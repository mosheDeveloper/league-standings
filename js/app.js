import { analyzeRun, buildProfile } from "./anticheat.js";
import {
  rankAgainstTable,
  buildAthletePool,
  filterOptions,
  describeFilters,
  sportLabel,
} from "./compare.js";
import { Tracker, probeGps } from "./tracker.js";
import { Store } from "./store.js";
import { buildSharePayload, shareToPlatform, drawStoryCard } from "./share.js";
import { buildBoards, bestVerifiedKmh, canSeeFriends } from "./records.js";
import {
  getSession,
  saveSession,
  clearSession,
  loadAuthConfig,
  loginWithMeta,
  localConsentSession,
  guestSession,
} from "./auth.js";

const $ = (id) => document.getElementById(id);

const state = {
  catalog: null,
  tables: {},
  selectedId: "football-stars",
  mode: "run",
  tracker: null,
  gpsOk: false,
  lastResult: null,
  recordsCatalog: null,
  session: null,
  recordsTab: "local",
  authConfig: null,
  compareFilters: { sport: null, leagueId: null, team: null },
};

function toast(msg) {
  const el = $("toast");
  if (!el) return;
  el.hidden = false;
  el.textContent = msg;
  el.classList.add("show");
  setTimeout(() => {
    el.classList.remove("show");
  }, 2200);
}

function showView(name) {
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.dataset.view === name));
  document.querySelectorAll("nav.tabbar button").forEach((b) =>
    b.classList.toggle("active", b.dataset.view === name)
  );
  document.body.classList.toggle("run-mode", name === "run");
}

function tableTitle(t) {
  return t?.title || t?.name || "";
}

function greet() {
  const name = state.session?.name || Store.getName();
  const el = $("greet");
  if (el) el.textContent = name ? `היי ${name} 👋` : "היי 👋";
}

function renderAccountBtn() {
  const btn = $("btn-account");
  if (!btn) return;
  if (!state.session) btn.textContent = "כניסה";
  else if (state.session.guest) btn.textContent = "אורח";
  else btn.textContent = state.session.name || "חשבון";
  const logout = $("btn-logout");
  if (logout) logout.hidden = !state.session;
  const title = $("login-title");
  if (title) title.textContent = state.session ? "החשבון שלי" : "התחברות";
  if (state.session?.name && $("login-name")) $("login-name").value = state.session.name;
}

function myBest() {
  return bestVerifiedKmh(Store.verifiedRuns());
}

function renderRecords() {
  if (!state.recordsCatalog) return;
  const boards = buildBoards({
    catalog: state.recordsCatalog,
    session: state.session,
    myKmh: myBest(),
  });
  const key = state.recordsTab;
  const board = boards[key];
  const titles = {
    local: `שיאי ${boards.countryLabel}`,
    global: "שיאים עולמיים",
    friends: "שיאי חברים",
  };
  $("records-sub").textContent = titles[key] || "";
  if (key === "friends" && !canSeeFriends(state.session)) {
    $("records-place").textContent = "צריך להתחבר כדי להשוות עם חברים";
    const guestNote = state.session?.guest
      ? `<p class="friends-gate-sub">כרגע אתם כאורח${
          state.session.name && state.session.name !== "אורח" ? ` (${state.session.name})` : ""
        }. אורח לא כולל רשימת חברים.</p>`
      : `<p class="friends-gate-sub">בלי חיבור לפייסבוק או אינסטגרם אי אפשר להשוות שיאים מול חברים.</p>`;
    $("records-list").innerHTML = `
      <li class="friends-gate">
        <p>התחברו עם פייסבוק או אינסטגרם כדי לראות מי מהחברים רץ מהר יותר — ולהופיע אצלם בטבלה.</p>
        ${guestNote}
        <button type="button" class="social-login fb" id="btn-records-login">התחברות לפייסבוק / אינסטגרם</button>
      </li>`;
    $("btn-records-login")?.addEventListener("click", openLogin);
    return;
  }
  if (board.place) {
    const where =
      key === "local" ? `ב${boards.countryLabel}` : key === "friends" ? "בין החברים" : "בעולם";
    $("records-place").textContent = `את/ה במקום ${board.place} מתוך ${board.total} ${where}. שיא: ${myBest().toFixed(1)} קמ״ש`;
  } else if (state.session) {
    $("records-place").textContent = "עדיין אין שיא מאושר — סיימו ריצה תקינה כדי להיכנס ללוח.";
  } else {
    $("records-place").textContent = "התחברו כדי לשמור את השיא שלכם מול המדינה והעולם.";
  }
  if (!board.sorted.length) {
    $("records-list").innerHTML = `<li>אין עדיין שיאים בלוח הזה.</li>`;
    return;
  }
  $("records-list").innerHTML = board.sorted
    .map((u, i) => {
      const you = u.id === state.session?.id;
      return `<li class="${you ? "you" : ""}"><span>${i + 1}. ${u.name}${you ? " · את/ה" : ""}</span><b>${Number(u.maxSpeedKmh).toFixed(1)}</b></li>`;
    })
    .join("");
}

