/**
 * TunaEye kiosk — React Native phone app
 *
 * Requires:  npx expo install react-native-svg expo-camera
 * Images:    ./assets/images/  (tunaEyeLoadingScreen, PHONEQR, PhoneScanSample, SAMPLETOPDOWN, sashiboCoreFull, tailCutFull .png)
 * app.json plugin: ["expo-camera", { "cameraPermission": "TunaEye uses the camera to scan the kiosk QR code and photograph the sample." }]
 *
 * Flow: onboarding (first launch) > weight + grader name > sample > scan the kiosk QR code
 *       > align the sample (illustration) > take the picture (live phone camera) > result (+ manual override) > price > receipt
 *
 * New-user help: blue hero welcome + onboarding, one-line subtitles on every step,
 *                and one-time "Tip n of 6" coach bubbles above the buttons.
 *
 * Changes in this version:
 *  - Receipt (on screen and print) uses the new "TUNAEYE KIOSK" layout and lists EVERY sample (core and/or tail).
 *  - Fish & grader details screen has more breathing room (top and bottom).
 *  - Every step now shows a Back button next to Continue in the bottom action bar.
 *  - "Line it up" shows the SAMPLETOPDOWN illustration only (no live-camera toggle).
 *  - "Take the photo" always uses the live phone camera (no illustration, no demo toggle).
 *  - Manual override with two samples lets you pick which sample to override (or set the final grade).
 *  - An invalid image (not a Sashibo core / tail cut) now pops a red "Invalid image" toast.
 *  - The "Allow camera" prompt is a properly centered panel (scanner + photo screen), asks automatically,
 *    and offers "Open settings" if access was blocked.
 *  - Take photo stays disabled until the camera reports ready.
 */
import React, { useEffect, useReducer, useRef, useState } from 'react';
import {
  Animated, Dimensions, Easing, Image, KeyboardAvoidingView, Linking, PanResponder, Platform, Pressable, SafeAreaView, ScrollView,
  StatusBar, StyleSheet, Text, TextInput, useWindowDimensions, View,
} from 'react-native';
import Svg, {
  Circle, ClipPath, Defs, Ellipse, G, LinearGradient, Path,
  RadialGradient, Rect, Stop, Text as SvgText,
} from 'react-native-svg';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Font from 'expo-font';
import * as Print from 'expo-print';
import NetInfo from '@react-native-community/netinfo';
import { isSupabaseConfigured } from './src/lib/supabase';
import { supabaseCloud } from './src/sync/cloud';
import { persistEvidence, readEvidence } from './src/sync/evidence';
import { loadStoredRecords, saveStoredRecords } from './src/sync/localStore';
import { syncRecord } from './src/sync/syncRecord';
import * as ImagePicker from 'expo-image-picker';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { gradeWithPi, checkPiStatus, capturePiSnapshot } from './src/pi/client';
import { PI_CONFIG, normalizePiUrl, derivePiCameraUrls } from './src/pi/config';
import { PI_IMAGE_TYPE, MIN_CONFIDENCE, PROVISIONAL_MIN_CONFIDENCE } from './src/pi/types';
import {
  PENDING_SYNC_GRADERS_KEY,
  validateGraderName,
  findGraderMatches,
  getDashboardHistory,
  shouldSkipPlacementTutorial,
  recordPlacementSession,
} from './src/kioskFlow';

let fontsLoaded = false;

async function loadFonts() {
  if (fontsLoaded) return;
  try {
    await Font.loadAsync({
      'OpenRunde-Regular': require('./assets/fonts/OpenRunde-Regular.woff2'),
      'OpenRunde-Medium': require('./assets/fonts/OpenRunde-Medium.woff2'),
      'OpenRunde-Semibold': require('./assets/fonts/OpenRunde-Semibold.woff2'),
      'OpenRunde-Bold': require('./assets/fonts/OpenRunde-Bold.woff2'),
    });
    fontsLoaded = true;
  } catch (e) {
    console.log('Font loading error:', e);
  }
}

/* ====================================================================== */
/* tokens                                                                  */
/* ====================================================================== */
const C = {
  pageBg: '#E6ECF3', chromeBg: '#FFFFFF', chromeText: '#173B6C', chromeSub: '#536477', chromeBorder: '#D2DCE8',
  canvas: '#EEF3FA', surface: '#FFFFFF', primary: '#2563EB', primaryPress: '#1D4FD8', navy: '#173B6C',
  text2: '#5B6B80', border: '#E1E8F2', blue: '#2563EB', cyan: '#5DD9F5', online: '#22B573',
  hero: '#1F5CFF', heroSoft: 'rgba(255,255,255,0.18)',
  gA: '#176B4B', gB: '#8A5900', gC: '#9A3C29', gAbg: '#E3F4EC', gBbg: '#FBF0D9', gCbg: '#F9E5E0',
  amber: '#7A4B00', amberbg: '#FFF4D6', warn: '#3F4F61', warnbg: '#EDF1F5', err: '#A12B2B', errbg: '#FBE9E9',
};
const IMG = {
  logo: require('./assets/images/tunaEyeLoadingScreen.png'),
  qr: require('./assets/images/PHONEQR.png'),
  scan: require('./assets/images/PhoneScanSample.png'),
  topdown: require('./assets/images/SAMPLETOPDOWN.png'),
  core: require('./assets/images/sashiboCoreFull.png'),
  tail: require('./assets/images/tailCutFull.png'),
};
const DEMO_IMG = {
  core: {
    A: require('./assets/demo_samples/SASHIBOCORE_A.png'),
    B: require('./assets/demo_samples/SASHIBOCORE_B.png'),
    C: require('./assets/demo_samples/SASHIBOCORE_C.png'),
    UNC: require('./assets/demo_samples/SASHIBOCORE_C.png'),
    INV: require('./assets/images/sashiboCoreFull.png'),
  },
  tail: {
    A: require('./assets/demo_samples/TAILCUT_A.png'),
    B: require('./assets/demo_samples/TAILCUT_B.png'),
    C: require('./assets/demo_samples/TAILCUT_C.png'),
    UNC: require('./assets/demo_samples/TAILCUT_C.png'),
    INV: require('./assets/images/tailCutFull.png'),
  },
};
const demoAssetFor = (type, code) => (DEMO_IMG[type === 'tail' ? 'tail' : 'core'][code] || IMG[type === 'tail' ? 'tail' : 'core']);

const SAMPLE_AR = { core: 2.05, tail: 1.9 }; // width / height of each sample PNG
const GC = { A: C.gA, B: C.gB, C: C.gC };
const GBG = { A: C.gAbg, B: C.gBbg, C: C.gCbg };
const GRADE_HERO = { A: '#15804B', B: '#C88000', C: '#C0392B' };
const GRADE_SUB = { A: 'Premium quality', B: 'Standard quality', C: 'Commercial grade' };
const MONO = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });
const TYPES = { core: { name: 'Sashibo core', short: 'Core' }, tail: { name: 'Tail cut', short: 'Tail' } };
const other = (t) => (t === 'core' ? 'tail' : 'core');
const ORIGIN = { model: 'Model', expert: 'Expert', manual: 'Manual override' };
const QUICK_REASONS = ['Color is clearly darker', 'Color is clearly lighter', 'Model looks wrong for this cut', 'Photo quality was poor', "Matches the buyer's sample"];
const STEPS = ['Details', 'Connect', 'Core', 'Tail', 'Grade', 'Receipt'];
const HERO_SCREENS = ['startup', 'welcome', 'onboarding'];
/* ====================================================================== */
/* helpers: money & weight (integer fixed-point)                           */
/* ====================================================================== */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uid = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = (Math.random() * 16) | 0; return (c === 'x' ? r : (r & 3) | 8).toString(16); });
const pad = (n, l = 4) => String(n).padStart(l, '0');
const parseTenths = (str) => { const p = String(str).split('.'); return parseInt(p[0] || '0', 10) * 10 + (p[1] ? parseInt(p[1][0], 10) : 0); };
const calcTotalCentavos = (wt, rate) => Math.floor((wt * rate + 5) / 10);
const fmtMoney = (c) => { const neg = c < 0; c = Math.abs(c); const w = Math.floor(c / 100); return (neg ? '-' : '') + 'PHP ' + String(w).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + pad(c % 100, 2); };
const fmtKg = (t) => (t / 10).toFixed(1) + ' kg';
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const manila = (ts) => new Date(ts + 8 * 3600e3);
const clock12 = (d) => { let h = d.getUTCHours(); const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12; return `${h}:${pad(d.getUTCMinutes(), 2)} ${ap}`; };
const fmtTime = (ts) => { const d = manila(ts); return `${MON[d.getUTCMonth()]} ${d.getUTCDate()}, ${clock12(d)} PHT`; };
const fmtClock = (ts) => clock12(manila(ts));

/* ====================================================================== */
/* state                                                                   */
/* ====================================================================== */
const now = Date.now();
const S = {
  screen: 'startup', prev: null,
  shift: { open: true, since: now - 3 * 3600e3, operator: 'Operator 01 (Demo)' },
  net: 'online',
  schedule: { id: 'PS-DEMO-03', version: 3, rates: { A: 62000, B: 50000, C: 38000 }, effective: 'Oct 1, 2026', validUntil: 'Oct 31, 2026', expired: false, label: 'Demo fixture rates (not an approved schedule)' },
  startup: { state: 'idle', checks: [], fail: null },
  session: null, auth: null, login: null, dialog: null, toast: null, help: false, drawer: false, navDock: false,
  onboarded: false, onbStep: 0, phoneLinked: false, piStatus: 'disconnected', piApiUrl: PI_CONFIG.apiUrl, piUrlDraft: PI_CONFIG.apiUrl, piStreamUrl: derivePiCameraUrls(PI_CONFIG.apiUrl).streamUrl, piSnapshotUrl: derivePiCameraUrls(PI_CONFIG.apiUrl).snapshotUrl, camSource: 'pi', camReady: false, kioskId: '', scanError: '', lastGrader: '',
  tips: false, coached: {}, barH: 0,
  ui: {
    large: false, batchOpen: false, recFilter: 'all', recSearch: '', recSel: null, reviewGrade: null, reviewReason: '', expertCtx: null,
    ovGrade: null, ovReason: '', ovAck: false, ovTarget: null, ovPin: '', ovPinError: '', histSel: null, histScope: 'mine', histPage: 0,
  },
  syncModal: null, slowWifiModal: null, graderCheckModal: null, cannotDetermineModal: null, skipReceiptModal: false, tutorialStep: 1,
  demo: { enabled: false, queue: [], next: 'A', quality: 'ok', printer: 'ok', timeoutOnce: false, cloudFailNext: 0, startupFault: 'none' },
  records: [], counter: 7, lastAck: null, syncing: { active: false, done: 0, total: 0 },
  busy: false, picking: false, flash: false, print: null, receiptSaved: false, countdown: 3, paused: false, timers: {}, lock: 0,
};
let rerender = () => { };
let persistTimer = null;
const persistSoon = () => { clearTimeout(persistTimer); persistTimer = setTimeout(() => { saveStoredRecords(S.records); }, 400); };
const render = () => { rerender(); persistSoon(); };
const clearTimers = () => { Object.values(S.timers).forEach((t) => { clearTimeout(t); clearInterval(t); }); S.timers = {}; };
const cloudOk = () => S.net === 'online';
const TS = () => (S.ui.large ? 1.18 : 1);

/* ---------- decision policy ---------- */
// Per-sample manual overrides (decision.manual with decision.target = 'core' | 'tail') replace that sample's grade.
function effCaps(s) {
  const decs = s.decisions || [];
  return (s.captures || []).map((c) => {
    const d = decs.slice().reverse().find((x) => x.manual && x.target === c.type && x.grade);
    return d ? { ...c, label: d.grade, outcome: 'accepted', overridden: true, raw: c } : c;
  });
}
function combineGrades(coreCap, tailCap) {
  const keys = ['GRADE_A', 'GRADE_B', 'GRADE_C'];
  const labels = ['A', 'B', 'C'];
  const hasScores = keys.every((k) => typeof coreCap.scores?.[k] === 'number' && typeof tailCap.scores?.[k] === 'number');
  if (hasScores) {
    const blended = keys.map((k) => ((coreCap.scores[k] || 0) + (tailCap.scores[k] || 0)) / 2);
    const winner = blended.reduce((best, val, idx) => (val > blended[best] ? idx : best), 0);
    return labels[winner];
  }
  const points = { A: 3, B: 2, C: 1 };
  const cConf = coreCap.score || 0;
  const tConf = tailCap.score || 0;
  const w = cConf + tConf || 1;
  const score = ((points[coreCap.label || 'C'] * cConf) + (points[tailCap.label || 'C'] * tConf)) / w;
  return score >= 2.5 ? 'A' : score >= 1.5 ? 'B' : 'C';
}
function resolve(s) {
  const caps = effCaps(s), dec = (s.decisions || []).filter((d) => !d.target).slice(-1)[0];
  const provisional = s.tailAvailability === 'not_available';
  if (dec) return dec.grade
    ? { status: 'final', grade: dec.grade, basis: dec.manual ? 'Manual override' : 'Expert decision', origin: dec.manual ? 'manual' : 'expert', provisional }
    : { status: 'unresolved', reason: 'Expert left this unresolved' };
  const core = caps.find((c) => c.type === 'core');
  const tail = caps.find((c) => c.type === 'tail');
  const ov = caps.filter((c) => c.overridden);
  const note = ov.length ? ' (override on ' + ov.map((c) => TYPES[c.type].short).join(' + ') + ')' : '';
  const origin = ov.length ? 'manual' : 'model';

  // Single sample (or Sashibo core primary flow)
  if (core && !tail) {
    if (core.outcome === 'invalid') return { status: 'unresolved', reason: 'Sashibo core image was rejected' };
    if (core.overridden) return { status: 'final', grade: core.label, basis: 'Manual override (Sashibo core)', origin: 'manual', provisional };
    if (core.outcome === 'accepted' && core.label !== 'C') {
      return { status: 'final', grade: core.label, basis: 'Sashibo core accepted' + note, origin };
    }
    if (provisional) {
      if (core.label && (core.score || 0) >= PROVISIONAL_MIN_CONFIDENCE) {
        return { status: 'final', grade: core.label, basis: 'Provisional (Tail-Cut not available)', origin, provisional: true };
      }
      return { status: 'unresolved', conflict: true, provisional: true, reason: 'Provisional confidence too low; manual override required' };
    }
    return {
      status: 'unresolved',
      tailNeeded: true,
      reason: core.label === 'C' && core.outcome === 'accepted'
        ? 'Sashibo core is Grade C. Capture supplementary Tail-Cut or continue provisionally.'
        : 'Sashibo core confidence is below 75%. Capture supplementary Tail-Cut or continue provisionally.',
    };
  }

  // Fallback if only tail was captured (e.g., demo/legacy record)
  if (!core && tail) {
    if (tail.outcome === 'accepted') return { status: 'final', grade: tail.label, basis: 'Tail cut' + note, origin };
    return { status: 'unresolved', reason: 'Tail cut result is uncertain or rejected' };
  }

  // Both Sashibo core and Tail cut captured
  if (core && tail) {
    if (core.outcome === 'invalid' || tail.outcome === 'invalid') {
      return { status: 'unresolved', reason: 'One of the sample images was rejected' };
    }
    if (tail.overridden) return { status: 'final', grade: tail.label, basis: 'Manual override (Tail cut)', origin: 'manual' };
    if (core.overridden && tail.outcome === 'accepted' && core.label === tail.label) {
      return { status: 'final', grade: core.label, basis: 'Both samples agree' + note, origin };
    }
    const avgConf = ((core.score || 0) + (tail.score || 0)) / 2;
    const bothBelow = core.outcome !== 'accepted' && tail.outcome !== 'accepted';
    const severeDisagreement = (core.label === 'A' && tail.label === 'C') || (core.label === 'C' && tail.label === 'A');
    if (bothBelow || avgConf < MIN_CONFIDENCE || severeDisagreement) {
      return {
        status: 'unresolved',
        conflict: true,
        reason: severeDisagreement
          ? `Severe disagreement: Core (${core.label}) vs Tail (${tail.label})`
          : `Combined confidence (${Math.round(avgConf * 100)}%) is below 75%`,
      };
    }
    if (core.label === tail.label) {
      return { status: 'final', grade: core.label, basis: 'Sashibo core and Tail cut agree' + note, origin };
    }
    const blended = combineGrades(core, tail);
    return { status: 'final', grade: blended, basis: `Blended Sashibo (${core.label}) + Tail (${tail.label})` + note, origin };
  }

  return { status: 'unresolved', reason: 'No accepted sample' };
}
function priceFor(s) {
  const r = resolve(s);
  if (r.status !== 'final') return { ok: false, why: 'The grade is not resolved yet.', kind: 'grade' };
  if (S.schedule.expired) return { ok: false, why: 'The approved rate schedule has expired. Refresh it or ask a supervisor.', kind: 'schedule' };
  const rate = S.schedule.rates[r.grade];
  return { ok: true, grade: r.grade, basis: r.basis, rate, total: calcTotalCentavos(s.weightTenths, rate), origin: r.origin };
}
const capText = (c) => (c.outcome === 'accepted' ? `Grade ${c.label} at ${Math.round(c.score * 100)}%` : c.outcome === 'uncertain' ? `Uncertain, closest ${c.label} at ${Math.round(c.score * 100)}%` : 'Rejected image');
/** Returns a new decisions list with a manual override added. target: 'all' (final grade) | 'core' | 'tail' */
function withOverride(decs, grade, target, extra = {}) {
  const t = target === 'all' || !target ? undefined : target;
  const kept = decs.filter((d) => !(d.manual && (t === undefined || !d.target || d.target === t)));
  return [...kept, { id: uid(), grade, manual: true, target: t, ...extra }];
}
const screenAfterGrade = (s) => {
  if (s.captures.length > 1) return 'paired';
  const last = s.captures[s.captures.length - 1] || {};
  return last.outcome === 'invalid' ? 'invalid' : 'result';
};

/* ---------- seed data ---------- */
function seed() {
  const mk = (id, minsAgo, w, caps, final, quote, sync, extra = {}) => ({
    id, uuid: uid(), createdAt: now - minsAgo * 60e3, weightTenths: w, batch: '', site: 'Davao landing center (demo site)', device: 'KIOSK-01 (Demo)', grader: 'Operator 01 (Demo)',
    captures: caps.map((c) => ({ id: uid(), type: c[0], code: c[1], label: c[2], score: c[3], outcome: c[4], inferMs: 700, attempt: 1 })),
    attempts: 0, decisions: [], weightCorrections: 0, final, quote, revision: 1, sync, offlineOrigin: false, demo: true,
    ackAt: sync === 'synced' ? now - minsAgo * 60e3 + 120e3 : null, prints: [], closed: true, ...extra,
  });
  const q = (g, w, ver = 3) => { const rate = S.schedule.rates[g]; return { grade: g, rateC: rate, weightTenths: w, totalC: calcTotalCentavos(w, rate), scheduleVersion: ver, scheduleId: 'PS-DEMO-03', revision: 1, confirmedAt: now, rounding: 'half-up to centavo' }; };
  S.records = [
    mk('TE-20261005-0006', 14, 360, [['core', 'UNC', 'B', 0.52, 'uncertain']], { status: 'unresolved', reason: 'A sample result is uncertain or rejected' }, null, 'pending', { offlineOrigin: true }),
    mk('TE-20261005-0005', 48, 470, [['core', 'A', 'A', 0.93, 'accepted'], ['tail', 'B', 'B', 0.86, 'accepted']], { status: 'final', grade: 'B', basis: 'Expert decision', origin: 'expert' }, q('B', 470), 'pending', {
      offlineOrigin: true,
      decisions: [{ id: uid(), grade: 'B', reason: 'Tail face shows duller color near the cut edge.', actor: 'Expert grader (Demo)', ts: now - 44 * 60e3, expectedRevision: 1 }],
      prints: [{ ts: now - 43 * 60e3, kind: 'Original', result: 'Receipt sent' }],
    }),
    mk('TE-20261005-0004', 96, 582, [['core', 'A', 'A', 0.95, 'accepted'], ['tail', 'A', 'A', 0.91, 'accepted']], { status: 'final', grade: 'A', basis: 'Both samples agree', origin: 'model' }, q('A', 582), 'synced', { prints: [{ ts: now - 95 * 60e3, kind: 'Original', result: 'Receipt sent' }] }),
    mk('TE-20261005-0003', 160, 318, [['core', 'B', 'B', 0.88, 'accepted']], { status: 'final', grade: 'B', basis: 'Single sample: Sashibo core', origin: 'model' }, q('B', 318), 'synced'),
    mk('TE-20261004-0021', 1400, 224, [['tail', 'C', 'C', 0.9, 'accepted']], { status: 'final', grade: 'C', basis: 'Single sample: Tail cut', origin: 'model' }, q('C', 224), 'failed', { stage: 'Image staged, metadata not acknowledged' }),
  ];
  S.lastAck = now - 95 * 60e3 + 120e3;
}
seed();

/* ---------- navigation / session ---------- */
function go(screen) {
  clearTimers(); S.prev = S.screen; S.screen = screen; S.help = false; S.toast = null; S.navDock = false; render();
  if (screen === 'completion') startCountdown();
  if (screen === 'pair') S.scanError = '';
}
function newSession() {
  const d = new Date(); const ymd = d.getFullYear() + pad(d.getMonth() + 1, 2) + pad(d.getDate(), 2);
  const idPrefix = `TE-${ymd}-`; // persisted records survive restarts: never reuse a local id
  S.counter = Math.max(S.counter, ...S.records.filter((x) => x.id.startsWith(idPrefix)).map((x) => parseInt(x.id.slice(idPrefix.length), 10) + 1 || 0));
  S.session = { id: uid(), recordId: `TE-${ymd}-${pad(S.counter++)}`, weightStr: '', grader: S.lastGrader || '', phone: S.phoneLinked ? 'connected' : 'waiting', weightTenths: 0, batch: '', sampleType: 'core', sampleTypes: ['core'], tailAvailability: 'pending', tailPromptOpen: false, captures: [], attempts: [], decisions: [], pending: null, job: null, weightCorrections: 0, editingWeight: false, startedAt: Date.now() };
  S.ui.batchOpen = false; S.print = null;
}
function persist(s) {
  let r = S.records.find((x) => x.id === s.recordId);
  if (!r) { r = { id: s.recordId, uuid: uid(), createdAt: Date.now(), batch: '', site: 'Davao landing center (demo site)', device: 'KIOSK-01 (Demo)', quote: null, revision: 1, sync: 'local', offlineOrigin: false, ackAt: null, prints: [], closed: false }; S.records.unshift(r); }
  Object.assign(r, { sessionId: s.id, stationId: S.kioskId || null, weightTenths: s.weightTenths, grader: s.grader, batch: s.batch, captures: s.captures.map((c) => ({ ...c })), attempts: s.attempts.length, decisions: s.decisions.slice(), weightCorrections: s.weightCorrections, final: resolve(s) });
  return r;
}
function clearPublicSession() { S.session = null; S.print = null; S.ui.reviewGrade = null; S.ui.reviewReason = ''; S.ui.expertCtx = null; }
function abandonSession() {
  const s = S.session;
  if (s && s.captures.length) { const r = persist(s); r.closed = true; enqueue(r); }
  clearPublicSession(); S.auth = null; S.dialog = null; go('welcome');
}
function finishToWelcome() { clearPublicSession(); S.auth = null; go('welcome'); }

/* ---------- sync (Supabase, same project as the kiosk; connectivity-triggered, no Realtime) ---------- */
const needsSync = (r) => !r.demo && r.closed && (r.sync === 'pending' || r.sync === 'failed');
function enqueue(r) {
  r.syncVersion = (r.syncVersion || 0) + 1; r.offlineOrigin = !cloudOk();
  if (r.sync === 'syncing') return; // the running sync notices syncVersion changed and runs again
  r.sync = 'pending'; r.stage = ''; r.lastSyncError = '';
  if (cloudOk()) uploadOne(r);
}
async function uploadOne(r) {
  if (r.sync === 'syncing' || r.demo) return false;
  if (!isSupabaseConfigured()) { r.sync = 'pending'; r.stage = 'Cloud not configured'; render(); return false; }
  const version = r.syncVersion || 0;
  r.sync = 'syncing'; r.stage = 'Signing in'; r.lastSyncError = ''; render();
  try {
    if (S.demo.cloudFailNext > 0) { S.demo.cloudFailNext--; throw new Error('Simulated cloud failure (demo control)'); }
    await syncRecord({ cloud: supabaseCloud, readImage: readEvidence }, r, {
      onStage: (stage) => { r.stage = stage; render(); },
      onImageUploaded: (key, path) => { r.remote = { ...(r.remote || {}), [key]: { imagePath: path } }; persistSoon(); },
    });
  } catch (e) {
    r.sync = 'failed'; r.stage = ''; r.lastSyncError = (e && e.message) || 'Unknown synchronization error'; render(); return false;
  }
  if ((r.syncVersion || 0) !== version) { r.sync = 'pending'; r.stage = ''; return uploadOne(r); } // changed mid-sync (e.g. expert decision)
  r.sync = 'synced'; r.stage = ''; r.ackAt = Date.now(); S.lastAck = r.ackAt; render(); return true;
}
async function syncBatch(filter) {
  if (!cloudOk() || S.syncing.active) return;
  const items = S.records.filter(filter);
  if (!items.length) return;
  S.syncing = { active: true, done: 0, total: items.length }; render();
  for (const r of items) { await uploadOne(r); S.syncing.done++; render(); }
  S.syncing.active = false; render();
}
const syncNow = () => syncBatch(needsSync);
const retryFailed = () => syncBatch((r) => needsSync(r) && r.sync === 'failed');
const counts = () => ({ pending: S.records.filter((r) => r.sync === 'pending').length, syncing: S.records.filter((r) => r.sync === 'syncing').length, failed: S.records.filter((r) => r.sync === 'failed').length, synced: S.records.filter((r) => r.sync === 'synced').length });
const syncLabel = (r) => ({ local: 'Saved locally', pending: 'Saved locally', syncing: 'Uploading…', synced: 'Synced', failed: 'Retry needed' }[r.sync]);

async function syncPendingRecords({ limit = 200, graders } = {}) {
  const selected = Array.isArray(graders) ? graders.map((g) => validateGraderName(g).toLowerCase()).filter(Boolean) : null;
  if (!cloudOk()) {
    if (selected && selected.length) {
      await AsyncStorage.setItem(PENDING_SYNC_GRADERS_KEY, JSON.stringify(selected)).catch(() => { });
    }
    toast('Offline — selected graders saved and will sync automatically when online.', 'amber');
    return { synced: 0, queued: true };
  }
  const items = S.records
    .filter((r) => needsSync(r) && (!selected || !selected.length || selected.includes(validateGraderName(r.grader).toLowerCase())))
    .slice(0, limit);
  if (!items.length) {
    S.syncModal = null;
    render();
    toast('No pending records to sync.', 'ok');
    return { synced: 0 };
  }
  S.syncModal = null;
  S.syncing = { active: true, done: 0, total: items.length };
  render();
  let slowTimer = setTimeout(() => {
    if (S.syncing.active) {
      S.slowWifiModal = { open: true, done: S.syncing.done, total: S.syncing.total };
      render();
    }
  }, 4000);
  let okCount = 0;
  for (const r of items) {
    const ok = await uploadOne(r);
    if (ok) okCount++;
    S.syncing.done++;
    if (S.slowWifiModal) S.slowWifiModal = { ...S.slowWifiModal, done: S.syncing.done, total: S.syncing.total };
    render();
  }
  clearTimeout(slowTimer);
  S.syncing.active = false;
  S.slowWifiModal = null;
  await AsyncStorage.removeItem(PENDING_SYNC_GRADERS_KEY).catch(() => { });
  render();
  toast(okCount === items.length ? `Synced ${okCount} record(s).` : `Synced ${okCount} of ${items.length} record(s).`, okCount === items.length ? 'ok' : 'amber');
  return { synced: okCount };
}

function openWelcomeSyncModal() {
  const groups = {};
  for (const r of S.records) {
    if (r.demo) continue;
    const g = validateGraderName(r.grader) || 'Unassigned';
    if (!groups[g]) groups[g] = { pending: 0, total: 0 };
    groups[g].total++;
    if (needsSync(r)) groups[g].pending++;
  }
  const sel = {};
  Object.keys(groups).forEach((g) => { sel[g] = groups[g].pending > 0; });
  S.syncModal = { open: true, groups, selected: sel };
  render();
}

