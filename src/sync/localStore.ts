import AsyncStorage from '@react-native-async-storage/async-storage'
import type { LocalRecord } from './types'

const KEY = 'tunaeye-phone-records-v1'

/** Load persisted records. A record left `syncing` by a killed app is retried as `pending`. */
export async function loadStoredRecords(): Promise<LocalRecord[]> {
  try {
    const parsed: unknown = JSON.parse((await AsyncStorage.getItem(KEY)) ?? '[]')
    if (!Array.isArray(parsed)) return []
    return (parsed as LocalRecord[])
      .filter(r => r && typeof r.uuid === 'string' && Array.isArray(r.captures) && !r.demo)
      .map(r => (r.sync === 'syncing' ? { ...r, sync: 'pending' as const, stage: '' } : r))
  } catch {
    return []
  }
}

export async function saveStoredRecords(records: LocalRecord[]): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(records.filter(r => !r.demo)))
  } catch {
    /* storage full/unavailable: in-memory state is still correct; next change retries */
  }
}
