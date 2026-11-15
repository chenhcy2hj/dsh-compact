             
                
                
              
                    
                    
                   

export const COMPACTED_PREFIX = '[Tool result cleared after turn '

/**
 * Counts Unicode code points in a string without splitting surrogate pairs.
 */
function countCodePoints(text        )         {
  let count = 0
  for (const _ of text) {
    count += 1
  }
  return count
}

/**
 * Estimates the character length of a tool result's content across string or block payloads.
 */
export function estimateContentChars(content                   )         {
  if (typeof content === 'string') {
    return countCodePoints(content)
  }
  if (!Array.isArray(content)) {
    return 0
  }

  let total = 0
  for (const block of content) {
    if (block && typeof block === 'object' && typeof block.text === 'string') {
      total += countCodePoints(block.text)
    } else if (block != null) {
      total += countCodePoints(JSON.stringify(block))
    }
  }
  return total
}

/**
 * Builds a concise placeholder string preserving tool identity and original size.
 */
export function buildCompactedPlaceholder(params   
              
                  
                     
                  
 )         {
  const errorTag = params.isError ? ' [error]' : ''
  return `[Tool result cleared after turn ${params.turn}: ${params.toolName} (${params.charsBefore} chars)${errorTag}]`
}

function isAlreadyCompacted(payload                   )          {
  const content = payload.message?.content
  if (typeof content === 'string') {
    return content.startsWith(COMPACTED_PREFIX)
  }
  if (Array.isArray(content) && content.length === 1) {
    const first = content[0]
    return Boolean(first && typeof first === 'object' && typeof first.text === 'string' && first.text.startsWith(COMPACTED_PREFIX))
  }
  return false
}

function getToolName(payload                   )         {
  const msg = payload.message                                    
                                                 
   
  return msg.toolName ?? msg.source?.toolName ?? msg.source?.name ?? 'tool'
}

function isErrorResult(payload                   )          {
  return Boolean(payload.error || payload.message?.isError)
}

function buildReplacedContent(
  original                   ,
  placeholder        ,
)                    {
  if (typeof original === 'string') {
    return placeholder
  }
  return [{ type: 'text', text: placeholder }]
}

/**
 * Compacts `tool/result` surface nodes from turns `<= targetMaxTurn` in place via
 * `surfaceOp: { op: 'replace', startSeq, endSeq }`, preserving tool-call/result pairing.
 */
export async function compactTurnToolResults(
  session             ,
  targetMaxTurn        ,
  config               ,
)                         {
  const result                = {
    compactedCount: 0,
    skippedCount: 0,
    charsBeforeTotal: 0,
    charsAfterTotal: 0,
    savedChars: 0,
  }

  if (!config.enabled || targetMaxTurn < 0) {
    return result
  }

  const excluded = new Set(config.excludedTools)
  const nodes = [...session.surface.nodes]

  for (const seq of nodes) {
    const event = await session.eventAt(seq)
    if (!event || event.type !== 'tool/result') {
      continue
    }

    const data = event.data                                 
    if (!data || typeof data.turn !== 'number' || !data.message) {
      result.skippedCount += 1
      continue
    }

    if (data.turn > targetMaxTurn) {
      result.skippedCount += 1
      continue
    }

    if (isAlreadyCompacted(data)) {
      result.skippedCount += 1
      continue
    }

    const toolName = getToolName(data)
    if (excluded.has(toolName)) {
      result.skippedCount += 1
      continue
    }

    const isError = isErrorResult(data)
    if (config.preserveErrors && isError) {
      result.skippedCount += 1
      continue
    }

    const charsBefore = estimateContentChars(data.message.content)
    if (charsBefore < config.minCharsToCompact) {
      result.skippedCount += 1
      continue
    }

    const placeholder = buildCompactedPlaceholder({
      turn: data.turn,
      toolName,
      charsBefore,
      isError,
    })
    const charsAfter = countCodePoints(placeholder)

    // Skip if replacing would not actually shrink the content.
    if (charsAfter >= charsBefore) {
      result.skippedCount += 1
      continue
    }

    // DSH assertToolResultRewrite requires surface replacement to change ONLY message.content.
    const nextData                    = {
      ...data,
      message: {
        ...data.message,
        content: buildReplacedContent(data.message.content, placeholder),
      },
    }

    await session.append('tool/result', nextData, {
      surfaceOp: {
        op: 'replace',
        startSeq: seq,
        endSeq: seq,
      },
      sourceEventSeqs: [seq],
    })

    result.compactedCount += 1
    result.charsBeforeTotal += charsBefore
    result.charsAfterTotal += charsAfter
    result.savedChars += charsBefore - charsAfter
  }

  return result
}
