/**
 * Anti-cheat for phone-carried running speed.
 * GPS spike filter, cadence/tilt bounce, human cap, learned profile.
 * Peak speed prefers GPS+IMU sensor fusion when inertial axes are present.
 */

import { fuseSession } from "./sensor-fusion.js";

export const HUMAN_SPEED_CAP_KMH = 45;
/**
 * Official max speed = highest mean speed over a sliding window of this length.
 * ~1.5 s captures a sprint crest without requiring an unrealistically flat plateau.
 * Crest is only counted inside a longer run-like sustain (see MIN_RUN_SUSTAIN_MS).
 */
export const PEAK_WINDOW_MS = 1500;
/** @deprecated Use PEAK_WINDOW_MS — kept as alias for older callers/tests. */
export const SUSTAINED_PEAK_MS = PEAK_WINDOW_MS;
/**
 * Live speedometer + official metrics only use speed from a continuous run-like
 * stretch of at least this long (pocket or hand while actually running).
 */
export const MIN_RUN_SUSTAIN_MS = 3000;
/** Brief GPS/IMU glitches under this do not reset the sustain timer. */
export const RUN_SUSTAIN_GAP_MS = 900;
/** Minimum GPS/fused speed (km/h) that counts toward a run stretch. */
export const MIN_RUN_SPEED_KMH = 6;
/**
 * Drop GPS fixes worse than this (meters). Keep in sync with fusion /
 * probeGps (45) — a tighter peak-only cap (e.g. 40) zeros outdoor runs that
 * fusion already accepted at 41–45 m.
 */
export const MAX_GPS_ACCURACY_M = 45;
/** Minimum GPS speed (km/h) in the peak window to confirm a fused peak. */
export const MIN_GPS_CORRELATION_KMH = 6;
/** Below this, a finished run is not treated as a measurable (shareable) peak. */
export const MIN_RECORDABLE_KMH = 8;
/** Motion window used for live / sliding pattern checks. */
export const MOTION_PATTERN_WINDOW_MS = 3000;
/** Foot-cadence band (Hz) treated as running (jog → sprint). */
export const RUN_CADENCE_MIN_HZ = 1.5;
export const RUN_CADENCE_MAX_HZ = 4.6;
const MS_PER_HOUR = 3.6;

export function kmh(mpsVal) {
  return mpsVal * MS_PER_HOUR;
}

export function mps(kmhVal) {
  return kmhVal / MS_PER_HOUR;
}

export function highPass(values, window = 8) {
  if (!values.length) return [];
  const out = [];
  let acc = 0;
  const q = [];
  for (let i = 0; i < values.length; i++) {
    q.push(values[i]);
    acc += values[i];
    if (q.length > window) acc -= q.shift();
    const avg = acc / q.length;
    out.push(values[i] - avg);
  }
  return out;
}

export function peakRateHz(series, dt, threshold = 0.2) {
  if (!series?.length || !dt) return 0;
  let peaks = 0;
  for (let i = 1; i < series.length - 1; i++) {
    if (series[i] >= series[i - 1] && series[i] > series[i + 1] && series[i] > threshold) {
      peaks += 1;
    }
  }
  const duration = series.length * dt;
  return duration > 0 ? peaks / duration : 0;
}

function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((s, x) => s + x, 0) / arr.length;
}

function stddev(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(mean(arr.map((x) => (x - m) ** 2)));
}

