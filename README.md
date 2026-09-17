# OfficeBoy

Tea and coffee orders for your office. Employees book their drink before a cutoff time, the office boy sees exactly what to make and who gets it, and the admin gets daily and monthly counts.

- **No server, no database, no domain.** Your Google Sheet is the backend (via Apps Script), and the app is a PWA hosted free on GitHub Pages.
- **No passwords for staff.** The admin shares a personal link. People open it once, add it to their home screen, and stay signed in.
- **Your data stays yours.** Every office runs on its own Google Sheet.
- **Admin controls what people see.** Sugar choices, attendance, auto-book, per-round drink changes, the countdown and the office boy's lists can each be turned on or off.

**Live app:** https://vivek-kubvt.github.io/officeboy/

## How it works

| Who | What they do |
|---|---|
| **Employee** | Opens the app → marks *In office / WFH / Leave* → taps **Yes** or **No** for each round (e.g. Morning 11:00, Evening 16:00) before the booking cutoff. Can set a usual drink and turn on *auto-book*. |
| **Office boy** | Sees live headcount, cups to make grouped by drink and sugar, and a delivery list sorted by desk. Taps a name when delivered. After the cutoff the count is final. |
| **Admin** | Adds people, shares their links, resets links, sets rounds, cutoffs and the menu, chooses which options people see, and views reports with CSV export. |

```
Employee taps Yes ──► Apps Script web app ──► Google Sheet (Orders, Attendance)
Office boy screen ◄── polls every 20 s ◄──────┘
```

After the cutoff, bookings for that round are locked on the server, using the sheet's time zone rather than the phone's clock.

## Set up your office

You need a Google account. Setup takes about 10 minutes.

### 1. Create the backend

1. Create a new, blank Google Sheet, e.g. *OfficeBoy – Pune office*.
2. **File → Settings → Time zone**: set your office's time zone. All cutoffs use it.
3. **Extensions → Apps Script**. Delete the sample code and paste in everything from [`apps-script/Code.gs`](apps-script/Code.gs). Save.
4. In the function dropdown pick **`install`** and press **Run**. Google asks for permission; approve it. (On *"Google hasn't verified this app"*: **Advanced → Go to project**. It's your own script.) This creates the tabs and a background trigger.
5. **Deploy → New deployment → ⚙ → Web app**
   - Execute as: **Me**
   - Who has access: **Anyone**
   - Press **Deploy** and copy the **Web app URL** (ends in `/exec`).

> Google Workspace accounts: if "Anyone" isn't offered, your Workspace admin has restricted it. Pick "Anyone within *your company*". Then only people signed in to a company Google account in their browser can use the links.

### 2. Open the app

1. Open the app at https://vivek-kubvt.github.io/officeboy/ (or your own GitHub Pages copy, see below) and tap **Set up or log in as admin**.
2. Paste the web app URL, then enter your office name, your name and an admin password.
3. Go to **People** → **Add person** for each employee and office boy (add desk/floor so deliveries are easy).
4. Tap **Share link** and send it on WhatsApp, Slack or email.

On a new device, the admin logs in with the same web app URL and the admin password.

### Updating the backend later

Paste the new `Code.gs`, then **Deploy → Manage deployments → ✏️ → Version: New version → Deploy**. The URL stays the same, so links keep working.

## Host the app on GitHub Pages

1. Fork this repo, or push it to your GitHub account.
2. In `docs/js/config.js`, set `SETUP_GUIDE_URL` to your repo's README.
3. **Settings → Pages → Build and deployment → Deploy from a branch → `main` / `docs`** → Save.
4. Your app will be at `https://<your-user>.github.io/<repo>/`.

One hosted copy can serve many offices: each share link carries its own sheet's web app ID.

## Security notes

- **A personal link works like a password.** Anyone who has it can order as that person. If a link leaks or someone leaves, use **People → Edit → Reset link**, or deactivate them.
- **Don't share the Google Sheet.** The `Users` tab stores everyone's link tokens. The admin password hash is kept in Script Properties, not in the sheet.
- Admin login is rate-limited (10 wrong attempts → 15 minute lock).
- The web app runs as the admin's Google account but only reads and writes this one spreadsheet.

## The sheet

The script creates these tabs. You can read them, but edit rounds, menu and people from the app.

| Tab | Columns |
|---|---|
| `Settings` | key, value |
| `Users` | id, name, role (`admin`/`employee`/`officeboy`), desk, token, defaultDrink, defaultSugar, autoBook, active, createdAt |
| `Menu` | name, hasSugar, active |
| `Rounds` | id, name, serveTime, cutoffTime, active |
| `Attendance` | date, userId, status (`office`/`wfh`/`leave`), updatedAt |
| `Orders` | date, roundId, userId, drink, sugar, status (`booked`/`skipped`/`delivered`), updatedAt |

Don't sort or re-order `Orders` or `Attendance`. The script reads them newest-first and stops at older dates to stay fast.

**Auto-book:** people with auto-book on count as booked with their usual drink unless they tap *No* or mark WFH/Leave. A trigger every 10 minutes writes those orders into the sheet once a round's cutoff passes, so reports are complete.

## Limits

Apps Script is free but not instant: each tap takes about 1–2 seconds, and the office boy screen refreshes every 20 seconds. It works well for offices of up to about 200 people. Google's daily quotas are far above what one office uses.

## Develop locally

No build step and no dependencies. You need Node 18+.

```bash
node dev/mock-server.mjs
```

Open http://localhost:8787, choose **Set up**, and paste `http://localhost:8787/exec` as the web app URL. The mock runs the real `apps-script/Code.gs` against an in-memory sheet saved in `dev/.mock-db.json` (delete it to reset). Set `MOCK_TZ=Asia/Kolkata` to test another time zone.

Project layout:

```
apps-script/Code.gs     backend (paste into Apps Script)
docs/                   the PWA, served by GitHub Pages
  js/app.js             routing, session, role-based tabs
  js/api.js             web app calls, share links
  js/views/             start/setup, today (employee), board (office boy), admin
  sw.js                 offline app shell. Bump CACHE when you release
dev/mock-server.mjs     local Apps Script stand-in
```

## License

MIT
