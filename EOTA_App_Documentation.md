# Eagles on the Air (EOTA) — FBCA.TV iOS App
### Handoff & Maintenance Documentation

*Last updated: July 2026*

This document explains how the **Eagles on the Air / FBCA.TV** iOS app works, how to keep it running, and how it is built — so that someone other than the original author can maintain it. It is written for two kinds of readers:

- **A non-developer** (a teacher, student leader, or volunteer) who needs to keep the schedule current and understand what the app does. → Read sections 1–4.
- **A developer** who needs to change the code, fix a bug, or ship an update. → Read all sections, especially 5–10.

---

## 1. What the app is

The app is a companion to the **FBCA.TV** website. It gives Fort Bend Christian Academy families and fans an easy way to:

- **Watch** the live sports broadcast stream.
- See whether a broadcast is **live right now** or showing a **replay**.
- Browse the **Broadcast Schedule** of upcoming games.
- **Filter** the schedule by sport.
- Set a **reminder** to be notified before a game goes live.
- **Share** a game to friends via text, email, or social media.
- Jump to the **Archives** (past broadcasts) on YouTube.

The broadcasts themselves are produced by the student broadcast program, **Eagles on the Air (E.O.T.A.)**.

---

## 2. The single most important thing to understand: `schedule.json`

**Almost everything the app shows is driven by one file: `schedule.json`.**

This file lives on the FBCA.TV website and is reachable at:

```
https://fbca.tv/schedule.json
```

The **same file is used by both the website and the app.** When you update it, both update. You do **not** need to release a new version of the app to change the schedule or even the live stream address — you just edit this one file on the website.

This is deliberate. It means a non-developer can run the broadcast season without ever opening Xcode.

### What `schedule.json` controls
- The list of games shown on the Broadcast Schedule screen.
- Which game shows as **LIVE** or **REPLAY** on the Watch button.
- The **live stream URL** the Watch screen plays.
- The timezone used to display game times.

> ⚠️ **Be careful editing this file.** It must remain valid JSON, and dates must be in the exact format described in Section 5. A single typo (a missing comma, a bad date) can cause the schedule to fail to load. Always check the file in a browser after editing — see Section 4.

---

## 3. Where `schedule.json` lives (hosting)

The FBCA.TV website is a self-hosted **GitHub Pages** site (a single HTML file plus `schedule.json`).

- **GitHub account:** `cleeFBCA`
- **Repository:** `fbca-tv-site`
- **Live file:** `https://fbca.tv/schedule.json`

To edit the schedule, you edit `schedule.json` in that repository (through the GitHub website or a Git client) and commit the change. GitHub Pages republishes automatically within a minute or two.

> *If you don't have access to the `cleeFBCA` GitHub account, you will need those credentials from the program's advisor before you can update the schedule.*

---

## 4. Common maintenance tasks (no coding required)

### 4a. Add or change a game
1. Open `schedule.json` in the `fbca-tv-site` repository.
2. Add a new entry to the `games` list, or edit an existing one, following the format in Section 5.
3. Commit/save the change.
4. Wait ~1–2 minutes, then open `https://fbca.tv/schedule.json` in a web browser and confirm it loads and your change is there.
5. Open the app and pull down on the Broadcast Schedule to refresh.

### 4b. Change the live stream address
If the streaming provider (Wowza) ever changes the playlist URL:
1. Update the `streamUrl` value in `schedule.json`.
2. Save and verify as above.
3. The app will pick up the new URL the next time someone opens the Watch screen — **no app update needed.**

> There is also a backup ("fallback") stream URL baked into the app in `AppConfig.swift`. The `streamUrl` in `schedule.json` is the real day-to-day control; the fallback only kicks in if the website can't be reached. See Section 6.

### 4c. Verify the file is valid
After any edit, open `https://fbca.tv/schedule.json` in a browser. If you see the raw text of the file, it loaded. If you see an error, or the page won't display, the JSON is broken — undo your last change. You can also paste the contents into a free "JSON validator" website to find the exact error.

---

## 5. `schedule.json` format reference

The file looks like this (abbreviated):

```json
{
  "version": 1,
  "team": "Eagles on the Air",
  "school": "Fort Bend Christian Academy",
  "timezone": "America/Chicago",
  "streamUrl": "https://cdn3.wowza.com/.../playlist.m3u8",
  "archiveUrl": "https://www.youtube.com/@eaglesontheair",
  "updated": "2026-07-14T17:30:00-05:00",
  "games": [
    {
      "id": "2026-08-21-fb-st-pius-x",
      "start": "2026-08-21T19:00:00-05:00",
      "sport": "Football",
      "opponent": "St. Pius X Catholic School",
      "homeAway": "away",
      "location": "Kubiak Stadium",
      "notes": "FB Season Opener"
    }
  ]
}
```

