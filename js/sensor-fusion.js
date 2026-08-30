/**
 * GPS + IMU sensor fusion for peak sprint / agility speed.
 *
 * Dual stream:
 *   - GPS ~1 Hz: absolute speed / position (noisy, under-samples short peaks)
 *   - Accelerometer ~50–100 Hz: forward linear accel between GPS fixes
 *
 * Pipeline:
 *   1. Estimate gravity via exponential low-pass → linear accel = raw − gravity
 *   2. Project linear accel onto the horizontal plane (⊥ gravity) so waist-belt
 *      vs arm-band orientation does not corrupt the forward axis
 *   3. Track a smoothed horizontal heading from accel + GPS displacement
 *   4. 1-D Kalman filter: predict with a_forward·dt, update with GPS speed
 *   5. Reject impossible GPS jumps before they enter the filter
 */

const MS_TO_KMH = 3.6;
const KMH_TO_MS = 1 / 3.6;

/** Soft human / vehicle hard cap used when rejecting GPS teleports (m/s). */
const HARD_SPEED_CAP_MS = 72 / MS_TO_KMH; // ~20 m/s ≈ 72 km/h

/**
 * Exponential low-pass gravity tracker.
 * τ ≈ 1.5 s so short sprint surges do not get absorbed into ĝ.
 * α = dt / (τ + dt) each step.
 */
export function createGravityEstimator(tauSec = 1.5) {
  return {
    tauSec,
    g: null, // [gx, gy, gz] m/s²
    /**
     * @param {number} ax
     * @param {number} ay
     * @param {number} az
     * @param {number} dtSec
     * @returns {{ gx:number, gy:number, gz:number, lx:number, ly:number, lz:number }}
     */
    update(ax, ay, az, dtSec) {
      const dt = Math.max(1e-4, dtSec);
      if (!this.g) {
        // Bootstrap: treat the dominant axis as "up" and scale to |g|≈9.81.
        // Using the full first sample as gravity would poison ĝ with a sprint surge.
        const abs = [Math.abs(ax), Math.abs(ay), Math.abs(az)];
        const i = abs[0] >= abs[1] && abs[0] >= abs[2] ? 0 : abs[1] >= abs[2] ? 1 : 2;
        const vals = [ax, ay, az];
        this.g = [0, 0, 0];
        this.g[i] = (vals[i] >= 0 ? 1 : -1) * 9.81;
      } else {
        // α = dt/(τ+dt): larger dt → trust new sample more (standard EMA form)
        const alpha = dt / (this.tauSec + dt);
        this.g[0] += alpha * (ax - this.g[0]);
        this.g[1] += alpha * (ay - this.g[1]);
        this.g[2] += alpha * (az - this.g[2]);
      }
      return {
        gx: this.g[0],
        gy: this.g[1],
        gz: this.g[2],
        lx: ax - this.g[0],
        ly: ay - this.g[1],
        lz: az - this.g[2],
      };
    },
    reset() {
      this.g = null;
    },
  };
}

/**
 * Project a vector onto the plane perpendicular to gravity (horizontal plane
 * in the device frame). Orientation-invariant for belt / arm-band placement.
 *
 * a_h = a − (a · ĝ) ĝ
 */
export function horizontalComponent(lx, ly, lz, gx, gy, gz) {
  const gMag = Math.hypot(gx, gy, gz) || 1;
  const ux = gx / gMag;
  const uy = gy / gMag;
  const uz = gz / gMag;
  const alongG = lx * ux + ly * uy + lz * uz;
  return {
    hx: lx - alongG * ux,
    hy: ly - alongG * uy,
    hz: lz - alongG * uz,
  };
}

/**
 * 1-D Kalman filter on speed (scalar state v in m/s).
 *
 * Predict:  v⁻ = v + a·Δt ,   P⁻ = P + Q·Δt
 * Update:   K = P⁻/(P⁻+R) ,   v = v⁻ + K(z − v⁻) ,   P = (1−K)P⁻
 *
 * Q (process noise) models accel / heading uncertainty.
 * R (measurement noise) models GPS speed noise; inflated when accuracy is poor.
 */
