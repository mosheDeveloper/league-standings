export const SPORT_LABELS = {
  football: "כדורגל",
  athletics: "אתלטיקה",
  basketball: "כדורסל",
};

export function sportLabel(sport) {
  return SPORT_LABELS[sport] || sport || "ספורט";
}

export function rankAgainstTable(maxSpeedKmh, tableOrAthletes) {
  const athletes = (
    Array.isArray(tableOrAthletes)
      ? [...tableOrAthletes]
      : [...(tableOrAthletes?.athletes || [])]
  ).sort((a, b) => b.maxSpeedKmh - a.maxSpeedKmh);
  const beaten = athletes.filter((a) => maxSpeedKmh > a.maxSpeedKmh);
  const fasterThan = beaten[0] || null;
  const ahead = athletes.filter((a) => a.maxSpeedKmh >= maxSpeedKmh);
  const nextTarget = ahead.length ? ahead[ahead.length - 1] : null;
  const place = ahead.length + 1;
  return {
    athletes,
    beaten,
    fasterThan,
    nextTarget,
    place,
    total: athletes.length + 1,
    percentile: athletes.length
      ? Math.round((beaten.length / athletes.length) * 100)
      : 0,
  };
}

/** Merge athletes from catalog tables with optional sport / league / team filters. */
export function buildAthletePool(tablesMap, catalogTables, filters = {}) {
  const sport = filters.sport || null;
  const leagueId = filters.leagueId || null;
  const team = filters.team || null;

  const metas = (catalogTables || []).filter((t) => {
    if (sport && t.sport !== sport) return false;
    if (leagueId && t.id !== leagueId) return false;
    return true;
  });

  const byId = new Map();
  for (const meta of metas) {
    const table = tablesMap?.[meta.id];
    if (!table) continue;
    for (const ath of table.athletes || []) {
      if (!ath || !Number.isFinite(ath.maxSpeedKmh)) continue;
      if (team && (ath.team || "") !== team) continue;
      const enriched = {
        ...ath,
        sport: meta.sport || table.sport || ath.sport,
        leagueId: meta.id,
        leagueName: meta.name || meta.title || table.name || table.title || meta.id,
      };
      const key = ath.id || `${meta.id}:${ath.name}:${ath.maxSpeedKmh}`;
      const prev = byId.get(key);
      if (!prev || enriched.maxSpeedKmh > prev.maxSpeedKmh) {
        byId.set(key, enriched);
      }
    }
  }

  return [...byId.values()].sort(
    (a, b) => b.maxSpeedKmh - a.maxSpeedKmh || String(a.name).localeCompare(String(b.name), "he")
  );
}

export function listSports(catalogTables) {
  const seen = new Set();
  const out = [];
  for (const t of catalogTables || []) {
    if (!t.sport || seen.has(t.sport)) continue;
    seen.add(t.sport);
    out.push(t.sport);
  }
  return out;
}

export function listLeagues(catalogTables, sport = null) {
  return (catalogTables || [])
    .filter((t) => !sport || t.sport === sport)
    .map((t) => ({
      id: t.id,
      name: t.name || t.title || t.id,
      sport: t.sport,
    }));
}

export function listTeams(athletes) {
  const seen = new Set();
  const out = [];
  for (const a of athletes || []) {
    const team = (a.team || "").trim();
    if (!team || seen.has(team)) continue;
    seen.add(team);
    out.push(team);
  }
  return out.sort((a, b) => a.localeCompare(b, "he"));
}

/** Options for cascading filters — teams derived from sport+league scope (team filter ignored). */
export function filterOptions(tablesMap, catalogTables, filters = {}) {
  const sports = listSports(catalogTables);
  const leagues = listLeagues(catalogTables, filters.sport || null);
  const poolForTeams = buildAthletePool(tablesMap, catalogTables, {
    sport: filters.sport || null,
    leagueId: filters.leagueId || null,
    team: null,
  });
  const teams = listTeams(poolForTeams);
  return { sports, leagues, teams };
}

export function describeFilters(filters, catalogTables) {
  const parts = [];
  if (filters?.sport) parts.push(sportLabel(filters.sport));
  if (filters?.leagueId) {
    const league = (catalogTables || []).find((t) => t.id === filters.leagueId);
    parts.push(league?.name || league?.title || filters.leagueId);
  }
  if (filters?.team) parts.push(filters.team);
  return parts.length ? parts.join(" · ") : "כל הספורטאים";
}

export function shareMessage(maxSpeedKmh, comparison, tableName) {
  const speed = formatSpeed(maxSpeedKmh);
  if (comparison.fasterThan) {
    return `אתה יותר מהיר מ-${comparison.fasterThan.name}. מהירות הריצה המקסימאלית היא: ${speed}`;
  }
  if (comparison.nextTarget) {
    return `עדיין מאחורי ${comparison.nextTarget.name} — אבל קרוב. מהירות הריצה המקסימאלית היא: ${speed}`;
  }
  return `מהירות הריצה המקסימאלית היא: ${speed} (${tableName})`;
}

export function formatSpeed(kmh) {
  const n = Number(kmh);
  if (!Number.isFinite(n)) return "0 קמ״ש";
  const rounded = Math.round(n * 10) / 10;
  const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  return `${text} קמ״ש`;
}
