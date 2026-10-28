// Checks schedule.json before the website and the iOS app read it, and compares
// it with the crew signup sheet. Run by .github/workflows/schedule-check.yml on
// every change to schedule.json and once a day.
//
//   node tools/check-schedule.mjs
//   CREW_PASSWORD=... node tools/check-schedule.mjs    also compare with the signup sheet
//
// The app decodes the whole file at once, so one bad entry blanks the schedule
// for everyone. These are the app's rules (BroadcastSchedule and Game in
// BroadcastScheduleView.swift), plus a few mistakes that are easy to make:
// a wrong time-zone offset around daylight saving, a sport with a typo, two
// games with the same id.
//
// It exits with an error if anything would break the app or site, or if the
// schedule and the signup sheet disagree, so GitHub emails a failed run.

import { readFileSync, existsSync } from 'node:fs';
import { open } from './crew-crypto.mjs';

const ROOT = new URL('../', import.meta.url);
const ZONE = 'America/Chicago';
// The site's sport filter order (SPORT_ORDER in index.html).
const SPORTS = ['Football', 'Volleyball', 'Girls Basketball', 'Boys Basketball', 'Basketball', 'Girls Soccer',
  'Boys Soccer', 'Soccer', 'Baseball', 'Softball', 'Special Event'];
const STATUSES = ['cancelled', 'canceled', 'postponed'];
// Swift's .iso8601 date decoding: no fractional seconds, and an offset or Z.
const ISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(Z|[+-]\d{2}:\d{2})$/;

const problems = [];   // break the app or site, or the schedules disagree
const warnings = [];   // worth a look
const where = (g, i) => `Game ${i + 1}${g && g.id ? ` (${g.id})` : ''}`;

