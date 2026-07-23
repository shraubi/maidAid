# MaidAid

MaidAid is a personal WhatsApp assistant that parses a cleaner's schedule and actual work report,
calculates hours, earnings and expenses, stores confirmed days in Google Sheets, and returns a draft
that the user manually copies to management.

It deliberately has:

- no language model;
- no scheduled or unsolicited messages;
- no group support;
- no way to select an arbitrary recipient;
- one allowlisted user phone number.

## Supported input

Schedule:

```text
19/07

*EIFFE* - Ð¾Ð·Ð½Ð°ÐºÐ¾Ð¼Ð»ÐµÐ½Ð¸Ðµ 11 (11:00)
*Federation* - ÑÐ°Ð¼Ð¾ÑÑ‚Ð¾ÑÑ‚ÐµÐ»ÑŒÐ½Ð°Ñ Ñ€Ð°Ð±Ð¾Ñ‚Ð° (12:00-15:30)
*Lauriston 31* - Ð¾Ð·Ð½Ð°ÐºÐ¾Ð¼Ð»ÐµÐ½Ð¸Ðµ (16:00-16:30)
```

Actual work:

```text
19/07 Ð¸Ð·Ð¼ÐµÐ½ÐµÐ½Ð¸Ñ

Eiffel 11:00-14:00 ÑÐ°Ð¼Ð¾ÑÑ‚Ð¾ÑÑ‚ÐµÐ»ÑŒÐ½Ð¾
14:30-15:00 Lauriston 31 Ð¾Ð·Ð½Ð°ÐºÐ¾Ð¼Ð»ÐµÐ½Ð¸Ðµ (Ð’ÐµÑ€Ð¾Ð½Ð¸ÐºÐ°)
15:30-18:00 Opera Ð¾Ð·Ð½Ð°ÐºÐ¾Ð¼Ð»ÐµÐ½Ð¸Ðµ (ÐÐ½Ð°)
Ð¡ÑƒÑˆÐºÐ° Eiffel 3.90
```

If a job has no end, the next job's start is used. Only a final job with no end triggers a focused
question.

## Local setup

Requirements: Node.js 22+.

```powershell
Copy-Item .env.example .env
npm.cmd install
npm.cmd test
npm.cmd run dev
```

For parser-only/local webhook development, set `USE_MEMORY_STORAGE=true`. With no WhatsApp access
token the server logs generated responses instead of sending them. Check `GET /health`.

## Google Sheets

1. Create a Google Cloud service account and enable Google Sheets API.
2. Create a spreadsheet and share it with the service account email as Editor.
3. Put the spreadsheet ID in `GOOGLE_SHEET_ID`.
4. Put the service account JSON (raw JSON or base64) in `GOOGLE_SERVICE_ACCOUNT_CREDENTIALS`.
5. Set `USE_MEMORY_STORAGE=false`.

On startup MaidAid creates and initializes these tabs:

- `Settings`
- `Days`
- `Jobs`
- `Expenses`
- `Messages`
- `Pending`

The default hourly rate is 1000 cents (â‚¬10/hour) and the default dryer expense is 390 cents.
Initial balance values can be changed on the `Settings` tab.

## WhatsApp Cloud API

For an initial test, create a Business app in Meta for Developers, add the WhatsApp product, and use
Meta's test phone number. Add the cleaner's phone as a test recipient.

Configure:

- `WHATSAPP_ACCESS_TOKEN`
- `WHATSAPP_PHONE_NUMBER_ID`
- `WHATSAPP_WABA_ID`
- `WHATSAPP_WEBHOOK_VERIFY_TOKEN`
- `META_APP_SECRET`
- `ALLOWED_USER_PHONE` in international digits-only form

Expose `POST /webhook` over HTTPS and configure the same URL and verify token in Meta. Subscribe the
app to WhatsApp `messages`. `GET /webhook` handles Meta's verification challenge.

The transport always sends to `ALLOWED_USER_PHONE`; callers cannot provide another recipient.

## Commands

- `Ñ€Ð°ÑÐ¿Ð¸ÑÐ°Ð½Ð¸Ðµ`
- `Ð¸Ñ‚Ð¾Ð³`
- `Ð¸ÑÐ¿Ñ€Ð°Ð²Ð¸Ñ‚ÑŒ 19/07`
- `Ñ‡ÐµÑ€Ð½Ð¾Ð²Ð¸Ðº 19/07`
- `Ð±Ð°Ð»Ð°Ð½Ñ`
- `Ð¸ÑÑ‚Ð¾Ñ€Ð¸Ñ`
- `Ð¾Ñ‚Ð¼ÐµÐ½Ð°`

## Production

Build and run:

```powershell
npm.cmd run build
npm.cmd start
```

Or build the included Docker image. Use a single instance for the MVP because Google Sheets is the
transaction store and is intentionally optimized for one user and low volume.

## Deploy to the shared VM

The deployment follows the same GitHub Actions/SSH pattern as `getajob`. Configure these repository
secrets:

- `VM_HOST` â€” the existing VM host;
- `VM_USER` â€” SSH user;
- `VM_SSH_KEY` â€” private deployment key;
- `APP_DIR` â€” MaidAid checkout directory on the VM, for example `/opt/maidaid`.

Prepare the VM once:

```bash
git clone https://github.com/shraubi/maidAid.git /opt/maidaid
cd /opt/maidaid
cp .env.example .env
# Fill in Meta and Google credentials.
docker compose up -d --build maidaid
```

The service listens only on VM loopback at `${MAIDAID_HOST_PORT:-3001}`. Configure the VM's existing
HTTPS reverse proxy to forward the public WhatsApp webhook hostname/path to
`http://127.0.0.1:3001`. Set `MAIDAID_HOST_PORT` in the VM `.env` if port 3001 is already occupied.

Every push to `main` then pulls the repository, rebuilds the `maidaid` Compose service, and restarts
it on the same VM.