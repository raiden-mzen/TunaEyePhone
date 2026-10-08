import type { GradingRecordInsert } from '../lib/database.types'
import { imagePathFor, mapCaptureToRow, rowId } from './mapping'
import type { LocalRecord, LocalSampleKey } from './types'

/** Narrow cloud surface so the pipeline is testable without a network. */
export interface CloudClient {
  getUserId(): Promise<string>
  uploadImage(path: string, data: ArrayBuffer, contentType: string): Promise<void>
  upsertRows(rows: GradingRecordInsert[]): Promise<void>
  fetchExistingIds(ids: string[]): Promise<string[]>
}

export interface SyncDeps {
  cloud: CloudClient
  readImage(uri: string): Promise<ArrayBuffer>
  now?: () => Date
}

export type SyncStage = 'Signing in' | 'Uploading image' | 'Saving record' | 'Verifying'

export interface SyncHooks {
  onStage?(stage: SyncStage): void
  onImageUploaded?(key: LocalSampleKey, path: string): void
}

export interface SyncResult {
  userId: string
  rowIds: string[]
  imagePaths: Partial<Record<LocalSampleKey, string>>
}

/**
 * Local record -> auth -> upload images (upsert) -> upsert grading_records on `id`
 * -> read back -> resolve. Throws on any failure; the caller marks the record `failed`
 * and keeps it for retry. Never generates ids: everything derives from record.uuid.
 */
export async function syncRecord(deps: SyncDeps, record: LocalRecord, hooks: SyncHooks = {}): Promise<SyncResult> {
  const { cloud } = deps
  if (!record.captures.length) throw new Error('Record has no captured samples to sync.')
  hooks.onStage?.('Signing in')
  const userId = await cloud.getUserId()

  const imagePaths: Partial<Record<LocalSampleKey, string>> = {}
  for (const capture of record.captures) {
    const target = imagePathFor(userId, record, capture.type)
    if (record.remote?.[capture.type]?.imagePath === target) { imagePaths[capture.type] = target; continue }
    if (!capture.uri) continue
    hooks.onStage?.('Uploading image')
    await cloud.uploadImage(target, await deps.readImage(capture.uri), 'image/jpeg')
    imagePaths[capture.type] = target
    hooks.onImageUploaded?.(capture.type, target)
  }

  hooks.onStage?.('Saving record')
  const nowIso = (deps.now?.() ?? new Date()).toISOString()
  const rows = record.captures.map(c => mapCaptureToRow(record, c, userId, imagePaths[c.type] ?? null, nowIso))
  await cloud.upsertRows(rows)

  hooks.onStage?.('Verifying')
  const found = new Set(await cloud.fetchExistingIds(rows.map(r => r.id)))
  const missing = rows.filter(r => !found.has(r.id))
  if (missing.length) throw new Error('Cloud persistence could not be verified.')
  return { userId, rowIds: record.captures.map(c => rowId(record, c.type)), imagePaths }
}
