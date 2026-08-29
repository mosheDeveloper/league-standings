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

export function deviceInfo() {
  const nav = typeof navigator !== "undefined" ? navigator : {};
  return {
    userAgent: String(nav.userAgent || "").slice(0, 240),
    platform: String(nav.platform || ""),
    language: String(nav.language || ""),
    deviceMemory: nav.deviceMemory ?? null,
    hardwareConcurrency: nav.hardwareConcurrency ?? null,
  };
}

/**
 * Placeholder accuracy score until a real model / reference DB is wired.
 * Returns 0–100 when a heuristic can run; otherwise null + pending status.
 */
export function scoreTechniqueSession({ gps = [], motion = [], durationMs = 0, exercise } = {}) {
  const status = exercise?.scoring?.status || "pending_model";
  if (status === "pending_model" || !exercise?.scoring?.modelId) {
    const provisional = provisionalMotionScore(motion, durationMs);
    return {
      score: provisional,
      scoreStatus: "pending_model",
      modelId: null,
      noteHe: "ציון זמני לפי תנועת מכשיר בלבד — יוחלף בהשוואה למודל ול־DB.",
    };
  }
  return {
    score: null,
    scoreStatus: "pending_model",
    modelId: exercise.scoring.modelId,
    noteHe: "מודל עדיין לא זמין במכשיר.",
  };
}

function provisionalMotionScore(motion, durationMs) {
  if (!motion?.length || durationMs < 1500) return null;
  const acc = motion.map((m) => m.accMag ?? 0).filter((n) => Number.isFinite(n));
  if (acc.length < 8) return null;
  const mean = acc.reduce((s, x) => s + x, 0) / acc.length;
  const variance = acc.reduce((s, x) => s + (x - mean) ** 2, 0) / acc.length;
  const std = Math.sqrt(variance);
  // Soft map: still phone → low; lively footwork → higher. Cap 0–100.
  const raw = ((std - 0.4) / 4.5) * 100;
  return Math.max(0, Math.min(100, Math.round(raw)));
}

export function buildTechniqueExport(session) {
  const exercise = session.exercise || {};
  const layout = exercise.coneLayout || {};
  return {
    schemaVersion: 1,
    kind: "technique_session",
    exportedAt: new Date().toISOString(),
    participantName: session.participantName || "",
    exerciseId: exercise.id || session.exerciseId,
    exerciseName: exercise.name || session.exerciseName || "",
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
    device: session.device || deviceInfo(),
    gps: session.gps || [],
    motion: session.motion || [],
    meta: session.meta || {},
  };
}

export function techniqueWhatsAppSummary(exp) {
  const score =
    exp.score == null || Number.isNaN(Number(exp.score))
      ? "ממתין למודל"
      : `${exp.score}/100 (זמני)`;
  return [
    `Sprint Max — מדידת טכניקה`,
    `משתתף: ${exp.participantName || "—"}`,
    `תרגיל: ${exp.exerciseName || exp.exerciseId || "—"}`,
    `זמן: ${formatDurationMs(exp.durationMs)}`,
    `ציון דיוק: ${score}`,
    `קונוסים: ${exp.coneLayout?.count ?? "—"} × ${exp.coneLayout?.spacingMeters ?? "—"} מ׳`,
    `דגימות GPS: ${exp.gps?.length || 0} · תנועה: ${exp.motion?.length || 0}`,
    ``,
    `מצורף קובץ JSON עם נתוני המכשיר לניתוח.`,
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

/** Minimum accuracy (%) required for a technique attempt to enter the improve chart. */
export const TECHNIQUE_CHART_MIN_SCORE = 90;

/**
 * Series of score / duration points for improvement charts.
 * @param {{ minScore?: number|null }} [options] When set, only sessions with score > minScore are included.
 */
export function techniqueChartPoints(sessions, exerciseId, metric = "score", options = {}) {
  const minScore = options.minScore;
  const list = [...(sessions || [])]
    .filter((s) => s && (!exerciseId || s.exerciseId === exerciseId))
    .filter((s) => {
      if (minScore == null) return true;
      return Number.isFinite(s.score) && s.score > minScore;
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

/** Sessions for an exercise history table (all attempts, newest first). */
export function techniqueHistoryRows(sessions, exerciseId) {
  return [...(sessions || [])]
    .filter((s) => s && (!exerciseId || s.exerciseId === exerciseId))
    .sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")));
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
