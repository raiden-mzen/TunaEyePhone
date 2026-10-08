import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { GradingRecordInsert } from '../src/lib/database.types.ts'
import { imagePathFor, mapCaptureToRow, rowId } from '../src/sync/mapping.ts'
import { syncRecord, type CloudClient } from '../src/sync/syncRecord.ts'
import type { LocalRecord } from '../src/sync/types.ts'

const USER = '11111111-1111-4111-8111-111111111111'
const GRADES = ['A', 'B', 'C', 'Invalid']

/** In-memory stand-in for the shared project: PK upsert on id, RLS-style owner checks, enum checks. */
function fakeCloud(opts: { failUpsertTimes?: number; dropRows?: boolean; failUploadTimes?: number } = {}) {
  const rows = new Map<string, GradingRecordInsert>()
  const objects = new Map<string, number>()
  const calls: string[] = []
  let failUpsert = opts.failUpsertTimes ?? 0
  let failUpload = opts.failUploadTimes ?? 0
  const cloud: CloudClient = {
    getUserId: async () => USER,
    async uploadImage(path, data, contentType) {
      calls.push('upload')
      if (failUpload-- > 0) throw new Error('network')
      assert.equal(path.split('/')[0], USER, 'storage RLS: first folder must be auth.uid()')
      assert.equal(contentType, 'image/jpeg')
      objects.set(path, data.byteLength) // upsert: true
    },
    async upsertRows(batch) {
      calls.push('upsert')
      if (failUpsert-- > 0) throw new Error('network')
      for (const r of batch) {
        assert.equal(r.user_id, USER, 'table RLS: user_id must be auth.uid()')
        assert.ok(['kiosk', 'mobile'].includes(r.source))
        assert.ok(['sashibo_core', 'tail_cut'].includes(r.sample_type))
        assert.ok(GRADES.includes(r.grade))
        if (r.original_grade) assert.ok(GRADES.includes(r.original_grade))
        if (r.confidence != null) assert.ok(r.confidence >= 0 && r.confidence <= 100)
        rows.set(r.id, { ...rows.get(r.id), ...r })
      }
    },
    async fetchExistingIds(ids) { calls.push('verify'); return opts.dropRows ? [] : ids.filter(id => rows.has(id)) },
  }
  return { cloud, rows, objects, calls }
}

const deps = (cloud: CloudClient) => ({ cloud, readImage: async () => new Uint8Array([1, 2, 3]).buffer as ArrayBuffer, now: () => new Date('2026-10-07T00:00:00Z') })

const record = (over: Partial<LocalRecord> = {}): LocalRecord => ({
  id: 'TE-20261007-0007', uuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', sessionId: 'sess-1', stationId: 'KIOSK-01', createdAt: Date.parse('2026-10-07T01:00:00Z'),
  weightTenths: 482, grader: 'Xander', sync: 'pending',
  captures: [
    { id: 'c1', type: 'core', label: 'A', score: 0.9312, outcome: 'accepted', ts: Date.parse('2026-10-07T01:00:05Z'), uri: 'file:///core.jpg' },
    { id: 'c2', type: 'tail', label: 'A', score: 0.88, outcome: 'accepted', ts: Date.parse('2026-10-07T01:00:30Z'), uri: 'file:///tail.jpg' },
  ],
  decisions: [], ...over,
})

test('maps to the canonical contract (source=mobile, ids, enums, storage path)', () => {
  const r = record()
  const row = mapCaptureToRow(r, r.captures[0], USER, imagePathFor(USER, r, 'core'), 'now')
  assert.equal(row.source, 'mobile')
  assert.equal(row.id, `${r.uuid}-core`)
  assert.equal(row.sample_type, 'sashibo_core')
  assert.equal(row.grade, 'A'); assert.equal(row.original_grade, 'A'); assert.equal(row.override_grade, null)
  assert.equal(row.confidence, 93.12); assert.equal(row.result_status, 'valid'); assert.equal(row.weight_kg, 48.2)
  assert.equal(row.image_path, `${USER}/${r.uuid}-core/sashibo_core.jpg`)
  assert.equal(imagePathFor(USER, r, 'tail'), `${USER}/${r.uuid}-tail/tail_cut.jpg`)
})

