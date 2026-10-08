import 'react-native-url-polyfill/auto'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Database } from './database.types'

// Expo inlines EXPO_PUBLIC_* only when accessed as literal `process.env.NAME`.
const url = process.env.EXPO_PUBLIC_SUPABASE_URL?.trim()
const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY?.trim()

let client: SupabaseClient<Database> | null = null

export const isSupabaseConfigured = (): boolean => Boolean(url && anonKey)

/** Same Supabase project as TunaEye Kiosk/Admin. Publishable/anon key only; never service_role. */
export function getSupabase(): SupabaseClient<Database> {
  if (!url || !anonKey) {
    throw new Error('Supabase is not configured. Set EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY.')
  }
  client ??= createClient<Database>(url, anonKey, {
    auth: { storage: AsyncStorage, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  })
  return client
}

/** Reuse the stored session, otherwise sign in anonymously (same model as the kiosk). */
export async function ensureSupabaseUser(): Promise<string> {
  const supabase = getSupabase()
  const { data: { session } } = await supabase.auth.getSession()
  if (session?.user) return session.user.id
  const { data, error } = await supabase.auth.signInAnonymously({ options: { data: { display_name: 'TunaEye mobile' } } })
  if (error || !data.user) throw error ?? new Error('Supabase authentication failed.')
  return data.user.id
}