export class SpeedKalman {
  constructor({ q = 1.2, r = 2.5, p0 = 4 } = {}) {
    this.v = 0; // m/s
    this.P = p0;
    this.Q = q;
    this.R = r;
  }

  reset() {
    this.v = 0;
    this.P = 4;
  }

  /** Dead-reckon speed using forward linear acceleration. */
  predict(aForwardMs2, dtSec) {
    const dt = Math.max(0, dtSec);
    if (dt <= 0) return this.v;
    this.v = Math.max(0, this.v + aForwardMs2 * dt);
    // Process noise grows with time between measurements
    this.P += this.Q * dt;
    return this.v;
  }

  /**
   * Incorporate a GPS speed measurement (m/s).
   * @param {number} zMs GPS speed
   * @param {number} [rOverride] optional R from GPS accuracy
   */
  update(zMs, rOverride) {
    if (!Number.isFinite(zMs) || zMs < 0) return this.v;
    const R = Number.isFinite(rOverride) ? rOverride : this.R;
    const K = this.P / (this.P + R);
    this.v = this.v + K * (zMs - this.v);
    this.P = (1 - K) * this.P;
    if (this.v < 0) this.v = 0;
    return this.v;
  }
}

/**
 * Map horizontal GPS accuracy (meters) → Kalman measurement noise R.
 * Worse accuracy → trust GPS less → larger R.
 */
export function gpsAccuracyToR(accuracyM, baseR = 2.5) {
  if (!Number.isFinite(accuracyM) || accuracyM <= 0) return baseR;
  // ~5 m → baseR; 25 m → ~4× baseR
  return baseR * (1 + accuracyM / 8);
}

/**
 * Reject GPS samples that teleport or imply impossible acceleration.
 * @returns {{ accept: boolean, reason: string|null }}
 */
export function validateGpsSample(prev, next, options = {}) {
  const maxJumpKmhPerSec = options.maxJumpKmhPerSec ?? 45;
  const hardCapKmh = options.hardCapKmh ?? 72;
  const maxAccuracy = options.maxAccuracy ?? 45;

  if (!next || !Number.isFinite(next.speedKmh)) {
    return { accept: false, reason: "invalid_speed" };
  }
  if (next.speedKmh > hardCapKmh) {
    return { accept: false, reason: "hard_cap" };
  }
  if (next.accuracy != null && next.accuracy > maxAccuracy) {
    return { accept: false, reason: "poor_accuracy" };
  }
  // Disagree violently with dead-reckoned / fused speed (catches teleports
  // even when the previous GPS fix was ~1 s ago and the jump rate looks "ok").
  if (Number.isFinite(options.refSpeedKmh)) {
    const dV = next.speedKmh - options.refSpeedKmh;
    if (dV > 18 && next.speedKmh > options.refSpeedKmh * 1.6 + 5) {
      return { accept: false, reason: "vs_fused" };
    }
  }
  if (prev && Number.isFinite(prev.speedKmh)) {
    const dt = (next.t - prev.t) / 1000;
    if (dt > 0.02) {
      const dV = Math.abs(next.speedKmh - prev.speedKmh);
      const jump = dV / dt;
      if (jump > maxJumpKmhPerSec && dV > 12) {
        return { accept: false, reason: "speed_teleport" };
      }
    }
    // Position teleport via haversine when both samples have coords
    if (
      Number.isFinite(prev.lat) &&
      Number.isFinite(prev.lng) &&
      Number.isFinite(next.lat) &&
      Number.isFinite(next.lng)
    ) {
      const dt = (next.t - prev.t) / 1000;
      if (dt > 0.05) {
        const dist = haversineMeters(prev.lat, prev.lng, next.lat, next.lng);
        const impliedKmh = (dist / dt) * 3.6;
        if (impliedKmh > hardCapKmh && dist > 35) {
          return { accept: false, reason: "position_teleport" };
        }
      }
    }
  }
  return { accept: true, reason: null };
}

export function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * Rolling EMA for noisy scalar series (optional debug / UI smoothing).
 */
export function ema(prev, sample, alpha = 0.25) {
  if (!Number.isFinite(sample)) return prev;
  if (!Number.isFinite(prev)) return sample;
  return prev + alpha * (sample - prev);
}

