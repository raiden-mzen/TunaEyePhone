import { Platform } from 'react-native';
import { File, Paths, UploadTask, UploadType } from 'expo-file-system';
import { PI_CONFIG, derivePiCameraUrls, piUrl } from './config';
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

export async function capturePiSnapshot(apiUrl = PI_CONFIG.apiUrl, snapshotUrlOverride = null) {
  const urls = derivePiCameraUrls(apiUrl, null, snapshotUrlOverride);
  const fallbackUrl = piUrl(PI_CONFIG.paths.snapshot, urls.apiUrl);
  const tryUrls = urls.snapshotUrl !== fallbackUrl ? [urls.snapshotUrl, fallbackUrl] : [urls.snapshotUrl];

  if (Platform.OS !== 'web') {
    let lastErr;
    for (const target of tryUrls) {
      try {
        const dest = new File(Paths.cache, `pi-snapshot-${Date.now()}.jpg`);
        const downloaded = await Promise.race([
          File.downloadFileAsync(target, dest, { idempotent: true }),
          new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('timeout'), { name: 'AbortError' })), PI_CONFIG.snapshotTimeout)),
        ]);
        if (downloaded && downloaded.uri) return downloaded.uri;
      } catch (e) {
        lastErr = e;
      }
    }
    throw new Error(lastErr && lastErr.name === 'AbortError' ? 'Pi camera snapshot timed out.' : 'Cannot reach Raspberry Pi camera.');
  }

  let r;
  try {
    r = await fetchT(urls.snapshotUrl, { cache: 'no-store' }, PI_CONFIG.snapshotTimeout);
  } catch (e) {
    if (urls.snapshotUrl !== fallbackUrl) {
      try {
        r = await fetchT(fallbackUrl, { cache: 'no-store' }, PI_CONFIG.snapshotTimeout);
      } catch (e2) {
        throw new Error(e2.name === 'AbortError' ? 'Pi camera snapshot timed out.' : 'Cannot reach Raspberry Pi camera.');
      }
    } else {
      throw new Error(e.name === 'AbortError' ? 'Pi camera snapshot timed out.' : 'Cannot reach Raspberry Pi camera.');
    }
  }
  if (!r.ok) throw new Error(`Pi camera snapshot failed (HTTP ${r.status})`);
  const blob = await r.blob();
  if (!blob || blob.size === 0) throw new Error('Pi camera returned an empty image.');
  return URL.createObjectURL(blob);
}

export async function gradeWithPi(imageUri, piImageType, apiUrl = PI_CONFIG.apiUrl) {
  const gradeEndpoint = piUrl(PI_CONFIG.paths.grade, apiUrl);
  const uriStr = String(imageUri || '');
  const isPng = /\.png(\?|$)/i.test(uriStr);
  const isWebp = /\.webp(\?|$)/i.test(uriStr);
  const ext = isPng ? 'png' : isWebp ? 'webp' : 'jpg';
  const mime = isPng ? 'image/png' : isWebp ? 'image/webp' : 'image/jpeg';

  let statusCode = 0;
  let bodyText = '';
  let usedNativeUpload = false;

  if (Platform.OS !== 'web' && /^file:\/\//i.test(uriStr)) {
    try {
      const task = new UploadTask(new File(uriStr), gradeEndpoint, {
        httpMethod: 'POST',
        uploadType: UploadType.MULTIPART,
        fieldName: 'image',
        mimeType: mime,
        parameters: { image_type: String(piImageType) },
      });
      const res = await Promise.race([
        task.uploadAsync(),
        new Promise((_, rej) => setTimeout(() => {
          try { task.cancel(); } catch { }
          rej(Object.assign(new Error('timeout'), { name: 'AbortError' }));
        }, PI_CONFIG.inferenceTimeout)),
      ]);
      statusCode = res.status;
      bodyText = res.body || '';
      usedNativeUpload = true;
    } catch (e) {
      if (e && e.name === 'AbortError') throw new Error('timeout');
      // Fall back to fetch FormData below if native UploadTask could not read/open the URI.
    }
  }

  if (!usedNativeUpload) {
    const form = new FormData();
    form.append('image_type', piImageType);
    if (Platform.OS === 'web' || /^(blob:|data:|https?:)/i.test(uriStr)) {
      const imgRes = await fetch(uriStr);
      const blob = await imgRes.blob();
      const bExt = blob.type === 'image/png' ? 'png' : blob.type === 'image/webp' ? 'webp' : 'jpg';
      form.append('image', blob, `capture.${bExt}`);
    } else {
      form.append('image', { uri: uriStr, name: `capture.${ext}`, type: mime });
    }
    let r;
    try {
      r = await Promise.race([
        fetch(gradeEndpoint, { method: 'POST', body: form }),
        new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('timeout'), { name: 'AbortError' })), PI_CONFIG.inferenceTimeout)),
      ]);
    } catch (e) {
      if (e && e.name === 'AbortError') throw new Error('timeout');
      throw new Error(e && e.message && !/network request failed/i.test(e.message) ? `Pi upload failed: ${e.message}` : 'unreachable');
    }
    statusCode = r.status;
    bodyText = await r.text().catch(() => '');
  }

  const parseJson = () => { try { return JSON.parse(bodyText); } catch { return null; } };
  if (statusCode === 422) {
    const body = parseJson() || {};
    const expected = piImageType === 'tailcut' ? 'Tail-Cut' : 'Sashibo Core';
    throw new Error(body?.error === 'sample_type_mismatch'
      ? `Wrong sample type. Please upload a ${expected} image.`
      : 'Sample type cannot be determined. Retake or upload another image.');
  }
  if (statusCode < 200 || statusCode >= 300) throw new Error(`Pi grading failed (HTTP ${statusCode})`);
  const j = parseJson();
  if (!j) throw new Error('Pi sent unreadable data.');
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