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
      // The whole roster, by number: players with nothing recorded yet show zeros (dimmed).
      const list = [...players.values()].sort((a, b) => (parseInt(a.num, 10) || 999) - (parseInt(b.num, 10) || 999) || a.name.localeCompare(b.name));
      out.sides[side] = { name: (m.names && m.names[side]) || (side === 'home' ? 'FBCA' : 'Opponent'), color: (m.colors && m.colors[side]) || '#333333', players: list, tot,
                          score: sport === 'soccer' ? tot.goal : 2 * tot.m2 + 3 * tot.m3 + tot.mft };
    }
    // Soccer: an own goal (recorded on the defender) counts for the other team.
    if (sport === 'soccer') { out.sides.home.score += out.sides.away.tot.og; out.sides.away.score += out.sides.home.tot.og; }
    const evs = st.events || [];
    out.latest = evs.length ? evs[evs.length - 1] : null;
    out.plays = evs.length;
    return out;
  };

  // ---------- Words for the page ----------
  const B_PLAY = { m2: 'made a 2-pointer', x2: 'missed a 2-pointer', m3: 'made a 3-pointer', x3: 'missed a 3-pointer', mft: 'made a free throw', xft: 'missed a free throw',
                   oreb: 'offensive rebound', dreb: 'defensive rebound', ast: 'assist', stl: 'steal', blk: 'block', to: 'turnover', pf: 'foul' };
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
    const words = (g.sport === 'soccer' ? S_PLAY : B_PLAY)[e.type] || e.type;
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
  // Bars: FBCA (home) in gold; the other team in its color unless that's too dark to see.
  const barOf = (side, g) => side === 'home' ? '#EAAF0F' : (lum(g.sides.away.color) < .22 ? '#B9C6B4' : g.sides.away.color);
  const pct = (m, a) => a ? Math.round(100 * m / a) + '%' : '–';
  // What each sport shows: team comparison rows [label, value, attempts (shooting), is a %, lower is better] and player columns.
  const SPORT = {
    basketball: {
      cmp: t => [['FG', t.m2 + t.m3, t.m2 + t.m3 + t.x2 + t.x3, true], ['3PT', t.m3, t.m3 + t.x3, true], ['FT', t.mft, t.mft + t.xft, true],
                 ['Rebounds', t.oreb + t.dreb], ['Assists', t.ast], ['Steals', t.stl], ['Blocks', t.blk], ['Turnovers', t.to, null, false, true], ['Fouls', t.pf, null, false, true]],
      cols: ['PTS', 'FG', '3PT', 'FT', 'REB', 'AST', 'STL', 'BLK', 'TO', 'PF'],
      row: p => [2 * p.m2 + 3 * p.m3 + p.mft, (p.m2 + p.m3) + '-' + (p.m2 + p.m3 + p.x2 + p.x3), p.m3 + '-' + (p.m3 + p.x3), p.mft + '-' + (p.mft + p.xft),
                 p.oreb + p.dreb, p.ast, p.stl, p.blk, p.to, p.pf]
    },
    soccer: {
      cmp: t => [['Shots', t.goal + t.sog + t.shot], ['On target', t.goal + t.sog], ['Corners', t.corner], ['Saves', t.save], ['Fouls', t.foul, null, false, true],
                 ['Offsides', t.offside, null, false, true], ['Yellow cards', t.yc, null, false, true], ['Red cards', t.rc, null, false, true]],
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
    const tm = (t, cls) => { const d = paint(el('div', 'tm slab ' + cls), t.color); d.append(el('span', null, t.name)); return d; };
    const mid = el('div', 'mid'), clk = el('div', 'clk', '–'), per = el('div', 'per', PERIOD[g.meta.period] || g.meta.period || '');
    mid.append(clk, per);
    board.append(tm(H, 'L'), el('div', 'sc', H.score), mid, el('div', 'sc', A.score), tm(A, 'R'));
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
    const cmp = el('div', 'card cmp'), rowsA = S.cmp(A.tot);
    S.cmp(H.tot).forEach(([label, hv, ha, isPct, lowGood], i) => {
      const [, av, aa] = rowsA[i];
      const r = el('div', 'row'), mid2 = el('div'), bar = el('div', 'bar2'), lb = el('div'), rb = el('div'), lf = el('i'), rf = el('i');
      const val = (v, a, cls) => { const d = el('div', 'v ' + cls); d.append(isPct ? v + '-' + a : String(v)); if (isPct) d.append(el('small', null, pct(v, a))); return d; };
      const hs = isPct ? (ha ? hv / ha : 0) : hv, as = isPct ? (aa ? av / aa : 0) : av, tot = hs + as;
      lf.style.cssText = `width:${tot ? 100 * hs / tot : 0}%;background:${barOf('home', g)}`; rf.style.cssText = `width:${tot ? 100 * as / tot : 0}%;background:${barOf('away', g)}`;
      lb.append(lf); rb.append(rf); bar.append(lb, rb); mid2.append(el('div', 'lbl', label), bar);
      const hv2 = val(hv, ha, 'L'), av2 = val(av, aa, 'R'), better = lowGood ? (a, b) => a < b : (a, b) => a > b;
      if (better(as, hs)) hv2.classList.add('lo'); if (better(hs, as)) av2.classList.add('lo');
      r.append(hv2, mid2, av2); cmp.append(r);
    });
    if (collapseTeamStats) {
      const d = el('details', 'sect'), sum = el('summary', null, 'Team stats');
      const prev = root.querySelector('details.sect'); d.open = prev ? prev.open : false;
      d.append(sum, cmp); parts.push(d);
    } else { const s = el('section'); s.append(el('h2', 'h', 'Team stats'), cmp); parts.push(s); }

    // Players
    const table = t => {
      const card = el('div', 'card'), th = paint(el('div', 'team-h slab'), t.color);
      th.append(el('span', null, t.name), el('small', null, t.score));
      card.append(th);
      if (!t.players.length) { card.append(el('div', 'none', 'No roster entered for this team yet.')); return card; }
      const tbl = el('table'), hr = el('tr');
      hr.append(el('th', null, 'Player'), ...S.cols.map(c => el('th', null, c)));
      tbl.append(hr);
      for (const p of t.players) {
        const tr = el('tr'), name = el('td');
        if (p.num) name.append(el('b', null, '#' + p.num));
        name.append(p.name);
        tr.append(name, ...S.row(p).map((v, i) => el('td', (i === 0 ? 'pts' : '') + (v === 0 || v === '0-0' ? ' zero' : ''), v)));
        tbl.append(tr);
      }
      const tot = el('tr', 'tot'); tot.append(el('td', null, 'Team'), ...S.row(t.tot).map(v => el('td', null, v)));
      tbl.append(tot);
      const sc = el('div', 'scroll'); sc.append(tbl); card.append(sc);
      return card;
    };
    const players = el('section'), grid = el('div', 'grid2');
    grid.append(table(H), table(A));
    players.append(el('h2', 'h', 'Players'), grid);
    parts.push(players);
    root.replaceChildren(...parts);
    tickBox(root, g);
  };
  // tickBox: the parts that change with time (clock, status tag), every half second or so.
  const tickBox = (root, g) => {
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
  window.EotaLive = { watch, renderBox, tickBox, latestText, clockText, isLive, statusTag, playerName, PERIOD, PER_SHORT };
})();
