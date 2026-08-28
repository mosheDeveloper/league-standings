import { detectCountry } from "./records.js";

const SESSION_KEY = "sprint.max.session";
const APP_ID_OVERRIDE_KEY = "sprint.max.metaAppId";

export function getSession() {
  try {
    return JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
  } catch {
    return null;
  }
}

export function saveSession(session) {
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

export function clearSession() {
  localStorage.removeItem(SESSION_KEY);
}

export function getAppIdOverride() {
  try {
    return (localStorage.getItem(APP_ID_OVERRIDE_KEY) || "").trim();
  } catch {
    return "";
  }
}

export function setAppIdOverride(appId) {
  const clean = String(appId || "").trim();
  if (clean) localStorage.setItem(APP_ID_OVERRIDE_KEY, clean);
  else localStorage.removeItem(APP_ID_OVERRIDE_KEY);
  return clean;
}

export async function loadAuthConfig() {
  let base = {
    facebookAppId: "",
    instagramAppId: "",
    facebookApiVersion: "v21.0",
    scopes: {},
    communityEndpoint: "",
  };
  try {
    const res = await fetch("./data/auth.json", { cache: "no-store" });
    if (res.ok) base = { ...base, ...(await res.json()) };
  } catch {
    /* keep defaults */
  }
  const override = getAppIdOverride();
  if (override) base.facebookAppId = override;
  return base;
}

export function resolveMetaAppId(config = {}) {
  return String(config.facebookAppId || config.instagramAppId || getAppIdOverride() || "").trim();
}

export function isMetaConfigured(config) {
  return Boolean(resolveMetaAppId(config));
}

function loadFacebookSdk(appId, version = "v21.0") {
  return new Promise((resolve, reject) => {
    if (!appId) {
      reject(new Error("missing-app-id"));
      return;
    }
    if (window.FB) {
      try {
        window.FB.init({ appId, cookie: true, xfbml: false, version, status: true });
      } catch {
        /* already inited */
      }
      resolve(window.FB);
      return;
    }
    window.fbAsyncInit = function () {
      window.FB.init({ appId, cookie: true, xfbml: false, version, status: true });
      resolve(window.FB);
    };
    const existing = document.querySelector('script[data-sprint-fb-sdk]');
    if (existing) {
      setTimeout(() => {
        if (!window.FB) reject(new Error("sdk-timeout"));
      }, 8000);
      return;
    }
    const s = document.createElement("script");
    s.src = "https://connect.facebook.net/he_IL/sdk.js";
    s.async = true;
    s.defer = true;
    s.dataset.sprintFbSdk = "1";
    s.onerror = () => reject(new Error("sdk-blocked"));
    document.head.appendChild(s);
    setTimeout(() => {
      if (!window.FB) reject(new Error("sdk-timeout"));
    }, 8000);
  });
}

function fbApi(path, params = {}) {
  return new Promise((resolve, reject) => {
    if (!window.FB) {
      reject(new Error("sdk-missing"));
      return;
    }
    window.FB.api(path, params, (res) => {
      if (!res) {
        resolve({});
        return;
      }
      if (res.error) {
        const err = new Error(res.error.message || "graph-error");
        err.code = res.error.code;
        err.type = res.error.type;
        reject(err);
        return;
      }
      resolve(res);
    });
  });
}

async function fetchAllFriends() {
  const friends = [];
  let path = "/me/friends";
  let params = { fields: "id,name,picture.width(120)", limit: 100 };
  for (let page = 0; page < 10; page++) {
    const res = await fbApi(path, params);
    for (const f of res.data || []) {
      friends.push({
        id: f.id,
        name: f.name,
        avatar: f.picture?.data?.url || "",
      });
    }
    const next = res.paging?.next;
    if (!next || !(res.data || []).length) break;
    // Subsequent pages: use absolute next URL via FB.api path from paging.cursors
    if (res.paging?.cursors?.after) {
      path = "/me/friends";
      params = {
        fields: "id,name,picture.width(120)",
        limit: 100,
        after: res.paging.cursors.after,
      };
    } else break;
  }
  return friends;
}

export async function sessionFromFacebook(provider, authResponse = null) {
  const me = await fbApi("/me", {
    fields: "id,name,email,picture.width(200).height(200)",
  });
  if (!me?.id) throw new Error("no-profile");
  let friends = [];
  try {
    friends = await fetchAllFriends();
  } catch {
    friends = [];
  }
  return {
    id: `fb-${me.id}`,
    facebookId: me.id,
    provider,
    name: me.name,
    email: me.email || "",
    avatar: me.picture?.data?.url || "",
    country: detectCountry(),
    friends,
    friendsFromApi: true,
    accessToken: authResponse?.accessToken || getSession()?.accessToken || "",
    userID: authResponse?.userID || me.id,
    expiresIn: authResponse?.expiresIn || null,
    at: new Date().toISOString(),
    local: false,
  };
}

function fbLogin(scope) {
  return new Promise((resolve, reject) => {
    window.FB.login(
      (res) => {
        if (res?.authResponse) resolve(res);
        else reject(new Error("cancelled"));
      },
      { scope, return_scopes: true, enable_profile_selector: true }
    );
  });
}

function fbGetLoginStatus() {
  return new Promise((resolve) => {
    if (!window.FB) {
      resolve(null);
      return;
    }
    window.FB.getLoginStatus((res) => resolve(res || null));
  });
}

export function metaErrorMessage(err) {
  const code = err?.message || String(err || "");
  if (code === "missing-app-id") {
    return "חסר מזהה אפליקציית Meta. הזינו App ID בהגדרות למטה או ב-data/auth.json.";
  }
  if (code === "sdk-blocked" || code === "sdk-timeout") {
    return "לא ניתן לטעון את Facebook SDK (חסימת רשת / חוסם פרסומות).";
  }
  if (code === "cancelled") return "ההתחברות בוטלה.";
  if (code === "no-profile") return "ההתחברות הצליחה אבל לא התקבל פרופיל מ־Meta.";
  if (code === "not-connected") return "אין סשן Meta פעיל — התחברו מחדש.";
  return err?.message ? `שגיאת Meta: ${err.message}` : "התחברות Meta נכשלה.";
}

/**
 * Facebook / Instagram via Meta Login (Facebook Login product).
 * Pulls profile + friends who also authorized the app (`user_friends`).
 * Throws on missing App ID / cancel / Graph errors — no silent mock session.
 */
export async function loginWithMeta(provider, config) {
  const appId = resolveMetaAppId(config);
  if (!appId) throw new Error("missing-app-id");
  const scope =
    provider === "instagram"
      ? config.scopes?.instagram || "public_profile,email,user_friends"
      : config.scopes?.facebook || "public_profile,email,user_friends";
  await loadFacebookSdk(appId, config.facebookApiVersion || "v21.0");
  const loginRes = await fbLogin(scope);
  return sessionFromFacebook(provider, loginRes.authResponse);
}

/** Restore an existing Facebook SDK session into our app session. */
export async function restoreMetaSession(config, provider = "facebook") {
  const appId = resolveMetaAppId(config);
  if (!appId) return null;
  await loadFacebookSdk(appId, config.facebookApiVersion || "v21.0");
  const status = await fbGetLoginStatus();
  if (status?.status !== "connected" || !status.authResponse) return null;
  return sessionFromFacebook(provider, status.authResponse);
}

export async function ensureMetaSdk(config) {
  const appId = resolveMetaAppId(config);
  if (!appId) throw new Error("missing-app-id");
  return loadFacebookSdk(appId, config.facebookApiVersion || "v21.0");
}

export async function logoutMeta(config) {
  try {
    if (isMetaConfigured(config)) {
      await ensureMetaSdk(config);
      await new Promise((resolve) => {
        window.FB.getLoginStatus((status) => {
          if (status?.status === "connected") {
            window.FB.logout(() => resolve());
          } else resolve();
        });
      });
    }
  } catch {
    /* ignore SDK logout failures */
  }
  clearSession();
}

export function guestSession(name) {
  const clean = (name || "").trim() || "אורח";
  return {
    id: `guest-${Date.now()}`,
    provider: "guest",
    guest: true,
    name: clean,
    avatar: "",
    country: detectCountry(),
    friends: [],
    friendsFromApi: false,
    local: false,
    at: new Date().toISOString(),
  };
}

/** @deprecated Prefer guestSession or real loginWithMeta — kept for tests/demo only */
export function localConsentSession(provider, name) {
  const clean = (name || "").trim() || "רץ חדש";
  return {
    id: `local-${provider}-${Date.now()}`,
    provider,
    name: clean,
    avatar: "",
    country: detectCountry(),
    friends: [],
    friendsFromApi: false,
    local: true,
    at: new Date().toISOString(),
  };
}

export { fbApi, loadFacebookSdk };
