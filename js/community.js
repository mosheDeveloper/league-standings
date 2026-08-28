/**
 * Community scores keyed by Facebook user id.
 * Local cache always; optional HTTP endpoint for cross-device friend boards.
 *
 * Endpoint contract (optional `communityEndpoint` in data/auth.json):
 *   GET  {endpoint}?ids=id1,id2  → { users: [{ facebookId, name, maxSpeedKmh, country }] }
 *   POST {endpoint} JSON body   → { facebookId, name, maxSpeedKmh, country, avatar? }
 */

const LOCAL_KEY = "sprint.max.community";

export function readLocalCommunity() {
  try {
    const raw = JSON.parse(localStorage.getItem(LOCAL_KEY) || "{}");
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

function writeLocalCommunity(map) {
  localStorage.setItem(LOCAL_KEY, JSON.stringify(map));
}

export function upsertLocalScore(entry) {
  if (!entry?.facebookId) return null;
  const map = readLocalCommunity();
  const prev = map[entry.facebookId] || {};
  const next = {
    facebookId: String(entry.facebookId),
    name: entry.name || prev.name || "",
    avatar: entry.avatar || prev.avatar || "",
    country: entry.country || prev.country || "",
    maxSpeedKmh: Math.max(Number(entry.maxSpeedKmh) || 0, Number(prev.maxSpeedKmh) || 0),
    at: new Date().toISOString(),
  };
  map[entry.facebookId] = next;
  writeLocalCommunity(map);
  return next;
}

export function localScoresForIds(ids = []) {
  const map = readLocalCommunity();
  return ids.map((id) => map[id]).filter(Boolean);
}

export async function publishScore(entry, endpoint) {
  const saved = upsertLocalScore(entry);
  const url = String(endpoint || "").trim();
  if (!url || !saved) return { local: saved, remote: null };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(saved),
    });
    if (!res.ok) throw new Error(`community-http-${res.status}`);
    const remote = await res.json().catch(() => saved);
    return { local: saved, remote };
  } catch (err) {
    return { local: saved, remote: null, error: err };
  }
}

export async function fetchScoresForFriends(friendIds = [], endpoint) {
  const ids = [...new Set((friendIds || []).map(String).filter(Boolean))];
  const local = localScoresForIds(ids);
  const byId = Object.fromEntries(local.map((u) => [u.facebookId, u]));
  const url = String(endpoint || "").trim();
  if (!url || !ids.length) return Object.values(byId);
  try {
    const res = await fetch(`${url}${url.includes("?") ? "&" : "?"}ids=${ids.map(encodeURIComponent).join(",")}`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`community-http-${res.status}`);
    const data = await res.json();
    for (const u of data.users || data || []) {
      if (!u?.facebookId) continue;
      const merged = {
        facebookId: String(u.facebookId),
        name: u.name || byId[u.facebookId]?.name || "",
        avatar: u.avatar || byId[u.facebookId]?.avatar || "",
        country: u.country || byId[u.facebookId]?.country || "",
        maxSpeedKmh: Math.max(Number(u.maxSpeedKmh) || 0, Number(byId[u.facebookId]?.maxSpeedKmh) || 0),
      };
      byId[u.facebookId] = merged;
      upsertLocalScore(merged);
    }
  } catch {
    /* keep local */
  }
  return Object.values(byId);
}

/** Merge Meta friends list with known community speeds. */
export function enrichFriendsWithScores(friends = [], scores = []) {
  const byId = Object.fromEntries((scores || []).map((s) => [String(s.facebookId), s]));
  return (friends || []).map((f) => {
    const hit = byId[String(f.id)];
    return {
      id: f.id,
      name: f.name || hit?.name || "",
      avatar: f.avatar || hit?.avatar || "",
      country: hit?.country || f.country || "",
      maxSpeedKmh: hit?.maxSpeedKmh || f.maxSpeedKmh || 0,
    };
  });
}
