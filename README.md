# Future Charge Manipulation Demo Portal

A standalone customer portal demonstrating the **future charege manipulation** feature to merchant partners. It is a reference implementation of what a merchant would build against the Recharge API directly.

> **Connecting your own store?** This README is the high-level overview. For the full step-by-step setup, token creation, and deployment walkthrough, see **[STORE_SETUP.md](STORE_SETUP.md)**.

## Purpose

This portal is **an example merchants can fork and follow to build their own custom customer portal**. It shows one concrete, end-to-end way to surface multiple queued charges, per-delivery bundle editing, and customer self-service on top of the Recharge API and the Shopify Admin API.

It is a **demo / reference implementation, not a turnkey hosted product.** A merchant adopting it is expected to take the code as a starting point and run it on their own infrastructure. The portal ships with everything wired up against a single store via environment variables — there is no multi-tenant layer.

### What you provide yourself

A merchant standing this up owns the following (see [STORE_SETUP.md](STORE_SETUP.md) for the how-to):

- **Web hosting** — the portal is a long-running Node.js server, so it needs a persistent host (e.g. Railway, Render, Fly.io, a VPS). Serverless platforms (Vercel/Netlify) don't fit because merchant config is written to disk under `data/`. A custom domain plus DNS/SSL is also yours to set up — see STORE_SETUP.md → *Hosting on a Domain*.
- **Persistent storage for merchant config** — the `data/*.json` files (merchant settings, week assignments, bundle defaults, add-on collections) live on disk, so a hosted deployment must mount a persistent volume at `data/`.
- **A Recharge store** with the `enable_future_charge_manipulation` / `enable_multiple_active_queued_charges` beta flags enabled, at least one bundle subscription product, and a test customer with active subscriptions and queued charges.
- **Recharge API tokens** — both a **Merchant** API key (server-side admin) and a **Storefront** access token (passwordless customer login).
- **A Shopify app** with the client-credentials grant and the required product/customer scopes.
- **Branding** — replace `public/logo.png` with your own logo.

## What It Does

The Future Charge Manipulations feature lets a single subscription have up to `max_queued_charges` (system max: 6) QUEUED charges at once, gated behind the `enable_future_charge_manipulation` / `enable_multiple_active_queued_charges` beta flags.

Built on top of that, the portal provides:

- **Passwordless login** — customers sign in with an email verification code (Recharge storefront flow); no password.
- **Delivery dashboard** — upcoming queued charges grouped by week, with the bundle contents for each.
- **Skip / unskip** queued charges per week.
- **Edit bundle selections** per queued charge independently.
- **Dietary preferences** — exclude-only ("Ingredients to Avoid"), stored as Shopify customer tags (see below).
- **Account page** — view/update address and payment method.
- **Order history** — previously charged orders.
- **Merchant admin portal** (`/merchant`) — pick the active bundle, assign Shopify collections to weeks, configure delivery offset and modification windows, and set up add-on collections.

## Tech Stack