test('override keeps the model result and records the decision', () => {
  const r = record({ decisions: [{ grade: 'B', reason: 'Duller at cut edge', manual: false }] })
  const row = mapCaptureToRow(r, r.captures[1], USER, null, 'now')
  assert.equal(row.grade, 'B'); assert.equal(row.original_grade, 'A'); assert.equal(row.override_grade, 'B'); assert.equal(row.override_reason, 'Duller at cut edge')
})

test('uncertain / invalid samples map to Invalid with the inference state and no original grade', () => {
  const r = record({ captures: [{ id: 'c', type: 'core', label: 'B', score: 0.52, outcome: 'uncertain', uri: null }, { id: 'd', type: 'tail', label: 'Invalid', score: 0.97, outcome: 'invalid', uri: null }] })
  const [u, i] = r.captures.map(c => mapCaptureToRow(r, c, USER, null, 'now'))
  assert.deepEqual([u.grade, u.result_status, u.original_grade], ['Invalid', 'uncertain', null])
  assert.deepEqual([i.grade, i.result_status, i.original_grade], ['Invalid', 'invalid', null])
})

test('pipeline order: upload images -> upsert rows -> verify; one row per sample', async () => {
  const f = fakeCloud(); const r = record()
  const res = await syncRecord(deps(f.cloud), r)
  assert.deepEqual(f.calls, ['upload', 'upload', 'upsert', 'verify'])
  assert.equal(f.rows.size, 2); assert.equal(f.objects.size, 2)
  assert.deepEqual(res.rowIds, [rowId(r, 'core'), rowId(r, 'tail')])
})

test('retry after a failed upsert reuses the same ids/paths and creates no duplicates', async () => {
  const f = fakeCloud({ failUpsertTimes: 1 }); const r = record()
  await assert.rejects(syncRecord(deps(f.cloud), r), /network/)
  assert.equal(f.rows.size, 0)
  await syncRecord(deps(f.cloud), r); await syncRecord(deps(f.cloud), r) // reconnect + manual sync
  assert.equal(f.rows.size, 2); assert.equal(f.objects.size, 2)
  assert.deepEqual([...f.rows.keys()].sort(), [`${r.uuid}-core`, `${r.uuid}-tail`].sort())
})

test('already-uploaded images are not re-uploaded on retry', async () => {
  const f = fakeCloud(); const r = record()
  r.remote = { core: { imagePath: imagePathFor(USER, r, 'core') } }
  await syncRecord(deps(f.cloud), r)
  assert.equal(f.calls.filter(c => c === 'upload').length, 1)
  assert.equal(f.rows.get(`${r.uuid}-core`)?.image_path, imagePathFor(USER, r, 'core'))
})

test('upload failure surfaces (record stays retryable) and nothing is written to the table', async () => {
  const f = fakeCloud({ failUploadTimes: 1 })
  await assert.rejects(syncRecord(deps(f.cloud), record()), /network/)
  assert.equal(f.rows.size, 0)
})

test('unverifiable cloud write is an error, never a silent success', async () => {
  await assert.rejects(syncRecord(deps(fakeCloud({ dropRows: true }).cloud), record()), /could not be verified/)
})

test('re-sync after an expert decision updates the same rows', async () => {
  const f = fakeCloud(); const r = record()
  await syncRecord(deps(f.cloud), r)
  r.decisions = [{ grade: 'C', reason: 'Expert review', manual: false }]
  await syncRecord(deps(f.cloud), r)
  assert.equal(f.rows.size, 2); assert.equal(f.rows.get(`${r.uuid}-core`)?.grade, 'C'); assert.equal(f.rows.get(`${r.uuid}-core`)?.override_grade, 'C')
})
