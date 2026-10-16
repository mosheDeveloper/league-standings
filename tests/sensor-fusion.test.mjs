import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SensorFusion,
  SpeedKalman,
  horizontalComponent,
  validateGpsSample,
  fuseSession,
  gpsAccuracyToR,
  haversineMeters,
} from "../js/sensor-fusion.js";
import { Tracker, buildLiveGpsIngest } from "../js/tracker.js";
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

test("approved speed updates only on accepted GPS while moving", () => {
  const fusion = new SensorFusion();
  fusion.pushGps({ t: 0, speedKmh: 15, accuracy: 5 });
  assert.ok(Math.abs(fusion.approvedSpeedKmh(500) - 15) < 0.05);
  assert.ok(Math.abs(fusion.peakApprovedKmh() - 15) < 0.05);

  for (let i = 1; i <= 40; i++) {
    fusion.pushAccel({
      t: i * 20,
      ax: 4,
      ay: 0,
      az: 9.81,
      includesGravity: true,
    });
  }
  // IMU-only drift must not change the approved live value
  assert.ok(Math.abs(fusion.approvedSpeedKmh(900) - 15) < 0.05);
  assert.ok(fusion.currentSpeedKmh() > 15);

  fusion.pushGps({ t: 1000, speedKmh: 55, accuracy: 5 });
  assert.ok(Math.abs(fusion.approvedSpeedKmh(1500) - 15) < 0.05);
  assert.ok(Math.abs(fusion.peakApprovedKmh() - 15) < 0.05);

  fusion.pushGps({ t: 2000, speedKmh: 24, accuracy: 5 });
  assert.ok(fusion.approvedSpeedKmh(2500) > 15);
  assert.ok(fusion.peakApprovedKmh() >= fusion.approvedSpeedKmh(2500));
  assert.ok(fusion.peakApprovedKmh() <= 24.5);
});

test("buildLiveGpsIngest uses wall clock, not lagged pos.timestamp", () => {
  const wall = 2_000_000;
  const pos = {
    timestamp: wall - 3500,
    coords: {
      speed: 5, // m/s → 18 km/h
      accuracy: 8,
      latitude: 32.08,
      longitude: 34.78,
    },
  };
  const sample = buildLiveGpsIngest(pos, null, wall);
  assert.ok(sample);
  assert.equal(sample.t, wall);
  assert.ok(Math.abs(sample.speedKmh - 18) < 0.01);
});

test("buildLiveGpsIngest skips unknown speed instead of coercing to 0", () => {
  const wall = 2_000_000;
  const pos = {
    timestamp: wall,
    coords: {
      speed: null,
      accuracy: 10,
      latitude: 32.08,
      longitude: 34.78,
    },
  };
  assert.equal(buildLiveGpsIngest(pos, null, wall), null);
});

test("buildLiveGpsIngest derives speed from lat/lng with GPS device timestamps", () => {
  const wall = 2_000_000;
  const lat0 = 32.08;
  const lng0 = 34.78;
  // ~5 m north in 1 s ≈ 18 km/h
  const lat1 = lat0 + 5 / 111_320;
  const last = { lat: lat0, lng: lng0, gpsTimestamp: wall - 4500 };
  const pos = {
    timestamp: wall - 3500,
    coords: { speed: null, accuracy: 9, latitude: lat1, longitude: lng0 },
  };
  const sample = buildLiveGpsIngest(pos, last, wall);
  assert.ok(sample);
  assert.equal(sample.t, wall);
  const expected =
    (haversineMeters(lat0, lng0, lat1, lng0) / 1) * 3.6;
  assert.ok(Math.abs(sample.speedKmh - expected) < 0.5);
});

test("live meter opens when GPS shares the IMU wall clock (lagged GPS time would zero it)", () => {
  const updates = [];
  const tracker = new Tracker((u) => updates.push(u), { officialPeakIntervalMs: 0 });
  tracker.startDemo();
  const wall0 = Date.now();
  const cadence = 3.15;
  for (let i = 0; i <= 400; i++) {
    const wall = wall0 + i * 15;
    const tSec = (i * 15) / 1000;
    const bounce = 4.2 * Math.sin(2 * Math.PI * cadence * tSec);
    // IMU on wall clock
    tracker.ingest({
      t: wall,
      ax: 4.5,
      ay: 0.2,
      az: 9.81,
      accMag: 9.7 + bounce,
      tiltBeta: 18 + 11 * Math.sin(2 * Math.PI * cadence * tSec),
      tiltGamma: 4,
      includesGravity: true,
    });
    if (i % 40 === 0) {
      // Production path: buildLiveGpsIngest stamps wall time even if device GPS clock lags.
      const sample = buildLiveGpsIngest(
        {
          timestamp: wall - 3000,
          coords: {
            speed: 5,
            accuracy: 8,
            latitude: 32.08 + (i / 40) * 0.00005,
            longitude: 34.78,
          },
        },
        null,
        wall
      );
      tracker.ingest(sample);
    }
  }
  const last = updates[updates.length - 1];
  assert.equal(last.runReady, true);
  assert.ok(last.speedKmh >= 16, `speed=${last.speedKmh}`);
  assert.ok(last.maxKmh >= 8, `max=${last.maxKmh}`);
});