function clamp(x, a, b) {
  return Math.max(a, Math.min(b, x));
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/**
 * Drop GPS samples that teleport or exceed a hard vehicle cap.
 * Input points: { t, speedKmh, accuracy? }
 */
export function filterGpsPoints(points, options = {}) {
  const maxAccuracy = options.maxAccuracy ?? MAX_GPS_ACCURACY_M;
  const maxJumpKmhPerSec = options.maxJumpKmhPerSec ?? 45;
  const hardCap = options.hardCap ?? 72;
  const sorted = [...(points || [])].sort((a, b) => a.t - b.t);
  const kept = [];
  for (const p of sorted) {
    if (!Number.isFinite(p.speedKmh)) continue;
    if (p.accuracy != null && p.accuracy > maxAccuracy) continue;
    if (p.speedKmh > hardCap) continue;
    if (kept.length) {
      const prev = kept[kept.length - 1];
      const dt = (p.t - prev.t) / 1000;
      if (dt > 0.02) {
        const jump = Math.abs(p.speedKmh - prev.speedKmh) / dt;
        if (jump > maxJumpKmhPerSec && Math.abs(p.speedKmh - prev.speedKmh) > 12) continue;
      }
    }
    kept.push(p);
  }
  return kept;
}

export function filterGpsSpikes(samples) {
  const asKmh = (samples || []).map((s) => ({
    ...s,
    speedKmh: s.speedKmh ?? (Number.isFinite(s.speedMps) ? s.speedMps * 3.6 : 0),
  }));
  const kept = filterGpsPoints(asKmh);
  return {
    samples: kept.map((s) => ({ ...s, speedMps: s.speedKmh / 3.6 })),
    rejected: asKmh.length - kept.length,
    total: asKmh.length,
  };
}

/**
 * Signed bounce series for cadence detection.
 *
 * Phones often expose linear acceleration (gravity removed). Taking |a| of that
 * stream peaks twice per footfall and reports ~2× cadence — which then fails
 * the run band and zeros the whole session. Prefer a signed axis when the
 * stream looks linear; keep |acc| for gravity-inclusive samples (~9.8 ± bounce).
 */
export function bounceSeries(motion) {
  const list = motion || [];
  if (!list.length) return [];

  const magOf = (m) =>
    m.accMag ?? Math.hypot(Number(m.ax) || 0, Number(m.ay) || 0, Number(m.az) || 0);
  const mags = list.map(magOf);
  const hasAxes = list.some(
    (m) =>
      (m.ax != null && Number.isFinite(m.ax)) ||
      (m.ay != null && Number.isFinite(m.ay)) ||
      (m.az != null && Number.isFinite(m.az))
  );
  if (!hasAxes) return mags;

  const linearVotes = list.filter((m) => m.linear === true).length;
  const looksLinear = linearVotes >= list.length * 0.4 || mean(mags) < 6;
  if (!looksLinear) return mags;

  const xs = list.map((m) => Number(m.ax) || 0);
  const ys = list.map((m) => Number(m.ay) || 0);
  const zs = list.map((m) => Number(m.az) || 0);
  const sx = stddev(xs);
  const sy = stddev(ys);
  const sz = stddev(zs);
  if (sz >= sx && sz >= sy) return zs;
  if (sy >= sx) return ys;
  return xs;
}

/**
 * Classify IMU bounce as pocket running, hand-held running, or neither.
 *
 * Pocket / waist: foot cadence ~1.6–4.5 Hz, moderate accel variance.
 * Tilt is helpful but optional — many phones deny DeviceOrientation, and a
 * firm pocket can show almost no tilt while still being a real run.
 * Hand while running: same cadence band plus larger tilt from arm swing.
 * Car / still: low bounce + low cadence. Hand wave without running: irregular
 * or out-of-band cadence / huge accel without a stable foot period.
 */
export function motionStats(motion) {
  if (!motion || motion.length < 8) {
    return {
      cadenceHz: 0,
      accStd: 0,
      tiltStd: 0,
      bounceScore: 0,
      pocketLike: false,
      handLike: false,
      runningLikeMotion: false,
      vehicleLike: false,
      linearAccel: false,
    };
  }
  const mag = motion.map(
    (m) => m.accMag ?? Math.hypot(Number(m.ax) || 0, Number(m.ay) || 0, Number(m.az) || 0)
  );
  const bounce = bounceSeries(motion);
  const linearAccel = mean(mag) < 6 || motion.filter((m) => m.linear === true).length >= motion.length * 0.4;
  const durationSec = Math.max(0.001, (motion[motion.length - 1].t - motion[0].t) / 1000);
  const dt = durationSec / Math.max(1, motion.length - 1);
  const hp = highPass(bounce, 8);
  // Use the stronger of magnitude / bounce variance so linear streams still score.
  const accStd = Math.max(stddev(mag), stddev(bounce));
  const thr = Math.max(0.15, stddev(hp) * 0.35);
  const cadenceHz = peakRateHz(hp, dt, thr);
  const betas = motion.map((m) => m.tiltBeta ?? m.beta).filter((v) => Number.isFinite(v));
  const gammas = motion.map((m) => m.tiltGamma ?? m.gamma).filter((v) => Number.isFinite(v));
  const tiltStd = Math.max(stddev(betas), stddev(gammas));
  const tiltAvailable = tiltStd >= 0.4;
  const cadenceScore = clamp((cadenceHz - 0.7) / 2.5, 0, 1);
  const varScore = clamp(accStd / 4, 0, 1);
  // Missing orientation gets a neutral tilt prior so firm-pocket runs still score.
  const tiltScore = tiltAvailable ? clamp(tiltStd / 10, 0, 1) : 0.35;
  const bounceScore = cadenceScore * 0.55 + varScore * 0.35 + tiltScore * 0.1;

  const cadenceOk =
    cadenceHz >= RUN_CADENCE_MIN_HZ && cadenceHz <= RUN_CADENCE_MAX_HZ;

  // Pocket / belt: step cadence + torso-scale bounce. No minimum tilt —
  // orientation may be missing, and a tight pocket barely tilts.
  // accStd floor ~1.0: firm jeans / waistband dampen bounce below the old 1.15.
  const pocketLike =
    cadenceOk &&
    accStd >= 1.0 &&
    accStd <= 11 &&
    (!tiltAvailable || tiltStd <= 30) &&
    bounceScore >= 0.28;

  // Hand while running: arm swing usually raises tilt; if orientation is
  // unavailable, require a bit more accel variance instead.
  const handLike =
    cadenceOk &&
    accStd >= 1.5 &&
    accStd <= 14 &&
    bounceScore >= 0.3 &&
    (tiltStd >= 4 || (!tiltAvailable && accStd >= 2.2));

  const runningLikeMotion = pocketLike || handLike;
  // Smooth cabin motion — low bounce regardless of GPS speed.
  const vehicleLike = accStd < 1.0 && cadenceHz < 1.5 && bounceScore < 0.28;

  return {
    cadenceHz: Math.round(cadenceHz * 100) / 100,
    accStd: Math.round(accStd * 100) / 100,
    tiltStd: Math.round(tiltStd * 100) / 100,
    bounceScore: Math.round(bounceScore * 100) / 100,
    pocketLike,
    handLike,
    runningLikeMotion,
    vehicleLike,
    linearAccel,
  };
}

/**
 * Recent motion slice ending at `endT` (default: last sample).
 */
export function motionWindowEndingAt(motion, endT, windowMs = MOTION_PATTERN_WINDOW_MS) {
  const list = motion || [];
  if (!list.length) return [];
  const end = endT ?? list[list.length - 1].t;
  const start = end - windowMs;
  return list.filter((m) => m.t >= start && m.t <= end);
}

/**
 * True when the latest ~2.5 s of IMU looks like pocket or hand running.
 */
export function isRunLikeAt(motion, tMs, windowMs = MOTION_PATTERN_WINDOW_MS) {
  return motionStats(motionWindowEndingAt(motion, tMs, windowMs)).runningLikeMotion;
}

/**
 * Contiguous [start,end] intervals where motion stayed run-like and, when GPS
 * is provided, speed stayed above MIN_RUN_SPEED_KMH. Only intervals lasting
 * MIN_RUN_SUSTAIN_MS are returned — these gate the speedometer and peaks.
 */
export function findSustainedRunWindows(motion, gpsPoints = [], options = {}) {
  const sustainMs = options.sustainMs ?? MIN_RUN_SUSTAIN_MS;
  const gapMs = options.gapMs ?? RUN_SUSTAIN_GAP_MS;
  const windowMs = options.windowMs ?? MOTION_PATTERN_WINDOW_MS;
  const minSpeed = options.minSpeedKmh ?? MIN_RUN_SPEED_KMH;
  const stepMs = options.stepMs ?? 200;
  const list = [...(motion || [])].sort((a, b) => a.t - b.t);
  if (list.length < 8) return [];

  const t0 = list[0].t;
  const t1 = list[list.length - 1].t;
  if (t1 - t0 < sustainMs * 0.5) return [];

  const hasGps = (gpsPoints || []).length > 0;
  let stretchStart = null;
  let lastGood = null;
  const raw = [];

  const closeStretch = () => {
    if (stretchStart != null && lastGood != null && lastGood - stretchStart >= sustainMs) {
      raw.push({ startMs: stretchStart, endMs: lastGood });
    }
    stretchStart = null;
    lastGood = null;
  };

  for (let t = t0; t <= t1; t += stepMs) {
    const runLike = isRunLikeAt(list, t, windowMs);
    const speedOk = !hasGps || gpsSpeedAtTime(gpsPoints, t) >= minSpeed;
    const ok = runLike && speedOk;
    if (ok) {
      if (stretchStart == null) stretchStart = t;
      else if (lastGood != null && t - lastGood > gapMs) {
        closeStretch();
        stretchStart = t;
      }
      lastGood = t;
    } else if (stretchStart != null && lastGood != null && t - lastGood > gapMs) {
      closeStretch();
    }
  }
  closeStretch();
  return raw;
}

function pointsInWindows(points, windows) {
  if (!windows?.length) return [];
  return (points || []).filter((p) =>
    windows.some((w) => p.t >= w.startMs && p.t <= w.endMs)
  );
}

export function buildProfile(runs) {
  const speeds = (runs || [])
    .filter((r) => r && (r.valid !== false) && Number.isFinite(r.maxSpeedKmh))
    .map((r) => r.maxSpeedKmh);
  const sorted = [...speeds].sort((a, b) => a - b);
  return {
    runs: speeds.length,
    count: speeds.length,
    verifiedMaxKmh: speeds,
    mean: Math.round(mean(speeds) * 10) / 10,
    p90: Math.round(percentile(sorted, 0.9) * 10) / 10,
    max: speeds.length ? Math.round(Math.max(...speeds) * 10) / 10 : 0,
  };
}

export function updateProfile(profile, verifiedMaxKmh) {
  const prev = (profile?.verifiedMaxKmh || []).map((maxSpeedKmh) => ({ valid: true, maxSpeedKmh }));
  return buildProfile([...prev, { valid: true, maxSpeedKmh: verifiedMaxKmh }]);
}

function motionHasAxes(motion) {
  return (motion || []).some(
    (m) =>
      (m.ax != null && Number.isFinite(m.ax)) ||
      (m.ay != null && Number.isFinite(m.ay)) ||
      (m.az != null && Number.isFinite(m.az))
  );
}

function fusedPointSpeedKmh(point) {
  const n = Number(point?.fusedSpeedKmh);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function gpsPointSpeedKmh(point) {
  const n = Number(point?.speedKmh ?? (Number.isFinite(point?.speedMps) ? point.speedMps * 3.6 : 0));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function gpsSpeedAtTime(gpsPoints, tMs) {
  const sorted = [...(gpsPoints || [])].sort((a, b) => a.t - b.t);
  if (!sorted.length) return 0;
  if (tMs <= sorted[0].t) return gpsPointSpeedKmh(sorted[0]);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].t >= tMs) {
      const prev = sorted[i - 1];
      const next = sorted[i];
      const span = next.t - prev.t;
      if (span <= 0) return gpsPointSpeedKmh(next);
      const ratio = Math.max(0, Math.min(1, (tMs - prev.t) / span));
      return gpsPointSpeedKmh(prev) + ratio * (gpsPointSpeedKmh(next) - gpsPointSpeedKmh(prev));
    }
  }
  return gpsPointSpeedKmh(sorted[sorted.length - 1]);
}

