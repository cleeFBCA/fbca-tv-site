// Stat keeper: live basketball stats for the EOTA broadcasts.
//
// The stat keeper page (graphics/basketball-stats.html) records each play as an event.
// The basketball scorebug control page listens over a WebSocket and turns the events into
// player and team stats for the bug, lower thirds and stats panel.
//
// One game is kept per name ("basketball", or "soccer" for the soccer stat page) in a Durable Object, so every tap is
// stored in one place in order, and two stat keepers can write to the same game.
//
//   GET  /state?game=basketball         the game: { rev, meta, events }
//   GET  /ws?game=basketball            WebSocket: the game on connect, then each change
//   POST /events  { gameId, events: [{ id, side, player, type, period, at, min?, note? }] }
//   POST /undo    { gameId, ids: [...] }
//   POST /meta    { gameId, meta: { keepers, period, names, colors, rosters, starters } }   (any subset)
//                 starters (basketball): { home: [player ids], away: [...] }, up to five each, set on the stat page.
//                 Soccer also: halfMin, otMin, clock { run, startedAt, base } (time played), clockSrc.
//                 Basketball also: qMin, otMin, clock { run, startedAt, base, len } (time LEFT in the quarter,
//                 counting down), clockSrc: the basketball scorebug shares its clock the way the soccer one does.
//                 timeouts { home, away, max }: each team's timeouts left and the game's allotment, shared with
//                 the clock (the box score shows them under the score).
//                 Both: status '' | 'half' | 'final', set from the scorebug's period (for the live box score).
//   POST /reset   { keepRosters, archive }   starts a new game; the finished one is kept in the archive first,
//                 or, with archive false (a test game), taken out of it
//   A game is also kept in the archive when the scorebug marks it final (meta.status), and kept up to date if a play
//   is added or undone after that, so it's in Past games without waiting for the next new game.
//   GET  /logo?game=basketball&side=home   a team's logo (PNG), as shared by the scorebug; meta.logos[side] = { v, name }
//                 With &v=, that version even after the side's logo has changed, so past games keep their logos.
//                 says which version is current and which team it belongs to (the app and box scores fetch it by v)
//   POST /logo    { side, name, png: 'data:image/png;base64,…' }  (png '' removes it)
//   POST /archive { action: 'delete', id } removes a past game; { action: 'logo', id, side, name, png } gives one a logo
//   GET  /archive?game=basketball      past games, newest first: { games: [{ id, startedAt, savedAt, names, score, plays }] }
//   GET  /archive?game=basketball&id=X one past game: { id, savedAt, meta, events }
//   POST /archive { action: 'delete', id }   forgets a past game
//   GET  /library                      saved teams: { teams: [{ name, team?, color?, roster, savedAt }] }
//   POST /library { action: 'save', teams: [{ name, team?, color, roster }] } | { action: 'delete', name }
//            name is the saved team's label ("FBCA Girls"); team, when different, is the name the box score shows ("FBCA").
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
// Plays each sport records. A game named "soccer…" is soccer; anything else is basketball.
const TYPES_BY_SPORT = {
  // in / out: a substitution, stamped with the game clock like any play (minutes and who's on the floor).
  // timeout: a team's timeout (player 'team'; note says how many it has left), from the scorebug or the stat page.
  basketball: ['m2', 'x2', 'm3', 'x3', 'mft', 'xft', 'oreb', 'dreb', 'ast', 'stl', 'blk', 'to', 'pf', 'in', 'out', 'timeout'],
  // og: an own goal, recorded on the defender who put it in (their side); it counts for the other team.
  // A penalty kick that goes in is a goal with note 'PK'. throw (throw-in) and fk (free kick) are the team's
  // (player 'team'); hand (handball) and pkm (a missed penalty kick) are a player's or the team's. Those four are
  // for the play-by-play only: no stats.
  soccer: ['goal', 'ast', 'sog', 'shot', 'save', 'corner', 'foul', 'offside', 'yc', 'rc', 'og', 'throw', 'fk', 'hand', 'pkm'],
  // Baseball and softball (graphics/baseball.js): every pitch and play, each carrying the situation after it in data.
  baseball: ['pitch', 'pa', 'br', 'pc', 'fix']
};
const sportOf = game => /^soccer/.test(game || '') ? 'soccer' : /^(baseball|softball)/.test(game || '') ? 'baseball' : 'basketball';
const MAX_DATA = 3000; // a baseball play's details and situation, as JSON
const MAX_SEASON = 400000; // one team's season record (typed or imported totals plus each game's lines)
const SIDES = ['home', 'away'];
const MAX_EVENTS = 3000, MAX_ROSTER = 30, MAX_SAVED = 150, MAX_ARCHIVE = 400, MAX_LOGO = 200000; // a logo's data URL, ~150 KB of PNG // ~two seasons of games per sport

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

