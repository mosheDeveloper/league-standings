import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeRun, filterGpsPoints, buildProfile, evaluateAntiCheat } from "../js/anticheat.js";
import { rankAgainstTable, shareMessage } from "../js/compare.js";
import { ascendingPersonalRecords } from "../js/pr-progress.js";
import { sampleRunning, sampleCar } from "../js/demo.js";
import { generateTrack, gpsSpike } from "../js/simulator.js";

function run(partial) {
  return {
    id: partial.id,
    at: partial.at,
    maxKmh: partial.maxKmh,
    mode: partial.mode || "run",
    excludeFromPr: partial.excludeFromPr,
    analysis: { valid: partial.valid !== false, maxSpeedKmh: partial.maxKmh },
  };
}

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

test("rapid forward/back rocking without net progress is rejected", () => {
  const t0 = 1_000_000;
  const gps = [];
  const motion = [];
  const mPerDeg = 111320;
  const hz = 25;
  for (let i = 0; i < 5 * hz; i++) {
    const tSec = i / hz;
    const t = t0 + i * (1000 / hz);
    const x = 0.7 * Math.sin(2 * Math.PI * 1.5 * tSec);
    const lat = 32.08 + x / mPerDeg;
    const lng = 34.78;
    let speedKmh = 0;
    if (i > 0) {
      const prev = gps[i - 1];
      const dLat = (lat - prev.lat) * mPerDeg;
      const dLng = (lng - prev.lng) * mPerDeg * Math.cos((32.08 * Math.PI) / 180);
      speedKmh = (Math.hypot(dLat, dLng) * hz) * 3.6;
    }
    const swing = 8 * Math.sin(2 * Math.PI * 2.5 * tSec);
    gps.push({ t, speedKmh, accuracy: 6, lat, lng });
    motion.push({
      t,
      ax: swing,
      ay: 0.3,
      az: 9.81,
      accMag: Math.hypot(swing, 0.3, 9.81),
      tiltBeta: 25 + 15 * Math.sin(i / 2),
      tiltGamma: 8,
      includesGravity: true,
    });
  }
  const v = analyzeRun({ gps, motion, durationMs: 5000 });
  assert.equal(v.valid, false);
  assert.ok(v.maxSpeedKmh < 8);
  assert.ok(v.flags.includes("oscillating_path") || v.label === "oscillating_path" || v.label === "no_speed");
});

test("phone-in-hand arm swing cannot far exceed GPS ground speed", async () => {
  const { Tracker } = await import("../js/tracker.js");
  const { FUSION_HEADROOM_KMH } = await import("../js/anticheat.js");
  const bodyKmh = 20;
  const tracker = new Tracker(null, { officialPeakIntervalMs: 0 });
  tracker.startDemo();
  const t0 = 1_000_000;
  const mPerDeg = 111320;
  const hz = 50;
  let x = 0;
  for (let i = 0; i < 5 * hz; i++) {
    const tSec = i / hz;
    const t = t0 + i * (1000 / hz);
    const arm = 8 * Math.max(0, Math.sin(2 * Math.PI * 3.2 * tSec));
    const bounce = 2.5 * Math.sin(2 * Math.PI * 3.0 * tSec);
    x += (bodyKmh / 3.6) / hz;
    if (i % hz === 0) {
      tracker.ingest({
        t,
        speedKmh: bodyKmh,
        accuracy: 6,
        lat: 32.08 + x / mPerDeg,
        lng: 34.78,
      });
    }
    tracker.ingest({
      t,
      ax: 1.2 + arm,
      ay: 0.4,
      az: 9.81,
      accMag: 9.9 + bounce + arm * 0.4,
      tiltBeta: 35 + 40 * Math.sin(2 * Math.PI * 3.2 * tSec),
      tiltGamma: 15,
      includesGravity: true,
    });
  }
  const session = tracker.stop();
  const v = analyzeRun(session);
  assert.equal(v.valid, true);
  assert.ok(v.maxSpeedKmh <= bodyKmh + FUSION_HEADROOM_KMH + 0.6);
  assert.ok(v.maxSpeedKmh >= bodyKmh - 2);
  // Uncapped fusion would have been much higher; official stays near GPS.
  assert.ok((v.sustainedPeak?.uncappedPeakKmh || 0) >= v.maxSpeedKmh - 0.05);
});

