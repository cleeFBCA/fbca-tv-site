// Stat keeper: live basketball stats for the EOTA broadcasts.
//
// The stat keeper page (graphics/basketball-stats.html) records each play as an event.
// The basketball scorebug control page listens over a WebSocket and turns the events into
// player and team stats for the bug, lower thirds and stats panel.
//
// One game is kept per name (default "basketball") in a Durable Object, so every tap is
// stored in one place in order, and two stat keepers can write to the same game.
//
//   GET  /state?game=basketball         the game: { rev, meta, events }
//   GET  /ws?game=basketball            WebSocket: the game on connect, then each change
//   POST /events  { gameId, events: [{ id, side, player, type, period, at }] }
//   POST /undo    { gameId, ids: [...] }
//   POST /meta    { gameId, meta: { keepers, period, names, colors, rosters } }   (any subset)
//   POST /reset   { keepRosters }      starts a new game
//   GET  /library                      saved teams: { teams: [{ name, roster, savedAt }] }
//   POST /library { action: 'save', teams: [{ name, color, roster }] } | { action: 'delete', name }
//   POSTs and /library need Authorization: Bearer <STAT_KEY>.
//
// Saved teams outlive new games, so FBCA (varsity, JV) and opponents seen before are a pick
// from a menu. They're kept by name, case and spacing ignored.
//
// Events carry a random id made on the device, so a play sent twice (a retry after a
// dropped connection) is stored once, and gameId, so plays queued offline during an
// earlier game are turned away after a reset.

import { DurableObject } from 'cloudflare:workers';

const SITE_ORIGINS = ['https://fbca.tv', 'https://www.fbca.tv'];
const TYPES = ['m2', 'x2', 'm3', 'x3', 'mft', 'xft', 'oreb', 'dreb', 'ast', 'stl', 'blk', 'to', 'pf'];
const SIDES = ['home', 'away'];
const MAX_EVENTS = 3000, MAX_ROSTER = 30, MAX_SAVED = 150;

const allowedOrigin = origin => SITE_ORIGINS.includes(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
const cors = origin => ({
  'Access-Control-Allow-Origin': allowedOrigin(origin) ? origin : SITE_ORIGINS[0],
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
  'Vary': 'Origin'
});
const json = (body, status = 200, origin = '') => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors(origin) }
});

// Answers from the game object, with this request's CORS headers in place of its own.
const withCors = (r, origin) => {
  const h = new Headers(r.headers);
  for (const [k, v] of Object.entries(cors(origin))) h.set(k, v);
  return new Response(r.body, { status: r.status, headers: h });
};

const clean = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const colorOk = v => typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v);
const DEFAULT_COLORS = { home: '#17402B', away: '#1F3A93' };
const idOk = v => typeof v === 'string' && /^[A-Za-z0-9_-]{6,40}$/.test(v);
const newId = () => crypto.randomUUID().replace(/-/g, '').slice(0, 16);

const keyMatches = async (given, real) => {
  if (!real || !given) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([given, real].map(t => crypto.subtle.digest('SHA-256', enc.encode(t))));
  return crypto.subtle.timingSafeEqual ? crypto.subtle.timingSafeEqual(a, b)
    : new Uint8Array(a).every((x, i) => x === new Uint8Array(b)[i]);
};

const cleanRoster = list => (Array.isArray(list) ? list : []).slice(0, MAX_ROSTER).map(p => ({
  id: idOk(p && p.id) ? p.id : newId(), num: clean(p && p.num, 3), name: clean(p && p.name, 40)
})).filter(p => p.num || p.name);

const defaultMeta = () => ({
  gameId: newId(), startedAt: Date.now(), keepers: 1, period: '1Q',
  names: { home: 'FBCA', away: 'Opponent' }, colors: { ...DEFAULT_COLORS }, rosters: { home: [], away: [] }
});

