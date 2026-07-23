# MaidAid

MaidAid is a small, stateless PWA for checking a cleaner's workday. It parses
the pasted text, highlights ambiguous input, calculates hours, earnings and expenses, and prepares a
daily report for the device's system share sheet.

The MVP has no accounts, database, history, accumulated balance, or automatic message delivery.
Report text is processed in memory for a single request and is not logged or cached.

## Supported input

```text
19/07 изменения

1. 10:00-11:00 St Denis ознакомление
2. 14:00-16:30 Ferronnerie практика
3. 17:00-19:00 Opera самостоятельно
Сушка Eiffel 3.90
```

The interface auto-detects whether the text describes a schedule or an actual day. Numbered-list
markers are removed from apartment names, and repeated activity descriptions in parentheses are
ignored.

If a job has no end, the next job's start is used. A final job without an end, a missing work type,
overlapping intervals, an invalid date, or any unrecognized line prevents confirmation.

Pricing:

- orientation — EUR 10 per apartment;
- independent cleaning — EUR 10 per hour;
- practice — EUR 15 per apartment.

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
- `HOURLY_RATE_CENTS` — independent-cleaning hourly rate, default `1000`;
- `ORIENTATION_FLAT_CENTS` — orientation price per apartment, default `1000`;
- `PRACTICE_FLAT_CENTS` — practice price per apartment, default `1500`;
- `DRYER_DEFAULT_CENTS` — dryer expense when no amount is present, default `390`;
- `PREVIEW_RATE_LIMIT_MAX` and `PREVIEW_RATE_LIMIT_WINDOW` — per-IP preview limit.

## API

`POST /api/preview` accepts up to 32 KB:

```json
{
  "text": "19/07 изменения\nEiffel 11-14 самостоятельно"
}
```

The optional `kind` field remains accepted for API compatibility, but the PWA does not ask the user
to choose it.

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
