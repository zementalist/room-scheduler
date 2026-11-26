# Room Reservations

Shared room and timetable booking for a university registrar. The Registrar Admin logs in to manage rooms,
semesters and bookings; anyone with the link gets a read-only "which rooms are free?" view.

- **Excel in and out**: import with a dry-run preview, export that re-imports losslessly.
- **Same rules in both editions**: a booking clashes when it is in the same room, the times overlap (back-to-back is
  fine) and the calendar scopes intersect (weekly bookings are bounded by their semester).

There are two ways to run it. They share the UI and the scheduling rules.

| | **GitHub Pages edition** (default) | **Server edition** |
|---|---|---|
| Cost | $0, no card | A small always-on host |
| Data | `schedule/data.json` in this repo (every save is a commit) | SQLite file |
| Admin sign-in | A GitHub access token pasted into the app | Username and password |
| Public view | Instant for the admin, about a minute for visitors after a save | Instant |
| Best for | One registrar, a modest timetable, nothing to maintain | Several admins, real logins, no public repository |

```
Pages:   Browser --> static site (GitHub Pages) + schedule/data.json
                 \-> (admin only) GitHub API --> commit to schedule/data.json --> site republished
Server:  Browser --> Caddy (HTTPS) --> Node app (API + static web) --> SQLite file on a Docker volume
```

## GitHub Pages edition

Everything is built and published by `.github/workflows/pages.yml` on each push to `main`.

- **Visitors** open the site and see the read-only "which rooms are free?" view. The data is the published
  `data.json` next to the page.
- **The admin** clicks *Admin login* and pastes an access token. From then on every change (add a booking, import
  a sheet, ...) is checked in the browser (clash rules) and committed to `schedule/data.json` through the GitHub
  API, so you get a full history for free: to undo something, revert that commit. The page reloads the newest
  committed copy before each change, and a save is refused (not overwritten) if the file changed in between.
- **Excel import/export** runs in the browser.

### Admin token

1. GitHub -> Settings -> Developer settings -> Personal access tokens -> **Fine-grained tokens** -> Generate new token.
2. *Repository access*: **Only select repositories** -> this repository. *Permissions* -> Repository permissions ->
   **Contents: Read and write**. Nothing else. Pick an expiry (up to a year) and note it in your calendar.
3. Paste the token into the app's login box. It is kept in that browser's local storage only; *Log out* forgets it.

Anyone holding the token can change the schedule, so treat it like a password. If it leaks, delete it on GitHub
(Settings -> Personal access tokens) and make a new one; nothing else needs to change.

### Things to know

- On GitHub Free, Pages needs a **public repository**: the code *and the timetable data* are publicly readable
  (the page shows the same data anyway). Do not put anything private in the schedule.
- A save becomes visible to visitors after the site republishes (usually under two minutes).
- One admin at a time is the design. Two people saving at once is safe (the second is told to retry) but not smooth.
- GitHub's rules (no commercial SaaS, soft bandwidth limits) are fine for a department timetable.
- Moving to the server edition later is an Excel export plus an import.

### Set it up on your own copy

1. Push this repo to GitHub, make it public, and set *Settings -> Pages -> Source* to **GitHub Actions**.
2. Push to `main` (or run the *Publish site* workflow). The site appears at `https://<user>.github.io/<repo>/`.
3. Create the admin token (above), open the site, log in, and import your Excel sheet.

Local preview: `VITE_BACKEND=static VITE_GH_REPO=<user>/<repo> npm run build`, then serve `web/dist`.

## Server edition: run it locally (Docker only, no Node install needed)

```powershell
copy .env.example .env      # then edit: set ADMIN_PASSWORD; for local use DOMAIN=:80 and COOKIE_SECURE=false
docker compose up -d --build
```

Open `http://localhost` (or `http://localhost:8080` if you set `HTTP_PORT=8080`) and use **Admin login**.

## Server edition: deploy for real

You need one always-on machine that can run Docker, and a host name pointing at it.

1. **Host.** Ask university IT for a small VM or a sub-domain first (free). Otherwise a ~EUR 4-5/month VPS (for example Hetzner)
   is plenty. Avoid free tiers for the primary copy: many sleep or wipe local disk, which would lose the SQLite file.
2. **DNS.** Point an A record (for example `rooms.youruniversity.edu`) at the machine and open ports 80 and 443.
3. **Configure.** Copy the project to the machine and create `.env`:

   ```
   ADMIN_USERNAME=registrar
   ADMIN_PASSWORD=<long passphrase, 8+ characters>
   DOMAIN=rooms.youruniversity.edu
   COOKIE_SECURE=true
   ```

4. **Start.** `docker compose up -d --build`. Caddy obtains and renews the HTTPS certificate automatically.

To change the admin password, edit `ADMIN_PASSWORD` in `.env` and run `docker compose up -d`; every existing session is signed out.

### Backups (important)

- The app writes `/data/backups/scheduler-YYYY-MM-DD.db` once a day (and at startup) and keeps the newest `BACKUP_KEEP` (default 14).
- These live on the **same disk** as the database, so also copy them off the machine. For example, from the host:

  ```
  docker compose cp app:/data/backups ./backups-copy
  ```

  Schedule that with cron or Task Scheduler and send it somewhere else.
- The admin **Export to Excel** button is a second, human-readable backup.

