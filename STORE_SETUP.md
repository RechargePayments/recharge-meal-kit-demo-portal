# Store Setup Guide

This guide walks you through connecting the demo portal to your own Recharge + Shopify store. No coding experience is required for most steps — you'll mainly be copying values into a configuration file.

---

## Prerequisites

Before you begin, make sure you have:

- **Node.js 18 or higher** installed on your computer ([download here](https://nodejs.org/))
- A **Recharge merchant account** with an active store
- A **Shopify store** connected to that Recharge account
- The store must have at least one **bundle subscription product** with the `enable_future_charge_manipulation` beta flag enabled (contact your Recharge rep if unsure)
- At least one customer on the store with active bundle subscriptions and queued charges

---

## Step 1: Get Your Recharge API Tokens

You need **two** Recharge tokens for this portal:

### 1a. Merchant API Key (server-side admin operations)

1. Log in to your Recharge merchant admin at `https://your-store.admin.rechargeapps.com`
2. Go to **Apps & Integrations** (or navigate to **Settings → API tokens** if on an older layout)
3. Click **Create API token**
4. Give it a descriptive name like "Demo Portal — Merchant"
5. Grant it the following scopes (at minimum):
   - `read_customers`, `write_customers`
   - `read_subscriptions`, `write_subscriptions`
   - `read_charges`, `write_charges`
   - `read_payment_methods`
   - `read_addresses`, `write_addresses`
   - `read_onetimes`, `write_onetimes`
   - `read_notifications`, `write_notifications`
6. Copy the generated API key — it will look like `sk_1x1_...` (production) or `sk_test_2x2_...` (staging)

> **Staging vs Production:** If you're testing, use a staging/sandbox store. Staging API keys start with `sk_test_2x2_` and use `https://api.rechargeapps.com`. Production keys start with `sk_1x1_`.

### 1b. Storefront Access Token (passwordless customer login)

The portal uses Recharge's storefront passwordless email-code flow to authenticate customers. This requires a **separate** storefront access token.

1. In the same **API tokens** screen, click **Create API token** again
2. Choose the **Storefront** token type (sometimes labelled "Customer-facing" or similar)
3. Give it a descriptive name like "Demo Portal — Storefront"
4. Grant it scopes for the customer-facing surface (read/write customers, subscriptions, charges, addresses, payment methods, bundle selections)
5. Copy the generated token — it must start with `strfnt`

You'll put both values in `.env` in Step 3.

---

## Step 2: Get Your Shopify App Credentials

The portal fetches product images and collection data from Shopify. It needs a Shopify app with "client credentials" grant (no OAuth redirect required).

1. Go to [partners.shopify.com](https://partners.shopify.com) and log in
2. Open your Partner Dashboard → **Apps**
3. Either select an existing app or create a new one:
   - Click **Create app** → choose **Create app manually**
   - Give it a name like "Demo Portal Products"
4. Go to the app's **Configuration** tab
5. Under **Access scopes**, add:
   - `read_products`
   - `read_product_listings`
6. Save and create a new version if prompted
7. Install the app on your Shopify store
8. Note down:
   - **Client ID** — visible on the app overview page
   - **Client Secret** — starts with `shpss_`, found under **API credentials** or **Client credentials**

---

## Step 3: Create Your `.env` File

1. In the project folder, find the file named `.env.example`
2. Make a copy of it and name the copy `.env`
3. Open `.env` in any text editor (Notepad, TextEdit, VS Code, etc.)
4. Fill in each value:

```
RECHARGE_API_KEY=sk_1x1_your_api_key_here
RECHARGE_API_URL=https://api.rechargeapps.com
RECHARGE_ADMIN_URL=https://your-store.admin.rechargeapps.com
RECHARGE_STOREFRONT_ACCESS_TOKEN=strfnt_your_storefront_access_token
SHOPIFY_STORE_DOMAIN=your-store.myshopify.com
SHOPIFY_CLIENT_ID=your_client_id_here
SHOPIFY_CLIENT_SECRET=shpss_your_client_secret_here
SESSION_SECRET=generate_a_random_64_char_hex_string
```

| Variable | Where to Find It | Example |
|----------|-----------------|---------|
| `RECHARGE_API_KEY` | Recharge admin → API tokens, **Merchant** type (Step 1a) | `sk_1x1_ae03b81acd928...` |
| `RECHARGE_API_URL` | Always `https://api.rechargeapps.com` | `https://api.rechargeapps.com` |
| `RECHARGE_ADMIN_URL` | Your Recharge admin URL (the URL in your browser when logged in) | `https://my-store.admin.rechargeapps.com` |
| `RECHARGE_STOREFRONT_ACCESS_TOKEN` | Recharge admin → API tokens, **Storefront** type (Step 1b). Must start with `strfnt` | `strfnt_b7c1...` |
| `SHOPIFY_STORE_DOMAIN` | Your Shopify admin → Settings → Domains, or the `.myshopify.com` URL | `my-store.myshopify.com` |
| `SHOPIFY_CLIENT_ID` | Shopify Partners → your app → Overview (Step 2) | `00d8b0271f65191a58d3...` |
| `SHOPIFY_CLIENT_SECRET` | Shopify Partners → your app → API credentials (Step 2) | `shpss_5cd9ebc6fdfc847...` |
| `SESSION_SECRET` | Generate locally — see below | `4ed5444da9bcf2868e67c5c6a4e5eb27...` |

### Generating `SESSION_SECRET`

The session cookie is signed with this secret. The app refuses to start without it. Generate a high-entropy value:

```bash
# macOS / Linux
openssl rand -hex 32

# Or, anywhere Node is installed
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

- Use a **different** secret in production than in local `.env`.
- Never commit the production value (the `.env` file is already in `.gitignore`).
- Treat it like a database password — anyone with the secret can forge a customer session.
- Rotating it logs out every active session.

---

## Step 4: Configure Bundle Product in Merchant Admin (Required)

Bundle variant IDs are no longer hardcoded in source code. Instead, the merchant chooses the active bundle directly in the merchant admin UI.

1. Start the app and open `http://localhost:5173/merchant`
2. In the **Bundle Product** panel at the top:
   - Select the dynamic bundle you want to manage
   - The rest of the merchant settings (collections, defaults, add-ons, lock window, delivery offset) are scoped to that bundle
3. Repeat for each bundle product you want to configure

If you are upgrading from an older version of this demo, existing config is automatically migrated to the previous default bundle variant on first run so your current settings are preserved.

**How to find your bundle variant ID:**
- Go to your Shopify admin → **Products**
- Find your bundle subscription product (the one customers subscribe to)
- Click on it and look at the URL — it will contain the product ID
- If the product has a single variant, you can find the variant ID by:
  - Clicking into the variant
  - Looking at the URL: `admin/products/PRODUCT_ID/variants/VARIANT_ID`
  - The `VARIANT_ID` number is what you need
- Alternatively, in Recharge admin, go to a subscription that uses this bundle product and look at the `external_variant_id` field

---

## Step 5: Clear the Store-Specific Data (You can just instruct Claude or an LLM to do this for you)

The `data/` folder contains JSON files with IDs from the previously connected store. You need to reset these.

1. Open the `data/` folder in the project
2. Replace the contents of each file with its empty/default state:

**`data/customer-preferences.json`** — replace with:
```json
{
  "preferences": {}
}
```

**`data/bundle-defaults.json`** — replace with:
```json
{}
```

**`data/week-assignments.json`** — replace with:
```json
{}
```

**`data/addon-collections.json`** — replace with:
```json
{}
```

**`data/merchant-settings.json`** — you can keep this as-is or adjust:
```json
{
  "activeBundleVariantId": null,
  "bundles": {}
}
```
- `activeBundleVariantId`: The bundle currently selected in merchant admin
- `bundles`: Per-bundle settings keyed by bundle `external_variant_id` (each bundle stores its own assignments, defaults, add-ons, delivery offset, and lock window)

---

## Step 6: (Optional) Replace the Logo

The file `public/logo.png` is the brand logo shown in the portal header. Replace it with your store's logo if desired. Keep the filename as `logo.png`.

---

## Step 7: Install Dependencies and Run

Open a terminal/command prompt in the project folder and run:

```bash
npm install
```

Then start the portal:

```bash
npm run dev
```

The portal will be available at **http://localhost:5173**

---

## Step 8: First-Time Use

1. Open http://localhost:5173 in your browser. You'll be redirected to `/login`.
2. Enter the email address of a customer on your store and submit.
3. Recharge sends a 6-digit verification code to that email. The portal redirects to `/login/verify`.
4. Enter the code. On success you're redirected to your delivery dashboard at `/<your-customer-id>`.
5. The session lasts ~55 minutes. After it expires, you'll be redirected back to `/login` automatically and can sign in again.
6. To sign out manually, visit `/logout`.
7. Navigate to `/merchant` (there's a "Merchant portal" link at the bottom of the login page) to:
   - Assign Shopify collections to upcoming weeks
   - Configure delivery offset and modification windows
   - Set up add-on collections

> **Note:** The customer's email in **Recharge** must match the inbox you can actually receive mail at. Recharge sends the verification code to the email on the customer record — typically the email synced from Shopify.

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| "RECHARGE_API_KEY is not set" error | Make sure your `.env` file exists in the project root and has the correct key |
| "SESSION_SECRET is not set" error at startup | Generate one with `openssl rand -hex 32` and add it to `.env` |
| "RECHARGE_STOREFRONT_ACCESS_TOKEN is not set" when trying to log in | Create a **Storefront**-type token in the Recharge admin (must start with `strfnt`) and put it in `.env` (Step 1b) |
| Login code email never arrives | The customer's email in Recharge must match a real inbox. Check spam. Confirm the customer record exists in Recharge admin → Customers |
| "That code didn't match or expired" after entering the code | Codes expire quickly. Click **Resend code** on the verify page and try again |
| Redirected to `/login?reason=expired` while using the portal | Recharge sessions are ~1 hour. Sign in again to continue |
| "Shopify token exchange failed" | Double-check `SHOPIFY_STORE_DOMAIN`, `SHOPIFY_CLIENT_ID`, and `SHOPIFY_CLIENT_SECRET`. Make sure the app is installed on the store |
| No queued charges showing | The customer needs active subscriptions with `enable_future_charge_manipulation` enabled and queued charges generated |
| Collections not appearing in merchant portal | Your Shopify store needs published custom collections. The portal reads collections via the Shopify Admin API |
| Bundle editing doesn't work | Open `/merchant` and select the correct bundle in the **Bundle Product** panel. Only dynamic bundles appear in this list |

---

## Requirements Summary

| Requirement | Type | Difficulty |
|-------------|------|-----------|
| `.env` file with 8 variables | Configuration | Easy — copy/paste values |
| `SESSION_SECRET` generated locally | Configuration | Easy — one shell command |
| Configure bundle in merchant admin | In-app setup | Easy — choose from dropdown |
| Clear `data/` folder JSON files | File editing | Easy — paste default contents |
| Replace `public/logo.png` (optional) | File swap | Optional |
| Node.js 18+ installed | System requirement | One-time setup |
| Shopify Partner app with `read_products` | Shopify setup | Medium — one-time setup |
| Recharge **Merchant** API token with correct scopes | Recharge setup | Easy — admin UI |
| Recharge **Storefront** access token (`strfnt_…`) | Recharge setup | Easy — admin UI |

---

## Store Requirements (What Your Store Needs)

For the full demo experience, your Recharge store should have:

- At least one **bundle subscription product** (Recharge Bundles / Recharge Plus feature)
- The `enable_future_charge_manipulation` / `enable_multiple_active_queued_charges` beta flags enabled
- At least one customer with **active bundle subscriptions** and **multiple queued charges**
- Shopify **custom collections** set up with products (these power the meal/item picker in the portal)

---

## Hosting on a Domain (Production Deployment)

By default the portal runs on `localhost`. Follow these steps to deploy it to a public URL so it's always available.

### Why Not Serverless?

The portal stores merchant configuration as JSON files on disk (`data/*.json`). Serverless platforms like Vercel and Netlify use ephemeral filesystems that reset on every deploy, so your config would be lost. You need a platform that runs a **persistent Node.js server**.

### Recommended Platforms

| Platform | Monthly Cost | Difficulty | Persistent Storage |
|----------|-------------|------------|-------------------|
| [Railway](https://railway.app) | ~$5 | Easy | Volumes supported |
| [Render](https://render.com) | ~$7 (Starter) | Easy | Persistent disks |
| [Fly.io](https://fly.io) | ~$3–5 | Medium | Volumes supported |
| [DigitalOcean App Platform](https://www.digitalocean.com/products/app-platform) | ~$5 | Easy | Attached storage |
| Any VPS (DigitalOcean Droplet, Linode, etc.) | ~$5–6 | Higher | Full disk access |

> **Render's free tier** spins down after inactivity. Use the paid Starter plan if you need the portal available 24/7.

### Step-by-Step: Deploy to Railway (Easiest Path)

1. **Push your code to GitHub** (private repo recommended). Make sure `.env` is in `.gitignore` — never commit secrets.

2. **Create a Railway project:**
   - Sign up at [railway.app](https://railway.app) and click **New Project → Deploy from GitHub Repo**
   - Select your repository

3. **Add environment variables:**
   - In the Railway dashboard, go to your service → **Variables**
   - Add all six variables from your `.env` file (`RECHARGE_API_KEY`, `RECHARGE_API_URL`, etc.)
   - If going to production, swap the staging key (`sk_test_2x2_...`) for a production key (`sk_1x1_...`)

4. **Attach a persistent volume** for the `data/` folder:
   - Go to your service → **Settings → Volumes**
   - Create a volume and set the mount path to `/app/data`
   - This ensures your merchant config and customer preferences survive deploys and restarts

5. **Verify build and start commands** — Railway auto-detects Node.js projects, but confirm these are set:
   - **Build command:** `npm install && npm run build`
   - **Start command:** `npm start`

6. **Deploy.** Railway will build and start the app. You'll get a URL like `your-app.up.railway.app` — verify it works.

### Connect a Custom Domain (Subdomain)

Once the portal is running on a platform, you can put it on your own domain (e.g. `portal.your-store.com`).

1. **Choose a subdomain**, e.g. `portal.your-store.com` or `meals.your-store.com`

2. **Add the domain in your hosting platform:**
   - Railway: Service → **Settings → Custom Domains → Add Domain**
   - Render: Service → **Settings → Custom Domains**
   - The platform will give you a target hostname (e.g. `your-app.up.railway.app`)

3. **Add a DNS record** where your domain is managed (your registrar, Cloudflare, Shopify, etc.):
   - **Type:** `CNAME`
   - **Name:** `portal` (or whatever subdomain you chose)
   - **Value:** the target hostname from your hosting platform
   - Example: `portal  CNAME  your-app.up.railway.app`

4. **SSL certificate** — most platforms auto-provision an SSL certificate via Let's Encrypt once the DNS record propagates. This usually takes a few minutes.

5. **Verify** — visit `https://portal.your-store.com` and confirm the portal loads.

> **If your domain is on Shopify:** Go to Shopify admin → **Settings → Domains → your domain → DNS settings** and add the CNAME record there. If Shopify doesn't expose DNS management for your domain, you'll need to manage DNS at your registrar (GoDaddy, Namecheap, Cloudflare, etc.) instead.

### Keeping It Running

- **Managed platforms** (Railway, Render, Fly) handle process restarts automatically — if the app crashes, it comes back up.
- **On a VPS**, use [pm2](https://pm2.io) to keep the process alive:
  ```bash
  npm install -g pm2
  pm2 start npm --name "demo-portal" -- start
  pm2 save
  pm2 startup
  ```
- **Port:** `remix-serve` reads the `PORT` environment variable automatically. Most platforms set this for you — no extra config needed.

---

## Production Ready: Migrate Customer Preferences to SQLite

The portal stores customer dietary preferences (include/exclude tags) in `data/customer-preferences.json`. This works fine for demos, but for a store with hundreds or thousands of customers it has problems:

- **Race conditions** — two customers saving at the same time can overwrite each other's data
- **Performance** — every save reads and re-writes the entire file
- **No querying** — you can't easily answer questions like "how many customers exclude Dairy?"

The fix is to move customer preferences into a SQLite database. SQLite is a single-file database that requires no external server — it's the simplest possible upgrade from JSON files.

> **The other `data/*.json` files** (merchant settings, week assignments, bundle defaults, addon collections) are merchant-level config that stays small regardless of customer count. You don't need to migrate those.

### 1. Install `better-sqlite3`

```bash
npm install better-sqlite3
npm install -D @types/better-sqlite3
```

### 2. Create the Database Module

Create a new file at `app/lib/db.server.ts`:

```typescript
import Database from "better-sqlite3";
import { join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";

const DATA_DIR = join(process.cwd(), "data");
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(join(DATA_DIR, "portal.db"));

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS customer_preferences (
    customer_id TEXT PRIMARY KEY,
    include_tags TEXT NOT NULL DEFAULT '[]',
    exclude_tags TEXT NOT NULL DEFAULT '[]'
  )
`);

export default db;
```

The database file (`data/portal.db`) lives in the same `data/` folder as your JSON files. `WAL` mode allows concurrent reads without blocking.

### 3. Replace `customer-preferences.server.ts`

Replace the contents of `app/lib/customer-preferences.server.ts` with:

```typescript
import db from "./db.server";

export type CustomerPreference = { include: string[]; exclude: string[] };

const getStmt = db.prepare(
  "SELECT include_tags, exclude_tags FROM customer_preferences WHERE customer_id = ?"
);
const upsertStmt = db.prepare(`
  INSERT INTO customer_preferences (customer_id, include_tags, exclude_tags)
  VALUES (?, ?, ?)
  ON CONFLICT(customer_id) DO UPDATE SET include_tags = excluded.include_tags,
                                          exclude_tags = excluded.exclude_tags
`);
const allStmt = db.prepare("SELECT customer_id, include_tags, exclude_tags FROM customer_preferences");

export function getCustomerPreferences(customerId: string | null): CustomerPreference | null {
  if (!customerId) return null;
  const row = getStmt.get(customerId) as { include_tags: string; exclude_tags: string } | undefined;
  if (!row) return null;
  return { include: JSON.parse(row.include_tags), exclude: JSON.parse(row.exclude_tags) };
}

export function getAllCustomerPreferences(): Record<string, CustomerPreference> {
  const rows = allStmt.all() as { customer_id: string; include_tags: string; exclude_tags: string }[];
  const result: Record<string, CustomerPreference> = {};
  for (const row of rows) {
    result[row.customer_id] = { include: JSON.parse(row.include_tags), exclude: JSON.parse(row.exclude_tags) };
  }
  return result;
}

export function saveCustomerPreferences(customerId: string, preferences: CustomerPreference): void {
  upsertStmt.run(customerId, JSON.stringify(preferences.include), JSON.stringify(preferences.exclude));
}
```

The exported function signatures are identical to the original, so **no other files need to change**.

### 4. Migrate Existing Data

If you have existing preferences in `customer-preferences.json`, run this one-time migration. Create a file called `migrate-preferences.ts` in the project root:

```typescript
import Database from "better-sqlite3";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const JSON_PATH = join(process.cwd(), "data", "customer-preferences.json");
const DB_PATH = join(process.cwd(), "data", "portal.db");

if (!existsSync(JSON_PATH)) {
  console.log("No customer-preferences.json found — nothing to migrate.");
  process.exit(0);
}

const raw = JSON.parse(readFileSync(JSON_PATH, "utf-8"));
const preferences: Record<string, { include: string[]; exclude: string[] }> = raw.preferences ?? {};
const entries = Object.entries(preferences);

if (entries.length === 0) {
  console.log("No preferences to migrate.");
  process.exit(0);
}

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS customer_preferences (
    customer_id TEXT PRIMARY KEY,
    include_tags TEXT NOT NULL DEFAULT '[]',
    exclude_tags TEXT NOT NULL DEFAULT '[]'
  )
`);

const upsert = db.prepare(`
  INSERT INTO customer_preferences (customer_id, include_tags, exclude_tags)
  VALUES (?, ?, ?)
  ON CONFLICT(customer_id) DO UPDATE SET include_tags = excluded.include_tags,
                                          exclude_tags = excluded.exclude_tags
`);

const insertAll = db.transaction(() => {
  for (const [customerId, pref] of entries) {
    upsert.run(customerId, JSON.stringify(pref.include), JSON.stringify(pref.exclude));
  }
});

insertAll();
console.log(`Migrated ${entries.length} customer preference(s) to SQLite.`);
db.close();
```

Run it with:

```bash
npx tsx migrate-preferences.ts
```

After verifying the app works with the database, you can safely delete `data/customer-preferences.json` and `migrate-preferences.ts`.

### 5. Update `.gitignore`

Add the database file so it isn't committed:

```
data/portal.db
data/portal.db-wal
data/portal.db-shm
```

### 6. Hosting Note

If you're deploying to a platform with persistent volumes (see the hosting section above), make sure the volume is mounted at the `data/` directory. The SQLite database file (`portal.db`) will live alongside your merchant config JSON files.
