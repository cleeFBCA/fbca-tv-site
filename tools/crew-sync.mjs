// Reads the crew signup spreadsheet from OneDrive and writes the upcoming games
// and who signed up for each position to duties-signups.json, encrypted with the
// crew password. The GitHub Action in .github/workflows/crew-sync.yml runs this
// every 15 minutes. It needs two secrets:
//
//   SIGNUP_SHEET_URL  the "Anyone with the link" share link to the spreadsheet
//   CREW_PASSWORD     the password crew members type on fbca.tv/duties
//
// Run it by hand the same way:
//   SIGNUP_SHEET_URL=... CREW_PASSWORD=... node tools/crew-sync.mjs
//
// The sheet is read as typed. Each tab is a season, each row a game, and every
// column with a number above its header in row 1 is a position. A row with no
// date isn't scheduled yet ("Playoff" is a placeholder), so it's skipped, and so
// are games before today. Times are PM unless they say AM. A name in a column
// with no header is shown with the game as a note.
//
// Two more tabs describe equipment. "Equipment" lists the kits (see
// equipmentSections). "Assignments" is laid out like a season tab, with the kit
// each position takes to each game; it's matched to games by date and sport.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { seal, macFor } from './crew-crypto.mjs';

const OUT = new URL('../duties-signups.json', import.meta.url);
const ZONE = 'America/Chicago';

const url = process.env.SIGNUP_SHEET_URL;
const password = process.env.CREW_PASSWORD;
if (!url || !password) {
  console.error('Set SIGNUP_SHEET_URL and CREW_PASSWORD.');
  process.exit(1);
}

// --- Download ---------------------------------------------------------------

// SharePoint answers the share link with a guest cookie and a redirect to the
// file, which only downloads if that cookie comes along. fetch doesn't keep
// cookies across redirects, so follow them by hand.
async function download(start) {
  const jar = new Map();
  let next = start;
  for (let hop = 0; hop < 10; hop++) {
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(next, { redirect: 'manual', headers: cookie ? { cookie } : {} });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
    const to = res.headers.get('location');
    if (res.status < 300 || res.status >= 400 || !to) return res;
    next = new URL(to, next);
  }
  throw new Error('Too many redirects');
}

const link = new URL(url);
link.searchParams.set('download', '1');
const res = await download(link);
const type = res.headers.get('content-type') || '';
if (!res.ok || !type.includes('spreadsheetml')) {
  // A sign-in page or an error means the link stopped being public. Leave the
  // last good file in place rather than wiping the schedule.
  console.error(`Couldn't download the sheet: HTTP ${res.status} ${type}. Is the link still "Anyone with the link"?`);
  process.exit(1);
}
const xlsx = Buffer.from(await res.arrayBuffer());

// --- Unzip (an .xlsx is a zip of XML files) ---------------------------------

function unzip(buf) {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('Not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = {};
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + size);
    files[name] = (method === 8 ? inflateRawSync(raw) : raw).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

// --- Read the workbook --------------------------------------------------------

const unescape = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&amp;/g, '&');
const textOf = (xml) => unescape([...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join(''));
const attr = (tag, name) => tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];