test("straight sprint with net progress is still accepted", () => {
  const t0 = 1_000_000;
  const gps = [];
  const motion = [];
  const mPerDeg = 111320;
  const hz = 25;
  let x = 0;
  for (let i = 0; i < 4 * hz; i++) {
    const tSec = i / hz;
    const t = t0 + i * (1000 / hz);
    const speedKmh = 22;
    x += (speedKmh / 3.6) / hz;
    const bounce = 3.8 * Math.sin(2 * Math.PI * 3.1 * tSec);
    gps.push({
      t,
      speedKmh,
      accuracy: 6,
      lat: 32.08 + x / mPerDeg,
      lng: 34.78,
    });
    motion.push({
      t,
      ax: 2.2,
      ay: 0.3,
      az: 9.81,
      accMag: 9.9 + bounce,
      tiltBeta: 14 + 8 * Math.sin(2 * Math.PI * 3.1 * tSec),
      tiltGamma: 3,
      includesGravity: true,
    });
  }
  const v = analyzeRun({ gps, motion, durationMs: 4000 });
  assert.equal(v.valid, true);
  assert.ok(v.maxSpeedKmh >= 18);
  assert.equal(v.flags.includes("oscillating_path"), false);
});

test("hand-waving IMU spike without GPS movement is rejected", () => {
  const t0 = 1_000_000;
  const gps = [
    { t: t0, speedKmh: 0, accuracy: 5, lat: 32.08, lng: 34.78 },
    { t: t0 + 2500, speedKmh: 0.5, accuracy: 5, lat: 32.08, lng: 34.78 },
  ];
  const motion = [];
  for (let i = 1; i <= 150; i++) {
    motion.push({
      t: t0 + i * 15,
      ax: 8,
      ay: 0,
      az: 9.81,
      accMag: Math.hypot(8, 9.81),
      tiltBeta: 5,
      tiltGamma: 1,
    });
  }
  const v = analyzeRun({ gps, motion, durationMs: 3000 });
  assert.equal(v.valid, false);
  assert.ok(v.maxSpeedKmh < 10);
  assert.ok(v.flags.includes("imu_gps_mismatch") || v.label === "imu_gps_mismatch");
});

test("official GPS peak uses rolling mean over ~1.5s window", async () => {
  const { findSustainedGpsPeakKmh, findRollingMeanPeak, PEAK_WINDOW_MS } =
    await import("../js/anticheat.js");
  assert.equal(PEAK_WINDOW_MS, 1500);
  const t0 = 1_000_000;
  const gps = [];
  const mPerDeg = 111320;
  let x = 0;
  for (let i = 0; i < 80; i++) {
    const dt = 0.04;
    const speedKmh = 24 + Math.sin(i / 8);
    x += (speedKmh / 3.6) * dt;
    gps.push({
      t: t0 + i * 40,
      speedKmh,
      accuracy: 6,
      lat: 32.08 + x / mPerDeg,
      lng: 34.78,
    });
  }
  const sustained = findSustainedGpsPeakKmh(gps);
  assert.ok(sustained.peakKmh >= 22);
  assert.equal(sustained.sustained, true);
  assert.equal(sustained.method, "rolling_mean");
  assert.ok(sustained.pathProgress?.progress >= 0.4);

  // A brief spike must not become the official peak
  const spiked = [
    ...gps,
    { t: t0 + 4000, speedKmh: 55, accuracy: 6, lat: 32.08 + (x + 1) / mPerDeg, lng: 34.78 },
    { t: t0 + 4050, speedKmh: 12, accuracy: 6, lat: 32.08 + (x + 1.1) / mPerDeg, lng: 34.78 },
  ];
  const rolled = findRollingMeanPeak(spiked, (p) => p.speedKmh, {
    windowMs: PEAK_WINDOW_MS,
    minSpeedKmh: 6,
    requirePathProgress: true,
  });
  assert.ok(rolled.peakKmh < 40);
});

test("zero official peak is not an approved run", () => {
  const analysis = analyzeRun({
    gps: [
      { t: 0, speedKmh: 3, accuracy: 8 },
      { t: 1000, speedKmh: 4, accuracy: 8 },
    ],
    motion: [
      { t: 0, accMag: 10.2, tiltBeta: 8, tiltGamma: 2 },
      { t: 500, accMag: 11.1, tiltBeta: 10, tiltGamma: 3 },
      { t: 1000, accMag: 10.4, tiltBeta: 7, tiltGamma: 2 },
    ],
    durationMs: 1200,
  });
  assert.equal(analysis.valid, false);
  assert.ok(analysis.maxSpeedKmh < 8);
  assert.ok(analysis.label === "no_speed" || analysis.flags.includes("no_speed"));
});