function maxGpsSpeedInWindow(gpsPoints, startMs, endMs) {
  let max = 0;
  for (const p of gpsPoints || []) {
    if (p.t >= startMs && p.t <= endMs) {
      max = Math.max(max, gpsPointSpeedKmh(p));
    }
  }
  return max;
}

function maxFusedSpeedInWindow(fusedSeries, startMs, endMs) {
  let max = 0;
  for (const p of fusedSeries || []) {
    if (p.t >= startMs && p.t <= endMs) {
      max = Math.max(max, fusedPointSpeedKmh(p));
    }
  }
  return max;
}

function windowSpeedStats(points, startMs, endMs, getSpeed) {
  let min = Infinity;
  let max = 0;
  let sum = 0;
  let count = 0;
  for (const p of points || []) {
    if (p.t < startMs) continue;
    if (p.t > endMs) break;
    const speed = getSpeed(p);
    if (speed <= 0) continue;
    min = Math.min(min, speed);
    max = Math.max(max, speed);
    sum += speed;
    count += 1;
  }
  if (!count) return { min: 0, max: 0, mean: 0, count: 0 };
  return { min, max, mean: sum / count, count };
}

/**
 * Highest mean speed over a sliding window (official sprint-max metric).
 * Mean-over-window resists GPS/IMU spikes better than an instantaneous max,
 * and still credits a real crest that is not perfectly flat for 2 s.
 */
