# MaidAid

MaidAid is a small, stateless PWA for checking a cleaner's schedule or actual work report. It parses
the pasted text, highlights ambiguous input, calculates hours, earnings and expenses, and prepares a
daily report for the device's system share sheet.

The MVP has no accounts, database, history, accumulated balance, or automatic message delivery.
Report text is processed in memory for a single request and is not logged or cached.

## Supported input

Schedule:

```text
19/07

*EIFFE* - ознакомление 11 (11:00)
*Federation* - самостоятельная работа (12:00-15:30)
*Lauriston 31* - ознакомление (16:00-16:30)
```

Actual work:

```text
19/07 изменения

Eiffel 11:00-14:00 самостоятельно
14:30-15:00 Lauriston 31 ознакомление (Вероника)
15:30-18:00 Opera ознакомление (Ана)
Сушка Eiffel 3.90
```

If a job has no end, the next job's start is used. A final job without an end, a missing work type,
overlapping intervals, an invalid date, or any unrecognized line prevents confirmation.

## Local development

Requirements: Node.js 22+.

```powershell
Copy-Item .env.example .env
npm.cmd install
npm.cmd test
npm.cmd run dev
```

Open `http://localhost:3000`. `GET /health` is public.

Configuration:

- `PORT`, `HOST`, `LOG_LEVEL` — server settings;
- `HOURLY_RATE_CENTS` — hourly earnings rate, default `1000`;
- `DRYER_DEFAULT_CENTS` — dryer expense when no amount is present, default `390`;
- `PREVIEW_RATE_LIMIT_MAX` and `PREVIEW_RATE_LIMIT_WINDOW` — per-IP preview limit.

## API

`POST /api/preview` accepts up to 32 KB:

```json
{
  "kind": "actual",
  "text": "19/07 изменения\nEiffel 11-14 самостоятельно"
}
```

The response contains `parsed`, `totals`, `issues`, `unparsedLines`, `canShare`, and `shareText`.
Invalid input returns HTTP 400. The endpoint is rate-limited per client IP.

## PWA behavior

The service worker caches only the application shell (`HTML`, `CSS`, JavaScript, manifest and icon).
API requests and report content are never cached. Sharing starts only after a user click; where the
Web Share API is unavailable, MaidAid copies the final text to the clipboard.

## Production and deployment

The GitHub workflow installs dependencies, runs tests and TypeScript compilation, and builds the
production image on the runner. The image includes the compiled server and static PWA assets.

Set the application values plus `NGROK_AUTHTOKEN`, `NGROK_DOMAIN`, and optionally
`MAIDAID_HOST_PORT` in the VM `.env`. MaidAid is reachable inside the Compose network and on a
loopback diagnostics port; ngrok is the HTTPS ingress.

Deploy the prebuilt services with:

```bash
docker compose pull maidaid ngrok
docker compose up -d --no-build maidaid ngrok
```

Persistent storage and multi-user authorization are intentionally deferred to a later release.