/**
 * Online GPS+IMU fusion engine used by Tracker.
 */
export class SensorFusion {
  constructor(options = {}) {
    this.opts = {
      /** Target IMU cadence; tracker may throttle before calling. */
      imuHz: options.imuHz ?? 75,
      /** Soft clamp on |a_forward| to kill contact shocks (m/s²). */
      maxAccelMs2: options.maxAccelMs2 ?? 14,
      /** Heading EMA for horizontal direction. */
      headingAlpha: options.headingAlpha ?? 0.12,
      ...options,
    };
    this.gravity = createGravityEstimator(1.5);
    this.kalman = new SpeedKalman();
    this.reset();
  }

  reset() {
    this.gravity.reset();
    this.kalman.reset();
    this._lastAccelT = null;
    this._lastGps = null;
    this._heading = null; // unit vector in device frame (horizontal)
    this._peakFusedMs = 0;
    this._peakRawGpsMs = 0;
    this._lastForwardAccel = 0;
    this._lastRawGpsKmh = 0;
    this._lastFusedKmh = 0;
    this._lastGpsAccepted = true;
    this._lastRejectReason = null;
    this._fusedSeries = []; // { t, fusedSpeedKmh, rawGpsSpeedKmh|null, aForward }
    this._gpsAcceptedCount = 0;
    this._gpsRejectedCount = 0;
    this._imuCount = 0;
  }

  /**
   * High-frequency accelerometer (+ optional gyro) sample.
   * Prefer linear acceleration (no gravity). If only including-gravity is
   * available, pass that and set `includesGravity: true`.
   * Optional gravityHint {gx,gy,gz} from accelerationIncludingGravity keeps
   * the horizontal plane correct when using OS linear accel.
   *
   * @param {{
   *   t: number,
   *   ax: number, ay: number, az: number,
   *   includesGravity?: boolean,
   *   gravityHint?: { gx:number, gy:number, gz:number },
   *   gx?: number, gy?: number, gz?: number,
   * }} sample
   * @returns {{ fusedSpeedKmh: number, aForward: number }}
   */
  pushAccel(sample) {
    const t = sample.t;
    const ax = sample.ax || 0;
    const ay = sample.ay || 0;
    const az = sample.az || 0;

    const dt =
      this._lastAccelT != null ? Math.min(0.05, Math.max(0, (t - this._lastAccelT) / 1000)) : 1 / this.opts.imuHz;
    this._lastAccelT = t;

    let lx;
    let ly;
    let lz;
    let gx;
    let gy;
    let gz;

    if (sample.includesGravity === false) {
      // OS linear accel — gravity already removed. Keep ĝ from hint or bootstrap.
      lx = ax;
      ly = ay;
      lz = az;
      const hint = sample.gravityHint;
      if (hint && Number.isFinite(hint.gx)) {
        const sep = this.gravity.update(hint.gx, hint.gy, hint.gz, dt);
        gx = sep.gx;
        gy = sep.gy;
        gz = sep.gz;
      } else if (this.gravity.g) {
        gx = this.gravity.g[0];
        gy = this.gravity.g[1];
        gz = this.gravity.g[2];
      } else {
        gx = 0;
        gy = 0;
        gz = 9.81;
        this.gravity.g = [gx, gy, gz];
      }
    } else {
      const sep = this.gravity.update(ax, ay, az, dt);
      gx = sep.gx;
      gy = sep.gy;
      gz = sep.gz;
      lx = sep.lx;
      ly = sep.ly;
      lz = sep.lz;
    }

    // Horizontal linear acceleration (orientation-invariant plane)
    const { hx, hy, hz } = horizontalComponent(lx, ly, lz, gx, gy, gz);
    const hMag = Math.hypot(hx, hy, hz);

    // Update heading when horizontal accel is meaningful (not bounce noise)
    if (hMag > 0.35) {
      const ux = hx / hMag;
      const uy = hy / hMag;
      const uz = hz / hMag;
      if (!this._heading) {
        this._heading = [ux, uy, uz];
      } else {
        const a = this.opts.headingAlpha;
        let nx = this._heading[0] + a * (ux - this._heading[0]);
        let ny = this._heading[1] + a * (uy - this._heading[1]);
        let nz = this._heading[2] + a * (uz - this._heading[2]);
        const nMag = Math.hypot(nx, ny, nz) || 1;
        this._heading = [nx / nMag, ny / nMag, nz / nMag];
      }
    }

    // Forward accel = projection onto heading; fall back to |a_h| when no heading yet
    let aForward = 0;
    if (this._heading) {
      aForward =
        hx * this._heading[0] + hy * this._heading[1] + hz * this._heading[2];
    } else {
      aForward = hMag; // bootstrap: treat any horizontal motion as forward
    }
    // Clamp contact spikes / phone slap
    aForward = Math.max(
      -this.opts.maxAccelMs2,
      Math.min(this.opts.maxAccelMs2, aForward)
    );
    this._lastForwardAccel = aForward;

    // Kalman predict between GPS fixes — this is what recovers sub-second peaks
    const v = this.kalman.predict(aForward, dt);
    this._peakFusedMs = Math.max(this._peakFusedMs, v);
    this._lastFusedKmh = v * MS_TO_KMH;
    this._imuCount += 1;

    const point = {
      t,
      fusedSpeedKmh: this._lastFusedKmh,
      rawGpsSpeedKmh: null,
      aForward,
    };
    this._fusedSeries.push(point);
    // Bound memory during long sessions (~2 min @ 75 Hz ≈ 9k samples)
    if (this._fusedSeries.length > 12000) {
      this._fusedSeries.splice(0, this._fusedSeries.length - 9000);
    }

    return { fusedSpeedKmh: this._lastFusedKmh, aForward };
  }