/* ---------- startup ---------- */
async function runStartup() {
  const tok = uid(); S.startup = { tok, state: 'running', checks: [], fail: null }; S.screen = 'startup'; render();
  const f = S.demo.startupFault;
  const piProbe = S.demo.enabled
    ? Promise.resolve(true)
    : Promise.race([
      checkPiStatus(S.piApiUrl, 1).then(() => true),
      sleep(1000).then(() => false),
    ]).catch(() => false);
  const fastChecks = [
    ['Phone link', f === 'camera' ? { ok: false, msg: 'Phone link not responding' } : { ok: true, msg: 'Ready to pair' }],
    ['Storage', { ok: true, msg: 'Writable' }],
    ['Shift', { ok: S.shift.open, msg: S.shift.open ? 'Open' : 'Closed', soft: true }],
    ['Cloud', { ok: cloudOk() && isSupabaseConfigured(), msg: !isSupabaseConfigured() ? 'Not configured • saving on device' : cloudOk() ? 'Reachable' : 'Offline • saving on device', soft: true, warn: !cloudOk() || !isSupabaseConfigured() }],
  ];
  for (const [name, res] of fastChecks) {
    await sleep(60); if (S.startup.tok !== tok || S.screen !== 'startup') return;
    S.startup.checks.push({ name, ...res });
    if (!res.ok && !res.soft) { S.startup.state = 'fail'; S.startup.fail = `${name}: ${res.msg}`; render(); return; }
    render();
  }
  const piOk = await piProbe;
  if (S.startup.tok !== tok || S.screen !== 'startup') return;
  S.piStatus = piOk ? 'connected' : 'error';
  S.startup.checks.push({
    name: 'Raspberry Pi',
    ok: piOk,
    msg: piOk ? `Connected (${S.piApiUrl})` : `Not reachable (${S.piApiUrl})`,
    soft: true,
    warn: !piOk,
  });
  render();
  await sleep(150); if (S.startup.tok !== tok || S.screen !== 'startup') return;
  S.startup.state = 'ok'; go(S.onboarded ? 'welcome' : 'onboarding');
}

/* ---------- weight ---------- */
function weightCheck(str) {
  if (!str) return { ok: false, msg: '' };
  const t = parseTenths(str);
  if (t < 150) return { ok: false, msg: 'Enter a weight between 15.0 and 200.0 kg.' };
  if (t > 2000) return { ok: false, msg: "Above this site's maximum of 200.0 kg. Check the scale reading." };
  return { ok: true, t };
}
function setWeight(value) {
  const s = S.session;
  if (!s) return;
  if (value === 'Clear') s.weightStr = '';
  else if (value === 'Backspace') s.weightStr = s.weightStr.slice(0, -1);
  else if (value === '.' && s.weightStr.includes('.')) return;
  else if (/^[0-9.]$/.test(value)) s.weightStr = sanitizeWeight(s.weightStr + value);
  else s.weightStr = sanitizeWeight(value);
  render();
}
function sanitizeWeight(v) {
  v = String(v).replace(',', '.').replace(/[^0-9.]/g, '');
  const parts = v.split('.');
  const whole = parts[0].slice(0, 3);
  if (parts.length > 1) return whole + '.' + parts.slice(1).join('').slice(0, 1);
  return whole;
}

/* ---------- capture / analysis ---------- */
async function doCapture() {
  if (S.busy) return; const s = S.session; if (!s || !s.sampleType) return;
  if (!S.shift.open) { toast('Shift is closed. Capture is blocked.', 'err'); return; }
  if (!camRef || !S.camReady) { toast('The camera is not ready yet. Allow camera access and try again.', 'err'); return; }
  S.busy = true; S.flash = true; render();
  const tok = s.id; let uri = null;
  try { const ph = await camRef.takePictureAsync({ quality: 0.7, skipProcessing: true }); uri = ph && ph.uri; }
  catch (e) { uri = null; }
  if (!uri) { S.busy = false; S.flash = false; toast('The phone could not take the picture. Try again.', 'err'); return; }
  await sleep(150);
  S.busy = false; S.flash = false;
  if (!S.session || S.session.id !== tok || S.screen !== 'camera') { render(); return; }
  s.pending = { id: uid(), type: s.sampleType, ts: Date.now(), uri };
  go('review');
}
async function doUpload() {
  if (S.busy || S.picking) return; const s = S.session; if (!s || !s.sampleType) return;
  if (!S.shift.open) { toast('Shift is closed. Capture is blocked.', 'err'); return; }
  S.picking = true; render();
  const tok = s.id; let uri = null;
  try {
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsEditing: false, quality: 0.8 });
    if (!res.canceled && res.assets && res.assets[0]) uri = res.assets[0].uri;
  } catch (e) {
    S.picking = false; toast("Couldn't open your photos. Try again.", 'err'); return;
  }
  S.picking = false;
  if (!uri) { render(); return; } // the user closed the picker
  if (!S.session || S.session.id !== tok || S.screen !== 'camera') { render(); return; }
  s.pending = { id: uid(), type: s.sampleType, ts: Date.now(), uri, source: 'upload' };
  go('review');
}
async function doPiSnapshot() {
  if (S.busy || S.picking) return; const s = S.session; if (!s || !s.sampleType) return;
  if (!S.shift.open) { toast('Shift is closed. Capture is blocked.', 'err'); return; }
  S.busy = true; render();
  const tok = s.id;
  try {
    const uri = await capturePiSnapshot(S.piApiUrl, S.piSnapshotUrl);
    S.busy = false;
    if (!S.session || S.session.id !== tok || S.screen !== 'camera') { render(); return; }
    s.pending = { id: uid(), type: s.sampleType, ts: Date.now(), uri, source: 'pi-camera' };
    go('review');
  } catch (e) {
    S.busy = false;
    toast((e && e.message) || 'Could not capture from Raspberry Pi camera.', 'err');
    render();
  }
}
const piErrorText = (e) => {
  if (!e) return 'The Raspberry Pi could not grade the image.';
  if (e.message === 'timeout' || e.name === 'AbortError') return 'The Raspberry Pi took too long to answer.';
  if (e.message === 'unreachable' || /network request failed/i.test(e.message || '')) return `Cannot reach the Raspberry Pi at ${S.piApiUrl}.`;
  return e.message || 'The Raspberry Pi could not grade the image.';
};

async function confirmGraderIdentity(typed) {
  const clean = validateGraderName(typed);
  if (!clean) return null;
  const matches = findGraderMatches(clean, S.records);
  if (matches.length) {
    S.graderCheckModal = {
      typed: clean,
      match: matches[0],
      addingInitial: false,
      initialStr: '',
      error: '',
    };
    render();
    return null;
  }
  const s = S.session;
  if (s) { s.grader = clean; S.lastGrader = clean; }
  go('weight');
  return clean;
}

function showPlacementTutorial(step = 1) {
  S.tutorialStep = Math.max(1, Math.min(3, step));
  go('tutorial');
  if (S.tutorialStep < 3) {
    S.timers.tut = setTimeout(() => {
      if (S.screen === 'tutorial') showPlacementTutorial(S.tutorialStep + 1);
    }, 2000);
  }
}

function tailCutAvailabilityModal() {
  const s = S.session;
  if (!s) return;
  s.tailPromptOpen = true;
  render();
}

async function captureAndGrade(sampleType, fileUri) {
  const s = S.session;
  if (!s) return;
  const typeKey = sampleType === 'Tail cut' || sampleType === 'tail' ? 'tail' : 'core';
  s.sampleType = typeKey;
  if (fileUri) {
    s.pending = { id: uid(), type: typeKey, ts: Date.now(), uri: fileUri, source: 'file' };
    return runAnalysis();
  }
  return doPiSnapshot();
}

function applyOverride(pin, grade, reason) {
  const s = S.session;
  if (!s) return false;
  const cleanPin = String(pin || '').trim();
  if (cleanPin !== '1234' && cleanPin !== '2468') {
    S.ui.ovPinError = 'Invalid supervisor PIN (use 1234 or 2468).';
    render();
    return false;
  }
  const cleanReason = String(reason || '').trim();
  const tg = s.captures.length > 1 ? S.ui.ovTarget : 'all';
  if (!grade || !tg || cleanReason.length < 3) return false;
  S.ui.ovPinError = '';
  s.decisions = withOverride(s.decisions, grade, tg, {
    reason: cleanReason,
    actor: cleanPin === '2468' ? 'Expert supervisor' : 'Supervisor',
    ts: Date.now(),
    expectedRevision: 1,
  });
  persist(s);
  const last = s.captures[s.captures.length - 1];
  go(s.captures.length > 1 ? 'paired' : last.outcome === 'invalid' ? 'invalid' : 'result');
  toast(tg === 'all' ? 'Grade set to ' + grade + ' by manual override.' : TYPES[tg].name + ' set to ' + grade + ' by manual override.');
  return true;
}

function onSessionComplete() {
  const s = S.session;
  if (!s) return;
  const r = persist(s);
  r.closed = true;
  enqueue(r);
  recordPlacementSession(s.grader).catch(() => { });
  go('completion');
}

function printOrSkipReceipt(action = 'print') {
  if (action === 'skip') {
    S.skipReceiptModal = true;
    render();
    return;
  }
  return doPrint();
}

function openRecordDetail(recordId) {
  S.ui.histSel = recordId;
  go('history');
}

async function runAnalysis() {
  const s = S.session; if (!s || !s.pending) return;
  const job = uid(), tok = s.id;
  s.job = { id: job, stage: 0, state: 'run' };
  go('analysis');
  const alive = () => S.session && S.session.id === tok && S.session.job && S.session.job.id === job && S.screen === 'analysis';
  const p = s.pending;
  const t0 = Date.now();
  let res;

  try {
    if (!PI_IMAGE_TYPE[p.type]) throw new Error(`Unsupported sample type: ${p.type}`);
    s.job.stage = 1;
    render();
    if (S.demo.enabled) {
      await sleep(700);
      if (!alive()) return;
      if (S.demo.timeoutOnce) { S.demo.timeoutOnce = false; throw new Error('timeout'); }
      const code = S.demo.queue.length ? S.demo.queue.shift() : S.demo.next;
      if (code === 'INV') {
        res = { id: 'demo-' + uid(), grade: 'INVALID', letter: null, confidence: 0.15, invalid: true, scores: { GRADE_A: 0.05, GRADE_B: 0.05, GRADE_C: 0.05, INVALID: 0.85 } };
      } else if (code === 'UNC') {
        res = { id: 'demo-' + uid(), grade: 'GRADE_C', letter: 'C', confidence: 0.68, invalid: false, scores: { GRADE_A: 0.10, GRADE_B: 0.22, GRADE_C: 0.68, INVALID: 0 } };
      } else {
        const g = ['A', 'B', 'C'].includes(code) ? code : 'A';
        const conf = g === 'A' ? 0.92 : g === 'B' ? 0.88 : 0.84;
        res = {
          id: 'demo-' + uid(),
          grade: 'GRADE_' + g,
          letter: g,
          confidence: conf,
          invalid: false,
          scores: { GRADE_A: g === 'A' ? conf : 0.06, GRADE_B: g === 'B' ? conf : 0.08, GRADE_C: g === 'C' ? conf : 0.02, INVALID: 0 },
        };
      }
    } else {
      res = await gradeWithPi(p.uri, PI_IMAGE_TYPE[p.type], S.piApiUrl);
    }
  } catch (e) {
    if (!alive()) return;
    const msg = piErrorText(e);
    if (/wrong sample type|cannot be determined|422/i.test(msg)) {
      s.pending = null;
      s.job = null;
      S.cannotDetermineModal = {
        open: true,
        sampleType: p.type,
        message: `This image is not recognized as a valid ${TYPES[p.type].name}. Camera reset — please scan again.`,
      };
      go('camera');
      return;
    }
    s.job.state = 'error';
    s.job.msg = msg;
    render();
    return;
  }

  if (!alive()) return;
  if (res.invalid) {
    s.pending = null;
    s.job = null;
    S.cannotDetermineModal = {
      open: true,
      sampleType: p.type,
      message: `This image is not recognized as a valid ${TYPES[p.type].name}. Camera reset — please scan again.`,
    };
    go('camera');
    return;
  }
  s.job.stage = 2;
  render();

  const confidence = Number(res.confidence);
  const outcome = res.invalid
    ? 'invalid'
    : confidence < MIN_CONFIDENCE
      ? 'uncertain'
      : 'accepted';

  const prior = s.captures.findIndex((c) => c.type === p.type);
  const attempt = s.attempts.filter((a) => a.type === p.type).length + 1;
  const keptUri = await persistEvidence(p.uri, p.id);
  if (!alive()) return;

  const letter = res.letter || res.grade || 'B';
  const codeKey = res.invalid ? 'INV' : outcome === 'uncertain' ? 'UNC' : letter;
  const cap = {
    id: p.id,
    type: p.type,
    outcome,
    attempt,
    ts: p.ts,
    uri: keptUri,
    demoAsset: p.source === 'demo' || S.demo.enabled ? demoAssetFor(p.type, codeKey) : null,
    code: codeKey,
    label: res.invalid ? 'Invalid' : letter,
    score: Number.isFinite(confidence) ? confidence : 0,
    scores: res.scores || null,
    piGradingId: res.id || null,
    inferMs: Number(res.inferMs) || (Date.now() - t0),
  };

  if (prior >= 0) s.attempts.push(s.captures.splice(prior, 1)[0]);
  s.captures.push(cap);
  s.pending = null;
  s.job = null;
  if (cap.type === 'core' && !res.invalid) {
    const decision = resolve(s);
    s.tailPromptOpen = Boolean(decision.tailNeeded);
  } else {
    s.tailPromptOpen = false;
  }
  persist(s);

  go(screenAfterGrade(s));

  if (cap.outcome === 'invalid') toast('Invalid image', 'err');
}
/* ---------- print / countdown / toast / dialog ---------- */
const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---- shared receipt helpers ---- */
const fmtReceiptDate = (ts) => { const d = manila(ts); return `${MON[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}, ${clock12(d)}`; };
// One line per sample (core and/or tail), using overrides where they exist.
const sampleLines = (r) => effCaps(r).map((c) => ({
  name: `${TYPES[c.type].name} (Fish 1)`,
  grade: c.outcome === 'accepted' ? c.label : '—',
  note: c.overridden ? `Manual override (model: ${capText(c.raw)})` : c.outcome === 'accepted' ? `Confidence: ${Math.round(c.score * 100)}%` : capText(c),
}));
// Deterministic pseudo-barcode from the record id.
function barcodeBars(id) {
  const seq = ('7' + id).split('').map((ch) => ch.charCodeAt(0)); const bars = []; let x = 0;
  for (let i = 0; i < 52; i++) { const v = seq[i % seq.length] + i * 7; const w = 1 + (v % 3); bars.push({ x, w }); x += w + 1 + ((v >> 2) % 2); }
  return { bars, width: x };
}

function receiptHtml(r) {
  const q = r.quote, lines = sampleLines(r), bc = barcodeBars(r.id);
  const items = lines.map((l) => `
    <div class="row"><span class="b">${esc(l.name)}</span><span class="b">Grade ${esc(l.grade)}</span></div>
    <div class="it">${esc(l.note)}</div>`).join('');
  const bars = bc.bars.map((b) => `<rect x="${b.x}" y="0" width="${b.w}" height="40" fill="#4a4a46"/>`).join('');
  return `<html><head><meta name="viewport" content="width=device-width, initial-scale=1.0" /><style>
    body{font-family:'Courier New',monospace;color:#1a1a18;margin:0;padding:24px;display:flex;justify-content:center;background:#fff}
    .paper{width:320px;background:#FBFAF6;padding:24px 28px;box-sizing:border-box}
    .c{text-align:center}.t{font-size:22px;font-weight:700;letter-spacing:1px;margin-top:10px}
    .sub{font-size:13px;color:#6b6b66;margin:4px 0 14px}
    .d{border-top:1px dashed #b5b5ae;margin:14px 0}.s{border-top:1px solid #d5d5ce;margin:14px 0 0}
    .row{display:flex;justify-content:space-between;gap:8px;font-size:14px;margin:7px 0}
    .k{color:#6b6b66}.b{font-weight:700}.h{font-size:12px;font-weight:700;color:#6b6b66}
    .it{font-size:12px;font-style:italic;color:#6b6b66;margin:-2px 0 8px}
    .tot{font-size:20px;font-weight:700;margin:12px 0}.f{font-size:12px;color:#9b9b95}
  </style></head><body><div class="paper">
    <div class="c t">TUNAEYE KIOSK</div><div class="c sub">Certified Quality Inspection</div>
    <div class="d"></div>
    <div class="row"><span class="k">ORDER NO:</span><span class="b">#${esc(r.id)}</span></div>
    <div class="row"><span class="k">DATE:</span><span>${esc(fmtReceiptDate(q.confirmedAt))}</span></div>
    <div class="row"><span class="k">INSPECTOR:</span><span>${esc(r.grader || '—')}</span></div>
    <div class="d"></div>
    <div class="row h"><span>ITEM</span><span>GRADE</span></div>
    ${items}
    <div class="row"><span class="k">Weight (manual)</span><span class="b">${esc(fmtKg(q.weightTenths))}</span></div>
    <div class="row"><span class="k">Rate</span><span>${esc(fmtMoney(q.rateC))}/kg</span></div>
    <div class="row"><span class="k">Estimate</span><span class="b">${esc(fmtMoney(q.totalC))}</span></div>
    <div class="s"></div>
    <div class="row tot"><span>TOTAL:</span><span>Grade ${esc(r.final.grade)}</span></div>
    <div class="it">${esc(r.final.basis)}</div>
    <div class="d"></div>
    <div class="c"><svg width="240" height="56" viewBox="0 0 ${bc.width} 40" preserveAspectRatio="none">${bars}</svg>
    <div class="f" style="margin-top:6px">* ${esc(r.id)} *</div></div>
    <div class="c" style="margin-top:14px;font-size:13px">Thank you for using TunaEye Kiosk!</div>
    <div class="c f" style="margin-top:6px">Decision-support estimate. Not a payment record.</div>
  </div></body></html>`;
}
/** Opens the system print dialog (Android print service / iOS AirPrint). Resolves { ok } or { cancelled } or { error }. */
async function printReceipt(r) {
  try { await Print.printAsync({ html: receiptHtml(r) }); return { ok: true }; }
  catch (e) {
    const msg = (e && e.message) || 'Printing failed.';
    return /cancel|did not complete|dismiss/i.test(msg) ? { cancelled: true } : { error: msg };
  }
}
async function doPrint() {
  const s = S.session; if (!s || !s.quote) return;
  if (S.print && S.print.state === 'sending') return;
  S.print = { state: 'sending' }; render(); const tok = s.id;
  const r = S.records.find((x) => x.id === s.recordId);
  let res;
  if (S.demo.printer !== 'ok') { // demo fault injection still works
    res = { error: S.demo.printer === 'paper' ? 'Paper out. Load a roll and try again.' : 'The printer did not respond.' }; S.demo.printer = 'ok';
  } else res = await printReceipt(r);
  if (!S.session || S.session.id !== tok || S.screen !== 'receipt') return;
  if (res.cancelled) { S.print = null; render(); return; }
  if (res.error) { S.print = { state: 'error', msg: res.error }; r.prints.push({ ts: Date.now(), kind: 'Original', result: 'Failed: ' + res.error }); render(); return; }
  r.prints.push({ ts: Date.now(), kind: r.prints.some((p) => p.result === 'Receipt sent') ? 'Copy' : 'Original', result: 'Receipt sent' });
  S.print = { state: 'sent' }; render();
}
function saveReceiptToGallery() {
  const s = S.session;
  if (!s || !s.quote) return;
  // Expo Go-safe fallback: no native MediaLibrary module is required.
  // The receipt remains available on this screen so the user can use the
  // Android screenshot/save controls. Real automatic gallery export should
  // be enabled later in a development build with a matching Expo SDK.
  S.receiptSaved = true;
  toast('Receipt ready — use your phone screenshot/save option to keep a copy.', 'ok');
  render();
}

function startCountdown() {
  S.countdown = 3; S.paused = false;
  S.timers.cd = setInterval(() => { S.countdown--; if (S.countdown <= 0) { act('another'); return; } render(); }, 1000);
}
function toast(msg, kind) { S.toast = { msg, kind }; render(); clearTimeout(S.timers.toast); S.timers.toast = setTimeout(() => { S.toast = null; render(); }, 2800); }
function ask(title, body, acts) { S.dialog = { title, body, acts }; render(); }

/* ---------- phone pairing: the phone scans the kiosk's QR code ---------- */
// The kiosk shows a QR such as  tunaeye://pair?k=KIOSK-01  (or https://kiosk.tunaeye.example/pair?k=KIOSK-01)

const DEFAULT_PI_API = PI_CONFIG.apiUrl;
const PI_URL_STORAGE_KEY = '@tunaeye/pi_api_url';

let pairingInProgress = false;

function parseKioskCode(data) {
  const str = String(data || '').trim();

  if (!str) return null;

  // Support kiosk JSON QR format
  try {
    const qr = JSON.parse(str);

    if (qr && typeof qr.apiUrl === 'string' && qr.apiUrl.trim()) {
      const urls = derivePiCameraUrls(qr.apiUrl, qr.streamUrl || null, qr.snapshotUrl || null);
      return {
        kioskId: qr.kioskId || 'KIOSK-01',
        ssid: qr.ssid || 'TunaRpi',
        apiUrl: urls.apiUrl,
        streamUrl: urls.streamUrl,
        snapshotUrl: urls.snapshotUrl,
      };
    }
  } catch {
    // Try legacy pairing URL or direct host/URL
  }

  // Support direct HTTP/HTTPS URL or host:port QR code (e.g. "10.42.0.1:5000" or "http://10.42.0.1:5000")
  if (/^(https?:\/\/)?[A-Za-z0-9.-]+:\d+(\/.*)?$/i.test(str) || /^https?:\/\//i.test(str)) {
    const urls = derivePiCameraUrls(str);
    return {
      kioskId: 'KIOSK-01',
      ssid: 'TunaRpi',
      apiUrl: urls.apiUrl,
      streamUrl: urls.streamUrl,
      snapshotUrl: urls.snapshotUrl,
    };
  }

  // Support old TunaEye QR format
  const m = /[?&]k=([A-Za-z0-9-]{3,32})/.exec(str);

  if (
    m &&
    /^(tunaeye:\/\/pair|https:\/\/kiosk\.tunaeye\.example\/pair)/.test(str)
  ) {
    const urls = derivePiCameraUrls(S.piApiUrl || DEFAULT_PI_API);
    return {
      kioskId: m[1],
      ssid: 'TunaRpi',
      apiUrl: urls.apiUrl,
      streamUrl: urls.streamUrl,
      snapshotUrl: urls.snapshotUrl,
    };
  }

  return null;
}

async function verifyKioskConnection(config) {
  const status = await checkPiStatus(config.apiUrl || S.piApiUrl || DEFAULT_PI_API, 1);
  if (!status || typeof status !== 'object') {
    throw new Error('Invalid Raspberry Pi response');
  }
  return status;
}

function connectPhone(config) {
  const s = S.session;

  if (!s) return;

  const cfg = typeof config === 'string'
    ? { kioskId: config, apiUrl: S.piApiUrl || DEFAULT_PI_API, streamUrl: null, snapshotUrl: null }
    : (config || {});

  const urls = derivePiCameraUrls(cfg.apiUrl || S.piApiUrl || DEFAULT_PI_API, cfg.streamUrl || null, cfg.snapshotUrl || null);

  s.phone = 'connected';

  S.phoneLinked = true;
  S.kioskId = cfg.kioskId || 'KIOSK-01';
  S.piApiUrl = urls.apiUrl;
  S.piUrlDraft = urls.apiUrl;
  S.piStreamUrl = urls.streamUrl;
  S.piSnapshotUrl = urls.snapshotUrl;
  S.piStatus = 'connected';
  S.scanError = '';
  AsyncStorage.setItem(PI_URL_STORAGE_KEY, S.piApiUrl).catch(() => { });

  render();
}

async function pairWithKiosk(data) {
  if (pairingInProgress) return false;

  const config = parseKioskCode(data);

  if (!config) {
    S.scanError =
      'Invalid TunaEye QR code. Scan the QR displayed by the kiosk.';
    render();
    return false;
  }

  pairingInProgress = true;

  S.piStatus = 'connecting';
  S.scanError = '';
  render();

  try {
    await verifyKioskConnection(config);

    if (!S.session || S.screen !== 'pair') {
      return false;
    }

    connectPhone(config);

    return true;
  } catch (error) {
    S.phoneLinked = false;
    S.piStatus = 'error';

    if (S.session) {
      S.session.phone = 'waiting';
    }

    S.scanError =
      `Cannot reach Raspberry Pi. Connect to ` +
      `${config.ssid} Wi-Fi and scan again.`;

    console.log('TunaEye pairing failed:', error);

    render();
    return false;
  } finally {
    pairingInProgress = false;
  }
}

let askCamera = () => { };
let camRef = null;


