import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeRun, filterGpsPoints, buildProfile, evaluateAntiCheat } from "../js/anticheat.js";
import { rankAgainstTable, shareMessage } from "../js/compare.js";
import { sampleRunning, sampleCar } from "../js/demo.js";
import { generateTrack, gpsSpike } from "../js/simulator.js";

function sessionFromSampler(sampler, seconds = 6, hz = 25) {
  const gps = [];
  const motion = [];
  const n = seconds * hz;
  const t0 = 1_000_000;
  for (let i = 0; i < n; i++) {
    const t = t0 + (i * 1000) / hz;
    const s = sampler(i / hz);
    gps.push({ t, speedKmh: s.speedKmh, accuracy: s.accuracy });
    motion.push({ t, accMag: s.accMag, tiltBeta: s.tiltBeta, tiltGamma: s.tiltGamma });
  }
  return { gps, motion, durationMs: seconds * 1000 };
}

test("running simulation is accepted", () => {
  const analysis = analyzeRun(sessionFromSampler(sampleRunning));
  assert.equal(analysis.valid, true);
  assert.ok(analysis.maxSpeedKmh > 18);
  assert.ok(analysis.maxSpeedKmh < 40);
  assert.equal(analysis.runningLikeMotion, true);
});

test("car simulation is rejected", () => {
  const analysis = analyzeRun(sessionFromSampler(sampleCar, 5));
  assert.equal(analysis.valid, false);
  assert.ok(analysis.vehicleScore >= 0.55 || analysis.rawMaxKmh > 40);
});

test("GPS teleport spikes are dropped", () => {
  const t0 = 0;
  const points = [
    { t: t0, speedKmh: 12, accuracy: 5 },
    { t: t0 + 200, speedKmh: 80, accuracy: 5 },
    { t: t0 + 400, speedKmh: 13, accuracy: 5 },
  ];
  const kept = filterGpsPoints(points);
  assert.equal(kept.some((p) => p.speedKmh === 80), false);
  assert.ok(kept.length >= 2);
});

test("share sentence matches the product copy", () => {
  const table = {
    name: "כוכבי כדורגל",
    athletes: [
      { name: "קיליאן מבאפה", maxSpeedKmh: 38 },
      { name: "ליונל מסי", maxSpeedKmh: 32.5 },
    ],
  };
  const comparison = rankAgainstTable(33.2, table);
  assert.equal(comparison.fasterThan.name, "ליונל מסי");
  assert.equal(
    shareMessage(33.2, comparison, table.name),
    "אתה יותר מהיר מ-ליונל מסי. מהירות הריצה המקסימאלית היא: 33.2 קמ״ש"
  );
});

test("profile plus car track is rejected", () => {
  const run = analyzeRun(sessionFromSampler(sampleRunning));
  const profile = buildProfile([run, run, run]);
  const { gps, motion } = generateTrack("car", 5000, 20);
  const v = evaluateAntiCheat({ gpsSamples: gps, motionSamples: motion, profile });
  assert.equal(v.valid, false);
});

test("simulator GPS spike helper is filtered", () => {
  const { gps } = generateTrack("run", 2500, 10);
  const spiked = [...gps.slice(0, 3), gpsSpike(gps[2].t, gps[2]), ...gps.slice(3)];
  const kept = filterGpsPoints(
    spiked.map((s) => ({ t: s.t, speedKmh: s.speedMps * 3.6, accuracy: s.accuracy }))
  );
  assert.equal(kept.some((p) => p.speedKmh >= 250), false);
});

test("cadence detector finds a 3Hz bounce", async () => {
  const { highPass, peakRateHz } = await import("../js/anticheat.js");
  const hz = 50;
  const values = [];
  for (let i = 0; i < 200; i++) values.push(Math.sin((2 * Math.PI * 3 * i) / hz));
  const hp = highPass(values, 8);
  const rate = peakRateHz(hp, 1 / hz, 0.2);
  assert.ok(rate > 2.4 && rate < 3.6);
});

test("still phone at speed is treated as a car", () => {
  const t0 = 1_000_000;
  const gps = [];
  const motion = [];
  for (let i = 0; i < 80; i++) {
    const t = t0 + i * 50;
    gps.push({ t, speedKmh: 28, accuracy: 8 });
    motion.push({ t, accMag: 9.81, tiltBeta: 2, tiltGamma: 0.4 });
  }
  const v = analyzeRun({ gps, motion, durationMs: 4000 });
  assert.equal(v.valid, false);
  assert.ok(v.flags.includes("still_phone") || v.label === "still_phone");
});