  /**
   * Low-frequency GPS sample.
   * @param {{
   *   t: number,
   *   speedKmh: number,
   *   accuracy?: number,
   *   lat?: number,
   *   lng?: number,
   * }} sample
   * @returns {{ fusedSpeedKmh: number, accepted: boolean, reason: string|null }}
   */
  pushGps(sample) {
    const rawKmh = sample.speedKmh;
    this._lastRawGpsKmh = rawKmh;
    if (Number.isFinite(rawKmh)) {
      this._peakRawGpsMs = Math.max(this._peakRawGpsMs, rawKmh * KMH_TO_MS);
    }

    const check = validateGpsSample(this._lastGps, sample, {
      ...this.opts,
      // Only compare against fused once we have a warmed estimate
      refSpeedKmh:
        this._gpsAcceptedCount > 0 || this._imuCount > 8
          ? this._lastFusedKmh || this.kalman.v * MS_TO_KMH
          : undefined,
    });
    this._lastGpsAccepted = check.accept;
    this._lastRejectReason = check.reason;

    if (!check.accept) {
      this._gpsRejectedCount += 1;
      // Still predict-only; do not corrupt Kalman with the spike
      return {
        fusedSpeedKmh: this._lastFusedKmh,
        accepted: false,
        reason: check.reason,
      };
    }

    // Optional heading nudge from GPS displacement (device-frame approx unused;
    // we only use speed magnitude for the scalar Kalman update).
    const zMs = rawKmh * KMH_TO_MS;
    const R = gpsAccuracyToR(sample.accuracy, this.kalman.R);
    let v;
    if (this._gpsAcceptedCount === 0 && this._imuCount === 0) {
      // Cold start: snap to first trusted GPS so dead-reckoning begins near truth
      this.kalman.v = Math.min(zMs, HARD_SPEED_CAP_MS);
      this.kalman.P = R;
      v = this.kalman.v;
    } else if (this._gpsAcceptedCount === 0) {
      // IMU ran first — pull hard toward GPS (inflate prior uncertainty)
      this.kalman.P = Math.max(this.kalman.P, 8);
      v = this.kalman.update(Math.min(zMs, HARD_SPEED_CAP_MS), R * 0.5);
    } else {
      v = this.kalman.update(Math.min(zMs, HARD_SPEED_CAP_MS), R);
    }
    this._peakFusedMs = Math.max(this._peakFusedMs, v);
    this._lastFusedKmh = v * MS_TO_KMH;
    this._lastGps = { ...sample };
    this._gpsAcceptedCount += 1;

    this._fusedSeries.push({
      t: sample.t,
      fusedSpeedKmh: this._lastFusedKmh,
      rawGpsSpeedKmh: rawKmh,
      aForward: this._lastForwardAccel,
    });

    return {
      fusedSpeedKmh: this._lastFusedKmh,
      accepted: true,
      reason: null,
    };
  }