// Soccer also keeps a match clock (shared by every stat device, for goal minutes) and its half length.
const defaultMeta = (sport = 'basketball') => ({
  gameId: newId(), startedAt: Date.now(), keepers: 1, period: sport === 'soccer' ? '1H' : sport === 'baseball' ? 'T1' : '1Q',
  names: { home: 'FBCA', away: 'Opponent' }, colors: { ...DEFAULT_COLORS }, rosters: { home: [], away: [] },
  ...(sport === 'soccer' ? { halfMin: 40, clock: { run: false, startedAt: 0, base: 0 } } : {}),
  ...(sport === 'baseball' ? { innings: 7, order: { home: [], away: [] }, sp: { home: '', away: '' } } : {})
});

export class Game extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY, seq INTEGER NOT NULL, side TEXT NOT NULL, player TEXT NOT NULL,
      type TEXT NOT NULL, period TEXT NOT NULL, at INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0)`);
    this.sql.exec('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
    // Finished games, saved when a new game starts: a summary for the list and the whole game (meta and plays).
    this.sql.exec('CREATE TABLE IF NOT EXISTS archive (id TEXT PRIMARY KEY, savedAt INTEGER NOT NULL, summary TEXT NOT NULL, data TEXT NOT NULL)');
    // The minute of a play (soccer goals), added after the first games were stored.
    try { this.sql.exec('ALTER TABLE events ADD COLUMN min TEXT'); } catch (e) { /* already there */ }
    // A short note on a play ("2 left" on a timeout), added later still.
    try { this.sql.exec('ALTER TABLE events ADD COLUMN note TEXT'); } catch (e) { /* already there */ }
    // A baseball play's details (JSON), added for baseball.
    try { this.sql.exec('ALTER TABLE events ADD COLUMN data TEXT'); } catch (e) { /* already there */ }
    this.sport = 'basketball';
    // Keep-alive pings from the pages are answered without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  get(k, fallback) { const r = this.sql.exec('SELECT v FROM kv WHERE k = ?', k).toArray()[0]; return r ? JSON.parse(r.v) : fallback; }
  put(k, v) { this.sql.exec('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', k, JSON.stringify(v)); }
  meta() {
    let m = this.get('meta');
    if (!m) { m = defaultMeta(this.sport); this.put('meta', m); }
    if (!m.colors) m.colors = { ...DEFAULT_COLORS }; // games started before team colors
    return m;
  }
  rev() { return this.get('rev', 0); }
  bump() { const r = this.rev() + 1; this.put('rev', r); return r; }
  events() {
    return this.sql.exec('SELECT id, side, player, type, period, at, min, note, data FROM events WHERE deleted = 0 ORDER BY seq').toArray()
      .map(e => { if (!e.min) delete e.min; if (!e.note) delete e.note; if (e.data) { try { e.data = JSON.parse(e.data); } catch (x) { delete e.data; } } else delete e.data; return e; });
  }
  state() { return { rev: this.rev(), meta: this.meta(), events: this.events() }; }
  // Keeps the current game in the archive (if it has any plays): its score worked out the way the pages do.
  archiveCurrent() {
    const meta = this.meta(), events = this.events();
    if (!events.length) return;
    const score = { home: 0, away: 0 }, PTS = { m2: 2, m3: 3, mft: 1 };
    if (this.sport === 'baseball') { const last = [...events].reverse().find(e => e.data && e.data.sit); if (last) Object.assign(score, last.data.sit.score); }
    else for (const e of events) {
      if (this.sport === 'soccer') { if (e.type === 'goal') score[e.side]++; if (e.type === 'og') score[e.side === 'home' ? 'away' : 'home']++; }
      else score[e.side] += PTS[e.type] || 0;
    }
    const savedAt = Date.now(), lastAt = Math.max(...events.map(e => e.at || 0));
    const summary = { id: meta.gameId, startedAt: meta.startedAt, lastAt, savedAt, names: meta.names, score, plays: events.length };
    this.sql.exec(`INSERT INTO archive (id, savedAt, summary, data) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET savedAt = excluded.savedAt, summary = excluded.summary, data = excluded.data`,
      meta.gameId, savedAt, JSON.stringify(summary), JSON.stringify({ meta, events }));
    this.sql.exec('DELETE FROM archive WHERE id NOT IN (SELECT id FROM archive ORDER BY savedAt DESC LIMIT ?)', MAX_ARCHIVE);
  }
  send(msg) {
    const text = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) { try { ws.send(text); } catch (e) { /* closing */ } }
  }

  async fetch(request) {
    const url = new URL(request.url);
    this.sport = sportOf(url.searchParams.get('game'));
    if (url.pathname === '/ws') {
      const [client, server] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(server);
      server.send(JSON.stringify({ t: 'state', ...this.state() }));
      return new Response(null, { status: 101, webSocket: client });
    }
    if (request.method === 'GET' && url.pathname === '/state') return json(this.state());
    if (request.method === 'GET' && url.pathname === '/logo') {
      const side = url.searchParams.get('side'), v = url.searchParams.get('v') || '';
      let logo = SIDES.includes(side) ? this.get('logo:' + side) : null;
      // A past game's logo: kept by version (logov:<v>) when it was shared
      if (v && (!logo || logo.v !== v) && /^[0-9a-f]{12}$/.test(v)) { const old = this.get('logov:' + v); logo = old ? { v, ...old } : null; }
      if (!logo) return new Response('No logo', { status: 404 });
      const bytes = Uint8Array.from(atob(logo.png.split(',')[1] || ''), c => c.charCodeAt(0));
      // Versioned by ?v=, so it can be cached for good; without one, briefly.
      return new Response(bytes, { headers: { 'Content-Type': 'image/png',
        'Cache-Control': url.searchParams.get('v') === logo.v ? 'public, max-age=31536000, immutable' : 'public, max-age=60' } });
    }
    if (request.method === 'GET' && url.pathname === '/archive') {
      const id = url.searchParams.get('id');
      if (id) {
        const r = this.sql.exec('SELECT savedAt, data FROM archive WHERE id = ?', id).toArray()[0];
        return r ? json({ id, savedAt: r.savedAt, ...JSON.parse(r.data) }) : json({ error: 'No saved game with that id' }, 404);
      }
      return json({ games: this.sql.exec('SELECT summary FROM archive ORDER BY savedAt DESC').toArray().map(r => JSON.parse(r.summary)) });
    }
    // Season stats (baseball): one record per team name. GET is open (the numbers go on air); changes need the key.
    const seasons = () => this.sql.exec("SELECT v FROM kv WHERE k LIKE 'season:%'").toArray().map(r => JSON.parse(r.v));
    if (request.method === 'GET' && url.pathname === '/season') return json({ teams: seasons() });
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
        if (!e || !idOk(e.id) || !SIDES.includes(e.side) || !TYPES_BY_SPORT[this.sport].includes(e.type)) continue;
        if (count >= MAX_EVENTS) break;
        const ev = { id: e.id, side: e.side, player: idOk(e.player) || e.player === 'team' ? e.player : 'team',
                     type: e.type, period: clean(e.period, 4) || meta.period, at: Number(e.at) || Date.now(), ...(e.min ? { min: clean(e.min, 6) } : {}),
                     ...(e.note ? { note: clean(e.note, 20) } : {}) };
        let data = null;
        if (this.sport === 'baseball') {
          const text = e.data && typeof e.data === 'object' ? JSON.stringify(e.data) : '';
          if (!text || text.length > MAX_DATA) continue;
          data = text; ev.data = e.data;
        }
        // INSERT OR IGNORE: a retried play, or one already undone (kept as deleted), changes nothing.
        const r = this.sql.exec('INSERT OR IGNORE INTO events (id, seq, side, player, type, period, at, min, note, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          ev.id, seq + 1, ev.side, ev.player, ev.type, ev.period, ev.at, ev.min || null, ev.note || null, data);
        if (r.rowsWritten > 0) { seq++; count++; added.push(ev); }
      }
      this.put('seq', seq);
      if (added.length) { this.send({ t: 'add', rev: this.bump(), events: added }); if (meta.status === 'final') this.archiveCurrent(); }
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
      if (gone.length) { this.send({ t: 'del', rev: this.bump(), ids: gone }); if (meta.status === 'final') this.archiveCurrent(); }
      return json({ ok: true, rev: this.rev() });
    }

    if (url.pathname === '/library') {
      const lib = this.get('library', {}), keyOf = n => clean(n, 60).toLowerCase(); // team names up to 60 ("Fort Bend Christian Academy Lady Eagles")
      if (body.action === 'save') {
        for (const t of (Array.isArray(body.teams) ? body.teams : []).slice(0, 4)) {
          const name = clean(t && t.name, 60), team = clean(t && t.team, 60), roster = cleanRoster(t && t.roster);
          if (!name) continue; // a team with no players yet is kept too (its name and color); the roster can come later
          lib[keyOf(name)] = { name, roster, savedAt: Date.now(), ...(team && team !== name ? { team } : {}), ...(colorOk(t.color) ? { color: t.color.toUpperCase() } : {}) };
        }
        // Over the limit: forget the teams saved longest ago.
        const keys = Object.keys(lib).sort((a, b) => lib[b].savedAt - lib[a].savedAt);
        for (const k of keys.slice(MAX_SAVED)) delete lib[k];
      } else if (body.action === 'delete') delete lib[keyOf(body.name)];
      else return json({ error: 'Unknown action' }, 400);
      this.put('library', lib);
      return json({ ok: true, teams: library() });
    }

    if (url.pathname === '/season') {
      const name = clean(body.name, 60), k = 'season:' + name.toLowerCase();
      if (!name) return json({ error: 'Send the team name' }, 400);
      const rec = this.get(k, { name, asOf: 0, base: { players: [] }, games: [] });
      const players = list => (Array.isArray(list) ? list : []).slice(0, 60);
      if (body.action === 'base') { rec.base = { players: players(body.players) }; rec.asOf = Math.max(0, Number(body.asOf) || 0); rec.source = clean(body.source, 30); }
      else if (body.action === 'game') {
        if (!idOk(body.id)) return json({ error: 'Send the game id' }, 400);
        const g = { id: body.id, at: Number(body.at) || Date.now(), opp: clean(body.opp, 60), players: players(body.players) };
        rec.games = [...(rec.games || []).filter(x => x.id !== g.id), g].sort((a, b) => a.at - b.at);
      } else if (body.action === 'dropgame') rec.games = (rec.games || []).filter(x => x.id !== body.id);
      else if (body.action === 'delete') { this.sql.exec('DELETE FROM kv WHERE k = ?', k); return json({ ok: true, teams: seasons() }); }
      else return json({ error: 'Unknown action' }, 400);
      rec.name = name; rec.updatedAt = Date.now();
      if (JSON.stringify(rec).length > MAX_SEASON) return json({ error: 'That season record is too big' }, 413);
      this.put(k, rec);
      this.send({ t: 'season', name });
      return json({ ok: true, teams: seasons() });
    }

    if (url.pathname === '/meta') {
      if (body.gameId !== meta.gameId) return stale();
      const m = body.meta || {}, next = { ...meta };
      if (m.keepers === 1 || m.keepers === 2) next.keepers = m.keepers;
      if (m.period != null) next.period = clean(m.period, 4) || meta.period;
      const n = v => Math.max(0, Math.min(1e13, Number(v) || 0));
      if (this.sport === 'soccer') {
        if (m.halfMin != null) next.halfMin = Math.max(1, Math.min(90, Math.round(Number(m.halfMin)) || 40));
        if (m.clock) next.clock = { run: !!m.clock.run, startedAt: n(m.clock.startedAt), base: n(m.clock.base) };
        if (m.otMin != null) next.otMin = Math.max(1, Math.min(30, Math.round(Number(m.otMin)) || 10));
      } else {
        // Basketball counts down: base is the time left when it was sent (startedAt), len the quarter's length.
        if (m.qMin != null) next.qMin = Math.max(1, Math.min(20, Math.round(Number(m.qMin)) || 8));
        if (m.otMin != null) next.otMin = Math.max(1, Math.min(10, Math.round(Number(m.otMin)) || 4));
        if (m.clock) next.clock = { run: !!m.clock.run, startedAt: n(m.clock.startedAt), base: Math.min(n(m.clock.base), 3600000), len: Math.min(n(m.clock.len), 3600000) };
        if (m.timeouts) { const to = v => Math.max(0, Math.min(11, Math.round(Number(v)) || 0)); next.timeouts = { home: to(m.timeouts.home), away: to(m.timeouts.away), max: to(m.timeouts.max) }; }
      }
      // Halftime or final, as set on the scorebug (fbca.tv's box score turns LIVE off at the final).
      if (m.status != null) next.status = m.status === 'half' || m.status === 'final' ? m.status : '';
      // The scorebug shares its clock: who set it, and when (the stat pages follow it while it keeps checking in).
      if (m.clockSrc != null) next.clockSrc = m.clockSrc === 'scorebug' ? 'scorebug' : '';
      if (m.clock) next.clockAt = Date.now();
      if (m.names) next.names = Object.fromEntries(SIDES.map(s => [s, clean(m.names[s], 60) || meta.names[s]]));
      // Each side's Saved teams label, when it differs from the name shown ("FBCA Girls" for FBCA)
      if (m.saved) next.saved = Object.fromEntries(SIDES.map(s => [s, clean(m.saved[s], 60)]));
      if (m.colors) next.colors = Object.fromEntries(SIDES.map(s => [s, colorOk(m.colors[s]) ? m.colors[s].toUpperCase() : meta.colors[s]]));
      if (m.rosters) next.rosters = Object.fromEntries(SIDES.map(s => [s, m.rosters[s] ? cleanRoster(m.rosters[s]) : meta.rosters[s]]));
      // Starters: up to five player ids per team, each once. A side left out keeps what it had.
      if (this.sport === 'baseball') {
        if (m.innings != null) next.innings = Math.max(1, Math.min(12, Math.round(Number(m.innings)) || 7));
        // Batting orders: up to 12 slots per team, each a player id and a position. A side left out keeps what it had.
        if (m.order) {
          const was = meta.order || { home: [], away: [] };
          next.order = Object.fromEntries(SIDES.map(s => [s, Array.isArray(m.order[s])
            ? m.order[s].filter(o => o && idOk(o.id)).slice(0, 12).map(o => ({ id: o.id, pos: clean(o.pos, 4) })) : (was[s] || [])]));
        }
        // Pitching decisions (win, loss, save), picked when the game is marked final. Sent whole; empty clears.
        if (m.dec) next.dec = Object.fromEntries(['W', 'L', 'S'].filter(k => m.dec[k] && SIDES.includes(m.dec[k].side) && idOk(m.dec[k].id)).map(k => [k, { side: m.dec[k].side, id: m.dec[k].id }]));
        // Starting pitchers: one player id per team (or none). They bat only if they're also in the order.
        if (m.sp) {
          const was = meta.sp || { home: '', away: '' };
          next.sp = Object.fromEntries(SIDES.map(s => [s, m.sp[s] == null ? (was[s] || '') : idOk(m.sp[s]) ? m.sp[s] : '']));
        }
      }
      if (m.starters && this.sport === 'basketball') {
        const was = meta.starters || { home: [], away: [] };
        next.starters = Object.fromEntries(SIDES.map(s => [s, Array.isArray(m.starters[s])
          ? [...new Set(m.starters[s].filter(idOk))].slice(0, 5) : (was[s] || [])]));
      }
      this.put('meta', next);
      this.send({ t: 'meta', rev: this.bump(), meta: next });
      if (next.status === 'final' && meta.status !== 'final') this.archiveCurrent(); // marked final: into Past games now
      return json({ ok: true, rev: this.rev(), meta: next });
    }

    if (url.pathname === '/logo') {
      const side = body.side, png = typeof body.png === 'string' ? body.png : '';
      if (!SIDES.includes(side)) return json({ error: 'side must be home or away' }, 400);
      if (png && (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(png) || png.length > MAX_LOGO)) return json({ error: 'Send a PNG data URL under 150 KB' }, 400);
      const name = clean(body.name, 60), was = this.get('logo:' + side);
      const v = png ? [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(png)))].slice(0, 6).map(b => b.toString(16).padStart(2, '0')).join('') : '';
      // Every version is kept too, so a past game's box score still shows the logos it had (one copy per logo).
      // Before the unchanged check, so a logo first shared before versions were kept gets its copy on a re-send.
      if (png && !this.get('logov:' + v)) this.put('logov:' + v, { name, png });
      if ((was ? was.v : '') === v && (!was || was.name === name)) return json({ ok: true, v, unchanged: true });
      if (png) this.put('logo:' + side, { v, name, png }); else this.sql.exec('DELETE FROM kv WHERE k = ?', 'logo:' + side);
      const next = { ...meta, logos: { ...(meta.logos || {}) } };
      if (png) next.logos[side] = { v, name }; else delete next.logos[side];
      this.put('meta', next);
      this.send({ t: 'meta', rev: this.bump(), meta: next });
      return json({ ok: true, v });
    }

    if (url.pathname === '/archive') {
      if (typeof body.id !== 'string') return json({ error: 'Unknown action' }, 400);
      // A logo for a past game that was saved without one: { action: 'logo', id, side, name, png }
      if (body.action === 'logo') {
        const r = this.sql.exec('SELECT data FROM archive WHERE id = ?', body.id).toArray()[0];
        if (!r) return json({ error: 'No saved game with that id' }, 404);
        const side = body.side, png = typeof body.png === 'string' ? body.png : '';
        if (!SIDES.includes(side) || !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(png) || png.length > MAX_LOGO) return json({ error: 'Send a side and a PNG data URL under 150 KB' }, 400);
        const name = clean(body.name, 60);
        const v = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(png)))].slice(0, 6).map(b => b.toString(16).padStart(2, '0')).join('');
        if (!this.get('logov:' + v)) this.put('logov:' + v, { name, png });
        const data = JSON.parse(r.data);
        data.meta.logos = { ...(data.meta.logos || {}), [side]: { v, name } };
        this.sql.exec('UPDATE archive SET data = ? WHERE id = ?', JSON.stringify(data), body.id);
        return json({ ok: true, v });
      }
      if (body.action !== 'delete') return json({ error: 'Unknown action' }, 400);
      this.sql.exec('DELETE FROM archive WHERE id = ?', body.id);
      return json({ ok: true });
    }

    if (url.pathname === '/reset') {
      if (body.archive !== false) this.archiveCurrent();
      else this.sql.exec('DELETE FROM archive WHERE id = ?', meta.gameId); // a test game, saved when it was marked final
      const next = defaultMeta(this.sport);
      if (body.keepRosters) { if (meta.innings) next.innings = meta.innings; next.rosters = meta.rosters; next.names = meta.names; if (meta.saved) next.saved = meta.saved; next.colors = meta.colors; next.keepers = meta.keepers; if (meta.halfMin) next.halfMin = meta.halfMin; if (meta.logos) next.logos = meta.logos; }
      else for (const side of SIDES) this.sql.exec('DELETE FROM kv WHERE k = ?', 'logo:' + side); // new teams: their logos come from the scorebug
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
    if (request.method === 'GET' && (url.pathname === '/state' || url.pathname === '/archive' || url.pathname === '/logo' || url.pathname === '/season')) {
      const r = await stub.fetch(request);
      return withCors(r, origin);
    }
    if (['/events', '/undo', '/meta', '/reset', '/library', '/archive', '/logo', '/season'].includes(url.pathname) && (request.method === 'POST' || url.pathname === '/library')) {
      const given = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
      if (!await keyMatches(given, env.STAT_KEY)) return json({ error: 'Wrong stat keeper key' }, 401, origin);
      const r = await stub.fetch(request);
      return withCors(r, origin);
    }
    return json({ error: 'Not found' }, 404, origin);
  }
};
