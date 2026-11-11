# Stat keeper (Cloudflare Worker)

Live basketball stats for EOTA broadcasts. The stat crew records plays on
**fbca.tv/graphics/basketball-stats.html** (phone, tablet or laptop; control room,
scorer's table or next to the announcers). Each play reaches the basketball
scorebug control page (`graphics/basketball-scorebug.html`, **Data sources →
Stats come from → Stat keeper page**) in well under a second, where it drives the
score, team fouls, player lower thirds and the team stats panel.

Address: `https://eota-stat-keeper.clee-625.workers.dev`

- One game at a time, in a Durable Object, so plays are stored in order and two
  stat keepers can write to the same game.
- One stat keeper (default) keeps both teams. **Setup → Stat keepers → Two** splits
  it: each device picks a team and sees only that team's players and plays.
- Plays are saved on the device first. During a Wi-Fi dropout the page says
  "Offline · N waiting" and sends them when it reconnects; a play is never stored twice.
- Anyone on fbca.tv may read the current game (the stats go on air anyway).
  Recording plays, rosters, new games and the saved teams list need the stat keeper key.

Soccer has its own stat keeper at **fbca.tv/graphics/soccer-stats.html** (game "soccer"):
goals with minutes from a shared match clock, assists, shots on and off target, saves,
corners, fouls, offsides and cards. The soccer scorebug connects under **Setup →
Stats come from → Stat keeper page**, and gets the score, cards, team stats and goal list
the Excel sheet used to supply. Same stat keeper key as basketball.
Soccer announcers follow it at **fbca.tv/graphics/soccer-announcers.html**.

Announcers follow the same game, read-only, at
**fbca.tv/graphics/basketball-announcers.html** (phone first, works on a laptop): ready-to-read
lines (score, runs, leaders, shooting, quarters, foul trouble, double-doubles), each player's
line, a team comparison and the play log. No key needed.

## Game night

1. Stat crew: open the stat keeper page, **Setup** → paste the key → **Save** (once per device).
2. Enter both rosters (`3 Jordan Lee`, one per line), or pick them from **Saved teams**,
   → **Save teams and rosters**. Every saved roster is kept in Saved teams by team name
   (e.g. "FBCA Varsity", "FBCA JV", each opponent) for next time; **Forget** removes one.
   **Start a new game** clears the last game's plays; leave "Keep the teams and rosters" ticked to reuse them.
3. Scorebug control page: **Data sources** → Stats come from **Stat keeper page** →
   **Connect to the stat keeper**, then tick what the stats should run (score, fouls, players, team stats).
4. During the game: tap a player, then the play (or the play, then the player).
   After a made basket the page offers the assist. Change the period with the buttons at the top.

## Set up (once) and deploy

In this folder: `npx wrangler login` (once), `npx wrangler deploy`, then
`npx wrangler secret put STAT_KEY` and paste a long random key. That's the key
for the stat crew. If the address changes, update `API` in
`graphics/basketball-stats.html` and `SK_API` in `graphics/basketball-scorebug.html`.

## Testing locally

Put `STAT_KEY=some-test-key` in `.dev.vars` (ignored by git), run
`npx wrangler dev --local --port 8788`, and open
`graphics/basketball-stats.html?api=http://localhost:8788` and
`graphics/basketball-scorebug.html?skapi=http://localhost:8788`.

## Check it's working

- Stat keeper page: the badge says **Live**. "Wrong key" means the saved key
  doesn't match the `STAT_KEY` secret.
- Scorebug: "Live from the stat keeper. N plays this game".
- Cloudflare: Workers & Pages → eota-stat-keeper → Logs.
