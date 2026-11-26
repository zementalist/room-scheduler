# Room Reservations

Shared room and timetable booking for a university registrar. The Registrar Admin logs in to manage rooms,
semesters and bookings; anyone with the link gets a read-only "which rooms are free?" view.

- **One container** (Node 26, Fastify, SQLite) serves both the API and the web app, behind Caddy for automatic HTTPS.
- **One database file** on a Docker volume, with a daily snapshot written inside the app.
- **Excel in and out**: import with a dry-run preview, export that re-imports losslessly.

```
Browser --> Caddy (HTTPS) --> Node app (API + static web) --> SQLite file on a Docker volume
```

## Why not GitHub Pages

GitHub Pages serves static files only: no server code, no writable database, no login. Browser storage is per
device, so data could never be shared. The app therefore needs a small always-on host; the whole stack is one
`docker compose up`.

## Run it locally (Docker only, no Node install needed)

```powershell
copy .env.example .env      # then edit: set ADMIN_PASSWORD; for local use DOMAIN=:80 and COOKIE_SECURE=false
docker compose up -d --build
```

Open `http://localhost` (or `http://localhost:8080` if you set `HTTP_PORT=8080`) and use **Admin login**.

## Deploy for real

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
