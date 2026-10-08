import type { AssignableGrade, TunaGrade } from '../lib/database.types'

/** Contract local-only sync states (never stored in PostgreSQL). `local` = session not closed yet. */
export type LocalSyncState = 'local' | 'pending' | 'syncing' | 'synced' | 'failed'
export type LocalSampleKey = 'core' | 'tail'
export type CaptureOutcome = 'accepted' | 'uncertain' | 'invalid'

export interface LocalCapture {
  id: string
  type: LocalSampleKey
  label: TunaGrade
  /** Model score 0..1 */
  score: number
  outcome: CaptureOutcome
  ts?: number
  /** Persistent local file/blob URI of the captured JPEG, if any. */
  uri?: string | null
}

export interface LocalDecision {
  grade: AssignableGrade | null
  reason?: string
  manual?: boolean
  ts?: number
}

export interface LocalRecord {
  /** Local display id, e.g. TE-20261005-0007 */
  id: string
  /** Stable UUID generated once when the record is created. Cloud ids derive from it. */
  uuid: string
  sessionId?: string
  stationId?: string | null
  createdAt: number
  weightTenths: number
  grader: string
  captures: LocalCapture[]
  decisions: LocalDecision[]
  sync: LocalSyncState
  stage?: string
  lastSyncError?: string
  /** Image paths already uploaded for the signed-in user (resume after partial failure). */
  remote?: Partial<Record<LocalSampleKey, { imagePath: string }>>
  demo?: boolean
}
