import {
  SensorFusion,
  haversineMeters,
  fuseSession,
} from "./sensor-fusion.js";
import {
  resolvePeakSpeedKmh,
  isRunLikeAt,
  MIN_RUN_SUSTAIN_MS,
  MIN_RUN_SPEED_KMH,
  RUN_SUSTAIN_GAP_MS,
} from "./anticheat.js";

export class Tracker {
  constructor(onUpdate, options = {}) {
    this.onUpdate = onUpdate;
    this.debug = !!options.debug;
    /** Target IMU processing rate (Hz); DeviceMotion may fire faster. */
    this._imuMinIntervalMs = 1000 / (options.imuHz ?? 75);
    /** How often to recompute the official rolling-window peak for live UI. */
    this._officialPeakIntervalMs = options.officialPeakIntervalMs ?? 250;
    this.reset();
  }

  reset() {
    this.active = false;
    this.startedAt = 0;
    this.gps = [];
    this.motion = [];
    this.watchId = null;
    this._motionHandler = null;
    this._orientHandler = null;
    this._tilt = { beta: 0, gamma: 0 };
    this._raf = null;
    this.gpsAccuracy = null;
    this.gpsError = null;
    this.fusion = new SensorFusion();
    this._lastImuProcessT = 0;
    this._lastMovingAt = 0;
    this._listenersAttached = false;
    this._cachedOfficialPeakKmh = 0;
    this._lastOfficialPeakAt = 0;
    this._peakCacheGpsLen = -1;
    /** Online sustain of run-like + GPS speed (gates the speedometer). */
    this._runStretchStart = null;
    this._runLastGoodAt = null;
    this._lastSustainCheckT = null;
  }

  /** Latest sample clock (tests/demos may use synthetic timestamps). */
  _sampleNow(fallback = Date.now()) {
    return (
      this._runLastGoodAt ??
      this._lastMovingAt ??
      this._lastImuProcessT ??
      (this.gps.length ? this.gps[this.gps.length - 1].t : fallback)
    );
  }

  /** True when recent IMU activity suggests the phone is being carried while moving. */
  isMoving(now = this._sampleNow()) {
    return this._lastMovingAt > 0 && now - this._lastMovingAt < 1500;
  }

  /**
   * Advance / reset the continuous run-like stretch used to gate live speed.
   * Requires pocket- or hand-running IMU pattern plus GPS-anchored speed.
   */
  _updateRunSustain(t = Date.now()) {
    // Pattern scoring is relatively heavy — check ~6–7×/s, not every IMU tick.
    if (this._lastSustainCheckT != null && t - this._lastSustainCheckT < 150) return;
    this._lastSustainCheckT = t;

    const speed = this.fusion.approvedSpeedKmh(t);
    const runLike = this.motion.length >= 8 && isRunLikeAt(this.motion, t);
    const ok = runLike && speed >= MIN_RUN_SPEED_KMH && this.isMoving(t);
    if (ok) {
      if (this._runStretchStart == null) this._runStretchStart = t;
      else if (this._runLastGoodAt != null && t - this._runLastGoodAt > RUN_SUSTAIN_GAP_MS) {
        this._runStretchStart = t;
      }
      this._runLastGoodAt = t;
    } else if (
      this._runStretchStart != null &&
      this._runLastGoodAt != null &&
      t - this._runLastGoodAt > RUN_SUSTAIN_GAP_MS
    ) {
      this._runStretchStart = null;
      this._runLastGoodAt = null;
    }
  }

  /** How long the current run-like + GPS stretch has lasted (ms). */
  runSustainMs(now = this._sampleNow()) {
    if (this._runStretchStart == null || this._runLastGoodAt == null) return 0;
    if (now - this._runLastGoodAt > RUN_SUSTAIN_GAP_MS) return 0;
    return Math.max(0, this._runLastGoodAt - this._runStretchStart);
  }

  /** True once the live meter may show a speed (≥ MIN_RUN_SUSTAIN_MS). */
  hasDisplayableRun(now = this._sampleNow()) {
    return this.runSustainMs(now) >= MIN_RUN_SUSTAIN_MS;
  }

