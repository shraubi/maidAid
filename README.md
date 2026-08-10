# MaidAid

MaidAid is a Russian-language PWA for cleaners to record a workday, calculate hours, earnings and expenses, share a ready report, and keep a private payment ledger.

## How it works

- Choose the date, apartment, work type, duration, and expenses.
- Preview the calculated report before saving and sharing it.
- Review or correct saved work and payments in the monthly ledger.
- Use the shared map for apartments, laundries, and practical notes.

Each cleaner has a private ledger. Places and apartment information are shared across the team. Data is stored in self-hosted PostgreSQL.

## Local development

Requirements: Node.js 22+ and PostgreSQL.

```powershell
Copy-Item .env.example .env
npm.cmd install
npm.cmd test
npm.cmd run dev
```

Copy `.env.example` for local development. Production values are supplied through Docker Compose; first-migration credentials may be passed from the shell instead of being saved in the file.

## API

- `GET /api/auth/me`, `POST /api/auth/login`, `POST /api/auth/register`, and `POST /api/auth/logout` manage cleaner sessions.
- `POST /api/preview` returns parsed details, totals, parsed advance, projected balance and projected share text.
- `POST /api/days` transactionally replaces the date and returns the saved day, authoritative running balance and final share text.
- `DELETE /api/days/:dateIso` removes an erroneous day and its text-derived advance; manual payments remain untouched.
- `GET /api/ledger?from=YYYY-MM-DD&to=YYYY-MM-DD` returns chronological rows and totals.
- `GET /api/apartments` and `GET /api/apartments/:id` return permanent apartment records and the preferred laundry link.
- `POST /api/apartments` and `PATCH /api/apartments/:id` create and update apartments, geocoding a full address when coordinates are absent.
- `GET /api/places`, `POST /api/places`, `PATCH /api/places/:id`, and `DELETE /api/places/:id` manage laundries and partner restaurants.
- `GET /api/apartments/:id/nearby-laundries` finds the three nearest OpenStreetMap candidates; `POST /api/apartments/:id/laundry-links` confirms one for that apartment.
- `POST /api/payments` creates a manual payment using integer `amountCents`.
- `PATCH /api/payments/:id` edits a manual payment.
- `DELETE /api/payments/:id` deletes a manual payment.
- `POST /api/admin/apartments/import?dryRun=true` validates or transactionally upserts `{ apartments: [...] }`; it requires `Authorization: Bearer <APARTMENT_IMPORT_TOKEN>`.
- `GET /health` verifies both the app and PostgreSQL connection.

Text-derived payments can only be changed by confirming their source day again. Expenses remain separate and do not reduce the outstanding balance.

## Deployment

`docker-compose.yml` runs PostgreSQL privately with a persistent volume and no host port. During the verification period, ngrok and Tailscale Funnel both expose the same MaidAid container and database. Set the application values plus `POSTGRES_PASSWORD`, `NGROK_AUTHTOKEN`, and optionally `MAIDAID_HOST_PORT` in the VM `.env`. Ngrok keeps its token-only behavior and assigns the tunnel URL automatically.

Before the first multi-cleaner deployment, temporarily supply `INITIAL_CLEANER_NAME` and `INITIAL_CLEANER_PIN` so existing ledger rows can be assigned safely. They can come from the deployment shell and do not need to be written to `.env`. Startup refuses to migrate legacy rows without them, and they are not used after migration. `TEAM_ACCESS_CODE` remains a runtime secret because the app checks it whenever a colleague creates a profile.

The Tailscale account must have MagicDNS, HTTPS, and Funnel enabled. The persistent `maidaid-tailscale` volume keeps the machine registration and the checked-in Funnel configuration exposes `https://maidaid.<tailnet-name>.ts.net`. Keep the ngrok tunnel active until production verification and explicit approval; ngrok removal belongs in the follow-up cleanup commit.

`TAILSCALE_AUTHKEY` is required only for the first Tailscale enrollment. After the `maidaid-tailscale` volume is populated and the Funnel survives a container restart, remove the key from `.env` and revoke it in the Tailscale admin console.

Server-side cleaner recovery commands:

```powershell
npm.cmd run users -- list
npm.cmd run users -- reset-pin "Cleaner name" 123456
npm.cmd run users -- disable "Cleaner name"
npm.cmd run users -- enable "Cleaner name"
npm.cmd run users -- expire-sessions "Cleaner name"
```

GitHub Actions runs unit/API tests and a real PostgreSQL integration test before building. During the dual-link verification period, the deployment workflow starts PostgreSQL, MaidAid, ngrok, and Tailscale, then checks the application and both ingress processes.
