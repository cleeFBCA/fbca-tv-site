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

  // ---------- Words for the page ----------
  const B_PLAY = { m2: 'made a 2-pointer', x2: 'missed a 2-pointer', m3: 'made a 3-pointer', x3: 'missed a 3-pointer', mft: 'made a free throw', xft: 'missed a free throw',
                   oreb: 'offensive rebound', dreb: 'defensive rebound', ast: 'assist', stl: 'steal', blk: 'block', to: 'turnover', pf: 'foul', timeout: 'timeout' };
  const S_PLAY = { goal: 'GOAL', ast: 'assist', sog: 'shot on target', shot: 'shot off target', save: 'save', corner: 'corner kick', foul: 'foul', offside: 'offside', yc: 'yellow card', rc: 'red card', og: 'OWN GOAL' };
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
      onUpdate({ ...compute(sport, thisGame()), at, scheduled, status: (st.meta && st.meta.status) || '' });
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
  // renderBox(root, game, { head, collapseTeamStats }): draws the whole box score into root (a .ebx element).
  //   head: a title row with the LIVE tag and a link to fbca.tv/boxscore (the home page).
  //   collapseTeamStats: team stats behind a toggle (closed at first; stays as the viewer left it).
  const renderBox = (root, g, { head = false, collapseTeamStats = false } = {}) => {
    const S = SPORT[g.sport], H = g.sides.home, A = g.sides.away, parts = [];
    const top = el('div', 'card head-card');
    if (head) {
      const h = el('div', 'ehead'), link = el('a', null, 'Full box score ›'); link.href = '/boxscore/';
      h.append(el('span', 'tag', 'Live'), el('span', 'what', (g.sport === 'soccer' ? 'Soccer' : 'Basketball') + ' box score'), link);
      top.append(h);
    }
    const board = el('div', 'board');
    // A team's logo, as the scorebug shared it through the stat keeper (meta.logos), fetched by version. Not on past
    // games: the stat keeper keeps only each side's current logo.
    const logoImg = (side, cls) => {
      const lg = !g.past && g.meta.logos && g.meta.logos[side];
      return lg && lg.v ? Object.assign(el('img', cls), { src: API + '/logo?game=' + g.sport + '&side=' + side + '&v=' + lg.v, alt: '' }) : null;
    };
    const tm = (t, cls) => {
      const d = paint(el('div', 'tm slab ' + cls), t.color), img = logoImg(t === H ? 'home' : 'away', 'tlogo');
      if (img) d.style.setProperty('--wm', `url("${img.src}")`); // the same logo, large and faint behind, by the score
      d.append(...(img ? [img] : []), el('span', null, t.name));
      return d;
    };
    const mid = el('div', 'mid'), clk = el('div', 'clk', '–'), per = el('div', 'per', PERIOD[g.meta.period] || g.meta.period || '');
    mid.append(clk, per);
    // Away on the left, home on the right, as on TV. FBCA is the stat keeper's home team, so it's on the right.
    board.append(tm(A, 'L'), el('div', 'sc', A.score), mid, el('div', 'sc', H.score), tm(H, 'R'));
    top.append(board);
    parts.push(top);

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

    // Team stats
    // Away's numbers on the left, home's (FBCA) on the right, like the scoreboard above.
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
    if (collapseTeamStats) {
      const d = el('details', 'sect'), sum = el('summary', null, 'Team stats');
      const prev = root.querySelector('details.sect'); d.open = prev ? prev.open : false;
      d.append(sum, cmp); parts.push(d);
    } else { const s = el('section'); s.append(el('h2', 'h', 'Team stats'), cmp); parts.push(s); }

    // Players
    const table = t => {
      const card = el('div', 'card'), th = paint(el('div', 'team-h slab'), t.color);
      const lg = logoImg(t === H ? 'home' : 'away', 'tlogo');
      th.append(...(lg ? [lg] : []), el('span', null, t.name), el('small', null, t.score));
      card.append(th);
      if (!t.players.length) { card.append(el('div', 'none', 'No roster entered for this team yet.')); return card; }
      // Basketball with starters set on the stat page: STARTERS, then BENCH, each under its own header, with minutes.
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
    const players = el('section'), grid = el('div', 'grid2');
    grid.append(table(A), table(H)); // away, then home (FBCA), as across the top
    players.append(el('h2', 'h', 'Players'), grid);
    parts.push(players);
    root.replaceChildren(...parts);
    root._fitW = 0; tickBox(root, g);
    if (document.fonts) document.fonts.ready.then(() => fitNames(root));
  };
  // A scoreboard team name that doesn't fit on one line goes to two (smaller); checked again as fonts load or the
  // screen resizes, so a name that fits again goes back to one line.
  const fitNames = root => {
    for (const tm of root.querySelectorAll('.board .tm')) {
      const s = tm.querySelector('span'); if (!s) continue;
      tm.classList.remove('long', 'longer');
      if (s.scrollWidth > s.clientWidth + 1) tm.classList.add('long');
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
    const d = await r.json(), meta = { ...d.meta, status: 'final' };
    return { ...compute(sport, { meta, events: d.events || [] }), at: d.savedAt, scheduled: false, status: 'final', past: true };
  };
  window.EotaLive = { watch, compute, csv, csvName, downloadCsv, pastGames, pastGame, gameDate, renderBox, tickBox, latestText, clockText, isLive, statusTag, playerName, PERIOD, PER_SHORT };
})();