| Layer | Choice |
|-------|--------|
| Framework | [Remix](https://remix.run/) 2.16 (Vite, SSR) |
| Language | TypeScript |
| Auth | [`@rechargeapps/storefront-client`](https://www.npmjs.com/package/@rechargeapps/storefront-client) (passwordless email-code login) |
| Validation | Zod (schema-validates all API responses) |
| Styling | Tailwind CSS |
| Runtime | Node.js 18+ |

API calls are made server-side only — neither the Recharge API key nor the Shopify credentials are ever exposed to the browser.

## Prerequisites

- Node.js 18+
- A Recharge store (staging recommended for testing) with the beta flags above
- A Recharge **Merchant** API key and a **Storefront** access token (Recharge API version `2021-11`)
- A Shopify app (client-credentials grant) installed on the store

Detailed token/scope setup lives in **[STORE_SETUP.md](STORE_SETUP.md)**.

## Setup

```bash
npm install
cp .env.example .env
```

Then fill in `.env`. All variables:

| Variable | Required | Description |
|----------|----------|-------------|
| `RECHARGE_API_KEY` | **Yes** | Merchant API key. Keys look like `sk_1x1_...`. |
| `RECHARGE_API_URL` | No | Recharge API base URL. Defaults to `https://api.rechargeapps.com`. |
| `RECHARGE_ADMIN_URL` | No | Your Recharge admin URL, e.g. `https://your-store.admin.rechargeapps.com`. Falls back to `RECHARGE_API_URL` if unset. |
| `RECHARGE_STOREFRONT_ACCESS_TOKEN` | **Yes** | Storefront token for passwordless login. Must start with `strfnt`. |
| `SHOPIFY_STORE_DOMAIN` | **Yes** | Shopify store domain, e.g. `your-store.myshopify.com`. |
| `SHOPIFY_CLIENT_ID` | **Yes** | Client ID of the Shopify client-credentials app. |
| `SHOPIFY_CLIENT_SECRET` | **Yes** | Client secret (`shpss_...`) of the Shopify app. |
| `SESSION_SECRET` | **Yes** | Secret used to sign the session cookie. Generate with `openssl rand -hex 32`. |

> The app **requires** `SESSION_SECRET` and `SHOPIFY_STORE_DOMAIN` to start. The remaining required values throw on first use (first API call or first login). `RECHARGE_API_URL` and `RECHARGE_ADMIN_URL` have sensible defaults. `PORT` is read automatically by `remix-serve` in production — most hosts set it for you.

For where to find each value (creating the Recharge tokens, configuring the Shopify app and its scopes, generating `SESSION_SECRET`), follow **[STORE_SETUP.md](STORE_SETUP.md)**.

## Running

```bash
npm run dev
# → http://localhost:5173
```

You'll be redirected to `/login` first — sign in with the email of a customer on your store. For production:

```bash
npm run build
npm start          # remix-serve; reads PORT
```

## Project Structure

```
future-charge-manipulation-demo-portal/
├── app/
│   ├── routes/
│   │   ├── _index.tsx                  # Redirects to /<customerId> (logged in) or /login
│   │   ├── login.tsx                   # Email entry (passwordless login)
│   │   ├── login_.verify.tsx           # Verification-code entry
│   │   ├── logout.tsx                  # Clears session
│   │   ├── $customerId.tsx             # Delivery dashboard (the main UI)
│   │   ├── $customerId_.account.tsx    # Address + payment method
│   │   ├── $customerId_.orders.tsx     # Previous orders
│   │   ├── charges.$id.tsx             # Resolves a charge → redirects to its dashboard week
│   │   └── merchant.tsx                # Merchant admin portal
│   ├── lib/
│   │   ├── auth.server.ts              # Passwordless auth + session guards
│   │   ├── recharge.server.ts          # Typed Recharge API client (server-side only)
│   │   ├── shopify.server.ts           # Shopify Admin API: token exchange, products, customer tags
│   │   ├── session.server.ts           # Cookie session storage (requires SESSION_SECRET)
│   │   ├── types.ts                    # Zod schemas / types
│   │   ├── customer-preferences.server.ts  # Dietary exclusions ↔ Shopify customer tags
│   │   ├── personalize-defaults.server.ts  # Apply preferences to bundle selections
│   │   ├── merchant-settings.server.ts # data/merchant-settings.json
│   │   ├── bundle-defaults.server.ts   # data/bundle-defaults.json
│   │   ├── addon-collections.server.ts # data/addon-collections.json
│   │   ├── preset-schedules.server.ts  # Recharge preset schedules / week assignments
│   │   ├── bundle-config.ts            # Defaults & constants
│   │   └── utils.ts                    # formatDate, formatCurrency, etc.
│   ├── root.tsx                        # Layout + error boundary
│   └── tailwind.css
├── data/                               # On-disk merchant config (mount a volume in prod)
│   ├── merchant-settings.json
│   ├── bundle-defaults.json
│   ├── addon-collections.json
│   └── week-assignments.json
├── public/logo.png                     # Brand logo (replace with your own)
├── .env / .env.example
├── SKILLS.md                           # Repo / GitLab MR workflow notes
├── package.json
├── tailwind.config.ts
├── tsconfig.json
└── vite.config.ts
```

## Customer Dietary Preferences

Preferences are **exclude-only** and stored as **Shopify customer tags** — there is no local database or JSON file for them. Each excluded ingredient is a tag of the form `rc_exclude_<slug>` (e.g. `rc_exclude_eggs`) on the customer's linked Shopify record. The slug is matched case-insensitively against Shopify **product** tags (underscores map to spaces). Because they live in Shopify, preferences survive deploys and scale with the store automatically — no volume or migration needed. See [STORE_SETUP.md → *Customer Dietary Preferences*](STORE_SETUP.md#customer-dietary-preferences-shopify-customer-tags) for details.

## APIs Used

**Recharge API** — all calls use header `X-Recharge-Access-Token` and `X-Recharge-Version: 2021-11`:

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/customers/:id` | Customer header info (incl. `external_customer_id.ecommerce` Shopify link) |
| GET | `/subscriptions?customer_id=:id` | Active subscription list |
| GET | `/charges?customer_id=:id&status=queued` | Queued charges (also `skipped`, `success` views) |
| POST | `/charges/:id/skip` · `/charges/:id/unskip` | Skip / unskip a queued charge |
| GET / PUT | `/bundle-selections` | Read / update bundle selections per charge |
| GET | `/addresses/:id`, `/payment-methods`, `/onetimes`, credit summaries | Account & dashboard data |
| GET / PUT | preset-schedule endpoints | Week assignments for the merchant portal |

`/bundle-selections` and preset schedules are Recharge Plus / Bundles features.

**Shopify Admin API** (`https://<store>/admin/api/2025-01`, client-credentials token) — fetches collection products and reads/writes customer tags:

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/products.json`, `/collects.json`, `/custom_collections.json` | Bundle/collection products for the item picker |
| GET | `/customers/:id.json?fields=id,tags` | Read dietary-preference tags |
| PUT | `/customers/:id.json` | Write dietary-preference tags (preserves other tags) |

Required Shopify scopes: `read_products`, `read_product_listings`, `read_customers`, `write_customers`.

## Related

- Jira epic: [SUBS-4477](https://rechargepayments.atlassian.net/browse/SUBS-4477)
- Setup & deployment: [STORE_SETUP.md](STORE_SETUP.md)
- API version: Recharge `2021-11`, Shopify Admin `2025-01`
