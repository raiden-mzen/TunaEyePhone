import { GRADING_IMAGES_BUCKET } from '../lib/database.types'
import { ensureSupabaseUser, getSupabase } from '../lib/supabase'
import type { CloudClient } from './syncRecord'

/** Real Supabase implementation (anon key + user session, so RLS applies). */
export const supabaseCloud: CloudClient = {
  getUserId: ensureSupabaseUser,
  async uploadImage(path, data, contentType) {
    const { error } = await getSupabase().storage.from(GRADING_IMAGES_BUCKET).upload(path, data, { contentType, upsert: true })
    if (error) throw error
  },
  async upsertRows(rows) {
    const { error } = await getSupabase().from('grading_records').upsert(rows, { onConflict: 'id' })
    if (error) throw error
  },
  async fetchExistingIds(ids) {
    const { data, error } = await getSupabase().from('grading_records').select('id').in('id', ids)
    if (error) throw error
    return (data ?? []).map(row => row.id)
  },
}