test("live max and final max use the same official peak metric", async () => {
  const { Tracker } = await import("../js/tracker.js");
  const tracker = new Tracker(null, { officialPeakIntervalMs: 0 });
  tracker.startDemo();
  const t0 = 1_000_000;
  for (let i = 0; i < 60; i++) {
    const t = t0 + i * 50;
    tracker.ingest({
      t,
      speedKmh: 20 + Math.sin(i / 6),
      accuracy: 6,
      lat: 32.08 + i * 0.00002,
      lng: 34.78,
      ax: 2.2,
      ay: 0.3,
      az: 9.81,
      accMag: 10.2 + 2 * Math.sin(i / 3),
      tiltBeta: 12 + 6 * Math.sin(i / 4),
      tiltGamma: 3,
      includesGravity: true,
    });
  }
  const liveMax = tracker.liveApprovedMaxKmh(true);
  const session = tracker.stop();
  const analysis = analyzeRun(session);
  assert.ok(liveMax > 8);
  assert.equal(analysis.maxSpeedKmh, liveMax);
  assert.equal(session.officialPeakKmh, analysis.maxSpeedKmh);
});

test("unapproved runs are excluded from PR chart", () => {
  const points = ascendingPersonalRecords([
    run({ id: "good", at: "2026-01-01T10:00:00.000Z", maxKmh: 24 }),
    run({ id: "bad", at: "2026-02-01T10:00:00.000Z", maxKmh: 40, valid: false }),
    run({ id: "better", at: "2026-03-01T10:00:00.000Z", maxKmh: 27 }),
  ]);
  assert.deepEqual(
    points.map((p) => p.id),
    ["good", "better"]
  );
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

  const apiEmpty = buildBoards({
    catalog,
    session: {
      id: "me2",
      name: "משה",
      country: "IL",
      provider: "facebook",
      friendsFromApi: true,
      friends: [],
    },
    myKmh: 32,
  });
  assert.equal(apiEmpty.friends.sorted.filter((u) => !u.me).length, 0);
});

test("meta auth helpers resolve app id and error copy", async () => {
  const { resolveMetaAppId, isMetaConfigured, metaErrorMessage } = await import("../js/auth.js");
  assert.equal(isMetaConfigured({ facebookAppId: "" }), false);
  assert.equal(isMetaConfigured({ facebookAppId: "123" }), true);
  assert.equal(resolveMetaAppId({ facebookAppId: "999", instagramAppId: "1" }), "999");
  assert.match(metaErrorMessage(new Error("missing-app-id")), /App ID/);
});

test("community store upserts max speed and enriches friends", async () => {
  const {
    upsertLocalScore,
    enrichFriendsWithScores,
    readLocalCommunity,
  } = await import("../js/community.js");
  // jsdom-less: stub localStorage if missing
  if (typeof globalThis.localStorage === "undefined") {
    const mem = new Map();
    globalThis.localStorage = {
      getItem: (k) => (mem.has(k) ? mem.get(k) : null),
      setItem: (k, v) => mem.set(k, String(v)),
      removeItem: (k) => mem.delete(k),
    };
  }
  localStorage.removeItem("sprint.max.community");
  upsertLocalScore({ facebookId: "10", name: "Dana", maxSpeedKmh: 28, country: "IL" });
  upsertLocalScore({ facebookId: "10", name: "Dana", maxSpeedKmh: 31, country: "IL" });
  const map = readLocalCommunity();
  assert.equal(map["10"].maxSpeedKmh, 31);
  const friends = enrichFriendsWithScores(
    [
      { id: "10", name: "Dana" },
      { id: "11", name: "NoScore" },
    ],
    Object.values(map)
  );
  assert.equal(friends[0].maxSpeedKmh, 31);
  assert.equal(friends[1].maxSpeedKmh, 0);
});

test("facebook share path requires config for publish helper", async () => {
  const { publishToFacebook } = await import("../js/share.js");
  await assert.rejects(
    () => publishToFacebook({ text: "t", url: "https://example.com", line: "l" }, { facebookAppId: "" }),
    /missing-app-id/
  );
});