function openLogin() {
  renderAccountBtn();
  $("login-sheet").hidden = false;
}
function closeLogin() {
  $("login-sheet").hidden = true;
}

async function finishLogin(session) {
  state.session = session;
  saveSession(session);
  Store.setName(session.name);
  greet();
  renderAccountBtn();
  renderRecords();
  closeLogin();
  if (session.guest) {
    toast("נכנסתם כאורח. שיאי חברים זמינים אחרי חיבור לפייסבוק או אינסטגרם.");
  } else {
    toast(session.friendsFromApi ? "מחוברים · נטענו חברים" : "מחוברים");
  }
}

async function onMetaLogin(provider) {
  try {
    const session = await loginWithMeta(provider, state.authConfig);
    await finishLogin(session);
  } catch (err) {
    if (err?.message === "cancelled") return;
    const name = $("login-name").value || Store.getName();
    const session = localConsentSession(provider, name);
    session.friends = (state.recordsCatalog?.sampleFriends || []).map((f) => ({
      id: f.id,
      name: f.name,
      country: f.country,
      maxSpeedKmh: f.maxSpeedKmh,
    }));
    await finishLogin(session);
    toast("Meta לא הוגדר עדיין — התחברות מקומית. הזינו App ID ב-data/auth.json לחיבור אמיתי.");
  }
}

async function loadCatalog() {
  const res = await fetch("./data/tables.json", { cache: "no-store" });
  if (!res.ok) throw new Error("לא ניתן לטעון טבלאות");
  return res.json();
}