async function checkRaspberryPi() {
  S.piStatus = 'connecting'; render();
  try {
    await checkPiStatus(S.piApiUrl);
    S.piStatus = 'connected';
  } catch (e) {
    console.log('Pi connection failed:', e);
    S.piStatus = 'error';
  }
  render();
}
/* ====================================================================== */
/* actions                                                                 */
/* ====================================================================== */
const A = {
  retryStartup() { runStartup(); },
  checkPi() { checkRaspberryPi(); },
  start() { if (!S.shift.open) return; newSession(); go('grader'); },
  openShift() { S.shift = { open: true, since: Date.now(), operator: 'Operator 01 (Demo)' }; render(); },
  closeShift() { ask('Close the shift?', 'Grading will be blocked until a shift is opened again. Saved results are kept.', [{ label: 'Keep open', act: 'closeDialog' }, { label: 'Close shift', act: 'doCloseShift', kind: 'danger' }]); },
  doCloseShift() { S.shift.open = false; S.dialog = null; render(); },
  closeDialog() { S.dialog = null; render(); },
  closeHelp() { S.help = false; render(); },
  help() { S.help = true; render(); },
  go(a) { S.dialog = null; go(a); },
  goSync() { openWelcomeSyncModal(); },
  pairNext() { const s = S.session; if (s.phone !== 'connected') return; go('camera'); },
  simPhone() { connectPhone({ kioskId: 'KIOSK-01', apiUrl: S.piApiUrl || DEFAULT_PI_API }); },
  skipDemo() { connectPhone({ kioskId: 'KIOSK-01', apiUrl: S.piApiUrl || DEFAULT_PI_API }); },
  setPiUrlDraft(v) { S.piUrlDraft = v; render(); },
  async connectPiUrl() {
    const url = normalizePiUrl(S.piUrlDraft || S.piApiUrl || DEFAULT_PI_API);
    if (!/^https?:\/\//i.test(url)) {
      S.scanError = 'Enter a valid http:// or https:// Raspberry Pi URL.';
      render();
      return;
    }
    S.piStatus = 'connecting';
    S.scanError = '';
    render();
    try {
      await verifyKioskConnection({ apiUrl: url });
      connectPhone({ kioskId: 'KIOSK-01', ssid: 'TunaRpi', apiUrl: url, streamUrl: null });
    } catch (error) {
      S.phoneLinked = false;
      S.piStatus = 'error';
      if (S.session) S.session.phone = 'waiting';
      S.scanError = `Cannot reach Raspberry Pi at ${url}.`;
      render();
    }
  },
  async savePiUrl() {
    const url = normalizePiUrl(S.piUrlDraft);
    if (!/^https?:\/\//i.test(url)) { toast('Enter a valid http:// or https:// URL.', 'err'); return; }
    S.piApiUrl = url;
    S.piUrlDraft = url;
    AsyncStorage.setItem(PI_URL_STORAGE_KEY, url).catch(() => { });
    await checkRaspberryPi();
    toast(S.piStatus === 'connected' ? `Connected to ${url}` : `Saved ${url}, but Raspberry Pi is not reachable.`, S.piStatus === 'connected' ? 'ok' : 'err');
  },
  repair() { const s = S.session; S.phoneLinked = false; s.phone = 'waiting'; S.scanError = ''; render(); },
  allowCamera() { askCamera(); },
  openSettings() { Linking.openSettings().catch(() => { }); },
  onbNext() { if (S.onbStep < ONB.length - 1) { S.onbStep++; render(); } else A.onbDone(); },
  onbBack() { if (S.onbStep > 0) { S.onbStep--; render(); } },
  onbSkip() { A.onbDone(); },
  onbDone() { S.onboarded = true; S.onbStep = 0; go('welcome'); },
  showOnboarding() { S.onbStep = 0; S.coached = {}; S.tips = true; go('onboarding'); },
  gotIt() { S.coached[S.screen] = true; render(); },
  hideTips() { S.tips = false; render(); },
  toggleNavDock(v) { S.navDock = v; render(); },
  toggleBatch() { S.ui.batchOpen = !S.ui.batchOpen; render(); },
  goHistory() { S.ui.histSel = null; go('history'); },
  openHist(id) { S.ui.histSel = id; render(); },
  closeHist() { S.ui.histSel = null; render(); },
  async weightNext() {
    const s = S.session, c = weightCheck(s.weightStr); if (!c.ok) return;
    if (s.editingWeight) {
      s.weightTenths = c.t; s.weightCorrections++; s.editingWeight = false; persist(s);
      go(s.editFrom || 'price'); return;
    }
    s.weightTenths = c.t;
    s.sampleType = 'core';
    s.sampleTypes = ['core'];
    const skipTut = await shouldSkipPlacementTutorial(s.grader);
    if (!skipTut) {
      showPlacementTutorial(1);
    } else {
      go(s.phone === 'connected' ? 'camera' : 'pair');
    }
  },
  graderNext() {
    const s = S.session;
    const clean = validateGraderName(s.grader);
    if (clean.length < 1) return;
    confirmGraderIdentity(clean);
  },
  tutNext() {
    if (S.tutorialStep < 3) showPlacementTutorial(S.tutorialStep + 1);
    else { const s = S.session; go(s && s.phone === 'connected' ? 'camera' : 'pair'); }
  },
  tutClose() {
    clearTimeout(S.timers.tut);
    const s = S.session;
    go(s && s.phone === 'connected' ? 'camera' : 'pair');
  },
  dismissCannotDetermine() {
    S.cannotDetermineModal = null;
    render();
  },
  syncToggleGrader(g) {
    if (!S.syncModal) return;
    S.syncModal.selected[g] = !S.syncModal.selected[g];
    render();
  },
  syncToggleAll() {
    if (!S.syncModal) return;
    const keys = Object.keys(S.syncModal.groups);
    const allOn = keys.every((k) => S.syncModal.selected[k]);
    keys.forEach((k) => { S.syncModal.selected[k] = !allOn; });
    render();
  },
  syncStartSelected() {
    if (!S.syncModal) return;
    const graders = Object.keys(S.syncModal.selected).filter((k) => S.syncModal.selected[k]);
    syncPendingRecords({ limit: 200, graders });
  },
  syncModalClose() { S.syncModal = null; render(); },
  slowWifiBg() { S.slowWifiModal = null; render(); },
  graderMatchYes() {
    const m = S.graderCheckModal?.match;
    const s = S.session;
    if (m && s) { s.grader = m.name; S.lastGrader = m.name; }
    S.graderCheckModal = null;
    go('weight');
  },
  graderMatchNo() {
    if (!S.graderCheckModal) return;
    S.graderCheckModal.addingInitial = true;
    S.graderCheckModal.error = '';
    render();
  },
  graderInitialKey(k) {
    const m = S.graderCheckModal;
    if (!m) return;
    if (k === 'del') m.initialStr = m.initialStr.slice(0, -1);
    else if (m.initialStr.length < 4) m.initialStr += k;
    m.error = '';
    render();
  },
  graderInitialSet(v) {
    const m = S.graderCheckModal;
    if (!m) return;
    m.initialStr = String(v || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 4);
    m.error = '';
    render();
  },
  graderInitialConfirm() {
    const m = S.graderCheckModal;
    const s = S.session;
    if (!m || !s || !m.initialStr.length) return;
    const candidate = validateGraderName(`${m.typed} ${m.initialStr}.`);
    const dup = S.records.some((r) => validateGraderName(r.grader).toLowerCase() === candidate.toLowerCase());
    if (dup) {
      m.error = `"${candidate}" already exists — add 1 more letter or number`;
      render();
      return;
    }
    s.grader = candidate;
    S.lastGrader = candidate;
    S.graderCheckModal = null;
    go('weight');
  },
  graderCheckCancel() { S.graderCheckModal = null; render(); },
  cancelSession() {
    const s = S.session; const has = s && s.captures.length;
    ask('Cancel this session?', has ? 'Saved results stay on this device for review. The weight and any unsaved image are cleared.' : 'The weight and anything entered on this screen will be cleared.', [{ label: 'Keep grading', act: 'closeDialog' }, { label: 'Cancel session', act: 'abandon', kind: 'danger' }]);
  },
  abandon() { abandonSession(); },
  sampleBack() { const s = S.session; go(s.captures.length ? 'result' : 'grader'); },
  pick(t) {
    const s = S.session;
    if (s.captures.some((c) => c.type === t)) return;
    if (t === 'core') {
      if (!s.sampleTypes.includes('core')) s.sampleTypes = ['core', ...s.sampleTypes];
      s.sampleType = 'core';
      render();
      return;
    }
    const hasTail = s.sampleTypes.includes('tail');
    s.sampleTypes = hasTail ? ['core'] : ['core', 'tail'];
    s.sampleType = s.captures.some((c) => c.type === 'core') ? 'tail' : 'core';
    render();
  },
  sampleNext() {
    const s = S.session;
    if (!s.sampleTypes.length) s.sampleTypes = ['core'];
    const ordered = ['core', 'tail'].filter((t) => s.sampleTypes.includes(t));
    const next = ordered.find((t) => !s.captures.some((c) => c.type === t)) || ordered[0];
    s.sampleType = next;
    go(s.phone === 'connected' ? 'align' : 'pair');
  },
  captureTail() {
    const s = S.session;
    if (!s) return;
    s.tailAvailability = 'available';
    s.tailPromptOpen = false;
    if (!s.sampleTypes.includes('tail')) s.sampleTypes = ['core', 'tail'];
    s.sampleType = 'tail';
    persist(s);
    go(s.phone === 'connected' ? 'camera' : 'pair');
  },
  tailNotAvailable() {
    const s = S.session;
    if (!s) return;
    s.tailAvailability = 'not_available';
    s.tailPromptOpen = false;
    persist(s);
    render();
  },
  openTailPrompt() {
    const s = S.session;
    if (!s) return;
    s.tailPromptOpen = true;
    render();
  },
  capture() { doCapture(); },
  capturePi() { doPiSnapshot(); },
  setCamSource(src) { S.camSource = src; render(); },
  demoScan() {
    const s = S.session; if (!s) return;
    s.pending = { id: uid(), type: s.sampleType || 'core', ts: Date.now(), uri: null, source: 'demo' };
    runAnalysis();
  },
  toggleDemoMode() {
    S.demo.enabled = !S.demo.enabled;
    if (S.demo.enabled) {
      S.phoneLinked = true;
      S.piStatus = 'connected';
      S.kioskId = 'DEMO-01';
      if (S.session) S.session.phone = 'connected';
      toast('Demo mode ON — simulated Pi & camera enabled.', 'ok');
    } else {
      toast('Demo mode OFF — live Raspberry Pi mode.', 'ok');
    }
    render();
  },
  openDemoDrawer() { S.drawer = true; render(); },
  uploadImage() { doUpload(); },
  retake() { const s = S.session; s.pending = null; s.job = null; go('camera'); },
  useImage() { runAnalysis(); },
  retryAnalysis() { runAnalysis(); },
  retakeSaved() { const s = S.session; s.pending = null; const c = s.captures[s.captures.length - 1]; s.decisions = s.decisions.filter((d) => !(d.manual && (!d.target || d.target === c.type))); s.sampleType = c.type; go('camera'); },
  retakeType(t) { const s = S.session; s.decisions = s.decisions.filter((d) => !(d.manual && (!d.target || d.target === t))); s.sampleType = t; go('camera'); },
  addOther() { const s = S.session; s.sampleType = other(s.captures[s.captures.length - 1].type); go('sample'); },
  discardSample() { const s = S.session; const c = s.captures.pop(); s.attempts.push(c); persist(s); go(s.captures.length > 1 ? 'paired' : 'result'); },
  toPrice() { persist(S.session); go('price'); },
  correctWeight() { const s = S.session; s.editingWeight = true; s.editFrom = S.screen; go('weight'); },
  refreshRates() {
    if (!cloudOk()) { toast("Can't reach the cloud. Rates were not refreshed.", 'err'); return; }
    const sc = S.schedule; const ver = sc.version + (sc.expired ? 1 : 0);
    S.schedule = { ...sc, version: ver, expired: false, id: 'PS-DEMO-0' + ver, validUntil: 'Nov 30, 2026' };
    toast('Rates are up to date (demo schedule v' + S.schedule.version + '). Past records are unchanged.');
  },
  confirmQuote() {
    const s = S.session, p = priceFor(s); if (!p.ok) return;
    const r = persist(s); if (r.quote && r.closed) return;
    r.quote = { grade: p.grade, rateC: p.rate, weightTenths: s.weightTenths, totalC: p.total, scheduleVersion: S.schedule.version, scheduleId: S.schedule.id, revision: 1, confirmedAt: Date.now(), rounding: 'half-up to centavo' };
    r.closed = true; s.quote = r.quote; enqueue(r); S.print = null; S.receiptSaved = false; S.receiptCaptureRef = null; go('receipt');
  },
  print() { printOrSkipReceipt('print'); },
  skipReceipt() { printOrSkipReceipt('skip'); },
  confirmSkipReceipt() { S.skipReceiptModal = false; onSessionComplete(); },
  cancelSkipReceipt() { S.skipReceiptModal = false; render(); },
  doneReceipt() { onSessionComplete(); },
  saveGallery() { saveReceiptToGallery(); },
  stay() { clearInterval(S.timers.cd); S.paused = true; render(); },
  finish() { finishToWelcome(); },
  another() {
    const keepGrader = S.session?.grader || S.lastGrader || '';
    clearPublicSession();
    S.auth = null;
    newSession();
    if (S.session) S.session.grader = keepGrader;
    go('weight');
  },
  histScope(sc) { S.ui.histScope = sc; S.ui.histPage = 0; render(); },
  histPrev() { if (S.ui.histPage > 0) { S.ui.histPage--; render(); } },
  histNext() { S.ui.histPage++; render(); },

  /* ----- manual override ----- */
  override() {
    const s = S.session; S.ui.ovGrade = null; S.ui.ovReason = ''; S.ui.ovAck = false; S.ui.ovPin = ''; S.ui.ovPinError = '';
    // With two samples the grader picks which one to override (pre-select a sample that is not accepted).
    const bad = s.captures.find((c) => c.outcome !== 'accepted');
    S.ui.ovTarget = s.captures.length > 1 ? (bad ? bad.type : null) : 'all';
    s.ovFrom = S.screen; go('override');
  },
  ovGrade(g) { S.ui.ovGrade = g; render(); },
  ovTarget(t) { S.ui.ovTarget = t; render(); },
  ovReasonPick(t) { S.ui.ovReason = t; render(); },
  ovAck() { S.ui.ovAck = !S.ui.ovAck; render(); },
  cancelOverride() { go(S.session.ovFrom || 'result'); },
  applyOverride() {
    applyOverride(S.ui.ovPin, S.ui.ovGrade, S.ui.ovReason);
  },
  clearOverride() {
    const s = S.session; s.decisions = s.decisions.filter((d) => !d.manual); persist(s);
    const last = s.captures[s.captures.length - 1];
    go(s.captures.length > 1 ? 'paired' : last.outcome === 'accepted' ? 'result' : 'invalid');
    toast('Override removed. The model result is back.');
  },

  expert() { S.login = { intent: 'expert', pin: '', error: '', ret: S.screen }; render(); },
  pinKey(k) { const L = S.login; if (!L) return; if (k === 'del') L.pin = L.pin.slice(0, -1); else if (L.pin.length < 4) L.pin += k; L.error = ''; render(); },
  loginCancel() { S.login = null; render(); },
  loginGo() {
    const L = S.login; if (!L || L.pin.length !== 4) return;
    const role = L.pin === '1234' ? 'admin' : L.pin === '2468' ? 'expert' : null;
    if (!role) { L.pin = ''; L.error = "That PIN isn't recognized. Try again."; render(); return; }
    if (L.intent === 'expert' && role !== 'expert') { L.pin = ''; L.error = "This PIN can't decide grades. Use an expert PIN."; render(); return; }
    S.auth = { role, name: role === 'admin' ? 'Administrator (Demo)' : 'Expert grader (Demo)' };
    const intent = L.intent; S.login = null;
    if (intent === 'expert') { S.ui.expertCtx = { kind: 'session' }; S.ui.reviewGrade = null; S.ui.reviewReason = ''; go('expert'); } else go('console');
  },
  logout() { S.auth = null; S.ui.recSel = null; S.login = null; go(S.session ? (S.screen === 'console' ? 'welcome' : S.screen) : 'welcome'); },
  recFilter(f) { S.ui.recFilter = f; render(); },
  openRec(id) { S.ui.recSel = id; render(); },
  closeRec() { S.ui.recSel = null; render(); },
  async reprintRec(id) { const r = S.records.find((x) => x.id === id); if (!r || !r.quote) { toast('No receipt to print for this record.', 'err'); return; } const res = await printReceipt(r); if (res.cancelled) return; if (res.error) { toast(res.error, 'err'); return; } r.prints.push({ ts: Date.now(), kind: 'Copy', result: 'Receipt sent' }); toast('Copy receipt sent to the print dialog. Marked as a copy on the record.'); },
  reviewRecord(id) { S.ui.expertCtx = { kind: 'record', id }; S.ui.reviewGrade = null; S.ui.reviewReason = ''; go('expert'); },
  revGrade(g) { S.ui.reviewGrade = g; render(); },
  cancelReview() {
    const ctx = S.ui.expertCtx; S.auth = null; S.ui.reviewGrade = null; S.ui.reviewReason = ''; S.ui.expertCtx = null;
    if (ctx && ctx.kind === 'record') go('welcome');
    else go(S.session ? screenAfterGrade(S.session) : 'welcome');
  },
  applyReview() { ask('Add this decision?', 'Your decision and reason are added to the record. The original model output stays unchanged. You will be signed out.', [{ label: 'Go back', act: 'closeDialog' }, { label: 'Apply decision', act: 'doApply', kind: 'primary' }]); },
  doApply() {
    const ctx = S.ui.expertCtx, g = S.ui.reviewGrade === 'U' ? null : S.ui.reviewGrade, reason = S.ui.reviewReason.trim();
    const dec = { id: uid(), grade: g, reason, actor: S.auth.name, ts: Date.now(), expectedRevision: 1 };
    S.dialog = null;
    if (ctx.kind === 'record') {
      const r = S.records.find((x) => x.id === ctx.id); r.decisions.push(dec); r.final = resolve(r);
      if (r.final.status === 'final' && S.schedule.expired === false) { const rate = S.schedule.rates[r.final.grade]; r.quote = { grade: r.final.grade, rateC: rate, weightTenths: r.weightTenths, totalC: calcTotalCentavos(r.weightTenths, rate), scheduleVersion: S.schedule.version, scheduleId: S.schedule.id, revision: 1, confirmedAt: Date.now(), rounding: 'half-up to centavo' }; }
      r.revision++; enqueue(r); S.auth = null; S.ui.expertCtx = null; go('welcome'); toast(r.final.status === 'final' ? 'Decision added. Record updated.' : 'Decision added. Record stays unresolved.'); return;
    }
    const s = S.session; s.decisions.push(dec); persist(s); S.auth = null; S.ui.expertCtx = null; S.ui.reviewGrade = null; S.ui.reviewReason = '';
    const r = resolve(s);
    go(s.captures.length >= 2 ? 'paired' : r.status === 'final' ? 'price' : 'invalid');
  },
  syncNow() { syncNow(); },
  retryFailed() { retryFailed(); },
  textsize(v) { S.ui.large = v === 'l'; render(); },
  test(n) { toast(n + ' test passed (demo only, no hardware attached).'); },
};
function act(a, arg) {
  const t = Date.now(); if (t < S.lock) return; S.lock = t + 140;
  const f = A[a]; if (f) f(arg === '' ? undefined : arg);
}

/* ====================================================================== */
/* icons & illustrations                                                   */
/* ====================================================================== */
const IC = {
  check: [['p', 'M5 12.5l4.5 4.5L19 7.5']],
  warn: [['p', 'M12 4l9 16H3L12 4z'], ['p', 'M12 10v4M12 17v.5']],
  x: [['p', 'M6 6l12 12M18 6L6 18']],
  info: [['c', 12, 12, 9], ['p', 'M12 11v5M12 8v.5']],
  cloud: [['p', 'M7 18a4 4 0 010-8 5.5 5.5 0 0110.6 1.2A3.6 3.6 0 0117 18H7z']],
  cloudoff: [['p', 'M7 18a4 4 0 010-8 5.5 5.5 0 0110.6 1.2A3.6 3.6 0 0117 18H7z'], ['p', 'M4 4l16 16']],
  print: [['p', 'M7 9V4h10v5M7 17H5a2 2 0 01-2-2v-4a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2h-2M7 14h10v6H7z']],
  back: [['p', 'M15 5l-7 7 7 7']],
  help: [['c', 12, 12, 9], ['p', 'M9.5 9.5a2.5 2.5 0 015 .5c0 1.5-2.5 2-2.5 3.5M12 17v.5']],
  backspace: [['p', 'M9 5h11v14H9l-6-7z'], ['p', 'M12.5 9.5l5 5M17.5 9.5l-5 5']],
  refresh: [['p', 'M20 11a8 8 0 10-2.3 5.7M20 4v7h-7']],
  lock: [['r', 5, 11, 14, 9, 2], ['p', 'M8 11V8a4 4 0 018 0v3']],
  list: [['p', 'M8 7h12M8 12h12M8 17h12M4 7h.5M4 12h.5M4 17h.5']],
  gear: [['c', 12, 12, 3], ['p', 'M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1']],
  pulse: [['p', 'M3 12h4l2-6 4 12 2-6h6']],
  tag: [['p', 'M3 12V4h8l10 10-8 8L3 12z'], ['c', 8, 8, 1]],
  out: [['p', 'M10 5H5v14h5M15 8l4 4-4 4M19 12H9']],
  arrow: [['p', 'M5 12h13M13 6l6 6-6 6']],
  camera: [['p', 'M4 8h4l2-2h4l2 2h4v10H4z'], ['c', 12, 13, 3]],
  edit: [['p', 'M5 19h4L19 9l-4-4L5 15z'], ['p', 'M13 6l4 4']],
  home: [['p', 'M4 11l8-7 8 7v9H4z'], ['p', 'M10 20v-6h4v6']],
  gallery: [['p', 'M4 5h16v14H4z'], ['c', 9, 10, 2, 2], ['p', 'M5 17l4-4 3 3 2-2 5 5']],
};
function Icon({ n, s = 28, c = C.navy, w = 2.2 }) {
  return (
    <Svg width={s} height={s} viewBox="0 0 24 24">
      <G fill="none" stroke={c} strokeWidth={w} strokeLinecap="round" strokeLinejoin="round">
        {(IC[n] || []).map((e, i) => e[0] === 'p' ? <Path key={i} d={e[1]} />
          : e[0] === 'c' ? <Circle key={i} cx={e[1]} cy={e[2]} r={e[3]} />
            : <Rect key={i} x={e[1]} y={e[2]} width={e[3]} height={e[4]} rx={e[5]} />)}
      </G>
    </Svg>
  );
}

/* ---------- picture components: every image gets an explicit width AND height ---------- */
function Mark({ s = 44 }) {
  return <Image source={IMG.logo} style={{ width: s, height: s }} resizeMode="contain" />;
}
function SampleIcon({ type, size = 150 }) {
  return <Image source={IMG[type]} style={{ width: size, height: size / SAMPLE_AR[type] }} resizeMode="contain" />;
}
// Cropped, rounded view of the top-down tray picture (the PNG has a lot of white around the tray).
function ChamberLine({ w = 240 }) {
  const sc = w / 1130, h = 730 * sc;
  return (
    <View style={{ width: w, height: h, borderRadius: 22, backgroundColor: '#fff', shadowColor: C.navy, shadowOpacity: 0.16, shadowRadius: 14, shadowOffset: { width: 0, height: 8 }, elevation: 5 }}>
      <View style={{ width: w, height: h, borderRadius: 22, overflow: 'hidden' }}>
        <Image source={IMG.topdown} resizeMode="contain" style={{ position: 'absolute', width: 1360 * sc, height: 1300 * sc, left: -140 * sc, top: -200 * sc }} />
      </View>
    </View>
  );
}
const TONES = { A: ['#D1303F', '#A31B2D', '#E9707C'], B: ['#B35654', '#8F3D3A', '#D08E8A'], C: ['#97685E', '#6F4A44', '#B9A39D'] };
let IDC = 0;
function TunaImg({ tone, type, blur }) {
  const id = useRef(++IDC).current; const t = TONES[tone] || null;
  const body = type === 'core'
    ? 'M120 240C120 120 250 70 340 90C470 110 540 190 500 300C460 400 300 420 200 380C140 350 120 300 120 240Z'
    : 'M80 230C150 150 300 130 420 165L565 120L545 240L575 345L420 320C300 355 150 330 80 265Z';
  return (
    <Svg viewBox="0 0 640 480" width="100%" height="100%" preserveAspectRatio="xMidYMid meet">
      <Defs>
        <RadialGradient id={`f${id}`} cx="0.45" cy="0.4" r="0.7"><Stop offset="0" stopColor={t ? t[2] : '#aaa'} /><Stop offset="0.45" stopColor={t ? t[0] : '#aaa'} /><Stop offset="1" stopColor={t ? t[1] : '#888'} /></RadialGradient>
        <RadialGradient id={`bg${id}`} cx="0.5" cy="0.4" r="0.8"><Stop offset="0" stopColor="#EEF1F5" /><Stop offset="1" stopColor="#B9C2CD" /></RadialGradient>
        <ClipPath id={`c${id}`}><Path d={body} /></ClipPath>
      </Defs>
      <Rect width={640} height={480} fill={`url(#bg${id})`} />
      <Rect x={40} y={40} width={560} height={400} rx={26} fill="#DDE3EA" stroke="#9FAAB8" strokeWidth={3} />
      <G opacity={blur ? 0.5 : 1}>
        {blur && <><G x={-8}><Path d={body} fill={t ? `url(#f${id})` : '#C4CBD4'} opacity={0.6} /></G><G x={8} y={6}><Path d={body} fill={t ? `url(#f${id})` : '#C4CBD4'} opacity={0.6} /></G></>}
        {t ? (
          <>
            <Path d={body} fill={`url(#f${id})`} />
            <G clipPath={`url(#c${id})`} stroke={t[2]} strokeWidth={2.5} fill="none" opacity={0.55}>
              <Path d="M80 200C200 170 340 190 600 160M80 250C220 220 360 245 600 215M80 300C220 270 380 300 600 270M80 350C220 330 380 350 600 330" />
            </G>
            <Path d={body} fill="none" stroke={t[1]} strokeWidth={4} />
            {tone === 'C' && <G clipPath={`url(#c${id})`}><Ellipse cx={300} cy={260} rx={120} ry={70} fill="#d7d2d0" opacity={0.28} /></G>}
          </>
        ) : (
          <>
            <Rect x={140} y={130} width={360} height={220} rx={40} fill="#C4CBD4" opacity={0.7} />
            <Path d="M180 300C260 240 380 250 460 190" stroke="#A8B1BD" strokeWidth={12} fill="none" />
          </>
        )}
      </G>
      {blur && <Rect width={640} height={480} fill="#fff" opacity={0.1} />}
      <SvgText x={610} y={468} textAnchor="end" fontSize={14} fill="#173B6C" opacity={0.7}>DEMO IMAGE</SvgText>
    </Svg>
  );
}
const toneOf = (c) => (c.code === 'INV' ? 'INV' : c.code === 'UNC' ? 'UNC' : c.label);
const photo = (uri, tone, type, blur, demoAsset) => uri
  ? <Image source={{ uri }} style={{ width: '100%', height: '100%' }} resizeMode="cover" />
  : (demoAsset || DEMO_IMG[type]?.[tone])
    ? <Image source={demoAsset || DEMO_IMG[type][tone]} style={{ width: '100%', height: '100%', backgroundColor: '#FFFFFF' }} resizeMode="contain" />
    : <TunaImg tone={tone} type={type} blur={blur} />;
const imgFor = (c, blur) => photo(c.uri, toneOf(c), c.type, blur, c.demoAsset);
function ImgFrame({ style, children }) {
  return <View style={[{ backgroundColor: '#0F1B2B', borderRadius: 22, borderWidth: 1, borderColor: C.border, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }, style]}>{children}</View>;
}
function Glow() { return null; }
/* clean ocean-blue surface (welcome, startup, onboarding) */
function Hero({ children }) {
  return (
    <View style={{ flex: 1, backgroundColor: C.hero, overflow: 'hidden' }}>
      {children}
    </View>
  );
}
const sheetStyle = { backgroundColor: '#fff', borderTopLeftRadius: 32, borderTopRightRadius: 32, paddingHorizontal: 20, paddingTop: 22, paddingBottom: 22, gap: 14, shadowColor: '#0B2A7A', shadowOpacity: 0.2, shadowRadius: 20, shadowOffset: { width: 0, height: -6 }, elevation: 14 };

/* ====================================================================== */
/* primitives                                                              */
/* ====================================================================== */
function Txt({ k = 'body', style, children, ...rest }) {
  const ts = TS();
  const base = {
    title: { fontSize: 28 * ts, fontWeight: '800', lineHeight: 28 * ts * 1.12, letterSpacing: -0.4, color: C.navy },
    h2: { fontSize: 21 * ts, fontWeight: '700', lineHeight: 21 * ts * 1.15, color: C.navy },
    body: { fontSize: 16 * ts, lineHeight: 16 * ts * 1.4, color: C.navy },
    sub: { fontSize: 14.5 * ts, lineHeight: 14.5 * ts * 1.4, color: C.text2 },
    label: { fontSize: 14 * ts, fontWeight: '600', color: C.text2 },
    det: { fontSize: 14 * ts, color: C.text2 },
  }[k];
  return <Text {...rest} style={[base, style]}>{children}</Text>;
}
// one-line helper text under a screen title
const Sub = ({ children }) => <Txt k="sub" style={{ textAlign: 'center', maxWidth: 320 }}>{children}</Txt>;
const CHIP = {
  '': [C.warnbg, C.warn], ok: [C.gAbg, C.gA], amber: [C.amberbg, C.amber], info: ['#E4ECFC', '#1D4FD8'], err: [C.errbg, C.err],
  gA: [C.gAbg, C.gA], gB: [C.gBbg, C.gB], gC: [C.gCbg, C.gC],
};
function Chip({ k = '', icon, style, children }) {
  const [bg, fg] = CHIP[k] || CHIP[''];
  return (
    <View style={[{ flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', gap: 8, minHeight: 34, paddingHorizontal: 12, borderRadius: 17, backgroundColor: bg, borderWidth: 1, borderColor: 'transparent' }, style]}>
      {icon ? <Icon n={icon} s={22} c={fg} /> : null}
      <Text style={{ fontSize: 14 * TS(), fontWeight: '600', color: fg, flexShrink: 1 }}>{children}</Text>
    </View>
  );
}
const chip = (txt, k = '', icon, style) => <Chip k={k} icon={icon} style={style}>{txt}</Chip>;
const gcls = (l) => (l === 'A' ? 'gA' : l === 'B' ? 'gB' : l === 'C' ? 'gC' : '');
const gradeChip = (l) => <Chip k={gcls(l)}>{`Grade ${l}`}</Chip>;
const cloudChip = () => S.net === 'online' ? chip('Cloud online', 'ok', 'cloud') : S.net === 'wifi' ? chip('Wi-Fi, no cloud access', 'amber', 'cloudoff') : chip('Offline · saving on device', 'amber', 'cloudoff');

function Stat({ v, l, k }) {
  return (
    <View style={{ flex: 1, backgroundColor: C.canvas, borderRadius: 20, borderWidth: 1, borderColor: C.border, paddingVertical: 12, paddingHorizontal: 8, alignItems: 'center', gap: 2 }}>
      <Text style={{ fontSize: 20 * TS(), fontWeight: '800', color: k || C.navy }}>{v}</Text>
      <Text style={{ fontSize: 12.5 * TS(), color: C.text2, textAlign: 'center' }}>{l}</Text>
    </View>
  );
}

function Card({ lift, style, children }) {
  return (
    <View style={[{ backgroundColor: C.surface, borderWidth: 1, borderColor: '#DCE5F2', borderRadius: 24, padding: 18 },
    lift && { shadowColor: C.navy, shadowOpacity: 0.08, shadowRadius: 18, shadowOffset: { width: 0, height: 8 }, elevation: 4 }, style]}>{children}</View>
  );
}
function KV({ l, r, last, center }) {
  const ts = TS();
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: center ? 'center' : 'baseline', flexWrap: 'wrap', gap: 16, paddingVertical: 12, borderBottomWidth: last ? 0 : 1, borderBottomColor: C.border }}>
      <Text style={{ fontSize: 16 * ts, color: C.text2 }}>{l}</Text>
      {typeof r === 'string' || typeof r === 'number'
        ? <Text style={{ fontSize: 16 * ts, fontWeight: '600', color: C.navy, textAlign: 'right', flexShrink: 1 }}>{r}</Text>
        : <View style={{ flexShrink: 1, alignItems: 'flex-end' }}>{r}</View>}
    </View>
  );
}
const infoRows = (rows) => rows.map((x, i) => <KV key={i} l={x[0]} r={x[1]} last={i === rows.length - 1} />);

function Spin({ size = 48, bw = 5, light }) {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => { const a = Animated.loop(Animated.timing(v, { toValue: 1, duration: 1000, easing: Easing.linear, useNativeDriver: true })); a.start(); return () => a.stop(); }, [v]);
  const rot = v.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });
  return <Animated.View style={{ width: size, height: size, borderRadius: size / 2, borderWidth: bw, borderColor: light ? 'rgba(255,255,255,0.3)' : '#D5E1F8', borderTopColor: light ? '#fff' : C.primary, transform: [{ rotate: rot }] }} />;
}
function Enter({ children }) {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => { Animated.timing(v, { toValue: 1, duration: 200, easing: Easing.out(Easing.quad), useNativeDriver: true }).start(); }, [v]);
  return <Animated.View style={{ flex: 1, opacity: v, transform: [{ translateY: v.interpolate({ inputRange: [0, 1], outputRange: [8, 0] }) }] }}>{children}</Animated.View>;
}

