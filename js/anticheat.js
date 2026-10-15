/**
 * Anti-cheat for phone-carried running speed.
 * GPS spike filter, cadence/tilt bounce, human cap, learned profile.
 * Peak speed prefers GPS+IMU sensor fusion when inertial axes are present.
 */

import { fuseSession, haversineMeters } from "./sensor-fusion.js";

export const HUMAN_SPEED_CAP_KMH = 45;
/**
 * Official max speed = highest mean speed over a sliding window of this length.
 * ~1.5 s captures a sprint crest without requiring an unrealistically flat plateau.
 */
export const PEAK_WINDOW_MS = 1500;
/** @deprecated Use PEAK_WINDOW_MS — kept as alias for older callers/tests. */
export const SUSTAINED_PEAK_MS = PEAK_WINDOW_MS;
/** Minimum GPS speed (km/h) in the peak window to confirm a fused peak. */
export const MIN_GPS_CORRELATION_KMH = 6;
/** Below this, a finished run is not treated as a measurable (shareable) peak. */
export const MIN_RECORDABLE_KMH = 8;
/**
 * Net displacement / (mean_speed × window) must clear this to count a peak.
 * Blocks rapid forward/back rocking that inflates |speed| with almost no progress.
 * Straight sprints ≈ 1.0; short F/B shuttles inside the window stay low.
 */
export const MIN_PATH_PROGRESS = 0.4;
/**
 * Fused official peak may exceed GPS in the same window by at most this much.
 * Lets fusion recover brief GPS under-sampling, but stops arm-swing (phone in hand
 * while running) from minting a much higher “hand speed” than ground speed.
 */
export const FUSION_HEADROOM_KMH = 3;
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
  const maxAccuracy = options.maxAccuracy ?? 40;
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