### Top-level fields
| Field | Meaning |
|---|---|
| `version` | Format version number. Leave as `1`. |
| `team` | Program name. |
| `school` | School name. |
| `timezone` | Timezone for displaying game times. Keep as `America/Chicago` (Central). |
| `streamUrl` | The live HLS stream address the Watch screen plays. |
| `archiveUrl` | The YouTube channel for past broadcasts. |
| `updated` | When you last edited the file (informational). |
| `games` | The list of broadcasts (see below). |

### Each game's fields
| Field | Required? | Meaning |
|---|---|---|
| `id` | Yes | A **unique** identifier for the game. Convention: `date-sport-opponent`, e.g. `2026-08-21-fb-st-pius-x`. Must never repeat. |
| `start` | Yes | Date and time the broadcast starts, in the exact format below. |
| `sport` | Yes | One of: `Football`, `Volleyball`, `Basketball`, `Soccer`, `Baseball`, `Softball`, or `Special Event`. These control the filter pills and their order. |
| `opponent` | Yes | The opposing team, or the event title for a Special Event. |
| `homeAway` | Yes* | `"home"`, `"away"`, or `null` for special events. Controls whether it reads "vs" or "at". |
| `location` | Optional | Venue name. Use `null` if unknown. |
| `notes` | Optional | Short badge text like `"Homecoming"` or `"Senior Night"`. Use `null` for none. |

### ⚠️ Date format — read this carefully
Dates use **ISO 8601 with a timezone offset**:

```
2026-08-21T19:00:00-05:00
        │        │
        │        └── time, 24-hour (19:00:00 = 7:00 PM)
        └── date (year-month-day)
```

The `-05:00` / `-06:00` at the end is the **Central Time offset**, and it changes with Daylight Saving Time:
- **`-05:00`** during Daylight Saving Time (roughly mid-March to early November).
- **`-06:00`** during Standard Time (roughly November to mid-March).

Most fall sports (August–October) use `-05:00`. Winter sports (basketball, some soccer) that fall after early November use `-06:00`. **If a game's time shows up an hour off in the app, this offset is almost always the reason.**

---

## 6. Project structure (for developers)

The app is written in **Swift / SwiftUI**. Below is each source file and what it does.

| File | Responsibility |
|---|---|
| `FBCA_TV_LivestreamApp.swift` | App entry point. Launches `ContentView`. |
| `ContentView.swift` | The main/home screen: logo, the three buttons (Watch, Broadcast Schedule, Archives), and the **LIVE / REPLAY** indicator logic. Fetches the schedule to decide what's live. |
| `WatchView.swift` | The video player. Fetches the current stream URL from `schedule.json`, configures audio, plays the stream, and pauses when you leave. |
| `BroadcastScheduleView.swift` | The schedule screen: loads and displays games, the sport **filter pills**, the **reminder bell** and **share** buttons on each card. Also contains the data models (`BroadcastSchedule`, `Game`), the `FilterPill` view, and the `GameRow` card view. |
| `ButtonView.swift` | The reusable green/gold button used on the home screen. Also defines `WatchStatus` (`.none` / `.live` / `.replay`) and draws the red LIVE badge and grey REPLAY badge. |
| `PressableButtonStyle.swift` | The press animation (slight shrink + shadow) used by the home-screen buttons. |
| `AppConfig.swift` | Central place for the app's URLs: the `schedule.json` address and the **fallback** stream URL. Change URLs here, not scattered through the code. |
| `ReminderManager.swift` | Handles local notification reminders: permission, scheduling 15 minutes before a game, saving which games are opted in, and rescheduling when the schedule changes. |

> **Note:** An earlier `WebView.swift` file existed but was **removed**. The Archives button now opens the YouTube app directly. There is also **no calendar feature anymore** — an earlier version could add games to the iOS Calendar, but that was removed in favor of the reminder bell.

### Brand colors
The green and gold appear throughout. The values are:
- **Green:** `Color(red: 0.0, green: 0.20, blue: 0.12)`
- **Gold:** `Color(red: 0.95, green: 0.75, blue: 0.20)`

In `BroadcastScheduleView.swift` these are defined once as `eotaGreen` and `eotaGold`.

---

## 7. Key behaviors explained

### 7a. LIVE / REPLAY indicator (on the Watch button)
`ContentView` fetches the schedule and decides the Watch button's state:
- **LIVE** (red, pulsing): the current time is within a game's broadcast window — from **15 minutes before** the start time to **30 minutes after** the estimated end. (Football is estimated at 3 hours, other sports 2 hours.)
- **REPLAY** (grey): nothing is live, so it shows the most recent past game — because the stream continues to show the last broadcast.
- **Neither**: no games have aired yet (e.g., before the season).

It re-checks every 60 seconds and again whenever the app returns to the foreground. These timing windows are constants named `preroll` and `postBuffer` in `ContentView.swift` — adjust them there if the badge turns on too early or off too soon.

### 7b. The live stream URL is loaded from the schedule
When someone taps **Watch**, the app fetches `schedule.json`, reads `streamUrl`, and plays it. If the website can't be reached, it falls back to the URL in `AppConfig.swift`. This is why the stream address can be changed without an app update (Section 4b).