  approvedSpeedKmh(now = this._sampleNow()) {
    if (!this.isMoving(now)) return 0;
    return this.fusion.approvedSpeedKmh(now);
  }

  /**
   * Speedometer value: GPS-anchored speed only after ≥3 s of run-like motion.
   * Hand waves, car travel, and brief jolts stay at 0.
   */
  displaySpeedKmh(now = this._sampleNow()) {
    if (!this.hasDisplayableRun(now)) return 0;
    return this.approvedSpeedKmh(now);
  }

  /**
   * Live "שיא" must match the post-run official metric (rolling-window mean
   * inside a ≥3 s run-like window). Stays 0 until that sustain is met.
   */
  liveApprovedMaxKmh(force = false) {
    const now = this._sampleNow();
    // Hide max until the first ≥3 s run stretch; once recorded, keep it even
    // if the live stretch drops (live speed goes to 0, שיא stays).
    if (
      this.active &&
      !this.hasDisplayableRun(now) &&
      !force &&
      this._cachedOfficialPeakKmh <= 0
    ) {
      return 0;
    }
    const gpsLen = this.gps.length;
    const gpsChanged = gpsLen !== this._peakCacheGpsLen;
    const wall = Date.now();
    if (
      !force &&
      !gpsChanged &&
      this._lastOfficialPeakAt > 0 &&
      wall - this._lastOfficialPeakAt < this._officialPeakIntervalMs
    ) {
      return this._cachedOfficialPeakKmh;
    }
    if (this.active && !this.hasDisplayableRun(now) && this._cachedOfficialPeakKmh <= 0) {
      this._lastOfficialPeakAt = wall;
      this._peakCacheGpsLen = gpsLen;
      return 0;
    }
    const peak = resolvePeakSpeedKmh({
      gps: this.gps,
      motion: this.motion,
      fused: this.fusion.fusedSeries(),
    });
    this._cachedOfficialPeakKmh = peak.maxSpeedKmh || 0;
    this._lastOfficialPeakAt = wall;
    this._peakCacheGpsLen = gpsLen;
    return this._cachedOfficialPeakKmh;
  }

  currentSpeedKmh() {
    // Prefer fused estimate; fall back to last raw GPS if fusion not warm yet
    const fused = this.fusion.currentSpeedKmh();
    if (fused > 0 || this.gps.length === 0) return fused;
    const last = this.gps[this.gps.length - 1];
    return last?.fusedSpeedKmh ?? last?.speedKmh ?? 0;
  }

  liveMaxKmh() {
    return this.fusion.peakFusedKmh();
  }

  rawGpsMaxKmh() {
    return this.fusion.peakRawGpsKmh();
  }

  /** Public debug/logging interface: raw GPS vs fused/filtered speed. */
  getFusionDebug() {
    return this.fusion.getDebugSnapshot();
  }

  ingest({
    t = Date.now(),
    speedKmh,
    accMag,
    ax,
    ay,
    az,
    gx,
    gy,
    gz,
    tiltBeta,
    tiltGamma,
    accuracy = 8,
    lat,
    lng,
    includesGravity,
    linear,
    gravityHint,
  }) {
    if (!this.active) return;

    if (speedKmh != null) {
      const gpsPoint = { t, speedKmh, accuracy, lat, lng };
      const { fusedSpeedKmh, accepted, reason } = this.fusion.pushGps(gpsPoint);
      this.gps.push({
        ...gpsPoint,
        fusedSpeedKmh,
        accepted,
        rejectReason: reason,
      });
    }

    if (accMag != null || ax != null || ay != null || az != null) {
      const hasAxes = ax != null || ay != null || az != null;
      const mag =
        accMag ??
        Math.sqrt((ax || 0) ** 2 + (ay || 0) ** 2 + (az || 0) ** 2);

      if (hasAxes) {
        const { aForward } = this.fusion.pushAccel({
          t,
          ax: ax || 0,
          ay: ay || 0,
          az: az || 0,
          includesGravity: linear === true ? false : includesGravity !== false,
          gravityHint: gravityHint || null,
          gx,
          gy,
          gz,
        });
        if (Math.abs(aForward) > 0.35 || Math.abs(mag - 9.81) > 0.7) {
          this._lastMovingAt = t;
        }
      } else {
        // Magnitude-only demos: feed residual over g as crude forward accel
        const a = Math.max(-6, Math.min(6, mag - 9.81));
        this.fusion.pushAccel({
          t,
          ax: a,
          ay: 0,
          az: 9.81,
          includesGravity: true,
        });
        if (Math.abs(a) > 0.35) this._lastMovingAt = t;
      }

      this.motion.push({
        t,
        accMag: mag,
        ax: ax ?? null,
        ay: ay ?? null,
        az: az ?? null,
        gx: gx ?? null,
        gy: gy ?? null,
        gz: gz ?? null,
        tiltBeta: tiltBeta ?? this._tilt.beta,
        tiltGamma: tiltGamma ?? this._tilt.gamma,
        linear: linear === true,
        includesGravity: linear === true ? false : includesGravity !== false,
      });
    }
    this._updateRunSustain(t);
    this._emit();
  }

