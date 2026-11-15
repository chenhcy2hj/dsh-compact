import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { COMPACTED_PREFIX } from '../src/compactor.ts'
import { apply } from '../src/plugin.ts'
import type { AppendOptions, CompactConfig, SessionEvent, SessionLike, SessionSeq } from '../src/types.ts'

class FakeSession implements SessionLike {
  readonly id = 'fake-session'
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
    this.events.push({ seq, type, data: data as Record<string, unknown> })
    if (options?.surfaceOp === 'append') {
      this.activeNodes.push(seq)
    } else if (options?.surfaceOp && typeof options.surfaceOp === 'object') {
      const { startSeq, endSeq } = options.surfaceOp
      const startIndex = this.activeNodes.indexOf(startSeq)
      const endIndex = this.activeNodes.indexOf(endSeq)
      this.activeNodes.splice(startIndex, endIndex - startIndex + 1, seq)
    }
    return seq
  }

  getSurfaceEvents(): SessionEvent[] {
    return this.activeNodes.map((seq) => this.events[seq]!)
  }
}

class FakeContext {
  private listeners = new Map<string, Array<(session: SessionLike, event: SessionEvent) => unknown>>()
  readonly logger = {
    info: () => {},
    warn: () => {},
  }

  on(event: string, listener: (session: SessionLike, event: SessionEvent) => unknown) {
    const list = this.listeners.get(event) ?? []
    list.push(listener)
    this.listeners.set(event, list)
  }

  async emit(event: string, session: SessionLike, sessionEvent: SessionEvent) {
    for (const listener of this.listeners.get(event) ?? []) {
      await listener(session, sessionEvent)
    }
  }
}

const baseConfig: CompactConfig = {
  enabled: true,
  keepRecentTurns: 0,
  minCharsToCompact: 120,
  preserveErrors: true,
  excludedTools: [],
}

describe('Seam 1: apply(ctx, config)', () => {
  it('compacts completed turn tool results when turn/end is emitted and ignores turn/start', async () => {
    const ctx = new FakeContext()
    apply(ctx as never, baseConfig)

    const session = new FakeSession()
    session.append(
      'tool/result',
      {
        turn: 1,
        step: 1,
        message: {
          role: 'toolResult',
          toolCallId: 'call_1',
          toolName: 'read_file',
          content: [{ type: 'text', text: 'x'.repeat(500) }],
        },
      },
      { surfaceOp: 'append' },
    )

    // Non-turn/end event must not compact
    await ctx.emit('session/event', session, { type: 'turn/start', data: { turn: 1 } })
    assert.equal(
      (session.getSurfaceEvents()[0]!.data as { message: { content: Array<{ text: string }> } }).message.content[0]!.text,
      'x'.repeat(500),
    )

    // turn/end must trigger compaction
    await ctx.emit('session/event', session, { type: 'turn/end', data: { turn: 1 } })
    assert.ok(
      (session.getSurfaceEvents()[0]!.data as { message: { content: Array<{ text: string }> } }).message.content[0]!.text.startsWith(COMPACTED_PREFIX),
    )
  })

  it('does nothing when enabled is false', async () => {
    const ctx = new FakeContext()
    apply(ctx as never, { ...baseConfig, enabled: false })

    const session = new FakeSession()
    session.append(
      'tool/result',
      {
        turn: 1,
        step: 1,
        message: {
          role: 'toolResult',
          toolCallId: 'call_disabled',
          toolName: 'bash',
          content: [{ type: 'text', text: 'y'.repeat(500) }],
        },
      },
      { surfaceOp: 'append' },
    )

    await ctx.emit('session/event', session, { type: 'turn/end', data: { turn: 1 } })
    assert.equal(
      (session.getSurfaceEvents()[0]!.data as { message: { content: Array<{ text: string }> } }).message.content[0]!.text,
      'y'.repeat(500),
    )
  })

  it('defers compaction by keepRecentTurns across sequential turns', async () => {
    const ctx = new FakeContext()
    apply(ctx as never, { ...baseConfig, keepRecentTurns: 1 })

    const session = new FakeSession()
    session.append(
      'tool/result',
      {
        turn: 1,
        step: 1,
        message: {
          role: 'toolResult',
          toolCallId: 'call_t1',
          toolName: 'read_file',
          content: [{ type: 'text', text: 'a'.repeat(500) }],
        },
      },
      { surfaceOp: 'append' },
    )

    // Turn 1 ends -> keepRecentTurns=1 keeps turn 1 intact
    await ctx.emit('session/event', session, { type: 'turn/end', data: { turn: 1 } })
    assert.equal(
      (session.getSurfaceEvents()[0]!.data as { message: { content: Array<{ text: string }> } }).message.content[0]!.text,
      'a'.repeat(500),
    )

    // Turn 2 ends -> turn 1 is now compacted, turn 2 stays intact
    session.append(
      'tool/result',
      {
        turn: 2,
        step: 1,
        message: {
          role: 'toolResult',
          toolCallId: 'call_t2',
          toolName: 'read_file',
          content: [{ type: 'text', text: 'b'.repeat(500) }],
        },
      },
      { surfaceOp: 'append' },
    )
    await ctx.emit('session/event', session, { type: 'turn/end', data: { turn: 2 } })

    const [t1, t2] = session.getSurfaceEvents()
    assert.ok(
      (t1!.data as { message: { content: Array<{ text: string }> } }).message.content[0]!.text.startsWith(COMPACTED_PREFIX),
    )
    assert.equal(
      (t2!.data as { message: { content: Array<{ text: string }> } }).message.content[0]!.text,
      'b'.repeat(500),
    )
  })

  it('catches session errors gracefully and logs a warning without throwing', async () => {
    const warnings: unknown[][] = []
    const ctx = new FakeContext()
    ctx.logger.warn = (...args: unknown[]) => warnings.push(args)
    apply(ctx as never, baseConfig)

    const failingSession: SessionLike = {
      surface: { nodes: [0] },
      eventAt: () => {
        throw new Error('storage unavailable')
      },
      append: () => 1,
    }

    await assert.doesNotReject(() =>
      ctx.emit('session/event', failingSession, { type: 'turn/end', data: { turn: 1 } }),
    )
    assert.equal(warnings.length, 1)
  })
})
