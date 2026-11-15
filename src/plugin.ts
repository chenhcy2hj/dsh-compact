import type { Context } from '@deepseek-ai/cordis'
import { compactTurnToolResults } from './compactor.ts'
import type { CompactConfig, SessionEvent, SessionLike } from './types.ts'

interface LoggerLike {
  info?(message: string, ...args: unknown[]): void
  warn?(message: string, ...args: unknown[]): void
}

interface TurnStartData {
  turn: number
}

interface PreStepInput {
  agent?: {
    session?: SessionLike
    turn?: number
  }
  turn?: number
}

const DEFAULT_CONFIG: CompactConfig = {
  enabled: true,
  keepRecentTurns: 0,
  minCharsToCompact: 120,
  preserveErrors: true,
  excludedTools: [],
}

function normalizeConfig(raw?: Partial<CompactConfig>): CompactConfig {
  return {
    enabled: raw?.enabled ?? DEFAULT_CONFIG.enabled,
    keepRecentTurns:
      typeof raw?.keepRecentTurns === 'number' && raw.keepRecentTurns >= 0
        ? raw.keepRecentTurns
        : DEFAULT_CONFIG.keepRecentTurns,
    minCharsToCompact:
      typeof raw?.minCharsToCompact === 'number' && raw.minCharsToCompact >= 0
        ? raw.minCharsToCompact
        : DEFAULT_CONFIG.minCharsToCompact,
    preserveErrors: raw?.preserveErrors ?? DEFAULT_CONFIG.preserveErrors,
    excludedTools: Array.isArray(raw?.excludedTools)
      ? raw.excludedTools.filter((item): item is string => typeof item === 'string')
      : DEFAULT_CONFIG.excludedTools,
  }
}

/**
 * Compacts prior turns' `tool/result` surface nodes on `agent/pre-step` while a
 * turn is open (`turn/start` .. `turn/end`), satisfying DSH's open-turn log invariant.
 */
export function apply(ctx: Context, rawConfig?: Partial<CompactConfig>): void {
  const config = normalizeConfig(rawConfig)
  const openTurns = new WeakMap<object, number>()
  const inFlight = new WeakSet<object>()
  const logger = (ctx as unknown as { logger?: LoggerLike }).logger
  const host = ctx as unknown as {
    on(
      event: 'session/event',
      listener: (session: SessionLike, event: SessionEvent) => void,
    ): void
    on(
      event: 'agent/pre-step',
      listener: (input: PreStepInput, next: () => Promise<unknown>) => Promise<unknown>,
    ): void
  }

  host.on('session/event', (session, event) => {
    if (event.type === 'turn/start') {
      const data = event.data as TurnStartData | undefined
      if (data && typeof data.turn === 'number') {
        openTurns.set(session, data.turn)
      }
    } else if (event.type === 'turn/end') {
      openTurns.delete(session)
    }
  })

  host.on('agent/pre-step', async (input, next) => {
    if (!config.enabled) {
      return next()
    }

    const session = input?.agent?.session
    if (!session) {
      return next()
    }

    const currentTurn =
      typeof input.turn === 'number'
        ? input.turn
        : typeof input.agent?.turn === 'number'
          ? input.agent.turn
          : openTurns.get(session)

    if (typeof currentTurn !== 'number') {
      return next()
    }

    const targetMaxTurn = currentTurn - 1 - config.keepRecentTurns
    if (targetMaxTurn < 0 || inFlight.has(session)) {
      return next()
    }

    inFlight.add(session)
    try {
      const stats = await compactTurnToolResults(session, targetMaxTurn, config)
      if (stats.compactedCount > 0) {
        logger?.info?.(
          `[dsh-compact] Pre-step turn ${currentTurn}: compacted ${stats.compactedCount} prior tool result(s), saved ${stats.savedChars} chars.`,
        )
      }
    } catch (error) {
      logger?.warn?.('[dsh-compact] Failed to compact tool results:', error)
    } finally {
      inFlight.delete(session)
    }

    return next()
  })
}
