// The live game banner (Lock Screen / Dynamic Island) for the iOS app, worked out from a game's state so the
// stat keeper can push it to phones with the app closed.
//
// A port of the app's LiveActivityController.state / attributes and BoxText.latest / clock
// (eota-ios-app: LiveActivityController.swift, LiveStats.swift). Keep the two in step: the field names must match
// GameActivityAttributes and its ContentState (GameActivity.swift) exactly, or iOS can't decode the push.
//
// Dates: iOS decodes content-state with JSONDecoder's defaults, so a Date is seconds since 2001-01-01, not 1970.

import EotaBaseball from '../../graphics/baseball.js';

const APPLE_EPOCH = 978307200; // 2001-01-01T00:00:00Z in Unix seconds
const appleDate = ms => ms / 1000 - APPLE_EPOCH;

const SIDES = ['home', 'away'];
const PTS = { m2: 2, m3: 3, mft: 1 };
const BASKETBALL_PLAY = { m2: 'made a 2-pointer', x2: 'missed a 2-pointer', m3: 'made a 3-pointer', x3: 'missed a 3-pointer',
  mft: 'made a free throw', xft: 'missed a free throw', oreb: 'offensive rebound', dreb: 'defensive rebound',
  ast: 'assist', stl: 'steal', blk: 'block', to: 'turnover', pf: 'foul', timeout: 'timeout' };
const SOCCER_PLAY = { goal: 'GOAL', ast: 'assist', sog: 'shot on target', shot: 'shot off target', save: 'save', corner: 'corner kick',
  foul: 'foul', offside: 'offside', yc: 'yellow card', rc: 'red card', og: 'OWN GOAL',
  throw: 'throw-in', fk: 'free kick', hand: 'handball', pkm: 'missed penalty kick' };
const PERIODS = { '1Q': '1st', '2Q': '2nd', '3Q': '3rd', '4Q': '4th', OT: 'OT', OT2: '2OT', OT3: '3OT', OT4: '4OT', '1H': '1st half', '2H': '2nd half', OT1: 'OT' };
const BALL_PLAYS = ['pa', 'br', 'pc'];

