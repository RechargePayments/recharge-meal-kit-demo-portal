# Future Charge Manipulation Demo Portal

A standalone prototype customer portal demonstrating the **multiple-queued-charges** feature (Jira epic: SUBS-4477) to merchant partners. It serves as a reference implementation of what a merchant would build using the Recharge API directly.

## What This Is

The multiple-queued-charges project (also called "Future Charge Manipulations") allows a single subscription purchase item to have up to `max_queued_charges` (system max: 6) QUEUED charges at once, gated behind the `enable_future_charge_manipulation` / `enable_multiple_active_queued_charges` beta flags.

This portal lets a pre-configured customer:
- View all active subscriptions and their queued charge timelines
- Skip individual queued charges
- Edit bundle selections per charge

## Tech Stack

| Layer | Choice |
|-------|--------|
| Framework | [Remix](https://remix.run/) 2.16 (Vite, SSR) |
| Language | TypeScript |
| Validation | Zod (schema-validates all API responses) |
| Styling | Tailwind CSS |
| Runtime | Node.js |

API calls are made server-side only — the Recharge API key is never exposed to the browser.

## Prerequisites

- Node.js 18+
- A Recharge **staging** merchant API key (2021-11 version)
- A customer ID that lives on that merchant's store
- A Shopify Partner app with `read_products` scope installed on the store (see Shopify setup below)

## Setup

```bash
npm install
```

Copy `.env.example` to `.env` and fill in the values:

```bash
cp .env.example .env
```

| Variable | Description |
|----------|-------------|
| `RECHARGE_API_KEY` | Staging merchant API key (`sk_test_1x1_...` format) |
| `RECHARGE_CUSTOMER_ID` | Numeric ID of the customer to display |
| `RECHARGE_API_URL` | `https://api.stage.rechargeapps.com` |
| `RECHARGE_ADMIN_URL` | `https://<store-subdomain>.admin.stage.rechargeapps.com` |
| `SHOPIFY_STORE_DOMAIN` | Shopify store domain, e.g. `your-store.myshopify.com` |
| `SHOPIFY_CLIENT_ID` | Client ID from the Shopify Partner Dashboard app |
| `SHOPIFY_CLIENT_SECRET` | Client secret (`shpss_...`) from the Shopify Partner Dashboard app |

### Shopify setup

The bundle editor fetches available products from Shopify collections. This requires a Shopify Partner app with the client credentials grant enabled:

1. Go to [dev.shopify.com](https://dev.shopify.com) → your app → **Configuration**
2. Add API scopes: `read_products`, `read_product_listings`
3. Create a new version, release it, and reinstall the app on your store
4. Copy the **Client ID** and **Client Secret** (`shpss_...`) into `.env`

The portal exchanges these credentials for a short-lived access token at runtime (expires every 24 h) and caches it in memory. No OAuth redirect flow is needed.

## Running

```bash
npm run dev
# → http://localhost:5173
```

## Project Structure

```
future-charge-manipulation-demo-portal/
├── app/
│   ├── routes/
│   │   ├── _index.tsx          # Dashboard: customer header, subscriptions, queued charge timeline
│   │   └── charges.$id.tsx     # Charge detail + bundle selection editor
│   ├── lib/
│   │   ├── recharge.server.ts  # Typed Recharge API client (server-side only)
│   │   ├── shopify.server.ts   # Shopify client — token exchange, caching, collection product fetch
│   │   ├── types.ts            # Zod schemas for Customer, Subscription, Charge, BundleSelection
│   │   └── utils.ts            # formatDate, formatCurrency, shortId helpers
│   ├── root.tsx                # Layout + error boundary
│   └── tailwind.css
├── .env                        # Local config (not committed)
├── .env.example
├── package.json
├── tailwind.config.ts
├── tsconfig.json
└── vite.config.ts
```

## Recharge API Endpoints Used

All calls use `X-Recharge-Version: 2021-11`.

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/customers/:id` | Customer header info |
| GET | `/subscriptions?customer_id=:id&status=active` | Active subscription list |
| GET | `/charges?customer_id=:id&status=queued` | All queued charges |
| POST | `/charges/:id/skip` | Skip a queued charge |
| GET | `/bundle_selections?charge_ids=:id` | Bundle selections per charge |
| PUT | `/bundle_selections/:id` | Update bundle selections |

## Key Feature Behaviors

- **Multiple queued charges:** A single subscription can have 2–6 QUEUED charges, one per upcoming billing cycle. The dashboard groups them by subscription in date order.
- **Skip:** Skipping a queued charge marks it as skipped — no replacement charge is created immediately. Charges are replenished up to the `max_queued_charges` limit when the recurring charge creation job next runs. Merchants configure the job schedule via `charge_creation_day_of_week` or `charge_creation_day_of_month` on the plan; subscriptions inherit these properties from the plan at creation time.
- **Bundle editing:** Each queued charge can have its bundle contents edited independently via the charge detail page.
- **Auto-refresh:** The dashboard polls every 30 seconds via Remix's `useRevalidator`.

## Related

- Jira epic: [SUBS-4477](https://rechargepayments.atlassian.net/browse/SUBS-4477)
- API docs: Recharge API 2021-11 (`/bundle_selections` is Recharge Plus only)