export function findRollingMeanPeak(points, getSpeed, options = {}) {
  const windowMs = options.windowMs ?? PEAK_WINDOW_MS;
  const minSpeedKmh = options.minSpeedKmh ?? 0;
  const minSamples = options.minSamples ?? 2;
  const minCoverage = options.minCoverage ?? 0.85;
  const sorted = [...(points || [])].sort((a, b) => a.t - b.t);
  if (!sorted.length) {
    return {
      peakKmh: 0,
      sustained: false,
      sustainedMs: windowMs,
      windowStartMs: null,
      windowEndMs: null,
      method: "rolling_mean",
    };
  }

  const tMin = sorted[0].t;
  const tMax = sorted[sorted.length - 1].t;
  const span = tMax - tMin;
  if (span < windowMs * minCoverage) {
    return {
      peakKmh: 0,
      sustained: false,
      sustainedMs: span,
      windowStartMs: null,
      windowEndMs: null,
      method: "rolling_mean",
    };
  }

  let bestPeak = 0;
  let bestStart = null;
  let bestEnd = null;
  const stepMs = options.stepMs ?? 100;
  const lastStart = Math.max(tMin, tMax - windowMs);

  for (let startMs = tMin; startMs <= lastStart; startMs += stepMs) {
    const endMs = Math.min(tMax, startMs + windowMs);
    const { mean, count } = windowSpeedStats(sorted, startMs, endMs, getSpeed);
    if (count < minSamples || mean < minSpeedKmh) continue;
    if (mean > bestPeak) {
      bestPeak = mean;
      bestStart = startMs;
      bestEnd = endMs;
    }
  }

  return {
    peakKmh: bestPeak > 0 ? Math.round(bestPeak * 10) / 10 : 0,
    sustained: bestPeak > 0,
    sustainedMs: bestPeak > 0 ? windowMs : 0,
    windowStartMs: bestStart,
    windowEndMs: bestEnd,
    method: "rolling_mean",
  };
}

