// Makes (or lists, or deletes) the Lock Screen scores broadcast channels: one per sport the app follows, in one
// APNs environment. Run once per environment from a Mac (Apple's channel service needs HTTP/2 on port 2195/2196,
// which curl does and a Worker may not):
//
//   node scripts/apns-channels.mjs create production  ~/Keys/AuthKey_ABC123DEFG.p8 ABC123DEFG
//   node scripts/apns-channels.mjs create development ~/Keys/AuthKey_ABC123DEFG.p8 ABC123DEFG
//   node scripts/apns-channels.mjs list   production  <p8> <key id>
//   node scripts/apns-channels.mjs delete production  <p8> <key id> <channel id>
//
// "create" prints the channel IDs as JSON. Put both environments' IDs in APNS_CHANNELS in wrangler.toml:
//   APNS_CHANNELS = '{"production":{"basketball":"…",…},"development":{…}}'
//
// Channels are made with "No Message Stored" (Apple's advice for sports scores: a bigger update budget, and a phone
// that was offline just gets the next update).

import { readFileSync } from 'node:fs';
import { createPrivateKey, sign } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const TEAM = 'F9A6UW5W67', BUNDLE = 'tv.fbca.eaglesontheair';
const SPORTS = ['basketball', 'soccer', 'baseball', 'softball'];
const HOSTS = {
  production: 'https://api-manage-broadcast.push.apple.com:2196',
  development: 'https://api-manage-broadcast.sandbox.push.apple.com:2195'
};

const [cmd, envName, p8, keyId, channelId] = process.argv.slice(2);
if (!['create', 'list', 'delete'].includes(cmd) || !HOSTS[envName] || !p8 || !keyId || (cmd === 'delete' && !channelId)) {
  console.error('Usage: node scripts/apns-channels.mjs create|list|delete production|development <AuthKey.p8> <key id> [channel id]');
  process.exit(1);
}

const b64url = b => Buffer.from(b).toString('base64url');
const head = b64url(JSON.stringify({ alg: 'ES256', kid: keyId }));
const claims = b64url(JSON.stringify({ iss: TEAM, iat: Math.floor(Date.now() / 1000) }));
const sig = sign('sha256', Buffer.from(head + '.' + claims), { key: createPrivateKey(readFileSync(p8)), dsaEncoding: 'ieee-p1363' });
const jwt = head + '.' + claims + '.' + b64url(sig);

// curl over HTTP/2; returns the status, the response headers and the body
function call(method, path, extraHeaders = [], body = null) {
  const args = ['-s', '--http2', '-X', method, '-D', '-', '-H', 'authorization: bearer ' + jwt, ...extraHeaders.flatMap(h => ['-H', h])];
  if (body) args.push('-H', 'content-type: application/json', '-d', JSON.stringify(body));
  args.push(HOSTS[envName] + path);
  const out = execFileSync('curl', args, { encoding: 'utf8' });
  const [rawHead, ...rest] = out.split(/\r?\n\r?\n/);
  const status = Number((rawHead.match(/^HTTP\/\S+\s+(\d+)/) || [])[1]);
  const headers = Object.fromEntries(rawHead.split(/\r?\n/).slice(1).map(l => { const i = l.indexOf(':'); return [l.slice(0, i).trim().toLowerCase(), l.slice(i + 1).trim()]; }));
  return { status, headers, body: rest.join('\n\n') };
}

if (cmd === 'create') {
  const ids = {};
  for (const sport of SPORTS) {
    const r = call('POST', `/1/apps/${BUNDLE}/channels`, [], { 'message-storage-policy': 0, 'push-type': 'LiveActivity' });
    if (r.status !== 201) { console.error(`${sport}: failed (${r.status}) ${r.body}`); process.exit(1); }
    ids[sport] = r.headers['apns-channel-id'];
    console.error(`${sport}: ${ids[sport]}`);
  }
  console.log(JSON.stringify({ [envName]: ids }));
} else if (cmd === 'list') {
  const r = call('GET', `/1/apps/${BUNDLE}/all-channels`);
  console.log(r.status, r.body);
} else {
  const r = call('DELETE', `/1/apps/${BUNDLE}/channels`, ['apns-channel-id: ' + channelId]);
  console.log(r.status === 204 ? 'Deleted' : `Failed (${r.status}) ${r.body}`);
}