/* ---------- buttons ---------- */
function Btn({ label, act: a, arg, kind = '', dis = false, icon, style, bar }) {
  const primary = kind.includes('primary'), danger = kind.includes('danger'), small = kind.includes('small'), ghost = kind.includes('ghost');
  const fg = primary ? '#fff' : danger ? C.err : ghost ? C.text2 : C.primary;
  const fs = (primary ? 17 : small ? 14 : 16) * TS();
  return (
    <Pressable
      disabled={dis} onPress={() => act(a, arg)}
      accessibilityRole="button" accessibilityLabel={label || icon} accessibilityState={{ disabled: dis }}
      style={({ pressed }) => [
        {
          minHeight: primary ? 54 : small ? 42 : 48, paddingHorizontal: small ? 14 : 20, borderRadius: 999, borderWidth: ghost ? 0 : 1.5,
          borderColor: primary ? C.primary : danger ? '#E9BDBD' : '#D5E0EE',
          backgroundColor: primary ? C.primary : ghost ? 'transparent' : C.surface,
          flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8
        },
        primary && !dis && { shadowColor: C.primary, shadowOpacity: 0.25, shadowRadius: 12, shadowOffset: { width: 0, height: 5 }, elevation: 4 },
        bar && (primary ? { flexBasis: '100%' } : ghost ? { paddingHorizontal: 12 } : { flexGrow: 1, flexBasis: '40%' }),
        dis && (primary ? { backgroundColor: '#9DB9F5', borderColor: '#9DB9F5', shadowOpacity: 0 } : { opacity: 0.45 }),
        pressed && !dis && { transform: [{ scale: 0.985 }], backgroundColor: primary ? C.primaryPress : '#EEF3FB' },
        style,
      ]}
    >
      {label ? <Text style={{ fontSize: fs, fontWeight: '700', color: fg, textAlign: 'center', flexShrink: 1 }}>{label}</Text> : null}
      {icon ? <Icon n={icon} s={primary ? 20 : 18} c={fg} /> : null}
    </Pressable>
  );
}
const B = (label, a, arg, kind = '', dis = false, icon = '', style) => <Btn label={label} act={a} arg={arg} kind={kind} dis={!!dis} icon={icon} style={style} />;
const backBtn = (a, arg) => B('Back', a, arg, 'ghost', false, 'back');
const helpBtn = () => B('', 'help', '', 'ghost', false, 'help');
function Note({ text }) { return <Txt k="det" style={{ flexBasis: '100%', textAlign: 'center' }}>{text}</Txt>; }

/* ---------- screen shell ---------- */
function Logo({ s = 28, light }) {
  return (
    <Pressable
      onLongPress={() => { if (S.screen === 'welcome' && !S.login) { S.login = { intent: 'admin', pin: '', error: '' }; render(); } }}
      delayLongPress={1200}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}
    >
      {light ? <View style={{ backgroundColor: '#fff', borderRadius: s * 0.34, padding: s * 0.1 }}><Mark s={s} /></View> : <Mark s={s} />}
      <Text style={{ fontSize: 19, fontWeight: '800', color: light ? '#fff' : C.navy, letterSpacing: -0.3 }}>Tuna<Text style={{ color: light ? C.cyan : C.primary }}>Eye</Text></Text>
    </Pressable>
  );
}
function Header({ idx }) {
  const { width } = useWindowDimensions();
  const compact = width < 430;
  const dot = S.net === 'online' ? C.online : '#E0A100';
  const home = () => { if (S.session) act('cancelSession'); else if (S.screen !== 'welcome') act('go', 'welcome'); };
  const shortLabels = ['Info', 'Pi', 'Core', 'Tail', 'Grade', 'Print'];
  return (
    <View style={{ paddingHorizontal: 12, paddingTop: 8, paddingBottom: 4, gap: 8, width: '100%', maxWidth: 560, alignSelf: 'center' }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#fff', borderRadius: 999, paddingVertical: 8, paddingLeft: 14, paddingRight: 8, borderWidth: 1, borderColor: '#DCE5F2', shadowColor: C.navy, shadowOpacity: 0.06, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 2 }}>
        <Logo s={26} />
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          {S.demo.enabled ? (
            <Pressable onPress={() => { S.drawer = !S.drawer; render(); }} style={{ paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999, backgroundColor: '#FFF4D6', borderWidth: 1, borderColor: '#EBD59C' }}>
              <Text style={{ fontSize: 11.5, fontWeight: '800', color: C.amber }}>DEMO</Text>
            </Pressable>
          ) : null}
          <Pressable hitSlop={12} onPress={() => { S.drawer = !S.drawer; render(); }}><View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: dot }} /></Pressable>
          <Pressable onPress={home} accessibilityRole="button" accessibilityLabel="Home" style={{ width: 34, height: 34, borderRadius: 17, borderWidth: 1, borderColor: C.border, alignItems: 'center', justifyContent: 'center', backgroundColor: C.canvas }}>
            <Icon n="home" s={17} />
          </Pressable>
        </View>
      </View>
      {idx ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#fff', borderRadius: 999, paddingVertical: 6, paddingHorizontal: compact ? 8 : 14, borderWidth: 1, borderColor: '#DCE5F2', width: '100%', shadowColor: C.navy, shadowOpacity: 0.04, shadowRadius: 8, shadowOffset: { width: 0, height: 2 }, elevation: 1 }}>
          {STEPS.map((label, i) => {
            const n = i + 1;
            const done = n < idx;
            const active = n === idx;
            const txt = compact ? shortLabels[i] : label;
            return (
              <React.Fragment key={label}>
                {i > 0 && !compact ? <View style={{ flex: 1, maxWidth: 14, height: 2, borderRadius: 1, backgroundColor: done ? C.primary : '#DCE5F2' }} /> : null}
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: compact ? 2 : 4, flexShrink: 1 }}>
                  <View style={{ width: compact ? 12 : 16, height: compact ? 12 : 16, borderRadius: 8, backgroundColor: done ? C.primary : active ? '#EEF4FF' : '#F1F5F9', borderWidth: active ? 2 : 0, borderColor: C.primary, alignItems: 'center', justifyContent: 'center' }}>
                    {done ? <Icon n="check" s={compact ? 8 : 9} c="#fff" w={3} /> : active ? <View style={{ width: 4, height: 4, borderRadius: 2, backgroundColor: C.primary }} /> : null}
                  </View>
                  <Text numberOfLines={1} style={{ fontSize: compact ? 9.5 : 11.5, fontWeight: active ? '800' : '600', color: active ? C.navy : done ? C.primary : C.text2 }}>{txt}</Text>
                </View>
              </React.Fragment>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}

/**
 * Screen shell. The bottom action bar always shows: [extra actions row] + [Back] [Continue].
 * Back is the first element in `left` whose icon is 'back'. Everything in `right` is shown in the bar
 * (primary buttons beside Back, other buttons in a row above). Swipe the handle up to see the full dock.
 */
function Shell({ idx = 0, left = [], right = [], children }) {
  const items = [...left, ...right].filter(Boolean);
  const isP = (e) => (e.props.kind || '').includes('primary');
  const ordered = [...items.filter((e) => e.props.text), ...items.filter((e) => !e.props.text && isP(e)), ...items.filter((e) => !e.props.text && !isP(e))];
  const backEl = left.find((e) => e && e.props && e.props.icon === 'back');
  const rightItems = right.filter(Boolean);
  const prim = rightItems.filter(isP), sec = rightItems.filter((e) => !isP(e));
  const hasBar = !!(backEl || rightItems.length);
  const navGesture = useRef(null);
  const [barH, setBarH] = useState(0);

  if (!navGesture.current) {
    navGesture.current = PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dy) > 10 && Math.abs(g.dy) > Math.abs(g.dx),
      onPanResponderRelease: (_, g) => {
        if (g.dy < -35) act('toggleNavDock', true);
        if (g.dy > 35) act('toggleNavDock', false);
      },
    });
  }

  return (
    <View style={{ flex: 1 }}>
      <Glow />
      <Header idx={idx} />

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{
          flexGrow: 1,
          paddingHorizontal: 16,
          // Leave room for the always-visible action bar.
          paddingBottom: hasBar && !S.navDock ? (barH || 92) + 28 : 24,
        }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {children}
      </ScrollView>

      {/* Back + Continue stay visible. The swipe-up dock is still separate. */}
      {!S.navDock && hasBar ? (
        <View
          onLayout={(e) => { const h = Math.ceil(e.nativeEvent.layout.height); if (h !== barH) setBarH(h); }}
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 0,
            paddingHorizontal: 16,
            paddingTop: 10,
            paddingBottom: 14,
            backgroundColor: 'rgba(255,255,255,0.97)',
            borderTopWidth: 1,
            borderTopColor: '#DCE5F2',
            shadowColor: C.navy,
            shadowOpacity: 0.08,
            shadowRadius: 16,
            shadowOffset: { width: 0, height: -4 },
            elevation: 8,
          }}
        >
          <View style={{ gap: 10 }}>
            {sec.length ? (
              <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
                {sec.map((e, i) => React.cloneElement(e, { key: 's' + i, bar: true, style: [{ minHeight: 46, flex: 1 }, e.props.style] }))}
              </View>
            ) : null}
            <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
              {backEl ? React.cloneElement(backEl, { key: 'back', kind: '', style: [{ minHeight: 52, minWidth: 104, flex: prim.length ? 0 : 1 }] }) : null}
              {prim.map((e, i) => React.cloneElement(e, { key: 'p' + i, style: [{ minHeight: 52, flex: 1 }, e.props.style] }))}
            </View>
          </View>
        </View>
      ) : null}

      {S.navDock ? (
        <View
          style={{
            flexDirection: 'row',
            flexWrap: 'wrap',
            gap: 8,
            justifyContent: 'space-between',
            paddingHorizontal: 14,
            paddingTop: 8,
            paddingBottom: 12,
            alignItems: 'center',
            borderTopWidth: 1,
            borderTopColor: C.border,
            backgroundColor: '#fff',
          }}
        >
          {ordered.map((e, i) => React.cloneElement(e, { key: i, bar: true }))}
        </View>
      ) : null}

      <View
        {...navGesture.current.panHandlers}
        style={{
          height: 22,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: C.canvas,
          zIndex: 10,
        }}
      >
        <View style={{ width: 52, height: 5, borderRadius: 3, backgroundColor: C.chromeBorder }} />
      </View>
    </View>
  );
}

function Bare({ children }) { return <View style={{ flex: 1 }}><Glow />{children}</View>; }
const BODY = { flexGrow: 1, width: '100%', maxWidth: 540, alignSelf: 'center', paddingTop: 4, paddingBottom: 10, gap: 10, justifyContent: 'center' };

/* ---------- first-use coach tips (shown once per step, above the buttons) ---------- */
const COACH = {
  weight: 'Type the fish weight from your scale. Use kilograms with one decimal.',
  grader: "Type the grader's name. It goes on the saved record and receipt.",
  sample: 'Tap the cut you placed in the chamber. You can add the other cut afterward.',
  pair: 'Point your phone at the QR code on the kiosk. It connects by itself.',
  align: 'Place the sample in the tray like the picture shows, then tap Looks good.',
  camera: 'Hold still, then tap Take photo. No camera? Tap Upload image to pick one from your gallery.',
  result: 'This is the suggested grade and price. If it looks wrong, tap Override grade.',
};
const COACH_KEYS = Object.keys(COACH);
function CoachMark() {
  const k = S.screen;
  if (!S.tips || !S.session || !COACH[k] || S.coached[k] || S.login || S.dialog || S.help || S.drawer) return null;
  const n = COACH_KEYS.indexOf(k) + 1, ts = TS();
  return (
    <View pointerEvents="box-none" style={{ position: 'absolute', left: 14, right: 14, top: 74, zIndex: 15 }}>
      <View style={{ backgroundColor: '#fff', borderRadius: 24, padding: 16, gap: 10, borderWidth: 1, borderColor: C.border, shadowColor: C.navy, shadowOpacity: 0.22, shadowRadius: 20, shadowOffset: { width: 0, height: 10 }, elevation: 12 }}>
        <Text style={{ fontSize: 13, fontWeight: '600', color: C.text2 }}>{`Tip ${n}/${COACH_KEYS.length}`}</Text>
        <Text style={{ fontSize: 17 * ts, fontWeight: '700', lineHeight: 24 * ts, color: C.navy }}>{COACH[k]}</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 2 }}>
          <Pressable onPress={() => act('hideTips')} hitSlop={8} style={{ paddingVertical: 8, paddingRight: 12 }}>
            <Text style={{ fontSize: 14 * ts, fontWeight: '600', color: C.text2 }}>Hide tips</Text>
          </Pressable>
          <Pressable onPress={() => act('gotIt')} accessibilityRole="button" style={({ pressed }) => [{ minHeight: 46, paddingHorizontal: 26, borderRadius: 999, backgroundColor: C.primary, alignItems: 'center', justifyContent: 'center' }, pressed && { backgroundColor: C.primaryPress }]}>
            <Text style={{ fontSize: 16 * ts, fontWeight: '700', color: '#fff' }}>Got it!</Text>
          </Pressable>
        </View>
      </View>
      <View style={{ alignSelf: 'center', width: 18, height: 18, marginTop: -9, backgroundColor: '#fff', transform: [{ rotate: '45deg' }], borderRightWidth: 1, borderBottomWidth: 1, borderColor: C.border }} />
    </View>
  );
}

/* ---------- history ---------- */
const histOk = (r) => r.closed && r.captures.length > 0;
const histList = () => S.records.filter(histOk).sort((a, b) => b.createdAt - a.createdAt);

function HistRow({ r }) {
  const f = r.final, c = r.captures[0], ts = TS();
  return (
    <Pressable
      onPress={() => act('openHist', r.id)}
      accessibilityRole="button" accessibilityLabel={`Open ${r.id}`}
      style={({ pressed }) => [{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderRadius: 22, backgroundColor: C.surface, borderWidth: 1, borderColor: C.border, width: '100%' }, pressed && { backgroundColor: '#F3F7FE' }]}
    >
      <ImgFrame style={{ width: 64, height: 64, borderRadius: 16 }}>{imgFor(c)}</ImgFrame>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ fontSize: 16 * ts, fontWeight: '700', color: C.navy }}>{r.id}</Text>
        <Txt k="det">{`${r.captures.map((x) => TYPES[x.type].short).join(' + ')} · ${fmtKg(r.weightTenths)}`}</Txt>
        <Txt k="det">{fmtTime(r.createdAt)}</Txt>
      </View>
      <View style={{ alignItems: 'flex-end', gap: 6 }}>
        {f.status === 'final' ? gradeChip(f.grade) : chip('Review pending', 'amber')}
        <Text style={{ fontSize: 14 * ts, fontWeight: '700', color: C.navy }}>{r.quote ? fmtMoney(r.quote.totalC) : '—'}</Text>
      </View>
    </Pressable>
  );
}

/* ====================================================================== */
/* screens                                                                 */
/* ====================================================================== */
const screens = {};

screens.startup = () => {
  const st = S.startup, failed = st.state === 'fail';
  return (
    <Hero>
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16, paddingHorizontal: 20 }}>
        <View style={{ backgroundColor: '#fff', borderRadius: 24, padding: 10 }}><Mark s={60} /></View>
        <Txt k="title" style={{ fontSize: 34, lineHeight: 38, color: '#fff' }}>TunaEye</Txt>
        <ChamberLine w={200} />
        {failed ? (
          <View style={{ gap: 12, alignItems: 'center' }}>
            {chip('Not ready', 'err', 'x')}
            <Txt style={{ color: '#fff' }}>{st.fail}</Txt>
            <Txt k="sub" style={{ textAlign: 'center', color: 'rgba(255,255,255,0.85)' }}>Check the connection or restart the chamber, then try again.</Txt>
            {B('Check again', 'retryStartup', '', 'small')}
          </View>
        ) : (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}><Spin size={36} bw={4} light /><Txt style={{ color: '#fff' }}>Getting things ready…</Txt></View>
        )}
        <View style={{ minHeight: 150, gap: 8, alignItems: 'flex-start', backgroundColor: 'rgba(255,255,255,0.14)', borderRadius: 20, paddingVertical: 12, paddingHorizontal: 16, alignSelf: 'stretch', maxWidth: 360 }}>
          {st.checks.map((c) => {
            const soft = c.warn || c.soft;
            return (
              <View key={c.name} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Icon n={c.ok ? 'check' : soft ? 'warn' : 'x'} s={20} c={c.ok ? '#9CF2C8' : soft ? '#FFD98A' : '#FFB4B4'} />
                <Text style={{ fontSize: 14.5, color: 'rgba(255,255,255,0.85)', flexShrink: 1 }}><Text style={{ fontWeight: '700', color: '#fff' }}>{c.name}</Text>{` · ${c.msg}`}</Text>
              </View>
            );
          })}
        </View>
      </View>
    </Hero>
  );
};

function renderWelcome() {
  const c = counts();
  const pend = c.pending + c.failed + c.syncing;
  const open = S.shift.open;
  const dayKey = (t) => manila(t).toISOString().slice(0, 10);
  const todayN = S.records.filter((r) => dayKey(r.createdAt) === dayKey(Date.now())).length;
  const hr = manila(Date.now()).getUTCHours();
  const greet = hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening';
  const name = (S.lastGrader || '').trim().split(' ')[0];
  const dot = S.net === 'online' ? '#5BE3A3' : '#FFC94D';
  const sm = S.syncModal;
  const sw = S.slowWifiModal;

  return (
    <Hero>
      <View style={{ flex: 1, paddingHorizontal: 22, paddingTop: 18 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
          <Logo s={28} light />
          <Pressable onPress={() => { S.drawer = !S.drawer; render(); }} hitSlop={8} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 32, paddingHorizontal: 12, borderRadius: 16, backgroundColor: C.heroSoft, flexShrink: 1 }}>
            <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: dot }} />
            <Text numberOfLines={1} style={{ fontSize: 12.5, fontWeight: '700', color: '#fff' }}>{open ? 'Ready' : 'Closed'}</Text>
          </Pressable>
        </View>
        <Text style={{ marginTop: 18, fontSize: 34 * TS(), lineHeight: 38 * TS(), fontWeight: '800', color: '#fff', letterSpacing: -0.9 }}>{'TunaEye\nStation 01'}</Text>
        <Text style={{ marginTop: 6, fontSize: 15 * TS(), lineHeight: 20 * TS(), color: 'rgba(255,255,255,0.88)' }}>{name ? `Operator: ${name} · Sashibo core first` : 'Sashibo core first, Tail-Cut if needed.'}</Text>
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', minHeight: 130 }}>
          <View style={{ transform: [{ rotate: '-4deg' }] }}><ChamberLine w={220} /></View>
        </View>
      </View>
      <View style={sheetStyle}>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Stat v={todayN} l="Graded today" />
          <Stat v={pend} l="To upload" k={pend ? C.amber : C.gA} />
          <Stat v={S.lastAck ? fmtClock(S.lastAck) : 'None'} l="Last upload" />
        </View>
        {open ? B('Start grading', 'start', '', 'primary', false, 'arrow', { width: '100%' }) : (
          <View style={{ width: '100%', gap: 8, alignItems: 'center' }}>
            {chip('Shift is closed. Open it to start.', 'amber', 'warn')}
            {B('Open shift', 'openShift', '', 'primary', false, '', { width: '100%' })}
          </View>
        )}
        {B('Grader Dashboard', 'goHistory', '', '', false, 'list', { width: '100%' })}

        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          {B('How it works', 'showOnboarding', '', 'ghost', false, 'info')}
          {B(S.demo.enabled ? 'Demo: ON' : 'Demo', 'openDemoDrawer', '', S.demo.enabled ? 'small primary' : 'ghost')}
          {B(pend ? `Sync (${pend})` : 'Sync', 'goSync', '', 'ghost', false, 'refresh')}
        </View>
      </View>

      {sm && sm.open ? (
        <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(15,27,43,0.48)', alignItems: 'center', justifyContent: 'center', padding: 20, zIndex: 60 }}>
          <Card lift style={{ width: '100%', maxWidth: 420, gap: 12, padding: 20, borderRadius: 24 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <Txt k="h1" style={{ fontSize: 20 }}>Sync pending records</Txt>
              {B('Toggle all', 'syncToggleAll', '', 'small ghost')}
            </View>
            <Txt k="sub">Select graders to upload to shared Supabase:</Txt>
            <ScrollView style={{ maxHeight: 220 }}>
              <View style={{ gap: 8 }}>
                {Object.keys(sm.groups).length ? Object.keys(sm.groups).map((g) => {
                  const info = sm.groups[g], on = !!sm.selected[g];
                  return (
                    <Pressable key={g} onPress={() => act('syncToggleGrader', g)}
                      style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 12, borderRadius: 14, borderWidth: 1, borderColor: on ? C.primary : C.border, backgroundColor: on ? '#EEF4FF' : C.surface }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                        <View style={{ width: 22, height: 22, borderRadius: 6, borderWidth: 2, borderColor: on ? C.primary : C.border, backgroundColor: on ? C.primary : 'transparent', alignItems: 'center', justifyContent: 'center' }}>
                          {on ? <Icon n="check" s={14} c="#fff" w={3} /> : null}
                        </View>
                        <Text style={{ fontWeight: '700', color: C.navy, fontSize: 15 }}>{g}</Text>
                      </View>
                      <Text style={{ color: C.text2, fontSize: 13 }}>{`${info.pending} pending · ${info.total} total`}</Text>
                    </Pressable>
                  );
                }) : <Txt k="det">No local records on this device yet.</Txt>}
              </View>
            </ScrollView>
            <View style={{ flexDirection: 'row', gap: 10 }}>
              {B('Close', 'syncModalClose', '', '', false, '', { flex: 1 })}
              {B('Sync selected', 'syncStartSelected', '', 'primary', !Object.values(sm.selected).some(Boolean), 'refresh', { flex: 1 })}
            </View>
          </Card>
        </View>
      ) : null}

      {sw && sw.open ? (
        <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(15,27,43,0.48)', alignItems: 'center', justifyContent: 'center', padding: 20, zIndex: 70 }}>
          <Card lift style={{ width: '100%', maxWidth: 400, gap: 14, padding: 22, borderRadius: 24, alignItems: 'center' }}>
            <Spin />
            <Txt k="h1" style={{ fontSize: 20, textAlign: 'center' }}>Slow Wi-Fi connection</Txt>
            <Txt k="sub" style={{ textAlign: 'center' }}>{`Syncing ${Math.min(sw.done + 1, sw.total)}/${sw.total}…`}</Txt>
            <View style={{ flexDirection: 'row', gap: 10, width: '100%' }}>
              {B('Sync in background', 'slowWifiBg', '', '', false, '', { flex: 1 })}
              {B('Keep waiting', 'slowWifiBg', '', 'primary', false, '', { flex: 1 })}
            </View>
          </Card>
        </View>
      ) : null}
    </Hero>
  );
}
screens.welcome = () => renderWelcome();

