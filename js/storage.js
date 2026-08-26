const OVERLAY_KEY = "runspeed.tables.overlay.v1";
const SELECTED_KEY = "runspeed.selectedTable";
const PROFILE_KEY = "runspeed.profile.v1";
const HISTORY_KEY = "runspeed.history.v1";

export async function loadIndex() {
  const res = await fetch("./data/tables-index.json", { cache: "no-store" });
  if (!res.ok) throw new Error("לא ניתן לטעון את רשימת הטבלאות");
  return res.json();
}

export async function fetchDefaultTable(file) {
  const res = await fetch(`./data/${file}`, { cache: "no-store" });
  if (!res.ok) throw new Error("לא ניתן לטעון טבלה");
  return res.json();
}

export function getOverlay() {
  try {
    return JSON.parse(localStorage.getItem(OVERLAY_KEY) || "{}");
  } catch {
    return {};
  }
}

export function setOverlayTable(id, table) {
  const o = getOverlay();
  o[id] = table;
  localStorage.setItem(OVERLAY_KEY, JSON.stringify(o));
}

export function clearOverlayTable(id) {
  const o = getOverlay();
  delete o[id];
  localStorage.setItem(OVERLAY_KEY, JSON.stringify(o));
}

export function exportOverlay() {
  return JSON.stringify(getOverlay(), null, 2);
}

export function importOverlay(text) {
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== "object") throw new Error("JSON לא תקין");
  localStorage.setItem(OVERLAY_KEY, JSON.stringify(parsed));
}

export async function resolveTable(meta) {
  const overlay = getOverlay();
  if (overlay[meta.id]) return overlay[meta.id];
  return fetchDefaultTable(meta.file);
}

export function getSelectedTableId(fallback) {
  return localStorage.getItem(SELECTED_KEY) || fallback;
}

export function setSelectedTableId(id) {
  localStorage.setItem(SELECTED_KEY, id);
}

export function loadProfile() {
  try {
    return JSON.parse(localStorage.getItem(PROFILE_KEY) || "null");
  } catch {
    return null;
  }
}

export function saveProfile(profile) {
  localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
}

export function loadHistory() {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
  } catch {
    return [];
  }
}

export function pushHistory(entry) {
  const h = loadHistory();
  h.unshift(entry);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(h.slice(0, 40)));
}
