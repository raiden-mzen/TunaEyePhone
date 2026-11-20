import { Platform } from 'react-native';
import { File, Paths } from 'expo-file-system';
import { PI_CONFIG, piUrl } from './config';
import { GRADE_LETTER } from './types';

async function fetchT(url, options, ms) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try { return await fetch(url, { ...options, signal: c.signal }); }
  finally { clearTimeout(t); }
}

export async function checkPiStatus(apiUrl = PI_CONFIG.apiUrl, attempts = 3) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetchT(piUrl(PI_CONFIG.paths.status, apiUrl), { headers: { Accept: 'application/json' } }, PI_CONFIG.healthTimeout);
      if (!r.ok) throw new Error(`Pi returned HTTP ${r.status}`);
      const data = await r.json();
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Pi sent an invalid status response.');
      return data;
    } catch (e) { last = e; await new Promise((r) => setTimeout(r, 400 * (i + 1))); }
  }
  throw last;
}

export async function capturePiSnapshot(apiUrl = PI_CONFIG.apiUrl) {
  let r;
  try {
    r = await fetchT(piUrl(PI_CONFIG.paths.snapshot, apiUrl), { cache: 'no-store' }, PI_CONFIG.snapshotTimeout);
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? 'Pi camera snapshot timed out.' : 'Cannot reach Raspberry Pi camera.');
  }
  if (!r.ok) throw new Error(`Pi camera snapshot failed (HTTP ${r.status})`);
  const blob = await r.blob();
  if (!blob || blob.size === 0) throw new Error('Pi camera returned an empty image.');
  if (Platform.OS === 'web') {
    return URL.createObjectURL(blob);
  }
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const file = new File(Paths.cache, `pi-snapshot-${Date.now()}.jpg`);
  file.write(bytes);
  return file.uri;
}

export async function gradeWithPi(imageUri, piImageType, apiUrl = PI_CONFIG.apiUrl) {
  const form = new FormData();
  form.append('image_type', piImageType);
  if (Platform.OS === 'web' || /^(blob:|data:|https?:)/i.test(String(imageUri || ''))) {
    const imgRes = await fetch(imageUri);
    const blob = await imgRes.blob();
    const ext = blob.type === 'image/png' ? 'png' : blob.type === 'image/webp' ? 'webp' : 'jpg';
    form.append('image', blob, `capture.${ext}`);
  } else {
    form.append('image', { uri: imageUri, name: 'capture.jpg', type: 'image/jpeg' });
  }
  let r;
  try { r = await fetchT(piUrl(PI_CONFIG.paths.grade, apiUrl), { method: 'POST', body: form }, PI_CONFIG.inferenceTimeout); }
  catch (e) { throw new Error(e.name === 'AbortError' ? 'timeout' : 'unreachable'); }
  if (r.status === 422) {
    const body = await r.json().catch(() => ({}));
    const expected = piImageType === 'tailcut' ? 'Tail-Cut' : 'Sashibo Core';
    throw new Error(body?.error === 'sample_type_mismatch'
      ? `Wrong sample type. Please upload a ${expected} image.`
      : 'Sample type cannot be determined. Retake or upload another image.');
  }
  if (!r.ok) throw new Error(`Pi grading failed (HTTP ${r.status})`);
  let j;
  try { j = await r.json(); } catch { throw new Error('Pi sent unreadable data.'); }
  if (typeof j.grade !== 'string' || typeof j.confidence !== 'number') throw new Error('Pi sent an unexpected response.');
  const invalid = j.grade === 'INVALID';
  const normalizedGrade = GRADE_LETTER[j.grade] || (['A', 'B', 'C'].includes(j.grade) ? j.grade : null);
  if (!invalid && !normalizedGrade) throw new Error('Pi sent an unknown grade: ' + j.grade);
  const confidence = j.confidence > 1 ? j.confidence / 100 : j.confidence;
  return {
    id: j.id,
    captureId: j.capture_id || null,
    grade: j.grade,
    letter: invalid ? null : normalizedGrade,
    confidence,
    scores: j.scores || null,
    invalid,
    status: j.status || null,
  };
}