import { test } from "node:test";
import assert from "node:assert/strict";
import {
  analyzeRun,
  filterGpsPoints,
  buildProfile,
  evaluateAntiCheat,
  findSustainedRunWindows,
  motionStats,
  MIN_RUN_SUSTAIN_MS,
  MAX_GPS_ACCURACY_M,
} from "../js/anticheat.js";
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
  const analysis = analyzeRun(sessionFromSampler(sampleRunning, 8));
  assert.equal(analysis.valid, true);
  assert.ok(analysis.maxSpeedKmh > 18);
  assert.ok(analysis.maxSpeedKmh < 40);
  assert.equal(analysis.runningLikeMotion, true);
  assert.ok((analysis.runWindows || []).length >= 1);
});

test("car simulation is rejected and shows zero speed", () => {
  const analysis = analyzeRun(sessionFromSampler(sampleCar, 8));
  assert.equal(analysis.valid, false);
  assert.equal(analysis.maxSpeedKmh, 0);
  assert.ok(analysis.vehicleScore >= 0.55 || analysis.rawMaxKmh > 40);
});

test("brief run under 3s is not shown as a measured peak", () => {
  const analysis = analyzeRun(sessionFromSampler(sampleRunning, 2));
  assert.equal(analysis.valid, false);
  assert.equal(analysis.maxSpeedKmh, 0);
  assert.ok(
    analysis.flags.includes("no_run_sustain") ||
      analysis.label === "no_run_sustain" ||
      analysis.label === "no_speed"
  );
});

test("pocket-like bounce is classified as running motion", () => {
  const { motion } = sessionFromSampler(sampleRunning, 6);
  const stats = motionStats(motion);
  assert.equal(stats.runningLikeMotion, true);
  assert.ok(stats.pocketLike || stats.handLike);
});

test("hand-held running tilt is accepted as run-like; chaotic wave is not", () => {
  const t0 = 1_000_000;
  const handRun = [];
  for (let i = 0; i < 120; i++) {
    const t = t0 + i * 40;
    const tSec = i * 0.04;
    const cadence = 2.8;
    const bounce = 5 * Math.sin(2 * Math.PI * cadence * tSec);
    handRun.push({
      t,
      accMag: 9.7 + bounce,
      tiltBeta: 25 + 18 * Math.sin(2 * Math.PI * cadence * tSec),
      tiltGamma: 12 + 8 * Math.sin(2 * Math.PI * cadence * tSec + 0.5),
    });
  }
  const handStats = motionStats(handRun);
  assert.equal(handStats.runningLikeMotion, true);
  assert.equal(handStats.handLike, true);

  const wave = [];
  for (let i = 0; i < 120; i++) {
    const t = t0 + i * 40;
    // Irregular high-frequency flailing — not a foot cadence band.
    wave.push({
      t,
      accMag: 9.81 + 6 * Math.sin(2 * Math.PI * 7.5 * i * 0.04) + (i % 3) * 2,
      tiltBeta: 40 * Math.sin(i),
      tiltGamma: 30 * Math.cos(i * 1.7),
    });
  }
  assert.equal(motionStats(wave).runningLikeMotion, false);
});

test("linear accel without orientation still counts as a real run (not 0)", () => {
  // Real phones often expose acceleration (gravity removed) and deny tilt.
  // |linear| doubles cadence — bounceSeries must use a signed axis instead.
  const t0 = 1_000_000;
  const gps = [];
  const motion = [];
  const cadence = 2.9;
  for (let i = 0; i < 200; i++) {
    const t = t0 + i * 40;
    const bounce = 3.5 * Math.sin(2 * Math.PI * cadence * i * 0.04);
    gps.push({
      t,
      speedKmh: 17 + Math.sin(i / 10),
      accuracy: 14,
      lat: 32.08 + i * 0.00001,
      lng: 34.78,
    });
    motion.push({
      t,
      ax: bounce,
      ay: 0.2,
      az: 0.5,
      accMag: Math.hypot(bounce, 0.2, 0.5),
      tiltBeta: 0,
      tiltGamma: 0,
      linear: true,
    });
  }
  const stats = motionStats(motion);
  assert.ok(stats.cadenceHz >= 2.2 && stats.cadenceHz <= 3.6, `cadence=${stats.cadenceHz}`);
  assert.equal(stats.runningLikeMotion, true);
  const analysis = analyzeRun({ gps, motion, durationMs: 8000 });
  assert.equal(analysis.valid, true);
  assert.ok(analysis.maxSpeedKmh >= 12, `max=${analysis.maxSpeedKmh}`);
  assert.ok((analysis.runWindows || []).length >= 1);
});

