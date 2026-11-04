# Stat sheet relay (Cloudflare Worker)

Lets the soccer graphics page (`graphics/soccer-scorebug.html`) read the EOTA
soccer stat sheet from OneDrive, so the Match Stats and halftime/full-time
panels fill themselves in. SharePoint won't hand the file to a web page
directly, so this Worker fetches it and passes it on. Free on Cloudflare's
Workers free plan.

Address: `https://eota-stat-sheet-relay.clee-625.workers.dev`

It only fetches Excel share links on `fortbendchristian-my.sharepoint.com`, and
only answers requests from fbca.tv, so it can't be used as a general proxy.

## Using it in a game

1. In the game's copy of the stat sheet: **Share → Anyone with the link can
   view → Copy link.** Each copy needs its own link; a saved copy doesn't keep
   the original's sharing.
2. On the graphics control page: **Stats & score** tab → paste the link →
   **Connect**. It reads the sheet every 20 seconds.

The page reads the sheet's **Scorebug** tab (team stats, by the labels in
column G) and the goals list on the **FBCA** and **Opponent** tabs (rows 36–47).
If those move, update `SHEET_ROWS` and `readSheet` in the graphics page.

## Deploy (only after changing worker.js)

In this folder: `npx wrangler login` (once), then `npx wrangler deploy`.
If the address changes, update `RELAY` in `graphics/soccer-scorebug.html`.

## Check it's working

- Stats tab says "Connected. Read … sec ago."
- An error like "OneDrive refused the link" means the sheet isn't shared as
  "Anyone with the link can view".
- Cloudflare: Workers & Pages → eota-stat-sheet-relay → Logs.