### 7c. Reminders (the bell)
- Tapping the bell on a game schedules a **local notification 15 minutes before** the game starts. Tapping again cancels it.
- The first time, iOS asks permission. If denied, the app shows an alert pointing to Settings. (Local notifications need **no Info.plist key** — unlike some permissions.)
- Opted-in games are remembered across app launches.
- Each time the schedule loads, reminders are **rescheduled** to match the latest times, and reminders for games that have passed or been removed are cleared.
- iOS limits an app to 64 pending notifications; because reminders are opt-in per game, this is never a practical concern for a normal season.

### 7d. Times and timezones
All game times are stored as absolute moments (with the offset, Section 5) and displayed in the schedule's timezone (Central). A viewer whose phone is set to another timezone still sees correct Central times and gets LIVE/reminder timing at the right moment.

---

## 8. Building and running the app (for developers)

1. Open the project in **Xcode** (a Mac is required).
2. The **minimum deployment target is iOS 17.0.** (Do not lower it — the app uses iOS 17 features.)
3. To run on the Simulator: choose an iPhone simulator and press **⌘R**.
4. To run on a physical iPhone, you must **sign the app**:
   - Xcode → Settings → Accounts → add an Apple ID.
   - Select the project → the app target → **Signing & Capabilities** → check **Automatically manage signing** and choose a Team.
   - The bundle identifier must be unique (e.g. `tv.fbca.eota` or `com.yourname.fbcatv`).
   - On the iPhone, first launch requires trusting the developer: **Settings → General → VPN & Device Management → Trust.**
   - *A free Apple ID lets you run on your own phone, but the app expires after 7 days and must be reinstalled from Xcode. Distributing to others requires the paid Apple Developer Program — see Section 10.*

### Assets you need in the project
- The EOTA logo image used on the home screen is referenced as `"logo"` in the asset catalog.
- An app icon (the green "EOTA" eagle mark) should be set in the asset catalog's AppIcon.

---

## 9. External services & accounts

| Service | Used for | Notes |
|---|---|---|
| **FBCA.TV website** (GitHub Pages) | Hosts `schedule.json` | Repo `fbca-tv-site`, account `cleeFBCA`. |
| **Wowza** (streaming CDN) | The live HLS video stream | The playlist URL is in `schedule.json` (`streamUrl`) and as a fallback in `AppConfig.swift`. |
| **YouTube** (`@eaglesontheair`) | Archives / past broadcasts | The Archives button opens this channel. |
| **Apple Developer** | Building, and eventually distributing | See Section 10. |

---

## 10. Known limitations & what's not done yet

### Current limitations (by design or accepted trade-offs)
- **The LIVE indicator trusts the schedule, not the actual video feed.** If a broadcast starts late, the badge may turn on before the real stream does. The 15-minute pre-roll and 30-minute buffer absorb most of this.
- **The stream shows the last broadcast when nothing is live.** This is why the REPLAY state exists.
- **A brief "Connecting..." appears** on the Watch screen because the app fetches the stream URL from the website before playing. This is the trade-off for being able to change the stream URL without an app update.
- The schedule is fetched when the app opens and on pull-to-refresh; it is not a live push feed.

### Not done yet — the path to families actually having the app
The app currently runs on the developer's own phone but is **not yet distributed.** To get it to families:
1. **Enroll in the Apple Developer Program** ($99/year).
2. **TestFlight:** invite the broadcast crew and a few parents to test the real build before public release.
3. **App Store submission**, which requires:
   - App screenshots (from the required device sizes).
   - A completed app icon set.
   - A **privacy policy URL** (even a simple page stating what data the app collects — currently it collects none).
   - An **authorization letter from FBCA administration**, because the app uses the school's name and branding (Apple may ask for this under their brand/impersonation guidelines).

### Possible future improvements (optional)
- Group the schedule by month or week with date headers.
- A "no broadcast is live right now" message on the Watch screen.
- Scores/results for past games.
- Accessibility (VoiceOver) polish.
- Server-based push notifications for instant "we're live now" alerts (more infrastructure than the current local reminders).

---

## 11. Quick reference — "How do I…?"

| I want to… | Do this |
|---|---|
| Add a game to the schedule | Edit `games` in `schedule.json` (Section 4a). |
| Fix a game showing the wrong time | Check the `-05:00` / `-06:00` offset (Section 5). |
| Change the live video address | Edit `streamUrl` in `schedule.json` (Section 4b). |
| Change a URL in the app itself | Edit `AppConfig.swift`. |
| Adjust when "LIVE" turns on/off | Edit `preroll` / `postBuffer` in `ContentView.swift`. |
| Change how early reminders fire | Edit `leadTime` in `ReminderManager.swift`. |
| Add a new sport to the filter | Add games with that `sport`; if it's a brand-new sport, also add it to the ordered list in `availableSports` in `BroadcastScheduleView.swift`. |
| Run the app on a phone | Sign the app in Xcode (Section 8). |
| Publish to families | Apple Developer Program + TestFlight + App Store (Section 10). |

---

*End of documentation.*
