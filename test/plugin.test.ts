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
  private listeners = new Map<string, Array<(...args: unknown[]) => unknown>>()
  readonly logger = {
    info: () => {},
    warn: () => {},
  }

  on(event: string, listener: (...args: unknown[]) => unknown) {
    const list = this.listeners.get(event) ?? []
    list.push(listener)
    this.listeners.set(event, list)
  }

  emitSessionEvent(session: SessionLike, sessionEvent: SessionEvent) {
    for (const listener of this.listeners.get('session/event') ?? []) {
      listener(session, sessionEvent)
    }
  }

  async runPreStep(session: SessionLike, turn?: number) {
    const handlers = this.listeners.get('agent/pre-step') ?? []
    let idx = 0
    const next = async (): Promise<unknown> => {
      if (idx >= handlers.length) {
        return { kind: 'enter' }
      }
      const fn = handlers[idx++]!
      return fn({ agent: { session }, ...(turn !== undefined ? { turn } : {}) }, next)
    }
    return next()
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
  it('compacts prior turn tool results on agent/pre-step inside an open turn while keeping current turn intact', async () => {
    const ctx = new FakeContext()
    apply(ctx as never, baseConfig)

    const session = new FakeSession()
    // Turn 1: open turn, tool result, close turn (no replacement outside open turn)
    ctx.emitSessionEvent(session, { type: 'turn/start', data: { turn: 1 } })
    session.append(
      'tool/result',
      {
        turn: 1,
        step: 1,
        message: {
          role: 'tool',
          toolCallId: 'call_1',
          toolName: 'read_file',
          content: [{ type: 'text', text: 'x'.repeat(500) }],
        },
      },
      { surfaceOp: 'append' },
    )
    await ctx.runPreStep(session)
    assert.equal(
      (session.getSurfaceEvents()[0]!.data as { message: { content: Array<{ text: string }> } }).message.content[0]!.text,
      'x'.repeat(500),
    )
    ctx.emitSessionEvent(session, { type: 'turn/end', data: { turn: 1 } })

    // Turn 2 opens -> pre-step compacts Turn 1's tool result inside Turn 2
    ctx.emitSessionEvent(session, { type: 'turn/start', data: { turn: 2 } })
    await ctx.runPreStep(session)
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
          role: 'tool',
          toolCallId: 'call_disabled',
          toolName: 'bash',
          content: [{ type: 'text', text: 'y'.repeat(500) }],
        },
      },
      { surfaceOp: 'append' },
    )

    ctx.emitSessionEvent(session, { type: 'turn/start', data: { turn: 2 } })
    await ctx.runPreStep(session)
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
          role: 'tool',
          toolCallId: 'call_t1',
          toolName: 'read_file',
          content: [{ type: 'text', text: 'a'.repeat(500) }],
        },
      },
      { surfaceOp: 'append' },
    )

    // Turn 2 opens -> keepRecentTurns=1 keeps Turn 1 intact
    ctx.emitSessionEvent(session, { type: 'turn/start', data: { turn: 2 } })
    await ctx.runPreStep(session)
    assert.equal(
      (session.getSurfaceEvents()[0]!.data as { message: { content: Array<{ text: string }> } }).message.content[0]!.text,
      'a'.repeat(500),
    )

    // Turn 3 opens -> Turn 1 is now compacted, Turn 2 stays intact
    session.append(
      'tool/result',
      {
        turn: 2,
        step: 1,
        message: {
          role: 'tool',
          toolCallId: 'call_t2',
          toolName: 'read_file',
          content: [{ type: 'text', text: 'b'.repeat(500) }],
        },
      },
      { surfaceOp: 'append' },
    )
    ctx.emitSessionEvent(session, { type: 'turn/start', data: { turn: 3 } })
    await ctx.runPreStep(session)

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

    ctx.emitSessionEvent(failingSession, { type: 'turn/start', data: { turn: 2 } })
    await assert.doesNotReject(() => ctx.runPreStep(failingSession))
    assert.equal(warnings.length, 1)
  })
})