export class Game extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY, seq INTEGER NOT NULL, side TEXT NOT NULL, player TEXT NOT NULL,
      type TEXT NOT NULL, period TEXT NOT NULL, at INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0)`);
    this.sql.exec('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
    // Keep-alive pings from the pages are answered without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  get(k, fallback) { const r = this.sql.exec('SELECT v FROM kv WHERE k = ?', k).toArray()[0]; return r ? JSON.parse(r.v) : fallback; }
  put(k, v) { this.sql.exec('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', k, JSON.stringify(v)); }
  meta() {
    let m = this.get('meta');
    if (!m) { m = defaultMeta(); this.put('meta', m); }
    if (!m.colors) m.colors = { ...DEFAULT_COLORS }; // games started before team colors
    return m;
  }
  rev() { return this.get('rev', 0); }
  bump() { const r = this.rev() + 1; this.put('rev', r); return r; }
  events() {
    return this.sql.exec('SELECT id, side, player, type, period, at FROM events WHERE deleted = 0 ORDER BY seq').toArray();
  }
  state() { return { rev: this.rev(), meta: this.meta(), events: this.events() }; }
  send(msg) {
    const text = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) { try { ws.send(text); } catch (e) { /* closing */ } }
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/ws') {
      const [client, server] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(server);
      server.send(JSON.stringify({ t: 'state', ...this.state() }));
      return new Response(null, { status: 101, webSocket: client });
    }
    if (request.method === 'GET' && url.pathname === '/state') return json(this.state());
    const library = () => Object.values(this.get('library', {})).sort((a, b) => a.name.localeCompare(b.name));
    if (request.method === 'GET' && url.pathname === '/library') return json({ teams: library() });

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') return json({ error: 'Send JSON' }, 400);
    const meta = this.meta();
    const stale = () => json({ error: 'That game was reset. Reload to join the new game.', reset: true, state: this.state() }, 409);

    if (url.pathname === '/events') {
      if (body.gameId !== meta.gameId) return stale();
      const list = Array.isArray(body.events) ? body.events.slice(0, 200) : [];
      let seq = this.get('seq', 0), count = this.sql.exec('SELECT COUNT(*) AS n FROM events').one().n;
      const added = [];
      for (const e of list) {
        if (!e || !idOk(e.id) || !SIDES.includes(e.side) || !TYPES.includes(e.type)) continue;
        if (count >= MAX_EVENTS) break;
        const ev = { id: e.id, side: e.side, player: idOk(e.player) || e.player === 'team' ? e.player : 'team',
                     type: e.type, period: clean(e.period, 4) || meta.period, at: Number(e.at) || Date.now() };
        // INSERT OR IGNORE: a retried play, or one already undone (kept as deleted), changes nothing.
        const r = this.sql.exec('INSERT OR IGNORE INTO events (id, seq, side, player, type, period, at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          ev.id, seq + 1, ev.side, ev.player, ev.type, ev.period, ev.at);
        if (r.rowsWritten > 0) { seq++; count++; added.push(ev); }
      }
      this.put('seq', seq);
      if (added.length) this.send({ t: 'add', rev: this.bump(), events: added });
      return json({ ok: true, rev: this.rev(), stored: list.filter(e => e && idOk(e.id)).map(e => e.id) });
    }

    if (url.pathname === '/undo') {
      if (body.gameId !== meta.gameId) return stale();
      const ids = (Array.isArray(body.ids) ? body.ids : []).filter(idOk).slice(0, 200), gone = [];
      for (const id of ids) {
        // A tombstone for an id we haven't seen yet, so the play is ignored if it arrives later.
        const r = this.sql.exec(`INSERT INTO events (id, seq, side, player, type, period, at, deleted) VALUES (?, 0, 'home', 'team', 'pf', '', 0, 1)
          ON CONFLICT(id) DO UPDATE SET deleted = 1 WHERE deleted = 0`, id);
        if (r.rowsWritten > 0) gone.push(id);
      }
      if (gone.length) this.send({ t: 'del', rev: this.bump(), ids: gone });
      return json({ ok: true, rev: this.rev() });
    }

    if (url.pathname === '/library') {
      const lib = this.get('library', {}), keyOf = n => clean(n, 30).toLowerCase();
      if (body.action === 'save') {
        for (const t of (Array.isArray(body.teams) ? body.teams : []).slice(0, 4)) {
          const name = clean(t && t.name, 30), roster = cleanRoster(t && t.roster);
          if (!name || !roster.length) continue;
          lib[keyOf(name)] = { name, roster, savedAt: Date.now(), ...(colorOk(t.color) ? { color: t.color.toUpperCase() } : {}) };
        }
        // Over the limit: forget the teams saved longest ago.
        const keys = Object.keys(lib).sort((a, b) => lib[b].savedAt - lib[a].savedAt);
        for (const k of keys.slice(MAX_SAVED)) delete lib[k];
      } else if (body.action === 'delete') delete lib[keyOf(body.name)];
      else return json({ error: 'Unknown action' }, 400);
      this.put('library', lib);
      return json({ ok: true, teams: library() });
    }

    if (url.pathname === '/meta') {
      if (body.gameId !== meta.gameId) return stale();
      const m = body.meta || {}, next = { ...meta };
      if (m.keepers === 1 || m.keepers === 2) next.keepers = m.keepers;
      if (m.period != null) next.period = clean(m.period, 4) || meta.period;
      if (m.names) next.names = Object.fromEntries(SIDES.map(s => [s, clean(m.names[s], 30) || meta.names[s]]));
      if (m.colors) next.colors = Object.fromEntries(SIDES.map(s => [s, colorOk(m.colors[s]) ? m.colors[s].toUpperCase() : meta.colors[s]]));
      if (m.rosters) next.rosters = Object.fromEntries(SIDES.map(s => [s, m.rosters[s] ? cleanRoster(m.rosters[s]) : meta.rosters[s]]));
      this.put('meta', next);
      this.send({ t: 'meta', rev: this.bump(), meta: next });
      return json({ ok: true, rev: this.rev(), meta: next });
    }

    if (url.pathname === '/reset') {
      const next = defaultMeta();
      if (body.keepRosters) { next.rosters = meta.rosters; next.names = meta.names; next.colors = meta.colors; next.keepers = meta.keepers; }
      this.sql.exec('DELETE FROM events');
      this.put('seq', 0); this.put('meta', next);
      this.bump();
      this.send({ t: 'state', ...this.state() });
      return json({ ok: true, ...this.state() });
    }
    return json({ error: 'Not found' }, 404);
  }

  // The pages ask for the whole game when they notice they missed a change.
  async webSocketMessage(ws, msg) {
    if (msg === 'sync') ws.send(JSON.stringify({ t: 'state', ...this.state() }));
  }
  async webSocketClose(ws, code) { try { ws.close(code, 'bye'); } catch (e) { /* already closed */ } }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url), origin = request.headers.get('Origin') || '';
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors(origin) });
    if (origin && !allowedOrigin(origin)) return json({ error: 'Not allowed from this site' }, 403, origin);

    const game = clean(url.searchParams.get('game') || 'basketball', 32);
    if (!/^[a-z0-9-]+$/.test(game)) return json({ error: 'Bad game name' }, 400, origin);
    const stub = env.GAME.get(env.GAME.idFromName(game));

    if (url.pathname === '/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') return json({ error: 'WebSocket only' }, 426, origin);
      return stub.fetch(request);
    }
    if (request.method === 'GET' && url.pathname === '/state') {
      const r = await stub.fetch(request);
      return withCors(r, origin);
    }
    if (['/events', '/undo', '/meta', '/reset', '/library'].includes(url.pathname) && (request.method === 'POST' || url.pathname === '/library')) {
      const given = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
      if (!await keyMatches(given, env.STAT_KEY)) return json({ error: 'Wrong stat keeper key' }, 401, origin);
      const r = await stub.fetch(request);
      return withCors(r, origin);
    }
    return json({ error: 'Not found' }, 404, origin);
  }
};