screens.weight = () => {
  const s = S.session, chk = weightCheck(s.weightStr), editing = s.editingWeight, ts = TS();
  const keys = [['1', '2', '3'], ['4', '5', '6'], ['7', '8', '9'], ['.', '0', 'Backspace']];
  const pct = chk.ok ? Math.min(100, Math.max(5, ((chk.t - 150) / (2000 - 150)) * 100)) : 0;
  return (
    <Shell idx={1} left={[backBtn(editing ? 'go' : 'grader', editing ? (s.editFrom || 'price') : ''), helpBtn()]}
      right={[B(editing ? 'Update price' : 'Start capture', 'weightNext', '', 'primary', !chk.ok, 'camera')]}>
      <View style={[BODY, { gap: 12, paddingTop: 6, paddingBottom: 16 }]}>
        <View style={{ backgroundColor: C.primary, borderRadius: 24, padding: 18, gap: 10, shadowColor: C.primary, shadowOpacity: 0.22, shadowRadius: 14, shadowOffset: { width: 0, height: 6 }, elevation: 5 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <Text style={{ fontSize: 18 * ts, fontWeight: '800', color: '#fff' }}>Weigh the fish</Text>
            <View style={{ paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999, backgroundColor: chk.ok ? '#fff' : 'rgba(255,255,255,0.2)' }}>
              <Text style={{ fontSize: 12, fontWeight: '800', color: chk.ok ? C.primary : '#fff' }}>{chk.ok ? 'Valid' : '15–200 kg'}</Text>
            </View>
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6 }}>
            <TextInput
              style={{ flex: 1, fontSize: 52 * ts, fontWeight: '800', color: '#fff', paddingVertical: 0 }}
              value={s.weightStr} onChangeText={(v) => setWeight(v)}
              keyboardType="decimal-pad" placeholder="0" placeholderTextColor="rgba(255,255,255,0.45)" maxLength={5} selectTextOnFocus
            />
            <Text style={{ fontSize: 24, fontWeight: '700', color: 'rgba(255,255,255,0.9)' }}>kg</Text>
          </View>
          <View style={{ height: 6, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.25)', overflow: 'hidden' }}>
            <View style={{ width: `${pct}%`, height: '100%', backgroundColor: '#fff', borderRadius: 3 }} />
          </View>
          {chk.msg ? <Text style={{ color: '#FFE4E4', fontSize: 12.5, fontWeight: '600' }}>{chk.msg}</Text> : null}
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <View style={{ flex: 1, backgroundColor: 'rgba(255,255,255,0.14)', borderRadius: 12, padding: 10 }}>
              <Text style={{ fontSize: 11, color: 'rgba(255,255,255,0.75)' }}>Order</Text>
              <Text style={{ fontSize: 14, fontWeight: '800', color: '#fff' }} numberOfLines={1}>{s.recordId}</Text>
            </View>
            <View style={{ flex: 1, backgroundColor: 'rgba(255,255,255,0.14)', borderRadius: 12, padding: 10 }}>
              <Text style={{ fontSize: 11, color: 'rgba(255,255,255,0.75)' }}>Grader</Text>
              <Text style={{ fontSize: 14, fontWeight: '800', color: '#fff' }} numberOfLines={1}>{s.grader || '—'}</Text>
            </View>
          </View>
        </View>

        <Card lift style={{ gap: 8, paddingVertical: 14, paddingHorizontal: 14 }}>
          {keys.map((row, idx) => (
            <View key={idx} style={{ flexDirection: 'row', gap: 8 }}>
              {row.map((k) => (
                <Pressable key={k} onPress={() => setWeight(k)} style={({ pressed }) => [st.key, { minHeight: 48, backgroundColor: k === 'Backspace' ? '#FBE9E9' : C.surface, borderColor: k === 'Backspace' ? '#F2C6C6' : C.border }, pressed && { backgroundColor: '#EEF4FF' }]}>
                  <Text style={[st.keyText, { fontSize: k === 'Backspace' ? 18 : 22, color: k === 'Backspace' ? C.err : C.navy }]}>{k === 'Backspace' ? '⌫' : k}</Text>
                </Pressable>
              ))}
            </View>
          ))}
          {B('Clear', 'clearWeight', '', 'small ghost')}
        </Card>
      </View>
    </Shell>
  );
};

screens.grader = () => {
  const s = S.session, ts = TS();
  const gm = S.graderCheckModal;
  const initials = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z', '2', '3', '4'];
  const dayKey = (t) => manila(t).toISOString().slice(0, 10);
  const todayList = S.records.filter((r) => dayKey(r.createdAt) === dayKey(Date.now()));
  const kgToday = Math.round(todayList.reduce((acc, r) => acc + (r.weightTenths || 0) / 10, 0));
  const aPct = todayList.length ? Math.round((todayList.filter((r) => r.final?.grade === 'A').length / todayList.length) * 100) : 0;
  return (
    <Shell idx={1} left={[backBtn('cancelSession'), helpBtn()]}
      right={[B('Start grading', 'graderNext', '', 'primary', validateGraderName(s.grader).length < 1, 'camera')]}>
      <View style={[BODY, { gap: 14, paddingTop: 8, paddingBottom: 20 }]}>
        <View style={{ backgroundColor: C.hero, borderRadius: 24, padding: 20, gap: 6, shadowColor: C.hero, shadowOpacity: 0.22, shadowRadius: 14, shadowOffset: { width: 0, height: 6 }, elevation: 5 }}>
          <Text style={{ fontSize: 12, fontWeight: '700', color: 'rgba(255,255,255,0.78)', letterSpacing: 0.8 }}>LET'S START GRADING</Text>
          <Text style={{ fontSize: 32 * ts, fontWeight: '800', color: '#fff' }} numberOfLines={1}>{s.grader.trim() || 'Who is grading?'}</Text>
          <Pressable onPress={() => act('toggleDemoMode')} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 10, backgroundColor: 'rgba(255,255,255,0.14)', borderRadius: 14, paddingVertical: 10, paddingHorizontal: 14 }}>
            <View>
              <Text style={{ fontSize: 13.5, fontWeight: '700', color: '#fff' }}>Demo mode</Text>
              <Text style={{ fontSize: 11.5, color: 'rgba(255,255,255,0.75)' }}>Sample images & simulated grades</Text>
            </View>
            <View style={{ width: 44, height: 24, borderRadius: 12, backgroundColor: S.demo.enabled ? '#fff' : 'rgba(255,255,255,0.28)', padding: 3, justifyContent: 'center', alignItems: S.demo.enabled ? 'flex-end' : 'flex-start' }}>
              <View style={{ width: 18, height: 18, borderRadius: 9, backgroundColor: S.demo.enabled ? C.primary : '#fff' }} />
            </View>
          </Pressable>
        </View>

        <Card lift style={{ gap: 14, paddingVertical: 18, paddingHorizontal: 18 }}>
          <TextInput
            style={[st.field, { minHeight: 58, borderRadius: 18, fontSize: 20 * ts, fontWeight: '700', paddingHorizontal: 18, borderColor: C.primary, backgroundColor: '#fff' }]}
            value={s.grader} onChangeText={(v) => { s.grader = v.slice(0, 15); render(); }}
            placeholder="Enter your name" placeholderTextColor="#8A99AB"
            autoCapitalize="words" autoCorrect={false} maxLength={15} returnKeyType="done"
          />
          <View style={{ backgroundColor: C.canvas, borderRadius: 16, padding: 14, borderWidth: 1, borderColor: C.border, gap: 10 }}>
            <Text style={{ fontSize: 13, fontWeight: '700', color: C.navy }}>Today at this station</Text>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
              <View><Text style={{ fontSize: 20, fontWeight: '800', color: C.navy }}>{todayList.length}</Text><Text style={{ fontSize: 12, color: C.text2 }}>Sessions</Text></View>
              <View><Text style={{ fontSize: 20, fontWeight: '800', color: C.navy }}>{kgToday}</Text><Text style={{ fontSize: 12, color: C.text2 }}>kg graded</Text></View>
              <View><Text style={{ fontSize: 20, fontWeight: '800', color: C.navy }}>{`${aPct}%`}</Text><Text style={{ fontSize: 12, color: C.text2 }}>Grade A</Text></View>
            </View>
          </View>
        </Card>
      </View>

      {gm ? (
        <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(15,27,43,0.48)', alignItems: 'center', justifyContent: 'center', padding: 20, zIndex: 60 }}>
          <Card lift style={{ width: '100%', maxWidth: 430, gap: 14, padding: 20, borderRadius: 24 }}>
            <Txt k="h1" style={{ fontSize: 22 }}>{`Are you ${gm.match.name}?`}</Txt>
            <Txt k="sub">{`Have you graded ${gm.match.ago}?`}</Txt>
            {!gm.addingInitial ? (
              <View style={{ flexDirection: 'row', gap: 10 }}>
                {B('No, start new', 'graderMatchNo', '', '', false, '', { flex: 1 })}
                {B('Yes, continue', 'graderMatchYes', '', 'primary', false, 'check', { flex: 1 })}
              </View>
            ) : (
              <View style={{ gap: 10 }}>
                <Txt k="label">{`Add 1–4 last-initial characters for "${gm.typed} ${gm.initialStr || '_'}"`}</Txt>
                <TextInput
                  value={gm.initialStr}
                  onChangeText={(v) => act('graderInitialSet', v)}
                  placeholder="Type 1–4 characters (e.g. H)"
                  placeholderTextColor="#8A99AB"
                  autoCapitalize="characters"
                  autoCorrect={false}
                  autoFocus
                  maxLength={4}
                  style={[st.field, { minHeight: 48, borderRadius: 14, fontSize: 18 * ts, fontWeight: '700', paddingHorizontal: 14, borderColor: C.primary, backgroundColor: '#fff' }]}
                />
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                  {initials.map((ch) => (
                    <Pressable key={ch} onPress={() => act('graderInitialKey', ch)} style={{ width: 34, height: 36, borderRadius: 10, borderWidth: 1, borderColor: C.border, backgroundColor: C.canvas, alignItems: 'center', justifyContent: 'center' }}>
                      <Text style={{ fontWeight: '700', color: C.navy }}>{ch}</Text>
                    </Pressable>
                  ))}
                  <Pressable onPress={() => act('graderInitialKey', 'del')} style={{ width: 46, height: 36, borderRadius: 10, borderWidth: 1, borderColor: C.border, backgroundColor: C.warnbg, alignItems: 'center', justifyContent: 'center' }}>
                    <Text style={{ fontWeight: '700', color: C.navy }}>⌫</Text>
                  </Pressable>
                </View>
                {gm.error ? <Text style={{ color: C.err, fontSize: 13 }}>{gm.error}</Text> : null}
                <View style={{ flexDirection: 'row', gap: 10 }}>
                  {B('Cancel', 'graderCheckCancel', '', '', false, '', { flex: 1 })}
                  {B('Continue', 'graderInitialConfirm', '', 'primary', !gm.initialStr.length, 'arrow', { flex: 1 })}
                </View>
              </View>
            )}
          </Card>
        </View>
      ) : null}
    </Shell>
  );
};

screens.tutorial = () => {
  const step = S.tutorialStep || 1;
  const info = [
    { t: 'Pull out the tray', b: 'Use the chamber handle and make sure the surface is clean.' },
    { t: 'Place the sample', b: 'Lay the Sashibo core flat and centered inside the outline.' },
    { t: 'Close and scan', b: 'Close the tray smoothly and capture to grade immediately.' },
  ][step - 1];
  return (
    <Shell idx={2} left={[backBtn('go', 'weight'), helpBtn()]}
      right={[B(step < 3 ? 'Next' : 'Continue', 'tutNext', '', 'primary', false, 'arrow'), B('Close', 'tutClose', '', 'ghost')]}>
      <View style={[BODY, { gap: 14, alignItems: 'center', justifyContent: 'center', paddingBottom: 16 }]}>
        <View style={{ flexDirection: 'row', gap: 8, width: '100%' }}>
          {[1, 2, 3].map((n) => (
            <View key={n} style={{ flex: 1, height: 6, borderRadius: 3, backgroundColor: n <= step ? C.primary : C.border }} />
          ))}
        </View>
        <View style={{ width: '100%', backgroundColor: C.primary, borderRadius: 26, padding: 20, alignItems: 'center', justifyContent: 'center', shadowColor: C.primary, shadowOpacity: 0.22, shadowRadius: 16, shadowOffset: { width: 0, height: 8 }, elevation: 5 }}>
          <Text style={{ position: 'absolute', top: 12, right: 18, fontSize: 54, fontWeight: '800', color: 'rgba(255,255,255,0.16)' }}>{`0${step}`}</Text>
          <ChamberLine w={Math.min(280, Dimensions.get('window').width - 80)} />
        </View>
        <Card lift style={{ width: '100%', gap: 6, alignItems: 'center' }}>
          <Txt k="h1" style={{ textAlign: 'center', fontSize: 24 }}>{info.t}</Txt>
          <Txt k="sub" style={{ textAlign: 'center' }}>{info.b}</Txt>
        </Card>
      </View>
    </Shell>
  );
};

const DESC = {
  core: 'Primary sample · graded first for every fish',
  tail: 'Supplementary · only needed if Core is Grade C or under 75%',
};
screens.sample = () => {
  const s = S.session;
  const card = (t) => {
    const done = s.captures.some((c) => c.type === t);
    const sel = s.sampleTypes.includes(t);
    const isCore = t === 'core';
    return (
      <Pressable key={t} disabled={done} onPress={() => act('pick', t)}
        style={[st.cardBtn, { minHeight: 170, borderRadius: 28 }, sel && { borderColor: C.primary, backgroundColor: '#EEF4FF' },
        sel && { shadowColor: C.primary, shadowOpacity: 0.2, shadowRadius: 14, shadowOffset: { width: 0, height: 8 }, elevation: 5 }, done && { opacity: 0.45 }]}>
        <View style={{ position: 'absolute', top: 14, left: 14 }}>
          {chip(isCore ? 'Primary · Step 1' : 'Supplementary', isCore ? 'info' : 'amber')}
        </View>
        <View style={{ position: 'absolute', top: 14, right: 14, width: 38, height: 38, borderRadius: 19, backgroundColor: sel || done ? C.primary : '#EEF2FA', alignItems: 'center', justifyContent: 'center' }}>
          {sel || done ? <Icon n="check" s={22} c="#fff" w={3} /> : null}
        </View>
        <SampleIcon type={t} size={130} />
        <Txt k="h2">{TYPES[t].name}</Txt>
        <Txt k="sub" style={{ textAlign: 'center' }}>{done ? 'Already graded in this session' : DESC[t]}</Txt>
        <Text style={{ fontSize: 13, fontWeight: '700', color: sel ? C.primary : C.text2 }}>
          {done ? 'Completed' : isCore ? 'Required first' : sel ? 'Supplementary included' : 'Tap to include (optional)'}
        </Text>
      </Pressable>
    );
  };
  const canContinue = s.sampleTypes.length > 0;
  return (
    <Shell idx={2} left={[backBtn('sampleBack'), helpBtn()]} right={[B('Continue', 'sampleNext', '', 'primary', !canContinue, 'arrow')]}>
      <View style={{ flexGrow: 1, paddingBottom: 8, gap: 10 }}>
        <View style={{ alignItems: 'center', gap: 6, paddingTop: 6 }}>
          <Txt k="title" style={{ fontSize: 34, textAlign: 'center' }}>Sample workflow</Txt>
          <Sub>Sashibo core is graded first. Tail cut is supplementary if needed.</Sub>
        </View>
        <Card style={{ gap: 8, backgroundColor: '#F8FBFF', borderColor: '#C9D9F7' }}>
          <Txt k="h2">Grading plan</Txt>
          <Txt k="sub">{s.sampleTypes.includes('tail') ? '1. Sashibo core  →  2. Tail cut (supplementary)' : '1. Sashibo core (Tail cut only if Grade C or <75%)'}</Txt>
        </Card>
        <View style={{ flex: 1, gap: 12 }}>{card('core')}{card('tail')}</View>
      </View>
    </Shell>
  );
};

function Brackets({ size = 200, color = C.cyan, w = 6 }) {
  const a = 34, o = w / 2, e = size - o;
  return (
    <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ position: 'absolute' }} pointerEvents="none">
      <G fill="none" stroke={color} strokeWidth={w} strokeLinecap="round" strokeLinejoin="round">
        <Path d={`M${o} ${a}V${o + 14}Q${o} ${o} ${o + 14} ${o}H${a}`} />
        <Path d={`M${size - a} ${o}H${e - 14}Q${e} ${o} ${e} ${o + 14}V${a}`} />
        <Path d={`M${o} ${size - a}V${e - 14}Q${o} ${e} ${o + 14} ${e}H${a}`} />
        <Path d={`M${size - a} ${e}H${e - 14}Q${e} ${e} ${e} ${e - 14}V${size - a}`} />
      </G>
    </Svg>
  );
}
function ScanArt({ size = 190 }) {
  return <Image source={IMG.qr} style={{ width: size, height: size }} resizeMode="contain" />;
}

/* ---------- camera permission panel (used by the QR scanner and the photo screen) ---------- */
function CameraPermission({ dark, msg }) {
  const [perm] = useCameraPermissions();
  const blocked = !!perm && !perm.granted && !perm.canAskAgain;
  const fg = dark ? '#FFFFFF' : C.navy, sub = dark ? '#C8D4E3' : C.text2;
  return (
    <View style={{ width: '100%', alignItems: 'center', justifyContent: 'center', gap: 12, paddingVertical: 22, paddingHorizontal: 22 }}>
      <View style={{ width: 58, height: 58, borderRadius: 29, backgroundColor: dark ? 'rgba(255,255,255,0.14)' : '#E4ECFC', alignItems: 'center', justifyContent: 'center' }}>
        <Icon n="camera" s={30} c={dark ? '#fff' : C.primary} />
      </View>
      <Text style={{ fontSize: 20 * TS(), fontWeight: '800', color: fg, textAlign: 'center' }}>Allow camera access</Text>
      <Text style={{ fontSize: 14.5 * TS(), lineHeight: 20 * TS(), color: sub, textAlign: 'center', maxWidth: 280 }}>
        {blocked ? 'Camera access is turned off. Open your phone settings and allow the camera for TunaEye.' : msg}
      </Text>
      <View style={{ alignSelf: 'stretch', alignItems: 'center', marginTop: 4 }}>
        {B(blocked ? 'Open settings' : 'Allow camera', blocked ? 'openSettings' : 'allowCamera', '', 'primary', false, '', { alignSelf: 'stretch', maxWidth: 300, minHeight: 52 })}
      </View>
    </View>
  );
}

function Scanner() {
  const [perm, requestPerm] = useCameraPermissions();
  const done = useRef(false), lastBad = useRef('');
  askCamera = requestPerm;
  // Ask for access automatically the first time the scanner opens.
  useEffect(() => { if (perm && !perm.granted && perm.canAskAgain) requestPerm(); }, [perm ? perm.granted : null, perm ? perm.canAskAgain : null]);
  const onScan = (e) => {
    if (done.current) return;
    const id = parseKioskCode(e && e.data);
    if (!id) {
      if (lastBad.current !== (e && e.data)) { lastBad.current = e && e.data; S.scanError = "That isn't a TunaEye kiosk code. Scan the code on the kiosk."; render(); }
      return;
    }
    done.current = true; connectPhone(id);
  };
  const box = { width: '82%', aspectRatio: 1, borderRadius: 28, overflow: 'hidden', backgroundColor: '#0F1B2B', alignItems: 'center', justifyContent: 'center' };
  if (!perm) return <View style={box}><Spin light /></View>;
  if (!perm.granted) {
    return (
      <Card lift style={{ width: '100%', padding: 4 }}>
        <CameraPermission msg="TunaEye needs your phone camera to scan the QR code on the kiosk." />
      </Card>
    );
  }

  return (
    <View style={box}>
      <CameraView
        style={StyleSheet.absoluteFill}
        facing="back"
        barcodeScannerSettings={{
          barcodeTypes: ['qr'],
        }}
        onBarcodeScanned={({ data }) => {
          if (!data || pairingInProgress) return;
          pairWithKiosk(data);
        }}
      />

      <View
        pointerEvents="none"
        style={{
          width: '68%',
          aspectRatio: 1,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Brackets size={190} />
      </View>

      {chip(
        S.piStatus === 'connecting'
          ? 'Connecting to Raspberry Pi…'
          : 'Looking for the kiosk code…',
        'info',
        '',
        {
          position: 'absolute',
          top: 14,
          alignSelf: 'center',
        }
      )}
    </View>
  );
}

screens.pair = () => {
  const s = S.session, ok = s.phone === 'connected';
  return (
    <Shell idx={2} left={[backBtn('go', 'grader'), helpBtn()]} right={[B('Continue', 'pairNext', '', 'primary', !ok, 'arrow')]}>
      <View style={[BODY, { gap: 12, alignItems: 'center', paddingBottom: 8 }]}>
        <Txt k="title" style={{ fontSize: 30, paddingTop: 4, textAlign: 'center' }}>Connect to Raspberry Pi</Txt>
        <Sub>Scan the RPi QR code (10.42.0.1:5000) or tap a preset below.</Sub>
        {ok ? (
          <Card lift style={{ width: '100%', alignItems: 'center', gap: 10, backgroundColor: C.gAbg, borderColor: '#BFE3D2', paddingVertical: 28 }}>
            <Icon n="check" s={56} c={C.gA} w={3} /><Txt k="h2" style={{ color: C.gA }}>Connected</Txt>
            <Txt k="sub" style={{ color: C.gA, textAlign: 'center' }}>{`${S.kioskId || 'KIOSK-01'} · ${S.piApiUrl}`}</Txt>
            {S.piStreamUrl ? <Txt k="det" style={{ color: C.gA }}>{`Camera: ${S.piSnapshotUrl}`}</Txt> : null}
            {B('Disconnect / change', 'repair', '', 'small ghost')}
          </Card>
        ) : (
          <>
            <Scanner />
            {S.scanError ? chip(S.scanError, 'err', 'warn', { alignSelf: 'center' }) : null}
            <Card style={{ width: '100%', gap: 10 }}>
              <Txt k="label">Direct Raspberry Pi URL</Txt>
              <TextInput
                value={S.piUrlDraft}
                onChangeText={(v) => act('setPiUrlDraft', v)}
                placeholder="http://10.42.0.1:5000"
                placeholderTextColor={C.text2}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                style={{
                  borderWidth: 1, borderColor: C.border, borderRadius: 12,
                  paddingHorizontal: 14, paddingVertical: 10, fontSize: 15 * TS(),
                  color: C.navy, backgroundColor: C.canvas, fontFamily: MONO,
                }}
              />
              {B(S.piStatus === 'connecting' ? 'Connecting…' : 'Connect to Raspberry Pi', 'connectPiUrl', '', 'primary', S.piStatus === 'connecting', 'arrow')}
            </Card>
            <DemoPill label="Skip for demo" a="skipDemo" icon="arrow" />
          </>
        )}
      </View>
    </Shell>
  );
};

/* ---------- onboarding ---------- */
const ONB = [
  {
    icon: 'pulse',
    title: 'Welcome to TunaEye',
    body: 'Grade yellowfin tuna by color and clarity. Here is how a session works, in four short steps.',
    art: () => <ChamberLine w={230} />,
  },
  {
    icon: 'edit',
    title: 'Add your name and the weight',
    body: "Weigh the whole fish on your own scale, then type the reading and the grader's name. Both go on the record.",
    art: () => (
      <View style={{ alignItems: 'center', gap: 14 }}>
        <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8, borderBottomWidth: 3, borderBottomColor: C.primary, paddingBottom: 6, paddingHorizontal: 8 }}>
          <Text style={{ fontSize: 52, fontWeight: '700', color: C.navy }}>4.7</Text><Text style={{ fontSize: 22, fontWeight: '600', color: C.text2 }}>kg</Text>
        </View>
        {chip("Grader's name", 'info', 'check')}
      </View>
    ),
  },
  {
    icon: 'camera',
    title: 'Pick a cut, then scan the kiosk',
    body: 'Choose the Sashibo core or the tail cut. Your phone camera opens: scan the QR code on the kiosk to connect.',
    art: () => <ScanArt size={190} />,
  },
  {
    icon: 'check',
    title: 'Take the photo, get a price',
    body: 'Line up the sample and take the picture. TunaEye suggests a grade and an estimate. You can override a grade that looks wrong, and an expert decides if two samples disagree.',
    art: () => <Image source={IMG.scan} style={{ width: 200, height: 200 }} resizeMode="contain" />,
  },
];
screens.onboarding = () => {
  const i = S.onbStep, last = i === ONB.length - 1, d = ONB[i];
  return (
    <Hero>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 20, paddingTop: 14 }}>
        <View style={{ minHeight: 34, paddingHorizontal: 14, borderRadius: 17, backgroundColor: C.heroSoft, justifyContent: 'center' }}>
          <Text style={{ fontSize: 13, fontWeight: '700', color: '#fff' }}>{`Step ${i + 1} of ${ONB.length}`}</Text>
        </View>
        {!last ? (
          <Pressable onPress={() => act('onbSkip')} hitSlop={10} style={{ minHeight: 34, paddingHorizontal: 14, justifyContent: 'center' }}>
            <Text style={{ fontSize: 15, fontWeight: '700', color: '#fff' }}>Skip</Text>
          </Pressable>
        ) : null}
      </View>
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 28 }}>
        <View style={{ width: '100%', maxWidth: 320, height: 250, alignItems: 'center', justifyContent: 'center', backgroundColor: '#fff', borderRadius: 30, transform: [{ rotate: i % 2 ? '3deg' : '-3deg' }], shadowColor: '#0B2A7A', shadowOpacity: 0.28, shadowRadius: 22, shadowOffset: { width: 0, height: 14 }, elevation: 12 }}>
          {d.art()}
        </View>
      </View>
      <View style={sheetStyle}>
        <View style={{ alignItems: 'center', gap: 10 }}>
          <View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: '#EAF0FF', alignItems: 'center', justifyContent: 'center' }}>
            <Icon n={d.icon} s={28} c={C.primary} />
          </View>
          <Txt k="title" style={{ textAlign: 'center', fontSize: 26 * TS() }}>{d.title}</Txt>
          <Txt k="sub" style={{ textAlign: 'center', fontSize: 16 * TS(), lineHeight: 23 * TS() }}>{d.body}</Txt>
        </View>
        <View style={{ flexDirection: 'row', gap: 8, justifyContent: 'center' }}>
          {ONB.map((_, k) => <View key={k} style={{ height: 8, width: k === i ? 26 : 8, borderRadius: 4, backgroundColor: k <= i ? C.primary : C.border }} />)}
        </View>
        <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
          {i > 0 ? (
            <Pressable onPress={() => act('onbBack')} accessibilityRole="button" accessibilityLabel="Back" style={{ width: 62, height: 62, borderRadius: 31, backgroundColor: '#EEF2FA', alignItems: 'center', justifyContent: 'center' }}>
              <Icon n="back" s={26} c={C.navy} />
            </Pressable>
          ) : null}
          {B(i === 0 ? "Let's go" : last ? 'Start grading' : 'Next', 'onbNext', '', 'primary', false, '', { flex: 1 })}
        </View>
      </View>
    </Hero>
  );
};

/* ---------- live phone camera (step 5: take the photo) ---------- */
function PhoneCam({ type }) {
  const [perm, requestPerm] = useCameraPermissions();
  const [err, setErr] = useState(false);
  const [tries, setTries] = useState(0);
  askCamera = requestPerm;
  // Ask for access automatically when the screen opens.
  useEffect(() => { if (perm && !perm.granted && perm.canAskAgain) requestPerm(); }, [perm ? perm.granted : null, perm ? perm.canAskAgain : null]);
  useEffect(() => () => { S.camReady = false; camRef = null; }, []);
  if (!perm) return <Spin light />;
  if (!perm.granted) return <CameraPermission dark msg="Your phone camera shows and photographs the sample." />;
  if (err) {
    return (
      <View style={{ width: '100%', alignItems: 'center', gap: 12, padding: 22 }}>
        <Icon n="warn" s={40} c="#FFD98A" />
        <Text style={{ color: '#fff', fontSize: 18, fontWeight: '700', textAlign: 'center' }}>The camera did not start</Text>
        <Text style={{ color: '#C8D4E3', fontSize: 14, textAlign: 'center' }}>Close other apps that use the camera, then try again.</Text>
        <Pressable onPress={() => { setErr(false); setTries((n) => n + 1); }} style={{ minHeight: 48, paddingHorizontal: 28, borderRadius: 999, backgroundColor: C.primary, alignItems: 'center', justifyContent: 'center' }}>
          <Text style={{ color: '#fff', fontSize: 16, fontWeight: '700' }}>Try again</Text>
        </Pressable>
      </View>
    );
  }
  return (
    <>
      <CameraView
        key={tries} ref={(r) => { camRef = r; }} style={StyleSheet.absoluteFill} facing="back"
        onCameraReady={() => { S.camReady = true; render(); }} onMountError={() => { S.camReady = false; setErr(true); }}
      />
      <View pointerEvents="none" style={{ position: 'absolute', top: '12%', bottom: '12%', left: '14%', right: '14%', borderWidth: 4, borderStyle: 'dashed', borderColor: 'rgba(93,217,245,0.95)', borderRadius: 36 }} />
      {chip(TYPES[type].name, '', '', { position: 'absolute', left: 20, top: 20, backgroundColor: '#fff' })}
      {chip('Live · Phone camera', 'info', '', { position: 'absolute', right: 20, top: 20 })}
      {S.flash && <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: '#fff', opacity: 0.7 }]} />}
    </>
  );
}
const camView = (t) => {
  const showPiStream = !S.demo.enabled && S.camSource === 'pi' && S.phoneLinked && S.piStreamUrl;
  const demoCode = S.demo.queue.length ? S.demo.queue[0] : S.demo.next;
  return (
    <ImgFrame style={{ width: '100%', aspectRatio: 4 / 3 }}>
      {S.demo.enabled ? (
        <View style={{ flex: 1, width: '100%', height: '100%', backgroundColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center' }}>
          <Image source={demoAssetFor(t, demoCode)} style={{ width: '92%', height: '92%' }} resizeMode="contain" />
          <Brackets size={220} w={5} color={C.primary} />
          <View style={{ position: 'absolute', top: 10, left: 10, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999, backgroundColor: 'rgba(248,250,252,0.95)', borderWidth: 1, borderColor: '#DCE5F2', flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: '#F59E0B' }} />
            <Text style={{ color: C.navy, fontSize: 12, fontWeight: '700' }}>Demo mode · Sample image</Text>
          </View>
        </View>
      ) : showPiStream ? (
        <View style={{ flex: 1, width: '100%', height: '100%', backgroundColor: '#0F1B2B', alignItems: 'center', justifyContent: 'center' }}>
          <Image source={{ uri: S.piStreamUrl }} style={StyleSheet.absoluteFill} resizeMode="cover" />
          <Brackets size={170} />
          <View style={{ position: 'absolute', top: 10, left: 10, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999, backgroundColor: 'rgba(15,27,43,0.75)', flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: C.online }} />
            <Text style={{ color: '#fff', fontSize: 12, fontWeight: '700' }}>{`RPi Stream · ${S.piStreamUrl.replace(/^https?:\/\//, '')}`}</Text>
          </View>
        </View>
      ) : (
        <PhoneCam type={t} />
      )}
    </ImgFrame>
  );
};

/* soft tinted pill, centered */
function DemoPill({ label, a, icon = 'camera' }) {
  return (
    <Pressable
      onPress={() => act(a)}
      accessibilityRole="button" accessibilityLabel={label}
      style={({ pressed }) => [
        {
          alignSelf: 'center', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
          minHeight: 46, paddingHorizontal: 20, borderRadius: 999, backgroundColor: '#E4ECFC',
          borderWidth: 1, borderColor: '#CFDDF6',
          shadowColor: C.primary, shadowOpacity: 0.12, shadowRadius: 10, shadowOffset: { width: 0, height: 4 }, elevation: 2
        },
        pressed && { transform: [{ scale: 0.98 }], backgroundColor: '#D5E1F8' },
      ]}
    >
      <Icon n={icon} s={20} c={C.primary} />
      <Text style={{ fontSize: 15 * TS(), fontWeight: '700', color: C.primary }}>{label}</Text>
    </Pressable>
  );
}

/* Step 4: shows the top-down illustration (SAMPLETOPDOWN.png) so the grader knows how to place the sample */
screens.align = () => {
  const s = S.session;
  const w = Math.min(360, Dimensions.get('window').width - 40);
  return (
    <Shell idx={4} left={[backBtn('go', 'pair'), helpBtn()]} right={[B('Looks good', 'go', 'camera', 'primary', false, 'arrow')]}>
      <View style={[BODY, { gap: 14, alignItems: 'center', paddingBottom: 8 }]}>
        <Txt k="title" style={{ fontSize: 34, paddingTop: 6, textAlign: 'center' }}>Line it up</Txt>
        <Sub>Place the sample in the tray like this, cut face up and inside the outline.</Sub>
        <View style={{ width: w }}>
          <ChamberLine w={w} />
          <View pointerEvents="none" style={{ position: 'absolute', top: '16%', bottom: '16%', left: '18%', right: '18%', borderWidth: 4, borderStyle: 'dashed', borderColor: 'rgba(93,217,245,0.95)', borderRadius: 36 }} />
        </View>
        {chip(`Sample: ${TYPES[s.sampleType].name}`, '', 'tag', { alignSelf: 'center' })}
        {chip('Center it inside the outline', 'info', 'check', { alignSelf: 'center' })}
      </View>
    </Shell>
  );
};

/* Step 5: the live phone camera (always the real camera, never an illustration) */
screens.camera = () => {
  const s = S.session, t = s.sampleType || 'core', linked = s.phone === 'connected';
  const isTail = t === 'tail';
  const usePiCam = !S.demo.enabled && S.camSource === 'pi';
  return (
    <Shell idx={isTail ? 4 : 3} left={[backBtn('go', isTail ? 'result' : 'grader'), helpBtn()]}
      right={[
        B('Upload image', 'uploadImage', '', '', S.busy || S.picking, 'gallery'),
        S.demo.enabled
          ? B('Demo scan', 'demoScan', '', 'primary', S.busy || S.picking, 'camera')
          : usePiCam
            ? B(S.busy ? 'Capturing…' : 'Scan sample', 'capturePi', '', 'primary', S.busy || S.picking || !linked, 'camera')
            : B(S.busy ? 'Taking photo…' : 'Take photo', 'capture', '', 'primary', S.busy || S.picking || !linked || !S.camReady, 'camera'),
      ]}>
      <View style={[BODY, { gap: 10, alignItems: 'center', paddingBottom: 12 }]}>
        <Txt k="title" style={{ fontSize: 28, paddingTop: 2, textAlign: 'center' }}>
          {isTail ? 'Show the tail cut face' : 'Place the core in the frame'}
        </Txt>
        <View style={{ flexDirection: 'row', gap: 8, width: '100%' }}>
          <View style={{ flex: 1, backgroundColor: '#fff', borderRadius: 14, padding: 10, borderWidth: 1, borderColor: '#DCE5F2' }}>
            <Text style={{ fontSize: 10.5, fontWeight: '700', color: C.text2, letterSpacing: 0.6 }}>ORDER</Text>
            <Text style={{ fontSize: 15, fontWeight: '800', color: C.navy }} numberOfLines={1}>{s.recordId}</Text>
          </View>
          <View style={{ flex: 1, backgroundColor: '#fff', borderRadius: 14, padding: 10, borderWidth: 1, borderColor: '#DCE5F2' }}>
            <Text style={{ fontSize: 10.5, fontWeight: '700', color: C.text2, letterSpacing: 0.6 }}>WEIGHT</Text>
            <Text style={{ fontSize: 15, fontWeight: '800', color: C.navy }}>{fmtKg(s.weightTenths)}</Text>
          </View>
        </View>
        {!S.demo.enabled ? (
          <View style={{ flexDirection: 'row', gap: 8, width: '100%' }}>
            {B('RPi Stream', 'setCamSource', 'pi', usePiCam ? 'small primary' : 'small', false, 'camera', { flex: 1 })}
            {B('Phone Camera', 'setCamSource', 'phone', !usePiCam ? 'small primary' : 'small', false, 'camera', { flex: 1 })}
          </View>
        ) : null}
        {camView(t)}
        {S.demo.quality === 'blurry' ? chip('Check focus', 'amber', 'warn', { alignSelf: 'center' }) : null}
      </View>
      {S.cannotDetermineModal && S.cannotDetermineModal.open ? (
        <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(15,27,43,0.5)', alignItems: 'center', justifyContent: 'center', padding: 20, zIndex: 60 }}>
          <Card lift style={{ width: '100%', maxWidth: 410, gap: 14, padding: 22, borderRadius: 24, alignItems: 'center' }}>
            {chip('Cannot Be Determined', 'err', 'warn')}
            <Txt k="h1" style={{ fontSize: 20, textAlign: 'center' }}>Cannot Be Determined</Txt>
            <Txt k="sub" style={{ textAlign: 'center' }}>{S.cannotDetermineModal.message}</Txt>
            {B('Scan again', 'dismissCannotDetermine', '', 'primary', false, 'camera', { width: '100%' })}
          </Card>
        </View>
      ) : null}
    </Shell>
  );
};

screens.review = () => {
  const s = S.session, p = s.pending;
  const tone = 'X';
  const bad = false;
  return (
    <Shell idx={p.type === 'tail' ? 4 : 3} left={[backBtn('retake'), B('Retake', 'retake', '', 'ghost', false, 'refresh'), helpBtn()]} right={[B('Use image', 'useImage', '', 'primary', false, 'check')]}>
      <View style={[BODY, { paddingBottom: 12, gap: 12 }]}>
        <Txt k="title" style={{ fontSize: 28, textAlign: 'center' }}>Use this image?</Txt>
        <ImgFrame style={{ width: '100%', aspectRatio: 4 / 3 }}>{photo(p.uri, tone, p.type, bad)}</ImgFrame>
        <Card lift style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 14 }}>
          <Text style={{ fontSize: 16, fontWeight: '700', color: C.navy }}>{TYPES[p.type].name}</Text>
          {chip('Ready', 'ok', 'check')}
        </Card>
      </View>
    </Shell>
  );
};

