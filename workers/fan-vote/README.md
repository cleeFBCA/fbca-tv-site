# Fan vote (Cloudflare Worker)

Stores the Player of the Game fan vote for EOTA broadcasts. Fans vote at
**fbca.tv/vote** (`vote/index.html`); the soccer graphics control page
(`graphics/soccer-scorebug.html`, **Fan vote** tab) creates the vote, opens and
closes it, and reads the tally for the on-air results panel. Free on
Cloudflare's Workers free plan, with the votes in a D1 database.

Address: `https://eota-fan-vote.clee-625.workers.dev`

- One vote per device (a random id kept in the browser), and at most 150 votes
  per internet connection per vote, so a crowd on the school Wi-Fi still works.
- Only fbca.tv may read and vote. Creating, opening and closing a vote needs the
  admin key, which the control page sends.

## Running a vote

1. Control page → **Fan vote** tab → paste the admin key → **Save key** (once
   per computer).
2. Fill in 2–4 nominees (typing in Name suggests players from the Lineups tab)
   and press **Open voting**.
3. **Show QR lower third** two or three times in the second half.
4. **Close voting**, then **Show results**. A spotlight photo saved for the
   winner shows on the results panel.

Changing the nominees and pressing Open starts a new vote with a fresh tally.

## Set up (once) and deploy

In this folder:

1. `npx wrangler login` (once).
2. `npx wrangler d1 create eota-fan-vote`, then put the `database_id` it prints
   into `wrangler.toml`. The tables are created on the first request.
3. `npx wrangler secret put ADMIN_KEY` and paste a long random key. That's the
   key for the control page.
4. `npx wrangler deploy`.

If the address changes, update `DEFAULT_API` in `vote/index.html` and `FV_API`
in `graphics/soccer-scorebug.html`.

## Testing locally

Put `ADMIN_KEY=some-test-key` in `.dev.vars` (ignored by git), run
`npx wrangler dev --local --port 8787`, and open the pages with
`vote/?api=http://localhost:8787` and
`graphics/soccer-scorebug.html?fvapi=http://localhost:8787`.

## Check it's working

- The Fan vote tab says "Voting is open. N votes."
- "Wrong admin key" means the key saved on that computer doesn't match the
  `ADMIN_KEY` secret.
- Cloudflare: Workers & Pages → eota-fan-vote → Logs.
