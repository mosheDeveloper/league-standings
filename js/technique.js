/**
 * Technique drills: packaging, provisional scoring stubs, WhatsApp export.
 * Cone count/spacing live in data/technique-exercises.json (developer config).
 */

export function formatDurationMs(ms) {
  const total = Math.max(0, Math.round(Number(ms) || 0) / 1000);
  const m = Math.floor(total / 60);
  const s = Math.floor(total % 60);
  const tenths = Math.floor((Math.max(0, Number(ms) || 0) % 1000) / 100);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${tenths}`;
}

/** Best-effort model parse from a classic User-Agent string. */
export function guessDeviceModelFromUa(ua = "") {
  const s = String(ua || "");
  if (!s) return null;

  // Android: "...; <Model> Build/..." or "...; <Model>)"
  const android = s.match(/Android[^;]*;\s*([^;)]+?)(?:\s+Build\/|[;)])/i);
  if (android?.[1]) {
    const model = android[1].trim().replace(/\s+/g, " ");
    if (model && !/^(wv|Mobile|U|Linux|arm(?:_?[a-z0-9]+)?)$/i.test(model)) {
      return model.slice(0, 64);
    }
  }

  // Classic iOS UA sometimes embeds hardware id (rare in modern Safari)
  const iosHw = s.match(/\((iPhone|iPad|iPod)[^;]*;\s*([^;)]+)\)/i);
  if (iosHw?.[2] && /iPhone\d/i.test(iosHw[2])) {
    return iosHw[2].trim().slice(0, 64);
  }

  return null;
}

/**
 * Try to read the device model without prompting the user.
 * Prefer UA Client Hints (Chromium/Android), then UA heuristics.
 * Returns { model, source } — model is null when the browser hides it (typical iOS).
 */
export async function detectDeviceModel(nav = typeof navigator !== "undefined" ? navigator : {}) {
  const uaData = nav.userAgentData;
  if (uaData?.getHighEntropyValues) {
    try {
      const hints = await uaData.getHighEntropyValues(["model", "platformVersion"]);
      const model = String(hints?.model || "").trim();
      if (model) {
        return {
          model: model.slice(0, 64),
          source: "ua_client_hints",
          platform: uaData.platform || null,
          platformVersion: hints.platformVersion || null,
          mobile: uaData.mobile ?? null,
        };
      }
    } catch {
      /* hints may be denied */
    }
  }

  const fromUa = guessDeviceModelFromUa(nav.userAgent || "");
  if (fromUa) {
    return { model: fromUa, source: "user_agent" };
  }

  const ua = String(nav.userAgent || "");
  if (/iPhone/i.test(ua)) return { model: null, source: "unavailable", family: "iPhone" };
  if (/iPad/i.test(ua)) return { model: null, source: "unavailable", family: "iPad" };
  return { model: null, source: "unavailable", family: null };
}

export function deviceInfo(overrides = {}) {
  const nav = typeof navigator !== "undefined" ? navigator : {};
  const model = overrides.model != null ? String(overrides.model).trim().slice(0, 64) : null;
  return {
    userAgent: String(nav.userAgent || "").slice(0, 240),
    platform: String(nav.platform || ""),
    language: String(nav.language || ""),
    deviceMemory: nav.deviceMemory ?? null,
    hardwareConcurrency: nav.hardwareConcurrency ?? null,
    model: model || null,
    modelSource: overrides.modelSource || (model ? "user" : null),
    modelFamily: overrides.modelFamily || null,
  };
}

function peakOf(series, key) {
  let max = 0;
  for (const p of series || []) {
    const v = Number(p?.[key]);
    if (Number.isFinite(v) && v > max) max = v;
  }
  return max;
}

/** Summary metrics derived from raw streams (always exported with a session). */
export function buildMeasurementOutputs(session = {}) {
  const gps = session.gps || [];
  const motion = session.motion || [];
  const fused = session.fused || [];
  const accuracies = gps.map((p) => p.accuracy).filter((n) => Number.isFinite(n));
  const fusedPeak = Math.max(peakOf(fused, "fusedSpeedKmh"), peakOf(fused, "speedKmh"), peakOf(gps, "fusedSpeedKmh"));
  return {
    durationMs: Number(session.durationMs) || 0,
    score: session.score ?? null,
    scoreStatus: session.scoreStatus || null,
    scoreNoteHe: session.scoreNoteHe || "",
    sampleCounts: {
      gps: gps.length,
      motion: motion.length,
      fused: fused.length,
    },
    maxSpeedKmh: Math.round(peakOf(gps, "speedKmh") * 10) / 10,
    maxFusedSpeedKmh: Math.round(fusedPeak * 10) / 10,
    meanGpsAccuracyM:
      accuracies.length > 0
        ? Math.round((accuracies.reduce((a, b) => a + b, 0) / accuracies.length) * 10) / 10
        : null,
  };
}

/**
 * Placeholder accuracy score until a real model / reference DB is wired.
 * Returns 0–100 when a heuristic can run; otherwise null + pending status.
 */
export function scoreTechniqueSession({ gps = [], motion = [], durationMs = 0, exercise } = {}) {
  const status = exercise?.scoring?.status || "pending_model";
  if (status === "pending_model" || !exercise?.scoring?.modelId) {
    const completed = isCompletedTechniqueSession({ motion, durationMs });
    return {
      score: completed ? PROVISIONAL_TECHNIQUE_ACCURACY : null,
      scoreStatus: "pending_model",
      modelId: null,
      noteHe: completed
        ? `ציון זמני קבוע (${PROVISIONAL_TECHNIQUE_ACCURACY}%) — יוחלף במדידות דיוק לכל תרגיל.`
        : "המדידה קצרה מדי — בצעו שוב את התרגיל.",
    };
  }
  return {
    score: null,
    scoreStatus: "pending_model",
    modelId: exercise.scoring.modelId,
    noteHe: "מודל עדיין לא זמין במכשיר.",
  };
}

function isCompletedTechniqueSession({ motion = [], durationMs = 0 } = {}) {
  if (!motion?.length || durationMs < 1500) return false;
  const acc = motion.map((m) => m.accMag ?? 0).filter((n) => Number.isFinite(n));
  return acc.length >= 8;
}

export function buildTechniqueExport(session) {
  const exercise = session.exercise || {};
  const layout = exercise.coneLayout || {};
  const device = {
    ...deviceInfo(),
    ...(session.device || {}),
  };
  if (!device.model && session.deviceModel) {
    device.model = String(session.deviceModel).trim().slice(0, 64);
    device.modelSource = device.modelSource || "user";
  }
  const outputs = buildMeasurementOutputs(session);
  return {
    schemaVersion: 2,
    kind: "technique_session",
    exportedAt: new Date().toISOString(),
    participantName: session.participantName || "",
    exerciseId: exercise.id || session.exerciseId,
    exerciseName: exercise.name || session.exerciseName || "",
    exerciseDescription: exercise.description || session.exerciseDescription || "",
    label: session.label || "unlabeled",
    phonePlacement: session.phonePlacement || "pocket",
    coneLayout: {
      count: Number(layout.count) || 0,
      spacingMeters: Number(layout.spacingMeters) || 0,
      pattern: layout.pattern || "straight_line",
    },
    startedAt: session.startedAt || null,
    durationMs: session.durationMs || 0,
    score: session.score ?? null,
    scoreStatus: session.scoreStatus || "pending_model",
    scoreNoteHe: session.scoreNoteHe || "",
    device,
    outputs,
    // Full measurement streams for offline analysis / model training
    measurements: {
      gps: session.gps || [],
      motion: session.motion || [],
      fused: session.fused || [],
    },
    // Top-level aliases kept for backward-compatible consumers
    gps: session.gps || [],
    motion: session.motion || [],
    fused: session.fused || [],
    fusionDebug: session.fusionDebug || null,
    meta: session.meta || {},
  };
}

export function techniqueWhatsAppSummary(exp) {
  const score =
    exp.score == null || Number.isNaN(Number(exp.score))
      ? "ממתין למודל"
      : `${exp.score}/100 (זמני)`;
  const counts = exp.outputs?.sampleCounts || {
    gps: exp.gps?.length || 0,
    motion: exp.motion?.length || 0,
    fused: exp.fused?.length || 0,
  };
  return [
    `Sprint Max — מדידת טכניקה`,
    `משתתף: ${exp.participantName || "—"}`,
    `דגם מכשיר: ${exp.device?.model || "—"}`,
    `תרגיל: ${exp.exerciseName || exp.exerciseId || "—"}`,
    `זמן: ${formatDurationMs(exp.durationMs)}`,
    `ציון דיוק: ${score}`,
    `קונוסים: ${exp.coneLayout?.count ?? "—"} × ${exp.coneLayout?.spacingMeters ?? "—"} מ׳`,
    `דגימות GPS: ${counts.gps || 0} · תנועה: ${counts.motion || 0} · fused: ${counts.fused || 0}`,
    ``,
    `מצורף קובץ JSON עם כל המדידות ונתוני המכשיר לניתוח.`,
  ].join("\n");
}

function downloadJson(obj, filename) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2500);
}

/**
 * Share measurement to WhatsApp: prefer file share, else download JSON + open wa.me text.
 */
export async function shareTechniqueToWhatsApp(session) {
  const exp = buildTechniqueExport(session);
  const text = techniqueWhatsAppSummary(exp);
  const safeName = String(exp.participantName || "anon")
    .replace(/[^\w\u0590-\u05FF-]+/g, "_")
    .slice(0, 24);
  const filename = `sprintmax-${exp.exerciseId || "tech"}-${safeName}-${Date.now()}.json`;
  const file = new File([JSON.stringify(exp, null, 2)], filename, { type: "application/json" });

  if (typeof navigator !== "undefined" && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({
        files: [file],
        title: "Sprint Max — מדידת טכניקה",
        text,
      });
      return "files";
    } catch (err) {
      if (err?.name === "AbortError") return "aborted";
    }
  }

  downloadJson(exp, filename);
  const wa = `https://wa.me/?text=${encodeURIComponent(text)}`;
  if (typeof window !== "undefined") {
    window.open(wa, "_blank", "noopener");
  }
  return "download-wa";
}