/** @deprecated Prefer findRollingMeanPeak — same rolling-mean semantics. */
function findSustainedWindowPeak(points, getSpeed, options = {}) {
  return findRollingMeanPeak(points, getSpeed, options);
}

function gpsCorrelatesWithFused(fusedKmh, gpsPoints, tMs, options = {}) {
  const minGpsKmh = options.minGpsKmh ?? MIN_GPS_CORRELATION_KMH;
  const ratio = options.ratio ?? 0.45;
  const slackKmh = options.slackKmh ?? 8;
  const windowStartMs = options.windowStartMs ?? tMs - PEAK_WINDOW_MS;
  const windowEndMs = options.windowEndMs ?? tMs + 250;
  const gpsAtT = gpsSpeedAtTime(gpsPoints, tMs);
  const gpsInWindow = maxGpsSpeedInWindow(gpsPoints, windowStartMs, windowEndMs);
  const gpsRef = Math.max(gpsAtT, gpsInWindow);
  if (gpsRef < minGpsKmh) return false;
  return gpsRef >= fusedKmh * ratio || gpsRef >= fusedKmh - slackKmh;
}

/**
 * Official GPS peak: highest mean speed over PEAK_WINDOW_MS.
 */
export function findSustainedGpsPeakKmh(gpsPoints, options = {}) {
  const kept = filterGpsPoints(gpsPoints);
  return findRollingMeanPeak(kept, gpsPointSpeedKmh, {
    windowMs: options.windowMs ?? PEAK_WINDOW_MS,
    minSpeedKmh: options.minSpeedKmh ?? MIN_GPS_CORRELATION_KMH,
    minSamples: options.minSamples ?? 2,
    stepMs: options.stepMs ?? 100,
  });
}

/**
 * Fused peak = highest mean over PEAK_WINDOW_MS, accepted only with GPS correlation.
 * Prevents IMU-only hand-waving from inflating the recorded peak.
 */
export function findSustainedPeakKmh(fusedSeries, gpsPoints, options = {}) {
  const windowMs = options.windowMs ?? PEAK_WINDOW_MS;
  const minGpsKmh = options.minGpsKmh ?? MIN_GPS_CORRELATION_KMH;
  const series = [...(fusedSeries || [])].sort((a, b) => a.t - b.t);
  const candidateKmh = series.length
    ? Math.max(...series.map((p) => fusedPointSpeedKmh(p)))
    : 0;

  if (candidateKmh <= 0) {
    return {
      peakKmh: 0,
      sustained: false,
      sustainedMs: 0,
      gpsCorrelated: false,
      candidateKmh: 0,
    };
  }

  const fusedWindow = findRollingMeanPeak(series, fusedPointSpeedKmh, {
    windowMs,
    minSpeedKmh: 0,
    minSamples: options.minSamples ?? 12,
    stepMs: options.stepMs ?? 50,
  });

  if (!fusedWindow.sustained) {
    return {
      peakKmh: 0,
      sustained: false,
      sustainedMs: fusedWindow.sustainedMs,
      gpsCorrelated: false,
      candidateKmh: Math.round(candidateKmh * 10) / 10,
    };
  }

  const anchorT = fusedWindow.windowEndMs ?? series[series.length - 1].t;
  const gpsCorrelated = gpsCorrelatesWithFused(fusedWindow.peakKmh, gpsPoints, anchorT, {
    minGpsKmh,
    windowStartMs: fusedWindow.windowStartMs,
    windowEndMs: fusedWindow.windowEndMs,
  });

  return {
    peakKmh: gpsCorrelated ? fusedWindow.peakKmh : 0,
    sustained: true,
    sustainedMs: fusedWindow.sustainedMs,
    gpsCorrelated,
    candidateKmh: Math.round(candidateKmh * 10) / 10,
    windowStartMs: fusedWindow.windowStartMs,
    windowEndMs: fusedWindow.windowEndMs,
  };
}

