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
    return read(KEYS.runs, []);
  },
  addRun(run) {
    const runs = Store.getRuns();
    runs.unshift(run);
    write(KEYS.runs, runs.slice(0, 80));
    return runs;
  },
  verifiedRuns() {
    return Store.getRuns().filter((r) => r.analysis?.valid && r.mode !== "sim-car");
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
