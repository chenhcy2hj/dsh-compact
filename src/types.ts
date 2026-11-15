export type SessionSeq = number

export type SurfaceOp =
  | 'append'
  | {
      op: 'replace'
      startSeq: SessionSeq
      endSeq: SessionSeq
    }

export interface TextContentBlock {
  type: 'text'
  text: string
}

export interface GenericContentBlock {
  type: string
  text?: string
  [key: string]: unknown
}

export type ToolResultContent = string | Array<TextContentBlock | GenericContentBlock>

export interface ToolResultMessage {
  role: string
  toolCallId: string
  toolName?: string
  content: ToolResultContent
  isError?: boolean
  [key: string]: unknown
}

export interface ToolResultError {
  name: string
  code: string
  reason?: string
}

export interface ToolResultPayload {
  turn: number
  step: number
  message: ToolResultMessage
  error?: ToolResultError
  meta?: Record<string, unknown>
}

export interface TurnEndPayload {
  turn: number
  reason?: string
}

export interface SessionEvent<T = Record<string, unknown>> {
  seq?: SessionSeq
  type: string
  data: T
}

export interface AppendOptions {
  surfaceOp?: SurfaceOp
  sourceEventSeqs?: SessionSeq[]
}

export interface SessionSurface {
  readonly nodes: readonly SessionSeq[]
}

export interface SessionLike {
  readonly id?: string
  readonly surface: SessionSurface
  eventAt(seq: SessionSeq): SessionEvent | undefined | Promise<SessionEvent | undefined>
  append(
    type: string,
    data: unknown,
    options?: AppendOptions,
  ): SessionSeq | void | Promise<SessionSeq | void>
}

export interface CompactConfig {
  /** Whether post-turn tool result compaction is active. */
  enabled: boolean
  /** Number of most recent completed turns whose tool results are kept intact. 0 clears immediately after each turn. */
  keepRecentTurns: number
  /** Minimum character count (in Unicode code points) required before a tool result is compacted. */
  minCharsToCompact: number
  /** When true, tool results with errors are preserved in full. */
  preserveErrors: boolean
  /** Tool names whose results should never be compacted. */
  excludedTools: string[]
}

export interface CompactResult {
  compactedCount: number
  skippedCount: number
  charsBeforeTotal: number
  charsAfterTotal: number
  savedChars: number
}
