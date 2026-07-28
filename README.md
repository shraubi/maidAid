# MaidAid

MaidAid is a small Russian-language PWA that parses a cleaner's pasted workday, highlights ambiguous input, calculates hours, earnings and expenses, and prepares a cumulative report for sharing.

Confirmed work and independently recorded payments are stored in self-hosted PostgreSQL. Confirming the same date replaces that day's work and its text-derived advance in one transaction; manual payments are never replaced with the day.

## Supported input

```text
26/07

Bosquet 9:00-12:00 - самостоятельная уборка
сушка 4.2 + 11.67

Dominique 12:30-15:30 - самостоятельная уборка
сушка 6 + 5.13

16:00 check in Dominiquet - самостоятельное заселение / LX638 flight number
Аванс: 50€
```

Every amount on an expense line is retained: the first amount uses the named category and additional amounts become `расходы`. A standalone amount after a job is also treated as an expense for that job. `Check in`/`заселение` is a flat-priced activity with a 30-minute inferred end and is reported separately from cleaning hours.

Advance formats include `Аванс 50`, `Аванс: 50€`, decimal values, and multiple lines (which are summed). Negative or invalid advances prevent confirmation.

Apartment names are resolved against active PostgreSQL records using exact normalized aliases. Unknown names are left unchanged and receive no apartment details.

## Local development

Requirements: Node.js 22+ and PostgreSQL.

```powershell
Copy-Item .env.example .env
npm.cmd install
npm.cmd test
npm.cmd run dev
```

Configuration:

- `DATABASE_URL` — PostgreSQL connection string;
- `HOURLY_RATE_CENTS` — independent-cleaning hourly rate;
- `ORIENTATION_FLAT_CENTS`, `PRACTICE_FLAT_CENTS`, `CHECKIN_FLAT_CENTS` — flat rates;
- `DRYER_DEFAULT_CENTS` — dryer expense when no amount is present;
- `PREVIEW_RATE_LIMIT_MAX` and `PREVIEW_RATE_LIMIT_WINDOW` — preview rate limit.
- `APARTMENT_IMPORT_TOKEN` — temporary bearer token enabling the one-time apartment import (leave empty to disable it);
- `APARTMENT_CACHE_TTL_MS` — active apartment lookup cache duration.

Startup creates the `work_days` and `payments` tables. The previous SQLite volume remains in Compose for rollback but is not read or migrated.

## API

- `POST /api/preview` returns parsed details, totals, parsed advance, projected balance and projected share text.
- `POST /api/days` transactionally replaces the date and returns the saved day, authoritative running balance and final share text.
- `DELETE /api/days/:dateIso` removes an erroneous day and its text-derived advance; manual payments remain untouched.
- `GET /api/ledger?from=YYYY-MM-DD&to=YYYY-MM-DD` returns chronological rows and totals.
- `POST /api/payments` creates a manual payment using integer `amountCents`.
- `PATCH /api/payments/:id` edits a manual payment.
- `DELETE /api/payments/:id` deletes a manual payment.
- `POST /api/admin/apartments/import?dryRun=true` validates or transactionally upserts `{ apartments: [...] }`; it requires `Authorization: Bearer <APARTMENT_IMPORT_TOKEN>`.
- `GET /health` verifies both the app and PostgreSQL connection.

Text-derived payments can only be changed by confirming their source day again. Expenses remain separate and do not reduce the outstanding balance.

## Deployment

`docker-compose.yml` runs PostgreSQL privately with a persistent volume and no host port. MaidAid waits for the database health check; ngrok waits for MaidAid. Set the application values plus `POSTGRES_PASSWORD`, `NGROK_AUTHTOKEN`, `NGROK_DOMAIN`, and optionally `MAIDAID_HOST_PORT` in the VM `.env`.

GitHub Actions runs unit/API tests and a real PostgreSQL integration test before building. The deployment workflow starts PostgreSQL, MaidAid and ngrok, then smoke-checks the application health endpoint.
