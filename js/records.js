const TZ_COUNTRY = {
  "Asia/Jerusalem": "IL",
  "America/New_York": "US",
  "America/Los_Angeles": "US",
  "America/Chicago": "US",
  "Europe/London": "GB",
  "Europe/Paris": "FR",
  "Europe/Berlin": "DE",
  "Europe/Madrid": "ES",
  "Europe/Rome": "IT",
  "America/Sao_Paulo": "BR",
  "America/Argentina/Buenos_Aires": "AR",
  "Europe/Amsterdam": "NL",
};

export function detectCountry(fallback = "IL") {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return TZ_COUNTRY[tz] || fallback;
  } catch {
    return fallback;
  }
}

export function countryName(code, countries = {}) {
  return countries[code] || code || "העולם";
}

export function bestVerifiedKmh(runs) {
  const speeds = (runs || []).map((r) => r.analysis?.maxSpeedKmh ?? r.maxKmh).filter((n) => Number.isFinite(n) && n > 0);
  return speeds.length ? Math.max(...speeds) : 0;
}

export function withMe(users, me) {
  const list = (users || []).filter((u) => u.id !== me?.id);
  if (me && me.maxSpeedKmh > 0) list.push(me);
  return list;
}

export function rankBoard(users, meId) {
  const sorted = [...(users || [])]
    .filter((u) => Number.isFinite(u.maxSpeedKmh) && u.maxSpeedKmh > 0)
    .sort((a, b) => b.maxSpeedKmh - a.maxSpeedKmh || String(a.name).localeCompare(String(b.name), "he"));
  const idx = sorted.findIndex((u) => u.id === meId);
  return {
    sorted,
    place: idx >= 0 ? idx + 1 : null,
    total: sorted.length,
  };
}

export function buildBoards({ catalog, session, myKmh }) {
  const countries = catalog.countries || {};
  const country = session?.country || catalog.defaultCountry || detectCountry();
  const me =
    session && myKmh > 0
      ? {
          id: session.id,
          name: session.name,
          country,
          maxSpeedKmh: myKmh,
          me: true,
        }
      : null;

  const all = withMe(catalog.users || [], me);
  const local = all.filter((u) => u.country === country);
  const global = all;

  const friendSeeds = session?.friends?.length
    ? session.friends.map((f) => {
        const hit = (catalog.users || []).find((u) => u.facebookId === f.id || u.id === f.id);
        return {
          id: f.id,
          name: f.name,
          country: f.country || country,
          maxSpeedKmh: hit?.maxSpeedKmh || f.maxSpeedKmh || 0,
        };
      })
    : session
      ? catalog.sampleFriends || []
      : [];

  const friends = withMe(
    friendSeeds.filter((f) => f.maxSpeedKmh > 0 || f.id),
    me
  ).filter((u) => u.maxSpeedKmh > 0 || u.me);

  return {
    country,
    countryLabel: countryName(country, countries),
    local: rankBoard(local, me?.id),
    global: rankBoard(global, me?.id),
    friends: rankBoard(
      friends.filter((u) => u.maxSpeedKmh > 0),
      me?.id
    ),
    loggedIn: !!session,
    me,
  };
}