/** Minimum execution accuracy (%) for a technique time to count as a personal record. */
export const TECHNIQUE_RECORD_MIN_ACCURACY = 90;

/** Alias used by chart filters and technique history labels. */
export const TECHNIQUE_CHART_MIN_SCORE = TECHNIQUE_RECORD_MIN_ACCURACY;

/** Placeholder accuracy (%) for completed drills until per-exercise calibration exists. */
export const PROVISIONAL_TECHNIQUE_ACCURACY = 90;

/**
 * Execution accuracy for chart eligibility and history labels.
 * Until a real model exists, completed pending_model sessions use the provisional 90%.
 */
export function techniqueExecutionAccuracy(session) {
  if (!session) return 0;
  const durationMs = Number(session.durationMs);
  const completed = Number.isFinite(durationMs) && durationMs >= 1500;
  const status = session.scoreStatus || session.exercise?.scoring?.status || "pending_model";

  if (status === "pending_model" && completed) {
    return PROVISIONAL_TECHNIQUE_ACCURACY;
  }

  const score = Number(session.score);
  if (Number.isFinite(score)) return score;
  if (!("score" in session) && completed) return PROVISIONAL_TECHNIQUE_ACCURACY;
  return 0;
}

export function isEligibleTechniqueTimeRecord(session, exerciseId) {
  if (!session || session.excludeFromPr) return false;
  if (exerciseId && session.exerciseId !== exerciseId) return false;
  const durationMs = Number(session.durationMs);
  if (!Number.isFinite(durationMs) || durationMs <= 0) return false;
  return techniqueExecutionAccuracy(session) >= TECHNIQUE_RECORD_MIN_ACCURACY;
}

