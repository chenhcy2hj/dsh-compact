                                                  
import { compactTurnToolResults } from './compactor.js'
                                                                                          

                      
                                                  
                                                  
 

const DEFAULT_CONFIG                = {
  enabled: true,
  keepRecentTurns: 0,
  minCharsToCompact: 120,
  preserveErrors: true,
  excludedTools: [],
}

function normalizeConfig(raw                         )                {
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
      ? raw.excludedTools.filter((item)                 => typeof item === 'string')
      : DEFAULT_CONFIG.excludedTools,
  }
}

/**
 * Registers the `session/event` listener that compacts completed-turn `tool/result`
 * nodes whenever a turn finishes (`turn/end`).
 */
export function apply(ctx         , rawConfig                         )       {
  const config = normalizeConfig(rawConfig)
  const inFlight = new WeakSet        ()
  const logger = (ctx                                      ).logger

  ;(ctx                
       
                             
                                                                                    
           
   ).on('session/event', async (session, event) => {
    if (!config.enabled || event.type !== 'turn/end') {
      return
    }

    const data = event.data                              
    if (!data || typeof data.turn !== 'number') {
      return
    }

    const targetMaxTurn = data.turn - config.keepRecentTurns
    if (targetMaxTurn < 0 || inFlight.has(session)) {
      return
    }

    inFlight.add(session)
    try {
      const stats = await compactTurnToolResults(session, targetMaxTurn, config)
      if (stats.compactedCount > 0) {
        logger?.info?.(
          `[dsh-compact] Turn ${data.turn} ended: compacted ${stats.compactedCount} tool result(s), saved ${stats.savedChars} chars.`,
        )
      }
    } catch (error) {
      logger?.warn?.('[dsh-compact] Failed to compact tool results:', error)
    } finally {
      inFlight.delete(session)
    }
  })
}
