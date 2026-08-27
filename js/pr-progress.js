/** Ascending personal-record series for the history improvement chart. */

export function runSpeedKmh(run) {
  const n = Number(run?.analysis?.maxSpeedKmh ?? run?.maxKmh);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function isEligiblePrRun(run) {
  if (!run || run.excludeFromPr) return false;
  if (run.mode === "sim-car") return false;
  if (run.analysis && run.analysis.valid === false) return false;
  return runSpeedKmh(run) > 0;
}

/**
 * Walk runs oldest → newest and keep only new personal bests.
 * @returns {{ id: string, at: string, maxKmh: number, run: object }[]}
 */
export function ascendingPersonalRecords(runs) {
  const chronological = [...(runs || [])]
    .filter(isEligiblePrRun)
    .sort((a, b) => String(a.at || "").localeCompare(String(b.at || "")));

  const points = [];
  let best = 0;
  for (const run of chronological) {
    const maxKmh = runSpeedKmh(run);
    if (maxKmh > best + 0.049) {
      best = maxKmh;
      points.push({
        id: run.id,
        at: run.at,
        maxKmh,
        run,
      });
    }
  }
  return points;
}

export function formatPrDate(iso) {
  try {
    return new Date(iso).toLocaleDateString("he-IL", {
      day: "numeric",
      month: "short",
      year: "2-digit",
    });
  } catch {
    return "";
  }
}
