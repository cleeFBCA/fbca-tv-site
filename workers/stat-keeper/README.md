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

## Lock Screen scores (iOS app)

The app's live game banner (Lock Screen and Dynamic Island, iOS 18 and later) is kept current by this worker
through Apple's push service, so it follows the game with the app closed.

- **Updates:** after any change to a basketball, soccer, baseball or softball game, the game works out the banner
  (`banner.js`, a port of the app's code: keep the two in step) and sends it to that sport's **broadcast channel**,
  at most every 4 seconds. Scores, periods and the final go at high priority, other plays at low. Every phone
  showing that sport's banner gets it, with one request per update however many phones there are.
- **Start:** people who turn on **Live scores on Lock Screen** (Broadcast Schedule screen) register a push-to-start
  token (`POST /push/register`). When a sport that's on today's fbca.tv schedule (from an hour before its start
  to three hours after) records its **first play**, the banner is started on every registered phone with a
  "Kinkaid at FBCA · Live now" alert. Once per game.
- **Test games:** tick **Test game: don't start the score banner on fans' phones** in the stat page's New game
  card. Off-day tests never start banners anyway (no game on the schedule).
- **End:** marking the game final ends the banner (the final score stays for 30 minutes). Starting a new game
  ends an unfinished one's banner at once.
- People who open the Watch screen get the banner too (whether or not they turned the switch on), subscribed to
  the same channel.

### Set up (once)

1. **Apple key** (Account Holder or Admin of the FBCA developer team, F9A6UW5W67): developer.apple.com →
   Certificates, Identifiers & Profiles → **Keys** → + → **Apple Push Notifications service (APNs)**, environment
   **Sandbox & Production**. Download the `.p8` (only once!) and note its **Key ID**. Keep the file safe.
2. **Broadcast capability:** Identifiers → `tv.fbca.eaglesontheair` → Push Notifications → **Configure** → turn on
   **Broadcast Capability** (can't be done from Xcode).
3. **Channels:** from this folder, for each environment:
   `node scripts/apns-channels.mjs create production ~/path/AuthKey_XXXXXXXXXX.p8 XXXXXXXXXX`
   `node scripts/apns-channels.mjs create development ~/path/AuthKey_XXXXXXXXXX.p8 XXXXXXXXXX`
   Combine the two printed lines into `APNS_CHANNELS` in `wrangler.toml`:
   `APNS_CHANNELS = '{"production":{…},"development":{…}}'`, and set `APNS_KEY_ID`.
4. `npx wrangler secret put APNS_KEY` and paste the whole `.p8` file, then `npx wrangler deploy`.

Until the key is set, the worker sends nothing and everything else works as before.

### Check it's working

- Workers & Pages → eota-stat-keeper → Logs: "Banner started on phones for basketball: …", "Start pushes: N sent",
  and any "Banner update … failed: 403 …" (a wrong key, team or bundle) or "400 BadChannelId".
- Apple's broadcast docs name two different hosts. If updates fail with a connection error or 404, set
  `APNS_BROADCAST_HOSTS = '{"production":"https://api-broadcast.push.apple.com","development":"https://api-broadcast.sandbox.push.apple.com"}'`.
- Pushes to Apple can't be tested with `wrangler dev` (Apple needs HTTP/2, which only the deployed worker has).
  Locally, `APNS_HOSTS`, `APNS_BROADCAST_HOSTS` and `SCHEDULE_URL` can point at a stand-in server.
