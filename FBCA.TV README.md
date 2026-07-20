# FBCA.tv — Eagles on the Air Website

Documentation for the FBCA.tv broadcast website. This is written for whoever
maintains the site, in case the original webmaster (Chris Lee) is unavailable.
It assumes no prior knowledge of the project, but does assume basic comfort with
editing files and using a web browser.

---

## 1. What this site is, in plain terms

FBCA.tv is the website for **Eagles on the Air**, the student broadcast program
at Fort Bend Christian Academy. Its main job is to let people watch live sports
broadcasts as quickly as possible, see the broadcast schedule, and find archived
games on YouTube.

The site is a **single web page** plus a **privacy policy page**. There is no
database, no login, and no server-side code — it is just static files. This makes
it cheap (free), reliable, and hard to break.

The **most important file to know about is `schedule.json`** — that is the one
you will edit regularly to update the broadcast schedule. Almost everything else
rarely changes.

---

## 2. Where everything lives (the big picture)

There are four separate services involved. You do not need to log into all of
them regularly — most of the time you only touch GitHub.

| Service | What it does | When you touch it |
|---|---|---|
| **GitHub** (account `cleeFBCA`, repo `fbca-tv-site`) | Stores and serves all the website files for free, via a feature called GitHub Pages | Whenever you update the schedule or the site |
| **Network Solutions** | The domain registrar — where `fbca.tv` is registered and where its DNS settings live. Managed by FBCA's IT director. | Almost never (only if the site's address needs to change) |
| **Wowza** | The video streaming service that hosts the actual live video feed | Only if the stream URL changes |
| **Cloudflare** | Provides free, privacy-friendly visitor analytics | Only to view visitor stats |

**How a visitor reaches the site:** they type `fbca.tv` → Network Solutions' DNS
points that name at GitHub's servers → GitHub serves the website files. The video
inside the page is pulled live from Wowza.

---

## 3. The files in the repository

All of these live in the `fbca-tv-site` repository on GitHub:

| File | What it is |
|---|---|
| `index.html` | The entire main website — layout, styling, and all the logic. It is a single self-contained file. |
| `schedule.json` | The broadcast schedule. **This is the file you edit most often.** |
| `privacypolicy.html` | The privacy policy page (required for the Roku and iOS apps). |
| `og-image.png` | The preview image shown when someone shares the site link on social media or text. |
| `CNAME` | A small GitHub file that records the custom domain (`fbca.tv`). **Do not edit or delete this** — it keeps the domain working. |
| `README.md` | This document. |

The website and the iOS app both read the **same** `schedule.json` file (served
at `https://fbca.tv/schedule.json`). Update it once and both stay in sync.

---

## 4. The most common task: updating the schedule

The schedule is controlled entirely by `schedule.json`. You do not need to touch
`index.html` to add or change games.

### How to edit it

1. Go to the `fbca-tv-site` repository on GitHub (logged in as `cleeFBCA`).
2. Click on `schedule.json`.
3. Click the pencil (edit) icon in the top right of the file view.
4. Make your changes (see the format below).
5. Scroll down and click **Commit changes**.

The website and app will pick up the change automatically within a few minutes.

### The format of a game entry

Each game is a block like this, inside the `"games": [ ... ]` list:

```json
{
  "id": "2026-08-28-fb-john-cooper",
  "start": "2026-08-28T19:00:00-05:00",
  "sport": "Football",
  "opponent": "John Cooper School",
  "homeAway": "home",
  "location": "Eagle Stadium",
  "notes": null
}
```

Field by field:

- **`id`** — a unique label for the game. Convention is `date-sport-opponent`.
  It just has to be different from every other id. No spaces.
- **`start`** — date and time the broadcast starts, in this exact format:
  `YYYY-MM-DDTHH:MM:SS-05:00`. The time is 24-hour. The `-05:00` at the end is
  the Central Time zone offset. **Use `-05:00` for daylight time (spring/summer/
  fall) and `-06:00` for standard time (roughly November–early March).**
- **`sport`** — one of: `Football`, `Volleyball`, `Basketball`, `Soccer`,
  `Baseball`, `Softball`, or `Special Event`. Spelling matters (see section 6).
- **`opponent`** — the other team's name. For a `Special Event`, put the event
  name here instead (e.g. `"FBCA 29th Commencement Ceremony"`).
- **`homeAway`** — `"home"` or `"away"`. Rule of thumb: if the schedule says
  "vs" it is home; if it says "at" it is away. For a Special Event with no
  opponent, this can be `null`.
- **`location`** — the venue name, e.g. `"Eagle Stadium"`. Can be `null` if
  unknown.
- **`notes`** — optional short label shown as a gold badge, e.g. `"Homecoming"`,
  `"Senior Night"`, `"Season Opener"`. Use `null` if there is none.

### Important formatting rules (JSON is picky)

- Every entry except the **last** one must be followed by a comma.
- Text values go in `"double quotes"`. Numbers and `null` do not.
- If you break the formatting, the schedule may stop loading. If that happens,
  paste the whole file into a free "JSON validator" website — it will point to
  the exact line with the mistake.

### Do NOT delete old games

Keep adding new games to the end of the list. **Never delete past games.** The
code automatically hides finished games from the schedule, and it needs the past
games to power the "replay" text under the video player (see section 5). The file
is meant to hold the full season as a running record.

