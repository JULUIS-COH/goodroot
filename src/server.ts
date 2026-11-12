import { createHash, createHmac, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, resolve } from "node:path";
import Stripe from "stripe";
import { database } from "./database.js";

function derivePassword(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, 64, { N: 32768, maxmem: 64 * 1024 * 1024 }, (error, key) => {
      if (error) reject(error);
      else resolve(key as Buffer);
    });
  });
}

const port = Number(process.env.PORT ?? 4173);
const appUrl = new URL(process.env.APP_URL ?? `http://localhost:${port}`);
const sessionSecret = process.env.SESSION_SECRET ?? "";
const stripeSecretKey = process.env.STRIPE_SECRET_KEY ?? "";
const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET ?? "";
const resendApiKey = process.env.RESEND_API_KEY ?? "";
const emailFrom = process.env.EMAIL_FROM ?? "";
const isProduction = process.env.NODE_ENV === "production";
const stripe = stripeSecretKey ? new Stripe(stripeSecretKey) : undefined;
const allowedCategories = new Set(["Community", "Medical", "Education", "Animals", "Environment"]);
const sessionDurationMs = 7 * 24 * 60 * 60 * 1000;
const maxBodyBytes = 8 * 1024 * 1024;
const uploadsDirectory = resolve(process.env.UPLOADS_DIRECTORY ?? "data/uploads");
mkdirSync(uploadsDirectory, { recursive: true });
const rateBuckets = new Map<string, { count: number; resetAt: number }>();
const platformFeeBps = Number(process.env.PLATFORM_FEE_BPS ?? 0);

if (isProduction && sessionSecret.length < 32) {
  throw new Error("SESSION_SECRET must contain at least 32 characters in production.");
}
if (isProduction && appUrl.protocol !== "https:") {
  throw new Error("APP_URL must use HTTPS in production.");
}
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be a valid TCP port.");
}
if (!Number.isInteger(platformFeeBps) || platformFeeBps < 0 || platformFeeBps > 1000) {
  throw new Error("PLATFORM_FEE_BPS must be an integer between 0 and 1000.");
}
if (stripeSecretKey && !stripeSecretKey.startsWith("sk_test_") && !stripeSecretKey.startsWith("sk_live_")) {
  throw new Error("STRIPE_SECRET_KEY must be a Stripe secret key.");
}
if (stripeSecretKey.startsWith("sk_live_")) {
  throw new Error("Live Stripe keys are deliberately disabled in this release. Use test-mode keys only.");
}
if (stripeSecretKey && !stripeWebhookSecret) {
  throw new Error("STRIPE_WEBHOOK_SECRET is required when Stripe test mode is configured.");
}
if (Boolean(resendApiKey) !== Boolean(emailFrom)) {
  throw new Error("RESEND_API_KEY and EMAIL_FROM must be configured together.");
}
if (isProduction && (!resendApiKey || !emailFrom)) {
  throw new Error("RESEND_API_KEY and EMAIL_FROM are required in production for account verification and recovery.");
}

interface UserRow {
  id: string;
  email: string;
  name: string;
  password_salt: string;
  password_hash: string;
  email_verified: number;
  stripe_account_id: string | null;
  created_at: string;
}

type AuthTokenPurpose = "verify_email" | "password_reset";

interface CampaignRow {
  id: string;
  owner_id: string | null;
  category: string;
  title: string;
  organizer: string;
  story: string;
  image: string;
  goal: number;
  seed_raised: number;
  seed_supporters: number;
  location: string;
  featured: number;
  published: number;
  created_at: string;
  updated_at: string;
  raised?: number;
  supporters?: number;
  stripe_account_id?: string | null;
  stripe_payout_ready?: number;
  beneficiary_type?: string;
  beneficiary_name?: string;
  thank_you_note?: string;
  draft?: number;
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(body));
}

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  if (isProduction) response.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; img-src 'self' https://images.unsplash.com data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hashSessionToken(token: string): string {
  return createHmac("sha256", sessionSecret || "goodroot-local-development-only").update(token).digest("hex");
}

function cookieValue(request: IncomingMessage, name: string): string | undefined {
  const cookieHeader = request.headers.cookie;
  if (!cookieHeader) return undefined;
  for (const pair of cookieHeader.split(";")) {
    const [key, ...valueParts] = pair.trim().split("=");
    if (key === name) return valueParts.join("=");
  }
  return undefined;
}

function writeSessionCookie(response: ServerResponse, token: string): void {
  const secure = isProduction ? "; Secure" : "";
  response.setHeader(
    "Set-Cookie",
    `goodroot_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${sessionDurationMs / 1000}${secure}`,
  );
}

function clearSessionCookie(response: ServerResponse): void {
  const secure = isProduction ? "; Secure" : "";
  response.setHeader("Set-Cookie", `goodroot_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`);
}

function resolveSession(request: IncomingMessage): UserRow | undefined {
  const token = cookieValue(request, "goodroot_session");
  if (!token || token.length > 200) return undefined;
  const row = database.prepare(`
    SELECT users.id, users.email, users.name, users.password_salt, users.password_hash,
           users.email_verified,
           users.stripe_account_id, users.created_at
    FROM sessions
    JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.expires_at > ?
  `).get(hashSessionToken(token), new Date().toISOString()) as UserRow | undefined;
  return row;
}

async function createSession(response: ServerResponse, userId: string): Promise<void> {
  const token = randomBytes(32).toString("base64url");
  const now = new Date();
  database.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now.toISOString());
  database.prepare("INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
    .run(hashSessionToken(token), userId, new Date(now.getTime() + sessionDurationMs).toISOString(), now.toISOString());
  writeSessionCookie(response, token);
}

function publicUser(user: UserRow): Record<string, unknown> {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    emailVerified: Boolean(user.email_verified),
    hasPayoutAccount: Boolean(user.stripe_account_id),
  };
}

