import { PI_CONFIG, piUrl } from './config';
import { GRADE_LETTER } from './types';

async function fetchT(url, options, ms) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try { return await fetch(url, { ...options, signal: c.signal }); }
  finally { clearTimeout(t); }
}

export async function checkPiStatus(attempts = 3) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetchT(piUrl(PI_CONFIG.paths.status), {}, PI_CONFIG.healthTimeout);
      if (!r.ok) throw new Error(`Pi returned HTTP ${r.status}`);
      return await r.json();
    } catch (e) { last = e; await new Promise((r) => setTimeout(r, 500 * (i + 1))); }
  }
  throw last;
}

export async function gradeWithPi(imageUri, piImageType) {
  const form = new FormData();
  form.append('image', { uri: imageUri, name: 'fish.jpg', type: 'image/jpeg' });
  form.append('image_type', piImageType);
  let r;
  try { r = await fetchT(piUrl(PI_CONFIG.paths.grade), { method: 'POST', body: form }, PI_CONFIG.inferenceTimeout); }
  catch (e) { throw new Error(e.name === 'AbortError' ? 'timeout' : 'unreachable'); }
  if (!r.ok) throw new Error(`Pi grading failed (HTTP ${r.status})`);
  let j;
  try { j = await r.json(); } catch { throw new Error('Pi sent unreadable data.'); }
  if (typeof j.grade !== 'string' || typeof j.confidence !== 'number') throw new Error('Pi sent an unexpected response.');
  const invalid = j.grade === 'INVALID';
  if (!invalid && !GRADE_LETTER[j.grade]) throw new Error('Pi sent an unknown grade: ' + j.grade);
  return { id: j.id, grade: j.grade, letter: invalid ? null : GRADE_LETTER[j.grade], confidence: j.confidence, scores: j.scores || null, invalid };
}