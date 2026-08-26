/**
 * Desktop/demo GPS + DeviceMotion simulation (running bounce vs car).
 */

import { mps } from "./anticheat.js";

const ORIGIN = { lat: 32.0853, lon: 34.7818 };

export function displace(origin, metersNorth, metersEast) {
  const dLat = metersNorth / 111320;
  const dLon = metersEast / (111320 * Math.cos((origin.lat * Math.PI) / 180));
  return { lat: origin.lat + dLat, lon: origin.lon + dLon };
}

function hash(n) {
  const x = Math.sin(n * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * @param {"run"|"car"} mode
 * @param {number} elapsedMs
 * @param {number} t0
 */
export function sampleAt(mode, elapsedMs, t0 = 0) {
  const t = t0 + elapsedMs;
  const sec = elapsedMs / 1000;
  if (mode === "car") {
    const speedKmh = 68 + Math.sin(sec / 8) * 6;
    const dist = mps(speedKmh) * sec;
    const pos = displace(ORIGIN, dist, Math.sin(sec / 20) * 4);
    return {
      gps: {
        t,
        lat: pos.lat,
        lon: pos.lon,
        speedMps: mps(speedKmh),
        accuracy: 8,
      },
      motion: {
        t,
        ax: 0.15 * Math.sin(sec * 1.1),
        ay: 0.12 * Math.cos(sec * 0.7),
        az: 9.75 + 0.08 * Math.sin(sec * 0.4),
        beta: 2 + 0.4 * Math.sin(sec * 0.5),
        gamma: 1 + 0.3 * Math.cos(sec * 0.4),
      },
    };
  }

  // Running: 14–22 km/h with ~3 Hz bounce and tilt oscillation.
  const cadence = 2.95;
  const speedKmh = 16 + 4 * Math.sin(sec / 6) + (hash(Math.floor(sec * 2)) - 0.5) * 1.2;
  const dist = mps(Math.max(8, speedKmh)) * sec;
  const pos = displace(ORIGIN, dist, Math.sin(sec / 12) * 2);
  const bounce = 5.8 * Math.sin(2 * Math.PI * cadence * sec);
  const tilt = 11 * Math.sin(2 * Math.PI * cadence * sec + 0.4);
  return {
    gps: {
      t,
      lat: pos.lat,
      lon: pos.lon,
      speedMps: mps(Math.max(8, speedKmh)),
      accuracy: 10,
    },
    motion: {
      t,
      ax: bounce * 0.35 + (hash(sec * 17) - 0.5) * 1.4,
      ay: bounce * 0.2 + (hash(sec * 13) - 0.5),
      az: 9.81 + bounce,
      beta: 8 + tilt,
      gamma: 4 + tilt * 0.6,
    },
  };
}

/** Inject a GPS teleport spike (for tests). */
export function gpsSpike(t, fromSample) {
  const pos = displace(
    { lat: fromSample.lat, lon: fromSample.lon },
    400,
    0
  );
  return {
    t: t + 200,
    lat: pos.lat,
    lon: pos.lon,
    speedMps: 80,
    accuracy: 12,
  };
}

export function generateTrack(mode, durationMs, hz = 10, t0 = 1_000_000) {
  const gps = [];
  const motion = [];
  const step = 1000 / hz;
  for (let e = 0; e <= durationMs; e += step) {
    const s = sampleAt(mode, e, t0);
    gps.push(s.gps);
    motion.push(s.motion);
  }
  return { gps, motion };
}