/**
 * Resolve peak speed: prefer live fused series from Tracker, else offline
 * GPS+IMU fusion when accel axes exist, else filtered GPS only.
 * Official peak = max of PEAK_WINDOW_MS rolling means inside a ≥MIN_RUN_SUSTAIN_MS
 * run-like window (pocket or hand). Speeds outside those windows are ignored.
 */
export function resolvePeakSpeedKmh(session = {}) {
  const gps = session.gps || [];
  const motion = session.motion || [];
  const kept = filterGpsPoints(gps);
  const gpsMax = kept.length ? Math.max(...kept.map((p) => p.speedKmh || 0)) : 0;
  const emptyGpsSustained = {
    peakKmh: 0,
    sustained: false,
    sustainedMs: 0,
    windowStartMs: null,
    windowEndMs: null,
    method: "rolling_mean",
  };

  if ((motion || []).length < 8) {
    return {
      maxSpeedKmh: 0,
      gpsMaxKmh: gpsMax,
      gpsSustainedPeakKmh: 0,
      source: "no_motion",
      fusionDebug: session.fusionDebug || null,
      keptGps: kept.length,
      sustainedPeak: null,
      gpsSustained: emptyGpsSustained,
      runWindows: [],
    };
  }

  const runWindows = findSustainedRunWindows(motion, kept);
  if (!runWindows.length) {
    return {
      maxSpeedKmh: 0,
      gpsMaxKmh: gpsMax,
      gpsSustainedPeakKmh: 0,
      source: "no_run_sustain",
      fusionDebug: session.fusionDebug || null,
      keptGps: kept.length,
      sustainedPeak: null,
      gpsSustained: emptyGpsSustained,
      runWindows,
    };
  }

  const gatedGps = pointsInWindows(kept, runWindows);
  const gpsSustained = findSustainedGpsPeakKmh(gatedGps);

  if (session.fused?.length) {
    const gatedFused = pointsInWindows(session.fused, runWindows);
    const sustained = findSustainedPeakKmh(gatedFused, gatedGps);
    const fusedMax = sustained.peakKmh;
    return {
      maxSpeedKmh: Math.max(gpsSustained.peakKmh, fusedMax),
      gpsMaxKmh: gpsMax,
      gpsSustainedPeakKmh: gpsSustained.peakKmh,
      source: fusedMax > gpsSustained.peakKmh ? "live_fusion" : gpsSustained.peakKmh > 0 ? "gps_sustained" : "gps_filtered",
      fusionDebug: session.fusionDebug || null,
      keptGps: kept.length,
      sustainedPeak: sustained,
      gpsSustained,
      runWindows,
    };
  }

  if (motionHasAxes(motion) && gatedGps.length) {
    const fused = fuseSession({ gps: gatedGps, motion });
    const gatedFused = pointsInWindows(fused.series, runWindows);
    const sustained = findSustainedPeakKmh(gatedFused.length ? gatedFused : fused.series, gatedGps);
    const fusedMax = sustained.peakKmh;
    const maxSpeedKmh = Math.max(gpsSustained.peakKmh, fusedMax);
    return {
      maxSpeedKmh,
      gpsMaxKmh: gpsMax,
      gpsSustainedPeakKmh: gpsSustained.peakKmh,
      source: fusedMax > gpsSustained.peakKmh ? "offline_fusion" : gpsSustained.peakKmh > 0 ? "gps_sustained" : "gps_filtered",
      fusionDebug: fused.debug,
      keptGps: kept.length,
      sustainedPeak: sustained,
      gpsSustained,
      runWindows,
    };
  }

  return {
    maxSpeedKmh: gpsSustained.peakKmh,
    gpsMaxKmh: gpsMax,
    gpsSustainedPeakKmh: gpsSustained.peakKmh,
    source: gpsSustained.peakKmh > 0 ? "gps_sustained" : "gps_filtered",
    fusionDebug: null,
    keptGps: kept.length,
    sustainedPeak: null,
    gpsSustained,
    runWindows,
  };
}

/**
 * Full analysis of a finished session.
 * @param {{gps:any[], motion:any[], fused?:any[], fusionDebug?:object, durationMs?:number, profile?:any}} session
 */
