export class Tracker {
  constructor(onUpdate) {
    this.onUpdate = onUpdate;
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
  }

  currentSpeedKmh() {
    const last = this.gps[this.gps.length - 1];
    return last?.speedKmh ?? 0;
  }

  liveMaxKmh() {
    let m = 0;
    for (const p of this.gps) if (p.speedKmh > m) m = p.speedKmh;
    return m;
  }

  ingest({ t = Date.now(), speedKmh, accMag, tiltBeta, tiltGamma, accuracy = 8, lat, lng }) {
    if (!this.active) return;
    if (speedKmh != null) {
      this.gps.push({ t, speedKmh, accuracy, lat, lng });
    }
    if (accMag != null) {
      this.motion.push({
        t,
        accMag,
        tiltBeta: tiltBeta ?? this._tilt.beta,
        tiltGamma: tiltGamma ?? this._tilt.gamma,
      });
    }
    this._emit();
  }

  _emit() {
    if (!this.onUpdate) return;
    this.onUpdate({
      durationMs: Date.now() - this.startedAt,
      speedKmh: this.currentSpeedKmh(),
      maxKmh: this.liveMaxKmh(),
      samples: this.gps.length,
      motion: this.motion.length,
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

    this._motionHandler = (ev) => {
      const a = ev.accelerationIncludingGravity;
      if (!a) return;
      const mag = Math.sqrt((a.x || 0) ** 2 + (a.y || 0) ** 2 + (a.z || 0) ** 2);
      this.ingest({ accMag: mag, t: Date.now() });
    };
    this._orientHandler = (ev) => {
      this._tilt.beta = ev.beta || 0;
      this._tilt.gamma = ev.gamma || 0;
    };
    window.addEventListener("devicemotion", this._motionHandler);
    window.addEventListener("deviceorientation", this._orientHandler);

    if (!navigator.geolocation) {
      throw new Error("אין GPS במכשיר");
    }

    this.watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const { speed, accuracy, latitude, longitude } = pos.coords;
        let speedKmh = speed != null && speed >= 0 ? speed * 3.6 : null;
        const last = this.gps[this.gps.length - 1];
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
      },
      (err) => {
        this.lastError = err.message;
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

  stop() {
    this.active = false;
    if (this.watchId != null) {
      navigator.geolocation.clearWatch(this.watchId);
      this.watchId = null;
    }
    if (this._motionHandler) window.removeEventListener("devicemotion", this._motionHandler);
    if (this._orientHandler) window.removeEventListener("deviceorientation", this._orientHandler);
    const durationMs = Date.now() - this.startedAt;
    return {
      gps: this.gps.slice(),
      motion: this.motion.slice(),
      durationMs,
      startedAt: this.startedAt,
    };
  }
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
