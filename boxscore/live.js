/* EOTA live box score: reads the current game from the stat keeper (workers/stat-keeper) and keeps it current.
   Used by fbca.tv/boxscore and the live card on the home page.

   Which game: the soccer and basketball stat keepers are each read once; the one with the most recent activity
   (a play, a clock check-in from the scorebug, or a new game) is shown. Then one WebSocket keeps it live: the stat
   keeper pushes each play as it's recorded, so a page never has to ask again. That matters for Cloudflare's free
   plan (100,000 requests a day for the whole account): a viewer costs one connection plus a keep-alive every
   45 seconds (answered without waking the server), not a request every few seconds. A tab in the background
   closes its connection after 30 seconds and reconnects when it's visible again. Only if the WebSocket keeps
   failing does the page fall back to reading the game once a minute.

   ?skapi=http://localhost:PORT points at a local stat keeper for testing; ?game=soccer|basketball picks one. */
(() => {
  const params = new URLSearchParams(location.search);
  const local = params.get('skapi');
  const API = local && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(local) ? local : 'https://eota-stat-keeper.clee-625.workers.dev';
  const WS = API.replace(/^http/, 'ws');
  const GAMES = ['basketball', 'soccer'];
  const LIVE_MS = 20 * 60000;    // activity this recent: LIVE
  const SHOW_MS = 12 * 3600000;  // the last game stays up this long

  // ---------- Reading a game ----------
  const latestAt = st => {
    if (!st || !st.meta) return 0;
    const ev = st.events || [], m = st.meta;
    return Math.max(m.startedAt || 0, m.clockSrc === 'scorebug' ? m.clockAt || 0 : 0, ...ev.map(e => e.at || 0));
  };
  const B_KEYS = ['m2', 'x2', 'm3', 'x3', 'mft', 'xft', 'oreb', 'dreb', 'ast', 'stl', 'blk', 'to', 'pf'];
  const S_KEYS = ['goal', 'ast', 'sog', 'shot', 'save', 'corner', 'foul', 'offside', 'yc', 'rc'];
  const zero = keys => Object.fromEntries(keys.map(k => [k, 0]));

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
      const list = [...players.values()].filter(p => p.any).sort((a, b) => (parseInt(a.num, 10) || 999) - (parseInt(b.num, 10) || 999) || a.name.localeCompare(b.name));
      out.sides[side] = { name: (m.names && m.names[side]) || (side === 'home' ? 'FBCA' : 'Opponent'), color: (m.colors && m.colors[side]) || '#333333', players: list, tot,
                          score: sport === 'soccer' ? tot.goal : 2 * tot.m2 + 3 * tot.m3 + tot.mft };
    }
    const evs = st.events || [];
    out.latest = evs.length ? evs[evs.length - 1] : null;
    out.plays = evs.length;
    return out;
  };

  // ---------- Words for the page ----------
  const B_PLAY = { m2: 'made a 2-pointer', x2: 'missed a 2-pointer', m3: 'made a 3-pointer', x3: 'missed a 3-pointer', mft: 'made a free throw', xft: 'missed a free throw',
                   oreb: 'offensive rebound', dreb: 'defensive rebound', ast: 'assist', stl: 'steal', blk: 'block', to: 'turnover', pf: 'foul' };
  const S_PLAY = { goal: 'GOAL', ast: 'assist', sog: 'shot on target', shot: 'shot off target', save: 'save', corner: 'corner kick', foul: 'foul', offside: 'offside', yc: 'yellow card', rc: 'red card' };
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
    const words = (g.sport === 'soccer' ? S_PLAY : B_PLAY)[e.type] || e.type;
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
  const clockRunning = g => !!(g.meta.clock && g.meta.clock.run && (g.sport === 'soccer' || clockText(g)));

  // ---------- Staying connected ----------
  // watch(onUpdate): onUpdate(game | null) on load and every change. game = { sport, live, at, ...compute() }.
  // showMs: how long after its last activity a game still counts (the home page uses less, so it doesn't connect
  // for a game it isn't showing).
  const watch = (onUpdate, { only, showMs = SHOW_MS } = {}) => {
    let sport = null, st = null, ws = null, ping = 0, retry = 0, fails = 0, poll = 0, hiddenTimer = 0, stopped = false;
    const emit = () => {
      if (!st) return onUpdate(null);
      const at = latestAt(st);
      if (Date.now() - at > showMs && !only) return onUpdate(null);
      onUpdate({ ...compute(sport, st), at });
    };
    const pickGame = async () => {
      const want = only || params.get('game');
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
    (async () => {
      if (!await pickGame()) return onUpdate(null);
      emit();
      if (only || Date.now() - latestAt(st) < showMs) connect(); // an old game needs no live connection
    })();
    return { stop: () => { stopped = true; clearTimeout(retry); clearInterval(poll); clearInterval(ping); if (ws) ws.close(); } };
  };

  // LIVE while plays are coming in (or a clock is running); pages check this on their own clock tick.
  const isLive = g => !!g && (Date.now() - g.at < LIVE_MS || clockRunning(g));
  window.EotaLive = { watch, latestText, clockText, isLive, playerName, PERIOD, PER_SHORT };
})();
