// Apple Push Notification service (APNs) for the iOS app's live game banner.
//
// Token-based auth: a JWT signed with the team's APNs key (.p8), ES256. Apple wants the same token reused for
// 20–60 minutes, so it's kept here for 50.
//
// Settings (wrangler secret / vars, see README "Lock Screen scores"):
//   APNS_KEY      secret: the .p8 file's contents (-----BEGIN PRIVATE KEY----- …)
//   APNS_KEY_ID   the key's 10-character ID
//   APNS_TEAM_ID  F9A6UW5W67
//   APNS_BUNDLE   tv.fbca.eaglesontheair
//   APNS_CHANNELS JSON: { "production": { "basketball": "<channel id>", … }, "development": { … } }
//
// Two environments: Xcode builds on a developer's phone use the sandbox ("development"); TestFlight and the
// App Store use "production". Tokens and channels belong to one or the other.

const HOSTS = {
  production: 'https://api.push.apple.com',
  development: 'https://api.sandbox.push.apple.com'
};

let cached = { jwt: '', at: 0, kid: '' };

const b64url = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlText = text => b64url(new TextEncoder().encode(text));

export const pushConfigured = env => !!(env.APNS_KEY && env.APNS_KEY_ID && env.APNS_TEAM_ID && env.APNS_BUNDLE);

export function channels(env) {
  try { return JSON.parse(env.APNS_CHANNELS || '{}'); } catch (e) { return {}; }
}

async function jwt(env) {
  const now = Math.floor(Date.now() / 1000);
  if (cached.jwt && cached.kid === env.APNS_KEY_ID && now - cached.at < 50 * 60) return cached.jwt;
  const pem = env.APNS_KEY.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(pem), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const head = b64urlText(JSON.stringify({ alg: 'ES256', kid: env.APNS_KEY_ID }));
  const claims = b64urlText(JSON.stringify({ iss: env.APNS_TEAM_ID, iat: now }));
  // WebCrypto's ECDSA signature is already r‖s, the form JWT wants.
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(head + '.' + claims));
  cached = { jwt: head + '.' + claims + '.' + b64url(sig), at: now, kid: env.APNS_KEY_ID };
  return cached.jwt;
}

async function send(env, url, headers, payload) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: 'bearer ' + await jwt(env), 'content-type': 'application/json', ...headers },
    body: JSON.stringify(payload)
  });
  let reason = '';
  if (!res.ok) { try { reason = (await res.json()).reason || ''; } catch (e) { /* empty body */ } }
  return { ok: res.ok, status: res.status, reason };
}

// Apple's broadcast page names api(.sandbox).push.apple.com in its text but api-broadcast(.sandbox).push.apple.com in
// its example. The first is the default; APNS_BROADCAST_HOSTS ({ "production": "https://…", … }) overrides it if
// the logs show broadcasts failing there.
const broadcastHost = (env, envName) => {
  try { const o = JSON.parse(env.APNS_BROADCAST_HOSTS || '{}'); if (o[envName]) return o[envName]; } catch (e) { /* use the default */ }
  return HOSTS[envName];
};

/** One update (or end) to everyone following a sport, through its broadcast channel. */
export async function broadcast(env, envName, channelId, payload, priority) {
  return send(env, `${broadcastHost(env, envName)}/4/broadcasts/apps/${env.APNS_BUNDLE}`, {
    'apns-channel-id': channelId,
    'apns-push-type': 'liveactivity',
    'apns-priority': String(priority),
    // Channels are made with "no message stored" (sports scores), which requires expiration 0.
    'apns-expiration': '0'
  }, payload);
}

/** A push to one phone: starting a banner with a push-to-start token. APNS_HOSTS overrides the host (local tests). */
export async function toDevice(env, envName, token, payload, priority = 10) {
  let host = HOSTS[envName];
  try { const o = JSON.parse(env.APNS_HOSTS || '{}'); if (o[envName]) host = o[envName]; } catch (e) { /* use the default */ }
  return send(env, `${host}/3/device/${token}`, {
    'apns-topic': env.APNS_BUNDLE + '.push-type.liveactivity',
    'apns-push-type': 'liveactivity',
    'apns-priority': String(priority)
  }, payload);
}

/** APNs reasons that mean a token will never work again, so it's forgotten. */
export const deadToken = r => r.status === 410 || r.reason === 'BadDeviceToken' || r.reason === 'Unregistered' || r.reason === 'DeviceTokenNotForTopic';