**Restore** a snapshot (stops the app briefly):

```
docker compose stop app
docker compose run --rm --no-deps -v "$(pwd)/backups-copy:/restore" app sh -c "cp /restore/scheduler-2026-11-26.db /data/scheduler.db && rm -f /data/scheduler.db-wal /data/scheduler.db-shm"
docker compose start app
```

## Free hosting on Render (no disk) with Litestream

Render's free web service has an ephemeral disk and sleeps after 15 idle minutes. To keep the data anyway, the image runs
[Litestream](https://litestream.io): on every start it restores `scheduler.db` from an S3-compatible bucket when the local file is
missing, and while running it streams each change to the bucket (about once a second, flushed on shutdown). It is switched on
only when `LITESTREAM_BUCKET` is set. If the bucket is unreachable at start, the app refuses to start rather than run unprotected.

1. Create a free [Backblaze B2](https://www.backblaze.com/cloud-storage) account (10 GB free, no card), a **private** bucket, and an
   application key restricted to that bucket. Note the bucket's endpoint (`s3.<region>.backblazeb2.com`) and region.
2. Render -> New -> Blueprint -> pick this repo (`render.yaml`). Fill in the prompted variables: `ADMIN_PASSWORD`,
   `LITESTREAM_BUCKET`, `LITESTREAM_ENDPOINT`, `LITESTREAM_REGION`, `LITESTREAM_ACCESS_KEY_ID` (B2 keyID), `LITESTREAM_SECRET_ACCESS_KEY` (B2 applicationKey).
3. Open the `.onrender.com` link. The first visit after a sleep takes about a minute while the container starts and restores.
   A free uptime pinger (for example UptimeRobot, every 5 minutes on `/api/health`) avoids most sleeps.

Run exactly one instance: two instances replicating to one bucket would corrupt the replica.

## Moving the data from the old HTML tool

1. Open the old `Room Reservations (1).html`, click **Export to Excel**.
2. In the new app: log in, **Semesters** -> create the current semester with its real first and last day.
3. **Import Excel sheet** -> choose the exported file, pick that semester for the weekly rows, and review the preview:
   rooms found, bookings ready, skipped rows with the row number and reason, and clashes. Nothing is saved until you press Import.
4. Compare the header line (rooms / schedule bookings / events) with the old app's before announcing the new link.

If the old export has a weekly slot that now clashes with a one-off booking, it is listed under **Clashes** instead of being imported silently.

## Excel format

One row per booking, or one row per room that has none. Headers are matched by exact name (case and spacing ignored):

| Column | Accepted headers | Notes |
|---|---|---|
| Room (required) | Room, Room Name, Hall, Location, Classroom | Room identity ignores case and extra spaces |
| Building, Capacity, Type | Building; Capacity, Seats; Type | Capacity is a whole number |
| Course | Course, Class, Subject, Title, Event | Free text |
| Category | Category | `Event` is an event; anything else is a schedule booking |
| Date (booking) | Date, Day, Weekday | `2026-03-02` for a date, or `Monday` for a weekly slot |
| Start / End | Start, From / End, To | `09:00`, `9:30 pm`, an Excel time, or a whole hour such as `9` |
| Semester | Semester, Term | Weekly rows only; falls back to the semester chosen in the dialog |

Slash dates such as `03/04/2026` are rejected as ambiguous rather than guessed. The **Download a template** link in the import dialog gives a ready-made file.

## Rules the app enforces

- Two bookings in one room clash when their times overlap (back-to-back is fine) **and** they can fall on the same real day.
- A weekly booking repeats only between its semester's first and last day, so a one-off booking after the term, or in another term, does not clash with it.
- Every create, edit and import is re-checked **on the server** inside a transaction; the browser preview is only a convenience.
- **Begin new semester** creates the new term, makes it current, and (optionally) clears all schedule bookings. Rooms and events are always kept.

## Development

Everything runs in the Node 26 image; no local Node is required.

```powershell
docker run --rm -v "${PWD}:/app" -w /app node:26-slim npm install
docker run --rm -v "${PWD}:/app" -w /app node:26-slim npm test           # 44 tests
docker run --rm -v "${PWD}:/app" -w /app node:26-slim npm run typecheck
docker run --rm -v "${PWD}:/app" -w /app node:26-slim node scripts/make-sample.ts   # sample/ workbook to try the importer
```

With a local Node 24+ you can instead run `npm run dev:server` (API on :3000, needs `ADMIN_PASSWORD` and `COOKIE_SECURE=false`) and `npm run dev:web` (Vite on :5173, proxies `/api`).

Layout: `shared/` (time helpers and the conflict engine, used by server and browser), `server/` (Fastify, SQLite, Excel), `web/` (React + Vite).
The server runs TypeScript directly (Node's built-in type stripping), so there is no server build step.

## Security notes

- Admin login only; passwords are hashed with scrypt, sessions are random tokens stored hashed, cookies are `HttpOnly`, `SameSite=Lax` and `Secure` (HTTPS).
- Login is rate limited; state-changing requests with a foreign `Origin` header are rejected.
- Public visitors can read rooms, course names and times (the same information as a posted timetable) and cannot change anything.

## Out of scope for this version

One admin account only; no student self-booking or approval flow; no requester or contact fields; no "cancel just this week"
exceptions; no PDF or calendar (ICS) export. These slot in cleanly on top of the current model.
