import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  COMPACTED_PREFIX,
  buildCompactedPlaceholder,
  compactTurnToolResults,
  estimateContentChars,
} from '../src/compactor.ts'
import type {
  AppendOptions,
  CompactConfig,
  SessionEvent,
  SessionLike,
  SessionSeq,
  ToolResultPayload,
} from '../src/types.ts'

class MockSession implements SessionLike {
  readonly id = 'test-session'
  private events: SessionEvent[] = []
  private activeNodes: SessionSeq[] = []

  get surface() {
    return { nodes: this.activeNodes }
  }

  eventAt(seq: SessionSeq): SessionEvent | undefined {
    return this.events[seq]
  }

  append(type: string, data: unknown, options?: AppendOptions): SessionSeq {
    const seq = this.events.length
    const event: SessionEvent = { seq, type, data: data as Record<string, unknown> }
    this.events.push(event)

    if (options?.surfaceOp === 'append') {
      this.activeNodes.push(seq)
    } else if (options?.surfaceOp && typeof options.surfaceOp === 'object') {
      const { startSeq, endSeq } = options.surfaceOp
      assert.ok(
        options.sourceEventSeqs?.includes(startSeq),
        'replace surfaceOp must include replaced seq in sourceEventSeqs',
      )
      const startIndex = this.activeNodes.indexOf(startSeq)
      const endIndex = this.activeNodes.indexOf(endSeq)
      assert.ok(startIndex !== -1 && endIndex !== -1 && startIndex <= endIndex, 'valid replace range')
      this.activeNodes.splice(startIndex, endIndex - startIndex + 1, seq)
    }

    return seq
  }

  getSurfaceEvents(): SessionEvent[] {
    return this.activeNodes.map((seq) => this.events[seq]!)
  }
}

const defaultConfig: CompactConfig = {
  enabled: true,
  keepRecentTurns: 0,
  minCharsToCompact: 120,
  preserveErrors: true,
  excludedTools: [],
}

function makeToolResultPayload(overrides: Partial<ToolResultPayload> & { text?: string } = {}): ToolResultPayload {
  const text = overrides.text ?? 'x'.repeat(500)
  return {
    turn: overrides.turn ?? 1,
    step: overrides.step ?? 1,
    message: overrides.message ?? {
      role: 'toolResult',
      toolCallId: 'call_1',
      toolName: 'read_file',
      content: [{ type: 'text', text }],
    },
    ...(overrides.error ? { error: overrides.error } : {}),
    ...(overrides.meta ? { meta: overrides.meta } : {}),
  }
}

describe('estimateContentChars & buildCompactedPlaceholder', () => {
  it('counts Unicode code points accurately for strings and blocks', () => {
    assert.equal(estimateContentChars('hello 🚀'), 7)
    assert.equal(
      estimateContentChars([
        { type: 'text', text: 'abc' },
        { type: 'text', text: '🚀' },
      ]),
      4,
    )
  })

  it('formats placeholder with turn, tool name, and char count', () => {
    assert.equal(
      buildCompactedPlaceholder({ turn: 2, toolName: 'bash', charsBefore: 1024, isError: false }),
      '[Tool result cleared after turn 2: bash (1024 chars)]',
    )
    assert.equal(
      buildCompactedPlaceholder({ turn: 2, toolName: 'bash', charsBefore: 1024, isError: true }),
      '[Tool result cleared after turn 2: bash (1024 chars) [error]]',
    )
  })
})