  _emit() {
    if (!this.onUpdate) return;
    const debug = this.debug ? this.getFusionDebug() : undefined;
    const sustainMs = this.runSustainMs();
    this.onUpdate({
      durationMs: Date.now() - this.startedAt,
      speedKmh: this.displaySpeedKmh(),
      maxKmh: this.liveApprovedMaxKmh(),
      rawSpeedKmh: this.currentSpeedKmh(),
      rawMaxKmh: this.liveMaxKmh(),
      moving: this.isMoving(),
      runSustainMs: sustainMs,
      runReady: sustainMs >= MIN_RUN_SUSTAIN_MS,
      rawGpsSpeedKmh: this.fusion._lastRawGpsKmh,
      rawMaxKmhGps: this.rawGpsMaxKmh(),
      samples: this.gps.length,
      motion: this.motion.length,
      gpsAccuracy: this.gpsAccuracy,
      gpsError: this.gpsError,
      fusion: debug,
    });
  }

  async startLive() {
    this.reset();
    this.active = true;
    this.startedAt = Date.now();

    if (typeof DeviceMotionEvent !== "undefined" && DeviceMotionEvent.requestPermission) {
      try {
        await DeviceMotionEvent.requestPermission();
      } catch {
        /* iOS may deny; GPS still works */
      }
    }
    if (typeof DeviceOrientationEvent !== "undefined" && DeviceOrientationEvent.requestPermission) {
      try {
        await DeviceOrientationEvent.requestPermission();
      } catch {
        /* optional */
      }
    }

    // High-frequency inertial stream (~50–100 Hz after throttle)
    this._motionHandler = (ev) => {
      const now = Date.now();
      if (now - this._lastImuProcessT < this._imuMinIntervalMs) return;
      this._lastImuProcessT = now;

      // Prefer linear acceleration (gravity already removed by the OS).
      // Fall back to accelerationIncludingGravity and let fusion strip gravity.
      const linear = ev.acceleration;
      const withG = ev.accelerationIncludingGravity;
      const useLinear =
        linear && (linear.x != null || linear.y != null || linear.z != null);
      const a = useLinear ? linear : withG;
      if (!a) return;
      const ax = a.x || 0;
      const ay = a.y || 0;
      const az = a.z || 0;
      const mag = Math.sqrt(ax * ax + ay * ay + az * az);
      const r = ev.rotationRate;
      const gravityHint =
        useLinear && withG
          ? { gx: withG.x || 0, gy: withG.y || 0, gz: withG.z || 0 }
          : null;
      this.ingest({
        t: now,
        accMag: mag,
        ax,
        ay,
        az,
        gx: r?.alpha ?? null,
        gy: r?.beta ?? null,
        gz: r?.gamma ?? null,
        linear: !!useLinear,
        includesGravity: !useLinear,
        gravityHint,
      });
    };
    this._orientHandler = (ev) => {
      this._tilt.beta = ev.beta || 0;
      this._tilt.gamma = ev.gamma || 0;
    };
    window.addEventListener("devicemotion", this._motionHandler, { passive: true });
    window.addEventListener("deviceorientation", this._orientHandler, { passive: true });
    this._listenersAttached = true;

    if (!navigator.geolocation) {
      this._detachSensors();
      throw new Error("אין GPS במכשיר");
    }

    // Low-frequency spatial stream (~1 Hz from the OS; we don't force slower)
    this.watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const { speed, accuracy, latitude, longitude } = pos.coords;
        let speedKmh = speed != null && speed >= 0 ? speed * 3.6 : null;
        const last = this.gps[this.gps.length - 1];
        // Derive speed from lat/lng deltas when the OS omits instantaneous speed
        if ((speedKmh == null || Number.isNaN(speedKmh)) && last?.lat != null) {
          const dt = (pos.timestamp - last.t) / 1000;
          if (dt > 0.3) {
            const d = haversineMeters(last.lat, last.lng, latitude, longitude);
            speedKmh = (d / dt) * 3.6;
          }
        }
        this.ingest({
          t: pos.timestamp || Date.now(),
          speedKmh: speedKmh ?? 0,
          accuracy,
          lat: latitude,
          lng: longitude,
        });
        this.gpsAccuracy = accuracy;
      },
      (err) => {
        this.lastError = err.message;
        this.gpsError = err;
        this._emit();
      },
      { enableHighAccuracy: true, maximumAge: 250, timeout: 8000 }
    );
  }

  startDemo() {
    this.reset();
    this.active = true;
    this.startedAt = Date.now();
  }

  /** Remove motion/orientation listeners (idempotent). */
  _detachSensors() {
    if (this._motionHandler) {
      window.removeEventListener("devicemotion", this._motionHandler);
      this._motionHandler = null;
    }
    if (this._orientHandler) {
      window.removeEventListener("deviceorientation", this._orientHandler);
      this._orientHandler = null;
    }
    this._listenersAttached = false;
  }

  stop() {
    this.active = false;
    if (this.watchId != null) {
      navigator.geolocation.clearWatch(this.watchId);
      this.watchId = null;
    }
    this._detachSensors();
    const durationMs = Date.now() - this.startedAt;
    const fused = this.fusion.fusedSeries();
    const officialPeak = resolvePeakSpeedKmh({
      gps: this.gps,
      motion: this.motion,
      fused,
      fusionDebug: this.getFusionDebug(),
    });
    this._cachedOfficialPeakKmh = officialPeak.maxSpeedKmh || 0;
    return {
      gps: this.gps.slice(),
      motion: this.motion.slice(),
      fused,
      fusionDebug: this.getFusionDebug(),
      durationMs,
      startedAt: this.startedAt,
      officialPeakKmh: this._cachedOfficialPeakKmh,
      officialPeak,
    };
  }
}