function createAuthToken(userId: string, purpose: AuthTokenPurpose, expiresInMs: number): string {
  const token = randomBytes(32).toString("base64url");
  const now = new Date();
  database.prepare("DELETE FROM auth_tokens WHERE user_id = ? AND purpose = ?").run(userId, purpose);
  database.prepare(`
    INSERT INTO auth_tokens (token_hash, user_id, purpose, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(sha256(token), userId, purpose, new Date(now.getTime() + expiresInMs).toISOString(), now.toISOString());
  database.prepare("DELETE FROM auth_tokens WHERE expires_at <= ?").run(now.toISOString());
  return token;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]!);
}

async function sendAccountEmail(to: string, subject: string, text: string, html: string, purpose: string): Promise<void> {
  if (!resendApiKey || !emailFrom) {
    if (isProduction) throw new Error("Account email delivery is not configured.");
    console.info(`Development ${purpose} link: ${text.match(/https?:\/\/\S+/)?.[0] ?? "(link unavailable)"}`);
    return;
  }
  const result = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resendApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from: emailFrom, to: [to], subject, text, html }),
    signal: AbortSignal.timeout(10000),
  });
  if (!result.ok) {
    const responseText = await result.text();
    console.error("Resend rejected an account email.", { status: result.status, response: responseText.slice(0, 500) });
    throw new Error("The account email could not be delivered. Check the email provider configuration.");
  }
}

async function sendVerificationEmail(user: Pick<UserRow, "id" | "email" | "name">): Promise<void> {
  const token = createAuthToken(user.id, "verify_email", 24 * 60 * 60 * 1000);
  const verificationUrl = new URL(`/sign-in.html?verify=${encodeURIComponent(token)}`, appUrl).toString();
  const name = escapeHtml(user.name);
  await sendAccountEmail(
    user.email,
    "Verify your Goodroot email",
    `Hi ${user.name},\n\nVerify your email address to activate your Goodroot account:\n${verificationUrl}\n\nThis link expires in 24 hours. If you did not create this account, you can ignore this message.`,
    `<p>Hi ${name},</p><p>Verify your email address to activate your Goodroot account.</p><p><a href="${escapeHtml(verificationUrl)}">Verify my email</a></p><p>This link expires in 24 hours. If you did not create this account, you can ignore this message.</p>`,
    "verify_email",
  );
}

async function sendPasswordResetEmail(user: Pick<UserRow, "id" | "email" | "name">): Promise<void> {
  const token = createAuthToken(user.id, "password_reset", 60 * 60 * 1000);
  const resetUrl = new URL(`/sign-in.html?reset=${encodeURIComponent(token)}`, appUrl).toString();
  const name = escapeHtml(user.name);
  await sendAccountEmail(
    user.email,
    "Reset your Goodroot password",
    `Hi ${user.name},\n\nChoose a new password for your Goodroot account:\n${resetUrl}\n\nThis link expires in one hour. If you did not request a reset, you can ignore this message.`,
    `<p>Hi ${name},</p><p>Use the secure link below to choose a new Goodroot password.</p><p><a href="${escapeHtml(resetUrl)}">Reset my password</a></p><p>This link expires in one hour. If you did not request a reset, you can ignore this message.</p>`,
    "password_reset",
  );
}

function requireUser(request: IncomingMessage, response: ServerResponse): UserRow | undefined {
  const user = resolveSession(request);
  if (!user) json(response, 401, { error: "Please sign in to continue." });
  return user;
}

function checkOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).origin === appUrl.origin;
  } catch {
    return false;
  }
}

function takeRateLimit(request: IncomingMessage, key: string, limit: number, windowMs: number): boolean {
  const address = request.socket.remoteAddress ?? "unknown";
  const bucketKey = `${key}:${address}`;
  const now = Date.now();
  const existing = rateBuckets.get(bucketKey);
  if (!existing || existing.resetAt <= now) {
    rateBuckets.set(bucketKey, { count: 1, resetAt: now + windowMs });
    if (rateBuckets.size > 5000) {
      for (const [entryKey, value] of rateBuckets) {
        if (value.resetAt <= now) rateBuckets.delete(entryKey);
      }
    }
    return true;
  }
  existing.count += 1;
  return existing.count <= limit;
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += data.length;
    if (total > maxBodyBytes) throw Object.assign(new Error("Request body is too large."), { status: 413 });
    chunks.push(data);
  }
  if (total === 0) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("Expected a JSON object.");
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw Object.assign(new Error("Request body must be valid JSON."), { status: 400 });
  }
}

function requiredString(value: unknown, minLength: number, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length >= minLength && normalized.length <= maxLength ? normalized : undefined;
}

function categoryImage(category: string): string {
  const images: Record<string, string> = {
    Medical: "https://images.unsplash.com/photo-1576091160399-112ba8d25d1d?auto=format&fit=crop&w=960&q=85",
    Community: "https://images.unsplash.com/photo-1511632765486-a01980e01a18?auto=format&fit=crop&w=960&q=85",
    Education: "https://images.unsplash.com/photo-1503676260728-1c00da094a0b?auto=format&fit=crop&w=960&q=85",
    Animals: "https://images.unsplash.com/photo-1459262838948-3e2de6c1ec80?auto=format&fit=crop&w=960&q=85",
    Environment: "https://images.unsplash.com/photo-1441974231531-c6227db76b6e?auto=format&fit=crop&w=960&q=85",
  };
  return images[category] ?? images.Community!;
}

function validImageBytes(bytes: Buffer): { extension: string; mimeType: string } | undefined {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return { extension: ".png", mimeType: "image/png" };
  }
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) {
    return { extension: ".jpg", mimeType: "image/jpeg" };
  }
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") {
    return { extension: ".webp", mimeType: "image/webp" };
  }
  return undefined;
}

function campaignRows(whereSql: string, values: (string | number)[] = []): Record<string, unknown>[] {
  return database.prepare(`
    SELECT campaigns.id, campaigns.owner_id, campaigns.category, campaigns.title, campaigns.organizer,
           campaigns.story, campaigns.image, campaigns.goal, campaigns.location, campaigns.featured,
           campaigns.beneficiary_type, campaigns.beneficiary_name, campaigns.thank_you_note,
           campaigns.draft, campaigns.published, campaigns.created_at, campaigns.updated_at,
           campaigns.seed_raised + COALESCE(SUM(CASE WHEN contributions.status = 'completed' THEN contributions.amount ELSE 0 END), 0) / 100 AS raised,
           campaigns.seed_supporters + COALESCE(SUM(CASE WHEN contributions.status = 'completed' THEN 1 ELSE 0 END), 0) AS supporters
    FROM campaigns
    LEFT JOIN contributions ON contributions.campaign_id = campaigns.id
    ${whereSql}
    GROUP BY campaigns.id
    ORDER BY campaigns.created_at DESC
  `).all(...values) as Record<string, unknown>[];
}

function campaignForDonor(id: string, viewerId?: string): CampaignRow | undefined {
  const visibilitySql = viewerId
    ? "(campaigns.published = 1 OR campaigns.owner_id = ?)"
    : "campaigns.published = 1";
  const values = viewerId ? [id, viewerId] : [id];
  return database.prepare(`
    SELECT campaigns.*, users.stripe_account_id, users.stripe_payout_ready,
           campaigns.seed_raised + COALESCE(SUM(CASE WHEN contributions.status = 'completed' THEN contributions.amount ELSE 0 END), 0) / 100 AS raised,
           campaigns.seed_supporters + COALESCE(SUM(CASE WHEN contributions.status = 'completed' THEN 1 ELSE 0 END), 0) AS supporters
    FROM campaigns
    LEFT JOIN users ON users.id = campaigns.owner_id
    LEFT JOIN contributions ON contributions.campaign_id = campaigns.id
    WHERE campaigns.id = ? AND ${visibilitySql}
    GROUP BY campaigns.id
  `).get(...values) as CampaignRow | undefined;
}

function requireStripe(response: ServerResponse): Stripe | undefined {
  if (!stripe) json(response, 503, { error: "Stripe test mode is not configured. Add STRIPE_SECRET_KEY to the local environment." });
  return stripe;
}

async function serveStatic(pathname: string, response: ServerResponse): Promise<void> {
  const page = pathname === "/" ? "/index.html" : pathname;
  const allowedFiles = new Set([
    "/index.html",
    "/explore.html",
    "/campaign.html",
    "/start.html",
    "/dashboard.html",
    "/sign-in.html",
    "/how-it-works.html",
    "/styles.css",
    "/site.js",
    "/app.js",
    "/pages.js",
  ]);
  const uploadedImage = page.match(/^\/uploads\/([a-f0-9-]{36})\.(jpg|png|webp)$/);
  if (!allowedFiles.has(page) && !uploadedImage) {
    json(response, 404, { error: "Page not found." });
    return;
  }
  const file = uploadedImage
    ? resolve(uploadsDirectory, `${uploadedImage[1]}.${uploadedImage[2]}`)
    : resolve(process.cwd(), "public", page === "/" ? "index.html" : page.slice(1));
  if (!existsSync(file)) {
    json(response, 404, { error: "Page not found." });
    return;
  }
  const contentType = extname(file) === ".html" ? "text/html; charset=utf-8"
    : extname(file) === ".css" ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8";
  response.writeHead(200, {
    "Content-Type": uploadedImage ? ({ jpg: "image/jpeg", png: "image/png", webp: "image/webp" }[uploadedImage[2]!]!) : contentType,
    "Cache-Control": uploadedImage ? "public, max-age=31536000, immutable" : "no-cache",
  });
  createReadStream(file).pipe(response);
}

async function handleApi(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
  const { pathname } = url;
  const method = request.method ?? "GET";

  if (pathname === "/api/health" && method === "GET") {
    json(response, 200, { ok: true, payments: stripe ? "stripe-test-mode-configured" : "not-configured" });
    return;
  }

  if (pathname === "/api/stripe/webhook" && method === "POST") {
    if (!stripe || !stripeWebhookSecret) {
      json(response, 503, { error: "Stripe webhook is not configured." });
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      chunks.push(data);
      if (chunks.reduce((size, item) => size + item.length, 0) > 1024 * 1024) {
        json(response, 413, { error: "Webhook payload is too large." });
        return;
      }
    }
    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(Buffer.concat(chunks), request.headers["stripe-signature"] ?? "", stripeWebhookSecret);
    } catch (error) {
      console.error("Stripe webhook signature verification failed.", error);
      json(response, 400, { error: "Invalid webhook signature." });
      return;
    }
    if (event.type !== "checkout.session.completed" && event.type !== "checkout.session.async_payment_succeeded" && event.type !== "checkout.session.expired" && event.type !== "checkout.session.async_payment_failed") {
      json(response, 200, { received: true });
      return;
    }
    const checkout = event.data.object as Stripe.Checkout.Session;
    const contributionId = checkout.metadata?.contributionId;
    if (!contributionId || !checkout.id) {
      json(response, 200, { received: true });
      return;
    }
    const transaction = database.prepare("SELECT id, campaign_id, amount, status FROM contributions WHERE id = ? AND stripe_checkout_session_id = ?");
    const pending = transaction.get(contributionId, checkout.id) as { id: string; campaign_id: string; amount: number; status: string } | undefined;
    if (!pending) {
      console.error("Received Stripe event for an unknown contribution.", { eventId: event.id, checkoutSessionId: checkout.id });
      json(response, 200, { received: true });
      return;
    }
    database.exec("BEGIN IMMEDIATE");
    try {
      const alreadyProcessed = database.prepare("SELECT event_id FROM processed_stripe_events WHERE event_id = ?").get(event.id);
      if (!alreadyProcessed) {
        if (event.type === "checkout.session.expired" || event.type === "checkout.session.async_payment_failed") {
          database.prepare("UPDATE contributions SET status = 'cancelled' WHERE id = ? AND status = 'pending'").run(pending.id);
        } else if (
          checkout.payment_status === "paid" &&
          checkout.currency === "usd" &&
          checkout.amount_total === pending.amount &&
          checkout.metadata?.campaignId === pending.campaign_id
        ) {
          const paymentIntentId = typeof checkout.payment_intent === "string" ? checkout.payment_intent : null;
          database.prepare(`
            UPDATE contributions
            SET status = 'completed', stripe_payment_intent_id = ?, completed_at = ?
            WHERE id = ? AND status = 'pending'
          `).run(paymentIntentId, new Date().toISOString(), pending.id);
        } else {
          console.error("Stripe event did not match the pending contribution.", { eventId: event.id, contributionId });
        }
        database.prepare("INSERT INTO processed_stripe_events (event_id, processed_at) VALUES (?, ?)").run(event.id, new Date().toISOString());
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    json(response, 200, { received: true });
    return;
  }

  if (pathname === "/api/campaigns" && method === "GET") {
    const category = url.searchParams.get("category");
    const query = url.searchParams.get("q")?.trim();
    const conditions = ["campaigns.published = 1"];
    const values: string[] = [];
    if (category && category !== "All causes" && allowedCategories.has(category)) {
      conditions.push("campaigns.category = ?");
      values.push(category);
    }
    if (query && query.length <= 100) {
      conditions.push("(campaigns.title LIKE ? OR campaigns.story LIKE ? OR campaigns.organizer LIKE ? OR campaigns.location LIKE ?)");
      const term = `%${query.replace(/[\\%_]/g, "\\$&")}%`;
      values.push(term, term, term, term);
    }
    const rows = campaignRows(`WHERE ${conditions.join(" AND ")}`, values);
    json(response, 200, { campaigns: rows });
    return;
  }

  const campaignPath = pathname.match(/^\/api\/campaigns\/([a-zA-Z0-9_-]+)(?:\/(connect|connect-status|checkout|publish))?$/);
  if (campaignPath && method === "GET" && !campaignPath[2]) {
    const viewer = resolveSession(request);
    const campaign = campaignForDonor(campaignPath[1]!, viewer?.id);
    if (!campaign) {
      json(response, 404, { error: "Fundraiser not found." });
      return;
    }
    const { stripe_account_id: stripeAccountId } = campaign;
    json(response, 200, {
      campaign: {
        id: campaign.id,
        category: campaign.category,
        title: campaign.title,
        organizer: campaign.organizer,
        story: campaign.story,
        image: campaign.image,
        goal: campaign.goal,
        raised: campaign.raised,
        supporters: campaign.supporters,
        location: campaign.location,
        beneficiary_type: campaign.beneficiary_type,
        beneficiary_name: campaign.beneficiary_name,
        thank_you_note: campaign.thank_you_note,
        draft: Boolean(campaign.draft),
        featured: Boolean(campaign.featured),
        created_at: campaign.created_at,
        can_accept_contributions: Boolean(campaign.stripe_payout_ready) && !campaign.draft,
        can_manage: viewer?.id === campaign.owner_id,
      },
    });
    return;
  }

  if (campaignPath && method === "POST" && campaignPath[2] === "publish") {
    const user = requireUser(request, response);
    if (!user) return;
    const campaign = database.prepare("SELECT id, title, story, goal, beneficiary_name FROM campaigns WHERE id = ? AND owner_id = ? AND draft = 1")
      .get(campaignPath[1]!, user.id) as { id: string; title: string; story: string; goal: number; beneficiary_name: string } | undefined;
    if (!campaign) {
      json(response, 404, { error: "Draft fundraiser not found." });
      return;
    }
    if (campaign.title.length < 5 || campaign.story.length < 15 || campaign.goal < 1 || campaign.beneficiary_name.length < 2) {
      json(response, 400, { error: "Complete the fundraiser details before publishing." });
      return;
    }
    database.prepare("UPDATE campaigns SET published = 1, draft = 0, updated_at = ? WHERE id = ? AND owner_id = ?")
      .run(new Date().toISOString(), campaign.id, user.id);
    const [published] = campaignRows("WHERE campaigns.id = ?", [campaign.id]);
    json(response, 200, { campaign: published });
    return;
  }

  if (pathname === "/api/auth/me" && method === "GET") {
    const user = resolveSession(request);
    json(response, 200, { user: user ? publicUser(user) : null });
    return;
  }

  if (pathname === "/api/auth/verify" && method === "POST") {
    if (!takeRateLimit(request, "auth:verify-email", 20, 15 * 60 * 1000)) {
      json(response, 429, { error: "Too many verification attempts. Please wait and try again." });
      return;
    }
    const body = await readJson(request);
    const token = requiredString(body.token, 20, 200);
    if (!token) {
      json(response, 400, { error: "This verification link is invalid or has expired." });
      return;
    }
    const now = new Date().toISOString();
    const authToken = database.prepare(`
      SELECT user_id FROM auth_tokens
      WHERE token_hash = ? AND purpose = 'verify_email' AND expires_at > ?
    `).get(sha256(token), now) as { user_id: string } | undefined;
    if (!authToken) {
      json(response, 400, { error: "This verification link is invalid or has expired." });
      return;
    }
    database.exec("BEGIN IMMEDIATE");
    try {
      const consumed = database.prepare(`
        DELETE FROM auth_tokens
        WHERE token_hash = ? AND user_id = ? AND purpose = 'verify_email' AND expires_at > ?
      `).run(sha256(token), authToken.user_id, now);
      if (consumed.changes !== 1) {
        database.exec("ROLLBACK");
        json(response, 400, { error: "This verification link is invalid or has expired." });
        return;
      }
      database.prepare("UPDATE users SET email_verified = 1 WHERE id = ?").run(authToken.user_id);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    json(response, 200, { message: "Your email is verified. You can now sign in." });
    return;
  }

  if (pathname === "/api/auth/verification-email" && method === "POST") {
    if (!takeRateLimit(request, "auth:resend-verification", 5, 15 * 60 * 1000)) {
      json(response, 429, { error: "Too many requests. Please wait before trying again." });
      return;
    }
    const body = await readJson(request);
    const email = requiredString(body.email, 5, 254)?.toLocaleLowerCase("en-US");
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      json(response, 400, { error: "Enter a valid email address." });
      return;
    }
    const user = database.prepare("SELECT id, email, name, email_verified FROM users WHERE email = ?")
      .get(email) as (Pick<UserRow, "id" | "email" | "name"> & { email_verified: number }) | undefined;
    if (user && !user.email_verified) await sendVerificationEmail(user);
    json(response, 202, { message: "If your account needs verification, we’ll email you a new link." });
    return;
  }

  if (pathname === "/api/auth/password-reset" && method === "POST") {
    if (!takeRateLimit(request, "auth:password-reset", 5, 15 * 60 * 1000)) {
      json(response, 429, { error: "Too many requests. Please wait before trying again." });
      return;
    }
    const body = await readJson(request);
    const email = requiredString(body.email, 5, 254)?.toLocaleLowerCase("en-US");
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      json(response, 400, { error: "Enter a valid email address." });
      return;
    }
    const user = database.prepare("SELECT id, email, name, email_verified FROM users WHERE email = ?")
      .get(email) as (Pick<UserRow, "id" | "email" | "name"> & { email_verified: number }) | undefined;
    if (user?.email_verified) await sendPasswordResetEmail(user);
    json(response, 202, { message: "If an account uses that email, we’ll send password reset instructions." });
    return;
  }

  if (pathname === "/api/auth/password-reset/confirm" && method === "POST") {
    if (!takeRateLimit(request, "auth:password-reset-confirm", 10, 15 * 60 * 1000)) {
      json(response, 429, { error: "Too many attempts. Please wait and try again." });
      return;
    }
    const body = await readJson(request);
    const token = requiredString(body.token, 20, 200);
    const password = typeof body.password === "string" ? body.password : "";
    if (!token) {
      json(response, 400, { error: "This password reset link is invalid or has expired." });
      return;
    }
    if (password.length < 12 || password.length > 128) {
      json(response, 400, { error: "Use a password between 12 and 128 characters." });
      return;
    }
    const now = new Date().toISOString();
    const authToken = database.prepare(`
      SELECT user_id FROM auth_tokens
      WHERE token_hash = ? AND purpose = 'password_reset' AND expires_at > ?
    `).get(sha256(token), now) as { user_id: string } | undefined;
    if (!authToken) {
      json(response, 400, { error: "This password reset link is invalid or has expired." });
      return;
    }
    const salt = randomBytes(16).toString("hex");
    const passwordHash = await derivePassword(password, salt);
    database.exec("BEGIN IMMEDIATE");
    try {
      const consumed = database.prepare(`
        DELETE FROM auth_tokens
        WHERE token_hash = ? AND user_id = ? AND purpose = 'password_reset' AND expires_at > ?
      `).run(sha256(token), authToken.user_id, now);
      if (consumed.changes !== 1) {
        database.exec("ROLLBACK");
        json(response, 400, { error: "This password reset link is invalid or has expired." });
        return;
      }
      database.prepare("UPDATE users SET password_salt = ?, password_hash = ? WHERE id = ?")
        .run(salt, passwordHash.toString("hex"), authToken.user_id);
      database.prepare("DELETE FROM auth_tokens WHERE user_id = ? AND purpose = 'password_reset'").run(authToken.user_id);
      database.prepare("DELETE FROM sessions WHERE user_id = ?").run(authToken.user_id);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    clearSessionCookie(response);
    json(response, 200, { message: "Your password has been updated. Sign in with your new password." });
    return;
  }

  if ((pathname === "/api/auth/register" || pathname === "/api/auth/login") && method === "POST") {
    const operation = pathname.endsWith("register") ? "register" : "login";
    if (!takeRateLimit(request, `auth:${operation}`, 10, 15 * 60 * 1000)) {
      json(response, 429, { error: "Too many attempts. Please wait and try again." });
      return;
    }
    const body = await readJson(request);
    const email = requiredString(body.email, 5, 254)?.toLocaleLowerCase("en-US");
    const password = typeof body.password === "string" ? body.password : "";
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      json(response, 400, { error: "Enter a valid email address." });
      return;
    }
    if (operation === "register") {
      const name = requiredString(body.name, 2, 60);
      if (!name || password.length < 12 || password.length > 128) {
        json(response, 400, { error: "Use a name and a password between 12 and 128 characters." });
        return;
      }
      const salt = randomBytes(16).toString("hex");
      const passwordHash = await derivePassword(password, salt);
      const id = randomUUID();
      try {
        database.prepare(`
          INSERT INTO users (id, email, name, password_salt, password_hash, email_verified, created_at)
          VALUES (?, ?, ?, ?, ?, 0, ?)
        `).run(id, email, name, salt, passwordHash.toString("hex"), new Date().toISOString());
      } catch (error) {
        if (error instanceof Error && error.message.includes("UNIQUE constraint failed: users.email")) {
          json(response, 409, { error: "An account with this email already exists." });
          return;
        }
        throw error;
      }
      await sendVerificationEmail({ id, email, name });
      json(response, 201, { message: "Check your email for a link to verify your account." });
      return;
    }
    if (password.length === 0 || password.length > 128) {
      json(response, 400, { error: "Check your email and password." });
      return;
    }
    const user = database.prepare("SELECT * FROM users WHERE email = ?").get(email) as UserRow | undefined;
    if (!user) {
      await derivePassword(password, randomBytes(16).toString("hex"));
      json(response, 401, { error: "Email or password is incorrect." });
      return;
    }
    const candidate = await derivePassword(password, user.password_salt);
    const expected = Buffer.from(user.password_hash, "hex");
    if (candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) {
      json(response, 401, { error: "Email or password is incorrect." });
      return;
    }
    if (!user.email_verified) {
      json(response, 403, { error: "Verify your email before signing in. You can request a new verification link below." });
      return;
    }
    await createSession(response, user.id);
    json(response, 200, { user: publicUser(user) });
    return;
  }

  if (pathname === "/api/auth/logout" && method === "POST") {
    const token = cookieValue(request, "goodroot_session");
    if (token) database.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashSessionToken(token));
    clearSessionCookie(response);
    json(response, 200, { ok: true });
    return;
  }

  if (pathname === "/api/uploads/images" && method === "POST") {
    const user = requireUser(request, response);
    if (!user) return;
    if (!takeRateLimit(request, "image-upload", 30, 60 * 60 * 1000)) {
      json(response, 429, { error: "Too many image uploads. Please wait and try again." });
      return;
    }
    const body = await readJson(request);
    if (typeof body.dataUrl !== "string" || body.dataUrl.length > 7 * 1024 * 1024) {
      json(response, 400, { error: "Choose an image smaller than 5 MB." });
      return;
    }
    const match = body.dataUrl.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/);
    if (!match) {
      json(response, 400, { error: "Upload a JPEG, PNG, or WebP image." });
      return;
    }
    const imageBytes = Buffer.from(match[2]!, "base64");
    const image = validImageBytes(imageBytes);
    if (!image || image.mimeType !== match[1] || imageBytes.length > 5 * 1024 * 1024) {
      json(response, 400, { error: "The image is invalid, unsupported, or larger than 5 MB." });
      return;
    }
    const filename = `${randomUUID()}${image.extension}`;
    writeFileSync(resolve(uploadsDirectory, filename), imageBytes, { flag: "wx" });
    json(response, 201, { imageUrl: `/uploads/${filename}` });
    return;
  }

  if (pathname === "/api/campaigns" && method === "POST") {
    const user = requireUser(request, response);
    if (!user) return;
    const body = await readJson(request);
    const status = body.status === "draft" ? "draft" : "published";
    const title = requiredString(body.title, 5, 90);
    const organizer = requiredString(body.organizer, 2, 80);
    const story = requiredString(body.story, 15, 1200);
    const requestedCategory = typeof body.category === "string" ? body.category : "";
    const category = allowedCategories.has(requestedCategory) ? requestedCategory : status === "draft" ? "Community" : requestedCategory;
    const requestedGoal = Number(body.goal);
    const goal = Number.isSafeInteger(requestedGoal) && requestedGoal >= 1 && requestedGoal <= 10000000
      ? requestedGoal
      : status === "draft" ? 1 : requestedGoal;
    const location = body.location === undefined ? "" : requiredString(body.location, 0, 100);
    const requestedBeneficiaryType = body.beneficiaryType === undefined
      ? "self"
      : typeof body.beneficiaryType === "string" ? body.beneficiaryType : "";
    const beneficiaryType = ["self", "someone", "charity", "community"].includes(requestedBeneficiaryType)
      ? requestedBeneficiaryType
      : status === "draft" ? "self" : requestedBeneficiaryType;
    const beneficiaryName = body.beneficiaryName === undefined ? organizer : requiredString(body.beneficiaryName, 2, 80);
    const requestedImageUrl = body.imageUrl === undefined || body.imageUrl === "" ? undefined : requiredString(body.imageUrl, 1, 200);
    const imageUrl = requestedImageUrl ?? categoryImage(category);
    const thankYouNote = body.thankYouNote === undefined ? "" : requiredString(body.thankYouNote, 0, 500);
    const validBeneficiaryType = ["self", "someone", "charity", "community"].includes(String(beneficiaryType));
    const validImage = Boolean(imageUrl && (imageUrl.startsWith("/uploads/") || imageUrl.startsWith("https://images.unsplash.com/")));
    const campaignTitle = title ?? (status === "draft" ? "" : undefined);
    const campaignOrganizer = organizer ?? (status === "draft" ? "" : undefined);
    const campaignStory = story ?? (status === "draft" ? "" : undefined);
    const campaignBeneficiaryName = beneficiaryName ?? (status === "draft" ? "" : undefined);
    if (campaignTitle === undefined || campaignOrganizer === undefined || campaignStory === undefined || !allowedCategories.has(category) || !validBeneficiaryType || campaignBeneficiaryName === undefined || imageUrl === undefined || !validImage || thankYouNote === undefined || !Number.isSafeInteger(goal) || goal < 1 || goal > 10000000 || location === undefined) {
      json(response, 400, { error: "Check the title, story, cause, beneficiary, image, location, and fundraising goal." });
      return;
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    database.prepare(`
      INSERT INTO campaigns
        (id, owner_id, category, title, organizer, story, image, goal, location, beneficiary_type, beneficiary_name, thank_you_note, published, draft, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, user.id, category, campaignTitle, campaignOrganizer, campaignStory, imageUrl, goal, location, beneficiaryType, campaignBeneficiaryName, thankYouNote, status === "published" ? 1 : 0, status === "draft" ? 1 : 0, now, now);
    const [campaign] = campaignRows("WHERE campaigns.id = ?", [id]);
    json(response, 201, { campaign });
    return;
  }

  if (pathname === "/api/me/campaigns" && method === "GET") {
    const user = requireUser(request, response);
    if (!user) return;
    const campaigns = campaignRows("WHERE campaigns.owner_id = ?", [user.id]);
    json(response, 200, { campaigns });
    return;
  }

  const updateEndpoint = pathname.match(/^\/api\/campaigns\/([a-zA-Z0-9_-]+)\/updates$/);
  if (updateEndpoint && method === "GET") {
    const viewer = resolveSession(request);
    const campaign = campaignForDonor(updateEndpoint[1]!, viewer?.id);
    if (!campaign) {
      json(response, 404, { error: "Fundraiser not found." });
      return;
    }
    const updates = database.prepare(`
      SELECT id, title, body, created_at FROM campaign_updates
      WHERE campaign_id = ? ORDER BY created_at DESC LIMIT 50
    `).all(updateEndpoint[1]!);
    json(response, 200, { updates });
    return;
  }

  if (updateEndpoint && method === "POST") {
    const user = requireUser(request, response);
    if (!user) return;
    const ownsCampaign = database.prepare("SELECT id FROM campaigns WHERE id = ? AND owner_id = ?")
      .get(updateEndpoint[1]!, user.id);
    if (!ownsCampaign) {
      json(response, 404, { error: "Fundraiser not found." });
      return;
    }
    const body = await readJson(request);
    const title = requiredString(body.title, 3, 100);
    const story = requiredString(body.body, 10, 2000);
    if (!title || !story) {
      json(response, 400, { error: "Write an update title and a message between 10 and 2,000 characters." });
      return;
    }
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    database.prepare("INSERT INTO campaign_updates (id, campaign_id, author_id, title, body, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, updateEndpoint[1]!, user.id, title, story, createdAt);
    json(response, 201, { update: { id, title, body: story, created_at: createdAt } });
    return;
  }

  const updatePath = pathname.match(/^\/api\/campaigns\/([a-zA-Z0-9_-]+)$/);
  if (updatePath && method === "PATCH") {
    const user = requireUser(request, response);
    if (!user) return;
    const existing = database.prepare(`
      SELECT id, category, title, organizer, story, goal, location, image, beneficiary_type,
             beneficiary_name, thank_you_note, draft
      FROM campaigns WHERE id = ? AND owner_id = ?
    `).get(updatePath[1]!, user.id) as {
      id: string;
      category: string;
      title: string;
      organizer: string;
      story: string;
      goal: number;
      location: string;
      image: string;
      beneficiary_type: string;
      beneficiary_name: string;
      thank_you_note: string;
      draft: number;
    } | undefined;
    if (!existing) {
      json(response, 404, { error: "Fundraiser not found." });
      return;
    }
    const body = await readJson(request);
    const isDraft = Boolean(existing.draft);
    const title = body.title === undefined ? existing.title : requiredString(body.title, isDraft ? 0 : 5, 90);
    const organizer = body.organizer === undefined ? existing.organizer : requiredString(body.organizer, isDraft ? 0 : 2, 80);
    const story = body.story === undefined ? existing.story : requiredString(body.story, isDraft ? 0 : 15, 1200);
    const category = body.category === undefined ? existing.category : body.category;
    const requestedGoal = body.goal === undefined ? existing.goal : Number(body.goal);
    const goal = isDraft && (!Number.isSafeInteger(requestedGoal) || requestedGoal < 1 || requestedGoal > 10000000)
      ? existing.goal
      : requestedGoal;
    const location = body.location === undefined ? existing.location : requiredString(body.location, 0, 100);
    const beneficiaryType = body.beneficiaryType === undefined ? existing.beneficiary_type : body.beneficiaryType;
    const beneficiaryName = body.beneficiaryName === undefined
      ? existing.beneficiary_name
      : requiredString(body.beneficiaryName, isDraft ? 0 : 2, 80);
    const thankYouNote = body.thankYouNote === undefined
      ? existing.thank_you_note
      : requiredString(body.thankYouNote, 0, 500);
    const image = body.imageUrl === undefined || body.imageUrl === "" ? existing.image : requiredString(body.imageUrl, 1, 200);
    const validImage = Boolean(image && (image.startsWith("/uploads/") || image.startsWith("https://images.unsplash.com/")));
    const validBeneficiaryType = typeof beneficiaryType === "string" && ["self", "someone", "charity", "community"].includes(beneficiaryType);
    if (title === undefined || organizer === undefined || story === undefined || typeof category !== "string" || !allowedCategories.has(category) || !validBeneficiaryType || beneficiaryName === undefined || thankYouNote === undefined || !Number.isSafeInteger(goal) || goal < 1 || goal > 10000000 || location === undefined || image === undefined || !validImage) {
      json(response, 400, { error: "Check the fundraiser details and try again." });
      return;
    }
    database.prepare(`
      UPDATE campaigns
      SET title = ?, organizer = ?, story = ?, category = ?, goal = ?, location = ?, image = ?,
          beneficiary_type = ?, beneficiary_name = ?, thank_you_note = ?, updated_at = ?
      WHERE id = ? AND owner_id = ?
    `).run(title, organizer, story, category, goal, location, image, beneficiaryType, beneficiaryName, thankYouNote, new Date().toISOString(), existing.id, user.id);
    const [campaign] = campaignRows("WHERE campaigns.id = ?", [existing.id]);
    json(response, 200, { campaign });
    return;
  }

  if (campaignPath && method === "POST" && campaignPath[2] === "connect") {
    const user = requireUser(request, response);
    if (!user) return;
    const payments = requireStripe(response);
    if (!payments) return;
    const campaign = database.prepare(`
      SELECT campaigns.id, users.stripe_account_id FROM campaigns
      JOIN users ON users.id = campaigns.owner_id WHERE campaigns.id = ? AND campaigns.owner_id = ?
    `).get(campaignPath[1]!, user.id) as { id: string; stripe_account_id: string | null } | undefined;
    if (!campaign) {
      json(response, 404, { error: "Fundraiser not found." });
      return;
    }
    let accountId = campaign.stripe_account_id;
    if (!accountId) {
      const account = await payments.accounts.create({
        type: "express",
        country: "US",
        email: user.email,
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
        },
        metadata: { goodroot_user_id: user.id },
      });
      accountId = account.id;
      database.prepare("UPDATE users SET stripe_account_id = ? WHERE id = ?").run(accountId, user.id);
    }
    const accountLink = await payments.accountLinks.create({
      account: accountId,
      refresh_url: `${appUrl.origin}/dashboard.html?connect=refresh`,
      return_url: `${appUrl.origin}/dashboard.html?connect=return`,
      type: "account_onboarding",
    });
    json(response, 200, { url: accountLink.url });
    return;
  }

  if (campaignPath && method === "GET" && campaignPath[2] === "connect-status") {
    const user = requireUser(request, response);
    if (!user) return;
    const payments = requireStripe(response);
    if (!payments) return;
    const campaign = database.prepare(`
      SELECT campaigns.id, users.stripe_account_id FROM campaigns
      JOIN users ON users.id = campaigns.owner_id WHERE campaigns.id = ? AND campaigns.owner_id = ?
    `).get(campaignPath[1]!, user.id) as { id: string; stripe_account_id: string | null } | undefined;
    if (!campaign) {
      json(response, 404, { error: "Fundraiser not found." });
      return;
    }
    if (!campaign.stripe_account_id) {
      json(response, 200, { connected: false, ready: false });
      return;
    }
    const account = await payments.accounts.retrieve(campaign.stripe_account_id);
    if (account.deleted) {
      database.prepare("UPDATE users SET stripe_account_id = NULL, stripe_payout_ready = 0 WHERE id = ?").run(user.id);
      json(response, 200, { connected: false, ready: false });
      return;
    }
    const ready = account.details_submitted && account.charges_enabled && account.payouts_enabled;
    database.prepare("UPDATE users SET stripe_payout_ready = ? WHERE id = ?").run(ready ? 1 : 0, user.id);
    json(response, 200, {
      connected: true,
      ready,
      detailsSubmitted: account.details_submitted,
      chargesEnabled: account.charges_enabled,
      payoutsEnabled: account.payouts_enabled,
    });
    return;
  }

  if (campaignPath && method === "POST" && campaignPath[2] === "checkout") {
    if (!takeRateLimit(request, "checkout", 20, 60 * 60 * 1000)) {
      json(response, 429, { error: "Too many contribution attempts. Please try again later." });
      return;
    }
    const payments = requireStripe(response);
    if (!payments) return;
    const campaign = campaignForDonor(campaignPath[1]!);
    if (!campaign) {
      json(response, 404, { error: "Fundraiser not found." });
      return;
    }
    if (!campaign.owner_id || !campaign.stripe_account_id || campaign.draft) {
      json(response, 409, { error: "This fundraiser is not connected to a payout account yet." });
      return;
    }
    const body = await readJson(request);
    const amount = Number(body.amount);
    const donorName = requiredString(body.name, 2, 60);
    const donorEmail = requiredString(body.email, 5, 254)?.toLocaleLowerCase("en-US");
    if (!Number.isSafeInteger(amount) || amount < 1 || amount > 999999 || !donorName || !donorEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(donorEmail)) {
      json(response, 400, { error: "Enter a valid whole-dollar contribution up to $999,999, name, and email." });
      return;
    }
    const account = await payments.accounts.retrieve(campaign.stripe_account_id);
    if (account.deleted || !account.details_submitted || !account.charges_enabled || !account.payouts_enabled) {
      json(response, 409, { error: "The fundraiser organizer must finish payment account setup before accepting contributions." });
      return;
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    const amountInCents = amount * 100;
    database.prepare(`
      INSERT INTO contributions (id, campaign_id, donor_name, amount, currency, status, created_at)
      VALUES (?, ?, ?, ?, 'usd', 'pending', ?)
    `).run(id, campaign.id, donorName, amountInCents, now);
    try {
      const fee = Math.floor(amountInCents * platformFeeBps / 10000);
      const checkout = await payments.checkout.sessions.create({
        mode: "payment",
        customer_email: donorEmail,
        client_reference_id: id,
        line_items: [{
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: amountInCents,
            product_data: { name: `Contribution to ${campaign.title}`, description: `Goodroot fundraiser · ${campaign.category}` },
          },
        }],
        metadata: { contributionId: id, campaignId: campaign.id },
        payment_intent_data: {
          transfer_data: { destination: campaign.stripe_account_id },
          ...(fee > 0 ? { application_fee_amount: fee } : {}),
        },
        success_url: `${appUrl.origin}/campaign.html?id=${encodeURIComponent(campaign.id)}&payment=success`,
        cancel_url: `${appUrl.origin}/campaign.html?id=${encodeURIComponent(campaign.id)}&payment=cancelled`,
      });
      database.prepare("UPDATE contributions SET stripe_checkout_session_id = ? WHERE id = ?").run(checkout.id, id);
      if (!checkout.url) throw new Error("Stripe did not return a checkout URL.");
      json(response, 201, { checkoutUrl: checkout.url });
    } catch (error) {
      database.prepare("DELETE FROM contributions WHERE id = ? AND status = 'pending'").run(id);
      throw error;
    }
    return;
  }

  json(response, 404, { error: "API endpoint not found." });
}