screens.analysis = () => {
  const s = S.session, j = s.job || { stage: 0, state: 'run' }, p = s.pending;
  const sampleLabel = p ? TYPES[p.type].name : 'Sashibo core';
  const rail = ['Capture', 'Analyze', 'Result'].map((n, i) => {
    const done = i === 0 || (i === 1 && j.stage >= 2), on = (i === 1 && j.stage < 2) || (i === 2 && j.stage >= 2);
    const col = done ? C.gA : on ? C.primary : C.text2;
    return (
      <React.Fragment key={n}>
        {i ? <View style={{ width: 22, height: 3, backgroundColor: C.border, borderRadius: 2 }} /> : null}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          {done ? <Icon n="check" s={22} c={col} w={3} /> : null}
          <Text style={{ fontSize: 14 * TS(), fontWeight: '600', color: col }}>{n}</Text>
        </View>
      </React.Fragment>
    );
  });
  return (
    <Bare>
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 18, paddingHorizontal: 22 }}>
        <ImgFrame style={{ width: 260, height: 195 }}>{p ? photo(p.uri, 'X', p.type) : null}</ImgFrame>
        {(j.state === 'timeout' || j.state === 'error') ? (
          <>
            {chip(j.state === 'error' ? 'Could not grade' : 'Taking longer than expected', 'amber', 'warn')}
            <Txt style={{ textAlign: 'center', maxWidth: 420 }}>{j.msg || 'The analysis did not finish in time. Try again or retake.'}</Txt>
            <View style={{ flexDirection: 'row', gap: 12, width: '100%', maxWidth: 360 }}>{B('Retake', 'retake', '', '', '', '', { flex: 1 })}{B('Try again', 'retryAnalysis', '', 'primary', '', '', { flex: 1 })}</View>
          </>
        ) : (
          <View style={{ alignItems: 'center', gap: 12 }}>
            <Spin />
            <Txt k="h1" style={{ textAlign: 'center' }}>{`Reading ${sampleLabel.toLowerCase()}…`}</Txt>
          </View>
        )}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 }}>{rail}</View>
      </View>
    </Bare>
  );
};

const sampleInfoCard = (c, s, extraRows, foot) => (
  <Card style={{ gap: 16 }}>
    <ImgFrame style={{ width: '100%', height: 170 }}>{imgFor(c)}</ImgFrame>
    <View>{infoRows(extraRows)}</View>
    {foot}
  </Card>
);

const valueCard = (s, p) => (
  <Card lift style={{ gap: 12, paddingVertical: 18, paddingHorizontal: 18 }}>
    <Text style={{ fontSize: 11.5, fontWeight: '800', color: C.text2, letterSpacing: 0.8 }}>TOTAL VALUE</Text>
    {p.ok ? (
      <>
        <Text style={{ fontSize: 36 * TS(), fontWeight: '800', color: C.primary }}>{fmtMoney(p.total)}</Text>
        <Txt k="sub">{`${fmtKg(s.weightTenths)} × ${fmtMoney(p.rate)} / kg`}</Txt>
        <View style={{ backgroundColor: C.canvas, borderRadius: 14, paddingHorizontal: 12, paddingVertical: 4, borderWidth: 1, borderColor: C.border }}>
          <KV l="Weight" r={fmtKg(s.weightTenths)} />
          <KV l="Rate" r={`${fmtMoney(p.rate)} / kg`} />
          <KV l="Grade" r={`${p.grade} · ${GRADE_SUB[p.grade] || ''}`} last />
        </View>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          {['A', 'B', 'C'].map((gr) => {
            const on = p.grade === gr;
            return (
              <View key={gr} style={{ flex: 1, borderRadius: 14, paddingVertical: 10, alignItems: 'center', backgroundColor: on ? GRADE_HERO[gr] : C.canvas, borderWidth: 1, borderColor: on ? GRADE_HERO[gr] : C.border }}>
                <Text style={{ fontSize: 16, fontWeight: '800', color: on ? '#fff' : C.text2 }}>{gr}</Text>
                <Text style={{ fontSize: 11, fontWeight: '700', color: on ? 'rgba(255,255,255,0.9)' : C.text2 }}>{fmtMoney(S.schedule.rates[gr]).replace('.00', '')}</Text>
              </View>
            );
          })}
        </View>
      </>
    ) : (<>{chip('Unavailable', 'amber', 'warn')}<Txt k="sub">{p.why}</Txt></>)}
    {B('Fix weight', 'correctWeight', '', 'small ghost', false, 'edit')}
  </Card>
);

screens.result = () => {
  const s = S.session, c = s.captures[s.captures.length - 1], p = priceFor(s), r = resolve(s);
  const g = r.status === 'final' ? r.grade : c.label, manual = r.origin === 'manual', pct = Math.round(c.score * 1000) / 10;
  const tailPrompt = Boolean(r.tailNeeded && c.type === 'core');
  const heroBg = tailPrompt ? '#FFF9EC' : GRADE_HERO[g] || C.primary;
  return (
    <Shell idx={5} left={[backBtn('go', 'grader'), B('Retake', 'retakeSaved', '', 'ghost', false, 'refresh'), helpBtn()]}
      right={[
        tailPrompt ? B('Capture tail cut', 'captureTail', '', 'primary', false, 'camera') : null,
        !tailPrompt ? B('Print receipt', 'confirmQuote', '', 'primary', !p.ok, 'print') : null,
      ]}>
      <View style={[BODY, { gap: 12, paddingBottom: 16 }]}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
          <View>
            <Txt k="title" style={{ fontSize: 28 }}>{tailPrompt ? 'Tail cut needed' : 'Final grade'}</Txt>
            <Txt k="det">{`${s.recordId} · ${s.grader} · ${fmtKg(s.weightTenths)}`}</Txt>
          </View>
          {tailPrompt ? chip('Action needed', 'amber', 'warn') : r.provisional ? chip('Provisional', 'amber', 'warn') : chip('Graded', 'ok', 'check')}
        </View>

        <Card lift style={{ alignItems: 'center', gap: 8, paddingVertical: 22, backgroundColor: heroBg, borderColor: tailPrompt ? '#EBD59C' : heroBg }}>
          {tailPrompt ? (
            <>
              <Text style={{ fontSize: 48 * TS(), fontWeight: '800', color: C.navy }}>{`${pct}%`}</Text>
              <Txt k="sub" style={{ color: C.amber, fontWeight: '700' }}>{`Grade ${g} · ${pct < 75 ? 'Under 75%' : 'Grade C check'}`}</Txt>
              <View style={{ width: '88%', height: 10, borderRadius: 5, backgroundColor: 'rgba(0,0,0,0.08)', overflow: 'hidden' }}>
                <View style={{ width: `${Math.min(100, pct)}%`, height: '100%', backgroundColor: C.amber }} />
              </View>
              <Txt k="sub" style={{ textAlign: 'center', color: '#5F3B00', marginTop: 4 }}>{r.reason}</Txt>
            </>
          ) : (
            <>
              <View style={{ width: 88, height: 88, borderRadius: 44, borderWidth: 4, borderColor: '#fff', alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.16)' }}>
                <Text style={{ fontSize: 48 * TS(), fontWeight: '800', color: '#fff' }}>{g}</Text>
              </View>
              <Text style={{ fontSize: 26 * TS(), fontWeight: '800', color: '#fff' }}>{`Grade ${g}${r.provisional ? ' (Provisional)' : ''}`}</Text>
              <Text style={{ fontSize: 14, fontWeight: '600', color: 'rgba(255,255,255,0.9)' }}>{GRADE_SUB[g] || ''}</Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: 'rgba(0,0,0,0.18)', borderRadius: 999, paddingVertical: 6, paddingHorizontal: 14, marginTop: 4 }}>
                <Text style={{ color: 'rgba(255,255,255,0.9)', fontSize: 13, fontWeight: '600' }}>{manual ? 'Manual override' : 'Model confidence'}</Text>
                <View style={{ backgroundColor: '#fff', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 3 }}>
                  <Text style={{ color: heroBg, fontSize: 13, fontWeight: '800' }}>{`${pct}%`}</Text>
                </View>
              </View>
              <View style={{ width: '88%', marginTop: 8, gap: 4 }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                  <Text style={{ color: '#fff', fontSize: 12.5, fontWeight: '700' }}>{`${TYPES[c.type].short} · Grade ${c.label}`}</Text>
                  <Text style={{ color: '#fff', fontSize: 12.5, fontWeight: '800' }}>{`${pct}%`}</Text>
                </View>
                <View style={{ height: 8, borderRadius: 4, backgroundColor: 'rgba(255,255,255,0.28)', overflow: 'hidden' }}>
                  <View style={{ width: `${Math.min(100, pct)}%`, height: '100%', backgroundColor: '#fff', borderRadius: 4 }} />
                </View>
              </View>
            </>
          )}
        </Card>

        {tailPrompt ? (
          <Card style={{ gap: 10 }}>
            <Txt k="h2">Is a Tail-Cut sample available?</Txt>
            <View style={{ flexDirection: 'row', gap: 10 }}>
              {B('Scan Tail-Cut', 'captureTail', '', 'primary', false, 'camera', { flex: 1, paddingHorizontal: 12 })}
              {B('No Tail-Cut', 'tailNotAvailable', '', '', false, '', { flex: 1, paddingHorizontal: 12 })}
            </View>
          </Card>
        ) : (
          <>
            <Card style={{ padding: 12, gap: 10 }}>
              <ImgFrame style={{ width: '100%', height: 150 }}>{imgFor(c)}</ImgFrame>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                <Text style={{ fontWeight: '800', color: C.navy, fontSize: 15 }}>{`${TYPES[c.type].short} sample`}</Text>
                <View style={{ paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999, backgroundColor: GRADE_HERO[c.label] || C.primary }}>
                  <Text style={{ color: '#fff', fontSize: 12, fontWeight: '800' }}>{`Grade ${c.label} · ${pct}%`}</Text>
                </View>
              </View>
            </Card>
            {valueCard(s, p)}
          </>
        )}

        <DemoPill label={manual ? 'Change override' : 'Override grade'} a="override" icon="edit" />
      </View>

      {tailPrompt && s.tailPromptOpen ? (
        <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(15,27,43,0.45)', alignItems: 'center', justifyContent: 'center', padding: 20, zIndex: 50 }}>
          <Card lift style={{ width: '100%', maxWidth: 440, gap: 14, padding: 20, borderRadius: 26 }}>
            <View style={{ alignSelf: 'flex-start' }}>{chip(`Sashibo Core · Grade ${g} · ${pct}%`, 'amber')}</View>
            <Txt k="h1" style={{ fontSize: 22 }}>Is a Tail-Cut sample available?</Txt>
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <View style={{ flex: 1, borderWidth: 1, borderColor: '#EBD59C', backgroundColor: '#FFF9EC', borderRadius: 16, padding: 10, alignItems: 'center', gap: 4 }}>
                <SampleIcon type="core" size={56} />
                <Text style={{ fontWeight: '800', color: C.navy, fontSize: 13 }}>{`Grade ${g} (${pct}%)`}</Text>
                <Text style={{ color: C.text2, fontSize: 11 }}>{pct < 75 ? 'Under 75%' : 'Grade C'}</Text>
              </View>
              <View style={{ flex: 1, borderWidth: 1, borderColor: C.border, backgroundColor: C.canvas, borderRadius: 16, padding: 10, alignItems: 'center', gap: 4 }}>
                <SampleIcon type="tail" size={56} />
                <Text style={{ fontWeight: '800', color: C.navy, fontSize: 13 }}>2nd Check</Text>
                <Text style={{ color: C.text2, fontSize: 11 }}>Combines both</Text>
              </View>
            </View>
            <View style={{ flexDirection: 'row', gap: 10 }}>
              {B('Scan Tail-Cut', 'captureTail', '', 'primary', false, 'camera', { flex: 1 })}
              {B('No Tail-Cut', 'tailNotAvailable', '', '', false, '', { flex: 1 })}
            </View>
          </Card>
        </View>
      ) : null}
    </Shell>
  );
};

screens.invalid = () => {
  const s = S.session, c = s.captures[s.captures.length - 1]; const inv = c.outcome === 'invalid';
  const hasOther = s.captures.some((x) => x.id !== c.id && x.outcome === 'accepted');
  return (
    <Shell idx={5} left={[backBtn('go', 'grader'), helpBtn()]} right={[hasOther ? B('Discard sample', 'discardSample', '', 'small danger') : null, !inv ? B('Expert review', 'expert', '', '', '', 'lock') : null, B('Retake', 'retakeSaved', '', 'primary', false, 'refresh')]}>
      <View style={[BODY, { paddingBottom: 8, gap: 10 }]}>
        <Card lift style={{ alignItems: 'center', justifyContent: 'center', gap: 16, backgroundColor: inv ? C.warnbg : C.amberbg }}>
          {inv ? chip('Image rejected', '', 'warn') : chip('Needs another look', 'amber', 'warn')}
          <Icon n={inv ? 'x' : 'help'} s={72} c={inv ? C.warn : C.amber} w={1.8} />
          <Txt k="title" style={{ textAlign: 'center' }}>{inv ? "Can't grade this image" : 'Result is uncertain'}</Txt>
          <Txt style={{ maxWidth: 480, textAlign: 'center' }}>{inv ? "It doesn't show a usable tuna sample. This is a rejected image, not a Grade C." : 'The model could not decide with enough certainty. Retake the image, override the grade manually, or ask an expert to review it.'}</Txt>
        </Card>
        {sampleInfoCard(c, s, [['Sample', TYPES[c.type].name], ['Record', s.recordId], [inv ? 'Model output' : 'Closest candidate', inv ? 'Rejected input' : `Grade ${c.label} · ${Math.round(c.score * 100)}%`]], null)}
        {!inv ? <DemoPill label="Override grade manually" a="override" icon="edit" /> : null}
      </View>
    </Shell>
  );
};

screens.paired = () => {
  const s = S.session, r = resolve(s), p = priceFor(s);
  const ecaps = effCaps(s);
  const caps = ['core', 'tail'].map((t) => ecaps.find((c) => c.type === t)).filter(Boolean);
  const avgPct = caps.length ? Math.round((caps.reduce((acc, c) => acc + (c.score || 0), 0) / caps.length) * 1000) / 10 : 0;
  const panel = (c) => {
    const pct = Math.round((c.score || 0) * 1000) / 10;
    return (
      <Card key={c.type} style={{ gap: 10 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          {chip(c.type === 'core' ? 'Core' : 'Tail', '')}
          {chip(`Grade ${c.label} · ${pct}%`, c.outcome === 'accepted' ? 'ok' : 'amber')}
        </View>
        <ImgFrame style={{ width: '100%', height: 120 }}>{imgFor(c)}</ImgFrame>
        <Txt k="det">{`${TYPES[c.type].name}${c.overridden ? ` (Override · Model: ${capText(c.raw)})` : ''}`}</Txt>
      </Card>
    );
  };
  const fg = r.status === 'final' ? r.grade : null;
  const retakeCap = caps.find((c) => c.outcome !== 'accepted') || caps[caps.length - 1];
  return (
    <Shell idx={5} left={[backBtn('go', 'grader'), retakeCap ? B('Retake', 'retakeType', retakeCap.type, '', '', 'refresh') : null, helpBtn()]}
      right={[r.status !== 'final' ? B('Expert review', 'expert', '', '', '', 'lock') : null, B('Print receipt', 'confirmQuote', '', 'primary', !p.ok, 'print')]}>
      <View style={[BODY, { gap: 14, paddingBottom: 8 }]}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
          <View>
            <Txt k="title" style={{ fontSize: 30 }}>Final grade</Txt>
            <Txt k="det">{`${s.recordId} · ${s.grader} · ${fmtKg(s.weightTenths)}`}</Txt>
          </View>
          {r.status === 'final' ? chip('Graded', 'ok', 'check') : chip('Action needed', 'amber', 'warn')}
        </View>

        {fg ? (
          <Card lift style={{ alignItems: 'center', gap: 10, paddingVertical: 22, backgroundColor: GRADE_HERO[fg], borderColor: GRADE_HERO[fg] }}>
            <View style={{ width: 88, height: 88, borderRadius: 44, borderWidth: 4, borderColor: '#fff', alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.16)' }}>
              <Text style={{ fontSize: 50 * TS(), fontWeight: '800', color: '#fff' }}>{fg}</Text>
            </View>
            <Text style={{ fontSize: 26 * TS(), fontWeight: '800', color: '#fff' }}>{`Grade ${fg}`}</Text>
            <Text style={{ fontSize: 14, fontWeight: '600', color: 'rgba(255,255,255,0.9)' }}>{GRADE_SUB[fg] || ''}</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: 'rgba(0,0,0,0.18)', borderRadius: 999, paddingVertical: 6, paddingHorizontal: 14 }}>
              <Text style={{ color: 'rgba(255,255,255,0.9)', fontSize: 13, fontWeight: '600' }}>Avg confidence</Text>
              <View style={{ backgroundColor: '#fff', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 3 }}>
                <Text style={{ color: GRADE_HERO[fg], fontSize: 13, fontWeight: '800' }}>{`${avgPct}%`}</Text>
              </View>
            </View>
            <View style={{ width: '90%', gap: 8, marginTop: 6 }}>
              {caps.map((c) => {
                const cpct = Math.round((c.score || 0) * 1000) / 10;
                return (
                  <View key={c.type} style={{ gap: 4 }}>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                      <Text style={{ fontSize: 13, fontWeight: '700', color: '#fff' }}>{`${TYPES[c.type].short} · Grade ${c.label}`}</Text>
                      <Text style={{ fontSize: 13, fontWeight: '800', color: '#fff' }}>{`${cpct}%`}</Text>
                    </View>
                    <View style={{ height: 8, borderRadius: 4, backgroundColor: 'rgba(255,255,255,0.28)', overflow: 'hidden' }}>
                      <View style={{ width: `${Math.min(100, cpct)}%`, height: '100%', backgroundColor: '#fff', borderRadius: 4 }} />
                    </View>
                  </View>
                );
              })}
            </View>
          </Card>
        ) : (
          <Card style={{ flexDirection: 'row', gap: 14, alignItems: 'center', backgroundColor: C.amberbg, borderColor: '#EBD59C' }}>
            <Icon n="warn" s={34} c={C.amber} />
            <View style={{ flex: 1 }}>
              <Txt k="h2" style={{ color: C.amber }}>Manual override required</Txt>
              <Txt k="sub" style={{ color: '#5F3B00' }}>{r.reason || 'Override or ask an expert before pricing.'}</Txt>
            </View>
          </Card>
        )}

        {valueCard(s, p)}
        <View style={{ gap: 10 }}>{caps.map(panel)}</View>
        <DemoPill label={s.decisions.some((d) => d.manual) ? 'Change override' : 'Override grade'} a="override" icon="edit" />
      </View>
    </Shell>
  );
};

screens.price = () => {
  const s = S.session, p = priceFor(s);
  return (
    <Shell idx={6} left={[backBtn('go', screenAfterGrade(s)), helpBtn()]} right={[B('Confirm', 'confirmQuote', '', 'primary', !p.ok, 'check')]}>
      <View style={[BODY, { gap: 10, paddingBottom: 8 }]}>
        <Txt k="title" style={{ fontSize: 34, paddingTop: 6, textAlign: 'center' }}>Estimated value</Txt>
        {p.ok ? <View style={{ alignItems: 'center' }}>{gradeChip(p.grade)}</View> : null}
        {valueCard(s, p)}
        <DemoPill label={s.decisions.some((d) => d.manual) ? 'Change override' : 'Override grade'} a="override" icon="edit" />
      </View>
    </Shell>
  );
};

/* ---------- manual override (with two samples, pick which sample to override) ---------- */
screens.override = () => {
  const s = S.session, g = S.ui.ovGrade, reason = S.ui.ovReason.trim(), ts = TS();
  const two = s.captures.length > 1;
  const tg = two ? S.ui.ovTarget : 'all';
  const has = s.decisions.some((d) => d.manual);
  const ok = !!g && !!tg && reason.length >= 3 && S.ui.ovPin.length === 4;
  const ecaps = effCaps(s);
  const shown = two && tg && tg !== 'all' ? ecaps.filter((c) => c.type === tg) : ecaps;
  // Preview the price with the override applied (nothing is saved until "Apply override").
  const hyp = g && tg ? priceFor({ ...s, decisions: withOverride(s.decisions, g, tg) }) : null;
  const tile = (x) => {
    const sel = g === x;
    return (
      <Pressable key={x} onPress={() => act('ovGrade', x)} accessibilityRole="button" accessibilityLabel={`Grade ${x}`}
        style={({ pressed }) => [{ flex: 1, minHeight: 124, borderRadius: 24, borderWidth: 3, borderColor: sel ? GC[x] : C.border, backgroundColor: sel ? GBG[x] : C.surface, alignItems: 'center', justifyContent: 'center', gap: 2 },
        sel && { shadowColor: GC[x], shadowOpacity: 0.25, shadowRadius: 12, shadowOffset: { width: 0, height: 6 }, elevation: 4 }, pressed && { transform: [{ scale: 0.97 }] }]}>
        <Text style={{ fontSize: 52 * ts, fontWeight: '800', lineHeight: 58 * ts, color: GC[x] }}>{x}</Text>
        <Text style={{ fontSize: 12.5 * ts, color: C.text2 }}>{`${fmtMoney(S.schedule.rates[x])}/kg`}</Text>
        {sel ? <View style={{ position: 'absolute', top: 8, right: 8 }}><Icon n="check" s={20} c={GC[x]} w={3} /></View> : null}
      </Pressable>
    );
  };
  const targetCard = (c) => {
    const sel = tg === c.type;
    return (
      <Pressable key={c.type} onPress={() => act('ovTarget', c.type)} accessibilityRole="button" accessibilityLabel={`Override ${TYPES[c.type].name}`}
        style={({ pressed }) => [{ flex: 1, minHeight: 112, borderRadius: 22, borderWidth: 3, borderColor: sel ? C.primary : C.border, backgroundColor: sel ? '#EEF4FF' : C.surface, padding: 12, alignItems: 'center', justifyContent: 'center', gap: 4 }, pressed && { transform: [{ scale: 0.98 }] }]}>
        <SampleIcon type={c.type} size={72} />
        <Text style={{ fontSize: 15 * ts, fontWeight: '800', color: C.navy }}>{TYPES[c.type].name}</Text>
        <Text style={{ fontSize: 12.5 * ts, color: C.text2, textAlign: 'center' }}>{c.overridden ? `Overridden to ${c.label}` : capText(c)}</Text>
        {sel ? <View style={{ position: 'absolute', top: 8, right: 8 }}><Icon n="check" s={20} c={C.primary} w={3} /></View> : null}
      </Pressable>
    );
  };
  return (
    <Shell idx={6} left={[backBtn('cancelOverride'), helpBtn()]}
      right={[has ? B('Remove override', 'clearOverride', '', 'small danger', false, 'x') : null, B('Apply override', 'applyOverride', '', 'primary', !ok, 'check')]}>
      <View style={[BODY, { gap: 16 }]}>
        <Txt k="title" style={{ fontSize: 32, paddingTop: 6, textAlign: 'center' }}>Manual override</Txt>
        {two ? (
          <View style={{ gap: 8 }}>
            <Txt k="h2">Which sample?</Txt>
            <View style={{ flexDirection: 'row', gap: 10 }}>{ecaps.map(targetCard)}</View>
            <Pressable onPress={() => act('ovTarget', 'all')} accessibilityRole="button"
              style={({ pressed }) => [{ minHeight: 52, borderRadius: 20, borderWidth: 3, borderColor: tg === 'all' ? C.primary : C.border, backgroundColor: tg === 'all' ? '#EEF4FF' : C.surface, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 }, pressed && { transform: [{ scale: 0.98 }] }]}>
              {tg === 'all' ? <Icon n="check" s={20} c={C.primary} w={3} /> : null}
              <Text style={{ fontSize: 15 * ts, fontWeight: '700', color: C.navy, flexShrink: 1, textAlign: 'center' }}>Set the final grade for both samples</Text>
            </Pressable>
            {!tg ? <Txt k="det" style={{ textAlign: 'center' }}>Pick a sample to continue.</Txt> : null}
          </View>
        ) : null}
        <Card style={{ gap: 4 }}>
          <Txt k="label">Model result</Txt>
          {shown.map((c) => (
            <Text key={c.id} style={{ fontSize: 16 * ts, color: C.navy }}>
              <Text style={{ fontWeight: '700' }}>{TYPES[c.type].name}: </Text>
              {c.overridden ? `Overridden to Grade ${c.label} (model: ${capText(c.raw)})` : capText(c)}
            </Text>
          ))}
        </Card>
        <View style={{ gap: 8 }}>
          <Txt k="h2">{two && tg && tg !== 'all' ? `Your grade for ${TYPES[tg].name}` : 'Your grade'}</Txt>
          <View style={{ flexDirection: 'row', gap: 10 }}>{['A', 'B', 'C'].map(tile)}</View>
          {hyp && hyp.ok ? chip(`New estimate ${fmtMoney(hyp.total)}`, 'info', 'tag', { alignSelf: 'center', marginTop: 4 }) : null}
          {hyp && !hyp.ok ? chip(hyp.kind === 'grade' ? 'The samples would still disagree. Override the other sample too.' : hyp.why, 'amber', 'warn', { alignSelf: 'center', marginTop: 4 }) : null}
        </View>
        <View style={{ gap: 8 }}>
          <Txt k="h2">Supervisor PIN</Txt>
          <TextInput
            value={S.ui.ovPin}
            onChangeText={(v) => { S.ui.ovPin = v.replace(/\D/g, '').slice(0, 4); S.ui.ovPinError = ''; render(); }}
            placeholder="4-digit PIN (e.g. 1234 or 2468)"
            placeholderTextColor={C.text2}
            keyboardType="number-pad"
            secureTextEntry
            maxLength={4}
            style={[st.field, { borderRadius: 14, minHeight: 50 }]}
          />
          {S.ui.ovPinError ? <Text style={{ color: C.err, fontSize: 13 }}>{S.ui.ovPinError}</Text> : null}
        </View>
        <View style={{ gap: 8 }}>
          <Txt k="h2">Why are you overriding?</Txt>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {QUICK_REASONS.map((t) => {
              const on = S.ui.ovReason === t;
              return (
                <Pressable key={t} onPress={() => act('ovReasonPick', t)} style={{ minHeight: 40, paddingHorizontal: 14, borderRadius: 20, borderWidth: 2, borderColor: on ? C.primary : C.border, backgroundColor: on ? '#E4ECFC' : C.surface, justifyContent: 'center' }}>
                  <Text style={{ fontSize: 14 * ts, fontWeight: '600', color: on ? C.primaryPress : C.navy }}>{t}</Text>
                </Pressable>
              );
            })}
          </View>
          <TextInput style={[st.field, { minHeight: 90, paddingVertical: 12, paddingHorizontal: 16, borderRadius: 24, textAlignVertical: 'top', lineHeight: 22 }]} multiline
            placeholder="Pick one above or write your own (5+ characters)" placeholderTextColor="#8A99AB" value={S.ui.ovReason} onChangeText={(v) => { S.ui.ovReason = v; render(); }} />
        </View>
        <Pressable onPress={() => act('ovAck')} accessibilityRole="checkbox" accessibilityState={{ checked: S.ui.ovAck }} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 4 }}>
          <View style={{ width: 30, height: 30, borderRadius: 9, borderWidth: 2, borderColor: S.ui.ovAck ? C.primary : C.border, backgroundColor: S.ui.ovAck ? C.primary : C.surface, alignItems: 'center', justifyContent: 'center' }}>
            {S.ui.ovAck ? <Icon n="check" s={20} c="#fff" w={3} /> : null}
          </View>
          <Txt k="sub" style={{ flex: 1 }}>I looked at the sample myself and stand by this grade.</Txt>
        </Pressable>
      </View>
    </Shell>
  );
};

