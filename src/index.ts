export const name = 'dsh-compact'

export { apply } from './plugin.ts'
export type { CompactConfig, CompactResult, SessionLike, SessionEvent } from './types.ts'
export { compactTurnToolResults, estimateContentChars, buildCompactedPlaceholder } from './compactor.ts'