test("firm pocket with little/no tilt is still credited", () => {
  const t0 = 1_000_000;
  const gps = [];
  const motion = [];
  const cadence = 3.0;
  for (let i = 0; i < 200; i++) {
    const t = t0 + i * 40;
    const bounce = 3.2 * Math.sin(2 * Math.PI * cadence * i * 0.04);
    gps.push({ t, speedKmh: 16, accuracy: 10, lat: 32.08, lng: 34.78 });
    motion.push({
      t,
      accMag: 9.7 + bounce,
      // Flat tilt — DeviceOrientation missing or phone locked in pocket.
      tiltBeta: 0,
      tiltGamma: 0,
    });
  }
  assert.equal(motionStats(motion).runningLikeMotion, true);
  const analysis = analyzeRun({ gps, motion, durationMs: 8000 });
  assert.equal(analysis.valid, true);
  assert.ok(analysis.maxSpeedKmh >= 10);
});

test("soft linear-accel pocket (iOS-style) still opens the meter", async () => {
  // Many phones prefer acceleration (no g). Soft jeans → accStd often ~0.7–1.0.
  const { Tracker } = await import("../js/tracker.js");
  const tracker = new Tracker(null, { officialPeakIntervalMs: 0 });
  tracker.startDemo();
  const t0 = Date.now();
  const hz = 50;
  const mPerDeg = 111320;
  let x = 0;
  const speed = 14;
  for (let i = 0; i < 6 * hz; i++) {
    const t = t0 + i * (1000 / hz);
    const tSec = i / hz;
    const bounce = 1.35 * Math.sin(2 * Math.PI * 2.9 * tSec);
    x += (speed / 3.6) / hz;
    if (i % hz === 0) {
      tracker.ingest({
        t,
        speedKmh: speed,
        accuracy: 20,
        lat: 32.08 + x / mPerDeg,
        lng: 34.78,
      });
    }
    tracker.ingest({
      t,
      ax: bounce * 0.25,
      ay: 0.1,
      az: bounce,
      accMag: Math.hypot(bounce * 0.25, 0.1, bounce),
      tiltBeta: 2,
      tiltGamma: 1,
      linear: true,
      includesGravity: false,
      gravityHint: { gx: 0, gy: 0, gz: 9.81 },
    });
  }
  const now = t0 + 6000;
  const stats = motionStats(tracker.motion);
  assert.equal(stats.linearAccel, true);
  assert.ok(stats.accStd < 1.05, `expected soft linear bounce, got ${stats.accStd}`);
  assert.equal(stats.runningLikeMotion, true);
  assert.equal(tracker.hasDisplayableRun(now), true);
  assert.ok(tracker.displaySpeedKmh(now) >= 8);
  const analysis = analyzeRun(tracker.stop());
  assert.equal(analysis.valid, true);
  assert.ok(analysis.maxSpeedKmh >= 8);
});

