// Fan vote: stores Player of the Game votes for the EOTA broadcasts.
//
// fbca.tv/vote shows the current vote and sends one vote per device. The soccer graphics
// control page (with the admin key) creates a vote, opens and closes it, and reads the
// tally for the on-air results. Votes live in a D1 database (binding DB).
//
//   GET  /poll?voter=ID        current vote, percentages, and this device's pick
//                              (vote counts too, with the admin key)
//   GET  /media?poll=ID        that vote's player photos and team logos (small images, sent once and
//                              cached, so /poll stays small for phones refreshing every 15 seconds)
//   POST /vote                 { poll, choice, voter }
//   POST /admin                { action: 'create', match, teams, nominees } | { action: 'open' | 'close', poll }
//                              | { action: 'stats', poll, stats } (each nominee's stat line, during the game)
//                              | { action: 'clear' } (no vote until the next one is created)
//                              with Authorization: Bearer <ADMIN_KEY>
//   Nominees: { num, name, pos, side, stat, photo }; teams: { home: { name, bg, fg, logo }, away: {...} }.
//   Photos and logos are small data: URLs the control page makes; anything else is dropped.

const SITE_ORIGINS = ['https://fbca.tv', 'https://www.fbca.tv'];
// Votes allowed from one internet connection per vote. Loose on purpose: a whole
// stand on the school Wi-Fi shares one address.
const IP_LIMIT = 150;
const MAX_NOMINEES = 6;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS polls (
     id TEXT PRIMARY KEY, match TEXT NOT NULL, nominees TEXT NOT NULL,
     open INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, closed_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS votes (
     poll_id TEXT NOT NULL, voter TEXT NOT NULL, choice INTEGER NOT NULL,
     ip TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (poll_id, voter))`,
  `CREATE INDEX IF NOT EXISTS votes_by_ip ON votes (poll_id, ip)`
];
let schemaReady = false;
const ensureSchema = async db => {
  if (schemaReady) return;
  await db.batch(SCHEMA.map(sql => db.prepare(sql)));
  // Added later: the teams (names and colors) and the vote's pictures. Older databases get the columns once.
  const { results } = await db.prepare('PRAGMA table_info(polls)').all();
  const have = new Set(results.map(r => r.name));
  for (const col of ['teams', 'media']) if (!have.has(col)) await db.prepare(`ALTER TABLE polls ADD COLUMN ${col} TEXT`).run();
  schemaReady = true;
};

// The site (and local testing) may read and vote; the control page may also be opened
// as a local file (Origin "null"), which is fine for admin calls since they need the key.
const allowedOrigin = (origin, admin) =>
  SITE_ORIGINS.includes(origin) || /^http:\/\/localhost(:\d+)?$/.test(origin) || (admin && origin === 'null');

const cors = origin => ({
  'Access-Control-Allow-Origin': origin || SITE_ORIGINS[0],
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
  'Vary': 'Origin'
});
const json = (body, status, origin) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors(origin) }
});

const clean = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
// A small picture from the control page: an image data: URL, or nothing.
const MAX_PIC = 80000;
const pic = v => typeof v === 'string' && v.length <= MAX_PIC && /^data:image\/(webp|jpeg|png);base64,[A-Za-z0-9+/=]+$/.test(v) ? v : '';
const color = v => /^#[0-9a-f]{6}$/i.test(v || '') ? v : '';
const team = t => ({ name: clean(t?.name, 30), bg: color(t?.bg), fg: color(t?.fg) });
const voterOk = v => typeof v === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(v);

const sha256 = async text => {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
};

// Constant-time comparison for the admin key.
const sameKey = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

const currentPoll = db => db.prepare('SELECT * FROM polls ORDER BY created_at DESC LIMIT 1').first();

// What every caller gets back: the vote, each player's share, who leads, and (for a voter)
// their own pick. Vote counts stay private: only the control page, with the key, gets them.
const state = async (db, voter, counts = false) => {
  const p = await currentPoll(db);
  if (!p) return { poll: null };
  const nominees = JSON.parse(p.nominees);
  const totals = nominees.map(() => 0);
  const { results } = await db.prepare('SELECT choice, COUNT(*) AS n FROM votes WHERE poll_id = ? GROUP BY choice').bind(p.id).all();
  for (const r of results) if (r.choice >= 0 && r.choice < totals.length) totals[r.choice] = r.n;
  let mine = null;
  if (voterOk(voter)) {
    const row = await db.prepare('SELECT choice FROM votes WHERE poll_id = ? AND voter = ?').bind(p.id, voter).first();
    if (row) mine = row.choice;
  }
  const total = totals.reduce((a, b) => a + b, 0), top = Math.max(...totals);
  // Which pictures exist (the pictures themselves come from /media, once per vote).
  const media = p.media ? JSON.parse(p.media) : { photos: [], logos: {} };
  return {
    poll: { id: p.id, match: p.match, open: !!p.open,
            teams: p.teams ? JSON.parse(p.teams) : null,
            nominees: nominees.map((n, i) => ({ ...n, photo: !!(media.photos || [])[i] })),
            logos: { home: !!(media.logos || {}).home, away: !!(media.logos || {}).away } },
    pct: totals.map(t => total ? Math.round(t / total * 100) : 0),
    leaders: total ? totals.flatMap((t, i) => t === top ? [i] : []) : [],
    mine,
    ...(counts ? { totals, total } : {})
  };
};

const vote = async (request, env, origin) => {
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Send JSON.' }, 400, origin); }
  const { poll, choice, voter } = body || {};
  if (!voterOk(voter)) return json({ error: 'Missing device id.' }, 400, origin);
  const p = await currentPoll(env.DB);
  if (!p || p.id !== poll) return json({ error: 'This vote has ended.', ...(await state(env.DB, voter)) }, 409, origin);
  if (!p.open) return json({ error: 'Voting is closed.', ...(await state(env.DB, voter)) }, 409, origin);
  const n = JSON.parse(p.nominees).length;
  if (!Number.isInteger(choice) || choice < 0 || choice >= n) return json({ error: 'Pick one of the players.' }, 400, origin);

  const ip = await sha256(p.id + '|' + (request.headers.get('CF-Connecting-IP') || 'unknown'));
  const used = await env.DB.prepare('SELECT COUNT(*) AS n FROM votes WHERE poll_id = ? AND ip = ?').bind(p.id, ip).first();
  if (used.n >= IP_LIMIT) return json({ error: 'Too many votes from this connection.', ...(await state(env.DB, voter)) }, 429, origin);

  // First vote counts; voting again from the same device changes nothing.
  await env.DB.prepare('INSERT OR IGNORE INTO votes (poll_id, voter, choice, ip, at) VALUES (?, ?, ?, ?, ?)')
    .bind(p.id, voter, choice, ip, Date.now()).run();
  return json(await state(env.DB, voter), 200, origin);
};

const hasKey = (request, env) =>
  !!env.ADMIN_KEY && sameKey((request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, ''), env.ADMIN_KEY);

const admin = async (request, env, origin) => {
  if (!hasKey(request, env)) return json({ error: 'Wrong admin key.' }, 401, origin);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Send JSON.' }, 400, origin); }
  const { action } = body || {};

  if (action === 'create') {
    const given = (Array.isArray(body.nominees) ? body.nominees : []).filter(n => clean(n?.name, 30)).slice(0, MAX_NOMINEES);
    const nominees = given.map(n => ({ num: clean(n?.num, 3), name: clean(n?.name, 30), pos: clean(n?.pos, 20),
                                       side: n?.side === 'away' ? 'away' : 'home', stat: clean(n?.stat, 60) }));
    if (nominees.length < 2) return json({ error: 'Add at least two players.' }, 400, origin);
    const t = body.teams || {};
    const teams = { home: team(t.home), away: team(t.away) };
    const media = { photos: given.map(n => pic(n?.photo)), logos: { home: pic(t.home?.logo), away: pic(t.away?.logo) } };
    const id = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO polls (id, match, nominees, open, created_at, teams, media) VALUES (?, ?, ?, 0, ?, ?, ?)')
      .bind(id, clean(body.match, 60), JSON.stringify(nominees), Date.now(), JSON.stringify(teams), JSON.stringify(media)).run();
    return json(await state(env.DB, null, true), 200, origin);
  }

  // During the game: each nominee's current stat line ("2 GOALS · 1 ASSIST").
  if (action === 'stats') {
    const p = await currentPoll(env.DB);
    if (!p || p.id !== body.poll) return json({ error: 'That vote is no longer the current one.' }, 409, origin);
    const stats = Array.isArray(body.stats) ? body.stats : [];
    const nominees = JSON.parse(p.nominees).map((n, i) => ({ ...n, stat: clean(stats[i], 60) }));
    await env.DB.prepare('UPDATE polls SET nominees = ? WHERE id = ?').bind(JSON.stringify(nominees), p.id).run();
    return json(await state(env.DB, null, true), 200, origin);
  }

  if (action === 'open' || action === 'close') {
    const p = await currentPoll(env.DB);
    if (!p || p.id !== body.poll) return json({ error: 'That vote is no longer the current one.' }, 409, origin);
    await env.DB.prepare('UPDATE polls SET open = ?, closed_at = ? WHERE id = ?')
      .bind(action === 'open' ? 1 : 0, action === 'close' ? Date.now() : null, p.id).run();
    return json(await state(env.DB, null, true), 200, origin);
  }

  // Between games: remove the vote and its votes, so fbca.tv/vote shows that nothing is running.
  if (action === 'clear') {
    await env.DB.batch([env.DB.prepare('DELETE FROM votes'), env.DB.prepare('DELETE FROM polls')]);
    return json(await state(env.DB, null, true), 200, origin);
  }

  return json({ error: 'Unknown action.' }, 400, origin);
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const isAdmin = url.pathname === '/admin';
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors(allowedOrigin(origin, true) ? origin : '') });
    if (origin && !allowedOrigin(origin, isAdmin)) return json({ error: 'Not allowed from this site.' }, 403, '');

    await ensureSchema(env.DB);
    if (request.method === 'GET' && url.pathname === '/poll')
      return json(await state(env.DB, url.searchParams.get('voter'), hasKey(request, env)), 200, origin);
    if (request.method === 'GET' && url.pathname === '/media') {
      const p = await env.DB.prepare('SELECT media FROM polls WHERE id = ?').bind(url.searchParams.get('poll') || '').first();
      const media = p && p.media ? JSON.parse(p.media) : { photos: [], logos: {} };
      // A vote's pictures never change, so phones keep them for the day.
      return new Response(JSON.stringify(media), { status: p ? 200 : 404, headers: { 'Content-Type': 'application/json',
        'Cache-Control': p ? 'public, max-age=86400, immutable' : 'no-store', ...cors(origin) } });
    }
    if (request.method === 'POST' && url.pathname === '/vote') return vote(request, env, origin);
    if (request.method === 'POST' && isAdmin) return admin(request, env, origin);
    return json({ error: 'Not found.' }, 404, origin);
  }
};