test("Tracker live UI hides speed until run sustain, then uses GPS-anchored speed", () => {
  const updates = [];
  const tracker = new Tracker((u) => updates.push(u), { officialPeakIntervalMs: 0 });
  tracker.startDemo();
  const t0 = Date.now();
  const cadence = 3.15;
  for (let i = 0; i <= 400; i++) {
    const t = t0 + i * 15;
    const tSec = (i * 15) / 1000;
    const bounce = 4.2 * Math.sin(2 * Math.PI * cadence * tSec);
    const sample = {
      t,
      ax: 4.5,
      ay: 0.2,
      az: 9.81,
      accMag: 9.7 + bounce,
      tiltBeta: 18 + 11 * Math.sin(2 * Math.PI * cadence * tSec),
      tiltGamma: 4,
      includesGravity: true,
    };
    if (i % 40 === 0) {
      sample.speedKmh = 18;
      sample.accuracy = 5;
      sample.lat = 32.08 + (i / 40) * 0.00005;
      sample.lng = 34.78;
    }
    tracker.ingest(sample);
  }
  const early = updates.find((u) => u.durationMs < 2500);
  assert.ok(early);
  assert.equal(early.speedKmh, 0);
  const last = updates[updates.length - 1];
  assert.equal(last.runReady, true);
  assert.ok(last.speedKmh >= 16 && last.speedKmh <= 24);
  assert.ok(last.maxKmh >= 8);
  assert.equal(last.moving, true);
  // Raw fused may still drift above GPS-anchored display speed
  assert.ok(last.rawSpeedKmh + 0.05 >= last.speedKmh);
});

test("approved speed is zero when phone is still", () => {
  const updates = [];
  const tracker = new Tracker((u) => updates.push(u), { officialPeakIntervalMs: 0 });
  tracker.startDemo();
  const t0 = Date.now() - 5000;
  for (let g = 0; g <= 4; g++) {
    tracker.ingest({ t: t0 + g * 400, speedKmh: 12, accuracy: 5 });
  }
  tracker.ingest({ t: Date.now(), ax: 0, ay: 0, az: 9.81, accMag: 9.81, includesGravity: true });
  const last = updates[updates.length - 1];
  assert.equal(last.moving, false);
  assert.equal(last.speedKmh, 0);
  // Official rolling peak may still reflect prior GPS window; live speed stays 0 when still.
  assert.ok(last.maxKmh >= 0);
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

test("approved speed decays after GPS staleness window", () => {
  const fusion = new SensorFusion();
  fusion.pushGps({ t: 1000, speedKmh: 12, accuracy: 5 });
  assert.equal(fusion.approvedSpeedKmh(1500), 12);
  assert.equal(fusion.approvedSpeedKmh(4000), 0);
});

function ingestSustainedSprint(tracker, t0) {
  const cadence = 3.15;
  // ≥3 s of pocket-like bounce + GPS so the speedometer gate opens.
  for (let i = 0; i <= 400; i++) {
    const t = t0 + i * 15;
    const tSec = (i * 15) / 1000;
    const bounce = 4.2 * Math.sin(2 * Math.PI * cadence * tSec);
    const sample = {
      t,
      ax: 4.5,
      ay: 0.2,
      az: 9.81,
      accMag: 9.7 + bounce,
      tiltBeta: 18 + 11 * Math.sin(2 * Math.PI * cadence * tSec),
      tiltGamma: 4 + 3 * Math.sin(2 * Math.PI * cadence * tSec + 0.4),
      includesGravity: true,
    };
    if (i % 50 === 0) {
      sample.speedKmh = 18 + Math.min(6, Math.floor(i / 50) * 2);
      sample.accuracy = 5;
      sample.lat = 32.08 + (i / 50) * 0.0001;
      sample.lng = 34.78;
    }
    tracker.ingest(sample);
  }
}

test("Tracker live max uses fusion and stop() cleans listeners + returns fused series", async () => {
  const updates = [];
  const tracker = new Tracker((u) => updates.push(u), {
    debug: true,
    officialPeakIntervalMs: 0,
  });
  tracker.startDemo();

  const t0 = Date.now();
  ingestSustainedSprint(tracker, t0);

  assert.ok(tracker.liveMaxKmh() > tracker.rawGpsMaxKmh());
  assert.ok(tracker.liveApprovedMaxKmh(true) > 0);
  assert.ok(updates.some((u) => u.fusion && u.maxKmh > 0));

  const session = tracker.stop();
  assert.equal(tracker.active, false);
  assert.equal(tracker._motionHandler, null);
  assert.equal(tracker.watchId, null);
  assert.ok(session.fused.length > 0);
  assert.ok(session.fusionDebug.peakFusedKmh >= session.fusionDebug.peakRawGpsKmh);

  const peak = resolvePeakSpeedKmh(session);
  assert.ok(peak.source === "live_fusion" || peak.source === "gps_sustained");
  assert.ok(peak.maxSpeedKmh > 18);
  assert.equal(session.officialPeakKmh, peak.maxSpeedKmh);
});

test("analyzeRun prefers sustained fused peak from session.fused", () => {
  const tracker = new Tracker();
  tracker.startDemo();
  ingestSustainedSprint(tracker, 0);
  const session = tracker.stop();

  const analysis = analyzeRun(session);
  assert.ok(analysis.speedSource === "live_fusion" || analysis.speedSource === "gps_sustained");
  assert.ok(analysis.maxSpeedKmh >= 20);
  assert.ok(analysis.maxSpeedKmh > 22 || analysis.gpsMaxKmh >= 22);
  assert.equal(analysis.valid, true);
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
