# Goodroot fundraising platform

Goodroot is an original, multi-page crowdfunding application for a US / USD launch. It includes a TypeScript server, SQLite persistence, account sessions, fundraiser creation and management, image uploads, organizer updates, and optional Stripe Connect test-mode checkout. It is not affiliated with or a copy of another fundraising platform.

## Requirements

- Node.js 24 or later (uses Node's built-in SQLite module)
- npm
- A Stripe account in test mode to exercise organizer onboarding and checkout

## Local development

```powershell
npm install
Copy-Item .env.example .env
npm run dev
```

Open <http://localhost:4173>. On first run, the app applies migrations in `src/migrations/`, creates `data/goodroot.sqlite`, and seeds six illustrative stories.

Without Stripe keys, accounts, fundraisers, drafts, uploads, and organizer updates work, but checkout is disabled. To test payments:

1. Put your **Stripe test-mode** secret key in `.env` as `STRIPE_SECRET_KEY`.
2. Run `stripe listen --forward-to http://localhost:4173/api/stripe/webhook` and set the printed signing secret as `STRIPE_WEBHOOK_SECRET`.
3. Restart the app, create an account, publish a fundraiser, and connect the Stripe Express test account from the dashboard.
4. Open that fundraiser and use Stripe's published test card numbers in Checkout. Never use live keys or real card details with this app.

`PLATFORM_FEE_BPS` defaults to `0`. It can be set from `0` to `1000` basis points for test-mode destination charges.

## Fundraiser workflow

The five-step creation flow collects the cause and beneficiary, goal and location, title and organizer, story and thank-you note, and an optional cover image. Organizers can save a private draft at any step and finish it later; incomplete drafts cannot be published. Owners can edit fundraisers, publish completed drafts, connect test payouts, and post updates. Only published fundraisers appear publicly.

Image uploads accept JPEG, PNG, or WebP up to 5 MB and are stored with generated filenames under `data/uploads/`. The browser does not send original filenames to the server.

## Docker deployment

Docker Compose runs the production image, health check, and named persistent data volume. Configure a production `.env` before starting it:

```powershell
Copy-Item .env.example .env
```

Set `APP_URL` to the public HTTPS origin and set `SESSION_SECRET` to a unique random value of at least 32 characters. Keep Stripe keys empty unless you are configuring **test mode**. Compose publishes the app only on the host's loopback interface; put a TLS reverse proxy in front of it.

```powershell
docker compose up --build -d
docker compose ps
docker compose logs -f app
```

The app listens on `127.0.0.1:4173` on the host for the reverse proxy. SQLite and uploads persist in the `goodroot-data` Docker volume at `/data`. Back up that volume consistently, including the SQLite database and its WAL files; do not run multiple application replicas against this SQLite database. Migrations are included in the image and are applied on startup.

To stop the service without removing data, use `docker compose down`. Do not use `docker compose down -v` unless you intend to delete the persistent database and uploads.

## Checks

```powershell
npm test
npm audit --omit=dev
```

CI runs the TypeScript build and integration tests, checks production dependencies, and builds the Docker image.

## Implemented

- Registration, login, logout, password hashing, and server-side expiring sessions.
- Searchable fundraiser listings, categories, story pages, campaign updates, and related campaigns.
- Authenticated fundraiser creation, image upload, private drafts, publishing, editing, and dashboard summaries.
- Stripe Connect Express onboarding and Checkout destination charges in test mode only.
- Signed Stripe webhook verification, amount/currency matching, event idempotency, and contribution totals.
- SQLite persistence and migrations, request size limits, same-origin checks, basic rate limits, security headers, container health checks, and persistent container storage.

## Before any real-money launch

This application is **not ready to process live donations**. Live Stripe keys are explicitly rejected. A real launch still needs legal and tax review for the fundraising model, email verification and account recovery, robust abuse/fraud controls, moderation and reporting, privacy and retention policies, monitoring and tested backups, and end-to-end testing against an approved production payment configuration. Contributions count only after a signed, verified Stripe webhook.

Sample fundraiser totals are illustrative display data, not verified payment history. SQLite is appropriate for local development and a single application process, not horizontally scaled production traffic. The Docker configuration is a deployable baseline, not a substitute for production operations, security, and compliance review.