const server = createServer(async (request, response) => {
  setSecurityHeaders(response);
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    const isApi = url.pathname.startsWith("/api/");
    if (isApi && request.method !== "GET" && request.method !== "HEAD" && !checkOrigin(request) && url.pathname !== "/api/stripe/webhook") {
      json(response, 403, { error: "Request origin is not allowed." });
      return;
    }
    if (isApi) {
      await handleApi(request, response, url);
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      json(response, 405, { error: "Method not allowed." });
      return;
    }
    await serveStatic(decodeURIComponent(url.pathname), response);
  } catch (error) {
    const status = typeof error === "object" && error !== null && "status" in error ? Number(error.status) : 500;
    if (status >= 500) console.error("Request failed.", error);
    if (!response.headersSent) json(response, status >= 400 && status < 600 ? status : 500, { error: status === 413 ? "Request body is too large." : status === 400 ? "Invalid request." : "An unexpected server error occurred." });
    else response.destroy(error instanceof Error ? error : undefined);
  }
});

server.listen(port, isProduction ? "0.0.0.0" : "127.0.0.1", () => {
  console.log(`Goodroot server listening at ${appUrl.origin}`);
  console.log(`Database: ${process.env.DATABASE_PATH ?? "data/goodroot.sqlite"}`);
  console.log(`Stripe test mode: ${stripe ? "configured" : "not configured"}`);
});

function shutdown(): void {
  server.close(() => {
    database.close();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