function motionStats(motion) {
  if (!motion || motion.length < 8) {
    return {
      cadenceHz: 0,
      accStd: 0,
      tiltStd: 0,
      bounceScore: 0,
      runningLikeMotion: false,
    };
  }
  const acc = motion.map((m) => m.accMag ?? Math.hypot(m.ax || 0, m.ay || 0, m.az || 0));
  const durationSec = Math.max(0.001, (motion[motion.length - 1].t - motion[0].t) / 1000);
  const dt = durationSec / Math.max(1, motion.length - 1);
  const hp = highPass(acc, 8);
  const accStd = stddev(acc);
  const thr = Math.max(0.2, stddev(hp) * 0.35);
  const cadenceHz = peakRateHz(hp, dt, thr);
  const betas = motion.map((m) => m.tiltBeta ?? m.beta).filter((v) => Number.isFinite(v));
  const gammas = motion.map((m) => m.tiltGamma ?? m.gamma).filter((v) => Number.isFinite(v));
  const tiltStd = Math.max(stddev(betas), stddev(gammas));
  const cadenceScore = clamp((cadenceHz - 0.8) / 2.4, 0, 1);
  const varScore = clamp(accStd / 4, 0, 1);
  const tiltScore = clamp(tiltStd / 10, 0, 1);
  const bounceScore = cadenceScore * 0.5 + varScore * 0.35 + tiltScore * 0.15;
  const runningLikeMotion = cadenceHz >= 1.8 && cadenceHz <= 4.8 && accStd >= 1.4 && bounceScore >= 0.38;
  return {
    cadenceHz: Math.round(cadenceHz * 100) / 100,
    accStd: Math.round(accStd * 100) / 100,
    tiltStd: Math.round(tiltStd * 100) / 100,
    bounceScore: Math.round(bounceScore * 100) / 100,
    runningLikeMotion,
  };
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
 * Path progress in a time window: netDisplacement / (meanSpeed × duration).
 * Returns null when fewer than 2 coordinate samples (skip the check).
 */
export function windowPathProgress(points, startMs, endMs, meanKmh) {
  const pts = [];
  for (const p of points || []) {
    if (p.t < startMs || p.t > endMs) continue;
    const lat = p.lat;
    const lng = p.lng ?? p.lon;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    pts.push({ lat, lng });
  }
  if (pts.length < 2 || !(meanKmh > 0)) return null;
  const net = haversineMeters(
    pts[0].lat,
    pts[0].lng,
    pts[pts.length - 1].lat,
    pts[pts.length - 1].lng
  );
  const expectedM = (meanKmh / 3.6) * Math.max(0.001, (endMs - startMs) / 1000);
  if (expectedM <= 0) return null;
  return {
    netM: net,
    expectedM,
    progress: net / expectedM,
  };
}

/**
 * Highest mean speed over a sliding window (official sprint-max metric).
 * Mean-over-window resists GPS/IMU spikes better than an instantaneous max,
 * and still credits a real crest that is not perfectly flat for 2 s.
 * Optional path-progress filter rejects forward/back rocking with no net travel.
 */
export function findRollingMeanPeak(points, getSpeed, options = {}) {
  const windowMs = options.windowMs ?? PEAK_WINDOW_MS;
  const minSpeedKmh = options.minSpeedKmh ?? 0;
  const minSamples = options.minSamples ?? 2;
  const minCoverage = options.minCoverage ?? 0.85;
  const requirePathProgress = options.requirePathProgress === true;
  const minPathProgress = options.minPathProgress ?? MIN_PATH_PROGRESS;
  const sorted = [...(points || [])].sort((a, b) => a.t - b.t);
  if (!sorted.length) {
    return {
      peakKmh: 0,
      sustained: false,
      sustainedMs: windowMs,
      windowStartMs: null,
      windowEndMs: null,
      method: "rolling_mean",
      pathProgress: null,
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
      pathProgress: null,
    };
  }

  let bestPeak = 0;
  let bestStart = null;
  let bestEnd = null;
  let bestProgress = null;
  const stepMs = options.stepMs ?? 100;
  const lastStart = Math.max(tMin, tMax - windowMs);

  for (let startMs = tMin; startMs <= lastStart; startMs += stepMs) {
    const endMs = Math.min(tMax, startMs + windowMs);
    const { mean, count } = windowSpeedStats(sorted, startMs, endMs, getSpeed);
    if (count < minSamples || mean < minSpeedKmh) continue;
    let progressInfo = null;
    if (requirePathProgress) {
      progressInfo = windowPathProgress(sorted, startMs, endMs, mean);
      // Only enforce when coordinates exist in the window.
      if (progressInfo && progressInfo.progress < minPathProgress) continue;
    }
    if (mean > bestPeak) {
      bestPeak = mean;
      bestStart = startMs;
      bestEnd = endMs;
      bestProgress = progressInfo;
    }
  }

  return {
    peakKmh: bestPeak > 0 ? Math.round(bestPeak * 10) / 10 : 0,
    sustained: bestPeak > 0,
    sustainedMs: bestPeak > 0 ? windowMs : 0,
    windowStartMs: bestStart,
    windowEndMs: bestEnd,
    method: "rolling_mean",
    pathProgress: bestProgress,
  };
}

/** @deprecated Prefer findRollingMeanPeak — same rolling-mean semantics. */
function findSustainedWindowPeak(points, getSpeed, options = {}) {
  return findRollingMeanPeak(points, getSpeed, options);
}

function gpsReferenceInWindow(gpsPoints, tMs, options = {}) {
  const windowStartMs = options.windowStartMs ?? tMs - PEAK_WINDOW_MS;
  const windowEndMs = options.windowEndMs ?? tMs + 250;
  const gpsAtT = gpsSpeedAtTime(gpsPoints, tMs);
  const gpsInWindow = maxGpsSpeedInWindow(gpsPoints, windowStartMs, windowEndMs);
  return Math.max(gpsAtT, gpsInWindow);
}

function gpsCorrelatesWithFused(fusedKmh, gpsPoints, tMs, options = {}) {
  const minGpsKmh = options.minGpsKmh ?? MIN_GPS_CORRELATION_KMH;
  const headroom = options.headroomKmh ?? FUSION_HEADROOM_KMH;
  // After clamping, correlation means “GPS saw real movement near this peak”.
  const gpsRef = gpsReferenceInWindow(gpsPoints, tMs, options);
  if (gpsRef < minGpsKmh) return false;
  return fusedKmh <= gpsRef + headroom + 0.05 || gpsRef >= fusedKmh * 0.7;
}

/**
 * Official GPS peak: highest mean speed over PEAK_WINDOW_MS,
 * with net path progress so F/B rocking cannot mint a record.
 */
export function findSustainedGpsPeakKmh(gpsPoints, options = {}) {
  const kept = filterGpsPoints(gpsPoints);
  return findRollingMeanPeak(kept, gpsPointSpeedKmh, {
    windowMs: options.windowMs ?? PEAK_WINDOW_MS,
    minSpeedKmh: options.minSpeedKmh ?? MIN_GPS_CORRELATION_KMH,
    minSamples: options.minSamples ?? 2,
    stepMs: options.stepMs ?? 100,
    requirePathProgress: options.requirePathProgress !== false,
    minPathProgress: options.minPathProgress ?? MIN_PATH_PROGRESS,
  });
}

/**
 * Fused peak = highest mean over PEAK_WINDOW_MS, accepted only with GPS correlation
 * and enough net GPS progress in the same window (blocks F/B phone rocking).
 */
export function findSustainedPeakKmh(fusedSeries, gpsPoints, options = {}) {
  const windowMs = options.windowMs ?? PEAK_WINDOW_MS;
  const minGpsKmh = options.minGpsKmh ?? MIN_GPS_CORRELATION_KMH;
  const minPathProgress = options.minPathProgress ?? MIN_PATH_PROGRESS;
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
      pathProgressOk: false,
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
      pathProgressOk: false,
      candidateKmh: Math.round(candidateKmh * 10) / 10,
    };
  }

  const anchorT = fusedWindow.windowEndMs ?? series[series.length - 1].t;
  const headroom = options.headroomKmh ?? FUSION_HEADROOM_KMH;
  const gpsRef = gpsReferenceInWindow(gpsPoints, anchorT, {
    windowStartMs: fusedWindow.windowStartMs,
    windowEndMs: fusedWindow.windowEndMs,
  });
  // Cap hand/IMU inflation: record at most GPS + headroom in the same window.
  const cappedPeakKmh =
    Math.round(Math.min(fusedWindow.peakKmh, gpsRef > 0 ? gpsRef + headroom : fusedWindow.peakKmh) * 10) / 10;
  const gpsCorrelated = gpsCorrelatesWithFused(cappedPeakKmh, gpsPoints, anchorT, {
    minGpsKmh,
    headroomKmh: headroom,
    windowStartMs: fusedWindow.windowStartMs,
    windowEndMs: fusedWindow.windowEndMs,
  });

  const pathInfo = windowPathProgress(
    gpsPoints,
    fusedWindow.windowStartMs,
    fusedWindow.windowEndMs,
    cappedPeakKmh
  );
  const pathProgressOk = !pathInfo || pathInfo.progress >= minPathProgress;

  return {
    peakKmh: gpsCorrelated && pathProgressOk ? cappedPeakKmh : 0,
    sustained: true,
    sustainedMs: fusedWindow.sustainedMs,
    gpsCorrelated,
    pathProgressOk,
    pathProgress: pathInfo,
    gpsRefKmh: Math.round(gpsRef * 10) / 10,
    uncappedPeakKmh: fusedWindow.peakKmh,
    candidateKmh: Math.round(candidateKmh * 10) / 10,
    windowStartMs: fusedWindow.windowStartMs,
    windowEndMs: fusedWindow.windowEndMs,
  };
}

