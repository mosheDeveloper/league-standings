import { analyzeRun, buildProfile } from "./anticheat.js";
import {
  rankAgainstTable,
  buildAthletePool,
  filterOptions,
  describeFilters,
  sportLabel,
  flattenCatalog,
  normalizeLeagueTable,
} from "./compare.js";
import { Tracker, probeGps } from "./tracker.js";
import { Store } from "./store.js";
import { buildSharePayload, shareToPlatform, drawStoryCard } from "./share.js";
import { buildBoards, bestVerifiedKmh, canSeeFriends } from "./records.js";
import { ascendingPersonalRecords, formatPrDate } from "./pr-progress.js";
import {
  getSession,
  saveSession,
  loadAuthConfig,
  loginWithMeta,
  guestSession,
  logoutMeta,
  restoreMetaSession,
  isMetaConfigured,
  metaErrorMessage,
  getAppIdOverride,
  setAppIdOverride,
  resolveMetaAppId,
} from "./auth.js";
import {
  publishScore,
  fetchScoresForFriends,
  enrichFriendsWithScores,
} from "./community.js";

const $ = (id) => document.getElementById(id);

const state = {
  catalog: null,
  tables: {},
  selectedId: "premier-league",
  mode: "run",
  tracker: null,
  gpsOk: false,
  lastResult: null,
  recordsCatalog: null,
  session: null,
  recordsTab: "local",
  authConfig: null,
  compareFilters: { sport: null, leagueId: null, team: null },
  prPointId: null,
  prHold: null,
  trainingCatalog: null,
};

function toast(msg) {
  const el = $("toast");
  if (!el) {
    console.info(msg);
    return;
  }
  el.hidden = false;
  el.textContent = msg;
  el.classList.add("show");
  setTimeout(() => {
    el.classList.remove("show");
  }, 2200);
}

function showView(name) {
  if (name !== "training") closeVideoPlayer();
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
  renderMetaSetup();
}

function renderMetaSetup() {
  const setup = $("meta-setup");
  const input = $("meta-app-id");
  const status = $("meta-setup-status");
  if (!setup || !input || !status) return;
  const configured = isMetaConfigured(state.authConfig);
  const appId = resolveMetaAppId(state.authConfig || {});
  if (!input.value) input.value = getAppIdOverride() || appId || "";
  setup.hidden = false;
  if (configured) {
    status.textContent = `Meta מחובר להגדרות · App ID …${appId.slice(-4)}`;
    status.dataset.state = "ok";
  } else {
    status.textContent = "חסר App ID — בלי זה אין התחברות אמיתית ואין פרסום לפיד Facebook.";
    status.dataset.state = "warn";
  }
  const fb = $("btn-login-fb");
  const ig = $("btn-login-ig");
  if (fb) fb.disabled = !configured;
  if (ig) ig.disabled = !configured;
}

async function refreshFriendsScores(session) {
  if (!session?.friendsFromApi || !session.friends?.length) return session;
  const scores = await fetchScoresForFriends(
    session.friends.map((f) => f.id),
    state.authConfig?.communityEndpoint
  );
  session.friends = enrichFriendsWithScores(session.friends, scores);
  return session;
}

