const KEYS = {
  runs: "sprint.max.runs",
  tableId: "sprint.max.tableId",
  overrides: "sprint.max.overrides",
  name: "sprint.max.displayName",
  compareFilters: "sprint.max.compareFilters",
};

const EMPTY_FILTERS = { sport: null, leagueId: null, team: null };

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function ensureRunId(run, index = 0) {
  if (run?.id) return run;
  return {
    ...run,
    id: `run_${String(run?.at || "x").replace(/\W/g, "")}_${index}`,
  };
}

export const Store = {
  getName() {
    return localStorage.getItem(KEYS.name) || "";
  },
  setName(name) {
    localStorage.setItem(KEYS.name, name.trim());
  },
  getTableId() {
    return localStorage.getItem(KEYS.tableId) || "premier-league";
  },
  setTableId(id) {
    localStorage.setItem(KEYS.tableId, id);
  },
  getRuns() {
    const runs = read(KEYS.runs, []);
    let changed = false;
    const withIds = runs.map((r, i) => {
      if (r?.id) return r;
      changed = true;
      return ensureRunId(r, i);
    });
    if (changed) write(KEYS.runs, withIds);
    return withIds;
  },
  addRun(run) {
    const runs = Store.getRuns();
    const entry = ensureRunId(
      {
        ...run,
        id: run.id || `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      },
      0
    );
    runs.unshift(entry);
    write(KEYS.runs, runs.slice(0, 80));
    return runs;
  },
  patchRun(id, patch) {
    const runs = Store.getRuns();
    const idx = runs.findIndex((r) => r.id === id);
    if (idx < 0) return null;
    runs[idx] = { ...runs[idx], ...patch };
    write(KEYS.runs, runs);
    return runs[idx];
  },
  excludeFromPr(id) {
    return Store.patchRun(id, { excludeFromPr: true });
  },
  verifiedRuns() {
    return Store.getRuns().filter(
      (r) => r.analysis?.valid && r.mode !== "sim-car" && !r.excludeFromPr
    );
  },
  getOverrides() {
    return read(KEYS.overrides, {});
  },
  setOverride(tableId, table) {
    const all = Store.getOverrides();
    all[tableId] = table;
    write(KEYS.overrides, all);
  },
  clearOverride(tableId) {
    const all = Store.getOverrides();
    delete all[tableId];
    write(KEYS.overrides, all);
  },
  getCompareFilters() {
    const raw = read(KEYS.compareFilters, null);
    if (!raw || typeof raw !== "object") return { ...EMPTY_FILTERS };
    return {
      sport: raw.sport || null,
      leagueId: raw.leagueId || null,
      team: raw.team || null,
    };
  },
  setCompareFilters(filters) {
    write(KEYS.compareFilters, {
      sport: filters?.sport || null,
      leagueId: filters?.leagueId || null,
      team: filters?.team || null,
    });
  },
};