export function analyzeRun(session = {}) {
  const gps = session.gps || [];
  const motion = session.motion || [];
  const rawMaxKmh = gps.length ? Math.max(...gps.map((p) => p.speedKmh || 0)) : 0;
  const kept = filterGpsPoints(gps);
  const peak = resolvePeakSpeedKmh(session);
  const measuredPeakKmh = peak.maxSpeedKmh;
  const sustainedPeak = peak.sustainedPeak;
  const stats = motionStats(motion);
  const runWindows = peak.runWindows || [];

  const flags = [];
  const stillPhone = stats.accStd < 0.85 && stats.tiltStd < 1.8 && stats.cadenceHz < 1.25;
  if (stillPhone) flags.push("still_phone");
  if (stats.vehicleLike) flags.push("vehicle_like_motion");
  if (peak.source === "no_run_sustain" || peak.source === "no_motion") {
    flags.push("no_run_sustain");
  }

  const candidateKmh = sustainedPeak?.candidateKmh || 0;
  const gpsSustainedPeakKmh = peak.gpsSustainedPeakKmh || peak.gpsSustained?.peakKmh || 0;
  const imuOnlySpike =
    candidateKmh >= 12 &&
    measuredPeakKmh < 10 &&
    gpsSustainedPeakKmh < MIN_GPS_CORRELATION_KMH;
  if (imuOnlySpike) flags.push("imu_gps_mismatch");
  if (sustainedPeak?.sustained && !sustainedPeak.gpsCorrelated && candidateKmh >= 12) {
    flags.push("no_gps_correlation");
  }
  if (
    measuredPeakKmh >= 12 &&
    gpsSustainedPeakKmh < MIN_GPS_CORRELATION_KMH &&
    (!sustainedPeak || sustainedPeak.peakKmh <= 0)
  ) {
    flags.push("no_sustained_peak");
  }

  // Vehicle score uses raw GPS max so smooth car travel is still rejected even
  // when gated peak is already 0.
  const rawKeptMax = kept.length ? Math.max(...kept.map((p) => p.speedKmh || 0)) : 0;
  const speedTerm = clamp((Math.max(measuredPeakKmh, rawKeptMax) - 22) / 38, 0, 1);
  const cadenceTerm = stats.cadenceHz >= 1.8 && stats.cadenceHz <= 4.8 ? 0 : 1;
  const varTerm = stats.accStd < 1.2 ? 1 : 0;
  const vehicleScore =
    Math.round((cadenceTerm * 0.45 + varTerm * 0.35 + speedTerm * 0.2) * 100) / 100;

  if (measuredPeakKmh > HUMAN_SPEED_CAP_KMH) flags.push("over_human_cap");
  if (measuredPeakKmh > 55 || rawKeptMax > 55) flags.push("hard_vehicle_speed");
  if (vehicleScore >= 0.55) flags.push("vehicle_motion");
  if (stats.runningLikeMotion) flags.push("running_motion");
  if (stats.pocketLike) flags.push("pocket_motion");
  if (stats.handLike) flags.push("hand_motion");

  const profile = session.profile;
  if (profile && (profile.runs || profile.count) >= 3) {
    const limit = Math.max(profile.p90 || profile.mean || 8, 8) * 1.35;
    if (measuredPeakKmh > limit && vehicleScore >= 0.4) flags.push("profile_violation");
  }

  let valid = true;
  let label = "ok";
  let messageHe = `נמדדה ריצה. השיא הוא ממוצע המהירות הגבוה ביותר על ${(PEAK_WINDOW_MS / 1000).toFixed(1)} שנ׳ בתוך מקטע ריצה של לפחות ${MIN_RUN_SUSTAIN_MS / 1000} שנ׳.`;

  if (flags.includes("hard_vehicle_speed") || measuredPeakKmh > 55 || rawKeptMax > 55) {
    valid = false;
    label = "vehicle_speed";
    messageHe = "לא נמדדה ריצה — המהירות נראית כמו נסיעה ברכב.";
  } else if (flags.includes("imu_gps_mismatch") || flags.includes("no_gps_correlation")) {
    valid = false;
    label = "imu_gps_mismatch";
    messageHe = "לא נמדדה ריצה — תנועת הטלפון לא תואמת תנועה ב-GPS (למשל נפנוף יד).";
  } else if (flags.includes("no_sustained_peak")) {
    valid = false;
    label = "no_sustained_peak";
    messageHe = `לא נמדדה ריצה — צריך מקטע ריצה של לפחות ${MIN_RUN_SUSTAIN_MS / 1000} שנ׳ עם GPS יציב.`;
  } else if (flags.includes("no_run_sustain") || measuredPeakKmh < MIN_RECORDABLE_KMH) {
    valid = false;
    label = flags.includes("no_run_sustain") ? "no_run_sustain" : "no_speed";
    if (!flags.includes("no_speed")) flags.push("no_speed");
    messageHe =
      `לא נמדדה ריצה. שימו את הטלפון בכיס, בחגורה או ביד יציבה בזמן ריצה — לפחות ${MIN_RUN_SUSTAIN_MS / 1000} שנ׳ ברצף.`;
  } else if (stillPhone && (measuredPeakKmh >= 12 || rawKeptMax >= 12)) {
    valid = false;
    label = "still_phone";
    messageHe = "לא נמדדה ריצה — הטלפון כמעט לא זז (נפוץ בנסיעה ברכב).";
  } else if (vehicleScore >= 0.55 && (measuredPeakKmh >= 25 || rawKeptMax >= 25) && !stats.runningLikeMotion) {
    valid = false;
    label = "smooth_high_speed";
    messageHe = "לא נמדדה ריצה — תנועה חלקה ומהירה מדי, כמו ברכב.";
  } else if (flags.includes("over_human_cap") && !stats.runningLikeMotion) {
    valid = false;
    label = "cap_no_bounce";
    messageHe = "לא נמדדה ריצה — מהירות מעל 45 קמ״ש בלי תנודות ריצה.";
  } else if (flags.includes("profile_violation")) {
    valid = false;
    label = "profile";
    messageHe = "לא נמדדה ריצה — המהירות חריגה ביחס לריצות הקודמות שלך ובלי סימני ריצה.";
  }

  // Invalid sessions never surface a speed on the meter / records — show 0.
  const rounded = valid ? Math.round(measuredPeakKmh * 10) / 10 : 0;
  const windowSec = PEAK_WINDOW_MS / 1000;
  return {
    valid,
    cheat: !valid,
    label,
    messageHe,
    flags,
    maxSpeedKmh: rounded,
    maxKmh: rounded,
    measuredPeakKmh: Math.round(measuredPeakKmh * 10) / 10,
    peakWindowMs: PEAK_WINDOW_MS,
    peakWindowSec: windowSec,
    minRunSustainMs: MIN_RUN_SUSTAIN_MS,
    runWindows,
    rawMaxKmh: Math.round(rawMaxKmh * 10) / 10,
    gpsMaxKmh: Math.round((peak.gpsMaxKmh || 0) * 10) / 10,
    speedSource: peak.source,
    fusionDebug: peak.fusionDebug,
    sustainedPeak,
    vehicleScore,
    runningLikeMotion: stats.runningLikeMotion,
    looksLikeRunning: stats.runningLikeMotion,
    pocketLike: !!stats.pocketLike,
    handLike: !!stats.handLike,
    cadenceHz: stats.cadenceHz,
    bounceScore: stats.bounceScore,
    accStd: stats.accStd,
    tiltStd: stats.tiltStd,
    keptGps: kept.length,
    droppedGps: gps.length - kept.length,
    motion: {
      looksLikeRunning: stats.runningLikeMotion,
      pocketLike: !!stats.pocketLike,
      handLike: !!stats.handLike,
      cadenceHz: stats.cadenceHz,
      bounceScore: stats.bounceScore,
    },
  };
}