---

## 5. How the page decides what to show under the video

The strip of text directly below the video player changes automatically based on
the current date and time compared to the schedule. It picks one of four states,
in this priority order:

1. **LIVE** (red indicator) — a game is happening now. This turns on 15 minutes
   before the listed start time and stays on for 3 hours after.
2. **STARTING SOON** (gold indicator) — the next game begins within the hour.
3. **REPLAY** (gray indicator) — no game is live or imminent, so it shows the
   most recently completed broadcast, because the Wowza stream keeps playing the
   last game after it ends.
4. **UP NEXT** — if there is no past game to replay, it shows the next upcoming
   game instead.

There is also a **countdown timer** ("Next broadcast in 2d 04h 15m") that appears
only when the site is off-air, and hides during a live broadcast.

None of this needs manual switching — it is all driven by the schedule times.
This is why the `start` times in `schedule.json` need to be accurate.

---

## 6. The sport filter buttons

Below the schedule heading are filter buttons (All Sports, Football, etc.).
These are generated automatically from `schedule.json`:

- A sport's button only appears if there is at least one **upcoming** game of
  that sport. So in the fall you will see Football and Volleyball; spring sports
  appear as their seasons arrive.
- Buttons always appear in a fixed order (Football, Volleyball, Basketball,
  Soccer, Baseball, Softball, Special Events) no matter what order games are in
  the file.
- If a sport name is misspelled in the JSON, that game still shows up — it just
  gets its own button at the end. This is a safety net, but it is best to spell
  sports exactly as listed in section 4 so they group correctly.

---

## 7. Occasional tasks

### If the video stream URL changes (new Wowza feed)

The stream address is stored in `schedule.json`, in the `"streamUrl"` field near
the top. Edit that value and commit. Both the website and app will use the new
stream.

### Updating the social share preview image

Replace `og-image.png` in the repository (keep the same filename). Social
platforms cache these aggressively — to force them to refresh, share the link
with a made-up ending like `fbca.tv/?v=3` (increase the number each time). The
site loads identically with or without that ending; it only tricks the cache.

### Viewing visitor analytics

Log into Cloudflare, go to **Web Analytics**, and select `fbca.tv`. You will see
visits, page views, top pages, countries, and device types. No personal data is
collected. There is no automatic emailed report — you check it manually.

---

## 8. Editing the look of the site (advanced)

The entire visual design and behavior lives in `index.html`. It is one large
file containing the layout, the styling (in a `<style>` section near the top),
and the logic (in a `<script>` section near the bottom).

If you need to edit it:

- **Do not use Apple TextEdit or basic Notepad** — they can silently corrupt the
  file by changing quotation marks. Use a proper code editor such as **Visual
  Studio Code** (free), or edit directly in GitHub's built-in editor.
- Images (the logo, the Roku button, the favicon) are embedded directly in the
  file as long strings of text (base64). This is normal — it keeps everything in
  one file. You generally will not need to touch these.
- After any edit, upload/commit the file and check the live site in a private/
  incognito browser window to avoid seeing a cached old version.

Unless you are comfortable with HTML/CSS/JavaScript, the schedule is the only
thing you should need to change — and that is all in `schedule.json`, not here.

---

## 9. Troubleshooting

**The schedule isn't updating after I edited it.**
Wait a few minutes — GitHub caches briefly. Then reload in a private/incognito
window. If it still fails, the JSON formatting is probably broken (a missing
comma or quote); paste the file into a free online JSON validator to find the
error.

**The site shows "Not Secure" for me but works for others.**
Your browser cached an old version. Fully quit and reopen the browser, or clear
the site data for fbca.tv. This affects only your machine, not visitors.

**A shared link shows a plain preview instead of the eagle image.**
The social platform cached an old version. Share it as `fbca.tv/?v=2` (bump the
number) to force a refresh.

**The whole site is down / shows a GitHub 404.**
Check that the `CNAME` file still exists in the repo and contains `fbca.tv`.
Check GitHub → repo **Settings → Pages** to confirm the custom domain is still
set and the DNS check passes. If DNS itself is the problem, that is handled at
Network Solutions by FBCA's IT director — the domain's A records must point to
GitHub's servers (185.199.108.153 through 185.199.111.153) and the `www` record
must point to `cleefbca.github.io`. Email records (MX) must be left untouched —
they run the school's Google email and are unrelated to the website.

**The video player shows "Stream Unavailable."**
This means the page could not reach the Wowza stream. It is only for genuine
technical stream problems, not for "no game right now." Check that the Wowza
feed is actually broadcasting and that `streamUrl` in `schedule.json` is correct.

---

## 10. Key facts to hand off

- **GitHub account:** `cleeFBCA` — owns the `fbca-tv-site` repository. Whoever
  maintains the site needs access to this account (or the repo should be moved to
  a school-owned GitHub organization for continuity).
- **Domain:** `fbca.tv`, registered at **Network Solutions**, DNS managed there
  by FBCA's IT director.
- **Hosting:** GitHub Pages (free).
- **Video:** Wowza (stream URL stored in `schedule.json`).
- **Analytics:** Cloudflare Web Analytics.
- **The one file you edit regularly:** `schedule.json`.
- **The apps:** there is a live Roku channel and an iOS app (in development).
  The iOS app reads the same `schedule.json` as the website.

---

*Last updated: July 2026.*