test("share caption invites others to use the app", async () => {
  const { buildSharePayload, INVITE } = await import("../js/share.js");
  const table = {
    name: "כוכבי כדורגל",
    athletes: [
      { name: "קיליאן מבאפה", maxSpeedKmh: 38 },
      { name: "ליונל מסי", maxSpeedKmh: 32.5 },
    ],
  };
  const comparison = rankAgainstTable(33.2, table);
  const payload = buildSharePayload(33.2, comparison, table.name);
  assert.match(payload.line, /אתה יותר מהיר מ-ליונל מסי/);
  assert.match(payload.text, new RegExp(INVITE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("athlete pool filters by sport, league and team", async () => {
  const {
    buildAthletePool,
    filterOptions,
    describeFilters,
    rankAgainstTable,
    normalizeLeagueTable,
    flattenCatalog,
  } = await import("../js/compare.js");

  const catalogDoc = {
    sports: [
      {
        id: "football",
        name: "כדורגל",
        leagues: [
          { id: "premier-league", name: "פרמייר ליג", file: "x" },
          { id: "la-liga", name: "לה ליגה", file: "y" },
        ],
      },
      {
        id: "basketball",
        name: "כדורסל",
        leagues: [{ id: "nba", name: "NBA", file: "z" }],
      },
    ],
  };
  const catalog = flattenCatalog(catalogDoc);
  const tables = {
    "premier-league": normalizeLeagueTable({
      teams: [
        {
          id: "newcastle",
          name: "ניוקאסל",
          athletes: [{ id: "gordon", name: "גורדון", maxSpeedKmh: 36.6 }],
        },
        {
          id: "arsenal",
          name: "ארסנל",
          athletes: [{ id: "saka2", name: "סאקה פל", maxSpeedKmh: 34 }],
        },
      ],
    }),
    "la-liga": normalizeLeagueTable({
      teams: [
        {
          id: "real",
          name: "ריאל מדריד",
          athletes: [
            { id: "mbappe", name: "אמבפה", maxSpeedKmh: 38 },
            { id: "saka", name: "סאקה", maxSpeedKmh: 34.4 },
          ],
        },
      ],
    }),
    nba: normalizeLeagueTable({
      teams: [
        {
          id: "spurs",
          name: "סן אנטוניו",
          athletes: [{ id: "fox", name: "פוקס", maxSpeedKmh: 33 }],
        },
      ],
    }),
  };

  const all = buildAthletePool(tables, catalog, {});
  assert.equal(all.length, 5);
  assert.equal(all[0].name, "אמבפה");

  const football = buildAthletePool(tables, catalog, { sport: "football" });
  assert.equal(football.length, 4);
  assert.ok(football.every((a) => a.sport === "football"));

  const league = buildAthletePool(tables, catalog, { leagueId: "premier-league" });
  assert.equal(league.length, 2);
  assert.ok(league.every((a) => a.leagueId === "premier-league"));

  const team = buildAthletePool(tables, catalog, { sport: "football", team: "ארסנל" });
  assert.equal(team.length, 1);
  assert.ok(team.every((a) => a.team === "ארסנל"));

  const opts = filterOptions(tables, catalog, { sport: "football" });
  assert.deepEqual(opts.sports, ["football", "basketball"]);
  assert.equal(opts.leagues.length, 2);
  assert.ok(opts.teams.includes("ריאל מדריד"));
  assert.equal(describeFilters({ sport: "football", team: "ארסנל" }, catalog), "כדורגל · ארסנל");

  const ranked = rankAgainstTable(35, football);
  assert.equal(ranked.place, 3);
  assert.equal(ranked.total, 5);
  assert.equal(ranked.fasterThan.name, "סאקה");
});

test("records boards rank me locally, globally and among friends", async () => {
  const { buildBoards } = await import("../js/records.js");
  const catalog = {
    defaultCountry: "IL",
    countries: { IL: "ישראל" },
    users: [
      { id: "a", name: "A", country: "IL", maxSpeedKmh: 34 },
      { id: "b", name: "B", country: "US", maxSpeedKmh: 36 },
      { id: "c", name: "C", country: "IL", maxSpeedKmh: 28 },
    ],
    sampleFriends: [{ id: "f1", name: "F", country: "IL", maxSpeedKmh: 30 }],
  };
  const session = { id: "me", name: "משה", country: "IL", provider: "facebook", friends: [] };
  const boards = buildBoards({ catalog, session, myKmh: 32 });
  assert.equal(boards.local.place, 2);
  assert.equal(boards.local.total, 3);
  assert.equal(boards.global.place, 3);
  assert.equal(boards.global.total, 4);
  assert.equal(boards.friends.place, 1);
  assert.ok(boards.friends.sorted.some((u) => u.me));
  assert.equal(boards.canSeeFriends, true);

  const guest = buildBoards({
    catalog,
    session: { id: "g", name: "אורח", country: "IL", provider: "guest", guest: true, friends: [] },
    myKmh: 32,
  });
  assert.equal(guest.canSeeFriends, false);
  assert.equal(guest.friends.sorted.filter((u) => !u.me).length, 0);

  const loggedOut = buildBoards({ catalog, session: null, myKmh: 28 });
  assert.equal(loggedOut.canSeeFriends, false);
});
