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