/**
 * Walk sessions oldest → newest and keep only new personal bests (fastest time).
 * @returns {{ id: string, at: string, durationMs: number, durationSec: number, accuracy: number, session: object }[]}
 */
export function ascendingTechniqueTimeRecords(sessions, exerciseId) {
  const chronological = [...(sessions || [])]
    .filter((s) => isEligibleTechniqueTimeRecord(s, exerciseId))
    .sort((a, b) => String(a.at || "").localeCompare(String(b.at || "")));

  const points = [];
  let bestMs = Infinity;
  for (const session of chronological) {
    const durationMs = Number(session.durationMs);
    if (durationMs < bestMs - 49) {
      bestMs = durationMs;
      points.push({
        id: session.id,
        at: session.at,
        durationMs,
        durationSec: durationMs / 1000,
        accuracy: techniqueExecutionAccuracy(session),
        session,
      });
    }
  }
  return points;
}

/** Sessions for one exercise, newest first (event history). */
export function techniqueHistoryRows(sessions, exerciseId) {
  return [...(sessions || [])]
    .filter((s) => s && (!exerciseId || s.exerciseId === exerciseId))
    .sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")));
}

export function techniqueExerciseHistory(sessions, exerciseId) {
  return techniqueHistoryRows(sessions, exerciseId);
}

/** Series of score / duration points for improvement charts. */
export function techniqueChartPoints(sessions, exerciseId, metric = "score", options = {}) {
  const minScore = options.minScore;
  const list = [...(sessions || [])]
    .filter((s) => s && (!exerciseId || s.exerciseId === exerciseId))
    .filter((s) => {
      if (minScore == null) return true;
      return Number.isFinite(s.score) && s.score >= minScore;
    })
    .sort((a, b) => String(a.at || "").localeCompare(String(b.at || "")));

  return list
    .map((s) => {
      let value = null;
      if (metric === "score") {
        value = Number.isFinite(s.score) ? s.score : null;
      } else if (metric === "durationSec") {
        value = Number.isFinite(s.durationMs) ? s.durationMs / 1000 : null;
      }
      if (value == null) return null;
      return { id: s.id, at: s.at, value, score: s.score ?? null, session: s };
    })
    .filter(Boolean);
}

export function conePositions(layout = {}) {
  const count = Math.max(0, Math.min(30, Number(layout.count) || 0));
  const spacing = Math.max(0.1, Number(layout.spacingMeters) || 1);
  const positions = [];
  for (let i = 0; i < count; i++) {
    positions.push({ index: i + 1, metersFromStart: i * spacing });
  }
  return {
    count,
    spacingMeters: spacing,
    pattern: layout.pattern || "straight_line",
    totalLengthMeters: count > 1 ? (count - 1) * spacing : 0,
    positions,
  };
}