/* ---------- on-screen receipt (new "TUNAEYE KIOSK" layout, lists every sample) ---------- */
function Paper({ r }) {
  const q = r.quote, lines = sampleLines(r), bc = barcodeBars(r.id);
  const M = { fontFamily: MONO, color: '#1a1a18' };
  const dash = <View style={{ borderTopWidth: 1, borderStyle: 'dashed', borderColor: '#B5B5AE', marginVertical: 14 }} />;
  const row = (l, rt, o = {}) => (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8, marginVertical: 5 }}>
      <Text style={[M, { fontSize: 14, color: o.boldL ? '#1a1a18' : '#6B6B66', fontWeight: o.boldL ? '700' : '400' }]}>{l}</Text>
      <Text style={[M, { fontSize: 14, fontWeight: o.bold ? '700' : '400', flexShrink: 1, textAlign: 'right' }]}>{rt}</Text>
    </View>
  );
  return (
    <View style={{ backgroundColor: '#FBFAF6', width: 320, paddingVertical: 26, paddingHorizontal: 28, borderRadius: 6, shadowColor: C.navy, shadowOpacity: 0.18, shadowRadius: 12, shadowOffset: { width: 0, height: 6 }, elevation: 4, overflow: 'visible' }}>
      {/* ticket notches */}
      <View style={{ position: 'absolute', left: -11, top: 150, width: 22, height: 22, borderRadius: 11, backgroundColor: C.canvas }} />
      <View style={{ position: 'absolute', right: -11, top: 150, width: 22, height: 22, borderRadius: 11, backgroundColor: C.canvas }} />

      <View style={{ alignItems: 'center' }}>
        <View style={{ width: 46, height: 46, borderRadius: 23, backgroundColor: '#ECEBE6', alignItems: 'center', justifyContent: 'center' }}><Icon n="home" s={24} c="#1a1a18" /></View>
        <Text style={[M, { fontSize: 22, fontWeight: '700', letterSpacing: 1, marginTop: 10 }]}>TUNAEYE KIOSK</Text>
        <Text style={[M, { fontSize: 13, color: '#6B6B66', marginTop: 4 }]}>Certified Quality Inspection</Text>
      </View>
      {dash}
      {row('ORDER NO:', `#${r.id}`, { bold: true })}
      {row('DATE:', fmtReceiptDate(q.confirmedAt))}
      {row('INSPECTOR:', r.grader || '—')}
      {dash}
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 }}>
        <Text style={[M, { fontSize: 12, fontWeight: '700', color: '#6B6B66' }]}>ITEM</Text>
        <Text style={[M, { fontSize: 12, fontWeight: '700', color: '#6B6B66' }]}>GRADE</Text>
      </View>
      {lines.map((l, i) => (
        <View key={i} style={{ marginBottom: 8 }}>
          {row(l.name, `Grade ${l.grade}`, { boldL: true, bold: true })}
          <Text style={[M, { fontSize: 12, fontStyle: 'italic', color: '#6B6B66', marginTop: -2 }]}>{l.note}</Text>
        </View>
      ))}
      {row('Weight (manual)', fmtKg(q.weightTenths), { bold: true })}
      {row('Rate', `${fmtMoney(q.rateC)}/kg`)}
      {row('Estimate', fmtMoney(q.totalC), { bold: true })}
      <View style={{ borderTopWidth: 1, borderColor: '#D5D5CE', marginTop: 10 }} />
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginVertical: 12 }}>
        <Text style={[M, { fontSize: 20, fontWeight: '700' }]}>TOTAL:</Text>
        <Text style={[M, { fontSize: 22, fontWeight: '700' }]}>{`Grade ${r.final.grade}`}</Text>
      </View>
      <Text style={[M, { fontSize: 12, fontStyle: 'italic', color: '#6B6B66' }]}>{r.final.basis}</Text>
      {dash}
      <View style={{ alignItems: 'center', gap: 8 }}>
        <Svg width="100%" height={56} viewBox={`0 0 ${bc.width} 40`} preserveAspectRatio="none">
          {bc.bars.map((b, i) => <Rect key={i} x={b.x} y={0} width={b.w} height={40} fill="#4A4A46" />)}
        </Svg>
        <Text style={[M, { fontSize: 12, color: '#6B6B66', letterSpacing: 1 }]}>{`* ${r.id} *`}</Text>
      </View>
      <Text style={[M, { fontSize: 13, textAlign: 'center', marginTop: 16 }]}>Thank you for using TunaEye Kiosk!</Text>
      <Text style={[M, { fontSize: 11, textAlign: 'center', color: '#9B9B95', marginTop: 6 }]}>{'Decision-support estimate.\nNot a payment record.'}</Text>
    </View>
  );
}
screens.receipt = () => {
  const s = S.session, r = S.records.find((x) => x.id === s.recordId), pr = S.print;
  const sending = pr && pr.state === 'sending', sent = pr && pr.state === 'sent';
  const g = r.final?.grade || 'B', q = r.quote;
  const heroBg = GRADE_HERO[g] || C.primary;
  return (
    <Shell idx={6} left={[helpBtn()]}
      right={[
        B('Print receipt', 'print', '', 'primary', sending, 'print'),
        B('Skip', 'skipReceipt', '', '', sending),
        B('Done', 'doneReceipt', '', 'ghost', sending),
      ]}>
      <View style={[BODY, { gap: 12, paddingBottom: 16 }]}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <Txt k="title" style={{ fontSize: 28 }}>Print receipt</Txt>
          {chip(`Order ${r.id}`, 'ok')}
        </View>
        {q ? (
          <View style={{ backgroundColor: heroBg, borderRadius: 22, padding: 16, gap: 10 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <View style={{ width: 48, height: 48, borderRadius: 14, backgroundColor: 'rgba(255,255,255,0.22)', alignItems: 'center', justifyContent: 'center' }}>
                <Text style={{ fontSize: 26, fontWeight: '800', color: '#fff' }}>{g}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 12, color: 'rgba(255,255,255,0.85)', fontWeight: '600' }}>Total value</Text>
                <Text style={{ fontSize: 26, fontWeight: '800', color: '#fff' }}>{fmtMoney(q.totalC)}</Text>
              </View>
            </View>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.16)', borderRadius: 10, padding: 8 }}>
                <Text style={{ fontSize: 10.5, color: 'rgba(255,255,255,0.75)' }}>Weight</Text>
                <Text style={{ fontSize: 13, fontWeight: '700', color: '#fff' }}>{fmtKg(r.weightTenths)}</Text>
              </View>
              <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.16)', borderRadius: 10, padding: 8 }}>
                <Text style={{ fontSize: 10.5, color: 'rgba(255,255,255,0.75)' }}>Rate</Text>
                <Text style={{ fontSize: 13, fontWeight: '700', color: '#fff' }}>{fmtMoney(q.rateC).replace('.00', '') + '/kg'}</Text>
              </View>
              <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.16)', borderRadius: 10, padding: 8 }}>
                <Text style={{ fontSize: 10.5, color: 'rgba(255,255,255,0.75)' }}>Grade</Text>
                <Text style={{ fontSize: 13, fontWeight: '700', color: '#fff' }}>{g}</Text>
              </View>
            </View>
          </View>
        ) : null}
        <View style={{ alignItems: 'center', justifyContent: 'center' }}>
          <View style={{ transform: [{ scale: 0.92 }] }}>
            <Paper r={r} />
          </View>
        </View>
        <View style={{ alignItems: 'center', gap: 8 }}>
          {sending ? <><Spin /><Txt k="sub">Sending to printer…</Txt></> : null}
          {sent ? chip('Receipt printed', 'ok', 'check', { alignSelf: 'center' }) : null}
          {S.receiptSaved ? chip('Receipt copy ready', 'ok', 'gallery', { alignSelf: 'center' }) : null}
          {pr && pr.state === 'error' ? chip('Print failed — try again', 'err', 'x', { alignSelf: 'center' }) : null}
        </View>
      </View>
      {S.skipReceiptModal ? (
        <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(15,27,43,0.48)', alignItems: 'center', justifyContent: 'center', padding: 20, zIndex: 60 }}>
          <Card lift style={{ width: '100%', maxWidth: 400, gap: 14, padding: 22, borderRadius: 24 }}>
            <Txt k="h1" style={{ fontSize: 22 }}>Skip printing?</Txt>
            <Txt k="sub">The record remains saved locally.</Txt>
            <View style={{ flexDirection: 'row', gap: 10 }}>
              {B('Cancel', 'cancelSkipReceipt', '', '', false, '', { flex: 1 })}
              {B('Skip & finish', 'confirmSkipReceipt', '', 'primary', false, 'arrow', { flex: 1 })}
            </View>
          </Card>
        </View>
      ) : null}
    </Shell>
  );
};

screens.history = () => {
  const sel = S.ui.histSel ? S.records.find((r) => r.id === S.ui.histSel) : null;
  if (sel) return histDetail(sel);
  const graderName = S.lastGrader || S.session?.grader || '';
  const scope = S.ui.histScope || 'mine';
  const allList = getDashboardHistory(S.records, graderName, scope);
  const pageSize = 8;
  const pageCount = Math.max(1, Math.ceil(allList.length / pageSize));
  const page = Math.min(S.ui.histPage || 0, pageCount - 1);
  const list = allList.slice(page * pageSize, (page + 1) * pageSize);
  const c = counts(), pend = c.pending + c.failed;
  return (
    <Shell idx={0} left={[backBtn('go', 'welcome'), helpBtn()]}>
      <View style={[BODY, { gap: 12, justifyContent: 'flex-start', paddingTop: 8 }]}>
        <View style={{ backgroundColor: C.hero, borderRadius: 24, padding: 18, gap: 12, shadowColor: C.hero, shadowOpacity: 0.2, shadowRadius: 14, shadowOffset: { width: 0, height: 6 }, elevation: 5 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: 'rgba(255,255,255,0.16)', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999 }}>
              <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: '#5BE3A3' }} />
              <Text style={{ fontSize: 11.5, fontWeight: '700', color: '#fff' }}>TunaEye Station 01</Text>
            </View>
          </View>
          <View>
            <Text style={{ fontSize: 13, color: 'rgba(255,255,255,0.82)' }}>Welcome back,</Text>
            <Text style={{ fontSize: 28, fontWeight: '800', color: '#fff' }}>{graderName || 'Grader'}</Text>
          </View>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {B('Start grading', 'start', '', '', false, 'arrow', { flex: 1, backgroundColor: '#fff', borderColor: '#fff' })}
            {B(pend ? `Sync (${pend})` : 'Sync', 'goSync', '', '', false, 'refresh', { backgroundColor: '#EEF4FF', borderColor: '#EEF4FF' })}
          </View>
        </View>

        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Stat v={allList.length} l="Records" />
          <Stat v={S.net === 'online' ? 'Online' : 'Offline'} l="Status" k={S.net === 'online' ? C.gA : C.amber} />
        </View>

        <View style={{ flexDirection: 'row', gap: 8, justifyContent: 'center' }}>
          {B('My records', 'histScope', 'mine', scope === 'mine' ? 'primary' : '', false, '', { flex: 1 })}
          {B('All device records', 'histScope', 'all', scope === 'all' ? 'primary' : '', false, '', { flex: 1 })}
        </View>
        {list.length ? list.map((r) => <HistRow key={r.id} r={r} />) : (
          <Card style={{ alignItems: 'center', gap: 10, padding: 36 }}>
            <Icon n="list" s={44} c="#7FA6D1" />
            <Txt k="h2">No records yet</Txt>
            <Txt k="sub" style={{ textAlign: 'center' }}>{scope === 'mine' ? 'Your completed gradings will appear here.' : 'Finished gradings will show up here.'}</Txt>
          </Card>
        )}
        {pageCount > 1 ? (
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
            {B('Prev', 'histPrev', '', '', page === 0)}
            <Txt k="det">{`Page ${page + 1} of ${pageCount}`}</Txt>
            {B('Next', 'histNext', '', '', page >= pageCount - 1)}
          </View>
        ) : null}
      </View>
    </Shell>
  );
};

function histDetail(r) {
  const f = r.final, q = r.quote, caps = effCaps(r), ts = TS();
  const g = f.status === 'final' ? f.grade : null;
  const rows = [
    ['Record', r.id],
    ['Date', fmtTime(r.createdAt)],
    ['Graded by', r.grader || '—'],
    ['Weight', fmtKg(r.weightTenths)],
  ];
  if (q) { rows.push(['Rate', `${fmtMoney(q.rateC)}/kg`]); rows.push(['Estimate', fmtMoney(q.totalC)]); }
  rows.push(['Basis', f.status === 'final' ? f.basis : f.reason || 'Unresolved']);
  rows.push(['Status', syncLabel(r)]);
  return (
    <Shell idx={0} left={[backBtn('closeHist'), helpBtn()]}
      right={[q ? B('Print receipt', 'reprintRec', r.id, 'primary', false, 'print') : null]}>
      <View style={[BODY, { gap: 12, justifyContent: 'flex-start', paddingTop: 12 }]}>
        <Card lift style={{ alignItems: 'center', gap: 2, paddingVertical: 20, backgroundColor: g ? GBG[g] : C.amberbg }}>
          <Txt k="label">{g ? 'Final grade' : 'Not graded yet'}</Txt>
          <Text style={{ fontSize: 72 * ts, fontWeight: '800', lineHeight: 78 * ts, color: g ? GC[g] : C.amber }}>{g || '—'}</Text>
          {q ? <Txt k="h2" style={{ color: g ? GC[g] : C.navy }}>{fmtMoney(q.totalC)}</Txt> : null}
        </Card>
        {caps.map((c) => (
          <Card key={c.id} style={{ gap: 12 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
              <Txt k="h2">{TYPES[c.type].name}</Txt>
              {c.overridden ? chip('Overridden', 'amber', 'edit') : c.outcome === 'accepted' ? chip(`Grade ${c.label}`, gcls(c.label)) : chip(c.outcome === 'uncertain' ? 'Uncertain' : 'Rejected', 'amber', 'warn')}
            </View>
            <ImgFrame style={{ width: '100%', height: 190 }}>{imgFor(c)}</ImgFrame>
            <Txt k="det">{c.overridden ? `Manual override (model: ${capText(c.raw)})` : capText(c)}</Txt>
          </Card>
        ))}
        <Card><View>{infoRows(rows)}</View></Card>
      </View>
    </Shell>
  );
}

screens.completion = () => {
  const s = S.session, r = S.records.find((x) => x.id === s.recordId), q = r.quote;
  const g = r.final?.grade || 'B', heroBg = GRADE_HERO[g] || C.primary;
  return (
    <Bare>
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 18, paddingHorizontal: 22 }}>
        <View style={{ width: 80, height: 80, borderRadius: 40, backgroundColor: C.gAbg, borderWidth: 2, borderColor: C.gA, alignItems: 'center', justifyContent: 'center' }}>
          <Icon n="check" s={44} c={C.gA} w={3} />
        </View>
        <Txt k="title" style={{ fontSize: 32, lineHeight: 36, textAlign: 'center' }}>Results recorded.</Txt>
        <View style={{ width: '100%', maxWidth: 380, backgroundColor: heroBg, borderRadius: 20, padding: 16, flexDirection: 'row', alignItems: 'center', gap: 14, shadowColor: heroBg, shadowOpacity: 0.25, shadowRadius: 12, shadowOffset: { width: 0, height: 6 }, elevation: 5 }}>
          <View style={{ width: 48, height: 48, borderRadius: 14, backgroundColor: 'rgba(255,255,255,0.22)', alignItems: 'center', justifyContent: 'center' }}>
            <Text style={{ fontSize: 26, fontWeight: '800', color: '#fff' }}>{g}</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 24, fontWeight: '800', color: '#fff' }}>{q ? fmtMoney(q.totalC) : `Grade ${g}`}</Text>
            <Text style={{ fontSize: 12.5, color: 'rgba(255,255,255,0.88)', fontWeight: '600' }}>{`${fmtKg(r.weightTenths)} · ${r.id} · ${syncLabel(r)}`}</Text>
          </View>
        </View>
        <View style={{ gap: 12, marginTop: 6, width: '100%', maxWidth: 380 }}>
          {B(`Grade another (${S.countdown})`, 'another', '', 'primary', false, 'arrow')}
          <Txt k="det" style={{ textAlign: 'center' }}>{S.paused ? 'Countdown paused' : `Starting next fish automatically in ${S.countdown}s…`}</Txt>
          <View style={{ flexDirection: 'row', gap: 12 }}>{B('Stay', 'stay', '', '', '', '', { flex: 1 })}{B('Finish', 'finish', '', '', '', '', { flex: 1 })}</View>
        </View>
      </View>
    </Bare>
  );
};

/* ---------- staff ---------- */
screens.console = () => {
  const a = S.auth, c = counts(), adm = a && a.role === 'admin', ts = TS();
  const tile = (ic, t, sub, act2, arg, dis) => (
    <Pressable key={t} disabled={dis} onPress={() => act(act2, arg)} style={({ pressed }) => [st.tile, dis && { opacity: 0.45 }, pressed && { backgroundColor: '#F3F7FE' }]}>
      <Icon n={ic} s={38} c={C.primary} w={2} />
      <Text style={{ fontSize: 19 * ts, fontWeight: '700', color: C.navy }}>{t}</Text>
      <Text style={{ fontSize: 13.5 * ts, color: C.text2 }}>{sub}</Text>
    </Pressable>
  );
  return (
    <Shell idx={0} left={[B('Exit console', 'logout', '', 'ghost', false, 'back')]}>
      <View style={[BODY, { gap: 24 }]}>
        <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 16 }}>
          {chip(S.shift.open ? 'Shift open' : 'Shift closed', S.shift.open ? 'ok' : 'amber')}{chip(a.name, 'info', 'lock')}{cloudChip()}
          {chip(`Pending ${c.pending + c.failed}`, c.pending + c.failed ? 'amber' : 'ok')}
        </View>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
          {tile('list', 'Records', 'Review saved results', 'go', 'records')}
          {tile('pulse', 'Diagnostics', 'Hardware and link status', 'go', 'diag', !adm)}
          {tile('tag', 'Pricing cache', 'Rates used on this device', 'go', 'pricing', !adm)}
          {tile('refresh', 'Sync', 'Upload pending results', 'go', 'sync')}
          {tile('gear', 'Settings', 'Text size and shift', 'go', 'settings', !adm)}
          {tile('out', 'Log out', 'Clear staff access', 'logout')}
        </View>
      </View>
    </Shell>
  );
};

function recList() {
  let rs = S.records.slice(); const q = S.ui.recSearch.trim().toLowerCase();
  if (q) rs = rs.filter((r) => r.id.toLowerCase().includes(q));
  if (S.ui.recFilter === 'pending') rs = rs.filter((r) => r.sync !== 'synced');
  if (S.ui.recFilter === 'review') rs = rs.filter((r) => r.final.status !== 'final');
  if (!rs.length) return (
    <Card style={{ alignItems: 'center', gap: 12, padding: 48 }}><Icon n="list" s={44} c="#7FA6D1" /><Txt k="h2">No records match</Txt><Txt k="sub">Clear the search or choose All.</Txt></Card>
  );
  return rs.map((r) => {
    const f = r.final;
    return (
      <Pressable key={r.id} onPress={() => act('openRec', r.id)} style={({ pressed }) => [st.rowrec, pressed && { backgroundColor: '#F3F7FE' }]}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8, width: '100%' }}>
          <View style={{ flexShrink: 1 }}><Text style={{ fontWeight: '700', fontSize: 16 * TS(), color: C.navy }}>{r.id}</Text><Txt k="det">{fmtTime(r.createdAt)}</Txt></View>
          <View>{f.status === 'final' ? gradeChip(f.grade) : chip('Review pending', 'amber', 'warn')}</View>
        </View>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', width: '100%', gap: 8 }}>
          <Text style={{ fontSize: 16 * TS(), color: C.navy, flexShrink: 1 }}>{`${r.captures.map((c) => TYPES[c.type].short).join(' + ') || '—'} · ${fmtKg(r.weightTenths)}`}</Text>
          <Text style={{ fontWeight: '700', fontSize: 16 * TS(), color: C.navy }}>{r.quote ? fmtMoney(r.quote.totalC) : '—'}</Text>
        </View>
        <Txt k="det">{syncLabel(r)}</Txt>
      </Pressable>
    );
  });
}
function recordDetail(r) {
  const f = r.final, q = r.quote, ex = S.auth && S.auth.role === 'expert';
  const rows = [['Graded by', r.grader || '—']];
  r.captures.forEach((c) => rows.push([`${TYPES[c.type].name} · attempt ${c.attempt}`, c.outcome === 'accepted' ? `Grade ${c.label} · ${Math.round(c.score * 100)}%` : c.outcome === 'uncertain' ? `Uncertain · ${c.label}? ${Math.round(c.score * 100)}%` : 'Rejected input']));
  const withDet = (main, det) => <><Text style={{ fontSize: 16 * TS(), fontWeight: '600', color: C.navy, textAlign: 'right' }}>{main}</Text><Txt k="det" style={{ textAlign: 'right' }}>{det}</Txt></>;
  r.decisions.forEach((d) => rows.push([(d.manual ? 'Manual override' : 'Expert decision') + (d.target ? ' · ' + TYPES[d.target].short : ''), withDet(d.grade ? 'Grade ' + d.grade : 'Unresolved', `${d.reason}\n${d.actor} · ${fmtClock(d.ts)}`)]));
  rows.push(['Final grade', f.status === 'final' ? `Grade ${f.grade} · ${f.basis}` : 'Unresolved']);
  rows.push(['Weight (manual)', fmtKg(r.weightTenths)]);
  rows.push(['Quote', q ? withDet(fmtMoney(q.totalC), `${fmtKg(q.weightTenths)} × ${fmtMoney(q.rateC)}/kg · schedule v${q.scheduleVersion} · rev ${q.revision}`) : 'None yet']);
  rows.push(['Sync', syncLabel(r)]);
  rows.push(['Prints', r.prints.length ? r.prints.map((p) => `${p.kind}: ${p.result}`).join('\n') : 'None']);
  const needsReview = f.status !== 'final' && r.captures.some((c) => c.outcome !== 'rejected');
  return (
    <Shell idx={0} left={[backBtn('closeRec'), helpBtn()]}
      right={[needsReview && ex ? B('Expert review', 'reviewRecord', r.id, '', '', 'lock') : needsReview ? <Note text="Review needs an expert sign-in" /> : null, q ? B('Reprint copy', 'reprintRec', r.id, 'primary', false, 'print') : null]}>
      <View style={[BODY, { paddingBottom: 8, gap: 10 }]}>
        <View style={{ gap: 16 }}>{r.captures.map((c, i) => <ImgFrame key={i} style={{ width: '100%', height: r.captures.length > 1 ? 150 : 200 }}>{imgFor(c)}</ImgFrame>)}</View>
        <Card>
          <Txt k="h2" style={{ marginBottom: 4 }}>{r.id}</Txt>
          <Txt k="det">{`${fmtTime(r.createdAt)} · ${r.device}`}</Txt>
          <View style={{ marginTop: 8 }}>{rows.map((x, i) => <KV key={i} l={x[0]} r={x[1]} last={i === rows.length - 1} />)}</View>
        </Card>
      </View>
    </Shell>
  );
}
screens.records = () => {
  const sel = S.ui.recSel ? S.records.find((r) => r.id === S.ui.recSel) : null;
  if (sel) return recordDetail(sel);
  return (
    <Shell idx={0} left={[backBtn('go', 'console'), helpBtn()]}>
      <View style={[BODY, { gap: 16 }]}>
        <View style={{ gap: 16 }}>
          <TextInput style={st.field} placeholder="Search by record ID" placeholderTextColor="#8A99AB" value={S.ui.recSearch} onChangeText={(v) => { S.ui.recSearch = v; render(); }} autoCapitalize="characters" autoCorrect={false} />
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {[['all', 'All'], ['pending', 'Not uploaded'], ['review', 'Needs review']].map((f) => (
              <View key={f[0]} style={{ flex: 1 }}>{B(f[1], 'recFilter', f[0], 'small' + (S.ui.recFilter === f[0] ? ' primary' : ''), false, '', { paddingHorizontal: 8 })}</View>
            ))}
          </View>
        </View>
        <View style={{ gap: 8 }}>{recList()}</View>
      </View>
    </Shell>
  );
};