const ord = n => n + ((n % 100 >= 11 && n % 100 <= 13) ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' })[n % 10] || 'th');
const isFBCA = name => /\bFBCA\b/.test(String(name).toUpperCase()) || String(name).toUpperCase().includes('FORT BEND CHRISTIAN');
const FBCA_EAGLE = 'bundle:fbca-eagle';

/** "Fort Bend Christian Academy" → "FBCA", "St. Thomas" → "ST", "Kinkaid" → "KINK" (LiveActivityController.initials) */
export const initials = name => {
  const words = String(name).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (words.length >= 2) return words.slice(0, 4).map(w => w[0]).join('').toUpperCase();
  return (words[0] || String(name)).slice(0, 4).toUpperCase();
};

const teamName = (meta, side) => (meta.names && meta.names[side]) || (side === 'home' ? 'FBCA' : 'Opponent');
const playerName = (meta, side, id) => {
  const p = id !== 'team' && ((meta.rosters && meta.rosters[side]) || []).find(x => x.id === id);
  return p ? (p.num ? '#' + p.num + ' ' : '') + p.name : teamName(meta, side);
};

/** The sport the app knows the game by: "basketball", "soccer", "baseball" or "softball" (the stat keeper's game name). */
export const sportOfGame = game => /^soccer/.test(game) ? 'soccer' : /^softball/.test(game) ? 'softball' : /^baseball/.test(game) ? 'baseball' : 'basketball';
const isBall = sport => sport === 'baseball' || sport === 'softball';

/** The banner's fixed part: the teams. A new game (gameId) is a new banner. */
export function attributes(sport, meta) {
  const name = s => teamName(meta, s), color = s => (meta.colors && meta.colors[s]) || '#333333';
  return {
    gameId: (meta.gameId || '') + '-' + sport, sport,
    homeName: name('home'), awayName: name('away'),
    homeAbbr: initials(name('home')), awayAbbr: initials(name('away')),
    homeColor: color('home'), awayColor: color('away')
  };
}

/** The banner's changing part (GameActivityAttributes.ContentState), as of now. */
export function contentState(sport, st, now = Date.now()) {
  const meta = st.meta, events = st.events || [], period = meta.period || '';
  // Each team's logo file as the app saves it (TeamLogoFiles.name); a phone that hasn't saved it shows initials.
  // FBCA without a shared logo gets the eagle built into the app.
  const logo = side => {
    const v = meta.logos && meta.logos[side] && meta.logos[side].v;
    if (v) return `${sport}-${side}-${v}.png`;
    return isFBCA(teamName(meta, side)) ? FBCA_EAGLE : '';
  };
  const base = { status: meta.status || '', homeLogo: logo('home'), awayLogo: logo('away') };

  if (isBall(sport)) {
    const S = EotaBaseball.compute(meta, events), t = S.sit;
    const e = [...events].reverse().find(x => BALL_PLAYS.includes(x.type));
    let lastPlay = '', lastPlaySide = '';
    if (e) {
      const d = e.data || {}, runs = (d.runs || []).length, r = d.r || '';
      const title = e.type === 'pa' ? (r === 'HR' && runs === 4 ? 'Grand slam' : (EotaBaseball.RESULTS[r] || {}).l || r)
        : e.type === 'br' ? EotaBaseball.RUNS[r] || r : 'Pitching change';
      const who = e.type === 'pc' || e.player !== 'team' ? playerName(meta, e.side, e.player) : teamName(meta, e.side);
      const what = (e.type === 'pc' ? 'now pitching' : title.toLowerCase()) + (runs > 0 ? ` · ${runs} ` + (runs === 1 ? 'run scores' : 'runs score') : '');
      lastPlay = who + ' · ' + what.toLowerCase();
      lastPlaySide = e.side || '';
    }
    return { homeScore: S.team.home.R || 0, awayScore: S.team.away.R || 0,
             period: `${t.b}-${t.s} · ${t.o} out`, clockRunning: false,
             clockText: (t.top ? '▲ ' : '▼ ') + ord(t.inn), lastPlay, lastPlaySide, ...base };
  }

  // Basketball and soccer: the score from the plays
  const score = { home: 0, away: 0 };
  for (const e of events) {
    if (!SIDES.includes(e.side)) continue;
    if (sport === 'soccer') { if (e.type === 'goal') score[e.side]++; if (e.type === 'og') score[e.side === 'home' ? 'away' : 'home']++; }
    else score[e.side] += PTS[e.type] || 0;
  }

  // The clock: running on its own on the phone from a reference moment, or stopped text
  const c = meta.clock, fresh = meta.clockSrc === 'scorebug' && now - (meta.clockAt || 0) < 150000;
  let clockRunning = false, clockRef;
  if (c && c.run && meta.status !== 'final' && meta.status !== 'half') {
    if (sport === 'soccer') {
      const half = (meta.halfMin || 40) * 60000, ot = (meta.otMin || 10) * 60000;
      const offset = ({ '2H': half, OT1: 2 * half, OT2: 2 * half + ot })[period] || 0;
      clockRef = appleDate((c.startedAt || 0) - (c.base || 0) - offset); clockRunning = true;
    } else if (fresh) {
      clockRef = appleDate((c.startedAt || 0) + (c.base || 0)); clockRunning = true;
    }
  }
  const clockText = clockRunning ? '' : stoppedClock(sport, meta, now);

  // The latest play (not a substitution)
  const e = [...events].reverse().find(x => x.type !== 'in' && x.type !== 'out');
  let lastPlay = '', lastPlaySide = '';
  if (e) {
    let words = (sport === 'soccer' ? SOCCER_PLAY : BASKETBALL_PLAY)[e.type] || e.type;
    if (e.type === 'timeout' && e.note) words += ` (${e.note})`;
    if (sport === 'soccer' && e.type === 'goal' && e.note === 'PK') words = 'PENALTY KICK GOAL';
    let who = playerName(meta, e.side, e.player);
    if (e.type === 'og') {
      const own = teamName(meta, e.side);
      who = e.player === 'team' ? own + ' defender' : playerName(meta, e.side, e.player) + ` (${own})`;
    }
    lastPlay = e.type === 'timeout' ? words[0].toUpperCase() + words.slice(1) : who + ' · ' + words.toLowerCase();
    lastPlaySide = e.side || '';
  }

  const out = { homeScore: score.home, awayScore: score.away, period: PERIODS[period] || period,
                clockRunning, clockText, lastPlay, lastPlaySide, ...base };
  if (clockRef != null) out.clockRef = clockRef;
  return out;
}

/** The clock in the middle when it isn't running on its own (BoxText.clock). */
function stoppedClock(sport, meta, now) {
  if (meta.status === 'final') return 'Final';
  if (meta.status === 'half') return 'Half';
  const c = meta.clock;
  if (!c) return '';
  if (sport === 'soccer') {
    if (!c.run && !(c.base > 0)) return '';
    const ms = (c.base || 0) + (c.run ? now - (c.startedAt || now) : 0);
    const half = Math.round(meta.halfMin || 40), ot = Math.round(meta.otMin || 10), period = meta.period || '1H';
    const start = ({ '2H': half, OT1: 2 * half, OT2: 2 * half + ot })[period] || 0;
    const len = period.startsWith('OT') ? ot : half, into = Math.floor(ms / 60000) + 1;
    return (into > len ? `${start + len}+${into - len}` : `${start + into}`) + "'";
  }
  if (meta.clockSrc !== 'scorebug' || now - (meta.clockAt || 0) > 150000) return '';
  const left = Math.max(0, (c.base || 0) - (c.run ? now - (c.startedAt || now) : 0));
  const sec = Math.ceil(left / 1000);
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

/** The parts of the state that matter enough to send right away at high priority (a score, the period, the status). */
export const bigChange = (a, b) => !a || a.homeScore !== b.homeScore || a.awayScore !== b.awayScore
  || a.period !== b.period || a.status !== b.status || a.clockRunning !== b.clockRunning;

/** The "game is on" alert that has to come with a banner started by push. */
export function startAlert(attrs) {
  return { title: `${attrs.awayName} at ${attrs.homeName}`, body: 'Live now. Follow the score on your Lock Screen.' };
}
