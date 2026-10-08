import type { AssignableGrade, GradingRecordInsert, SampleType, TunaGrade } from '../lib/database.types'
import type { LocalCapture, LocalRecord, LocalSampleKey } from './types'

export const SAMPLE_TYPE_BY_KEY: Record<LocalSampleKey, SampleType> = { core: 'sashibo_core', tail: 'tail_cut' }
const isAssignable = (g: string | null | undefined): g is AssignableGrade => g === 'A' || g === 'B' || g === 'C'

/**
 * Stable cloud id for one sample row. Derived from the record UUID created at grading time,
 * so every retry (and every re-sync after an override) targets the same row.
 */
export const rowId = (record: Pick<LocalRecord, 'uuid'>, key: LocalSampleKey): string => `${record.uuid}-${key}`

/** Contract path: {user_id}/{record_id}/{sample_type}.jpg */
export const imagePathFor = (userId: string, record: Pick<LocalRecord, 'uuid'>, key: LocalSampleKey): string =>
  `${userId}/${rowId(record, key)}/${SAMPLE_TYPE_BY_KEY[key]}.jpg`

const round2 = (n: number) => Math.round(n * 100) / 100

export function mapCaptureToRow(
  record: LocalRecord,
  capture: LocalCapture,
  userId: string,
  imagePath: string | null,
  nowIso: string,
): GradingRecordInsert {
  const decision = record.decisions.length ? record.decisions[record.decisions.length - 1] : undefined
  const override = decision && isAssignable(decision.grade) ? decision.grade : null
  const modelGrade: AssignableGrade | null = capture.outcome === 'accepted' && isAssignable(capture.label) ? capture.label : null
  const grade: TunaGrade = override ?? modelGrade ?? 'Invalid'
  const weight = record.weightTenths / 10
  return {
    id: rowId(record, capture.type),
    user_id: userId,
    source: 'mobile',
    station_id: record.stationId ?? null,
    session_id: record.sessionId ?? record.uuid,
    grader_name: record.grader.trim() || 'Mobile grader',
    sample_type: SAMPLE_TYPE_BY_KEY[capture.type],
    fish_id: 'Fish 1',
    weight_kg: Number.isFinite(weight) && weight > 0 ? weight : null,
    grade,
    confidence: Number.isFinite(capture.score) ? Math.min(100, Math.max(0, round2(capture.score * 100))) : null,
    result_status: capture.outcome === 'accepted' ? 'valid' : capture.outcome,
    original_grade: modelGrade,
    override_grade: override,
    override_reason: override ? decision?.reason?.trim() || null : null,
    image_path: imagePath,
    captured_at: new Date(capture.ts ?? record.createdAt).toISOString(),
    updated_at: nowIso,
  }
}
