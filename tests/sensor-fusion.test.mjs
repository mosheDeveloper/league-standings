import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SensorFusion,
  SpeedKalman,
  horizontalComponent,
  validateGpsSample,
  fuseSession,
  gpsAccuracyToR,
} from "../js/sensor-fusion.js";
import { Tracker } from "../js/tracker.js";
import { analyzeRun, resolvePeakSpeedKmh } from "../js/anticheat.js";

test("Kalman predict integrates forward accel between GPS updates", () => {
  const k = new SpeedKalman({ q: 1, r: 2, p0: 1 });
  // Seed state near 5 m/s (partial pull on first measurement is expected)
  k.v = 5;
  k.P = 1;
  // Sprint burst: +4 m/s² for 0.5 s → +2 m/s
  k.predict(4, 0.5);
  assert.ok(k.v > 6.5 && k.v < 7.5);
});

test("horizontal projection strips gravity-aligned bounce", () => {
  // Gravity along +Z; linear bounce also along Z should vanish horizontally
  const h = horizontalComponent(0, 0, 5, 0, 0, 9.81);
  assert.ok(Math.hypot(h.hx, h.hy, h.hz) < 1e-9);
  // Forward surge along +X survives
  const f = horizontalComponent(3, 0, 1, 0, 0, 9.81);
  assert.ok(Math.abs(f.hx - 3) < 1e-9);
  assert.ok(Math.abs(f.hz) < 1e-6);
});

test("orientation (rotated phone) yields same forward magnitude", () => {
  // Same physical surge, phone rotated 90° about Z: device X↔Y swap
  const a = horizontalComponent(4, 0, 0.2, 0, 0, 9.8);
  const b = horizontalComponent(0, 4, 0.2, 0, 0, 9.8);
  assert.ok(Math.abs(Math.hypot(a.hx, a.hy, a.hz) - Math.hypot(b.hx, b.hy, b.hz)) < 1e-9);
});

test("GPS teleport spikes are rejected by validateGpsSample", () => {
  const prev = { t: 0, speedKmh: 12, accuracy: 5, lat: 32.08, lng: 34.78 };
  const spike = { t: 200, speedKmh: 80, accuracy: 5, lat: 32.08, lng: 34.78 };
  const ok = { t: 400, speedKmh: 13, accuracy: 5, lat: 32.0801, lng: 34.78 };
  assert.equal(validateGpsSample(prev, spike).accept, false);
  assert.equal(validateGpsSample(prev, ok).accept, true);
});

test("fusion captures peak sprint between 1 Hz GPS samples", () => {
  const fusion = new SensorFusion();
  const t0 = 1_000_000;

  // Steady 20 km/h GPS lock
  fusion.pushGps({ t: t0, speedKmh: 20, accuracy: 6, lat: 32.08, lng: 34.78 });

  // 800 ms of forward accel @ 75 Hz that GPS will miss until next fix
  // a = 5 m/s² for 0.8 s → +4 m/s ≈ +14.4 km/h → peak ~34.4 km/h
  for (let i = 1; i <= 60; i++) {
    const t = t0 + (i * 1000) / 75;
    fusion.pushAccel({
      t,
      ax: 5,
      ay: 0,
      az: 9.81,
      includesGravity: true,
    });
  }

  const peakFused = fusion.peakFusedKmh();
  const peakGps = fusion.peakRawGpsKmh();
  assert.equal(peakGps, 20);
  assert.ok(peakFused > peakGps + 8, `expected fused peak >> GPS, got ${peakFused}`);
  assert.ok(peakFused < 45, `fused peak unrealistically high: ${peakFused}`);

  // Next GPS arrives lower (averaged) — fusion should pull toward it but keep history peak
  fusion.pushGps({ t: t0 + 1000, speedKmh: 24, accuracy: 6, lat: 32.0802, lng: 34.78 });
  assert.ok(fusion.peakFusedKmh() >= peakFused - 0.05);
});