test("phone-in-hand arm swing uses GPS run speed (not swing inflation)", async () => {
  // Moving the hand while running is fine — record body/GPS speed only.
  const { Tracker } = await import("../js/tracker.js");
  const bodyKmh = 20;
  const tracker = new Tracker(null, { officialPeakIntervalMs: 0 });
  tracker.startDemo();
  const t0 = 1_000_000;
  const mPerDeg = 111320;
  const hz = 50;
  let x = 0;
  for (let i = 0; i < 6 * hz; i++) {
    const tSec = i / hz;
    const t = t0 + i * (1000 / hz);
    const arm = 8 * Math.max(0, Math.sin(2 * Math.PI * 3.2 * tSec));
    const bounce = 2.8 * Math.sin(2 * Math.PI * 3.0 * tSec);
    x += (bodyKmh / 3.6) / hz;
    if (i % hz === 0) {
      tracker.ingest({
        t,
        speedKmh: bodyKmh,
        accuracy: 8,
        lat: 32.08 + x / mPerDeg,
        lng: 34.78,
      });
    }
    tracker.ingest({
      t,
      ax: 1.2 + arm,
      ay: 0.4,
      az: 9.81 + bounce,
      accMag: Math.hypot(1.2 + arm, 0.4, 9.81 + bounce),
      tiltBeta: 35 + 40 * Math.sin(2 * Math.PI * 3.2 * tSec),
      tiltGamma: 15,
      includesGravity: true,
    });
  }
  const session = tracker.stop();
  const stats = motionStats(session.motion);
  assert.equal(stats.handLike, true);
  assert.equal(stats.runningLikeMotion, true);
  const analysis = analyzeRun(session);
  assert.equal(analysis.valid, true);
  assert.equal(analysis.handLike, true);
  // Official max = GPS ground speed — fused arm-swing (~27+) must not win.
  assert.ok(analysis.maxSpeedKmh <= bodyKmh + 0.2, `max=${analysis.maxSpeedKmh}`);
  assert.ok(analysis.maxSpeedKmh >= bodyKmh - 0.5, `max=${analysis.maxSpeedKmh}`);
  assert.equal(analysis.speedSource, "gps_sustained");
});

test("soft pocket bounce (damped jeans) still counts as a run", () => {
  const t0 = 1_000_000;
  const gps = [];
  const motion = [];
  const cadence = 2.9;
  for (let i = 0; i < 200; i++) {
    const t = t0 + i * 40;
    const bounce = 1.6 * Math.sin(2 * Math.PI * cadence * i * 0.04);
    gps.push({ t, speedKmh: 14, accuracy: 12, lat: 32.08, lng: 34.78 });
    motion.push({
      t,
      accMag: 9.7 + bounce,
      ax: 0.4,
      ay: 0.2,
      az: 9.7 + bounce,
      tiltBeta: 2,
      tiltGamma: 1,
      includesGravity: true,
    });
  }
  const stats = motionStats(motion);
  assert.ok(stats.accStd < 1.15, `expected soft bounce, got accStd=${stats.accStd}`);
  assert.equal(stats.runningLikeMotion, true);
  const analysis = analyzeRun({ gps, motion, durationMs: 8000 });
  assert.equal(analysis.valid, true);
  assert.ok(analysis.maxSpeedKmh >= 8);
});

test("outdoor GPS accuracy 41–45 m still yields a measurable peak", () => {
  const t0 = 1_000_000;
  const gps = [];
  const motion = [];
  const cadence = 3.1;
  for (let i = 0; i < 200; i++) {
    const t = t0 + i * 40;
    const bounce = 4.0 * Math.sin(2 * Math.PI * cadence * i * 0.04);
    if (i % 25 === 0) {
      gps.push({
        t,
        speedKmh: 18,
        accuracy: 42,
        lat: 32.08 + i * 0.00001,
        lng: 34.78,
      });
    }
    motion.push({
      t,
      accMag: 9.7 + bounce,
      ax: 2.2,
      ay: 0.3,
      az: 9.81,
      tiltBeta: 16,
      tiltGamma: 4,
      includesGravity: true,
    });
  }
  const kept = filterGpsPoints(gps);
  assert.ok(kept.length >= 4, `kept=${kept.length}`);
  const analysis = analyzeRun({ gps, motion, durationMs: 8000 });
  assert.equal(analysis.valid, true);
  assert.ok(analysis.maxSpeedKmh >= 8, `max=${analysis.maxSpeedKmh}`);
});

