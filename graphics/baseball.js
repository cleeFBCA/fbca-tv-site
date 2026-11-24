/*
  Baseball / softball rules for Eagles on the Air: shared by the baseball stat keeper
  (graphics/baseball-stats.html) and the baseball scorebug (graphics/baseball-scorebug.html).

  The stat keeper records every pitch and play. Each play is one event on the eota-stat-keeper
  worker (game "baseball" or "softball") and carries the game's situation after it in data.sit:
  inning, half, count, outs, runners, score, who's up, each team's pitcher and pitch counts.
  So the scorebug only reads the last event, and Undo just takes the last event away.

  Event types:
    pitch  a pitch that doesn't end the plate appearance   data { p: B|C|S|F, pit, sit }
    pa     a plate appearance's result (side = batting team, player = batter)
           data { r: result code, p: last pitch ('' for an intentional walk), pit, outs, runs:[{id,pit,er}], rbi, err, lob?, sit }
    br     running between pitches (side = batting team, player = the runner)  data { r, pit, outs, runs, err, lob?, sit }
    pc     pitching change (side = fielding team, player = new pitcher)        data { from, sit }
    fix    the keeper corrected the situation by hand                          data { sit }

  Season stats: a team's totals as of a date (typed in, or imported from GameChanger), plus every
  game recorded here after that date, plus the game being played now.
*/
(function (root) {
  'use strict';
  const SIDES = ['home', 'away'];
  const other = s => s === 'home' ? 'away' : 'home';

  // Plate appearance results. bat: the batter's base by default (0 = out); h: bases for a hit; ab: counts as an at-bat.
  const RESULTS = {
    '1B': { l: 'Single', short: '1B', h: 1, ab: 1, bat: 1 },
    '2B': { l: 'Double', short: '2B', h: 2, ab: 1, bat: 2 },
    '3B': { l: 'Triple', short: '3B', h: 3, ab: 1, bat: 3 },
    HR: { l: 'Home run', short: 'HR', h: 4, ab: 1, bat: 4 },
    BB: { l: 'Walk', short: 'BB', ab: 0, bat: 1, force: 1 },
    IBB: { l: 'Intentional walk', short: 'IBB', ab: 0, bat: 1, force: 1 },
    HBP: { l: 'Hit by pitch', short: 'HBP', ab: 0, bat: 1, force: 1 },
    K: { l: 'Strikeout swinging', short: 'K', ab: 1, bat: 0, k: 1 },
    KL: { l: 'Strikeout looking', short: 'K', ab: 1, bat: 0, k: 1 },
    GO: { l: 'Ground out', short: 'GO', ab: 1, bat: 0 },
    FO: { l: 'Fly out', short: 'FO', ab: 1, bat: 0 },
    LO: { l: 'Line out', short: 'LO', ab: 1, bat: 0 },
    PO: { l: 'Pop out', short: 'PO', ab: 1, bat: 0 },
    E: { l: 'Reached on error', short: 'E', ab: 1, bat: 1, err: 1 },
    FC: { l: "Fielder's choice", short: 'FC', ab: 1, bat: 1 },
    SAC: { l: 'Sacrifice bunt', short: 'SAC', ab: 0, bat: 0 },
    SF: { l: 'Sacrifice fly', short: 'SF', ab: 0, bat: 0 },
    DP: { l: 'Double play', short: 'DP', ab: 1, bat: 0 }
  };
  // Running plays between pitches
  const RUNS = {
    SB: 'Stolen base', CS: 'Caught stealing', WP: 'Wild pitch', PB: 'Passed ball', BK: 'Balk',
    PK: 'Picked off', E: 'Advanced on an error', ADV: 'Runner advanced', OUT: 'Runner out'
  };
  const PITCHES = { B: 'Ball', C: 'Called strike', S: 'Swinging strike', F: 'Foul' };
  const POSITIONS = ['P', 'C', '1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF', 'DH', 'DP', 'FLEX', 'EH'];

  const newSit = () => ({ inn: 1, top: true, b: 0, s: 0, o: 0, bases: [null, null, null], score: { home: 0, away: 0 },
                         up: { home: 0, away: 0 }, pit: { home: '', away: '' }, np: {} });
  const batting = sit => sit.top ? 'away' : 'home';
  const fielding = sit => sit.top ? 'home' : 'away';
  const period = sit => (sit.top ? 'T' : 'B') + sit.inn;
  const clone = o => JSON.parse(JSON.stringify(o));
  const dataOf = e => { if (!e || !e.data) return null; if (typeof e.data === 'string') { try { return JSON.parse(e.data); } catch (x) { return null; } } return e.data; };

  // The situation now: from the last play (every play carries it).
  const current = events => {
    for (let i = (events || []).length - 1; i >= 0; i--) { const d = dataOf(events[i]); if (d && d.sit) return { ...newSit(), ...clone(d.sit) }; }
    return newSit();
  };
  const orderOf = (meta, side) => ((meta && meta.order && meta.order[side]) || []).filter(o => o && o.id);
  // The batter up: picked by hand (sit.bat), else the next one in the batting order.
  const batterOf = (meta, sit) => {
    if (sit.bat) return sit.bat;
    const ord = orderOf(meta, batting(sit));
    return ord.length ? ord[(sit.up[batting(sit)] || 0) % ord.length].id : '';
  };
  const onDeck = (meta, sit, n = 1) => {
    const ord = orderOf(meta, batting(sit));
    return ord.length ? ord[((sit.up[batting(sit)] || 0) + n) % ord.length].id : '';
  };
  // The fielding team's pitcher: the last change, else whoever plays P in its lineup.
  // The pitcher: the last pitching change, else the starting pitcher, else whoever bats at P
  const pitcherOf = (meta, sit, side = fielding(sit)) => sit.pit[side] || (meta && meta.sp && meta.sp[side]) || (orderOf(meta, side).find(o => o.pos === 'P') || {}).id || '';

  // Where each runner (and the batter) goes by default after a result. dest: 0 out, 1–3 a base, 4 scored.
  const forced = bases => [!!bases[0], !!bases[0] && !!bases[1], !!bases[0] && !!bases[1] && !!bases[2]];
  const defaultMoves = (sit, code) => {
    const R = RESULTS[code] || {}, f = forced(sit.bases), stay = sit.bases.map((r, i) => r ? i + 1 : null);
    const plus = n => sit.bases.map((r, i) => r ? Math.min(4, i + 1 + n) : null);
    const forcedUp = sit.bases.map((r, i) => r ? (f[i] ? i + 2 : i + 1) : null);
    let r = stay, b = R.bat || 0;
    if (R.h) r = plus(R.h);
    else if (R.force) r = forcedUp;
    else if (code === 'GO' || code === 'E') r = code === 'E' ? plus(1) : forcedUp;
    else if (code === 'SAC') r = plus(1);
    else if (code === 'SF') r = sit.bases.map((x, i) => x ? (i === 2 ? 4 : i + 1) : null);
    else if (code === 'FC') { const lead = f.lastIndexOf(true); r = sit.bases.map((x, i) => x ? (i === lead ? 0 : f[i] ? i + 2 : i + 1) : null); if (lead < 0) { const l2 = sit.bases.map(Boolean).lastIndexOf(true); if (l2 >= 0) r[l2] = 0; } }
    else if (code === 'DP') { r = stay.slice(); if (sit.bases[0]) r[0] = 0; else { const l = sit.bases.map(Boolean).lastIndexOf(true); if (l >= 0) r[l] = 0; } }
    return { b, r };
  };
  const runMoves = (sit, code, runner) => {
    const r = sit.bases.map((x, i) => x ? i + 1 : null);
    if (['WP', 'PB', 'BK'].includes(code)) return { r: sit.bases.map((x, i) => x ? i + 2 : null) };
    const i = runner != null ? runner : sit.bases.map(Boolean).lastIndexOf(true);
    if (i >= 0 && sit.bases[i]) { if (code === 'SB' || code === 'E' || code === 'ADV') r[i] = i + 2; if (['CS', 'PK', 'OUT'].includes(code)) r[i] = 0; }
    return { r };
  };
  // Runs batted in, by default: runs scored, except on an error or a double play.
  const defaultRbi = (code, moves) => ['E', 'DP', 'K', 'KL'].includes(code) ? 0
    : (moves.r || []).filter(d => d === 4).length + (moves.b === 4 ? 1 : 0);

  // Moves runners (and the batter, for a plate appearance). Returns the bases after, the runs and the outs.
  const move = (sit, moves, batter, pit, code) => {
    const bases = [null, null, null], runs = []; let outs = 0;
    for (let i = 2; i >= 0; i--) {
      const r = sit.bases[i]; if (!r) continue;
      const d = moves.r && moves.r[i] != null ? moves.r[i] : i + 1;
      if (d === 0) outs++;
      else if (d >= 4) runs.push({ id: r.id, pit: r.pit, er: !r.ue });
      else if (!bases[d - 1]) bases[d - 1] = r; else outs++; // two runners on one base: the one behind is out
    }
    if (batter != null) {
      const d = moves.b || 0, ue = code === 'E';
      if (d === 0) outs++;
      else if (d >= 4) runs.push({ id: batter, pit, er: !ue });
      else if (!bases[d - 1]) bases[d - 1] = { id: batter, pit, ue }; else outs++;
    }
    return { bases, runs, outs };
  };
  const endHalf = sit => ({ ...sit, inn: sit.top ? sit.inn : sit.inn + 1, top: !sit.top, b: 0, s: 0, o: 0, bases: [null, null, null], bat: '' });

  // One action from the stat keeper → the event to store (with the situation after it).
  // act: { k: 'pitch', p } | { k: 'pa', code, moves, rbi, err, p } | { k: 'br', code, moves, err, runner } | { k: 'pc', id } | { k: 'fix', sit } | { k: 'bat', id }
  const apply = (meta, sit0, act, idFn, at) => {
    const sit = clone(sit0), bat = batting(sit), fld = fielding(sit), pit = pitcherOf(meta, sit), batter = batterOf(meta, sit);
    const base = { id: idFn(), at: at || Date.now(), period: period(sit0) };
    const count = (p) => { if (p && pit) sit.np[pit] = (sit.np[pit] || 0) + 1; };
    if (act.k === 'pitch') {
      const p = act.p;
      if (p === 'B' && sit.b >= 3) return apply(meta, sit0, { k: 'pa', code: 'BB', p: 'B' }, idFn, at);
      if ((p === 'C' || p === 'S') && sit.s >= 2) return apply(meta, sit0, { k: 'pa', code: p === 'C' ? 'KL' : 'K', p }, idFn, at);
      if (p === 'B') sit.b++; else if (p === 'C' || p === 'S' || (p === 'F' && sit.s < 2)) sit.s++;
      count(p);
      return { ...base, side: bat, player: batter || 'team', type: 'pitch', data: { p, pit, sit } };
    }
    if (act.k === 'pa') {
      const code = act.code, moves = act.moves || defaultMoves(sit, code);
      const p = act.p != null ? act.p : (code === 'IBB' ? '' : code === 'HBP' ? 'H' : 'X');
      count(p);
      const m = move(sit, moves, batter || 'team', pit, code);
      const rbi = act.rbi != null ? act.rbi : defaultRbi(code, moves);
      const err = act.err != null ? act.err : (RESULTS[code] && RESULTS[code].err ? 1 : 0);
      sit.bases = m.bases; sit.o += m.outs; sit.score[bat] += m.runs.length; sit.b = 0; sit.s = 0;
      if (!sit.bat) { const n = orderOf(meta, bat).length; if (n) sit.up[bat] = ((sit.up[bat] || 0) + 1) % n; }
      sit.bat = '';
      const data = { r: code, p, pit, outs: m.outs, runs: m.runs, rbi, err };
      let next = sit;
      if (sit.o >= 3) { data.lob = sit.bases.filter(Boolean).length; next = endHalf(sit); }
      data.sit = next;
      return { ...base, side: bat, player: batter || 'team', type: 'pa', data };
    }
    if (act.k === 'br') {
      const code = act.code, moves = act.moves || runMoves(sit, code, act.runner);
      const runnerIdx = act.runner != null ? act.runner : (moves.r || []).findIndex((d, i) => sit.bases[i] && d !== i + 1);
      const who = runnerIdx >= 0 && sit.bases[runnerIdx] ? sit.bases[runnerIdx].id : 'team';
      const m = move(sit, moves, null, pit, code);
      sit.bases = m.bases; sit.o += m.outs; sit.score[bat] += m.runs.length;
      if (code === 'BK' || code === 'PK') { /* no pitch */ }
      const data = { r: code, pit, outs: m.outs, runs: m.runs, err: act.err != null ? act.err : (code === 'E' ? 1 : 0) };
      let next = sit;
      if (sit.o >= 3) { data.lob = sit.bases.filter(Boolean).length; next = endHalf(sit); } // the batter leads off next time
      data.sit = next;
      return { ...base, side: bat, player: who, type: 'br', data };
    }
    if (act.k === 'pc') {
      const side = act.side || fld, from = pitcherOf(meta, sit, side);
      sit.pit[side] = act.id;
      // A runner already on base stays charged to the pitcher who let him on.
      return { ...base, side, player: act.id, type: 'pc', data: { from, sit } };
    }
    if (act.k === 'bat') { sit.bat = act.id; return { ...base, side: bat, player: act.id || 'team', type: 'fix', data: { what: 'batter', sit } }; }
    if (act.k === 'fix') return { ...base, side: bat, player: 'team', type: 'fix', data: { sit: { ...newSit(), ...clone(act.sit) } } };
    throw new Error('Unknown action');
  };

  // ---------- Stats ----------
  const BAT_KEYS = ['G', 'PA', 'AB', 'H', '1B', '2B', '3B', 'HR', 'RBI', 'R', 'BB', 'SO', 'HBP', 'SAC', 'SF', 'SB', 'CS'];
  const PIT_KEYS = ['G', 'GS', 'outs', 'BF', 'NP', 'H', 'R', 'ER', 'BB', 'SO', 'HBP', 'HR', 'ABA', 'W', 'L', 'SV'];
  const zero = keys => Object.fromEntries(keys.map(k => [k, 0]));
  const ip = outs => Math.floor((outs || 0) / 3) + '.' + ((outs || 0) % 3);
  const rate = (n, d) => d ? (n / d).toFixed(3).replace(/^0/, '') : '.000';
  const avg = b => rate(b.H, b.AB);
  const obp = b => rate(b.H + b.BB + b.HBP, b.AB + b.BB + b.HBP + b.SF);
  const slg = b => rate(b['1B'] + 2 * b['2B'] + 3 * b['3B'] + 4 * b.HR, b.AB);
  const era = (p, innings = 7) => p.outs ? (p.ER * innings * 3 / p.outs).toFixed(2) : (p.ER ? '∞' : '0.00');
  const baa = p => rate(p.H, p.ABA);
  const whip = p => p.outs ? ((p.H + p.BB) * 3 / p.outs).toFixed(2) : '0.00';

  // The game so far: line score, R/H/E/LOB, each player's batting and pitching line.
  const compute = (meta, events) => {
    meta = meta || {}; events = events || [];
    const out = { sit: current(events), line: { home: [], away: [] }, team: {}, bat: { home: {}, away: {} }, pit: { home: {}, away: {} }, plays: [] };
    for (const side of SIDES) out.team[side] = { R: 0, H: 0, E: 0, LOB: 0 };
    const B = (side, id) => out.bat[side][id] || (out.bat[side][id] = zero(BAT_KEYS));
    const P = (side, id) => out.pit[side][id] || (out.pit[side][id] = zero(PIT_KEYS));
    const lineAdd = (side, inn, n) => { const L = out.line[side]; while (L.length < inn) L.push(0); L[inn - 1] += n; };
    // Every half inning that was started gets a 0 in the line score
    let maxT = 0, maxB = 0;
    for (const e of events) {
      const d = dataOf(e); if (!d) continue;
      const m = /^([TB])(\d+)$/.exec(e.period || ''); const inn = m ? +m[2] : 1, top = !m || m[1] === 'T';
      if (top) maxT = Math.max(maxT, inn); else maxB = Math.max(maxB, inn);
      const bat = top ? 'away' : 'home', fld = other(bat);
      if (e.type === 'pitch') { if (d.pit) P(fld, d.pit).NP++; continue; }
      if (e.type === 'pa' || e.type === 'br') {
        const runs = d.runs || [];
        for (const r of runs) { if (r.id && r.id !== 'team') B(bat, r.id).R++; if (r.pit) { P(fld, r.pit).R++; if (r.er) P(fld, r.pit).ER++; } }
        if (runs.length) lineAdd(bat, inn, runs.length);
        out.team[bat].R += runs.length;
        out.team[fld].E += d.err || 0;
        out.team[bat].LOB += d.lob || 0;
        if (d.pit) P(fld, d.pit).outs += d.outs || 0;
      }
      if (e.type === 'pa') {
        const R = RESULTS[d.r] || {}, b = B(bat, e.player), p = d.pit ? P(fld, d.pit) : zero(PIT_KEYS);
        b.PA++; p.BF++; if (d.p) p.NP++;
        if (R.ab) { b.AB++; p.ABA++; }
        if (R.h) { b.H++; p.H++; out.team[bat].H++; b[['', '1B', '2B', '3B', 'HR'][R.h]]++; if (R.h === 4) p.HR++; }
        if (d.r === 'BB' || d.r === 'IBB') { b.BB++; p.BB++; }
        if (d.r === 'HBP') { b.HBP++; p.HBP++; }
        if (R.k) { b.SO++; p.SO++; }
        if (d.r === 'SAC') b.SAC++;
        if (d.r === 'SF') b.SF++;
        b.RBI += d.rbi || 0;
      }
      if (e.type === 'br' && e.player && e.player !== 'team') {
        if (d.r === 'SB') B(bat, e.player).SB++;
        if (d.r === 'CS') B(bat, e.player).CS++;
      }
    }
    // The current half too, even before its first play
    const cs = out.sit; if (cs.top) maxT = Math.max(maxT, cs.inn); else maxB = Math.max(maxB, cs.inn);
    if (!cs.top) maxT = Math.max(maxT, cs.inn);
    while (out.line.away.length < maxT) out.line.away.push(0);
    while (out.line.home.length < maxB) out.line.home.push(0);
    for (const side of SIDES) {
      for (const id in out.bat[side]) out.bat[side][id].G = 1;
      for (const id in out.pit[side]) out.pit[side][id].G = 1;
      // The first pitcher in the lineup (or the first to throw) started
      const first = events.find(e => (e.type === 'pitch' || e.type === 'pa') && dataOf(e) && dataOf(e).pit && (e.side !== side));
      const st = first && dataOf(first).pit;
      if (st && out.pit[side][st]) out.pit[side][st].GS = 1;
    }
    return out;
  };

  // A player's line today: "2-3, HR, 2 RBI" / "1-1, BB"
  const todayLine = b => {
    if (!b || !b.PA) return '';
    const bits = [b.H + '-' + b.AB];
    if (b.HR) bits.push((b.HR > 1 ? b.HR + ' ' : '') + 'HR');
    if (b['3B']) bits.push((b['3B'] > 1 ? b['3B'] + ' ' : '') + '3B');
    if (b['2B']) bits.push((b['2B'] > 1 ? b['2B'] + ' ' : '') + '2B');
    if (b.RBI) bits.push(b.RBI + ' RBI');
    if (b.BB) bits.push((b.BB > 1 ? b.BB + ' ' : '') + 'BB');
    if (b.SO) bits.push((b.SO > 1 ? b.SO + ' ' : '') + 'K');
    if (b.SB) bits.push((b.SB > 1 ? b.SB + ' ' : '') + 'SB');
    return bits.join(', ');
  };
  const pitchLine = p => p ? `${ip(p.outs)} IP, ${p.H} H, ${p.R} R, ${p.ER} ER, ${p.BB} BB, ${p.SO} K` : '';

  // ---------- Season stats ----------
  // Players are matched across games by name (case, spacing and punctuation ignored); the number can change.
  const nameKey = n => String(n || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const addTo = (a, b, keys) => { for (const k of keys) a[k] = (a[k] || 0) + (Number(b && b[k]) || 0); return a; };
  // A game's players for the season record: [{ num, name, bat, pit }]
  const gamePlayers = (meta, stats, side) => {
    const roster = (meta.rosters && meta.rosters[side]) || [];
    return roster.map(p => {
      const b = stats.bat[side][p.id], pt = stats.pit[side][p.id];
      return (b || pt) ? { num: p.num || '', name: p.name, ...(b ? { bat: b } : {}), ...(pt ? { pit: pt } : {}) } : null;
    }).filter(Boolean);
  };
  // rec: { name, asOf, base: { players }, games: [{ id, at, opp, players }] }. live: { id, players } for the game now.
  const seasonTotals = (rec, live) => {
    const map = new Map();
    const add = list => { for (const p of list || []) {
      const k = nameKey(p.name); if (!k) continue;
      const t = map.get(k) || { num: p.num || '', name: p.name, bat: zero(BAT_KEYS), pit: zero(PIT_KEYS), pitched: false, games: 0 };
      if (p.num) t.num = p.num;
      addTo(t.bat, p.bat, BAT_KEYS); addTo(t.pit, p.pit, PIT_KEYS);
      if (p.pit && (p.pit.outs || p.pit.BF)) t.pitched = true;
      map.set(k, t);
    } };
    if (rec) {
      add(rec.base && rec.base.players);
      for (const g of rec.games || []) if (!rec.asOf || g.at > rec.asOf) if (!live || g.id !== live.id) add(g.players);
    }
    if (live) add(live.players);
    return map;
  };
  const seasonFor = (totals, name) => totals && totals.get(nameKey(name)) || null;

  // ---------- GameChanger season export (CSV) ----------
  const parseCsv = text => {
    const rows = []; let row = [], f = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; continue; }
      if (c === '"') q = true; else if (c === ',') { row.push(f); f = ''; }
      else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; }
      else f += c;
    }
    if (f || row.length) { row.push(f); rows.push(row); }
    return rows;
  };
  const ipToOuts = v => { const m = /^(\d+)(?:\.(\d))?$/.exec(String(v || '').trim()); return m ? +m[1] * 3 + Math.min(2, +(m[2] || 0)) : 0; };
  // GameChanger: a row of section names (Batting, Pitching, Fielding…) over a row of column names. Totals and glossary rows are skipped.
  const BAT_MAP = { GP: 'G', PA: 'PA', AB: 'AB', H: 'H', '1B': '1B', '2B': '2B', '3B': '3B', HR: 'HR', RBI: 'RBI', R: 'R', BB: 'BB', SO: 'SO', K: 'SO', HBP: 'HBP', SAC: 'SAC', SH: 'SAC', SF: 'SF', SB: 'SB', CS: 'CS' };
  const PIT_MAP = { GP: 'G', GS: 'GS', BF: 'BF', '#P': 'NP', NP: 'NP', P: 'NP', H: 'H', R: 'R', ER: 'ER', BB: 'BB', SO: 'SO', K: 'SO', HBP: 'HBP', HR: 'HR', W: 'W', L: 'L', SV: 'SV', AB: 'ABA' };
  const parseGameChanger = text => {
    const rows = parseCsv(String(text || '').replace(/^﻿/, '')).filter(r => r.some(c => c.trim()));
    const hi = rows.findIndex(r => r.some(c => /^last$/i.test(c.trim())) && r.some(c => /^first$/i.test(c.trim())));
    if (hi < 0) throw new Error('No "Last" and "First" columns. Export the season stats from GameChanger as CSV.');
    const head = rows[hi].map(c => c.trim()), groups = hi > 0 ? rows[hi - 1].map(c => c.trim()) : [];
    let g = '', ipCol = head.findIndex(h => h === 'IP');
    const section = head.map((h, i) => { if (groups[i]) g = groups[i].toLowerCase(); return g || (ipCol >= 0 && i >= ipCol ? 'pitching' : 'batting'); });
    const col = n => head.findIndex(h => h.toLowerCase() === n);
    const iNum = col('number') >= 0 ? col('number') : col('#'), iLast = col('last'), iFirst = col('first');
    const players = [];
    for (const r of rows.slice(hi + 1)) {
      const last = (r[iLast] || '').trim(), first = (r[iFirst] || '').trim();
      if (!last && !first) continue;
      if (/^(totals?|team|glossary)$/i.test(first) || /^(totals?|team|glossary)$/i.test(last)) continue;
      const bat = zero(BAT_KEYS), pit = zero(PIT_KEYS); let baaV = 0;
      head.forEach((h, i) => {
        const v = (r[i] || '').trim(); if (v === '' || v === '-') return;
        if (/^batting/.test(section[i]) && BAT_MAP[h]) bat[BAT_MAP[h]] = Number(v) || 0;
        if (/^pitching/.test(section[i])) {
          if (h === 'IP') pit.outs = ipToOuts(v);
          else if (h === 'BAA') baaV = Number(v) || 0;
          else if (PIT_MAP[h]) pit[PIT_MAP[h]] = Number(v) || 0;
        }
      });
      if (!bat['1B'] && bat.H) bat['1B'] = Math.max(0, bat.H - bat['2B'] - bat['3B'] - bat.HR);
      // At-bats against: from BAA when it's there, else batters faced less walks and hit batters
      if (!pit.ABA && (pit.BF || pit.H)) pit.ABA = baaV > 0 && pit.H ? Math.round(pit.H / baaV) : Math.max(0, pit.BF - pit.BB - pit.HBP);
      const p = { num: iNum >= 0 ? (r[iNum] || '').trim().replace(/^#/, '') : '', name: (first + ' ' + last).trim() };
      if (bat.PA || bat.AB || bat.G) p.bat = bat;
      if (pit.outs || pit.BF) p.pit = pit;
      if (p.bat || p.pit) players.push(p);
    }
    if (!players.length) throw new Error('No players with stats found in that file.');
    return players;
  };

  const api = { SIDES, other, RESULTS, RUNS, PITCHES, POSITIONS, BAT_KEYS, PIT_KEYS, newSit, batting, fielding, period, current,
    orderOf, batterOf, onDeck, pitcherOf, defaultMoves, runMoves, defaultRbi, apply, compute, dataOf, todayLine, pitchLine,
    ip, avg, obp, slg, era, baa, whip, zero, nameKey, gamePlayers, seasonTotals, seasonFor, parseGameChanger, parseCsv, ipToOuts };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.EotaBaseball = api;
})(typeof window !== 'undefined' ? window : globalThis);