/** One-shot GPS lock check before a run may start. */
export function probeGps({ timeout = 9000, maxAccuracyM = 45 } = {}) {
  return new Promise((resolve) => {
    if (!navigator.geolocation) {
      resolve({
        ok: false,
        reason: "unsupported",
        message: "אין GPS במכשיר. אי אפשר להתחיל מדידה.",
      });
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const accuracy = pos.coords.accuracy;
        if (Number.isFinite(accuracy) && accuracy > maxAccuracyM) {
          resolve({
            ok: false,
            reason: "weak",
            accuracy,
            message: `אין קליטת GPS מספיקה (דיוק ${Math.round(accuracy)} מ׳). צאו לאוויר הפתוח ושפרו מיקום כדי להתחיל.`,
          });
          return;
        }
        resolve({ ok: true, accuracy, coords: pos.coords });
      },
      (err) => {
        const denied = err.code === 1;
        resolve({
          ok: false,
          reason: denied ? "denied" : "unavailable",
          message: denied
            ? "אין הרשאת מיקום. אפשרו GPS כדי להתחיל ריצה."
            : "אין קליטת GPS. הדליקו מיקום, צאו החוצה, ושפרו קליטה כדי להתחיל.",
        });
      },
      { enableHighAccuracy: true, timeout, maximumAge: 0 }
    );
  });
}

export { haversineMeters, fuseSession, SensorFusion };