test("rejected GPS spike does not inflate fused speed", () => {
  const fusion = new SensorFusion();
  fusion.pushGps({ t: 0, speedKmh: 15, accuracy: 5 });
  const before = fusion.currentSpeedKmh();
  // 55 km/h in 150 ms is a teleport but under the hard cap (72)
  const res = fusion.pushGps({ t: 150, speedKmh: 55, accuracy: 5 });
  assert.equal(res.accepted, false);
  assert.ok(res.reason === "speed_teleport" || res.reason === "vs_fused");
  assert.ok(Math.abs(fusion.currentSpeedKmh() - before) < 0.5);
  assert.ok(fusion.getDebugSnapshot().gpsRejectedCount >= 1);
});

test("GPS jump vs fused estimate is rejected even at 1 Hz spacing", () => {
  const fusion = new SensorFusion();
  fusion.pushGps({ t: 0, speedKmh: 20, accuracy: 5 });
  for (let i = 1; i <= 40; i++) {
    fusion.pushAccel({
      t: i * 20,
      ax: 2,
      ay: 0,
      az: 9.81,
      includesGravity: true,
    });
  }
  const before = fusion.currentSpeedKmh();
  const res = fusion.pushGps({ t: 1000, speedKmh: 58, accuracy: 5 });
  assert.equal(res.accepted, false);
  assert.equal(res.reason, "vs_fused");
  assert.ok(Math.abs(fusion.currentSpeedKmh() - before) < 0.5);
});

test("debug snapshot exposes raw vs fused fields", () => {
  const fusion = new SensorFusion();
  fusion.pushGps({ t: 0, speedKmh: 18, accuracy: 8 });
  fusion.pushAccel({ t: 20, ax: 1, ay: 0, az: 9.81, includesGravity: true });
  const d = fusion.getDebugSnapshot();
  assert.equal(typeof d.rawGpsSpeedKmh, "number");
  assert.equal(typeof d.fusedSpeedKmh, "number");
  assert.equal(typeof d.peakFusedKmh, "number");
  assert.equal(typeof d.peakRawGpsKmh, "number");
  assert.equal(typeof d.aForwardMs2, "number");
  assert.ok("kalmanP" in d);
  assert.ok("gpsAccepted" in d);
});

test("gpsAccuracyToR grows with worse accuracy", () => {
  assert.ok(gpsAccuracyToR(25) > gpsAccuracyToR(5));
});

test("live display speed ignores IMU-only spikes (confirmed GPS only)", () => {
  const fusion = new SensorFusion();
  fusion.pushGps({ t: 1000, speedKmh: 0, accuracy: 5, lat: 32.08, lng: 34.78 });

  for (let i = 1; i <= 60; i++) {
    fusion.pushAccel({
      t: 1000 + i * 15,
      ax: 6,
      ay: 0,
      az: 9.81,
      includesGravity: true,
    });
  }

  assert.ok(fusion.currentSpeedKmh() > 5, "fused speed should rise from IMU");
  assert.equal(fusion.confirmedSpeedKmh(2000), 0, "confirmed speed stays at last GPS");
  assert.equal(fusion.peakConfirmedGpsKmh(), 0);
});

test("confirmed speed updates only on accepted GPS fixes", () => {
  const fusion = new SensorFusion();
  fusion.pushGps({ t: 0, speedKmh: 12, accuracy: 5 });
  assert.equal(fusion.confirmedSpeedKmh(500), 12);

  fusion.pushGps({ t: 1000, speedKmh: 18, accuracy: 5 });
  assert.equal(fusion.confirmedSpeedKmh(1500), 18);
  assert.equal(fusion.peakConfirmedGpsKmh(), 18);

  const spike = fusion.pushGps({ t: 1150, speedKmh: 55, accuracy: 5 });
  assert.equal(spike.accepted, false);
  assert.equal(fusion.confirmedSpeedKmh(1200), 18, "rejected spike does not change display");
});

