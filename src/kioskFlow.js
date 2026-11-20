import AsyncStorage from '@react-native-async-storage/async-storage';

export const PENDING_SYNC_GRADERS_KEY = 'tunaeye-pending-sync-graders';
export const TUTORIAL_SESSIONS_KEY = '@tunaeye/tutorial_sessions';

export function validateGraderName(name) {
  return String(name || '').trim().slice(0, 15);
}

export function phoneticKey(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .replace(/ph/g, 'f')
    .replace(/th/g, 't')
    .replace(/[cq]/g, 'k')
    .replace(/z/g, 's')
    .replace(/(.)\1+/g, '$1');
}

export function levenshtein(a, b) {
  const s = String(a || '').toLowerCase();
  const t = String(b || '').toLowerCase();
  if (!s.length) return t.length;
  if (!t.length) return s.length;
  const dp = Array.from({ length: s.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= t.length; j++) dp[0][j] = j;
  for (let i = 1; i <= s.length; i++) {
    for (let j = 1; j <= t.length; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[s.length][t.length];
}

export function relativeAgo(ts, now = Date.now()) {
  const diff = Math.max(0, Math.floor((now - ts) / 1000));
  if (diff < 60) return 'just now';
  const mins = Math.floor(diff / 60);
  if (mins < 60) return `${mins} min${mins === 1 ? '' : 's'} ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? '' : 's'} ago`;
  const days = Math.floor(hrs / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

export function findGraderMatches(typed, records = [], knownGraders = []) {
  const clean = validateGraderName(typed);
  if (!clean) return [];
  const cleanLower = clean.toLowerCase();
  const cleanPhonetic = phoneticKey(clean);
  const byName = new Map();

  for (const g of knownGraders) {
    const name = validateGraderName(g);
    if (name) byName.set(name.toLowerCase(), { name, lastAt: 0 });
  }
  for (const r of records) {
    const name = validateGraderName(r?.grader);
    if (!name) continue;
    const key = name.toLowerCase();
    const prev = byName.get(key);
    const ts = Number(r.createdAt) || 0;
    if (!prev || ts > prev.lastAt) byName.set(key, { name, lastAt: ts });
  }

  const matches = [];
  for (const entry of byName.values()) {
    const cand = entry.name;
    const candLower = cand.toLowerCase();
    const candBase = candLower.split(' ')[0];
    const exact = candLower === cleanLower;
    const phonetic = Boolean(cleanPhonetic && phoneticKey(candBase) === cleanPhonetic);
    const prefix = cleanLower.length >= 3 && (candLower.startsWith(cleanLower) || cleanLower.startsWith(candBase));
    const dist = levenshtein(cleanLower, candBase) <= 2;
    if (exact || phonetic || prefix || dist) {
      matches.push({
        name: cand,
        lastAt: entry.lastAt,
        ago: entry.lastAt ? relativeAgo(entry.lastAt) : 'recently',
        exact,
      });
    }
  }
  return matches.sort((a, b) => Number(b.exact) - Number(a.exact) || b.lastAt - a.lastAt);
}

export function getDashboardHistory(records, graderName, scope = 'mine') {
  const clean = validateGraderName(graderName).toLowerCase();
  const list = scope === 'all'
    ? records.slice()
    : clean
      ? records.filter((r) => validateGraderName(r?.grader).toLowerCase() === clean)
      : [];
  return list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

export async function shouldSkipPlacementTutorial(graderName, now = Date.now()) {
  const key = validateGraderName(graderName).toLowerCase() || '__default__';
  try {
    const raw = JSON.parse((await AsyncStorage.getItem(TUTORIAL_SESSIONS_KEY)) || '{}');
    const list = Array.isArray(raw[key]) ? raw[key] : [];
    const recent = list.filter((ts) => now - Number(ts) <= 30 * 60 * 1000);
    return recent.length >= 2;
  } catch {
    return false;
  }
}

export async function recordPlacementSession(graderName, now = Date.now()) {
  const key = validateGraderName(graderName).toLowerCase() || '__default__';
  try {
    const raw = JSON.parse((await AsyncStorage.getItem(TUTORIAL_SESSIONS_KEY)) || '{}');
    const list = Array.isArray(raw[key]) ? raw[key] : [];
    const recent = list.filter((ts) => now - Number(ts) <= 30 * 60 * 1000);
    recent.push(now);
    raw[key] = recent.slice(-10);
    await AsyncStorage.setItem(TUTORIAL_SESSIONS_KEY, JSON.stringify(raw));
  } catch {}
}
