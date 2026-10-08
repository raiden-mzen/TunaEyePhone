import { Directory, File, Paths } from 'expo-file-system'
import { Platform } from 'react-native'

/**
 * Move a fresh capture out of the camera cache so it survives until it is synced.
 * Falls back to the original URI on failure or on web (blob URLs cannot be persisted).
 */
export async function persistEvidence(uri: string | null | undefined, captureId: string): Promise<string | null> {
  if (!uri) return null
  if (Platform.OS === 'web') return uri
  try {
    const dir = new Directory(Paths.document, 'evidence')
    dir.create({ idempotent: true, intermediates: true })
    const dest = new File(dir, `${captureId}.jpg`)
    await new File(uri).copy(dest, { overwrite: true })
    return dest.uri
  } catch {
    return uri
  }
}

export async function readEvidence(uri: string): Promise<ArrayBuffer> {
  if (Platform.OS === 'web') return (await fetch(uri)).arrayBuffer()
  return new File(uri).arrayBuffer()
}