const files = unzip(xlsx);
const strings = [...(files['xl/sharedStrings.xml'] || '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1]));
const rels = Object.fromEntries([...files['xl/_rels/workbook.xml.rels'].matchAll(/<Relationship\b[^>]*>/g)]
  .map((m) => [attr(m[0], 'Id'), attr(m[0], 'Target')]));
const sheets = [...files['xl/workbook.xml'].matchAll(/<sheet\b[^>]*>/g)].map((m) => {
  const target = rels[attr(m[0], 'r:id')].replace(/^\//, '');
  return { name: unescape(attr(m[0], 'name')).trim(), path: target.startsWith('xl/') ? target : 'xl/' + target };
});

const colNum = (letters) => [...letters].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);

/** A sheet as rows of { column number: value }, keyed by row number. */
function readSheet(xml) {
  const rows = {};
  for (const r of xml.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    for (const c of (r[1] || '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = attr(c[1], 'r'), t = attr(c[1], 't'), body = c[2] || '';
      const v = body.match(/<v>([\s\S]*?)<\/v>/)?.[1];
      let value;
      if (t === 's') value = strings[+v];
      else if (t === 'inlineStr') value = textOf(body);
      else if (t === 'str' || t === 'e') value = v == null ? undefined : unescape(v);
      else if (v != null) value = Number(v);
      if (value === undefined || value === '') continue;
      const [, col, row] = ref.match(/([A-Z]+)(\d+)/);
      (rows[row] ??= {})[colNum(col)] = value;
    }
  }
  return rows;
}

// --- Dates and times ----------------------------------------------------------

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const pad = (n) => String(n).padStart(2, '0');
// CREW_SYNC_TODAY (YYYY-MM-DD) pretends it's another day, for testing.
const today = process.env.CREW_SYNC_TODAY || new Intl.DateTimeFormat('en-CA', { timeZone: ZONE }).format(new Date());

/** A game's date as YYYY-MM-DD, or null if it isn't scheduled yet. */
function dateOf(value, firstYear) {
  if (typeof value === 'number') {
    // Excel counts days from December 30, 1899.
    const d = new Date(Date.UTC(1899, 11, 30) + Math.round(value) * 86400000);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  }
  // Typed as text, like "Friday, October 23". The school year starts in the fall.
  const m = String(value).toLowerCase().match(/(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:\D+(\d{4}))?/);
  if (!m) return null;
  const month = MONTHS.indexOf(m[1]) + 1;
  const year = m[3] ? +m[3] : month >= 7 ? firstYear : firstYear + 1;
  return `${year}-${pad(month)}-${pad(+m[2])}`;
}

/** A time like "7:00 PM". Every time is PM unless it says AM. */
function timeOf(value) {
  if (value == null) return '';
  let h, min, am = false;
  if (typeof value === 'number') {
    const total = Math.round((value % 1) * 1440);
    h = Math.floor(total / 60) % 24; min = total % 60;
    if (h >= 12) h -= 12;
  } else {
    const m = String(value).match(/(\d{1,2})(?::(\d{2}))?\s*([ap])?/i);
    if (!m) return String(value).trim();
    h = +m[1] % 12; min = +(m[2] || 0); am = /a/i.test(m[3] || '');
  }
  return `${h === 0 ? 12 : h}:${pad(min)} ${am ? 'AM' : 'PM'}`;
}

// --- Games --------------------------------------------------------------------

const clean = (v) => (v == null ? '' : String(v).trim());
// Column names that differ between tabs ("Tech Dir." and "Tech Director").
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
const ALIAS = { techdir: 'techdirector', social: 'socialmedia' };
const posKey = (name) => ALIAS[slug(name)] || slug(name);

/** The dated rows of a tab laid out like the signup sheet, with each position's cell. */
function scheduleRows(rows) {
  const title = clean(rows[1]?.[1]);
  const firstYear = +(title.match(/(\d{4})\s*-\s*\d{4}/)?.[1] || new Date().getFullYear());
  const header = rows[2] || {};
  const find = (re) => Number(Object.keys(header).find((c) => re.test(clean(header[c]))));
  const col = {
    show: find(/^show/i), date: find(/^date/i), opponent: find(/^opponent/i), ha: find(/^h\s*\/\s*a/i),
    sport: find(/^sport/i), game: find(/^game\s*time/i), call: find(/^call\s*time/i),
  };
  // Positions are the columns numbered in row 1.
  const positions = Object.keys(rows[1] || {}).map(Number).filter((c) => c > 1 && typeof rows[1][c] === 'number' && clean(header[c])).sort((a, b) => a - b);
  const last = Math.max(0, ...positions);
  const out = [];
  for (const r of Object.keys(rows).map(Number).filter((r) => r > 2).sort((a, b) => a - b)) {
    const row = rows[r];
    const date = row[col.date] == null ? null : dateOf(row[col.date], firstYear);
    if (!date || date < today) continue;
    out.push({ row, date, col, header, positions, last });
  }
  return out;
}

/**
 * The Equipment tab: sections of kits. A section starts with a header row (its
 * title in column A, then a part name per column), has one row per kit (the
 * kit's name in column A, then what it uses for each part), and ends at a
 * blank row.
 */
function equipmentSections(rows) {
  const sections = [];
  let current = null;
  for (const r of Object.keys(rows).map(Number).sort((a, b) => a - b)) {
    const row = rows[r];
    const cols = Object.keys(row).map(Number).sort((a, b) => a - b);
    if (!cols.length) continue;
    if (!current || !rows[r - 1]) {
      current = { title: clean(row[1]), parts: cols.filter((c) => c > 1).map((c) => [c, clean(row[c])]), kits: [] };
      sections.push(current);
      continue;
    }
    const name = clean(row[1]);
    if (!name) continue;
    current.kits.push({ name, items: current.parts.map(([c, part]) => [part, clean(row[c])]).filter(([, v]) => v) });
  }
  return sections.map(({ title, parts, kits }) => ({ title, parts: parts.map((p) => p[1]), kits }));
}

const games = [];
const kitsFor = new Map(); // "date|sport" → { position key: what's in the cell }
let equipment = [];

for (const sheet of sheets) {
  const rows = readSheet(files[sheet.path]);
  if (/^equipment/i.test(sheet.name)) { equipment = equipmentSections(rows); continue; }
  if (/assign/i.test(sheet.name)) {
    for (const { row, date, col, header, positions } of scheduleRows(rows)) {
      const kits = {};
      for (const c of positions) if (clean(row[c])) kits[posKey(clean(header[c]))] = clean(row[c]);
      kitsFor.set(`${date}|${slug(clean(row[col.sport]))}`, kits);
    }
    continue;
  }
  for (const { row, date, col, header, positions, last } of scheduleRows(rows)) {
    // Anything typed in an unlabeled column near the positions goes with the game as a note.
    const notes = Object.keys(row).map(Number)
      .filter((c) => c > last && c <= last + 4 && !clean(header[c]) && clean(row[c]))
      .map((c) => clean(row[c]));
    games.push({
      season: sheet.name,
      show: clean(row[col.show]),
      date,
      opponent: clean(row[col.opponent]),
      ha: clean(row[col.ha]),
      sport: clean(row[col.sport]),
      game: timeOf(row[col.game]),
      call: timeOf(row[col.call]),
      // [position, who, kits], kits from the Assignments tab.
      crew: positions.map((c) => [clean(header[c]), clean(row[c])]),
      notes,
    });
  }
}
for (const g of games) {
  const kits = kitsFor.get(`${g.date}|${slug(g.sport)}`) || {};
  g.crew = g.crew.map(([pos, who]) => [pos, who, kits[posKey(pos)] || '']);
}
games.sort((a, b) => a.date.localeCompare(b.date) || a.call.localeCompare(b.call));

// --- Encrypt, and write only if something changed ------------------------------

const text = JSON.stringify({ games, equipment });
const previous = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : null;
if (previous && (await macFor(text, password, previous)) === previous.mac) {
  console.log(`No changes. ${games.length} upcoming games.`);
  process.exit(0);
}
const envelope = { ...(await seal(text, password, previous)), updated: new Date().toISOString() };
writeFileSync(OUT, JSON.stringify(envelope) + '\n');
console.log(`Updated. ${games.length} upcoming games.`);