/**
 * Resolve peak speed: prefer live fused series from Tracker, else offline
 * GPS+IMU fusion when accel axes exist, else filtered GPS only.
 * Official peak = max of PEAK_WINDOW_MS rolling means; fused needs GPS correlation.
 */
export function resolvePeakSpeedKmh(session = {}) {
  const gps = session.gps || [];
  const motion = session.motion || [];
  const kept = filterGpsPoints(gps);
  const gpsMax = kept.length ? Math.max(...kept.map((p) => p.speedKmh || 0)) : 0;
  const gpsSustained = findSustainedGpsPeakKmh(gps);

  if (session.fused?.length) {
    const sustained = findSustainedPeakKmh(session.fused, kept);
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
    };
  }

  if (motionHasAxes(motion) && gps.length) {
    const fused = fuseSession({ gps, motion });
    const sustained = findSustainedPeakKmh(fused.series, kept);
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
    };
  }

  // Never fall back to a single GPS sample — that caused "live max then final 0"
  // mismatches when a spike flashed on screen but failed the official window.
  return {
    maxSpeedKmh: gpsSustained.peakKmh,
    gpsMaxKmh: gpsMax,
    gpsSustainedPeakKmh: gpsSustained.peakKmh,
    source: gpsSustained.peakKmh > 0 ? "gps_sustained" : "gps_filtered",
    fusionDebug: null,
    keptGps: kept.length,
    sustainedPeak: null,
    gpsSustained,
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
  const maxSpeedKmh = peak.maxSpeedKmh;
  const sustainedPeak = peak.sustainedPeak;
  const stats = motionStats(motion);

  const flags = [];
  const stillPhone = stats.accStd < 0.85 && stats.tiltStd < 1.8 && stats.cadenceHz < 1.25;
  if (stillPhone) flags.push("still_phone");

  const candidateKmh = sustainedPeak?.candidateKmh || 0;
  const gpsSustainedPeakKmh = peak.gpsSustainedPeakKmh || peak.gpsSustained?.peakKmh || 0;
  const gpsPeakIgnoringProgress = findRollingMeanPeak(kept, gpsPointSpeedKmh, {
    windowMs: PEAK_WINDOW_MS,
    minSpeedKmh: MIN_GPS_CORRELATION_KMH,
    requirePathProgress: false,
  });
  const imuOnlySpike =
    candidateKmh >= 12 &&
    maxSpeedKmh < 10 &&
    gpsSustainedPeakKmh < MIN_GPS_CORRELATION_KMH;
  if (imuOnlySpike) flags.push("imu_gps_mismatch");
  if (sustainedPeak?.sustained && !sustainedPeak.gpsCorrelated && candidateKmh >= 12) {
    flags.push("no_gps_correlation");
  }
  if (sustainedPeak?.sustained && sustainedPeak.pathProgressOk === false && candidateKmh >= 12) {
    flags.push("oscillating_path");
  }
  if (
    gpsPeakIgnoringProgress.peakKmh >= 12 &&
    gpsSustainedPeakKmh < MIN_RECORDABLE_KMH &&
    maxSpeedKmh < MIN_RECORDABLE_KMH
  ) {
    flags.push("oscillating_path");
  }
  if (
    maxSpeedKmh >= 12 &&
    gpsSustainedPeakKmh < MIN_GPS_CORRELATION_KMH &&
    (!sustainedPeak || sustainedPeak.peakKmh <= 0)
  ) {
    flags.push("no_sustained_peak");
  }

  const speedTerm = clamp((maxSpeedKmh - 22) / 38, 0, 1);
  const cadenceTerm = stats.cadenceHz >= 1.8 && stats.cadenceHz <= 4.8 ? 0 : 1;
  const varTerm = stats.accStd < 1.2 ? 1 : 0;
  const vehicleScore =
    Math.round((cadenceTerm * 0.45 + varTerm * 0.35 + speedTerm * 0.2) * 100) / 100;

  if (maxSpeedKmh > HUMAN_SPEED_CAP_KMH) flags.push("over_human_cap");
  if (maxSpeedKmh > 55) flags.push("hard_vehicle_speed");
  if (vehicleScore >= 0.55) flags.push("vehicle_motion");
  if (stats.runningLikeMotion) flags.push("running_motion");

  const profile = session.profile;
  if (profile && (profile.runs || profile.count) >= 3) {
    const limit = Math.max(profile.p90 || profile.mean || 8, 8) * 1.35;
    if (maxSpeedKmh > limit && vehicleScore >= 0.4) flags.push("profile_violation");
  }

  let valid = true;
  let label = "ok";
  let messageHe = `הריצה נראית תקינה. השיא הוא ממוצע המהירות הגבוה ביותר על ${(PEAK_WINDOW_MS / 1000).toFixed(1)} שנ׳.`;

  if (flags.includes("hard_vehicle_speed") || maxSpeedKmh > 55) {
    valid = false;
    label = "vehicle_speed";
    messageHe = "מהירות לא אנושית — נחסמה כנסיעה ברכב.";
  } else if (flags.includes("imu_gps_mismatch") || flags.includes("no_gps_correlation")) {
    valid = false;
    label = "imu_gps_mismatch";
    messageHe = "שיא המהירות לא אושר — אין התאמה מספקת ל-GPS (למשל הזזת הטלפון בלי ריצה).";
  } else if (flags.includes("oscillating_path")) {
    valid = false;
    label = "oscillating_path";
    messageHe =
      "שיא לא אושר — זוהתה תנועה קדימה־אחורה בלי התקדמות מספקת. רוצו קדימה בקו ישר למדידת שיא.";
  } else if (flags.includes("no_sustained_peak")) {
    valid = false;
    label = "no_sustained_peak";
    messageHe = `שיא המהירות לא אושר — נדרש ממוצע מהירות של כ־${(PEAK_WINDOW_MS / 1000).toFixed(1)} שנ׳ עם אימות GPS.`;
  } else if (maxSpeedKmh < MIN_RECORDABLE_KMH) {
    valid = false;
    label = "no_speed";
    flags.push("no_speed");
    messageHe =
      "לא נמדד שיא מאושר. שימו את הטלפון בכיס/חגורת מותן, רוצו לפחות כמה שניות עם GPS יציב, ואז עצרו.";
  } else if (stillPhone && maxSpeedKmh >= 12) {
    valid = false;
    label = "still_phone";
    messageHe = "הטלפון כמעט לא זז במהלך המדידה — כך מזהים נסיעה ברכב.";
  } else if (vehicleScore >= 0.55 && maxSpeedKmh >= 25 && !stats.runningLikeMotion) {
    valid = false;
    label = "smooth_high_speed";
    messageHe = "תנועת הטלפון חלקה כמו ברכב, והמהירות גבוהה מדי לריצה.";
  } else if (flags.includes("over_human_cap") && !stats.runningLikeMotion) {
    valid = false;
    label = "cap_no_bounce";
    messageHe = "מהירות שיא מעל 45 קמ״ש בלי תנודות ריצה.";
  } else if (flags.includes("profile_violation")) {
    valid = false;
    label = "profile";
    messageHe = "המהירות גבוהה מדי ביחס לריצות הקודמות שלך, ובלי סימני ריצה.";
  }

  const rounded = Math.round(maxSpeedKmh * 10) / 10;
  const windowSec = PEAK_WINDOW_MS / 1000;
  return {
    valid,
    cheat: !valid,
    label,
    messageHe,
    flags,
    maxSpeedKmh: rounded,
    maxKmh: rounded,
    peakWindowMs: PEAK_WINDOW_MS,
    peakWindowSec: windowSec,
    rawMaxKmh: Math.round(rawMaxKmh * 10) / 10,
    gpsMaxKmh: Math.round((peak.gpsMaxKmh || 0) * 10) / 10,
    speedSource: peak.source,
    fusionDebug: peak.fusionDebug,
    sustainedPeak,
    vehicleScore,
    runningLikeMotion: stats.runningLikeMotion,
    looksLikeRunning: stats.runningLikeMotion,
    cadenceHz: stats.cadenceHz,
    bounceScore: stats.bounceScore,
    accStd: stats.accStd,
    tiltStd: stats.tiltStd,
    keptGps: kept.length,
    droppedGps: gps.length - kept.length,
    motion: {
      looksLikeRunning: stats.runningLikeMotion,
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
