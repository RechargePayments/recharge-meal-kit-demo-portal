# Demo Portal — AI Skills Reference

## Project location

- Workspace root: `/Users/tarek/Documents/demo-portal`
- **Git repo root**: `/Users/tarek/Documents/demo-portal/future-charge-manipulation-demo-portal` (NOT the parent directory)
- All git commands must run from `future-charge-manipulation-demo-portal/`

## Tech stack

- Remix 2 + React 18 + Vite 5 + TypeScript + Tailwind CSS
- Dev server: `npm run dev` (runs `remix vite:dev`)

## GitLab remote

- Host: `gitlab.rechargeapps.net`
- Repo: `engineering/subscriptions/future-charge-manipulation-demo-portal`
- Remote URL: `https://gitlab.rechargeapps.net/engineering/subscriptions/future-charge-manipulation-demo-portal.git`
- Default branch: `master`

## Pushing a branch and creating a merge request

1. **Work from the git repo root**:
   ```
   cd /Users/tarek/Documents/demo-portal/future-charge-manipulation-demo-portal
   ```

2. **Create branch, stage, commit, push**:
   ```bash
   git checkout -b feature/my-feature
   git add <files>
   git commit -m "commit message"
   git push -u origin feature/my-feature
   ```

3. **Create the MR with `glab`** — you MUST set `GITLAB_HOST`:
   ```bash
   GITLAB_HOST=gitlab.rechargeapps.net glab mr create \
     --source-branch feature/my-feature \
     --target-branch master \
     --title "MR title" \
     --description "MR body" \
     --repo engineering/subscriptions/future-charge-manipulation-demo-portal \
     --no-editor
   ```

   Critical details:
   - `GITLAB_HOST=gitlab.rechargeapps.net` must be set as an env prefix — `glab` defaults to `gitlab.com` otherwise.
   - `--repo` uses the project path, not the full URL.
   - `--no-editor` prevents interactive editor from blocking.
   - Do NOT use `--hostname` (not a valid flag for `glab mr create`).
   - `gh` (GitHub CLI) is not used here. Use `glab` (GitLab CLI) at `/opt/homebrew/bin/glab`.

## Data storage pattern

Local JSON files under `data/` act as the persistence layer (no database):

| File | Purpose |
|------|---------|
| `data/bundle-defaults.json` | Per-week configs (`targetQuantity`) and legacy weekly defaults |
| `data/week-assignments.json` | Per-week Shopify collection assignments |
| `data/merchant-settings.json` | Global merchant settings (e.g. `deliveryDateOffset`) |

Each data file has a corresponding `app/lib/<name>.server.ts` module that reads/writes it using `node:fs`. Follow the same pattern when adding new settings.

**Customer dietary preferences are not stored locally.** They are exclude-only and live on the Shopify customer as `rc_exclude_<ingredient>` tags (e.g. `rc_exclude_eggs`). `app/lib/customer-preferences.server.ts` reads/writes these via the Shopify Admin API (`getCustomerTags`/`setCustomerTags`), resolving the Shopify customer from the Recharge customer's `external_customer_id.ecommerce`.

## Route structure

| Route file | Role |
|------------|------|
| `app/routes/_index.tsx` | Landing page — email lookup → redirects to `/$customerId` |
| `app/routes/$customerId.tsx` | Subscriber portal — subscriptions, bundles, preferences, meal editor |
| `app/routes/merchant.tsx` | Merchant portal — weekly collection management, config, apply defaults |

## Key conventions

- Server-only modules use the `.server.ts` suffix (Remix convention).
- Dates from Recharge are `YYYY-MM-DD` strings in UTC. Always parse with `T00:00:00Z` to avoid timezone drift.
- The merchant portal uses Remix `useFetcher` with `intent` form fields to dispatch actions.
- The subscriber portal passes data from the loader to nested components via props.
