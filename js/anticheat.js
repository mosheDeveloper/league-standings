/**
 * Anti-cheat for phone-carried running speed.
 * GPS spike filter, cadence/tilt bounce, human cap, learned profile.
 */

export const HUMAN_SPEED_CAP_KMH = 45;
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

/**
 * Full analysis of a finished session.
 * @param {{gps:any[], motion:any[], durationMs?:number, profile?:any}} session
 */
export function analyzeRun(session = {}) {
  const gps = session.gps || [];
  const motion = session.motion || [];
  const rawMaxKmh = gps.length ? Math.max(...gps.map((p) => p.speedKmh || 0)) : 0;
  const kept = filterGpsPoints(gps);
  const maxSpeedKmh = kept.length ? Math.max(...kept.map((p) => p.speedKmh || 0)) : 0;
  const stats = motionStats(motion);

  const flags = [];
  const stillPhone = stats.accStd < 0.85 && stats.tiltStd < 1.8 && stats.cadenceHz < 1.25;
  if (stillPhone) flags.push("still_phone");

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
  let messageHe = "הריצה נראית תקינה.";

  if (flags.includes("hard_vehicle_speed") || maxSpeedKmh > 55) {
    valid = false;
    label = "vehicle_speed";
    messageHe = "מהירות לא אנושית — נחסמה כנסיעה ברכב.";
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
  return {
    valid,
    cheat: !valid,
    label,
    messageHe,
    flags,
    maxSpeedKmh: rounded,
    maxKmh: rounded,
    rawMaxKmh: Math.round(rawMaxKmh * 10) / 10,
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
