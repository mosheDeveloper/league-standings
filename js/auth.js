import { detectCountry } from "./records.js";

const SESSION_KEY = "sprint.max.session";

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

export async function loadAuthConfig() {
  const res = await fetch("./data/auth.json", { cache: "no-store" });
  if (!res.ok) return { facebookAppId: "", instagramAppId: "", scopes: {} };
  return res.json();
}

function loadFacebookSdk(appId, version = "v21.0") {
  return new Promise((resolve, reject) => {
    if (!appId) {
      reject(new Error("missing-app-id"));
      return;
    }
    if (window.FB) {
      resolve(window.FB);
      return;
    }
    window.fbAsyncInit = function () {
      window.FB.init({ appId, cookie: true, xfbml: false, version });
      resolve(window.FB);
    };
    const s = document.createElement("script");
    s.src = "https://connect.facebook.net/he_IL/sdk.js";
    s.async = true;
    s.onerror = () => reject(new Error("sdk-blocked"));
    document.head.appendChild(s);
    setTimeout(() => {
      if (!window.FB) reject(new Error("sdk-timeout"));
    }, 8000);
  });
}

function fbApi(path, params) {
  return new Promise((resolve) => {
    window.FB.api(path, params, (res) => resolve(res || {}));
  });
}

async function sessionFromFacebook(provider) {
  const me = await fbApi("/me", { fields: "id,name,email,picture.width(200)" });
  if (!me?.id) throw new Error("no-profile");
  const friendsRes = await fbApi("/me/friends", { fields: "id,name,picture.width(120)" });
  const friends = (friendsRes.data || []).map((f) => ({
    id: f.id,
    name: f.name,
    avatar: f.picture?.data?.url,
  }));
  return {
    id: `fb-${me.id}`,
    facebookId: me.id,
    provider,
    name: me.name,
    avatar: me.picture?.data?.url || "",
    country: detectCountry(),
    friends,
    friendsFromApi: true,
    at: new Date().toISOString(),
  };
}

function fbLogin(scope) {
  return new Promise((resolve, reject) => {
    window.FB.login(
      (res) => {
        if (res?.authResponse) resolve(res);
        else reject(new Error("cancelled"));
      },
      { scope }
    );
  });
}

/**
 * Facebook / Instagram via Meta Login.
 * Requests friends who also use the app (`user_friends`).
 * If App ID is missing, returns null so the UI can use in-app consent.
 */
export async function loginWithMeta(provider, config) {
  const appId = config.facebookAppId || config.instagramAppId;
  const scope =
    provider === "instagram"
      ? config.scopes?.instagram || "public_profile,email,user_friends"
      : config.scopes?.facebook || "public_profile,email,user_friends";
  await loadFacebookSdk(appId, config.facebookApiVersion);
  await fbLogin(scope);
  return sessionFromFacebook(provider);
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
    at: new Date().toISOString(),
  };
}

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
