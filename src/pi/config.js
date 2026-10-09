export const PI_CONFIG = {
  host: '10.42.0.1',
  apiPort: 5000,
  streamPort: 8080,
  // Verify which of these actually exist on your Pi, then change here only.
  paths: { status: '/status', grade: '/grade' },
  healthTimeout: 5000,
  inferenceTimeout: 30000,
};
export const piUrl = (p) => `http://${PI_CONFIG.host}:${PI_CONFIG.apiPort}${p}`;