export function evaluateAntiCheat({ gpsSamples, motionSamples, profile } = {}) {
  const gps = (gpsSamples || []).map((s) => ({
    t: s.t,
    speedKmh: s.speedKmh ?? (s.speedMps != null ? s.speedMps * 3.6 : 0),
    accuracy: s.accuracy,
    lat: s.lat,
    lng: s.lon ?? s.lng,
  }));
  const motion = (motionSamples || []).map((m) => ({
    t: m.t,
    accMag: m.accMag ?? Math.hypot(m.ax || 0, m.ay || 0, m.az || 0),
    tiltBeta: m.tiltBeta ?? m.beta,
    tiltGamma: m.tiltGamma ?? m.gamma,
  }));
  return analyzeRun({ gps, motion, profile });
}

export function shareText(maxKmh, playerName) {
  const rounded = Math.round(Number(maxKmh) * 10) / 10;
  const speed = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  const name = playerName || "הטבלה";
  return `אתה יותר מהיר מ-${name}. מהירות הריצה המקסימאלית היא: ${speed} קמ״ש`;
}

export function rankAgainstTable(maxKmh, athletesOrTable) {
  const list = Array.isArray(athletesOrTable)
    ? athletesOrTable
    : athletesOrTable?.athletes || [];
  const sorted = [...list].sort((a, b) => b.maxSpeedKmh - a.maxSpeedKmh);
  const faster = sorted.filter((a) => a.maxSpeedKmh > maxKmh + 0.005);
  const slower = sorted.filter((a) => a.maxSpeedKmh <= maxKmh + 0.005);
  const beaten = slower[0] || null;
  return {
    place: faster.length + 1,
    total: sorted.length,
    beaten,
    slower,
    faster,
    sorted,
    athletes: sorted,
    fasterThan: beaten,
    nextTarget: faster[faster.length - 1] || null,
  };
}