test("Tracker live display uses confirmed GPS, not fused IMU", () => {
  const updates = [];
  const tracker = new Tracker((u) => updates.push(u));
  tracker.startDemo();

  const t0 = Date.now();
  tracker.ingest({ t: t0, speedKmh: 0, accuracy: 5, lat: 32.08, lng: 34.78 });
  for (let i = 1; i <= 50; i++) {
    tracker.ingest({
      t: t0 + i * 15,
      ax: 5,
      ay: 0,
      az: 9.81,
      accMag: Math.hypot(5, 9.81),
      includesGravity: true,
    });
  }

  const last = updates[updates.length - 1];
  assert.ok(tracker.currentSpeedKmh() > 5, "internal fused speed rises");
  assert.equal(last.speedKmh, 0, "live display stays at confirmed GPS");
  assert.equal(last.maxKmh, 0, "live max uses confirmed GPS peak only");
  assert.ok(last.fusedSpeedKmh > 5, "fused speed still available for analysis");
});

test("Tracker live max uses fusion and stop() cleans listeners + returns fused series", async () => {
  const updates = [];
  const tracker = new Tracker((u) => updates.push(u), { debug: true });
  tracker.startDemo();

  const t0 = Date.now();
  tracker.ingest({
    t: t0,
    speedKmh: 18,
    accuracy: 5,
    lat: 32.08,
    lng: 34.78,
  });
  for (let i = 1; i <= 40; i++) {
    tracker.ingest({
      t: t0 + i * 15,
      ax: 4.5,
      ay: 0.2,
      az: 9.81,
      accMag: Math.hypot(4.5, 0.2, 9.81),
      includesGravity: true,
    });
  }

  assert.ok(tracker.liveMaxKmh() > tracker.rawGpsMaxKmh());
  assert.ok(updates.some((u) => u.fusion && u.maxKmh > 0));

  const session = tracker.stop();
  assert.equal(tracker.active, false);
  assert.equal(tracker._motionHandler, null);
  assert.equal(tracker.watchId, null);
  assert.ok(session.fused.length > 0);
  assert.ok(session.fusionDebug.peakFusedKmh >= session.fusionDebug.peakRawGpsKmh);

  const peak = resolvePeakSpeedKmh(session);
  assert.equal(peak.source, "live_fusion");
  assert.ok(peak.maxSpeedKmh > 18);
});

test("analyzeRun prefers fused peak from session.fused", () => {
  // Interleave GPS and IMU by timestamp so fusion sees a mid-interval surge
  const tracker = new Tracker();
  tracker.startDemo();
  tracker.ingest({ t: 0, speedKmh: 22, accuracy: 6, lat: 32, lng: 34 });
  for (let i = 1; i <= 50; i++) {
    tracker.ingest({
      t: i * 15,
      ax: 3,
      ay: 0,
      az: 9.81,
      accMag: Math.hypot(3, 9.81),
      tiltBeta: 12,
      tiltGamma: 3,
      includesGravity: true,
    });
  }
  tracker.ingest({ t: 1000, speedKmh: 23, accuracy: 6, lat: 32.0001, lng: 34 });
  const session = tracker.stop();

  const analysis = analyzeRun(session);
  assert.equal(analysis.speedSource, "live_fusion");
  assert.ok(analysis.maxSpeedKmh >= analysis.gpsMaxKmh);
  assert.ok(analysis.maxSpeedKmh > 22);
});

test("fuseSession offline recovers mid-interval peak", () => {
  const gps = [
    { t: 0, speedKmh: 16, accuracy: 5, lat: 32, lng: 34 },
    { t: 1000, speedKmh: 18, accuracy: 5, lat: 32.0001, lng: 34 },
  ];
  const motion = [];
  for (let i = 1; i <= 70; i++) {
    motion.push({
      t: (i * 1000) / 70,
      ax: 6,
      ay: 0,
      az: 9.81,
      includesGravity: true,
    });
  }
  const out = fuseSession({ gps, motion });
  assert.ok(out.fusedMaxKmh > out.rawGpsMaxKmh + 5);
  assert.ok(out.debug.imuCount > 50);
});
