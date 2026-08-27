/** Feeds the Tracker with synthetic GPS + IMU so we can test without a track. */

function hash(n) {
  const x = Math.sin(n * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

export function sampleRunning(tSec) {
  const cadence = 3.15;
  const bounce = 4.2 * Math.sin(2 * Math.PI * cadence * tSec);
  const speed =
    tSec < 1.2
      ? 8 * tSec
      : tSec < 3.2
        ? 18 + 10 * Math.sin((tSec - 1.2) * 0.9)
        : 32.6 + 2.4 * Math.sin(tSec * 1.4);
  return {
    speedKmh: Math.max(0, speed),
    accMag: 9.7 + bounce + (hash(tSec) - 0.5) * 0.4,
    tiltBeta: 18 + 11 * Math.sin(2 * Math.PI * cadence * tSec),
    tiltGamma: 4 + 3 * Math.sin(2 * Math.PI * cadence * tSec + 0.4),
    accuracy: 6,
  };
}

export function sampleCar(tSec) {
  const speed = Math.min(62, tSec * 18);
  return {
    speedKmh: speed,
    accMag: 9.81 + (hash(tSec + 9) - 0.5) * 0.18,
    tiltBeta: 4 + (hash(tSec + 3) - 0.5) * 0.5,
    tiltGamma: 1 + (hash(tSec + 5) - 0.5) * 0.3,
    accuracy: 5,
  };
}

export function playDemo(tracker, { kind = "run", durationMs = 6500, hz = 25 } = {}) {
  const started = performance.now();
  const dt = 1000 / hz;
  return new Promise((resolve) => {
    const tick = () => {
      if (!tracker.active) {
        resolve("stopped");
        return;
      }
      const elapsed = performance.now() - started;
      const tSec = elapsed / 1000;
      const sample = kind === "car" ? sampleCar(tSec) : sampleRunning(tSec);
      tracker.ingest({ t: Date.now(), ...sample });
      if (elapsed >= durationMs) {
        resolve("done");
        return;
      }
      setTimeout(tick, dt);
    };
    tick();
  });
}
