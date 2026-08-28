/**
 * Optional Cloudflare Worker for cross-device friend score sync.
 * Deploy separately; set communityEndpoint in data/auth.json to the worker URL.
 *
 * Bind a KV namespace as COMMUNITY.
 */

export default {
  async fetch(request, env) {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Accept",
    };
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    const kv = env.COMMUNITY;
    if (!kv) {
      return json({ error: "COMMUNITY KV not bound" }, 500, cors);
    }

    if (request.method === "GET") {
      const url = new URL(request.url);
      const ids = (url.searchParams.get("ids") || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 100);
      const users = [];
      for (const id of ids) {
        const raw = await kv.get(`user:${id}`);
        if (raw) {
          try {
            users.push(JSON.parse(raw));
          } catch {
            /* skip */
          }
        }
      }
      return json({ users }, 200, cors);
    }

    if (request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "invalid-json" }, 400, cors);
      }
      const facebookId = String(body.facebookId || "").trim();
      const maxSpeedKmh = Number(body.maxSpeedKmh);
      if (!facebookId || !Number.isFinite(maxSpeedKmh) || maxSpeedKmh <= 0 || maxSpeedKmh > 60) {
        return json({ error: "invalid-payload" }, 400, cors);
      }
      const key = `user:${facebookId}`;
      let prev = {};
      try {
        prev = JSON.parse((await kv.get(key)) || "{}");
      } catch {
        prev = {};
      }
      const next = {
        facebookId,
        name: String(body.name || prev.name || "").slice(0, 80),
        avatar: String(body.avatar || prev.avatar || "").slice(0, 500),
        country: String(body.country || prev.country || "").slice(0, 8),
        maxSpeedKmh: Math.max(maxSpeedKmh, Number(prev.maxSpeedKmh) || 0),
        at: new Date().toISOString(),
      };
      await kv.put(key, JSON.stringify(next));
      return json(next, 200, cors);
    }

    return json({ error: "method-not-allowed" }, 405, cors);
  },
};

function json(data, status, cors) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...cors },
  });
}