screens.expert = () => {
  const ctx = S.ui.expertCtx; const src = ctx.kind === 'record' ? S.records.find((r) => r.id === ctx.id) : S.session;
  const caps = src.captures; const g = S.ui.reviewGrade, reason = S.ui.reviewReason.trim(); const ok = g && reason.length >= 5;
  const opts = [['A', 'Grade A'], ['B', 'Grade B'], ['C', 'Grade C'], ['U', 'Leave unresolved']];
  return (
    <Shell idx={0} left={[B('Cancel', 'cancelReview', '', 'ghost', false, 'x')]} right={[S.ui.reviewReason.length && reason.length < 5 ? <Note text="A reason is required" /> : null, B('Apply decision', 'applyReview', '', 'primary', !ok, 'check')]}>
      <View style={[BODY, { paddingBottom: 8, gap: 10 }]}>
        <Card style={{ gap: 16 }}>
          <Txt k="h2">Original model output</Txt>
          {caps.map((c, i) => (
            <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: 16 }}>
              <ImgFrame style={{ width: 110, height: 82 }}>{imgFor(c)}</ImgFrame>
              <View style={{ flex: 1 }}>
                <Text style={{ fontWeight: '700', fontSize: 16 * TS(), color: C.navy }}>{TYPES[c.type].name}</Text>
                <Txt k="sub">{c.outcome === 'accepted' ? `Grade ${c.label} · ${Math.round(c.score * 100)}%` : c.outcome === 'uncertain' ? `Uncertain · closest ${c.label}, ${Math.round(c.score * 100)}%` : 'Rejected input'}</Txt>
              </View>
            </View>
          ))}
          <Txt k="det">Your decision is added to the record. The original model output is never changed.</Txt>
        </Card>
        <View style={{ gap: 16 }}>
          <Txt k="h2">Final commercial grade</Txt>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 16 }}>
            {opts.map((o) => (
              <Pressable key={o[0]} onPress={() => act('revGrade', o[0])} style={[st.opt, g === o[0] && { borderColor: C.primary, backgroundColor: '#F3F7FE' }]}>
                <Text style={{ fontSize: 26, fontWeight: '700', width: 32, color: o[0] === 'U' ? C.navy : GC[o[0]] }}>{o[0] === 'U' ? '—' : o[0]}</Text>
                <Text style={{ fontSize: 18 * TS(), fontWeight: '600', color: C.navy, flexShrink: 1 }}>{o[1]}</Text>
              </Pressable>
            ))}
          </View>
          <Txt k="label">Reason (required)</Txt>
          <TextInput style={[st.field, { minHeight: 110, paddingVertical: 14, paddingHorizontal: 16, textAlignVertical: 'top', lineHeight: 24 }]} multiline placeholder="Why this grade?" placeholderTextColor="#8A99AB" value={S.ui.reviewReason} onChangeText={(v) => { S.ui.reviewReason = v; render(); }} />
          <KV l="Reviewer" r={S.auth.name} last />
        </View>
      </View>
    </Shell>
  );
};

screens.sync = () => {
  const c = counts(), sy = S.syncing; const queue = S.records.filter((r) => r.sync !== 'local');
  const conn = S.net === 'online' ? chip('Cloud reachable', 'ok', 'cloud') : S.net === 'wifi' ? chip('Wi-Fi connected, no cloud access', 'amber', 'cloudoff') : chip('Offline', 'amber', 'cloudoff');
  const rows = queue.length ? queue.map((r) => {
    const k = r.sync === 'synced' ? 'ok' : r.sync === 'failed' ? 'err' : r.sync === 'syncing' ? 'info' : 'amber';
    const pct = r.sync === 'syncing' ? ({ 'Signing in': 10, 'Uploading image': 35, 'Saving record': 65, Verifying: 90 }[r.stage] || 20) : r.sync === 'synced' ? 100 : r.sync === 'failed' ? 60 : 0;
    return (
      <Card key={r.id} style={{ paddingVertical: 14, paddingHorizontal: 16, gap: 12 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 16 }}>
          <View style={{ flex: 1 }}><Text style={{ fontWeight: '700', fontSize: 16 * TS(), color: C.navy }}>{r.id}</Text><Txt k="det">{(r.offlineOrigin ? 'Created offline' : 'Created online') + (r.stage ? ' · ' + r.stage : '') + (r.sync === 'failed' && r.lastSyncError ? ' · ' + r.lastSyncError : '')}</Txt></View>
          {chip({ pending: 'Pending', syncing: 'Syncing', synced: 'Uploaded', failed: 'Failed' }[r.sync], k)}
        </View>
        <View style={{ height: 10, borderRadius: 5, backgroundColor: C.border, overflow: 'hidden' }}><View style={{ height: '100%', width: `${pct}%`, backgroundColor: C.primary }} /></View>
      </Card>
    );
  }) : <Card style={{ alignItems: 'center', gap: 8, padding: 40 }}><Icon n="check" s={44} c={C.gA} /><Txt k="h2">Nothing to upload</Txt><Txt k="sub">New results appear here after they are saved.</Txt></Card>;
  return (
    <Shell idx={0} left={[backBtn('go', S.auth ? 'console' : 'welcome'), helpBtn()]}
      right={[c.failed ? B('Retry failed', 'retryFailed', '', '', !cloudOk() || sy.active) : null, B('Sync now', 'syncNow', '', 'primary', !cloudOk() || sy.active || !(c.pending + c.failed), 'refresh')]}>
      <View style={[BODY, { gap: 16 }]}>
        <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 16 }}>
          {conn}{chip('Pending ' + c.pending, c.pending ? 'amber' : 'ok')}{chip('Failed ' + c.failed, c.failed ? 'err' : '')}{chip('Uploaded ' + c.synced, 'ok')}
          <Txt k="det">{`Last confirmed upload: ${S.lastAck ? fmtTime(S.lastAck) : 'none yet'}`}</Txt>
        </View>
        {sy.active ? <Card style={{ flexDirection: 'row', alignItems: 'center', gap: 16 }}><Spin size={32} bw={4} /><Text style={{ fontWeight: '700', fontSize: 16, color: C.navy }}>{`Uploading ${Math.min(sy.done + 1, sy.total)} of ${sy.total}`}</Text></Card> : null}
        <View style={{ gap: 8 }}>{rows}</View>
      </View>
    </Shell>
  );
};

screens.diag = () => {
  const row = (n, stt, k, test, last) => (
    <View key={n} style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 16, paddingVertical: 12, borderBottomWidth: last ? 0 : 1, borderBottomColor: C.border }}>
      <Text style={{ fontSize: 16 * TS(), color: C.text2 }}>{n}</Text>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 16, flexShrink: 1 }}>{chip(stt, k)}{test ? B('Test', 'test', n, 'small') : null}</View>
    </View>
  );
  return (
    <Shell idx={0} left={[backBtn('go', 'console'), helpBtn()]}>
      <Card style={{ marginTop: 8, marginBottom: 16 }}>
        <Txt k="h2" style={{ marginBottom: 8 }}>Device status</Txt>
        {row('Phone camera', 'Scans the kiosk QR, views and photographs the sample', 'info', 1)}{row('Model', S.piStatus === 'connected' ? 'Raspberry Pi ready' : 'Check Raspberry Pi connection', S.piStatus === 'connected' ? 'ok' : 'amber')}{row('Storage', 'Writable (device memory)', 'info', 1)}
        {row('Raspberry Pi',
          S.piStatus === 'connected' ? `Connected (${S.piApiUrl})` : S.piStatus === 'connecting' ? 'Checking…' : S.piStatus === 'error' ? `Not reachable (${S.piApiUrl})` : `Not checked (${S.piApiUrl})`,
          S.piStatus === 'connected' ? 'ok' : S.piStatus === 'error' ? 'err' : 'amber', 0)}
        {B('Check Raspberry Pi', 'checkPi', '', 'small')}
        {row('Cloud', S.net === 'online' ? 'Reachable' : S.net === 'wifi' ? 'Wi-Fi only' : 'Offline', S.net === 'online' ? 'ok' : 'amber')}
        {row('Inter font', 'Not loaded · system sans in use', 'amber', 0, true)}
      </Card>
    </Shell>
  );
};

screens.pricing = () => {
  const sc = S.schedule;
  return (
    <Shell idx={0} left={[backBtn('go', 'console'), helpBtn()]}>
      <View style={[BODY, { paddingBottom: 8, gap: 10 }]}>
        <Card>
          <Txt k="h2" style={{ marginBottom: 8 }}>Rates on this device</Txt>
          {['A', 'B', 'C'].map((g, i) => <KV key={g} center l={gradeChip(g)} r={`${fmtMoney(sc.rates[g])} / kg`} last={i === 2} />)}
        </Card>
        <Card style={{ gap: 16 }}>
          <Txt k="h2">Schedule</Txt>
          <View>{infoRows([['Version', 'v' + sc.version], ['ID', sc.id], ['Effective', sc.effective], ['Valid until', sc.validUntil], ['Status', sc.expired ? 'Expired' : 'Approved (fixture)']])}</View>
          <Txt k="det">{`Updating rates never changes past records. ${sc.label}`}</Txt>
          {B('Refresh from cloud', 'refreshRates', '', 'primary', false, 'refresh')}
        </Card>
      </View>
    </Shell>
  );
};

screens.settings = () => (
  <Shell idx={0} left={[backBtn('go', 'console'), helpBtn()]}>
    <View style={[BODY, { paddingBottom: 8, gap: 10 }]}>
      <Card style={{ gap: 16 }}>
        <Txt k="h2">Display</Txt><Txt k="sub">Text size</Txt>
        <View style={{ flexDirection: 'row', gap: 16 }}>{B('Normal', 'textsize', 'n', S.ui.large ? '' : 'primary', '', '', { flex: 1 })}{B('Large', 'textsize', 'l', S.ui.large ? 'primary' : '', '', '', { flex: 1 })}</View>
        <Txt k="det">Large text is for checking layouts at higher text scaling.</Txt>
      </Card>
      <Card style={{ gap: 16 }}>
        <Txt k="h2">Raspberry Pi connection</Txt>
        <TextInput
          value={S.piUrlDraft}
          onChangeText={(v) => act('setPiUrlDraft', v)}
          placeholder="http://127.0.0.1:3000"
          placeholderTextColor={C.text2}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          style={{
            borderWidth: 1, borderColor: C.border, borderRadius: 12,
            paddingHorizontal: 14, paddingVertical: 11, fontSize: 15 * TS(),
            color: C.navy, backgroundColor: C.canvas, fontFamily: MONO,
          }}
        />
        {B('Save & test Raspberry Pi', 'savePiUrl', '', 'primary')}
      </Card>
      <Card style={{ gap: 16 }}>
        <Txt k="h2">Shift and limits</Txt>
        <View>{infoRows([['Shift', S.shift.open ? 'Open' : 'Closed'], ['Weight maximum', '200.0 kg (proposed)'], ['Weight precision', '0.1 kg'], ['Mode', 'Demo fixtures']])}</View>
        {S.shift.open ? B('Close shift', 'closeShift', '', 'danger') : B('Open shift', 'openShift', '', 'primary')}
      </Card>
    </View>
  </Shell>
);

/* ====================================================================== */
/* overlays                                                                */
/* ====================================================================== */
const HELP = {
  welcome: 'Press Start grading to begin. Have the fish weight from your scale ready.',
  weight: 'Read the weight from the external scale and type it in kilograms with your keyboard. Use one decimal place.',
  grader: "Type the grader's full name. It is saved on the record and printed on the receipt.",
  sample: 'Choose the type of sample you will place in the chamber. You can add the other type afterward.',
  align: 'The picture shows how the sample sits in the tray. Place the cut face up and inside the dashed outline, then tap Looks good.',
  pair: 'Point your phone camera at the QR code on the kiosk. Allow camera access if asked. Keep the code inside the corners.',
  onboarding: 'Use Next to step through the quick tour. You can replay it from the home screen with How it works.',
  camera: 'Allow camera access if asked, then tap Take photo. If the camera is not available, tap Upload image and choose a photo of the sample from your gallery.',
  review: 'Check the picture your phone took. Use it only if it is sharp and centered, or retake it.',
  result: 'The grade comes from color and clarity only. Check the estimated value, fix the weight if the reading was wrong, then tap Confirm. If the grade looks wrong, use Override grade.',
  invalid: 'Retake the image. If a sample keeps coming back uncertain, override the grade manually or ask an expert to review it.',
  paired: 'Each sample keeps its own result. If they disagree, override one sample yourself or have an expert choose the final grade.',
  price: 'The estimate is weight × the approved rate for the grade. Fix the weight if the reading was wrong.',
  override: 'With two samples, first pick which sample to override (or set the final grade for both). Then pick the grade and say why. The model result is kept on the record.',
  receipt: 'Print is optional. Your result is already saved.',
  records: 'Select a record to see its model output, review and price details.',
  history: 'Tap any tuna to see its grade, price, photos and who graded it.',
  sync: 'Sync now uploads results saved while offline. New results upload on their own when the cloud is reachable.',
  default: 'Ask a supervisor if you need help.',
};
function Overlay({ children }) {
  return <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(23,59,108,0.38)', alignItems: 'center', justifyContent: 'center', zIndex: 10 }]}>{children}</View>;
}
const dialogBox = { backgroundColor: '#fff', borderRadius: 28, padding: 24, width: '92%', maxWidth: 520, shadowColor: C.navy, shadowOpacity: 0.28, shadowRadius: 24, shadowOffset: { width: 0, height: 16 }, elevation: 12 };
function overlay() {
  if (S.login) {
    const L = S.login;
    const rows = [['1', '2', '3'], ['4', '5', '6'], ['7', '8', '9'], ['', '0', 'del']];
    return (
      <Overlay>
        <View style={[dialogBox, { alignItems: 'center', gap: 8 }]}>
          <Icon n="lock" s={44} c={C.primary} />
          <Txt k="h2">{L.intent === 'expert' ? 'Expert sign-in' : 'Staff sign-in'}</Txt>
          <Txt k="sub">{L.error ? <Text style={{ color: C.err }}>{L.error}</Text> : 'Enter your 4-digit PIN.'}</Txt>
          <View style={{ flexDirection: 'row', gap: 14, justifyContent: 'center', marginTop: 12, marginBottom: 18 }}>
            {[0, 1, 2, 3].map((i) => <View key={i} style={{ width: 22, height: 22, borderRadius: 11, borderWidth: 3, borderColor: C.primary, backgroundColor: i < L.pin.length ? C.primary : 'transparent' }} />)}
          </View>
          <View style={{ gap: 10, width: '100%' }}>
            {rows.map((r, i) => (
              <View key={i} style={{ flexDirection: 'row', gap: 10 }}>
                {r.map((k, j) => k === '' ? <View key={`spacer-${j}`} style={{ flex: 1 }} /> : (
                  <Pressable key={k} onPress={() => act('pinKey', k)} style={({ pressed }) => [st.key, pressed && { backgroundColor: '#E4ECFC', transform: [{ scale: 0.97 }] }]}>
                    {k === 'del' ? <Icon n="backspace" s={32} /> : <Text style={st.keyText}>{k}</Text>}
                  </Pressable>
                ))}
              </View>
            ))}
          </View>
          <View style={{ flexDirection: 'row', gap: 16, marginTop: 24, width: '100%' }}>
            {B('Cancel', 'loginCancel', '', '', '', '', { flex: 1 })}{B('Log in', 'loginGo', '', 'primary', L.pin.length !== 4, '', { flex: 1 })}
          </View>
        </View>
      </Overlay>
    );
  }
  if (S.dialog) {
    const d = S.dialog;
    return (
      <Overlay>
        <View style={dialogBox}>
          <Txt k="h2">{d.title}</Txt>
          <Txt style={{ marginTop: 12, color: C.text2 }}>{d.body}</Txt>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 20 }}>
            {d.acts.map((a, i) => <React.Fragment key={i}>{B(a.label, a.act, a.arg, a.kind || '', false, '', { flexBasis: '40%', flexGrow: 1 })}</React.Fragment>)}
          </View>
        </View>
      </Overlay>
    );
  }
  if (S.help) {
    return (
      <Overlay>
        <View style={dialogBox}>
          <Icon n="help" s={40} c={C.primary} />
          <Txt k="h2" style={{ marginTop: 8 }}>Help</Txt>
          <Txt style={{ marginTop: 12 }}>{HELP[S.screen] || HELP.default}</Txt>
          <View style={{ marginTop: 20 }}>{B('Got it', 'closeHelp', '', 'primary')}</View>
        </View>
      </Overlay>
    );
  }
  return null;
}

/* ====================================================================== */
/* demo bar + drawer                                                       */
/* ====================================================================== */
function DBtn({ label, on, onPress }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [st.dbtn, on && { backgroundColor: C.primary, borderColor: C.primary }, pressed && !on && { backgroundColor: 'rgba(37,99,235,0.08)' }]}>
      <Text style={{ fontSize: 13, fontWeight: '600', color: on ? '#fff' : C.chromeText }}>{label}</Text>
    </Pressable>
  );
}
function demoJump(scr) {
  S.drawer = false;
  S.demo.enabled = true;
  S.phoneLinked = true;
  S.piStatus = 'connected';
  S.kioskId = 'DEMO-01';
  if (scr === 'welcome' || scr === 'history') { go(scr); return; }
  if (!S.session) newSession();
  const s = S.session;
  s.phone = 'connected';
  if (!s.grader) { s.grader = 'Demo Grader'; S.lastGrader = 'Demo Grader'; }
  if (!s.weightTenths) { s.weightStr = '42.5'; s.weightTenths = 425; }
  if (['result', 'paired', 'override', 'receipt', 'completion'].includes(scr) && !s.captures.length) {
    s.captures.push({ id: uid(), type: 'core', outcome: 'uncertain', attempt: 1, ts: Date.now(), uri: null, code: 'UNC', label: 'C', score: 0.742, scores: { GRADE_A: 0.08, GRADE_B: 0.18, GRADE_C: 0.74, INVALID: 0 }, inferMs: 500 });
  }
  if (scr === 'paired' && s.captures.length < 2) {
    s.captures.push({ id: uid(), type: 'tail', outcome: 'accepted', attempt: 1, ts: Date.now(), uri: null, code: 'B', label: 'B', score: 0.914, scores: { GRADE_A: 0.06, GRADE_B: 0.91, GRADE_C: 0.03, INVALID: 0 }, inferMs: 500 });
  }
  if (scr === 'receipt' || scr === 'completion') {
    if (!s.quote) {
      const p = priceFor(s);
      const g = p.ok ? p.grade : 'B';
      const rate = S.schedule.rates[g];
      const r = persist(s);
      r.quote = { grade: g, rateC: rate, weightTenths: s.weightTenths, totalC: calcTotalCentavos(s.weightTenths, rate), scheduleVersion: S.schedule.version, scheduleId: S.schedule.id, revision: 1, confirmedAt: Date.now(), rounding: 'half-up to centavo' };
      r.closed = true;
      s.quote = r.quote;
    }
  }
  go(scr);
}
function demoAct(d) {
  const [k, v] = d.split(':'); const D = S.demo;
  if (k === 'close') { S.drawer = false; render(); return; }
  if (k === 'mode') { A.toggleDemoMode(); return; }
  if (k === 'jump') { demoJump(v); return; }
  if (k === 'net') { const was = S.net; S.net = v; if (v === 'online' && was !== 'online') { S.toast = { msg: 'Checking cloud access…' }; render(); setTimeout(() => { S.toast = null; render(); }, 900); } }
  else if (k === 'next') { D.next = v; D.queue = []; }
  else if (k === 'q') D.queue = v.split(',');
  else if (k === 'qual') D.quality = v;
  else if (k === 'pr') D.printer = D.printer === v ? 'ok' : v;
  else if (k === 'timeout') D.timeoutOnce = !D.timeoutOnce;
  else if (k === 'cloudfail') D.cloudFailNext = D.cloudFailNext > 0 ? 0 : 1;
  else if (k === 'sch') S.schedule.expired = v === 'exp';
  else if (k === 'su') D.startupFault = v;
  else if (k === 'tips') { S.tips = true; S.coached = {}; }
  else if (k === 'onb') { S.drawer = false; S.onbStep = 0; go('onboarding'); return; }
  else if (k === 'rerun') { clearPublicSession(); S.auth = null; S.login = null; S.dialog = null; S.drawer = false; runStartup(); return; }
  else if (k === 'reset') {
    clearTimers(); const real = S.records.filter((x) => !x.demo); S.records = []; S.counter = 7; seed(); S.records = isSupabaseConfigured() ? real : [...real, ...S.records];
    S.schedule = { ...S.schedule, version: 3, id: 'PS-DEMO-03', expired: false, validUntil: 'Oct 31, 2026' };
    S.demo = { queue: [], next: 'A', quality: 'ok', printer: 'ok', timeoutOnce: false, cloudFailNext: 0, startupFault: 'none' };
    S.net = 'online'; S.shift.open = true; S.phoneLinked = false; S.kioskId = ''; S.tips = true; S.coached = {};
    clearPublicSession(); S.auth = null; S.login = null; S.dialog = null; S.ui.recSel = null; go('welcome'); return;
  }
  render();
}
function Drawer() {
  const D = S.demo; const q0 = !D.queue.length;
  const b = (label, on, a) => <DBtn key={a + label} label={label} on={!!on} onPress={() => demoAct(a)} />;
  const h3 = (t) => <Text style={st.h3}>{t}</Text>;
  const grp = (items) => <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{items}</View>;
  const p = (t) => <Text style={st.dp}>{t}</Text>;
  return (
    <View style={{ position: 'absolute', top: 0, right: 0, bottom: 0, width: '88%', maxWidth: 340, backgroundColor: C.chromeBg, borderLeftWidth: 1, borderLeftColor: C.chromeBorder, zIndex: 20 }}>
      <ScrollView contentContainerStyle={{ padding: 16 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}><Text style={{ fontWeight: '700', fontSize: 14, color: C.chromeText }}>Demo controls</Text>{b('Close', 0, 'close')}</View>
        {p('Enable Demo mode to simulate Pi inference & camera, or jump to any screen.')}
        {h3('Demo mode')}{grp([b('Demo ON', D.enabled, 'mode:on'), b('Demo OFF (Live Pi)', !D.enabled, 'mode:off')])}
        {h3('Jump to screen')}{grp([
          ['welcome', 'Welcome'], ['grader', 'Grader'], ['weight', 'Weight'], ['tutorial', 'Tutorial'],
          ['pair', 'Connect'], ['camera', 'Camera'], ['result', 'Result'], ['paired', 'Final Combined'],
          ['override', 'Override'], ['receipt', 'Receipt'], ['completion', 'Completion'], ['history', 'Dashboard'],
        ].map(([scr, label]) => b(label, S.screen === scr, 'jump:' + scr)))}
        {h3('Connectivity')}{grp([b('Online', S.net === 'online', 'net:online'), b('Offline', S.net === 'offline', 'net:offline'), b('Wi-Fi, no cloud', S.net === 'wifi', 'net:wifi')])}
        {h3('Next capture result')}{grp([['A', 'Grade A'], ['B', 'Grade B'], ['C', 'Grade C'], ['UNC', 'Uncertain'], ['INV', 'Invalid']].map((x) => b(x[1], D.next === x[0] && q0, 'next:' + x[0])))}
        {h3('Scenario presets')}{grp([b('Paired agree (A, A)', 0, 'q:A,A'), b('Paired conflict (A, B)', 0, 'q:A,B'), b('Uncertain, then A', 0, 'q:UNC,A'), b('Invalid, then B', 0, 'q:INV,B')])}
        {p('Queued results: ' + (D.queue.length ? D.queue.join(', ') : 'none'))}
        {h3('Camera quality')}{grp([b('Sharp', D.quality === 'ok', 'qual:ok'), b('Out of focus', D.quality === 'blurry', 'qual:blurry')])}
        {h3('Faults (fire once)')}{grp([b('Printer fails', D.printer === 'fail', 'pr:fail'), b('Paper out', D.printer === 'paper', 'pr:paper'), b('Analysis timeout', D.timeoutOnce, 'timeout'), b('Cloud upload fails', D.cloudFailNext > 0, 'cloudfail')])}
        {h3('Pricing')}{grp([b('Schedule valid', !S.schedule.expired, 'sch:ok'), b('Schedule expired', S.schedule.expired, 'sch:exp')])}
        {h3('Startup')}{grp([b('Normal', D.startupFault === 'none', 'su:none'), b('Phone link fault', D.startupFault === 'camera', 'su:camera'), b('Model missing', D.startupFault === 'model', 'su:model'), b('Re-run startup', 0, 'rerun')])}
        {h3('Staff PINs (demo)')}{p("Administrator 1234 · Expert grader 2468. Admin can't decide grades.")}
        {h3('Data')}{grp([b('Replay onboarding', 0, 'onb'), b('Show tips again', 0, 'tips'), b('Reset all demo data', 0, 'reset')])}
      </ScrollView>
    </View>
  );
}

/* ====================================================================== */
/* app                                                                     */
/* ====================================================================== */
/** Load locally persisted records. Real records survive restarts; demo fixtures are never synced. */
async function hydrateRecords() {
  try {
    const savedPiUrl = normalizePiUrl(await AsyncStorage.getItem(PI_URL_STORAGE_KEY));
    if (savedPiUrl && /^https?:\/\//i.test(savedPiUrl)) {
      S.piApiUrl = savedPiUrl;
      S.piUrlDraft = savedPiUrl;
    }
  } catch { }
  const stored = await loadStoredRecords();
  for (const r of stored) if (!r.closed && r.captures.length && r.sync === 'local') { r.closed = true; r.sync = 'pending'; r.offlineOrigin = true; } // app was killed mid-session: keep the graded result
  const demo = isSupabaseConfigured() ? [] : S.records.filter((r) => r.demo);
  S.records = [...stored, ...demo].sort((a, b) => b.createdAt - a.createdAt);
}
export default function App() {
  const [, force] = useReducer((x) => x + 1, 0);
  rerender = force;
  useEffect(() => {
    let alive = true; let unsub = () => { };
    const netState = (st) => (!st.isConnected ? 'offline' : st.isInternetReachable === false ? 'wifi' : 'online');
    (async () => {
      await hydrateRecords();
      if (!alive) return;
      const st = await NetInfo.fetch().catch(() => null);
      if (st && alive) S.net = netState(st);
      runStartup();
      if (S.net === 'online') syncNow(); // pending records from earlier sessions
      unsub = NetInfo.addEventListener(async (next) => {
        const was = S.net; S.net = netState(next); render();
        if (S.net === 'online' && was !== 'online') {
          try {
            const queued = JSON.parse((await AsyncStorage.getItem(PENDING_SYNC_GRADERS_KEY)) || 'null');
            if (Array.isArray(queued) && queued.length) {
              syncPendingRecords({ limit: 200, graders: queued });
              return;
            }
          } catch { }
          syncNow(); // connectivity-triggered, not polling/Realtime
        }
      });
    })();
    return () => { alive = false; unsub(); clearTimers(); rerender = () => { }; };
  }, []);
  const fn = screens[S.screen];
  const hero = HERO_SCREENS.includes(S.screen);
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: hero ? C.hero : C.chromeBg, paddingTop: Platform.OS === 'android' ? StatusBar.currentHeight || 0 : 0 }}>
      <StatusBar barStyle={hero ? 'light-content' : 'dark-content'} backgroundColor={hero ? C.hero : C.chromeBg} />
      <KeyboardAvoidingView style={{ flex: 1, backgroundColor: C.canvas, overflow: 'hidden' }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Enter key={S.screen}>{fn ? fn() : null}</Enter>
        <CoachMark />
        {overlay()}
        {S.toast ? (
          <View pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, bottom: 170, alignItems: 'center', zIndex: 30 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: S.toast.kind === 'err' ? C.err : C.navy, borderRadius: 20, paddingVertical: 12, paddingHorizontal: 16, maxWidth: '88%', shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 12, shadowOffset: { width: 0, height: 6 }, elevation: 8 }}>
              <Icon n={S.toast.kind === 'err' ? 'warn' : 'check'} s={20} c="#fff" w={2.6} />
              <Text style={{ color: '#fff', fontSize: 15, fontWeight: S.toast.kind === 'err' ? '700' : '400', flexShrink: 1 }}>{S.toast.msg}</Text>
            </View>
          </View>
        ) : null}
        {S.drawer ? <Drawer /> : null}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

/* ====================================================================== */
/* static styles                                                           */
/* ====================================================================== */
const st = StyleSheet.create({
  key: { flex: 1, minHeight: 58, borderRadius: 16, borderWidth: 2, borderColor: C.border, backgroundColor: C.surface, alignItems: 'center', justifyContent: 'center' },
  keyText: { fontSize: 26, fontWeight: '600', color: C.navy },
  field: { minHeight: 54, fontSize: 17, borderRadius: 999, borderWidth: 2, borderColor: C.border, backgroundColor: C.surface, paddingHorizontal: 20, color: C.navy, width: '100%' },
  smallRow: { minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 14, borderRadius: 16, borderWidth: 2, borderColor: C.border, backgroundColor: C.surface },
  cardBtn: { flex: 1, borderWidth: 3, borderColor: C.border, backgroundColor: C.surface, borderRadius: 28, padding: 16, alignItems: 'center', justifyContent: 'center', gap: 8 },
  opt: { flexBasis: '45%', flexGrow: 1, flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: 3, borderColor: C.border, backgroundColor: C.surface, borderRadius: 20, minHeight: 58, paddingHorizontal: 14 },
  tile: { width: '48.5%', minHeight: 118, padding: 16, borderRadius: 24, gap: 6, backgroundColor: C.surface, borderWidth: 1, borderColor: C.border, alignItems: 'flex-start', justifyContent: 'center' },
  rowrec: { width: '100%', gap: 6, paddingVertical: 14, paddingHorizontal: 16, borderRadius: 22, backgroundColor: C.surface, borderWidth: 1, borderColor: C.border, alignItems: 'flex-start' },
  dbtn: { minHeight: 36, paddingHorizontal: 12, borderRadius: 12, borderWidth: 1, borderColor: C.chromeBorder, alignItems: 'center', justifyContent: 'center' },
  h3: { marginTop: 16, marginBottom: 8, fontSize: 14, fontWeight: '700', color: C.chromeText },
  dp: { color: C.chromeSub, marginVertical: 6, fontSize: 13, lineHeight: 18 },
});