async function fetchTable(meta) {
  const overrides = Store.getOverrides();
  if (overrides[meta.id]) return overrides[meta.id];
  const res = await fetch(`./${meta.file}`.replace(/^\.\//, "./"), { cache: "no-store" });
  if (!res.ok) throw new Error("טבלה חסרה");
  return res.json();
}

async function ensureTable(id) {
  const meta = state.catalog.tables.find((t) => t.id === id);
  if (!meta) throw new Error("טבלה לא נמצאה");
  state.tables[id] = await fetchTable(meta);
  return state.tables[id];
}

function sportMark(sport) {
  return { football: "⚽", athletics: "🏃", basketball: "🏀" }[sport] || "🏅";
}

function fillSelects() {
  if (!state.catalog) return;
  const opts = state.catalog.tables
    .map((t) => `<option value="${t.id}">${t.name || t.title}</option>`)
    .join("");
  if ($("table-select")) {
    $("table-select").innerHTML = opts;
    $("table-select").value = state.selectedId;
  }
  if ($("editor-select")) {
    $("editor-select").innerHTML = opts;
    $("editor-select").value = state.selectedId;
  }
}

function renderLeagues() {
  renderFilterChips();
  renderLeaguesCardsOnly();
  renderAthleteCompare();
}

function chipHtml(label, on, attrs) {
  return `<button type="button" class="league-chip ${on ? "on" : ""}" ${attrs}>${label}</button>`;
}

function escAttr(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}

function sanitizeCompareFilters(filters) {
  const next = {
    sport: filters?.sport || null,
    leagueId: filters?.leagueId || null,
    team: filters?.team || null,
  };
  const opts = filterOptions(state.tables, state.catalog?.tables || [], next);
  if (next.sport && !opts.sports.includes(next.sport)) next.sport = null;
  if (next.leagueId && !opts.leagues.some((l) => l.id === next.leagueId)) {
    next.leagueId = null;
  }
  const teamOpts = filterOptions(state.tables, state.catalog?.tables || [], {
    sport: next.sport,
    leagueId: next.leagueId,
    team: null,
  }).teams;
  if (next.team && !teamOpts.includes(next.team)) next.team = null;
  return next;
}

function setCompareFilters(partial, { syncRunTable = true } = {}) {
  const merged = sanitizeCompareFilters({ ...state.compareFilters, ...partial });
  state.compareFilters = merged;
  Store.setCompareFilters(merged);
  if (syncRunTable && merged.leagueId) {
    state.selectedId = merged.leagueId;
    Store.setTableId(merged.leagueId);
  } else if (syncRunTable && !merged.leagueId && state.catalog?.tables?.length) {
    const match = state.catalog.tables.find((t) => !merged.sport || t.sport === merged.sport);
    if (match) {
      state.selectedId = match.id;
      Store.setTableId(match.id);
    }
  }
  fillSelects();
  renderFilterChips();
  renderLeaguesCardsOnly();
  renderAthleteCompare();
}

function renderLeaguesCardsOnly() {
  const host = $("league-cards");
  if (!host || !state.catalog) return;
  host.innerHTML = state.catalog.tables
    .map((t) => {
      const table = state.tables[t.id];
      const n = table?.athletes?.length ?? "—";
      return `<button type="button" class="league-card ${t.id === state.selectedId ? "on" : ""}" data-id="${t.id}">
        <strong>${sportMark(t.sport)} ${t.name || t.title}</strong>
        <small>${t.blurb || ""} · ${n} ספורטאים</small>
      </button>`;
    })
    .join("");
}

function paintFilterRow(sportHostId, leagueHostId, teamRowId, teamHostId) {
  if (!state.catalog || !$(sportHostId)) return;
  const filters = sanitizeCompareFilters(state.compareFilters);
  state.compareFilters = filters;
  const opts = filterOptions(state.tables, state.catalog.tables, filters);

  $(sportHostId).innerHTML =
    chipHtml("הכל", !filters.sport, 'data-filter="sport" data-value=""') +
    opts.sports
      .map((s) =>
        chipHtml(
          `${sportMark(s)} ${sportLabel(s)}`,
          filters.sport === s,
          `data-filter="sport" data-value="${s}"`
        )
      )
      .join("");

  $(leagueHostId).innerHTML =
    chipHtml("הכל", !filters.leagueId, 'data-filter="league" data-value=""') +
    opts.leagues
      .map((l) =>
        chipHtml(
          l.name,
          filters.leagueId === l.id,
          `data-filter="league" data-value="${l.id}"`
        )
      )
      .join("");

  const teamRow = $(teamRowId);
  if (!opts.teams.length) {
    if (teamRow) teamRow.hidden = true;
  } else if (teamRow) {
    teamRow.hidden = false;
    $(teamHostId).innerHTML =
      chipHtml("הכל", !filters.team, 'data-filter="team" data-value=""') +
      opts.teams
        .map((team) =>
          chipHtml(team, filters.team === team, `data-filter="team" data-value="${escAttr(team)}"`)
        )
        .join("");
  }

  return { filters, opts };
}

function renderFilterChips() {
  const painted = paintFilterRow(
    "filter-sport",
    "filter-league",
    "filter-team-row",
    "filter-team"
  );
  paintFilterRow(
    "home-filter-sport",
    "home-filter-league",
    "home-filter-team-row",
    "home-filter-team"
  );
  const scopeEl = $("home-compare-scope");
  if (scopeEl && painted) {
    const athletes = buildAthletePool(state.tables, state.catalog.tables, painted.filters);
    const scope = describeFilters(painted.filters, state.catalog.tables);
    scopeEl.textContent = `${scope} · ${athletes.length} ספורטאים`;
  }
}

function activeComparisonTable() {
  const filters = sanitizeCompareFilters(state.compareFilters);
  const athletes = buildAthletePool(state.tables, state.catalog?.tables || [], filters);
  const title = describeFilters(filters, state.catalog?.tables || []);
  const base =
    (filters.leagueId && state.tables[filters.leagueId]) ||
    state.tables[state.selectedId] ||
    {};
  return {
    ...base,
    id: filters.leagueId || state.selectedId || "pool",
    title,
    name: title,
    athletes,
    disclaimer:
      (filters.leagueId && state.tables[filters.leagueId]?.disclaimer) ||
      base.disclaimer ||
      "מהירויות משוערות לפי הסינון שנבחר — להשוואה בלבד.",
  };
}

function renderAthleteCompare() {
  if (!state.catalog) return;
  renderFilterChips();
  const filters = sanitizeCompareFilters(state.compareFilters);
  state.compareFilters = filters;

  const athletes = buildAthletePool(state.tables, state.catalog.tables, filters);
  const scope = describeFilters(filters, state.catalog.tables);
  if ($("compare-scope")) {
    $("compare-scope").textContent = `${scope} · ${athletes.length} ספורטאים לפי מהירות`;
  }

  const myKmh = myBest();
  if (!$("compare-place") || !$("compare-ladder")) return;

  if (!athletes.length) {
    $("compare-place").textContent = "אין ספורטאים בסינון הזה — נסו להרחיב.";
    $("compare-ladder").innerHTML = "";
    if ($("compare-disclaimer")) $("compare-disclaimer").textContent = "";
    return;
  }

  if (myKmh > 0) {
    const comparison = rankAgainstTable(myKmh, athletes);
    $("compare-place").textContent = `את/ה במקום ${comparison.place} מתוך ${comparison.total} · שיא: ${myKmh.toFixed(1)} קמ״ש`;
    const items = athletes.map((ath, i) => {
      const meta = [ath.team, ath.leagueName].filter(Boolean).join(" · ");
      return `<li><span>${i + 1}. ${ath.name}<small class="muted"> ${meta}</small></span><b>${Number(ath.maxSpeedKmh).toFixed(1)}</b></li>`;
    });
    const insertAt = athletes.filter((x) => x.maxSpeedKmh >= myKmh).length;
    items.splice(
      insertAt,
      0,
      `<li class="you"><span>את/ה · שיא אישי</span><b>${myKmh.toFixed(1)} קמ״ש</b></li>`
    );
    $("compare-ladder").innerHTML = items.join("");
  } else {
    $("compare-place").textContent = "עדיין אין שיא מאושר — הסולם מציג את הספורטאים. אחרי ריצה תקינה תופיעו כאן.";
    $("compare-ladder").innerHTML = athletes
      .map((ath, i) => {
        const meta = [ath.team, ath.leagueName].filter(Boolean).join(" · ");
        return `<li><span>${i + 1}. ${ath.name}<small class="muted"> ${meta}</small></span><b>${Number(ath.maxSpeedKmh).toFixed(1)}</b></li>`;
      })
      .join("");
  }

  if ($("compare-disclaimer")) {
    if (filters.leagueId) {
      $("compare-disclaimer").textContent = state.tables[filters.leagueId]?.disclaimer || "";
    } else {
      $("compare-disclaimer").textContent =
        "מהירויות משוערות לפי הטבלאות הכלולות — להשוואה בלבד, לא מדידה רשמית אחידה.";
    }
  }
}

function onCompareFilterClick(e) {
  const btn = e.target.closest("[data-filter]");
  if (!btn) return;
  e.preventDefault();
  const kind = btn.dataset.filter;
  const value = btn.dataset.value || null;
  if (kind === "sport") {
    setCompareFilters({ sport: value || null, leagueId: null, team: null });
  } else if (kind === "league") {
    setCompareFilters({ leagueId: value || null, team: null });
  } else if (kind === "team") {
    setCompareFilters({ team: value || null }, { syncRunTable: false });
  }
}

function setGpsUi({ state: gpsState, text, canStart }) {
  const box = $("gps-status");
  if (box) box.dataset.state = gpsState;
  $("gps-status-text").textContent = text;
  $("btn-start").disabled = !canStart;
  state.gpsOk = !!canStart;
}

async function refreshGpsLock() {
  setGpsUi({
    state: "checking",
    text: "בודקים קליטת GPS…",
    canStart: false,
  });
  const probe = await probeGps();
  if (probe.ok) {
    const acc = probe.accuracy != null ? ` · דיוק ${Math.round(probe.accuracy)} מ׳` : "";
    setGpsUi({
      state: "ok",
      text: `מיקום נעול${acc}. אפשר להתחיל ריצה.`,
      canStart: true,
    });
  } else {
    setGpsUi({
      state: "bad",
      text: probe.message,
      canStart: false,
    });
  }
  return probe;
}

function renderProfile() {
  const verified = Store.verifiedRuns();
  const profile = buildProfile(verified.map((r) => r.analysis));
  if (!profile.runs) {
    $("profile-box").textContent = "אין עדיין פרופיל. שלוש ריצות מאושרות ילמדו את קצב הריצה שלך.";
    return;
  }
  $("profile-box").textContent = `${profile.runs} ריצות מאושרות · ממוצע שיא ${profile.mean} קמ״ש. נסיעה ברכב תיחסם אוטומטית.`;
}

function onLive(update) {
  $("live-speed").textContent = (update.speedKmh || 0).toFixed(1);
  $("max-speed").textContent = (update.maxKmh || 0).toFixed(1);
  $("cadence").textContent = update.motion > 8 ? "חי" : "…";
  const s = Math.floor((update.durationMs || 0) / 1000);
  $("live-time").textContent = `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  const ring = $("speed-ring");
  if (ring) ring.style.setProperty("--p", String(Math.min(1, (update.speedKmh || 0) / 36)));
  if (update.gpsError) {
    $("live-status").textContent = "אבד אות GPS — שבו לאוויר הפתוח";
  } else if (update.gpsAccuracy != null) {
    $("live-status").textContent = `מיקום חי · דיוק ${Math.round(update.gpsAccuracy)} מ׳`;
  }
}

async function startRun() {
  if (state.tracker?.active) return;
  const probe = state.gpsOk ? { ok: true } : await refreshGpsLock();
  if (!probe.ok) {
    toast("אין קליטת GPS. שפרו מיקום כדי להתחיל.");
    return;
  }
  $("btn-start").disabled = true;
  $("btn-stop").disabled = false;
  document.body.classList.add("run-mode");
  showView("run");
  $("live-speed").textContent = "0.0";
  $("max-speed").textContent = "0.0";
  $("live-time").textContent = "00:00";
  $("live-status").textContent = "מחכים למיקום ולתנועת הטלפון";

  state.tracker = new Tracker(onLive);
  try {
    await state.tracker.startLive();
  } catch (e) {
    toast(e.message || "אין GPS");
    $("btn-start").disabled = false;
    $("btn-stop").disabled = true;
    document.body.classList.remove("run-mode");
    showView("home");
    refreshGpsLock();
  }
}

function stopRun() {
  document.body.classList.remove("run-mode");
  $("btn-stop").disabled = true;
  if (!state.tracker) {
    showView("home");
    refreshGpsLock();
    return;
  }
  const session = state.tracker.stop();
  const verified = Store.verifiedRuns();
  const profile = buildProfile(verified.map((r) => r.analysis));
  const analysis = analyzeRun({ ...session, profile });
  const table = activeComparisonTable();
  const comparison = rankAgainstTable(analysis.maxSpeedKmh, table);
  const payload = buildSharePayload(analysis.maxSpeedKmh, comparison, tableTitle(table));
  const share = payload.line;
  const result = {
    at: new Date().toISOString(),
    mode: state.mode,
    tableId: table.id || state.selectedId,
    tableTitle: tableTitle(table),
    filters: { ...state.compareFilters },
    maxKmh: analysis.maxSpeedKmh,
    analysis,
    comparison,
    share,
    payload,
  };
  Store.addRun(result);
  state.lastResult = { ...result, table };
  renderResult();
  showView("result");
  renderProfile();
  renderRecords();
  renderAthleteCompare();
  refreshGpsLock();
}

function renderResult() {
  const r = state.lastResult;
  if (!r) return;
  const a = r.analysis;
  $("result-speed").textContent = Number(r.maxKmh).toFixed(1);
  $("result-place").textContent = `\u202A${r.comparison.place} / ${r.comparison.total}\u202C`;
  const badge = $("result-badge");
  badge.className = "badge " + (a.valid ? "ok" : "bad");
  badge.textContent = a.valid ? "ריצה מאושרת" : "לא אושר — חשד לרכב / רמאות";
  $("result-msg").textContent = a.messageHe;
  $("share-line").textContent = a.valid ? r.share : "לא ניתן לשתף שיא לא מאושר כהישג.";
  $("share-block").hidden = !a.valid;
  $("cadence-out").textContent = `${a.cadenceHz ?? "—"} הרץ · bounce ${a.bounceScore ?? "—"}`;

  const athletes = r.comparison.athletes || [];
  const items = athletes.map(
    (ath, i) => `<li><span>${i + 1}. ${ath.name}<small class="muted"> ${ath.team || ""}</small></span><b>${ath.maxSpeedKmh.toFixed(1)}</b></li>`
  );
  const insertAt = athletes.filter((x) => x.maxSpeedKmh >= r.maxKmh).length;
  items.splice(insertAt, 0, `<li class="you"><span>את/ה</span><b>${Number(r.maxKmh).toFixed(1)} קמ״ש</b></li>`);
  $("rank-list").innerHTML = items.join("");
  $("table-disclaimer").textContent = r.table?.disclaimer || "";

  const canvas = $("share-canvas");
  drawStoryCard(canvas, {
    maxKmh: r.maxKmh,
    playerName: r.comparison.fasterThan?.name || r.comparison.nextTarget?.name,
    tableTitle: r.tableTitle,
    cheat: !a.valid,
    shareLine: r.share,
  });
  $("share-preview").src = canvas.toDataURL("image/png");
}

function openShareSheet() {
  $("share-sheet").hidden = false;
}
function closeShareSheet() {
  $("share-sheet").hidden = true;
}

function renderHistory() {
  const h = Store.getRuns();
  if (!h.length) {
    $("history-list").innerHTML = `<p class="muted">אין ריצות עדיין.</p>`;
    return;
  }
  $("history-list").innerHTML = h
    .map(
      (e) => `<li>
        <span>${new Date(e.at).toLocaleString("he-IL")}<br>
        <small class="muted">${e.tableTitle || ""} · ${e.analysis?.valid ? "אושר" : "לא אושר"}</small></span>
        <b>${Number(e.maxKmh).toFixed(1)} קמ״ש</b>
      </li>`
    )
    .join("");
}

async function openEditor() {
  const id = $("editor-select").value;
  const table = await ensureTable(id);
  $("json-editor").value = JSON.stringify(table, null, 2);
}

function saveEditor() {
  const id = $("editor-select").value;
  let parsed;
  try {
    parsed = JSON.parse($("json-editor").value);
  } catch {
    toast("JSON לא תקין");
    return;
  }
  if (!Array.isArray(parsed.athletes)) {
    toast("חסר מערך athletes");
    return;
  }
  parsed.id = parsed.id || id;
  Store.setOverride(id, parsed);
  state.tables[id] = parsed;
  toast("הטבלה נשמרה במכשיר");
}

async function shareResult(platform) {
  const r = state.lastResult;
  if (!r?.analysis?.valid) return;
  const payload = {
    ...(r.payload || buildSharePayload(r.maxKmh, r.comparison, r.tableTitle)),
    canvas: $("share-canvas"),
  };
  try {
    const how = await shareToPlatform(platform, payload);
    closeShareSheet();
    if (how === "aborted") return;
    if (how === "copied") toast("הטקסט הועתק");
    else if (how === "saved" || how === "download-copy")
      toast("הכרטיס נשמר — הדביקו בסטורי עם הטקסט שהועתק");
    else toast("נפתח לשיתוף");
  } catch (e) {
    if (e?.name === "AbortError") return;
    toast("לא ניתן לשתף מכאן — נסו שמירת תמונה");
  }
}

function wireInstall() {
  let deferred = null;
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e;
    $("btn-install").hidden = false;
  });
  $("btn-install").addEventListener("click", async () => {
    if (!deferred) return;
    deferred.prompt();
    await deferred.userChoice;
    deferred = null;
    $("btn-install").hidden = true;
  });
}

async function pickTable(id) {
  state.selectedId = id;
  Store.setTableId(id);
  try {
    await ensureTable(id);
  } catch {
    /* table may still be loading during early init */
  }
  const meta = state.catalog?.tables?.find((t) => t.id === id);
  setCompareFilters({
    sport: meta?.sport || null,
    leagueId: id,
    team: null,
  });
}

function wireUi() {
  $("league-cards")?.addEventListener("click", (e) => {
    const id = e.target.closest("[data-id]")?.dataset.id;
    if (id) pickTable(id);
  });
  $("compare-filters")?.addEventListener("click", onCompareFilterClick);
  $("home-filters")?.addEventListener("click", onCompareFilterClick);
  $("table-select")?.addEventListener("change", (e) => pickTable(e.target.value));
  $("btn-gps-retry")?.addEventListener("click", () => refreshGpsLock());
  $("btn-start")?.addEventListener("click", startRun);
  $("btn-stop")?.addEventListener("click", stopRun);
  $("btn-new-run")?.addEventListener("click", () => showView("home"));
  document.querySelectorAll("nav.tabbar button").forEach((b) =>
    b.addEventListener("click", () => {
      const v = b.dataset.view;
      if (v === "history") renderHistory();
      if (v === "home") {
        renderProfile();
        greet();
        renderFilterChips();
      }
      if (v === "records") renderRecords();
      if (v === "tables") {
        renderLeagues();
        openEditor();
      }
      showView(v);
    })
  );
  $("editor-select")?.addEventListener("change", openEditor);
  $("btn-save-json")?.addEventListener("click", saveEditor);
  $("btn-reset-json")?.addEventListener("click", () => {
    Store.clearOverride($("editor-select").value);
    delete state.tables[$("editor-select").value];
    openEditor();
    toast("חזרה לטבלת ברירת המחדל");
  });
  $("btn-export")?.addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(Store.getOverrides(), null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "runspeed-tables-overlay.json";
    a.click();
  });
  $("import-file")?.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      for (const [id, table] of Object.entries(parsed)) Store.setOverride(id, table);
      state.tables = {};
      await Promise.all(state.catalog.tables.map((t) => ensureTable(t.id)));
      await openEditor();
      renderLeagues();
      toast("ייבוא הצליח");
    } catch {
      toast("ייבוא נכשל");
    }
  });
  $("btn-open-share")?.addEventListener("click", openShareSheet);
  $("share-sheet")?.addEventListener("click", (e) => {
    if (e.target.closest("[data-close-sheet]")) closeShareSheet();
    const p = e.target.closest("[data-platform]")?.dataset.platform;
    if (p) shareResult(p);
  });
  $("btn-account")?.addEventListener("click", openLogin);
  $("login-sheet")?.addEventListener("click", (e) => {
    if (e.target.closest("[data-close-login]")) closeLogin();
  });
  $("btn-login-fb")?.addEventListener("click", () => onMetaLogin("facebook"));
  $("btn-login-ig")?.addEventListener("click", () => onMetaLogin("instagram"));
  $("btn-login-guest")?.addEventListener("click", async () => {
    const name = $("login-name").value || Store.getName();
    await finishLogin(guestSession(name));
  });
  $("btn-logout")?.addEventListener("click", () => {
    clearSession();
    state.session = null;
    greet();
    renderAccountBtn();
    renderRecords();
    closeLogin();
    toast("התנתקתם");
  });
  $("records-tabs")?.addEventListener("click", (e) => {
    const tab = e.target.closest("[data-board]")?.dataset.board;
    if (!tab) return;
    state.recordsTab = tab;
    $("records-tabs").querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.board === tab));
    renderRecords();
  });
  $("btn-clear-history")?.addEventListener("click", () => {
    localStorage.removeItem("sprint.max.runs");
    renderHistory();
    renderProfile();
    renderRecords();
    renderAthleteCompare();
  });
  wireInstall();
}

async function init() {
  // Wire clicks first so sport/league/team chips work even while tables load.
  wireUi();

  state.catalog = await loadCatalog();
  state.selectedId = Store.getTableId();
  if (!state.catalog.tables.some((t) => t.id === state.selectedId)) {
    state.selectedId = state.catalog.tables[0].id;
  }
  state.compareFilters = sanitizeCompareFilters(Store.getCompareFilters());
  Store.setCompareFilters(state.compareFilters);
  fillSelects();
  renderFilterChips();

  await Promise.all(state.catalog.tables.map((t) => ensureTable(t.id)));
  state.compareFilters = sanitizeCompareFilters(state.compareFilters);
  renderLeagues();
  renderProfile();
  renderHistory();
  await openEditor();
  state.authConfig = await loadAuthConfig();
  try {
    state.recordsCatalog = await (await fetch("./data/records.json", { cache: "no-store" })).json();
  } catch {
    state.recordsCatalog = { users: [], sampleFriends: [], countries: {}, defaultCountry: "IL" };
  }
  state.session = getSession();
  greet();
  renderAccountBtn();
  renderRecords();
  renderAthleteCompare();
  refreshGpsLock();

  if ("serviceWorker" in navigator) {
    try {
      await navigator.serviceWorker.register("./sw.js");
    } catch {
      /* ignore */
    }
  }
}

init().catch((err) => {
  console.error(err);
  const el = $("profile-box");
  if (el) el.textContent = err.message || String(err);
});
