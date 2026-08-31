import {
  SensorFusion,
  haversineMeters,
  fuseSession,
} from "./sensor-fusion.js";

export class Tracker {
  constructor(onUpdate, options = {}) {
    this.onUpdate = onUpdate;
    this.debug = !!options.debug;
    /** Target IMU processing rate (Hz); DeviceMotion may fire faster. */
    this._imuMinIntervalMs = 1000 / (options.imuHz ?? 75);
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
    this._listenersAttached = false;
  }

  currentSpeedKmh() {
    // Prefer fused estimate; fall back to last raw GPS if fusion not warm yet
    const fused = this.fusion.currentSpeedKmh();
    if (fused > 0 || this.gps.length === 0) return fused;
    const last = this.gps[this.gps.length - 1];
    return last?.fusedSpeedKmh ?? last?.speedKmh ?? 0;
  }

  /** Live meter: only accepted GPS measurements (ignores IMU dead-reckoning spikes). */
  displaySpeedKmh(nowT = Date.now()) {
    return this.fusion.confirmedSpeedKmh(nowT);
  }

  displayMaxKmh() {
    return this.fusion.peakConfirmedGpsKmh();
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
        this.fusion.pushAccel({
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
    this._emit();
  }

  _emit() {
    if (!this.onUpdate) return;
    const debug = this.debug ? this.getFusionDebug() : undefined;
    this.onUpdate({
      durationMs: Date.now() - this.startedAt,
      speedKmh: this.displaySpeedKmh(),
      maxKmh: this.displayMaxKmh(),
      fusedSpeedKmh: this.currentSpeedKmh(),
      fusedMaxKmh: this.liveMaxKmh(),
      rawGpsSpeedKmh: this.fusion._lastRawGpsKmh,
      rawMaxKmh: this.rawGpsMaxKmh(),
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
    return {
      gps: this.gps.slice(),
      motion: this.motion.slice(),
      fused: this.fusion.fusedSeries(),
      fusionDebug: this.getFusionDebug(),
      durationMs,
      startedAt: this.startedAt,
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
