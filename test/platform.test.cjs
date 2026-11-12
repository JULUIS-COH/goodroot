const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const { once } = require("node:events");
const { createServer } = require("node:net");
const { readFileSync } = require("node:fs");
const { DatabaseSync } = require("node:sqlite");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { after, test } = require("node:test");
const Stripe = require("stripe");

const webhookSecret = "whsec_goodroot_integration_test_secret";
const stripeForTest = new Stripe("sk_test_goodroot_integration");

let child;
let temporaryDirectory;
let baseUrl;
let origin;
let cookie;
let startupOutput = "";

async function unusedPort() {
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate a local port.");
  await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function request(path, { method = "GET", body, authenticated = false, requestOrigin = origin } = {}) {
  const headers = { origin: requestOrigin };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (authenticated && cookie) headers.cookie = cookie;
  return fetch(`${baseUrl}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function developmentToken(purpose) {
  const queryName = purpose === "verify_email" ? "verify" : "reset";
  const pattern = new RegExp(`Development ${purpose} link: https?[^\\s]*[?&]${queryName}=([A-Za-z0-9_-]+)`, "g");
  const tokens = [...startupOutput.matchAll(pattern)];
  assert.ok(tokens.length > 0, `Server did not emit a development ${purpose} link:\n${startupOutput}`);
  return tokens[tokens.length - 1][1];
}

after(async () => {
  if (child && child.exitCode === null) {
    child.kill();
    await once(child, "exit");
  }
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
});

test("accounts, fundraiser management, and API access work end to end", { timeout: 90000 }, async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "goodroot-platform-"));
  const port = await unusedPort();
  baseUrl = `http://127.0.0.1:${port}`;
  origin = baseUrl;
  child = spawn(process.execPath, ["--env-file-if-exists=.env", "dist/src/server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(port),
      APP_URL: baseUrl,
      DATABASE_PATH: join(temporaryDirectory, "test.sqlite"),
      SESSION_SECRET: "integration-test-secret-that-is-long-enough",
      STRIPE_SECRET_KEY: "sk_test_goodroot_integration",
      STRIPE_WEBHOOK_SECRET: webhookSecret,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  startupOutput = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { startupOutput += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { startupOutput += chunk; });
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Server exited during startup:\n${startupOutput}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  assert.equal(ready, true, `Server failed to start:\n${startupOutput}`);

  const health = await request("/api/health");
  assert.deepEqual(await health.json(), { ok: true, payments: "stripe-test-mode-configured" });
  assert.equal((await request("/.env")).status, 404);
  assert.equal((await request("/src/server.ts")).status, 404);

  const seeded = await request("/api/campaigns");
  assert.equal(seeded.status, 200);
  assert.equal((await seeded.json()).campaigns.length, 6);

  const crossOrigin = await request("/api/auth/register", {
    method: "POST",
    requestOrigin: "https://not-goodroot.example",
    body: { name: "Test Organizer", email: "organizer@example.com", password: "A-long-test-password-123" },
  });
  assert.equal(crossOrigin.status, 403);

  const unauthenticatedCreate = await request("/api/campaigns", {
    method: "POST",
    body: { title: "Test fundraiser", category: "Community", story: "A sufficiently long fundraiser story.", goal: 100 },
  });
  assert.equal(unauthenticatedCreate.status, 401);

  const registration = await request("/api/auth/register", {
    method: "POST",
    body: { name: "Test Organizer", email: "organizer@example.com", password: "A-long-test-password-123" },
  });
  assert.equal(registration.status, 201);
  assert.match((await registration.json()).message, /verify your account/i);
  assert.equal(registration.headers.get("set-cookie"), null);
  const unverifiedLogin = await request("/api/auth/login", {
    method: "POST",
    body: { email: "organizer@example.com", password: "A-long-test-password-123" },
  });
  assert.equal(unverifiedLogin.status, 403);
  const verificationToken = developmentToken("verify_email");
  const verification = await request("/api/auth/verify", {
    method: "POST",
    body: { token: verificationToken },
  });
  assert.equal(verification.status, 200);
  assert.equal((await verification.json()).message, "Your email is verified. You can now sign in.");
  assert.equal((await request("/api/auth/verify", { method: "POST", body: { token: verificationToken } })).status, 400);

  const registrationResend = await request("/api/auth/verification-email", {
    method: "POST",
    body: { email: "organizer@example.com" },
  });
  assert.equal(registrationResend.status, 202);
  assert.match((await registrationResend.json()).message, /if your account needs verification/i);

  const unknownPasswordReset = await request("/api/auth/password-reset", {
    method: "POST",
    body: { email: "nobody@example.com" },
  });
  assert.equal(unknownPasswordReset.status, 202);
  const passwordResetRequest = await request("/api/auth/password-reset", {
    method: "POST",
    body: { email: "organizer@example.com" },
  });
  assert.equal(passwordResetRequest.status, 202);
  assert.equal((await passwordResetRequest.json()).message, (await unknownPasswordReset.clone().json()).message);

  const resetToken = developmentToken("password_reset");
  const invalidPasswordReset = await request("/api/auth/password-reset/confirm", {
    method: "POST",
    body: { token: resetToken, password: "short" },
  });
  assert.equal(invalidPasswordReset.status, 400);

  const login = await request("/api/auth/login", {
    method: "POST",
    body: { email: "organizer@example.com", password: "A-long-test-password-123" },
  });
  assert.equal(login.status, 200);
  cookie = login.headers.get("set-cookie").split(";")[0];
  assert.ok(cookie.startsWith("goodroot_session="));
  const currentUser = (await (await request("/api/auth/me", { authenticated: true })).json()).user;
  assert.equal(currentUser.email, "organizer@example.com");
  assert.equal(currentUser.emailVerified, true);

  const uploaded = await request("/api/uploads/images", {
    method: "POST",
    authenticated: true,
    body: { dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lWQAAAAASUVORK5CYII=" },
  });
  assert.equal(uploaded.status, 201);
  const uploadedImage = (await uploaded.json()).imageUrl;
  assert.equal((await request(uploadedImage)).status, 200);
  const rejectedImage = await request("/api/uploads/images", {
    method: "POST",
    authenticated: true,
    body: { dataUrl: "data:image/svg+xml;base64,PHN2Zy8+" },
  });
  assert.equal(rejectedImage.status, 400);

  const created = await request("/api/campaigns", {
    method: "POST",
    authenticated: true,
    body: {
      title: "A new community garden",
      organizer: "Austin Garden Neighbors",
      category: "Community",
      story: "We are raising money to create a welcoming garden for our neighborhood.",
      goal: "3000",
      location: "Austin, Texas",
      imageUrl: uploadedImage,
    },
  });
  assert.equal(created.status, 201);
  const campaign = (await created.json()).campaign;
  assert.equal(campaign.goal, 3000);
  assert.equal(campaign.raised, 0);

  const search = await request("/api/campaigns?q=neighborhood");
  assert.equal((await search.json()).campaigns.length, 2);

  const detail = await request(`/api/campaigns/${campaign.id}`);
  const detailCampaign = (await detail.json()).campaign;
  assert.equal(detailCampaign.title, "A new community garden");
  assert.equal(detailCampaign.image, uploadedImage);
  assert.equal(detailCampaign.can_accept_contributions, false);
  assert.equal("stripe_account_id" in detailCampaign, false);
  assert.equal("owner_id" in detailCampaign, false);

  const update = await request(`/api/campaigns/${campaign.id}`, {
    method: "PATCH",
    authenticated: true,
    body: { title: "A renewed community garden", goal: 4000 },
  });
  assert.equal(update.status, 200);
  assert.equal((await update.json()).campaign.title, "A renewed community garden");
  assert.equal((await (await request(`/api/campaigns/${campaign.id}`)).json()).campaign.image, uploadedImage);

  const campaignUpdate = await request(`/api/campaigns/${campaign.id}/updates`, {
    method: "POST",
    authenticated: true,
    body: { title: "First garden update", body: "We have picked the first planting beds and gathered volunteers." },
  });
  assert.equal(campaignUpdate.status, 201);
  const campaignUpdates = await request(`/api/campaigns/${campaign.id}/updates`);
  assert.equal((await campaignUpdates.json()).updates[0].title, "First garden update");

  const incompleteDraftResponse = await request("/api/campaigns", {
    method: "POST",
    authenticated: true,
    body: { status: "draft" },
  });
  assert.equal(incompleteDraftResponse.status, 201);
  const incompleteDraft = (await incompleteDraftResponse.json()).campaign;
  assert.equal(incompleteDraft.draft, 1);
  assert.equal(incompleteDraft.title, "");
  assert.equal((await request(`/api/campaigns/${incompleteDraft.id}`)).status, 404);
  assert.equal((await request(`/api/campaigns/${incompleteDraft.id}`, { authenticated: true })).status, 200);
  const partialDraftUpdate = await request(`/api/campaigns/${incompleteDraft.id}`, {
    method: "PATCH",
    authenticated: true,
    body: { category: "Community", beneficiaryType: "community", beneficiaryName: "Eastwood neighbors" },
  });
  assert.equal(partialDraftUpdate.status, 200);
  assert.equal((await partialDraftUpdate.json()).campaign.beneficiary_name, "Eastwood neighbors");
  const incompletePublish = await request(`/api/campaigns/${incompleteDraft.id}/publish`, {
    method: "POST",
    authenticated: true,
    body: {},
  });
  assert.equal(incompletePublish.status, 400);

  const completedDraft = await request(`/api/campaigns/${incompleteDraft.id}`, {
    method: "PATCH",
    authenticated: true,
    body: {
      title: "A private draft fundraiser",
      organizer: "Austin Garden Neighbors",
      category: "Community",
      story: "This complete story is still private until its organizer publishes it.",
      goal: 1800,
      beneficiaryType: "community",
      beneficiaryName: "Eastwood neighbors",
    },
  });
  assert.equal(completedDraft.status, 200);
  assert.equal((await request(`/api/campaigns/${incompleteDraft.id}`)).status, 404);
  assert.equal((await request(`/api/campaigns/${incompleteDraft.id}/publish`, { method: "POST" })).status, 401);
  const publishedDraft = await request(`/api/campaigns/${incompleteDraft.id}/publish`, {
    method: "POST",
    authenticated: true,
    body: {},
  });
  assert.equal(publishedDraft.status, 200);
  assert.equal((await publishedDraft.json()).campaign.draft, 0);

  const list = await request("/api/me/campaigns", { authenticated: true });
  assert.equal((await list.json()).campaigns.length, 2);

  const noStripe = await request(`/api/campaigns/${campaign.id}/checkout`, {
    method: "POST",
    body: { amount: 25, name: "Donor", email: "donor@example.com" },
  });
  assert.equal(noStripe.status, 409);

  const pendingContributionId = "test-webhook-contribution";
  const checkoutSessionId = "cs_test_goodroot_integration";
  const contributionDb = new DatabaseSync(join(temporaryDirectory, "test.sqlite"));
  contributionDb.prepare(`
    INSERT INTO contributions (id, campaign_id, donor_name, amount, currency, status, stripe_checkout_session_id, created_at)
    VALUES (?, ?, ?, ?, 'usd', 'pending', ?, ?)
  `).run(pendingContributionId, campaign.id, "Test Donor", 2500, checkoutSessionId, new Date().toISOString());
  contributionDb.close();

  const webhookEvent = {
    id: "evt_goodroot_integration",
    object: "event",
    api_version: "2025-03-31.basil",
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: checkoutSessionId,
        object: "checkout.session",
        amount_total: 2500,
        currency: "usd",
        payment_status: "paid",
        payment_intent: "pi_goodroot_integration",
        metadata: { contributionId: pendingContributionId, campaignId: campaign.id },
      },
    },
    livemode: false,
    pending_webhooks: 1,
    request: null,
    type: "checkout.session.completed",
  };
  const rawEvent = JSON.stringify(webhookEvent);
  const signature = stripeForTest.webhooks.generateTestHeaderString({ payload: rawEvent, secret: webhookSecret });
  const invalidWebhook = await fetch(`${baseUrl}/api/stripe/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json", "stripe-signature": "invalid" },
    body: rawEvent,
  });
  assert.equal(invalidWebhook.status, 400);

  const deliverWebhook = () => fetch(`${baseUrl}/api/stripe/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json", "stripe-signature": signature },
    body: rawEvent,
  });
  assert.equal((await deliverWebhook()).status, 200);
  assert.equal((await deliverWebhook()).status, 200);
  const updatedCampaign = await request(`/api/campaigns/${campaign.id}`);
  assert.equal((await updatedCampaign.json()).campaign.raised, 25);

  const logout = await request("/api/auth/logout", { method: "POST", authenticated: true });
  assert.equal(logout.status, 200);
  assert.equal((await (await request("/api/auth/me")).json()).user, null);

  const logoutLogin = await request("/api/auth/login", {
    method: "POST",
    body: { email: "organizer@example.com", password: "A-long-test-password-123" },
  });
  assert.equal(logoutLogin.status, 200);
  cookie = logoutLogin.headers.get("set-cookie").split(";")[0];

  const resetWithSession = await request("/api/auth/password-reset/confirm", {
    method: "POST",
    authenticated: true,
    body: { token: resetToken, password: "An-even-better-password-456" },
  });
  assert.equal(resetWithSession.status, 200);
  assert.equal((await (await request("/api/auth/me", { authenticated: true })).json()).user, null);
  assert.equal((await request("/api/auth/login", {
    method: "POST",
    body: { email: "organizer@example.com", password: "A-long-test-password-123" },
  })).status, 401);
  const newPasswordLogin = await request("/api/auth/login", {
    method: "POST",
    body: { email: "organizer@example.com", password: "An-even-better-password-456" },
  });
  assert.equal(newPasswordLogin.status, 200);
  assert.equal((await request("/api/auth/password-reset/confirm", {
    method: "POST",
    body: { token: resetToken, password: "Another-password-that-is-strong-789" },
  })).status, 400);
});

test("live Stripe keys are rejected", () => {
  const result = spawnSync(process.execPath, ["--env-file-if-exists=.env", "dist/src/server.js"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: "4173",
      DATABASE_PATH: join(temporaryDirectory, "live-key.sqlite"),
      SESSION_SECRET: "integration-test-secret-that-is-long-enough",
      STRIPE_SECRET_KEY: "sk_live_intentionally_rejected",
      STRIPE_WEBHOOK_SECRET: "whsec_integration_test_secret",
    },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Live Stripe keys are deliberately disabled/);
});

test("account-security migration preserves existing accounts", () => {
  const legacyDatabasePath = join(temporaryDirectory, "legacy.sqlite");
  const legacyDatabase = new DatabaseSync(legacyDatabasePath);
  legacyDatabase.exec(readFileSync(join(process.cwd(), "src/migrations/001_core.sql"), "utf8"));
  legacyDatabase.exec(readFileSync(join(process.cwd(), "src/migrations/002_campaign_creation.sql"), "utf8"));
  legacyDatabase.exec("CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
  legacyDatabase.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)")
    .run("001_core.sql", new Date().toISOString());
  legacyDatabase.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)")
    .run("002_campaign_creation.sql", new Date().toISOString());
  legacyDatabase.prepare(`
    INSERT INTO users (id, email, name, password_salt, password_hash, created_at)
    VALUES ('legacy-user', 'legacy@example.com', 'Legacy Organizer', 'salt', 'hash', ?)
  `).run(new Date().toISOString());
  legacyDatabase.close();

  const migration = spawnSync(process.execPath, ["--input-type=module", "-e", "import('./dist/src/database.js')"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, DATABASE_PATH: legacyDatabasePath },
  });
  assert.equal(migration.status, 0, `${migration.stdout}\n${migration.stderr}`);

  const upgradedDatabase = new DatabaseSync(legacyDatabasePath);
  const user = upgradedDatabase.prepare("SELECT email_verified FROM users WHERE id = 'legacy-user'").get();
  assert.equal(user.email_verified, 1);
  const authTokens = upgradedDatabase.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'auth_tokens'").get();
  assert.ok(authTokens);
  upgradedDatabase.close();
});

test("production refuses to start without account email delivery", () => {
  const result = spawnSync(process.execPath, ["--env-file-if-exists=.env", "dist/src/server.js"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: "4173",
      APP_URL: "https://goodroot.example",
      DATABASE_PATH: join(temporaryDirectory, "production-email.sqlite"),
      SESSION_SECRET: "production-test-session-secret-with-more-than-32-characters",
      RESEND_API_KEY: "",
      EMAIL_FROM: "",
      STRIPE_SECRET_KEY: "",
      STRIPE_WEBHOOK_SECRET: "",
    },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /RESEND_API_KEY and EMAIL_FROM are required in production/);
});
