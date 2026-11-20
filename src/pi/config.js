export const normalizePiUrl = (url) => {
  const s = String(url || '').trim().replace(/\/+$/, '');
  if (!s) return '';
  return /^https?:\/\//i.test(s) ? s : `http://${s}`;
};

export const derivePiCameraUrls = (apiUrl, streamUrl = null, snapshotUrl = null) => {
  const base = normalizePiUrl(apiUrl) || PI_CONFIG.apiUrl;
  const cleanStream = streamUrl ? normalizePiUrl(streamUrl) : '';
  const cleanSnap = snapshotUrl ? normalizePiUrl(snapshotUrl) : '';
  const isPort5000 = /:5000$/i.test(base);
  const camBase = isPort5000 ? base.replace(/:5000$/i, ':8080') : base;
  const resolvedStream = cleanStream || `${camBase}${PI_CONFIG.paths.stream}`;
  const resolvedSnap = cleanSnap || (cleanStream ? cleanStream.replace(/\/stream(\?.*)?$/i, '/snapshot$1') : `${camBase}${PI_CONFIG.paths.snapshot}`);
  return { apiUrl: base, streamUrl: resolvedStream, snapshotUrl: resolvedSnap };
};

const ENV_PI_URL = normalizePiUrl(process.env.EXPO_PUBLIC_PI_API_URL);

export const PI_CONFIG = {
  apiUrl: ENV_PI_URL || 'http://127.0.0.1:3000',
  paths: { status: '/status', grade: '/grade', snapshot: '/snapshot', stream: '/stream' },
  healthTimeout: 5000,
  snapshotTimeout: 6000,
  inferenceTimeout: 30000,
};

export const piUrl = (p, baseUrl = PI_CONFIG.apiUrl) => `${normalizePiUrl(baseUrl) || PI_CONFIG.apiUrl}${p}`;