async function syncMyScore(session = state.session) {
  if (!session?.facebookId || session.guest || session.local) return;
  const kmh = myBest();
  if (!(kmh > 0)) return;
  await publishScore(
    {
      facebookId: session.facebookId,
      name: session.name,
      avatar: session.avatar,
      country: session.country,
      maxSpeedKmh: kmh,
    },
    state.authConfig?.communityEndpoint
  );
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

async function finishLogin(session, { quiet } = {}) {
  let next = session;
  if (next?.friendsFromApi) {
    next = await refreshFriendsScores(next);
  }
  state.session = next;
  saveSession(next);
  Store.setName(next.name);
  greet();
  renderAccountBtn();
  renderRecords();
  closeLogin();
  await syncMyScore(next);
  if (quiet) return;
  if (next.guest) {
    toast("נכנסתם כאורח. שיאי חברים זמינים אחרי חיבור לפייסבוק או אינסטגרם.");
  } else if (next.friendsFromApi) {
    const n = next.friends?.length || 0;
    toast(n ? `מחוברים · נשאבו ${n} חברים מ־Meta` : "מחוברים · פרופיל נשאב מ־Meta (אין עדיין חברים באפליקציה)");
  } else {
    toast("מחוברים");
  }
}

async function onMetaLogin(provider) {
  if (!isMetaConfigured(state.authConfig)) {
    toast(metaErrorMessage(new Error("missing-app-id")));
    $("meta-app-id")?.focus();
    return;
  }
  const fb = $("btn-login-fb");
  const ig = $("btn-login-ig");
  if (fb) fb.disabled = true;
  if (ig) ig.disabled = true;
  try {
    const session = await loginWithMeta(provider, state.authConfig);
    await finishLogin(session);
  } catch (err) {
    if (err?.message === "cancelled") {
      toast("ההתחברות בוטלה");
      return;
    }
    console.error(err);
    toast(metaErrorMessage(err));
  } finally {
    renderMetaSetup();
  }
}

async function loadCatalog() {
  const res = await fetch("./data/catalog.json", { cache: "no-store" });
  if (!res.ok) throw new Error("לא ניתן לטעון קטלוג מקצוענים");
  const catalog = await res.json();
  const tables = flattenCatalog(catalog);
  if (!tables.length) throw new Error("קטלוג ריק");
  return { ...catalog, tables };
}

async function fetchTable(meta) {
  const overrides = Store.getOverrides();
  if (overrides[meta.id]) return normalizeLeagueTable(overrides[meta.id]);
  const res = await fetch(`./${meta.file}`.replace(/^\.\//, "./"), { cache: "no-store" });
  if (!res.ok) throw new Error("טבלה חסרה");
  return normalizeLeagueTable(await res.json());
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
}

function renderLeagues() {
  renderFilterChips();
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
  // Auto-select sole league for sports like athletics → כוכבים
  if (next.sport && !next.leagueId && opts.leagues.length === 1) {
    next.leagueId = opts.leagues[0].id;
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
  renderAthleteCompare();
}

function paintFilterRow() {
  if (!state.catalog || !$("filter-sport")) return null;
  const filters = sanitizeCompareFilters(state.compareFilters);
  state.compareFilters = filters;
  const opts = filterOptions(state.tables, state.catalog.tables, filters);

  $("filter-sport").innerHTML = opts.sports
    .map((s) =>
      chipHtml(
        `${sportMark(s)} ${sportLabel(s)}`,
        filters.sport === s,
        `data-filter="sport" data-value="${s}"`
      )
    )
    .join("");

  const leagueRow = $("filter-league-row");
  const leagueLabel = $("filter-league-label");
  if (!filters.sport) {
    if (leagueRow) leagueRow.hidden = true;
  } else {
    if (leagueRow) leagueRow.hidden = false;
    const isStars = opts.leagues.every((l) => {
      const meta = state.catalog.tables.find((t) => t.id === l.id);
      return meta?.kind === "stars" || meta?.hideTeams;
    });
    if (leagueLabel) leagueLabel.textContent = isStars ? "קטגוריה" : "ליגה";
    $("filter-league").innerHTML = opts.leagues
      .map((l) =>
        chipHtml(
          l.name,
          filters.leagueId === l.id,
          `data-filter="league" data-value="${l.id}"`
        )
      )
      .join("");
  }

  const teamRow = $("filter-team-row");
  if (!filters.sport || !filters.leagueId || opts.hideTeams || !opts.teams.length) {
    if (teamRow) teamRow.hidden = true;
  } else if (teamRow) {
    teamRow.hidden = false;
    $("filter-team").innerHTML =
      chipHtml("כל הקבוצות", !filters.team, 'data-filter="team" data-value=""') +
      opts.teams
        .map((team) =>
          chipHtml(team, filters.team === team, `data-filter="team" data-value="${escAttr(team)}"`)
        )
        .join("");
  }

  return { filters, opts };
}

function renderFilterChips() {
  paintFilterRow();
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

  if (!filters.sport) {
    if ($("compare-scope")) $("compare-scope").textContent = "בחרו ענף ספורט כדי לראות מקצוענים";
    if ($("compare-place")) $("compare-place").textContent = "";
    if ($("compare-ladder")) $("compare-ladder").innerHTML = "";
    if ($("compare-disclaimer")) {
      $("compare-disclaimer").textContent =
        state.catalog.disclaimer || "המהירויות משוערות — להשוואה ולהשראה בלבד.";
    }
    return;
  }

  const athletes = buildAthletePool(state.tables, state.catalog.tables, filters);
  const scope = describeFilters(filters, state.catalog.tables);
  if ($("compare-scope")) {
    $("compare-scope").textContent = `${scope} · ${athletes.length} ספורטאים לפי מהירות`;
  }

  const myKmh = myBest();
  if (!$("compare-place") || !$("compare-ladder")) return;

  if (!athletes.length) {
    $("compare-place").textContent = "אין ספורטאים בסינון הזה — נסו ליגה או קבוצה אחרת.";
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
    $("compare-place").textContent = "עדיין אין שיא מאושר — הסולם מציג את המקצוענים. אחרי ריצה תקינה תופיעו כאן.";
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
        state.catalog.disclaimer || "המהירויות משוערות — להשוואה ולהשראה בלבד.";
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
  /* Profile anti-cheat stats stay internal — not shown on the run screen. */
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
    $("live-status").textContent = "אבד אות GPS — חזרו לאוויר הפתוח";
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
  renderHistory();
  renderRecords();
  renderAthleteCompare();
  refreshGpsLock();
  if (analysis.valid) {
    syncMyScore().then(() => {
      if (state.session?.friendsFromApi) {
        refreshFriendsScores(state.session).then((s) => {
          state.session = s;
          saveSession(s);
          renderRecords();
        });
      }
    });
  }
}

function renderResult() {
  const r = state.lastResult;
  if (!r) return;
  const a = r.analysis;
  $("result-speed").textContent = Number(r.maxKmh).toFixed(1);
  $("result-place").textContent = `\u202A${r.comparison.place} / ${r.comparison.total}\u202C`;
  const badge = $("result-badge");
  badge.className = "pill " + (a.valid ? "ok" : "bad");
  badge.textContent = a.valid ? "ריצה מאושרת" : "לא אושר";
  $("result-msg").textContent = a.messageHe;
  $("share-line").textContent = a.valid ? r.share : "לא ניתן לשתף שיא לא מאושר כהישג.";
  $("share-block").hidden = !a.valid;
  const statusEl = $("result-status");
  if (statusEl) statusEl.textContent = a.valid ? "אושר" : "לא אושר";

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

function openPrPointSheet(point) {
  state.prPointId = point.id;
  const when = new Date(point.at).toLocaleString("he-IL");
  $("pr-point-detail").textContent = `${point.maxKmh.toFixed(1)} קמ״ש · ${when}`;
  $("pr-point-sheet").hidden = false;
}

function closePrPointSheet() {
  state.prPointId = null;
  $("pr-point-sheet").hidden = true;
}

function clearPrHold() {
  if (state.prHold?.timer) clearTimeout(state.prHold.timer);
  state.prHold = null;
}

function bindPrPointGestures(root) {
  root.querySelectorAll("[data-pr-id]").forEach((el) => {
    const id = el.dataset.prId;
    const openFor = () => {
      const points = ascendingPersonalRecords(Store.getRuns());
      const point = points.find((p) => p.id === id);
      if (point) openPrPointSheet(point);
    };

    el.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      clearPrHold();
      state.prHold = {
        id,
        x: e.clientX,
        y: e.clientY,
        timer: setTimeout(() => {
          state.prHold = null;
          if (navigator.vibrate) navigator.vibrate(12);
          openFor();
        }, 480),
      };
    });
    el.addEventListener("pointermove", (e) => {
      if (!state.prHold || state.prHold.id !== id) return;
      if (Math.hypot(e.clientX - state.prHold.x, e.clientY - state.prHold.y) > 12) clearPrHold();
    });
    el.addEventListener("pointerup", clearPrHold);
    el.addEventListener("pointercancel", clearPrHold);
    el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      openFor();
    });
  });
}

function renderPrChart() {
  const host = $("pr-chart");
  if (!host) return;
  const points = ascendingPersonalRecords(Store.getRuns());
  if (!points.length) {
    host.innerHTML = `<div class="pr-chart-empty">עדיין אין שיאים עולים.<br>ריצה מאושרת ראשונה תפתח את הגרף.</div>`;
    return;
  }

  const w = 320;
  const h = 168;
  const pad = { t: 28, r: 16, b: 36, l: 16 };
  const innerW = w - pad.l - pad.r;
  const innerH = h - pad.t - pad.b;
  const speeds = points.map((p) => p.maxKmh);
  const minY = Math.max(0, Math.min(...speeds) - 1.5);
  const maxY = Math.max(...speeds) + 1.2;
  const spanY = Math.max(0.5, maxY - minY);
  const n = points.length;

  const xy = points.map((p, i) => {
    const x = pad.l + (n === 1 ? innerW / 2 : (i / (n - 1)) * innerW);
    const y = pad.t + innerH - ((p.maxKmh - minY) / spanY) * innerH;
    return { ...p, x, y };
  });

  const line = xy.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
  const axisY = pad.t + innerH;

  host.innerHTML = `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="שיאים עולים לאורך זמן">
    <line class="pr-axis" x1="${pad.l}" y1="${axisY}" x2="${w - pad.r}" y2="${axisY}" />
    <path class="pr-line" d="${line}" />
    ${xy
      .map(
        (p) => `<g class="pr-point" data-pr-id="${p.id}" tabindex="0" role="button"
          aria-label="שיא ${p.maxKmh.toFixed(1)} קמ״ש ב-${formatPrDate(p.at)}. לחיצה ארוכה למחיקת תיעוד">
          <circle class="pr-hit" cx="${p.x}" cy="${p.y}" r="18" />
          <circle class="pr-dot" cx="${p.x}" cy="${p.y}" r="6" />
          <text class="pr-label-speed" x="${p.x}" y="${p.y - 12}" text-anchor="middle">${p.maxKmh.toFixed(1)}</text>
          <text class="pr-label-date" x="${p.x}" y="${axisY + 16}" text-anchor="middle">${formatPrDate(p.at)}</text>
        </g>`
      )
      .join("")}
  </svg>`;
  bindPrPointGestures(host);
}

function renderHistory() {
  renderPrChart();
  const h = Store.getRuns();
  if (!h.length) {
    $("history-list").innerHTML = `<p class="muted">אין ריצות עדיין.</p>`;
    return;
  }
  // Keep approved runs near the top; push unapproved (red speeds) lower.
  const ranked = [...h].sort((a, b) => {
    const aOk = a.analysis?.valid ? 0 : 1;
    const bOk = b.analysis?.valid ? 0 : 1;
    if (aOk !== bOk) return aOk - bOk;
    return String(b.at || "").localeCompare(String(a.at || ""));
  });
  $("history-list").innerHTML = ranked
    .map((e) => {
      const valid = !!e.analysis?.valid;
      const excluded = !!e.excludeFromPr;
      const status = !valid ? "לא אושר" : excluded ? "הוסר מהגרף" : "אושר";
      return `<li>
        <span>${new Date(e.at).toLocaleString("he-IL")}<br>
        <small class="muted">${e.tableTitle || ""} · ${status}</small></span>
        <b class="${valid ? "" : "invalid"}">${Number(e.maxKmh).toFixed(1)} קמ״ש</b>
      </li>`;
    })
    .join("");
}

function youtubeEmbedSrc(videoId, { autoplay = false } = {}) {
  const id = String(videoId || "").trim();
  if (!/^[a-zA-Z0-9_-]{6,20}$/.test(id)) return "";
  const params = new URLSearchParams({ rel: "0", modestbranding: "1" });
  if (autoplay) params.set("autoplay", "1");
  return `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}?${params}`;
}

function youtubeThumbSrc(videoId) {
  const id = String(videoId || "").trim();
  if (!/^[a-zA-Z0-9_-]{6,20}$/.test(id)) return "";
  return `https://img.youtube.com/vi/${encodeURIComponent(id)}/hqdefault.jpg`;
}

function openVideoPlayer({ youtubeId, title }) {
  const overlay = $("video-player");
  const frame = $("video-player-frame");
  const titleEl = $("video-player-title");
  if (!overlay || !frame) return;

  const src = youtubeEmbedSrc(youtubeId, { autoplay: true });
  if (!src) return;

  if (titleEl) titleEl.textContent = title || "";
  frame.innerHTML = `<iframe
    src="${src}"
    title="${escAttr(title || "סרטון הדרכה")}"
    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share; fullscreen"
    referrerpolicy="strict-origin-when-cross-origin"
    allowfullscreen
  ></iframe>`;
  overlay.hidden = false;
  document.body.classList.add("player-mode");
}

function closeVideoPlayer() {
  const overlay = $("video-player");
  const frame = $("video-player-frame");
  if (!overlay || overlay.hidden) return;

  if (document.fullscreenElement) {
    document.exitFullscreen?.().catch(() => {});
  }
  if (frame) frame.innerHTML = "";
  overlay.hidden = true;
  document.body.classList.remove("player-mode");
}

async function toggleVideoFullscreen() {
  const stage = $("video-player-stage");
  if (!stage) return;
  try {
    if (!document.fullscreenElement) {
      await (stage.requestFullscreen?.() || stage.webkitRequestFullscreen?.());
    } else {
      await (document.exitFullscreen?.() || document.webkitExitFullscreen?.());
    }
  } catch {
    toast("מסך מלא לא זמין בדפדפן זה");
  }
}

function syncVideoFullscreenBtn() {
  const btn = $("btn-video-fs");
  if (!btn) return;
  const on = !!document.fullscreenElement;
  btn.setAttribute("aria-label", on ? "יציאה ממסך מלא" : "מסך מלא");
  btn.title = on ? "יציאה ממסך מלא" : "מסך מלא";
}

function renderTraining() {
  const host = $("training-grid");
  if (!host) return;
  const catalog = state.trainingCatalog;
  if ($("training-title") && catalog?.title) $("training-title").textContent = catalog.title;
  if ($("training-sub") && catalog?.subtitle) $("training-sub").textContent = catalog.subtitle;

  const cols = Math.max(1, Number(catalog?.columns) || 2);
  host.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;

  const videos = [...(catalog?.videos || [])]
    .map((v, i) => ({
      slot: Number(v.slot) || i + 1,
      youtubeId: v.youtubeId || v.id || "",
      title: v.title || `סרטון ${Number(v.slot) || i + 1}`,
    }))
    .filter((v) => v.youtubeId)
    .sort((a, b) => a.slot - b.slot);

  if (!videos.length) {
    host.innerHTML = `<p class="training-empty">עדיין אין סרטוני הדרכה זמינים.</p>`;
    return;
  }

  host.innerHTML = videos
    .map((v) => {
      const thumb = youtubeThumbSrc(v.youtubeId);
      if (!thumb) {
        return `<article class="training-card" data-slot="${v.slot}" disabled>
          <span class="training-slot">${v.slot}</span>
          <div class="training-frame"></div>
          <p class="training-title">${escAttr(v.title)}</p>
        </article>`;
      }
      return `<button type="button" class="training-card" data-slot="${v.slot}" data-youtube-id="${escAttr(v.youtubeId)}" data-title="${escAttr(v.title)}" aria-label="פתיחת ${escAttr(v.title)}">
        <span class="training-slot">${v.slot}</span>
        <div class="training-frame">
          <img src="${thumb}" alt="" loading="lazy" />
          <span class="training-play" aria-hidden="true"></span>
        </div>
        <p class="training-title">${escAttr(v.title)}</p>
      </button>`;
    })
    .join("");
}

async function loadTrainingCatalog() {
  try {
    state.trainingCatalog = await (await fetch("./data/training-videos.json", { cache: "no-store" })).json();
  } catch {
    state.trainingCatalog = { title: "שיפור ביצועים", subtitle: "", columns: 2, videos: [] };
  }
  renderTraining();
}

async function shareResult(platform) {
  const r = state.lastResult;
  if (!r?.analysis?.valid) return;
  const payload = {
    ...(r.payload || buildSharePayload(r.maxKmh, r.comparison, r.tableTitle)),
    canvas: $("share-canvas"),
  };
  try {
    const how = await shareToPlatform(platform, payload, state.authConfig || {});
    closeShareSheet();
    if (how === "aborted") return;
    if (how === "facebook-published") toast("נפתח דיאלוג הפרסום של Facebook — אשרו כדי לפרסם בפיד");
    else if (how === "facebook-sharer") toast("נפתח Facebook לשיתוף הקישור");
    else if (how === "messenger-published") toast("נפתח Messenger לשליחה");
    else if (how === "copied") toast("הטקסט הועתק");
    else if (how === "saved" || how === "download-copy")
      toast("הכרטיס נשמר — פתחו Instagram/TikTok והדביקו בסטורי");
    else if (how === "files") toast("נפתח שיתוף המערכת עם התמונה");
    else toast("נפתח לשיתוף");
  } catch (e) {
    if (e?.name === "AbortError") return;
    if (e?.message === "missing-app-id") {
      toast("לפרסום בפייסבוק צריך App ID של Meta — הזינו במסך ההתחברות");
      openLogin();
      return;
    }
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
  $("compare-filters")?.addEventListener("click", onCompareFilterClick);
  $("table-select")?.addEventListener("change", (e) => pickTable(e.target.value));
  $("btn-gps-retry")?.addEventListener("click", () => refreshGpsLock());
  $("btn-start")?.addEventListener("click", startRun);
  $("btn-stop")?.addEventListener("click", stopRun);
  $("btn-new-run")?.addEventListener("click", () => showView("home"));
  document.querySelectorAll("nav.tabbar button").forEach((b) =>
    b.addEventListener("click", () => {
      const v = b.dataset.view;
      if (v === "history") renderHistory();
      if (v === "training") renderTraining();
      if (v === "home") {
        renderProfile();
        greet();
      }
      if (v === "records") renderRecords();
      if (v === "tables") {
        renderLeagues();
      }
      showView(v);
    })
  );
  $("training-grid")?.addEventListener("click", (e) => {
    const card = e.target.closest(".training-card[data-youtube-id]");
    if (!card) return;
    openVideoPlayer({
      youtubeId: card.dataset.youtubeId,
      title: card.dataset.title,
    });
  });
  $("btn-video-close")?.addEventListener("click", closeVideoPlayer);
  $("btn-video-fs")?.addEventListener("click", toggleVideoFullscreen);
  $("video-player")?.addEventListener("click", (e) => {
    if (e.target.closest("[data-close-video]")) closeVideoPlayer();
  });
  document.addEventListener("fullscreenchange", syncVideoFullscreenBtn);
  document.addEventListener("keydown", (e) => {
    const overlay = $("video-player");
    if (!overlay || overlay.hidden || e.key !== "Escape") return;
    if (document.fullscreenElement) {
      document.exitFullscreen?.().catch(() => {});
      return;
    }
    closeVideoPlayer();
  });
  $("btn-open-share")?.addEventListener("click", openShareSheet);
  $("share-sheet")?.addEventListener("click", (e) => {
    if (e.target.closest("[data-close-sheet]")) closeShareSheet();
    const p = e.target.closest("[data-platform]")?.dataset.platform;
    if (p) shareResult(p);
  });
  $("pr-point-sheet")?.addEventListener("click", (e) => {
    if (e.target.closest("[data-close-pr-point]")) closePrPointSheet();
  });
  $("btn-exclude-pr")?.addEventListener("click", () => {
    if (!state.prPointId) return;
    Store.excludeFromPr(state.prPointId);
    closePrPointSheet();
    renderHistory();
    renderProfile();
    renderRecords();
    toast("תיעוד השיא הוסר מהגרף");
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
  $("btn-save-meta-app")?.addEventListener("click", async () => {
    const id = setAppIdOverride($("meta-app-id")?.value || "");
    state.authConfig = await loadAuthConfig();
    renderMetaSetup();
    toast(id ? "App ID נשמר במכשיר" : "App ID נמחק — משתמשים ב-auth.json");
  });
  $("btn-logout")?.addEventListener("click", async () => {
    await logoutMeta(state.authConfig || {});
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
  if (!state.compareFilters.sport) {
    const meta = state.catalog.tables.find((t) => t.id === state.selectedId);
    state.compareFilters = sanitizeCompareFilters({
      sport: meta?.sport || "football",
      leagueId: state.selectedId,
      team: null,
    });
  }
  Store.setCompareFilters(state.compareFilters);
  fillSelects();
  renderFilterChips();

  await Promise.all(state.catalog.tables.map((t) => ensureTable(t.id)));
  state.compareFilters = sanitizeCompareFilters(state.compareFilters);
  renderLeagues();
  renderProfile();
  renderHistory();
  await loadTrainingCatalog();
  state.authConfig = await loadAuthConfig();
  try {
    state.recordsCatalog = await (await fetch("./data/records.json", { cache: "no-store" })).json();
  } catch {
    state.recordsCatalog = { users: [], sampleFriends: [], countries: {}, defaultCountry: "IL" };
  }
  state.session = getSession();
  if (state.session && !state.session.guest && !state.session.local && isMetaConfigured(state.authConfig)) {
    try {
      const restored = await restoreMetaSession(state.authConfig, state.session.provider || "facebook");
      if (restored) {
        restored.country = state.session.country || restored.country;
        state.session = await refreshFriendsScores(restored);
        saveSession(state.session);
      }
    } catch (err) {
      console.warn("meta restore failed", err);
    }
  }
  greet();
  renderAccountBtn();
  renderRecords();
  renderAthleteCompare();
  refreshGpsLock();
  if (state.session?.facebookId) syncMyScore();

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
  toast(err.message || String(err));
});
