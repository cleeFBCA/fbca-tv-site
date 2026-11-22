/* EOTA live box score: reads the current game from the stat keeper (workers/stat-keeper) and keeps it current.
   Used by fbca.tv/boxscore and the live card on the home page.

   Which game: the soccer and basketball stat keepers are each read once; the one with the most recent activity
   (a play, a clock check-in from the scorebug, or a new game) is shown. Then one WebSocket keeps it live: the stat
   keeper pushes each play as it's recorded, so a page never has to ask again. That matters for Cloudflare's free
   plan (100,000 requests a day for the whole account): a viewer costs one connection plus a keep-alive every
   45 seconds (answered without waking the server), not a request every few seconds. A tab in the background
   closes its connection after 30 seconds and reconnects when it's visible again. Only if the WebSocket keeps
   failing does the page fall back to reading the game once a minute.

   LIVE comes from the schedule, as on the home page: a soccer or basketball game counts as live from 5 minutes before
   its start to 3 hours after (cancelled and postponed games never do), and only with stats recorded for it. The
   scorebug tells the stat keeper when the game is at halftime or final (meta.status), and the LIVE tag follows.

   ?skapi=http://localhost:PORT points at a local stat keeper for testing; ?game=soccer|basketball picks one. */
(() => {
  const params = new URLSearchParams(location.search);
  const local = params.get('skapi');
  const API = local && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(local) ? local : 'https://eota-stat-keeper.clee-625.workers.dev';
  const WS = API.replace(/^http/, 'ws');
  const GAMES = ['basketball', 'soccer'];
  const SHOW_MS = 12 * 3600000;  // fbca.tv/boxscore keeps the last game up this long
  const LIVE_LEAD_MIN = 5, LIVE_DURATION_HRS = 3; // the home page's live window
  const STATS_LEAD_MS = 2 * 3600000; // stats recorded from 2 hours before the start count as this game's

  // ---------- The schedule ----------
  const sportOfScheduled = g => /soccer/i.test(g.sport || '') ? 'soccer' : /basketball/i.test(g.sport || '') ? 'basketball' : '';
  const isOff = g => /^(cancell?ed|postponed)$/i.test(g.status || '');
  // The scheduled soccer or basketball game in its live window now, if any: { sport, start, game }.
  const liveScheduled = (games, now = Date.now()) => {
    const on = (games || []).map(g => ({ g, start: Date.parse(g.start), sport: sportOfScheduled(g) }))
      .filter(x => x.sport && !isOff(x.g) && now >= x.start - LIVE_LEAD_MIN * 60000 && now <= x.start + LIVE_DURATION_HRS * 3600000)
      .sort((a, b) => b.start - a.start);
    return on[0] ? { sport: on[0].sport, start: on[0].start, game: on[0].g } : null;
  };
  // The schedule entry for a game: same sport, same day (local time) as `when` (ms, when the stat crew started it). On a
  // doubleheader day (girls at 5, boys at 7), the one whose start is closest to `when`.
  const scheduleFor = (games, sport, when) => {
    const day = d => { const x = new Date(d); return x.getFullYear() + '-' + x.getMonth() + '-' + x.getDate(); }, want = day(when);
    const same = (games || []).filter(g => sportOfScheduled(g) === sport && !isOff(g) && day(Date.parse(g.start)) === want);
    return same.sort((a, b) => Math.abs(Date.parse(a.start) - when) - Math.abs(Date.parse(b.start) - when))[0] || null;
  };
  const loadSchedule = () => fetch('/schedule.json', { cache: 'no-cache' }).then(r => r.ok ? r.json() : null).then(d => (d && d.games) || []).catch(() => null);

  // ---------- Reading a game ----------
  const latestAt = st => {
    if (!st || !st.meta) return 0;
    const ev = st.events || [], m = st.meta;
    return Math.max(m.startedAt || 0, m.clockSrc === 'scorebug' ? m.clockAt || 0 : 0, ...ev.map(e => e.at || 0));
  };
  const B_KEYS = ['m2', 'x2', 'm3', 'x3', 'mft', 'xft', 'oreb', 'dreb', 'ast', 'stl', 'blk', 'to', 'pf'];
  const S_KEYS = ['goal', 'ast', 'sog', 'shot', 'save', 'corner', 'foul', 'offside', 'yc', 'rc', 'og'];
  const zero = keys => Object.fromEntries(keys.map(k => [k, 0]));

  // Largest lead and percent led, for basketball team stats. The same code is in boxscore/live.js and
  // graphics/basketball-scorebug.html. The scoring plays, in the order entered, give the running score: a team's largest
  // lead is the most it was ahead by at any point. Percent led is the share of the game time played that a team was
  // ahead, timed by the game clock each play is stamped with (the stat page stamps plays while the scorebug shares its
  // clock). If any scoring play has no stamp, percent led stays blank rather than guess.
  const LEAD_PTS = { m2: 2, m3: 3, mft: 1 }, LEAD_PERIODS = ['1Q', '2Q', '3Q', '4Q', 'OT', 'OT2', 'OT3'];
  // Game time in seconds from the opening tip to `left` seconds left in period p (the stat keeper's period names).
  const leadClock = (qMin, otMin) => {
    const q = (qMin || 8) * 60, ot = (otMin || 4) * 60, len = i => i < 4 ? q : ot;
    const at = (p, left) => { const i = LEAD_PERIODS.indexOf(p); return i < 0 || !(left >= 0) ? null : (i < 4 ? i * q : 4 * q + (i - 4) * ot) + Math.max(0, len(i) - left); };
    return { at, end: p => at(p, 0) };
  };
  // → { big: {home, away}, led: {home, away} (seconds, up to the last scoring play), last (its game time),
  //     diff (home minus away after it), timed (every scoring play had a clock stamp), endPer (latest period played) }
  const leadTrack = (events, clock) => {
    let h = 0, a = 0, last = 0, timed = true, endI = 0;
    const big = { home: 0, away: 0 }, led = { home: 0, away: 0 };
    for (const e of events) {
      endI = Math.max(endI, LEAD_PERIODS.indexOf(e.period));
      const pts = LEAD_PTS[e.type]; if (!pts || (e.side !== 'home' && e.side !== 'away')) continue;
      const m = /^(\d+):(\d\d)$/.exec(e.min || ''), t = m ? clock.at(e.period, +m[1] * 60 + +m[2]) : null;
      if (t == null) timed = false;
      else if (timed) { if (t > last) { if (h > a) led.home += t - last; else if (a > h) led.away += t - last; } last = Math.max(last, t); }
      if (e.side === 'home') h += pts; else a += pts;
      big.home = Math.max(big.home, h - a); big.away = Math.max(big.away, a - h);
    }
    return { big, led, last, diff: h - a, timed, endPer: LEAD_PERIODS[endI] };
  };
  // Percent led for each side (0 to 1) at game time `now` in seconds (the last scoring play when unknown); null when untimed.
  const leadPct = (L, now) => {
    if (!L || !L.timed) return null;
    const end = Math.max(L.last, now || 0), led = { ...L.led };
    if (L.diff > 0) led.home += end - L.last; else if (L.diff < 0) led.away += end - L.last;
    return end > 0 ? { home: led.home / end, away: led.away / end } : { home: 0, away: 0 };
  };

  // Who's on the floor and minutes played (basketball). The same code is in boxscore/live.js and
  // graphics/basketball-stats.html. The stat keeper sets each team's five starters (meta.starters) and records each
  // substitution as an "out" and an "in" play, stamped with the game clock like every play. Starters go in at the
  // opening tip. A player's minutes are the game time between going in and coming out (or now, while still on the
  // floor): game clock, so timeouts and halftime don't count. If any of a team's subs has no clock stamp (the scorebug
  // wasn't sharing its clock), that team's minutes stay blank rather than guess.
  // Game time now, in seconds from the opening tip: the shared clock, or the end of the period at halftime / the final.
  const gameNow = (m, clock) => {
    if (m.status === 'final' || m.status === 'half') return clock.end(m.period);
    const c = m.clock;
    if (!c || m.clockSrc !== 'scorebug' || Date.now() - (m.clockAt || 0) >= 150000) return null;
    return clock.at(m.period, Math.max(0, (c.base || 0) - (c.run ? Date.now() - (c.startedAt || Date.now()) : 0)) / 1000);
  };
  // → { floor: five slots of player ids (null = open; a sub takes the slot of the player going out),
  //     secs: { id: seconds played } or null when untimed }
  const floorTrack = (events, starters, side, clock, now) => {
    const floor = (starters || []).slice(0, 5), inAt = new Map(floor.map(id => [id, 0])), secs = {};
    while (floor.length < 5) floor.push(null);
    let timed = true, lastT = 0;
    for (const e of events) {
      if (e.side !== side || (e.type !== 'in' && e.type !== 'out')) continue;
      const m = /^(\d+):(\d\d)$/.exec(e.min || ''), t = m ? clock.at(e.period, +m[1] * 60 + +m[2]) : null;
      if (t == null) timed = false; else lastT = Math.max(lastT, t);
      const slot = floor.indexOf(e.player);
      if (e.type === 'out' && slot >= 0) {
        const t0 = inAt.get(e.player);
        if (t != null && t0 != null) secs[e.player] = (secs[e.player] || 0) + Math.max(0, t - t0);
        floor[slot] = null; inAt.delete(e.player);
      } else if (e.type === 'in' && slot < 0) {
        const open = floor.indexOf(null);
        if (open >= 0) floor[open] = e.player; else floor.push(e.player);
        inAt.set(e.player, t);
      }
    }
    const end = now == null ? lastT : Math.max(now, lastT);
    for (const [id, t0] of inAt) if (t0 != null) secs[id] = (secs[id] || 0) + Math.max(0, end - t0);
    return { floor, secs: timed ? secs : null };
  };
  // Minutes as box scores show them: whole minutes, rounded.
  const minText = sec => sec == null ? '–' : String(Math.round(sec / 60));

  // Players and team totals for both sides, the score, and the latest play.
  const compute = (sport, st) => {
    const m = st.meta, keys = sport === 'soccer' ? S_KEYS : B_KEYS, out = { sport, meta: m, sides: {} };
    for (const side of ['home', 'away']) {
      const roster = (m.rosters && m.rosters[side]) || [], players = new Map(roster.map(p => [p.id, { ...p, ...zero(keys), any: false }]));
      const tot = zero(keys);
      for (const e of st.events || []) {
        if (e.side !== side || !keys.includes(e.type)) continue;
        tot[e.type]++;
        const p = players.get(e.player);
        if (p) { p[e.type]++; p.any = true; }
      }
      // The whole roster, by number (#0 first, then #00, then #1...; no number goes last): players with nothing recorded yet show zeros (dimmed).
      const numOf = p => { const n = parseInt(p.num, 10); return Number.isNaN(n) ? 999 : n; };
      const list = [...players.values()].sort((a, b) => numOf(a) - numOf(b) || String(a.num).length - String(b.num).length || a.name.localeCompare(b.name));
      out.sides[side] = { name: (m.names && m.names[side]) || (side === 'home' ? 'FBCA' : 'Opponent'), color: (m.colors && m.colors[side]) || '#333333', players: list, tot,
                          score: sport === 'soccer' ? tot.goal : 2 * tot.m2 + 3 * tot.m3 + tot.mft };
    }
    // Soccer: an own goal (recorded on the defender) counts for the other team.
    if (sport === 'soccer') { out.sides.home.score += out.sides.away.tot.og; out.sides.away.score += out.sides.home.tot.og; }
    const evs = st.events || [];
    const plays = evs.filter(e => e.type !== 'in' && e.type !== 'out'); // substitutions aren't plays to show
    out.latest = plays.length ? plays[plays.length - 1] : null;
    // Basketball: largest lead and percent led, and starters and minutes (all to now; see gameNow).
    if (sport === 'basketball') {
      const clock = leadClock(m.qMin, m.otMin), L = leadTrack(evs, clock), now = gameNow(m, clock), pct = leadPct(L, now);
      for (const side of ['home', 'away']) {
        const t = out.sides[side], starters = ((m.starters || {})[side] || []).filter(id => t.players.some(p => p.id === id));
        Object.assign(t.tot, { lead: L.big[side], ledPct: pct ? pct[side] : null });
        t.starters = starters;
        if (starters.length) {
          const f = floorTrack(evs, starters, side, clock, now);
          for (const p of t.players) p.sec = f.secs ? f.secs[p.id] || 0 : null;
        }
      }
    }
    out.plays = evs.length;
    out.events = evs;
    return out;
  };

  // ---------- The game, play by play (basketball's Gamecast, Play-by-Play and charts) ----------
  // Each play's game time (seconds from the opening tip) from its clock stamp. Plays with no stamp (the scorebug wasn't
  // sharing its clock) are spread evenly through their quarter, so the charts still have a shape.
  const PTS_OF = { m2: 2, m3: 3, mft: 1 };
  // Win probability: an estimate, not a forecast model. It starts even, and after each basket asks how likely the
  // leader is to stay ahead with the time left, treating the rest of the game's scoring as random with a spread that
  // shrinks as time runs out (a typical high school final margin varies by about 11 points over 32 minutes).
  const WP_SPREAD = 11;
  const normCdf = x => { const t = 1 / (1 + .3275911 * Math.abs(x) / Math.SQRT2), y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - .284496736) * t + .254829592) * t * Math.exp(-x * x / 2); return x >= 0 ? (1 + y) / 2 : (1 - y) / 2; };
  // Home (FBCA)'s chance of winning, 0-1, ahead by `diff` with `left` seconds to play in a `full`-second game.
  const winProb = (diff, left, full, final) => {
    if (final || left <= 0) return diff > 0 ? 1 : diff < 0 ? 0 : .5;
    return normCdf(diff / (WP_SPREAD * Math.sqrt(left / full)));
  };
  const flow = g => {
    const m = g.meta, clock = leadClock(m.qMin, m.otMin), q = (m.qMin || 8) * 60, full = 4 * q, evs = g.events || [];
    const per = e => Math.max(0, LEAD_PERIODS.indexOf(e.period)), stamp = e => { const x = /^(\d+):(\d\d)$/.exec(e.min || ''); return x ? clock.at(e.period, +x[1] * 60 + +x[2]) : null; };
    // Game time for every play, with unstamped plays spread through their quarter
    const tOf = new Map(), byPer = {};
    evs.forEach(e => (byPer[per(e)] = byPer[per(e)] || []).push(e));
    for (const [i, list] of Object.entries(byPer)) {
      const start = clock.at(LEAD_PERIODS[i], i < 4 ? q : (m.otMin || 4) * 60), end = clock.end(LEAD_PERIODS[i]);
      list.forEach((e, k) => { const t = stamp(e); tOf.set(e.id, t != null ? t : start + (end - start) * (k + 1) / (list.length + 1)); });
    }
    const lastPer = evs.length ? Math.max(...evs.map(per)) : Math.max(0, LEAD_PERIODS.indexOf(m.period));
    const curPer = Math.max(lastPer, LEAD_PERIODS.indexOf(m.period)), final = g.status === 'final';
    const endT = Math.max(full, clock.end(LEAD_PERIODS[curPer]) || full);   // the whole game so far, at least regulation
    let nowT = final ? clock.end(LEAD_PERIODS[curPer]) : gameNow(m, clock);
    if (nowT == null) nowT = evs.length ? Math.max(...evs.map(e => tOf.get(e.id))) : 0;
    // Running score, by quarter, the probability and game flow series, lead changes
    let h = 0, a = 0, leader = 0, changes = 0;
    const quarters = [], series = [{ t: 0, h: 0, a: 0, p: .5 }], scoreAfter = new Map(), wpAfter = new Map();
    for (const e of evs) {
      const pts = PTS_OF[e.type];
      if (pts && (e.side === 'home' || e.side === 'away')) {
        const i = per(e); quarters[i] = quarters[i] || { home: 0, away: 0 }; quarters[i][e.side] += pts;
        if (e.side === 'home') h += pts; else a += pts;
        const lead = Math.sign(h - a); if (lead && leader && lead !== leader) changes++; if (lead) leader = lead;
        const t = tOf.get(e.id), lft = t < full ? full - t : Math.max(0, clock.end(LEAD_PERIODS[per(e)]) - t);
        series.push({ t, h, a, p: winProb(h - a, lft, full), id: e.id });
      }
      scoreAfter.set(e.id, { home: h, away: a });
      wpAfter.set(e.id, series[series.length - 1].p);
    }
    const pNow = winProb(h - a, final ? 0 : Math.max(0, (nowT < full ? full : clock.end(LEAD_PERIODS[curPer])) - nowT), full, final);
    series.push({ t: Math.max(nowT, series[series.length - 1].t), h, a, p: pNow });
    for (let i = 0; i <= Math.max(3, curPer); i++) quarters[i] = quarters[i] || { home: 0, away: 0 };
    // Who's on the floor now (needs the starters set on the stat page)
    const floor = {};
    for (const side of ['home', 'away']) {
      const t = g.sides[side], st = t.starters || [];
      floor[side] = st.length ? floorTrack(evs, st, side, clock, null).floor.filter(Boolean).map(id => t.players.find(p => p.id === id)).filter(Boolean) : null;
    }
    return { tOf, quarters, series, changes, pNow, scoreAfter, wpAfter, floor, endT, nowT, full, curPer, clock };
  };
  // The plays to list, oldest first: a made basket carries the assist recorded right after it, and a player going out
  // and one coming in for the same team are one substitution.
  const playList = g => {
    const evs = g.events || [], out = [];
    for (let i = 0; i < evs.length; i++) {
      const e = evs[i], n = evs[i + 1];
      if ((e.type === 'm2' || e.type === 'm3') && n && n.type === 'ast' && n.side === e.side && Math.abs((n.at || 0) - (e.at || 0)) < 30000) { out.push({ e, ast: n }); i++; continue; }
      if ((e.type === 'out' || e.type === 'in') && n && n.side === e.side && n.type === (e.type === 'out' ? 'in' : 'out')) {
        out.push({ e: e.type === 'in' ? e : n, sub: e.type === 'out' ? e : n, id: e.id }); i++; continue;
      }
      out.push({ e });
    }
    return out;
  };

  // ---------- Words for the page ----------
  const B_PLAY = { m2: 'made a 2-pointer', x2: 'missed a 2-pointer', m3: 'made a 3-pointer', x3: 'missed a 3-pointer', mft: 'made a free throw', xft: 'missed a free throw',
                   oreb: 'offensive rebound', dreb: 'defensive rebound', ast: 'assist', stl: 'steal', blk: 'block', to: 'turnover', pf: 'foul', timeout: 'timeout' };
  const S_PLAY = { goal: 'GOAL', ast: 'assist', sog: 'shot on target', shot: 'shot off target', save: 'save', corner: 'corner kick', foul: 'foul', offside: 'offside', yc: 'yellow card', rc: 'red card', og: 'OWN GOAL',
                   throw: 'throw-in', fk: 'free kick', hand: 'handball', pkm: 'missed penalty kick' };
  const PERIOD = { '1Q': '1st quarter', '2Q': '2nd quarter', '3Q': '3rd quarter', '4Q': '4th quarter', OT: 'Overtime', OT2: '2nd overtime', OT3: '3rd overtime',
                   '1H': '1st half', '2H': '2nd half', OT1: 'Overtime', };
  const PER_SHORT = { '1Q': '1Q', '2Q': '2Q', '3Q': '3Q', '4Q': '4Q', OT: 'OT', OT2: '2OT', OT3: '3OT', '1H': '1H', '2H': '2H', OT1: 'OT', };
  const playerName = (g, side, id) => {
    if (id === 'team' || !id) return g.sides[side].name;
    const p = ((g.meta.rosters && g.meta.rosters[side]) || []).find(x => x.id === id);
    return p ? (p.num ? '#' + p.num + ' ' : '') + p.name : g.sides[side].name;
  };
  // "52'" for soccer, "3:42" left for basketball: from the play itself, so it's the time it happened.
  const playTime = (g, e) => e.min ? (g.sport === 'soccer' ? e.min + "'" : e.min) : '';
  const latestText = g => {
    const e = g.latest; if (!e) return null;
    let words = (g.sport === 'soccer' ? S_PLAY : B_PLAY)[e.type] || e.type;
    // A timeout: the team's name, then "timeout (2 left)" (the scorebug sends how many are left).
    if (e.type === 'timeout' && e.note) words += ' (' + e.note + ')';
    // A penalty kick that went in: a goal with note 'PK'.
    if (g.sport === 'soccer' && e.type === 'goal' && e.note === 'PK') words = 'PENALTY KICK GOAL';
    // An own goal: "#5 Jane Doe (TKS) · OWN GOAL", then "Goal for FBCA" where the team usually goes.
    if (e.type === 'og') {
      const other = e.side === 'home' ? 'away' : 'home', who = e.player === 'team' || !e.player ? g.sides[e.side].name + ' defender' : playerName(g, e.side, e.player) + ' (' + g.sides[e.side].name + ')';
      return { when: [PER_SHORT[e.period] || e.period, playTime(g, e)].filter(Boolean).join(' '), who, what: words, team: 'Goal for ' + g.sides[other].name, side: other, big: true };
    }
    return { when: [PER_SHORT[e.period] || e.period, playTime(g, e)].filter(Boolean).join(' '), who: playerName(g, e.side, e.player), what: words,
             team: g.sides[e.side].name, side: e.side, big: e.type === 'goal' || e.type === 'm3' || e.type === 'rc' };
  };

  // The clock: soccer's match minute (shared by the scorebug or run by the stat crew); basketball's time left,
  // shared by the scorebug while it keeps checking in.
  const clockText = g => {
    const m = g.meta, c = m.clock;
    if (!c) return '';
    if (g.sport === 'soccer') {
      if (!c.run && !c.base) return '';
      const ms = (c.base || 0) + (c.run ? Date.now() - (c.startedAt || Date.now()) : 0);
      const half = m.halfMin || 40, ot = m.otMin || 10, start = { '1H': 0, '2H': half, OT1: 2 * half, OT2: 2 * half + ot }[m.period] || 0;
      const len = /^OT/.test(m.period) ? ot : half, into = Math.floor(ms / 60000) + 1;
      return (into > len ? `${start + len}+${into - len}` : String(start + into)) + "'";
    }
    if (m.clockSrc !== 'scorebug' || Date.now() - (m.clockAt || 0) > 150000) return '';
    const left = Math.max(0, (c.base || 0) - (c.run ? Date.now() - (c.startedAt || Date.now()) : 0)), sec = Math.ceil(left / 1000);
    return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
  };

  // Basketball timeouts left, shared by the scorebug with its clock: { home, away, max }, or null when it isn't
  // sharing (or has stopped checking in) or the game is over.
  const timeoutsLeft = g => {
    const m = g.meta, t = m.timeouts;
    if (g.sport !== 'basketball' || !t || g.status === 'final' || m.clockSrc !== 'scorebug' || Date.now() - (m.clockAt || 0) > 150000) return null;
    return t;
  };

  // ---------- Staying connected ----------
  // watch(onUpdate): onUpdate(game | null) on load and every change. game = { sport, live, at, ...compute() }.
  // scheduledOnly (the home page): nothing (and no connection) unless a scheduled soccer or basketball game is live.
  // game.scheduled: these stats are the live scheduled game's. game.status: '', 'half' or 'final' (from the scorebug).
  const watch = (onUpdate, { only, scheduledOnly = false } = {}) => {
    let sport = null, st = null, ws = null, ping = 0, retry = 0, fails = 0, poll = 0, hiddenTimer = 0, stopped = false;
    let schedule = [], sched = null, schedKey = '';
    // This game's stats: a new game started on the stat keeper, or plays recorded, from 2 hours before the scheduled
    // start (the scorebug's clock checking in doesn't count). Plays from before that are an earlier game's, left
    // behind if the stat crew didn't start a new game, and are left out.
    const since = () => sched.start - STATS_LEAD_MS;
    const recorded = s => Math.max((s.meta && s.meta.startedAt) || 0, ...(s.events || []).map(e => e.at || 0));
    const isScheduled = () => !!(sched && st && sched.sport === sport && recorded(st) >= since());
    const thisGame = () => isScheduled() ? { ...st, events: (st.events || []).filter(e => (e.at || 0) >= since()) } : st;
    // A scheduled game that's on but has no stats yet: { waiting: <schedule entry> } for fbca.tv/boxscore to say so.
    const waiting = () => sched && (!st || sport !== sched.sport || !isScheduled()) ? { waiting: sched.game } : null;
    const emit = () => {
      if (!st) return onUpdate(scheduledOnly ? null : waiting());
      const at = latestAt(st), scheduled = isScheduled();
      if (scheduledOnly && !scheduled) return onUpdate(null);
      if (!scheduledOnly && sched && !scheduled) return onUpdate(waiting());
      if (!scheduledOnly && Date.now() - at > SHOW_MS && !only && !scheduled) return onUpdate(null);
      const info = scheduled ? sched.game : scheduleFor(schedule, sport, (st.meta && st.meta.startedAt) || at);
      onUpdate({ ...compute(sport, thisGame()), at, scheduled, status: (st.meta && st.meta.status) || '', info });
    };
    const pickGame = async () => {
      const want = only || params.get('game') || (sched && sched.sport);
      const list = GAMES.includes(want) ? [want] : GAMES;
      const read = await Promise.all(list.map(g => fetch(API + '/state?game=' + g, { cache: 'no-store' }).then(r => r.ok ? r.json() : null).catch(() => null)));
      let best = -1;
      read.forEach((s, i) => { if (s && (best < 0 || latestAt(s) > latestAt(read[best]))) best = i; });
      if (best < 0) return false;
      sport = list[best]; st = read[best];
      return true;
    };
    const startPolling = () => {
      clearInterval(poll);
      poll = setInterval(async () => {
        try { const r = await fetch(API + '/state?game=' + sport, { cache: 'no-store' }); if (r.ok) { st = await r.json(); emit(); } } catch (e) { /* next time */ }
      }, 60000);
    };
    const connect = () => {
      if (stopped || ws || document.visibilityState === 'hidden') return;
      clearTimeout(retry);
      try { ws = new WebSocket(WS + '/ws?game=' + sport); } catch (e) { ws = null; return scheduleRetry(); }
      ws.onopen = () => { fails = 0; clearInterval(poll); poll = 0; clearInterval(ping); ping = setInterval(() => { if (ws && ws.readyState === 1) ws.send('ping'); }, 45000); };
      ws.onmessage = e => {
        if (e.data === 'pong') return;
        let msg; try { msg = JSON.parse(e.data); } catch (err) { return; }
        if (msg.t === 'state') st = { rev: msg.rev, meta: msg.meta, events: msg.events };
        else if (!st || msg.rev !== st.rev + 1) { ws.send('sync'); return; } // missed a change: ask for the whole game
        else {
          st.rev = msg.rev;
          if (msg.t === 'add') { const have = new Set(st.events.map(x => x.id)); st.events.push(...msg.events.filter(x => !have.has(x.id))); }
          if (msg.t === 'del') st.events = st.events.filter(x => !msg.ids.includes(x.id));
          if (msg.t === 'meta') st.meta = msg.meta;
        }
        emit();
      };
      ws.onclose = () => { clearInterval(ping); ws = null; if (!stopped && document.visibilityState !== 'hidden') { fails++; scheduleRetry(); } };
      ws.onerror = () => { try { ws && ws.close(); } catch (e) { /* closing */ } };
    };
    // Back off 2 s, 4 s, 8 s … up to 30 s (with a little randomness so a crowd doesn't reconnect at once).
    const scheduleRetry = () => {
      clearTimeout(retry);
      if (fails >= 3 && !poll) startPolling();
      retry = setTimeout(connect, Math.min(30000, 2000 * 2 ** Math.min(fails, 4)) * (0.75 + Math.random() / 2));
    };
    document.addEventListener('visibilitychange', () => {
      clearTimeout(hiddenTimer);
      if (document.visibilityState === 'hidden') hiddenTimer = setTimeout(() => { if (ws) { const w = ws; ws = null; w.onclose = null; clearInterval(ping); w.close(); } }, 30000);
      else if (sport && !ws) { fails = 0; connect(); }
    });
    const disconnect = () => { clearTimeout(retry); clearInterval(poll); poll = 0; clearInterval(ping); if (ws) { const w = ws; ws = null; w.onclose = null; w.close(); } };
    // (Re)start from the schedule: which game, and whether it needs a live connection at all.
    const start = async () => {
      const games = await loadSchedule();
      if (games) schedule = games;
      sched = liveScheduled(schedule);
      schedKey = sched ? sched.sport + sched.start : '';
      if (scheduledOnly && !sched) { disconnect(); st = null; return onUpdate(null); }
      if (!await pickGame()) { disconnect(); return emit(); }
      emit();
      // Connected for the scheduled game even before its first play (the first play then shows at once), or for a
      // recent game on fbca.tv/boxscore; an old game needs no live connection.
      if (sched || (!scheduledOnly && (only || Date.now() - latestAt(st) < SHOW_MS))) connect(); else disconnect();
    };
    // Every minute: has a scheduled game come into (or gone out of) its live window? The schedule file is re-read
    // every 10 minutes in case it changed.
    let checks = 0;
    setInterval(async () => {
      if (++checks % 10 === 0) { const games = await loadSchedule(); if (games) schedule = games; }
      const next = liveScheduled(schedule), key = next ? next.sport + next.start : '';
      if (key !== schedKey) { disconnect(); fails = 0; start(); }
      else if (st) emit();
    }, 60000);
    start();
    return { stop: () => { stopped = true; clearTimeout(retry); clearInterval(poll); clearInterval(ping); if (ws) ws.close(); } };
  };

  // ---------- Drawing the box score (boxscore/box.css) ----------
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const lum = c => { const n = parseInt(String(c).slice(1), 16) || 0; return (.2126 * (n >> 16) + .7152 * (n >> 8 & 255) + .0722 * (n & 255)) / 255; };
  // A light team color (a white jersey, yellow) gets dark text and dark stripes; a dark one keeps white text.
  const paint = (node, color) => {
    node.style.setProperty('--c', color); node.style.setProperty('--dd', -(Date.now() % 5000) / 1000 + 's');
    node.classList.toggle('light', lum(color) > .55);
    return node;
  };
  // Team stats bar colors. The same rule is in boxscore/live.js, graphics/basketball-scorebug.html and graphics/soccer-scorebug.html.
  // FBCA is gold. Any other team gets the first of its main color, then its text color, that shows on the charcoal panel
  // (brightness at least 22%) and can't be mistaken for the other bar (color difference, CIE ΔE, at least 35: gold vs
  // yellow, old gold or orange is under that). If neither works: cream, or sage when cream is too close.
  const BAR = { gold: '#EAAF0F', fallbacks: ['#F3EFE2', '#B9C6B4'], minLum: .22, minGap: 35 };
  const barLum = c => { const n = parseInt(c.slice(1), 16); return (.2126 * (n >> 16) + .7152 * (n >> 8 & 255) + .0722 * (n & 255)) / 255; };
  const barLab = c => {
    const n = parseInt(c.slice(1), 16), lin = v => (v /= 255) <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4;
    const [r, g, b] = [lin(n >> 16), lin(n >> 8 & 255), lin(n & 255)], f = t => t > .008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
    const x = f((.4124 * r + .3576 * g + .1805 * b) / .95047), y = f(.2126 * r + .7152 * g + .0722 * b), z = f((.0193 * r + .1192 * g + .9505 * b) / 1.08883);
    return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
  };
  const barGap = (a, b) => { const p = barLab(a), q = barLab(b); return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]); };
  // colors: the team's [main, text] colors (the box score only has a main color); other: the bar it sits beside, if already chosen.
  const barPick = (colors, other) => [...colors.filter(c => /^#[0-9a-f]{6}$/i.test(c || '') && barLum(c) >= BAR.minLum), ...BAR.fallbacks]
    .find(c => !other || barGap(c, other) >= BAR.minGap) || BAR.fallbacks[1];
  // The box score's home side is always FBCA.
  const barsOf = g => { const home = BAR.gold; return { home, away: barPick([g.sides.away.color], home) }; };
  const pct = (m, a) => a ? Math.round(100 * m / a) + '%' : '–';
  // What each sport shows: team comparison rows [label, value, attempts (shooting), kind, lower is better] and player columns.
  // kind: true = shooting (made-attempts and a %), 'share' = a 0-1 share shown as a % (blank when unknown).
  // The team rows match the scorebugs' team stats / match stats panels (graphics/*-scorebug.html): same stats, order and
  // labels, and the same rule for which number dims (fewer is better for turnovers, fouls, offsides and cards).
  const SPORT = {
    basketball: {
      cmp: t => [['FG', t.m2 + t.m3, t.m2 + t.m3 + t.x2 + t.x3, true], ['3PT', t.m3, t.m3 + t.x3, true], ['FT', t.mft, t.mft + t.xft, true],
                 ['Rebounds', t.oreb + t.dreb], ['Off. rebounds', t.oreb], ['Assists', t.ast], ['Steals', t.stl], ['Blocks', t.blk], ['Turnovers', t.to, null, false, true],
                 ['Fouls', t.pf, null, false, true], ['Largest lead', t.lead], ['Percent led', t.ledPct, null, 'share']],
      cols: ['PTS', 'FG', '3PT', 'FT', 'REB', 'AST', 'STL', 'BLK', 'TO', 'PF'],
      row: p => [2 * p.m2 + 3 * p.m3 + p.mft, (p.m2 + p.m3) + '-' + (p.m2 + p.m3 + p.x2 + p.x3), p.m3 + '-' + (p.m3 + p.x3), p.mft + '-' + (p.mft + p.xft),
                 p.oreb + p.dreb, p.ast, p.stl, p.blk, p.to, p.pf]
    },
    soccer: {
      cmp: t => [['Shots', t.goal + t.sog + t.shot], ['Shots on goal', t.goal + t.sog], ['Corners', t.corner], ['Fouls', t.foul, null, false, true],
                 ['Offsides', t.offside, null, false, true], ['Saves', t.save], ['Yellow cards', t.yc, null, false, true], ['Red cards', t.rc, null, false, true]],
      cols: ['G', 'A', 'SH', 'SOG', 'SV', 'YC', 'RC'],
      row: p => [p.goal, p.ast, p.goal + p.sog + p.shot, p.goal + p.sog, p.save, p.yc, p.rc]
    }
  };
  // A team's logo, as the scorebug shared it through the stat keeper (meta.logos), fetched by version. Not on past
  // games: the stat keeper keeps only each side's current logo. With none, FBCA gets its eagle; another team, its initials.
  // FBCA without a shared logo gets its eagle (as the app does): "FBCA", "FBCA Varsity", "Fort Bend Christian Academy"...
  const isFBCA = name => /\bFBCA\b/i.test(name || '') || /FORT BEND CHRISTIAN/i.test(name || '');
  const FBCA_EAGLE = '/boxscore/fbca-eagle.png';
  const logoImg = (g, side, cls) => {
    const lg = !g.past && g.meta.logos && g.meta.logos[side];
    const src = lg && lg.v ? API + '/logo?game=' + g.sport + '&side=' + side + '&v=' + lg.v : isFBCA(g.sides[side] && g.sides[side].name) ? FBCA_EAGLE : '';
    return src ? Object.assign(el('img', cls), { src, alt: '' }) : null;
  };
  // "Fort Bend Christian Academy" → "FBCA", "Kinkaid" → "KINK" (as the Live Activity does)
  const abbr = name => {
    const w = String(name || '').split(/[^A-Za-z0-9]+/).filter(Boolean);
    return (w.length >= 2 ? w.slice(0, 4).map(x => x[0]).join('') : (w[0] || '').slice(0, 4)).toUpperCase();
  };
  // A small team mark: the logo, or the team's initials on its color
  const mark = (g, side, cls) => {
    const img = logoImg(g, side, 'mk ' + (cls || '')); if (img) return img;
    const d = paint(el('span', 'mk ini ' + (cls || ''), abbr(g.sides[side].name)), g.sides[side].color); return d;
  };
  const sideOf = (g, t) => t === g.sides.home ? 'home' : 'away';

  // The scoreboard card (with the LIVE title row on the home page)
  const boardCard = (g, head) => {
    const H = g.sides.home, A = g.sides.away, top = el('div', 'card head-card');
    if (head) {
      const h = el('div', 'ehead'), link = el('a', null, 'Full box score ›'); link.href = '/boxscore/';
      h.append(el('span', 'tag', 'Live'), el('span', 'what', (g.sport === 'soccer' ? 'Soccer' : 'Basketball') + ' box score'), link);
      top.append(h);
    }
    const board = el('div', 'board');
    const tm = (t, cls) => {
      const d = paint(el('div', 'tm slab ' + cls), t.color), img = logoImg(g, sideOf(g, t), 'tlogo');
      if (img) d.style.setProperty('--wm', `url("${img.src}")`); // the same logo, large and faint behind, by the score
      d.append(...(img ? [img] : []), el('span', null, t.name));
      return d;
    };
    const mid = el('div', 'mid'), clk = el('div', 'clk', '–'), per = el('div', 'per', PERIOD[g.meta.period] || g.meta.period || '');
    mid.append(clk, per);
    // Away on the left, home on the right, as on TV. FBCA is the stat keeper's home team, so it's on the right.
    // The score, with that team's timeouts left under it as dots (lit for each one left), as on the scorebug.
    const sc = side => {
      const d = el('div', 'sc'); d.append(el('span', 'n', g.sides[side].score));
      const t = timeoutsLeft(g);
      if (t) {
        const left = t[side] || 0, dots = el('div', 'tos');
        dots.title = left + (left === 1 ? ' timeout' : ' timeouts') + ' left';
        dots.setAttribute('aria-label', dots.title);
        for (let i = 0; i < Math.max(t.max || 0, left); i++) dots.append(el('i', i < left ? 'on' : null));
        d.append(dots);
      }
      return d;
    };
    board.append(tm(A, 'L'), sc('away'), mid, sc('home'), tm(H, 'R'));
    top.append(board);
    return top;
  };

  // Team stats, the classic way (the home page): values on the outside, one split bar per stat
  const cmpCard = g => {
    const S = SPORT[g.sport], H = g.sides.home, A = g.sides.away;
    const cmp = el('div', 'card cmp'), rowsH = S.cmp(H.tot), bars = barsOf(g);
    S.cmp(A.tot).forEach(([label, av, aa, isPct, lowGood], i) => {
      const [, hv, ha] = rowsH[i];
      const r = el('div', 'row'), mid2 = el('div'), bar = el('div', 'bar2'), lf = el('i'), rf = el('i');
      const shoot = isPct === true, share = isPct === 'share';
      const val = (v, a, cls) => {
        const d = el('div', 'v ' + cls);
        d.append(shoot ? v + '-' + a : share ? (v == null ? '–' : Math.round(100 * v) + '%') : String(v));
        if (shoot) d.append(el('small', null, pct(v, a)));
        return d;
      };
      const hs = shoot ? (ha ? hv / ha : 0) : hv || 0, as = shoot ? (aa ? av / aa : 0) : av || 0, tot = hs + as;
      // Away's share fills from the left, home (FBCA gold) the rest from the right; nothing yet on either side shows an even, dimmed split.
      lf.style.cssText = `width:${tot ? 100 * as / tot : 50}%;background:${bars.away}`; rf.style.background = bars.home;
      if (!tot) bar.classList.add('none');
      bar.append(lf, rf); mid2.append(el('div', 'lbl', label), bar);
      const av2 = val(av, aa, 'L'), hv2 = val(hv, ha, 'R'), better = lowGood ? (a, b) => a < b : (a, b) => a > b;
      if (better(as, hs)) hv2.classList.add('lo'); if (better(hs, as)) av2.classList.add('lo');
      r.append(av2, mid2, hv2); cmp.append(r);
    });
    return cmp;
  };

  // Each team's player table: STARTERS and BENCH with minutes when the stat page set starters
  const playerTables = g => {
    const S = SPORT[g.sport], H = g.sides.home, A = g.sides.away;
    const table = t => {
      const card = el('div', 'card'), th = paint(el('div', 'team-h slab'), t.color);
      const lg = logoImg(g, sideOf(g, t), 'tlogo');
      th.append(...(lg ? [lg] : []), el('span', null, t.name), el('small', null, t.score));
      card.append(th);
      if (!t.players.length) { card.append(el('div', 'none', 'No roster entered for this team yet.')); return card; }
      const starters = t.starters || [], split = starters.length > 0, cols = split ? ['MIN', ...S.cols] : S.cols;
      const tbl = el('table');
      const header = (label, cls) => { const hr = el('tr', cls); hr.append(el('th', null, label), ...cols.map(c => el('th', null, c))); tbl.append(hr); };
      const line = p => {
        const tr = el('tr'), name = el('td');
        if (p.num) name.append(el('b', null, '#' + p.num));
        name.append(p.name);
        const vals = S.row(p), first = split ? 1 : 0;
        if (split) vals.unshift(minText(p.sec));
        tr.append(name, ...vals.map((v, i) => el('td', (i === first ? 'pts' : '') + (v === 0 || v === '0-0' || v === '0' ? ' zero' : ''), v)));
        tbl.append(tr);
      };
      if (split) {
        const byId = new Map(t.players.map(p => [p.id, p]));
        header('Starters'); starters.forEach(id => line(byId.get(id)));
        const bench = t.players.filter(p => !starters.includes(p.id));
        if (bench.length) { header('Bench', 'sub-h'); bench.forEach(line); }
      } else { header('Player'); t.players.forEach(line); }
      const tot = el('tr', 'tot'); tot.append(el('td', null, 'Team'), ...(split ? [el('td', null, '')] : []), ...S.row(t.tot).map(v => el('td', null, v)));
      tbl.append(tot);
      const sc = el('div', 'scroll'); sc.append(tbl); card.append(sc);
      return card;
    };
    const grid = el('div', 'grid2');
    grid.append(table(A), table(H)); // away, then home (FBCA), as across the top
    return grid;
  };

  // ---------- Basketball's tabs: Gamecast, Box Score, Play-by-Play, Team Stats ----------
  const nameOnly = (g, side, id) => {
    if (id === 'team' || !id) return g.sides[side].name;
    const p = ((g.meta.rosters && g.meta.rosters[side]) || []).find(x => x.id === id);
    return p ? p.name || '#' + p.num : g.sides[side].name;
  };
  // "Jordan Lee" → "J. Lee"
  const shortName = p => { const w = String(p.name || '').trim().split(/\s+/); return w.length > 1 ? w[0][0] + '. ' + w.slice(1).join(' ') : p.name || '#' + p.num; };
  const PERIOD_ORD = { '1Q': '1st', '2Q': '2nd', '3Q': '3rd', '4Q': '4th', OT: 'OT', OT2: '2OT', OT3: '3OT' };
  const TITLE = { m2: '+2 Points', m3: '+3 Points', mft: '+1 Point', x2: 'Missed 2PT', x3: 'Missed 3PT', xft: 'Missed FT', oreb: 'Offensive Rebound',
                  dreb: 'Defensive Rebound', ast: 'Assist', stl: 'Steal', blk: 'Block', to: 'Turnover', pf: 'Foul', timeout: 'Timeout', in: 'Substitution', out: 'Substitution' };
  const DESC = { m2: 'makes a 2-pointer', m3: 'makes a 3-pointer', mft: 'makes a free throw', x2: 'misses a 2-pointer', x3: 'misses a 3-pointer',
                 xft: 'misses a free throw', oreb: 'offensive rebound', dreb: 'defensive rebound', ast: 'assist', stl: 'steal', blk: 'block', to: 'turnover' };
  const describe = (g, it) => {
    const e = it.e, who = nameOnly(g, e.side, e.player), team = g.sides[e.side].name;
    if (e.type === 'timeout') return team + ' timeout' + (e.note ? ' (' + e.note + ')' : '');
    if (e.type === 'pf') return 'Foul on ' + who;
    if (it.sub) return nameOnly(g, e.side, e.player) + ' in for ' + nameOnly(g, e.side, it.sub.player);
    if (e.type === 'in') return who + ' checks in for ' + team;
    if (e.type === 'out') return who + ' checks out for ' + team;
    return who + ' ' + (DESC[e.type] || e.type) + (it.ast ? ' (' + nameOnly(g, e.side, it.ast.player) + ' assists)' : '');
  };
  const winText = (g, p) => { const home = p >= .5; return 'Win %: ' + abbr(g.sides[home ? 'home' : 'away'].name) + ', ' + (100 * (home ? p : 1 - p)).toFixed(1); };
  // One play: the team's mark, then a solid bar (a basket) or dots (anything else) in its color; the title, the
  // time, what happened, and the score after it on the right (the scoring team's number bright).
  const playItem = (g, F, bars, it) => {
    const e = it.e, side = e.side, scoring = !!PTS_OF[e.type], row = el('div', 'pp' + (scoring ? ' score' : ''));
    row.style.setProperty('--tc', bars[side]);
    const rail = el('div', 'rail'); rail.append(mark(g, side), el('i', scoring ? 'bar' : 'dots')); row.append(rail);
    const body = el('div', 'pb'), top = el('div', 'pt');
    top.append(el('b', null, TITLE[e.type] || e.type));
    const sc = F.scoreAfter.get(e.id) || { home: 0, away: 0 }, nums = el('span', 'ps');
    const an = el('span', null, sc.away), hn = el('span', null, sc.home);
    if (scoring) (side === 'home' ? an : hn).classList.add('dim'); else { an.classList.add('dim'); hn.classList.add('dim'); }
    nums.append(an, hn); top.append(nums);
    const when = el('div', 'pw', [e.min, PERIOD_ORD[e.period] || e.period].filter(Boolean).join(' - '));
    body.append(top, when, el('div', 'pd', describe(g, it)));
    if (scoring) body.append(el('div', 'pd wp', winText(g, F.wpAfter.get(e.id))));
    row.append(body);
    return row;
  };
  const section = (title, ...kids) => { const s = el('section', 'card gc'); s.append(el('h2', 'gh', title), ...kids); return s; };

  // ---------- Soccer play-by-play: every play, newest first, under its half ----------
  const S_TITLE = { goal: 'Goal', ast: 'Assist', sog: 'Shot on Target', shot: 'Shot off Target', save: 'Save', corner: 'Corner Kick', foul: 'Foul',
                    offside: 'Offside', yc: 'Yellow Card', rc: 'Red Card', og: 'Own Goal', throw: 'Throw-in', fk: 'Free Kick', hand: 'Handball',
                    pkm: 'Missed Penalty Kick' };
  // The plays, oldest first: a goal carries its assist (that team's next play, recorded within a minute), and each
  // goal (an own goal for the other team) the score after it.
  const soccerPlays = g => {
    const evs = (g.events || []).filter(e => g.sides[e.side] && S_TITLE[e.type]), out = [], used = new Set(), score = { home: 0, away: 0 };
    evs.forEach((e, i) => {
      if (used.has(e.id)) return;
      const it = { e, side: e.side };
      if (e.type === 'goal' && e.note !== 'PK') {
        const n = evs.slice(i + 1).find(x => x.side === e.side);
        if (n && n.type === 'ast' && Math.abs((n.at || 0) - (e.at || 0)) < 60000) { it.ast = n; used.add(n.id); }
      }
      if (e.type === 'og') it.side = e.side === 'home' ? 'away' : 'home';   // shown for the team it counted for
      if (e.type === 'goal' || e.type === 'og') { score[it.side]++; it.goal = true; }
      it.score = { ...score };
      out.push(it);
    });
    // A play without a minute (recorded before every play got one): estimated from the nearest timed play in the same
    // half, by when each was entered. The minute runs 1, 2, ..., then 40+1 in stoppage.
    const timed = (g.events || []).filter(e => /^\d+(\+\d+)?$/.test(e.min || '') && e.at);
    const val = m => m.split('+').reduce((a, b) => a + +b, 0);
    const half = g.meta.halfMin || 40, ot = g.meta.otMin || 10;
    for (const it of out) {
      const e = it.e; if (e.min || !e.at) continue;
      const near = timed.filter(x => x.period === e.period).sort((a, b) => Math.abs(a.at - e.at) - Math.abs(b.at - e.at))[0];
      if (!near) continue;
      const start = { '1H': 0, '2H': half, OT1: 2 * half, OT2: 2 * half + ot }[e.period] || 0, end = start + (/^OT/.test(e.period) ? ot : half);
      const est = Math.max(start + 1, val(near.min) + Math.round((e.at - near.at) / 60000));
      it.min = String(est > end ? end + '+' + (est - end) : est);
    }
    return out;
  };
  const soccerDescribe = (g, it) => {
    const e = it.e, who = nameOnly(g, e.side, e.player), team = g.sides[e.side].name, mine = e.player && e.player !== 'team';
    switch (e.type) {
      case 'goal': return e.note === 'PK' ? who + ' scores from the penalty spot' : who + ' scores' + (it.ast ? ' (assist: ' + nameOnly(g, e.side, it.ast.player) + ')' : '');
      case 'og': return 'Own goal by ' + (mine ? who + ' (' + team + ')' : team);
      case 'ast': return 'Assist by ' + who;
      case 'sog': return 'Shot on target by ' + who;
      case 'shot': return 'Shot off target by ' + who;
      case 'save': return 'Save by ' + who;
      case 'corner': return mine ? 'Corner kick by ' + who : 'Corner kick for ' + team;
      case 'foul': return 'Foul on ' + who;
      case 'offside': return who + ' offside';
      case 'yc': return 'Yellow card for ' + who;
      case 'rc': return 'Red card for ' + who;
      case 'throw': return 'Throw-in for ' + team;
      case 'fk': return 'Free kick for ' + team;
      case 'hand': return 'Handball on ' + who;
      case 'pkm': return who + ' misses a penalty kick';
    }
    return who;
  };
  // One play, drawn like basketball's: the team's mark and a bar (a goal) or dots in its color, the title, the
  // score after a goal (the scoring team's number bright), the minute and half, and what happened.
  const soccerPlayItem = (g, bars, it) => {
    const e = it.e, side = it.side, row = el('div', 'pp' + (it.goal ? ' score' : ''));
    row.style.setProperty('--tc', bars[side]);
    const rail = el('div', 'rail'); rail.append(mark(g, side), el('i', it.goal ? 'bar' : 'dots')); row.append(rail);
    const body = el('div', 'pb'), top = el('div', 'pt');
    top.append(el('b', null, e.type === 'goal' && e.note === 'PK' ? 'Penalty Kick Goal' : S_TITLE[e.type]));
    if (it.goal) {
      const nums = el('span', 'ps'), an = el('span', null, it.score.away), hn = el('span', null, it.score.home);
      (side === 'home' ? an : hn).classList.add('dim');
      nums.append(an, hn); top.append(nums);
    }
    const min = e.min || it.min;
    body.append(top, el('div', 'pw', [min ? min + "'" : '', PERIOD[e.period] || e.period].filter(Boolean).join(' - ')), el('div', 'pd', soccerDescribe(g, it)));
    row.append(body);
    return row;
  };
  const soccerPlayCard = g => {
    const plays = soccerPlays(g); if (!plays.length) return null;
    const bars = barsOf(g), card = el('section', 'card gc'); let per = null;
    for (const it of plays.reverse()) {
      if (it.e.period !== per) { per = it.e.period; card.append(el('h2', 'gh', PERIOD[per] || per)); }
      card.append(soccerPlayItem(g, bars, it));
    }
    return card;
  };
  const moreLink = (text, go) => { const b = el('button', 'more', text); b.type = 'button'; b.onclick = go; return b; };

  // Scores by quarter, away above home
  const quarterTable = (g, F) => {
    const tbl = el('table', 'qt'), hr = el('tr'), n = F.quarters.length;
    hr.append(el('th'), ...F.quarters.map((x, i) => el('th', null, i < 4 ? String(i + 1) : i === 4 ? 'OT' : (i - 3) + 'OT')), el('th', null, 'T'));
    tbl.append(hr);
    for (const side of ['away', 'home']) {
      const tr = el('tr'), nm = el('td'), qn = el('div', 'qn'); qn.append(mark(g, side), el('span', null, g.sides[side].name)); nm.append(qn);
      tr.append(nm, ...F.quarters.map((x, i) => el('td', i > F.curPer ? 'zero' : null, i > F.curPer ? '–' : x[side])), el('td', 'tot', g.sides[side].score));
      tbl.append(tr);
    }
    const w = el('div', 'scroll'); w.append(tbl); return w;
  };
  // A player's line for On the Court
  const courtTable = (g, side, list) => {
    const wrap = el('div', 'court'), head = el('div', 'ch'); head.append(mark(g, side, 'big'), el('b', null, g.sides[side].name)); wrap.append(head);
    if (!list) { wrap.append(el('p', 'note', 'Shows once the stat crew sets the starting five.')); return wrap; }
    const tbl = el('table', 'ct'), hr = el('tr'); hr.append(...['Player', 'PTS', 'FG', 'REB', 'AST', 'PF'].map(c => el('th', null, c))); tbl.append(hr);
    for (const p of list) {
      const tr = el('tr'), nm = el('td'); nm.append(el('b', null, shortName(p)), el('small', null, p.num ? '#' + p.num : ''));
      tr.append(nm, el('td', 'pts', 2 * p.m2 + 3 * p.m3 + p.mft), el('td', null, (p.m2 + p.m3) + '-' + (p.m2 + p.m3 + p.x2 + p.x3)), el('td', null, p.oreb + p.dreb), el('td', null, p.ast), el('td', null, p.pf));
      tbl.append(tr);
    }
    wrap.append(tbl); return wrap;
  };
  // Game leaders: each team's best in points, rebounds and assists, with a stat line (no photos: a number badge)
  const leaders = (g, bars) => {
    const box = el('div', 'gl'), head = el('div', 'glh');
    const tag = side => { const d = el('div', 'gls ' + side); d.append(mark(g, side, 'big'), el('b', null, abbr(g.sides[side].name))); return d; };
    head.append(tag('away'), tag('home')); box.append(head);
    const cats = [
      ['Points', p => 2 * p.m2 + 3 * p.m3 + p.mft, p => `${p.m2 + p.m3}/${p.m2 + p.m3 + p.x2 + p.x3} FG, ${p.mft}/${p.mft + p.xft} FT`],
      ['Rebounds', p => p.oreb + p.dreb, p => `${p.dreb} DREB, ${p.oreb} OREB`],
      ['Assists', p => p.ast, p => `${p.to} TO` + (p.sec != null ? `, ${Math.round(p.sec / 60)} MIN` : '')]];
    for (const [label, val, line] of cats) {
      const row = el('div', 'glr');
      const cell = side => {
        const t = g.sides[side], best = [...t.players].sort((a, b) => val(b) - val(a))[0], d = el('div', 'glc ' + side);
        if (!best || !val(best)) { d.append(el('div', 'glv', '–')); return d; }
        const badge = el('span', 'badge', best.num ? '#' + best.num : abbr(t.name)); badge.style.setProperty('--tc', bars[side]);
        const v = el('div', 'glv'); v.append(badge, el('b', null, val(best)));
        const nm = el('div', 'gln'); nm.append(el('b', null, shortName(best)), el('small', null, best.num ? ' #' + best.num : ''));
        d.append(v, nm, el('div', 'gll', line(best)));
        return d;
      };
      row.append(cell('away'), el('div', 'glk', label), cell('home'));
      box.append(row);
    }
    return box;
  };

  // The charts: win probability (one line, the leader's side of the middle) and game flow (each team's score)
  const SVGNS = 'http://www.w3.org/2000/svg';
  const sv = (tag, attrs) => { const n = document.createElementNS(SVGNS, tag); for (const k in attrs) n.setAttribute(k, attrs[k]); return n; };
  const chartFrame = (F, W, Hh, yTicks) => {
    const svg = sv('svg', { viewBox: `0 0 ${W + 44} ${Hh + 26}`, class: 'chart', role: 'img' });
    const X = t => W * Math.min(1, t / F.endT), g = sv('g', {});
    // Quarter lines and labels
    const qs = Math.max(4, F.curPer + 1);
    for (let i = 0; i <= qs; i++) {
      const t = i === 0 ? 0 : F.clock.end(LEAD_PERIODS[i - 1]); if (t == null || t > F.endT + 1) continue;
      g.append(sv('line', { x1: X(t), x2: X(t), y1: 0, y2: Hh, class: 'grid' }));
      if (i < qs) { const t2 = F.clock.end(LEAD_PERIODS[i]); if (t2 != null) { const lb = sv('text', { x: (X(t) + X(Math.min(t2, F.endT))) / 2, y: Hh + 18, class: 'xl' }); lb.textContent = PERIOD_ORD[LEAD_PERIODS[i]]; g.append(lb); } }
    }
    for (const [y, label] of yTicks) {
      g.append(sv('line', { x1: 0, x2: W, y1: y, y2: y, class: 'grid' }));
      const tx = sv('text', { x: W + 8, y: y + 5, class: 'yl' }); tx.textContent = label; g.append(tx);
    }
    svg.append(g);
    return { svg, X };
  };
  const winChart = (g, F, bars) => {
    const W = 560, Hh = 220, { svg, X } = chartFrame(F, W, Hh, [[0, '100'], [Hh / 4, ''], [Hh / 2, '50'], [3 * Hh / 4, ''], [Hh, '100']]);
    // Away at the top, home at the bottom: the line sits toward whoever's ahead.
    const Y = p => Hh * p;
    const pts = F.series.map(s => [X(s.t), Y(s.p)]);
    const d = 'M' + pts[0][0] + ',' + pts[0][1] + pts.slice(1).map(([x, y]) => `H${x.toFixed(1)}V${y.toFixed(1)}`).join('');
    const last = pts[pts.length - 1];
    svg.append(sv('path', { d: d + `H${last[0]}V${Hh / 2}H0Z`, class: 'area' }), sv('path', { d, class: 'line', stroke: '#fff' }));
    const pct = {}, wrap = el('div', 'wpc'), row = side => {
      const r = el('div', 'wpr'), k = el('i', 'key'); k.style.background = bars[side];
      const nm = el('span', 'wpn'); nm.append(mark(g, side, 'big'), el('span', null, abbr(g.sides[side].name)), k);
      pct[side] = el('b'); r.append(nm, pct[side]); return r;
    };
    // The percentages: at the picked moment, or now
    const setPct = s => { const p = s ? s.p : F.pNow; pct.home.textContent = (100 * p).toFixed(1) + '%'; pct.away.textContent = (100 * (1 - p)).toFixed(1) + '%'; };
    wrap.append(row('away'), svg, row('home'), scrub(g, F, svg, X, Hh, s => [[Y(s.p), '#fff']], 'score', setPct));
    return wrap;
  };
  const flowChart = (g, F, bars) => {
    const top = Math.max(25, Math.ceil(Math.max(g.sides.home.score, g.sides.away.score, 1) / 25) * 25), W = 560, Hh = 220;
    const ticks = []; for (let v = 0; v <= top; v += 25) ticks.push([Hh - Hh * v / top, String(v)]);
    const { svg, X } = chartFrame(F, W, Hh, ticks), Y = v => Hh - Hh * v / top;
    for (const side of ['away', 'home']) {
      const d = 'M0,' + Hh + F.series.slice(1).map(s => `H${X(s.t).toFixed(1)}V${Y(s[side === 'home' ? 'h' : 'a']).toFixed(1)}`).join('');
      svg.append(sv('path', { d, class: 'line' + (side === 'away' ? ' dash' : ''), stroke: bars[side] }));
    }
    const wrap = el('div', 'gfc'), head = el('div', 'gfh'), score = {};
    const team = side => { const d = el('div', 'gft ' + side), k = el('i', 'key' + (side === 'away' ? ' dash' : '')); k.style.color = bars[side];
      const t = el('div'); score[side] = el('b', null, g.sides[side].score); t.append(score[side]); const n = el('small'); n.append(...(side === 'away' ? [k, ' ' + abbr(g.sides[side].name)] : [abbr(g.sides[side].name) + ' ', k])); t.append(n);
      d.append(...(side === 'away' ? [mark(g, side, 'big'), t] : [t, mark(g, side, 'big')])); return d; };
    const mid = el('div', 'gfm'); mid.append(el('b', null, F.changes), el('small', null, F.changes === 1 ? 'Lead change' : 'Lead changes'));
    head.append(team('away'), mid, team('home'));
    // The scores: at the picked moment, or now
    const setScore = s => { score.away.textContent = s ? s.a : g.sides.away.score; score.home.textContent = s ? s.h : g.sides.home.score; };
    wrap.append(head, svg, scrub(g, F, svg, X, Hh, s => [[Y(s.a), bars.away], [Y(s.h), bars.home]], 'win', setScore));
    return wrap;
  };
  // Tap, drag or hover on a chart: a line and dots at the nearest basket, that play in the card below it (the score then
  // on the win probability chart; the win chance then on game flow), and the numbers above the chart as they were then
  // (onPick). Moving off the chart or lifting a finger goes back to now: the numbers as they are, the latest basket.
  const scrub = (g, F, svg, X, Hh, dotsFor, side, onPick) => {
    const pts = F.series.filter(s => s.id), card = el('div', 'pcard');
    onPick(null);
    if (!pts.length) { card.append(el('p', 'note', 'No baskets yet.')); return card; }
    const items = new Map(playList(g).map(it => [it.e.id, it]));
    const over = sv('g', { class: 'scrub' }), vline = sv('line', { y1: 0, y2: Hh, class: 'vline' }); over.append(vline); svg.append(over);
    let dots = [];
    const show = s => {
      F.pick.id = s.id;
      const x = X(s.t); vline.setAttribute('x1', x); vline.setAttribute('x2', x);
      dots.forEach(d => d.remove());
      dots = dotsFor(s).map(([y, c]) => { const d = sv('circle', { cx: x, cy: y, r: 6, class: 'dot', fill: c }); over.append(d); return d; });
      const it = items.get(s.id) || { e: (g.events || []).find(e => e.id === s.id) }, e = it.e; if (!e) return;
      const left = el('div', 'pcl'), right = el('div', 'pcr');
      left.append(el('b', null, TITLE[e.type] || e.type), el('div', 'pw', [e.min, PERIOD_ORD[e.period] || e.period].filter(Boolean).join(' - ')), el('div', 'pd', describe(g, it)));
      if (side === 'score') for (const sd of ['away', 'home']) { const c = el('div', 'pcs'); c.append(el('b', null, sd === 'home' ? s.h : s.a), el('small', null, abbr(g.sides[sd].name))); right.append(c); }
      else { const home = s.p >= .5, c = el('div', 'pcs'); c.append(el('b', null, abbr(g.sides[home ? 'home' : 'away'].name) + ' ' + (100 * (home ? s.p : 1 - s.p)).toFixed(1) + '%'), el('small', null, 'Win %')); right.append(c); }
      card.replaceChildren(left, right);
    };
    const nearest = ev => {
      const r = svg.getBoundingClientRect(), vb = svg.viewBox.baseVal, x = (ev.clientX - r.left) / r.width * vb.width;
      return pts.reduce((b, s) => Math.abs(X(s.t) - x) < Math.abs(X(b.t) - x) ? s : b, pts[0]);
    };
    const pick = ev => { const s = nearest(ev); show(s); onPick(s); };
    const now = () => { F.pick.id = null; show(pts[pts.length - 1]); F.pick.id = null; onPick(null); };
    svg.addEventListener('pointermove', pick);
    svg.addEventListener('pointerdown', pick);
    for (const t of ['pointerleave', 'pointercancel']) svg.addEventListener(t, now);
    svg.addEventListener('pointerup', ev => { if (ev.pointerType !== 'mouse') now(); });
    // A pick still under the mouse survives the game updating; otherwise the latest basket
    const kept = pts.find(s => s.id === F.pick.id);
    if (kept) { show(kept); onPick(kept); } else now();
    return card;
  };

  // Team stats the Gamecast way: shooting as each team's own bar from the outside in (the middle is 100%); counts as
  // one bar split by share.
  const STAT_ROWS = t => [
    ['Field Goal %', t.m2 + t.m3, t.m2 + t.m3 + t.x2 + t.x3, 'pct'], ['Three Point %', t.m3, t.m3 + t.x3, 'pct'], ['Free Throw %', t.mft, t.mft + t.xft, 'pct'],
    ['Rebounds', t.oreb + t.dreb], ['Assists', t.ast], ['Steals', t.stl], ['Blocks', t.blk], ['Turnovers', t.to], ['Fouls', t.pf],
    ['Largest Lead', t.lead], ['Percent Led', t.ledPct == null ? null : Math.round(100 * t.ledPct), null, 'share']];
  const statBars = (g, bars, only) => {
    const box = el('div', 'tsb'), head = el('div', 'tsh'), A = STAT_ROWS(g.sides.away.tot), H = STAT_ROWS(g.sides.home.tot);
    const key = side => { const d = el('div', 'tsk ' + side), k = el('i'); k.style.background = bars[side];
      d.append(...(side === 'away' ? [mark(g, side, 'big'), k, el('span', null, abbr(g.sides[side].name))] : [el('span', null, abbr(g.sides[side].name)), k, mark(g, side, 'big')])); return d; };
    head.append(key('away'), key('home')); box.append(head);
    A.forEach(([label, av, aa, kind], i) => {
      if (only && !only.includes(label)) return;
      const [, hv, ha] = H[i], r = el('div', 'tsr'), top = el('div', 'tst');
      const num = (v, a, side) => {
        const d = el('div', 'tsv ' + side);
        if (kind === 'pct') { const big = el('b', null, a ? Math.round(100 * v / a) + '%' : '–'), sm = el('small', null, `(${v}-${a})`); d.append(...(side === 'away' ? [big, ' ', sm] : [sm, ' ', big])); }
        else d.append(el('b', null, v == null ? '–' : v + (kind === 'share' ? '%' : '')));
        return d;
      };
      top.append(num(av, aa, 'away'), el('div', 'tsl', label), num(hv, ha, 'home'));
      const bar = el('div', 'tbar' + (kind === 'pct' ? ' two' : ''));
      if (kind === 'pct') {
        // Two tracks, each from its team's edge toward the middle: a full track is 100%
        for (const [side, v, a] of [['away', av, aa], ['home', hv, ha]]) {
          const tr = el('span', 'trk ' + side), f = el('i'); f.style.cssText = `width:${a ? 100 * v / a : 0}%;background:${bars[side]}`; tr.append(f); bar.append(tr);
        }
      } else {
        const x = +av || 0, y = +hv || 0, tot = x + y, l = el('i'), rr = el('i');
        l.style.cssText = `width:${tot ? 100 * x / tot : 50}%;background:${bars.away}`; rr.style.background = bars.home;
        if (!tot) bar.classList.add('none'); else if (x && y) bar.classList.add('split'); // the dividing line only when both have some
        bar.append(l, rr);
      }
      r.append(top, bar); box.append(r);
    });
    return box;
  };
  // Team Stats tab: every number, side by side
  const statTable = g => {
    const tbl = el('table', 'tst2'), hr = el('tr'), A = g.sides.away.tot, H = g.sides.home.tot;
    const hd = side => { const th = el('th'); th.append(mark(g, side)); return th; };
    hr.append(el('th'), hd('away'), hd('home')); tbl.append(hr);
    const P = (m, a) => a ? String(Math.round(100 * m / a)) : '–';
    const rows = [
      ['FG', t => `${t.m2 + t.m3}-${t.m2 + t.m3 + t.x2 + t.x3}`], ['Field Goal %', t => P(t.m2 + t.m3, t.m2 + t.m3 + t.x2 + t.x3)],
      ['3PT', t => `${t.m3}-${t.m3 + t.x3}`], ['Three Point %', t => P(t.m3, t.m3 + t.x3)], ['FT', t => `${t.mft}-${t.mft + t.xft}`], ['Free Throw %', t => P(t.mft, t.mft + t.xft)],
      ['Rebounds', t => t.oreb + t.dreb], ['Offensive Rebounds', t => t.oreb, 1], ['Defensive Rebounds', t => t.dreb, 1], ['Assists', t => t.ast], ['Steals', t => t.stl],
      ['Blocks', t => t.blk], ['Turnovers', t => t.to], ['Fouls', t => t.pf], ['Largest Lead', t => t.lead], ['Percent Led', t => t.ledPct == null ? '–' : Math.round(100 * t.ledPct)]];
    for (const [label, f, sub] of rows) { const tr = el('tr', sub ? 'sub' : null); tr.append(el('td', null, label), el('td', null, f(A)), el('td', null, f(H))); tbl.append(tr); }
    return tbl;
  };
  // Game information from the schedule
  const ICON = {
    cal: '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="5" width="18" height="16" rx="1.5"/><path d="M3 10h18M8 3v4M16 3v4"/><path d="M7 14h2M11 14h2M15 14h2M7 17.5h2M11 17.5h2"/></svg>',
    pin: '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>' };
  const gameInfo = g => {
    const i = g.info; if (!i) return null;
    const box = el('div', 'gi'), line = (icon, ...kids) => { const r = el('div', 'gir'), ic = el('span', 'gii'); ic.innerHTML = ICON[icon]; const t = el('div'); t.append(...kids); r.append(ic, t); return r; };
    const d = new Date(i.start);
    box.append(line('cal', el('b', null, d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) + ', ' + d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }))));
    if (i.location) box.append(line('pin', el('b', null, i.location), el('small', null, (i.homeAway === 'away' ? 'FBCA at ' : 'FBCA vs ') + i.opponent)));
    if (i.notes) box.append(line('cal', el('small', null, i.notes)));
    return box;
  };

  const TABS = [['gamecast', 'Gamecast'], ['box', 'Box Score'], ['pbp', 'Play-by-Play'], ['team', 'Team Stats']];
  const renderTabs = (root, g) => {
    const F = flow(g), bars = barsOf(g), plays = playList(g), newest = [...plays].reverse();
    F.pick = root._pick = root._pick || { id: null };
    const want = (location.hash || '').slice(1), tab = root._tab || (TABS.some(t => t[0] === want) ? want : 'gamecast');
    root._tab = tab;
    const top = boardCard(g, false), bar = el('nav', 'tabs');
    const panes = {};
    const go = name => {
      root._tab = name;
      bar.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.t === name));
      for (const [k, p] of Object.entries(panes)) p.hidden = k !== name;
      try { history.replaceState(null, '', '#' + name); } catch (e) { /* file: pages */ }
    };
    for (const [k, label] of TABS) { const b = el('button', k === tab ? 'on' : null, label); b.type = 'button'; b.dataset.t = k; b.onclick = () => { go(k); window.scrollTo({ top: Math.min(window.scrollY, root.offsetTop), behavior: 'smooth' }); }; bar.append(b); }
    top.append(bar);

    // Gamecast
    const gc = el('div', 'pane');
    if (plays.length) {
      const list = el('div', 'plays'); newest.slice(0, 5).forEach(it => list.append(playItem(g, F, bars, it)));
      gc.append(section('Recent Plays', list, moreLink('Full Play-by-Play', () => go('pbp'))));
    } else gc.append(section('Recent Plays', el('p', 'note', 'No plays recorded yet.')));
    gc.append(section('Scoring', quarterTable(g, F)));
    const court = el('div'); court.append(courtTable(g, 'away', F.floor.away), courtTable(g, 'home', F.floor.home));
    gc.append(section('On the Court', court, moreLink('Full Box Score', () => go('box'))));
    gc.append(section('Game Leaders', leaders(g, bars), moreLink('Full Box Score', () => go('box'))));
    const which = root._chart || 'wp', seg = el('div', 'seg'), chartBox = el('div');
    const drawChart = k => { root._chart = k; seg.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.c === k)); chartBox.replaceChildren(k === 'wp' ? winChart(g, F, bars) : flowChart(g, F, bars)); };
    for (const [k, label] of [['wp', 'Win Probability'], ['flow', 'Game Flow']]) { const b = el('button', null, label); b.type = 'button'; b.dataset.c = k; b.onclick = () => drawChart(k); seg.append(b); }
    drawChart(which);
    gc.append(section('Probabilities & Game Flow', seg, chartBox, el('p', 'fine', 'According to EOTA Analytics')));
    gc.append(section('Team Stats', statBars(g, bars, ['Field Goal %', 'Three Point %', 'Free Throw %', 'Turnovers', 'Rebounds', 'Percent Led', 'Largest Lead']), moreLink('Full Team Stats', () => go('team'))));
    const info = gameInfo(g); if (info) gc.append(section('Game Information', info));
    panes.gamecast = gc;

    // Box Score
    const bx = el('div', 'pane print'); bx.append(playerTables(g)); panes.box = bx;

    // Play-by-Play: every play, newest first, under its quarter
    const pb = el('div', 'pane');
    if (plays.length) {
      const card = el('section', 'card gc'); let per = null;
      for (const it of newest) {
        if (it.e.period !== per) { per = it.e.period; card.append(el('h2', 'gh', PERIOD[per] || per)); }
        card.append(playItem(g, F, bars, it));
      }
      pb.append(card);
    } else pb.append(el('p', 'note', 'No plays recorded yet.'));
    panes.pbp = pb;

    // Team Stats
    const ts = el('div', 'pane print');
    ts.append(section('Team Stats', statBars(g, bars)), section('By the Numbers', statTable(g)));
    panes.team = ts;

    for (const [k, p] of Object.entries(panes)) p.hidden = k !== tab;
    root.replaceChildren(top, ...Object.values(panes));
    root._fitW = 0; tickBox(root, g);
    if (document.fonts) document.fonts.ready.then(() => fitNames(root));
    root.querySelectorAll('.board .tlogo').forEach(img => { if (!img.complete) img.addEventListener('load', () => fitNames(root), { once: true }); });
  };

  // renderBox(root, game, { head, collapseTeamStats, tabs }): draws the whole box score into root (a .ebx element).
  //   head: a title row with the LIVE tag and a link to fbca.tv/boxscore (the home page).
  //   collapseTeamStats: team stats behind a toggle (closed at first; stays as the viewer left it).
  //   tabs: basketball on fbca.tv/boxscore: Gamecast, Box Score, Play-by-Play and Team Stats tabs.
  const renderBox = (root, g, { head = false, collapseTeamStats = false, tabs = false } = {}) => {
    if (tabs && g.sport === 'basketball') return renderTabs(root, g);
    const parts = [boardCard(g, head)];
    // Latest play (it flashes when a new one arrives)
    const lp = latestText(g);
    if (lp) {
      const play = el('div', 'card play' + (lp.big ? ' big' : '')), txt = el('div', 'txt');
      txt.append(el('small', null, [lp.when, lp.team].filter(Boolean).join(' · ')));
      const line = el('span'); line.append(el('b', null, lp.who), ' · ', el('span', 'verb', lp.what)); txt.append(line);
      play.append(el('span', 'ptag', 'Latest'), txt);
      if (root._lastPlay && g.latest.id !== root._lastPlay) play.classList.add('flash');
      root._lastPlay = g.latest.id;
      parts.push(play);
    } else parts.push(el('p', 'note', 'No plays recorded yet.'));
    // Team stats. Away's numbers on the left, home's (FBCA) on the right, like the scoreboard above.
    const cmp = cmpCard(g);
    if (collapseTeamStats) {
      const d = el('details', 'sect'), sum = el('summary', null, 'Team stats');
      const prev = root.querySelector('details.sect'); d.open = prev ? prev.open : false;
      d.append(sum, cmp); parts.push(d);
    } else { const s = el('section'); s.append(el('h2', 'h', 'Team stats'), cmp); parts.push(s); }
    const players = el('section'); players.append(el('h2', 'h', 'Players'), playerTables(g));
    parts.push(players);
    // Soccer on fbca.tv/boxscore (not the home page's compact box score): every play, newest first
    const pbp = g.sport === 'soccer' && !head && soccerPlayCard(g);
    if (pbp) { const s = el('section'); s.append(el('h2', 'h', 'Play-by-play'), pbp); parts.push(s); }
    // The date, time and venue from the schedule (fbca.tv/boxscore; not the home page's compact box score)
    const info = !head && gameInfo(g); if (info) parts.push(section('Game Information', info));
    root.replaceChildren(...parts);
    root._fitW = 0; tickBox(root, g);
    if (document.fonts) document.fonts.ready.then(() => fitNames(root));
    // A logo takes its width when it loads, so the names are checked again then.
    root.querySelectorAll('.board .tlogo').forEach(img => { if (!img.complete) img.addEventListener('load', () => fitNames(root), { once: true }); });
  };
  // A scoreboard team name that doesn't fit beside its logo moves below it (the name gets the slab's whole width);
  // still too long, it goes to two lines (smaller), then four. Checked again as fonts load or the screen resizes,
  // so a name that fits again goes back beside its logo on one line.
  const fitNames = root => {
    for (const tm of root.querySelectorAll('.board .tm')) {
      const s = tm.querySelector('span'); if (!s) continue;
      tm.classList.remove('long', 'longer', 'stack');
      const over = () => s.scrollWidth > s.clientWidth + 1;
      if (over() && tm.querySelector('.tlogo')) tm.classList.add('stack');
      if (over()) tm.classList.add('long');
      if (tm.classList.contains('long') && s.scrollHeight > s.clientHeight + 1) tm.classList.add('longer');
    }
  };
  // tickBox: the parts that change with time (clock, status tag), every half second or so.
  const tickBox = (root, g) => {
    if (root._fitW !== root.clientWidth) { root._fitW = root.clientWidth; fitNames(root); }
    const tag = root.querySelector('.tag');
    if (tag) { tag.classList.toggle('on', isLive(g) && g.status !== 'half'); tag.textContent = statusTag(g); }
    // At halftime and after the final, the middle of the scoreboard says so instead of a clock.
    const clk = root.querySelector('.board .clk'), per = root.querySelector('.board .per');
    const done = g.status === 'final' ? 'Final' : g.status === 'half' ? 'Half' : '';
    if (clk) { const t = done || clockText(g); clk.textContent = t || '–'; clk.hidden = !t; }
    if (per) per.hidden = !!done;
    // Timeouts go away when the scorebug stops sharing or the game ends, without waiting for the next play.
    const showTos = !!timeoutsLeft(g);
    root.querySelectorAll('.board .tos').forEach(d => { d.hidden = !showTos; });
  };

  // LIVE: the scheduled game, in its live window, and not marked final by the scorebug.
  const isLive = g => !!g && g.scheduled && g.status !== 'final';
  // The tag beside the box score: LIVE, HALFTIME, FINAL, or LAST GAME (a game outside its scheduled window).
  const statusTag = g => !g ? '' : g.status === 'final' ? 'Final' : g.status === 'half' && g.scheduled ? 'Halftime' : g.scheduled ? 'Live' : 'Last game';
  // ---------- A game as a spreadsheet (CSV), for the Download buttons ----------
  // Used by fbca.tv/boxscore and the stat keeper pages (graphics/*-stats.html). Made and attempted shots get their own
  // columns, and each play's time is written with its period ("2Q 3:42"): Excel would open "2-5" as a date and
  // "3:42" as a time of day.
  const CSV_COLS = {
    basketball: [['PTS', p => 2 * p.m2 + 3 * p.m3 + p.mft], ['FGM', p => p.m2 + p.m3], ['FGA', p => p.m2 + p.m3 + p.x2 + p.x3], ['3PM', p => p.m3],
                 ['3PA', p => p.m3 + p.x3], ['FTM', p => p.mft], ['FTA', p => p.mft + p.xft], ['OREB', p => p.oreb], ['DREB', p => p.dreb],
                 ['REB', p => p.oreb + p.dreb], ['AST', p => p.ast], ['STL', p => p.stl], ['BLK', p => p.blk], ['TO', p => p.to], ['PF', p => p.pf]],
    soccer: [['G', p => p.goal], ['A', p => p.ast], ['SH', p => p.goal + p.sog + p.shot], ['SOG', p => p.goal + p.sog], ['SV', p => p.save],
             ['YC', p => p.yc], ['RC', p => p.rc]]
  };
  const gameDate = g => new Date((g.meta && g.meta.startedAt) || Date.now());
  const csv = g => {
    const S = SPORT[g.sport], H = g.sides.home, A = g.sides.away, soccer = g.sport === 'soccer', rows = [];
    const date = gameDate(g).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    // Away first, then home (FBCA), as on the page.
    rows.push([(soccer ? 'Soccer' : 'Basketball') + ' box score', date], [A.name, A.score], [H.name, H.score], []);
    // Team stats, as on the page
    rows.push(['Team stats', A.name, H.name]);
    const cA = S.cmp(A.tot);
    S.cmp(H.tot).forEach(([label, hv, ha, kind], i) => {
      const [, av, aa] = cA[i], f = (v, a) => kind === true ? v + ' of ' + a + ' (' + pct(v, a) + ')' : kind === 'share' ? (v == null ? '' : Math.round(100 * v) + '%') : v;
      rows.push([label, f(av, aa), f(hv, ha)]);
    });
    rows.push([]);
    // Every player (starters first when they were set), then each team's total
    const cols = CSV_COLS[g.sport], mins = !soccer;
    rows.push(['Team', '#', 'Player', ...(mins ? ['Starter', 'MIN'] : []), ...cols.map(c => c[0])]);
    for (const t of [A, H]) {
      const st = t.starters || [];
      const order = st.length ? [...st.map(id => t.players.find(p => p.id === id)).filter(Boolean), ...t.players.filter(p => !st.includes(p.id))] : t.players;
      for (const p of order) rows.push([t.name, p.num, p.name, ...(mins ? [st.includes(p.id) ? 'Yes' : '', p.sec == null ? '' : Math.round(p.sec / 60)] : []), ...cols.map(c => c[1](p))]);
      rows.push([t.name, '', 'Team total', ...(mins ? ['', ''] : []), ...cols.map(c => c[1](t.tot))]);
    }
    rows.push([], ['Play-by-play'], ['When', 'Team', 'Player', 'Play']);
    const WORDS = { ...(soccer ? S_PLAY : B_PLAY), in: 'checked in', out: 'checked out' };
    for (const e of g.events || []) {
      if (!g.sides[e.side]) continue;
      rows.push([(PER_SHORT[e.period] || e.period) + (e.min ? ' ' + playTime(g, e) : ''), g.sides[e.side].name,
                 e.player === 'team' ? 'Team' : playerName(g, e.side, e.player), (WORDS[e.type] || e.type) + (e.note ? ' (' + e.note + ')' : '')]);
    }
    const q = v => { const t = v == null ? '' : String(v); return /[",\r\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
    // The byte-order mark tells Excel the file is UTF-8 (names with accents, the dash).
    return '\ufeff' + rows.map(r => r.map(q).join(',')).join('\r\n') + '\r\n';
  };
  // "2026-11-15 FBCA vs Visitors basketball box score.csv"
  const csvName = g => {
    const d = gameDate(g), ymd = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    return (ymd + ' ' + g.sides.home.name + ' vs ' + g.sides.away.name + ' ' + g.sport + ' box score').replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, ' ').trim() + '.csv';
  };
  const downloadCsv = g => {
    const url = URL.createObjectURL(new Blob([csv(g)], { type: 'text/csv;charset=utf-8' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: csvName(g) });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  };
  // Past games, kept by the stat keeper when a new game starts (newest first), and one past game ready to draw.
  const pastGames = async () => {
    const lists = await Promise.all(GAMES.map(sport => fetch(API + '/archive?game=' + sport, { cache: 'no-store' })
      .then(r => r.ok ? r.json() : { games: [] }).then(d => (d.games || []).map(x => ({ ...x, sport }))).catch(() => [])));
    return lists.flat().sort((a, b) => (b.lastAt || b.savedAt) - (a.lastAt || a.savedAt));
  };
  const pastGame = async (sport, id) => {
    if (!GAMES.includes(sport)) return null;
    const r = await fetch(API + '/archive?game=' + sport + '&id=' + encodeURIComponent(id), { cache: 'no-store' });
    if (!r.ok) return null;
    const d = await r.json(), meta = { ...d.meta, status: 'final' }, games = await loadSchedule();
    const info = scheduleFor(games, sport, meta.startedAt || d.lastAt || d.savedAt);
    return { ...compute(sport, { meta, events: d.events || [] }), at: d.savedAt, scheduled: false, status: 'final', past: true, info };
  };
  window.EotaLive = { watch, compute, csv, csvName, downloadCsv, pastGames, pastGame, gameDate, renderBox, tickBox, latestText, clockText, isLive, statusTag, playerName, PERIOD, PER_SHORT };
})();