describe('compactTurnToolResults', () => {
  it('compacts tool results from completed turns while preserving toolCallId pairing', async () => {
    const session = new MockSession()
    session.append('user/message', { turn: 1, content: 'Inspect files' }, { surfaceOp: 'append' })
    session.append(
      'assistant/message',
      { turn: 1, step: 1, toolCalls: [{ id: 'call_1', name: 'read_file' }] },
      { surfaceOp: 'append' },
    )
    const originalSeq = session.append(
      'tool/result',
      makeToolResultPayload({ turn: 1, step: 1, text: 'a'.repeat(1000) }),
      { surfaceOp: 'append' },
    )
    session.append('assistant/message', { turn: 1, step: 2, content: 'Done!' }, { surfaceOp: 'append' })

    const stats = await compactTurnToolResults(session, 1, defaultConfig)

    assert.equal(stats.compactedCount, 1)
    assert.equal(stats.charsBeforeTotal, 1000)
    assert.ok(stats.savedChars > 900)

    const surfaceEvents = session.getSurfaceEvents()
    assert.equal(surfaceEvents.length, 4)

    const compactedEvent = surfaceEvents[2]!
    assert.equal(compactedEvent.type, 'tool/result')
    assert.notEqual(compactedEvent.seq, originalSeq)

    const data = compactedEvent.data as unknown as ToolResultPayload
    assert.equal(data.message.toolCallId, 'call_1')
    assert.equal(data.message.toolName, 'read_file')
    assert.equal(data.meta, undefined)
    assert.deepEqual(data.message.content, [
      {
        type: 'text',
        text: '[Tool result cleared after turn 1: read_file (1000 chars)]',
      },
    ])
  })

  it('respects keepRecentTurns and only clears older turns', async () => {
    const session = new MockSession()
    session.append('tool/result', makeToolResultPayload({ turn: 1, text: 'a'.repeat(400) }), {
      surfaceOp: 'append',
    })
    session.append('tool/result', makeToolResultPayload({ turn: 2, text: 'b'.repeat(400) }), {
      surfaceOp: 'append',
    })

    // Turn 2 ended with keepRecentTurns = 1 -> targetMaxTurn = 1
    const stats = await compactTurnToolResults(session, 1, {
      ...defaultConfig,
      keepRecentTurns: 1,
    })

    assert.equal(stats.compactedCount, 1)
    assert.equal(stats.skippedCount, 1)

    const [first, second] = session.getSurfaceEvents()
    assert.ok(
      (first!.data as unknown as ToolResultPayload).message.content[0]!.text!.startsWith(COMPACTED_PREFIX),
    )
    assert.equal(
      (second!.data as unknown as ToolResultPayload).message.content[0]!.text,
      'b'.repeat(400),
    )
  })

  it('skips errors when preserveErrors is true, excludedTools, short results, and already-compacted nodes', async () => {
    const session = new MockSession()

    // 1. Error tool result
    session.append(
      'tool/result',
      makeToolResultPayload({
        turn: 1,
        message: {
          role: 'toolResult',
          toolCallId: 'call_err',
          toolName: 'bash',
          isError: true,
          content: [{ type: 'text', text: 'e'.repeat(400) }],
        },
      }),
      { surfaceOp: 'append' },
    )

    // 2. Excluded tool
    session.append(
      'tool/result',
      makeToolResultPayload({
        turn: 1,
        message: {
          role: 'toolResult',
          toolCallId: 'call_excl',
          toolName: 'memory_search',
          content: [{ type: 'text', text: 'm'.repeat(400) }],
        },
      }),
      { surfaceOp: 'append' },
    )

    // 3. Short result below minCharsToCompact
    session.append(
      'tool/result',
      makeToolResultPayload({ turn: 1, text: 'ok' }),
      { surfaceOp: 'append' },
    )

    // 4. Eligible result
    session.append(
      'tool/result',
      makeToolResultPayload({ turn: 1, text: 'z'.repeat(400) }),
      { surfaceOp: 'append' },
    )

    const config: CompactConfig = {
      ...defaultConfig,
      excludedTools: ['memory_search'],
    }

    const firstPass = await compactTurnToolResults(session, 1, config)
    assert.equal(firstPass.compactedCount, 1)
    assert.equal(firstPass.skippedCount, 3)

    // Second pass must be idempotent
    const secondPass = await compactTurnToolResults(session, 1, config)
    assert.equal(secondPass.compactedCount, 0)
    assert.equal(secondPass.skippedCount, 4)
  })

  it('compacts string-typed tool result content as a string placeholder', async () => {
    const session = new MockSession()
    session.append(
      'tool/result',
      makeToolResultPayload({
        turn: 1,
        message: {
          role: 'toolResult',
          toolCallId: 'call_str',
          toolName: 'grep_search',
          content: 'line\n'.repeat(200),
        },
      }),
      { surfaceOp: 'append' },
    )

    const stats = await compactTurnToolResults(session, 1, defaultConfig)
    assert.equal(stats.compactedCount, 1)

    const compacted = session.getSurfaceEvents()[0]!.data as unknown as ToolResultPayload
    assert.equal(typeof compacted.message.content, 'string')
    assert.equal(
      compacted.message.content,
      '[Tool result cleared after turn 1: grep_search (1000 chars)]',
    )
  })
})
