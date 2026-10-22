// Encrypts the crew duties guide, the duty cards and equipment list shown on
// fbca.tv/duties, so only someone with the crew password can read it.
//
// The guide is written in a plain text file (Markdown) kept outside this public
// repo. Only the encrypted copy, duties-guide.json, is committed.
//
//   node tools/crew-guide.mjs seal  path/to/duties-guide.md    encrypt it into duties-guide.json
//   node tools/crew-guide.mjs open  path/to/duties-guide.md    decrypt duties-guide.json back into a text file
//
// It asks for the crew password, or reads CREW_PASSWORD. Use `open` to get an
// editable copy on a new computer, since the encrypted file is the only copy in
// the repo.
//
// The guide's format: a "# " heading per position, matching the column names
// in the signup sheet ("# Director", "# Cam 2"). "# Camera" covers every Cam
// column without its own heading, and "# Utility" every Utility column. Under
// each, "## " sections like Equipment, Setup, Test, Operate, and Strike. A list
// item written "- [ ] ..." becomes a checkbox. "# Equipment list" is the
// master list. A heading ending in "(Home)" or "(Away)" only shows for that
// setup, like "## Equipment (Away)" or "# Equipment list (Away)". Untagged
// headings show for both.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { seal, open } from './crew-crypto.mjs';

const OUT = new URL('../duties-guide.json', import.meta.url);
const [cmd, file] = process.argv.slice(2);
if (!['seal', 'open'].includes(cmd) || !file) {
  console.error('Usage: node tools/crew-guide.mjs seal|open path/to/duties-guide.md');
  process.exit(1);
}

async function ask(question) {
  // Read without echoing the password to the terminal.
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  rl._writeToOutput = (s) => { if (s.includes(question)) rl.output.write(s); };
  const answer = await new Promise((resolve) => rl.question(question, resolve));
  rl.close();
  process.stdout.write('\n');
  return answer;
}

const password = process.env.CREW_PASSWORD || (await ask('Crew password: '));

if (cmd === 'seal') {
  const previous = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : null;
  if (previous) {
    // Catch a typo before it locks everyone out of the guide.
    try { await open(previous, password); } catch {
      console.error('That password doesn\'t open the current guide. If the crew password changed, delete duties-guide.json first.');
      process.exit(1);
    }
  }
  const envelope = { ...(await seal(readFileSync(file, 'utf8'), password, previous)), updated: new Date().toISOString() };
  writeFileSync(OUT, JSON.stringify(envelope) + '\n');
  console.log('Wrote duties-guide.json.');
} else {
  if (existsSync(file)) { console.error(`${file} already exists. Pick a new name so it isn't overwritten.`); process.exit(1); }
  try {
    writeFileSync(file, await open(JSON.parse(readFileSync(OUT, 'utf8')), password));
  } catch {
    console.error('Wrong password.');
    process.exit(1);
  }
  console.log(`Wrote ${file}.`);
}