  currentSpeedKmh() {
    return this._lastFusedKmh;
  }

  peakFusedKmh() {
    return this._peakFusedMs * MS_TO_KMH;
  }

  peakRawGpsKmh() {
    return this._peakRawGpsMs * MS_TO_KMH;
  }

  fusedSeries() {
    return this._fusedSeries.slice();
  }

  /**
   * Debugging / logging interface: raw GPS vs fused speed side-by-side.
   */
  getDebugSnapshot() {
    return {
      rawGpsSpeedKmh: round1(this._lastRawGpsKmh),
      fusedSpeedKmh: round1(this._lastFusedKmh),
      peakRawGpsKmh: round1(this.peakRawGpsKmh()),
      peakFusedKmh: round1(this.peakFusedKmh()),
      aForwardMs2: Math.round(this._lastForwardAccel * 100) / 100,
      kalmanV_ms: Math.round(this.kalman.v * 100) / 100,
      kalmanP: Math.round(this.kalman.P * 1000) / 1000,
      gpsAccepted: this._lastGpsAccepted,
      rejectReason: this._lastRejectReason,
      gpsAcceptedCount: this._gpsAcceptedCount,
      gpsRejectedCount: this._gpsRejectedCount,
      imuCount: this._imuCount,
      hasHeading: !!this._heading,
    };
  }
}

/**
 * Offline fusion over recorded GPS + motion arrays (for analyzeRun / tests).
 * Motion samples should include ax/ay/az when available; falls back to
 * high-pass of accMag as a coarse forward proxy.
 *
 * @returns {{
 *   fusedMaxKmh: number,
 *   rawGpsMaxKmh: number,
 *   series: Array<{t:number, fusedSpeedKmh:number, rawGpsSpeedKmh:number|null}>,
 *   debug: object,
 * }}
 */
export function fuseSession({ gps = [], motion = [] } = {}, options = {}) {
  const fusion = new SensorFusion(options);
  const events = [];

  for (const p of gps || []) {
    events.push({ kind: "gps", t: p.t, p });
  }
  for (const m of motion || []) {
    events.push({ kind: "imu", t: m.t, m });
  }
  events.sort((a, b) => a.t - b.t || (a.kind === "imu" ? -1 : 1));

  for (const ev of events) {
    if (ev.kind === "imu") {
      const m = ev.m;
      if (m.ax != null || m.ay != null || m.az != null) {
        fusion.pushAccel({
          t: m.t,
          ax: m.ax || 0,
          ay: m.ay || 0,
          az: m.az || 0,
          // Samples with gravity still in them (typical DeviceMotion includingGravity)
          includesGravity: m.includesGravity !== false && m.linear !== true,
        });
      } else if (Number.isFinite(m.accMag)) {
        // Coarse fallback: treat (accMag − 9.81) as unsigned forward accel
        const a = Math.max(-6, Math.min(6, (m.accMag || 9.81) - 9.81));
        fusion.pushAccel({
          t: m.t,
          ax: a,
          ay: 0,
          az: 9.81,
          includesGravity: true,
        });
      }
    } else {
      fusion.pushGps({
        t: ev.p.t,
        speedKmh: ev.p.speedKmh ?? (ev.p.speedMps != null ? ev.p.speedMps * 3.6 : 0),
        accuracy: ev.p.accuracy,
        lat: ev.p.lat,
        lng: ev.p.lng ?? ev.p.lon,
      });
    }
  }

  return {
    fusedMaxKmh: round1(fusion.peakFusedKmh()),
    rawGpsMaxKmh: round1(fusion.peakRawGpsKmh()),
    series: fusion.fusedSeries(),
    debug: fusion.getDebugSnapshot(),
  };
}

function round1(n) {
  return Math.round((Number(n) || 0) * 10) / 10;
}
