const KEYS = {
  runs: "sprint.max.runs",
  tableId: "sprint.max.tableId",
  overrides: "sprint.max.overrides",
  name: "sprint.max.displayName",
};

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
    return localStorage.getItem(KEYS.tableId) || "football-stars";
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
};
