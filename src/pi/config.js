export const normalizePiUrl = (url) => String(url || '').trim().replace(/\/+$/, '');

const ENV_PI_URL = normalizePiUrl(process.env.EXPO_PUBLIC_PI_API_URL);

export const PI_CONFIG = {
  apiUrl: ENV_PI_URL || 'http://127.0.0.1:3000',
  paths: { status: '/status', grade: '/grade', snapshot: '/snapshot', stream: '/stream' },
  healthTimeout: 5000,
  snapshotTimeout: 6000,
  inferenceTimeout: 30000,
};

export const piUrl = (p, baseUrl = PI_CONFIG.apiUrl) => `${normalizePiUrl(baseUrl) || PI_CONFIG.apiUrl}${p}`;