/** "2026-11-13" and "17:00" for an instant, in Chicago time. */
function local(date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

/** Checks one date string the way the app reads it. Returns the Date, or null. */
function checkDate(text, label) {
  const m = typeof text === 'string' && text.match(ISO);
  if (!m) {
    problems.push(`${label}: "${text}" isn't a date the app can read. Write it like 2026-11-13T17:00:00-06:00.`);
    return null;
  }
  const date = new Date(text);
  if (isNaN(date)) {
    problems.push(`${label}: "${text}" isn't a real date.`);
    return null;
  }
  // The written clock time should be Chicago time on that date: -05:00 in daylight time, -06:00 otherwise.
  const written = `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}`;
  const actual = local(date);
  if (m[7] !== 'Z' && `${actual.day} ${actual.time}` !== written) {
    // Chicago is -05:00 (daylight time) or -06:00 (standard time); pick the one that keeps the written time.
    const off = ['-05:00', '-06:00'].find((o) => local(new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${o}`)).time === `${m[4]}:${m[5]}`);
    problems.push(`${label}: "${text}" has the wrong time-zone offset for that date, so it shows at ${twelve(actual.time)} instead of ${twelve(`${m[4]}:${m[5]}`)}. ` +
      `Use ${off} on ${m[1]}-${m[2]}-${m[3]}.`);
  }
  return date;
}

/** "17:00" → "5:00 PM" */
const twelve = (t) => { const [h, m] = t.split(':').map(Number); return `${(h + 11) % 12 + 1}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`; };

const isText = (v) => typeof v === 'string' && v.trim() !== '';
const optionalText = (v) => v === undefined || v === null || typeof v === 'string';

// --- 1. schedule.json itself ---------------------------------------------------

let schedule = null;
try {
  schedule = JSON.parse(readFileSync(new URL('schedule.json', ROOT), 'utf8'));
} catch (err) {
  problems.push(`schedule.json isn't valid JSON, so the app shows an error and the site shows no games: ${err.message}. ` +
    'Look for a missing comma or quote near that spot.');
}

const games = [];
if (schedule) {
  if (!Number.isInteger(schedule.version)) problems.push('"version" must be a whole number, like 1.');
  for (const key of ['team', 'school', 'timezone', 'streamUrl', 'archiveUrl']) {
    if (!isText(schedule[key])) problems.push(`"${key}" is missing or empty.`);
  }
  try { new Intl.DateTimeFormat('en-US', { timeZone: schedule.timezone }); }
  catch { problems.push(`"timezone" "${schedule.timezone}" isn't a time zone. Use America/Chicago.`); }
  for (const key of ['streamUrl', 'archiveUrl']) {
    if (isText(schedule[key]) && !/^https:\/\//.test(schedule[key])) problems.push(`"${key}" should start with https://.`);
  }
  checkDate(schedule.updated, '"updated"');
  if (!Array.isArray(schedule.games)) problems.push('"games" must be a list: "games": [ ... ].');

  const ids = new Map();
  (Array.isArray(schedule.games) ? schedule.games : []).forEach((g, i) => {
    const at = where(g, i);
    if (!g || typeof g !== 'object' || Array.isArray(g)) { problems.push(`${at}: each game must be { ... }.`); return; }
    if (!isText(g.id)) problems.push(`${at}: "id" is missing or empty.`);
    else if (ids.has(g.id)) problems.push(`${at}: the id "${g.id}" is also used by game ${ids.get(g.id) + 1}. Ids must be different (app reminders use them).`);
    else ids.set(g.id, i);
    const start = checkDate(g.start, `${at} "start"`);
    if (!isText(g.sport)) problems.push(`${at}: "sport" is missing or empty.`);
    else if (!SPORTS.includes(g.sport)) warnings.push(`${at}: "${g.sport}" isn't one of the usual sports (${SPORTS.join(', ')}). Check the spelling and spaces.`);
    if (!isText(g.opponent)) problems.push(`${at}: "opponent" is missing or empty.`);
    if (!optionalText(g.location)) problems.push(`${at}: "location" must be text or null.`);
    if (!optionalText(g.notes)) problems.push(`${at}: "notes" must be text or null.`);
    if (!(g.homeAway === undefined || g.homeAway === null || ['home', 'away'].includes(g.homeAway))) {
      problems.push(`${at}: "homeAway" must be "home", "away", or null (lowercase).`);
    }
    if (!(g.status === undefined || g.status === null || STATUSES.includes(g.status))) {
      problems.push(`${at}: "status" must be "cancelled", "postponed", or null (lowercase).`);
    }
    const known = ['id', 'start', 'sport', 'opponent', 'homeAway', 'location', 'notes', 'status'];
    for (const key of Object.keys(g)) if (!known.includes(key)) warnings.push(`${at}: "${key}" isn't a field the site or app uses. Check the spelling.`);
    if (start) games.push({ ...g, date: start });
  });
}

// --- 2. The signup sheet, if we can read it ----------------------------------

const password = process.env.CREW_PASSWORD;
const signupsFile = new URL('duties-signups.json', ROOT);
if (password && games.length && existsSync(signupsFile)) {
  const sheet = JSON.parse(await open(JSON.parse(readFileSync(signupsFile, 'utf8')), password));
  const today = local(new Date()).day;
  const key = (day, sport) => `${day}|${sport.toLowerCase().replace(/\s+/g, ' ').trim()}`;
  const toMinutes = (t) => {
    const m = String(t).match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
    if (!m) return null;
    let h = +m[1] % 12;
    if (!m[3] || m[3].toUpperCase() === 'PM') h += 12;   // the sheet's times are PM unless they say AM
    return h * 60 + +m[2];
  };
  const fmt = (min) => `${(Math.floor(min / 60) + 11) % 12 + 1}:${String(min % 60).padStart(2, '0')} ${min >= 720 ? 'PM' : 'AM'}`;
  const tbd = (s) => /^\s*(tbd|tba)?\s*$/i.test(s || '');

  // Cancelled and postponed games stay in both places until someone tidies up, so they're only matched, not compared.
  const upcoming = games.filter((g) => local(g.date).day >= today && g.sport !== 'Special Event');
  const bySchedule = new Map(upcoming.map((g) => [key(local(g.date).day, g.sport), g]));
  const bySheet = new Map(sheet.games.filter((g) => g.date >= today).map((g) => [key(g.date, g.sport), g]));

  for (const [k, s] of bySheet) {
    const g = bySchedule.get(k);
    if (!g) { problems.push(`The signup sheet has ${s.sport} on ${s.date} vs ${s.opponent}, but schedule.json doesn't.`); continue; }
    if (g.status) continue;
    const t = local(g.date).time.split(':');
    const scheduleMin = +t[0] * 60 + +t[1];
    const sheetMin = toMinutes(s.game);
    if (sheetMin !== null && sheetMin !== scheduleMin) {
      problems.push(`${s.sport} on ${s.date}: the signup sheet says ${s.game}, schedule.json says ${fmt(scheduleMin)}.`);
    }
    const ha = (s.ha || '').toLowerCase();
    if ((ha === 'home' || ha === 'away') && typeof g.homeAway === 'string' && ha !== g.homeAway.toLowerCase()) {
      problems.push(`${s.sport} on ${s.date}: the signup sheet says ${s.ha}, schedule.json says ${g.homeAway}.`);
    }
    // Names are written differently on purpose ("FBCHA" and the full name), so only TBD is compared.
    if (tbd(s.opponent) !== tbd(g.opponent)) {
      problems.push(`${s.sport} on ${s.date}: the signup sheet says the opponent is "${s.opponent}", schedule.json says "${g.opponent}".`);
    }
  }
  for (const [k, g] of bySchedule) {
    if (!bySheet.has(k) && !g.status) problems.push(`schedule.json has ${g.sport} on ${local(g.date).day} vs ${g.opponent}, but the signup sheet doesn't.`);
  }
  console.log(`Compared ${bySchedule.size} upcoming broadcasts with ${bySheet.size} signup sheet games.`);
}

// --- Report -------------------------------------------------------------------

for (const w of warnings) console.log(`::warning::${w}`);
for (const p of problems) console.log(`::error::${p}`);
if (problems.length) {
  console.error(`\n${problems.length} problem${problems.length === 1 ? '' : 's'} found.`);
  process.exit(1);
}
console.log(`schedule.json looks good: ${games.length} games${warnings.length ? `, ${warnings.length} warning(s)` : ''}.`);