test("slow jog cadence (~1.85 Hz) sustains a measurable peak", () => {
  const t0 = 1_000_000;
  const gps = [];
  const motion = [];
  const cadence = 1.85;
  for (let i = 0; i < 220; i++) {
    const t = t0 + i * 40;
    const bounce = 2.8 * Math.sin(2 * Math.PI * cadence * i * 0.04);
    gps.push({ t, speedKmh: 11, accuracy: 12, lat: 32.08, lng: 34.78 });
    motion.push({
      t,
      accMag: 9.7 + bounce,
      tiltBeta: 8 + 4 * Math.sin(2 * Math.PI * cadence * i * 0.04),
      tiltGamma: 2,
    });
  }
  const analysis = analyzeRun({ gps, motion, durationMs: 8800 });
  assert.equal(analysis.valid, true);
  assert.ok(analysis.maxSpeedKmh >= 8, `max=${analysis.maxSpeedKmh}`);
  assert.ok((analysis.runWindows || []).length >= 1);
});

test("peak GPS filter accuracy cap matches fusion (45 m)", () => {
  assert.equal(MAX_GPS_ACCURACY_M, 45);
});

test("sustained run windows require MIN_RUN_SUSTAIN_MS", () => {
  assert.equal(MIN_RUN_SUSTAIN_MS, 3000);
  const session = sessionFromSampler(sampleRunning, 8);
  const windows = findSustainedRunWindows(session.motion, session.gps);
  assert.ok(windows.length >= 1);
  assert.ok(windows.every((w) => w.endMs - w.startMs >= MIN_RUN_SUSTAIN_MS - 50));
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

test("still phone at speed is not counted as a run", () => {
  const t0 = 1_000_000;
  const gps = [];
  const motion = [];
  for (let i = 0; i < 160; i++) {
    const t = t0 + i * 50;
    gps.push({ t, speedKmh: 28, accuracy: 8 });
    motion.push({ t, accMag: 9.81, tiltBeta: 2, tiltGamma: 0.4 });
  }
  const v = analyzeRun({ gps, motion, durationMs: 8000 });
  assert.equal(v.valid, false);
  assert.equal(v.maxSpeedKmh, 0);
  assert.ok(
    v.flags.includes("still_phone") ||
      v.flags.includes("no_run_sustain") ||
      v.flags.includes("vehicle_like_motion") ||
      v.label === "still_phone" ||
      v.label === "no_run_sustain"
  );
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
  assert.equal(v.maxSpeedKmh, 0);
  assert.ok(
    v.flags.includes("imu_gps_mismatch") ||
      v.flags.includes("no_run_sustain") ||
      v.label === "imu_gps_mismatch" ||
      v.label === "no_run_sustain"
  );
});

test("official GPS peak uses rolling mean over ~1.5s window", async () => {
  const { findSustainedGpsPeakKmh, findRollingMeanPeak, PEAK_WINDOW_MS } =
    await import("../js/anticheat.js");
  assert.equal(PEAK_WINDOW_MS, 1500);
  const t0 = 1_000_000;
  const gps = [];
  for (let i = 0; i < 80; i++) {
    gps.push({ t: t0 + i * 40, speedKmh: 24 + Math.sin(i / 8), accuracy: 6, lat: 32.08, lng: 34.78 });
  }
  const sustained = findSustainedGpsPeakKmh(gps);
  assert.ok(sustained.peakKmh >= 22);
  assert.equal(sustained.sustained, true);
  assert.equal(sustained.method, "rolling_mean");

  // A brief spike must not become the official peak
  const spiked = [
    ...gps,
    { t: t0 + 4000, speedKmh: 55, accuracy: 6, lat: 32.08, lng: 34.78 },
    { t: t0 + 4050, speedKmh: 12, accuracy: 6, lat: 32.08, lng: 34.78 },
  ];
  const rolled = findRollingMeanPeak(spiked, (p) => p.speedKmh, {
    windowMs: PEAK_WINDOW_MS,
    minSpeedKmh: 6,
  });
  assert.ok(rolled.peakKmh < 40);
});

test("zero official peak is not a measured run", () => {
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
  assert.equal(analysis.maxSpeedKmh, 0);
  assert.ok(
    analysis.label === "no_speed" ||
      analysis.label === "no_run_sustain" ||
      analysis.flags.includes("no_speed") ||
      analysis.flags.includes("no_run_sustain")
  );
});

test("live max and final max use the same official peak metric", async () => {
  const { Tracker } = await import("../js/tracker.js");
  const tracker = new Tracker(null, { officialPeakIntervalMs: 0 });
  tracker.startDemo();
  const t0 = 1_000_000;
  const cadence = 3.15;
  for (let i = 0; i < 160; i++) {
    const t = t0 + i * 50;
    const tSec = i * 0.05;
    const bounce = 4.2 * Math.sin(2 * Math.PI * cadence * tSec);
    tracker.ingest({
      t,
      speedKmh: 20 + Math.sin(i / 6),
      accuracy: 6,
      lat: 32.08 + i * 0.00002,
      lng: 34.78,
      ax: 2.2 + bounce * 0.3,
      ay: 0.3,
      az: 9.81,
      accMag: 9.7 + bounce,
      tiltBeta: 18 + 11 * Math.sin(2 * Math.PI * cadence * tSec),
      tiltGamma: 4 + 3 * Math.sin(2 * Math.PI * cadence * tSec + 0.4),
      includesGravity: true,
    });
  }
  assert.ok(tracker.hasDisplayableRun());
  const liveMax = tracker.liveApprovedMaxKmh(true);
  const session = tracker.stop();
  const analysis = analyzeRun(session);
  assert.ok(liveMax > 8);
  assert.equal(analysis.maxSpeedKmh, liveMax);
  assert.equal(session.officialPeakKmh, analysis.maxSpeedKmh);
});

test("speedometer stays at zero until 3s of run-like motion", async () => {
  const { Tracker } = await import("../js/tracker.js");
  const updates = [];
  const tracker = new Tracker((u) => updates.push(u), { officialPeakIntervalMs: 0 });
  tracker.startDemo();
  const t0 = 1_000_000;
  const cadence = 3.15;
  for (let i = 0; i < 40; i++) {
    const t = t0 + i * 50;
    const tSec = i * 0.05;
    const bounce = 4.2 * Math.sin(2 * Math.PI * cadence * tSec);
    tracker.ingest({
      t,
      speedKmh: 18,
      accuracy: 6,
      lat: 32.08 + i * 0.00002,
      lng: 34.78,
      ax: 2.2,
      ay: 0.3,
      az: 9.81,
      accMag: 9.7 + bounce,
      tiltBeta: 18 + 11 * Math.sin(2 * Math.PI * cadence * tSec),
      tiltGamma: 4,
      includesGravity: true,
    });
  }
  // ~2 s — still below sustain gate
  assert.equal(tracker.displaySpeedKmh(), 0);
  assert.equal(tracker.liveApprovedMaxKmh(), 0);

  for (let i = 40; i < 140; i++) {
    const t = t0 + i * 50;
    const tSec = i * 0.05;
    const bounce = 4.2 * Math.sin(2 * Math.PI * cadence * tSec);
    tracker.ingest({
      t,
      speedKmh: 18,
      accuracy: 6,
      lat: 32.08 + i * 0.00002,
      lng: 34.78,
      ax: 2.2,
      ay: 0.3,
      az: 9.81,
      accMag: 9.7 + bounce,
      tiltBeta: 18 + 11 * Math.sin(2 * Math.PI * cadence * tSec),
      tiltGamma: 4,
      includesGravity: true,
    });
  }
  assert.ok(tracker.hasDisplayableRun());
  assert.ok(tracker.displaySpeedKmh() >= 6);
  assert.ok(tracker.liveApprovedMaxKmh(true) >= 6);
});

test("invalid runs are excluded from PR chart", () => {
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
