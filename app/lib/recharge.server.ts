import { z } from "zod";
import {
  CustomerSchema,
  SubscriptionSchema,
  ChargeSchema,
  BundleSelectionSchema,
  BundleCollectionSchema,
  type Customer,
  type Subscription,
  type Charge,
  type BundleSelection,
  type BundleCollection,
  type BundleItemPayload,
} from "./types";
import { getCollectionProducts, getCollectionProductsSorted } from "./shopify.server";

const BASE_URL = process.env.RECHARGE_API_URL ?? "https://api.rechargeapps.com";
const ADMIN_URL = process.env.RECHARGE_ADMIN_URL ?? BASE_URL;

function authHeaders(): Record<string, string> {
  const key = process.env.RECHARGE_API_KEY;
  if (!key) throw new Error("RECHARGE_API_KEY is not set");
  return {
    "X-Recharge-Access-Token": key,
    "X-Recharge-Version": "2021-11",
    "Content-Type": "application/json",
  };
}

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: { ...authHeaders(), ...(options.headers as Record<string, string> ?? {}) },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`Recharge ${res.status} — ${path}: ${text}`);
  }
  return res.json() as Promise<T>;
}

// ─── Customer ─────────────────────────────────────────────────────────────────

export async function getCustomer(customerId: string): Promise<Customer> {
  const data = await api<{ customer: unknown }>(`/customers/${customerId}`);
  return CustomerSchema.parse(data.customer);
}

export async function getCustomerByEmail(email: string): Promise<Customer | null> {
  const data = await api<{ customers: unknown[] }>(`/customers?email=${encodeURIComponent(email)}&limit=1`);
  const customers = z.array(CustomerSchema).parse(data.customers);
  return customers[0] ?? null;
}

// ─── Subscriptions ────────────────────────────────────────────────────────────

export async function getSubscription(subscriptionId: number): Promise<Subscription> {
  const data = await api<{ subscription: unknown }>(`/subscriptions/${subscriptionId}`);
  return SubscriptionSchema.parse(data.subscription);
}

export async function listSubscriptions(customerId: string): Promise<Subscription[]> {
  const data = await api<{ subscriptions: unknown[] }>(
    `/subscriptions?customer_id=${customerId}&status=active&limit=50`
  );
  return z.array(SubscriptionSchema).parse(data.subscriptions);
}

// ─── Charges ──────────────────────────────────────────────────────────────────

export async function listQueuedCharges(customerId: string): Promise<Charge[]> {
  const data = await api<{ charges: unknown[] }>(
    `/charges?customer_id=${customerId}&status=queued&sort_by=scheduled_at-asc&limit=250`
  );
  return z.array(ChargeSchema).parse(data.charges);
}

export async function getCharge(chargeId: string): Promise<Charge> {
  const data = await api<{ charge: unknown }>(`/charges/${chargeId}`);
  return ChargeSchema.parse(data.charge);
}

export async function skipCharge(chargeId: string, purchaseItemIds?: number[]): Promise<Charge> {
  const body = purchaseItemIds?.length ? { purchase_item_ids: purchaseItemIds } : {};
  const data = await api<{ charge: unknown }>(`/charges/${chargeId}/skip`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  return ChargeSchema.parse(data.charge);
}

// ─── Bundle Selections ────────────────────────────────────────────────────────

export async function getBundleSelections(chargeId: number): Promise<BundleSelection[]> {
  const data = await api<{ bundle_selections: unknown[] }>(
    `/bundle_selections?charge_ids=${chargeId}&limit=10`
  );
  return z.array(BundleSelectionSchema).parse(data.bundle_selections);
}

export async function getBundleCollectionsFromShopify(
  collectionIds: string[],
  { sorted = false }: { sorted?: boolean } = {}
): Promise<BundleCollection[]> {
  const unique = [...new Set(collectionIds)];
  if (unique.length === 0) return [];

  const fetchProducts = sorted ? getCollectionProductsSorted : getCollectionProducts;

  const collections = await Promise.all(
    unique.map(async (collectionId) => {
      const products = await fetchProducts(collectionId);
      return {
        id: collectionId,
        title: collectionId,
        products: products.map((p) => ({
          id: p.id,
          external_product_id: String(p.id),
          title: p.title,
          image_url: p.image?.src ?? null,
          tags: p.tags ?? [],
          variants: p.variants.map((v) => ({
            id: v.id,
            title: v.title,
            sku: v.sku ?? undefined,
            external_product_id: String(p.id),
          })),
        })),
      };
    })
  );

  return z.array(BundleCollectionSchema).parse(collections);
}

export async function getBundleProductCollectionIds(externalProductId: string): Promise<string[]> {
  const { collectionIds } = await getBundleProductInfo(externalProductId);
  return collectionIds;
}

export async function getBundleProductInfo(externalProductId: string): Promise<{
  collectionIds: string[];
  quantityRanges: number[][];
}> {
  const data = await api<{
    bundle_products: Array<{
      variants: Array<{
        option_sources: Array<{ option_source_id: string }>;
        ranges?: Array<{ id: number; quantity_min: number; quantity_max: number }>;
      }>;
    }>;
  }>(`/bundle_products?external_product_id=${externalProductId}&limit=25`);

  const collectionIds = [
    ...new Set(
      data.bundle_products.flatMap((bp) =>
        bp.variants.flatMap((v) => v.option_sources.map((os) => os.option_source_id))
      )
    ),
  ];

  const seenIds = new Set<number>();
  const quantityRanges = data.bundle_products
    .flatMap((bp) => bp.variants.flatMap((v) => v.ranges ?? []))
    .filter((r) => {
      if (seenIds.has(r.id)) return false;
      seenIds.add(r.id);
      return true;
    })
    .map((r) => [r.quantity_min, r.quantity_max]);

  return { collectionIds, quantityRanges };
}

export async function createBundleSelection(
  chargeId: number,
  purchaseItemId: number,
  items: BundleItemPayload[]
): Promise<BundleSelection> {
  const data = await api<{ bundle_selection: unknown }>(`/bundle_selections`, {
    method: "POST",
    body: JSON.stringify({ charge_id: chargeId, purchase_item_id: purchaseItemId, items }),
  });
  return BundleSelectionSchema.parse(data.bundle_selection);
}

export async function updateBundleSelection(
  bundleSelectionId: number,
  items: BundleItemPayload[]
): Promise<BundleSelection> {
  const data = await api<{ bundle_selection: unknown }>(
    `/bundle_selections/${bundleSelectionId}`,
    { method: "PUT", body: JSON.stringify({ items }) }
  );
  return BundleSelectionSchema.parse(data.bundle_selection);
}

// ─── Merchant defaults application ───────────────────────────────────────────

// Shopify variant ID for the single variant of the Customizable Dynamic Weekly Bundle.
// Fetching all subscriptions for this variant in one call avoids per-charge subscription
// lookups. Future API improvement: a subscription_ids filter on the charges endpoint
// would eliminate these lookups entirely and better support this merchant use case.
const BUNDLE_VARIANT_ID = "47959488430339";

export async function listBundleSubscriptionIds(): Promise<Set<number>> {
  const data = await api<{ subscriptions: unknown[] }>(
    `/subscriptions?external_variant_id=${BUNDLE_VARIANT_ID}&limit=250`
  );
  const subs = z.array(z.object({ id: z.number() })).parse(data.subscriptions);
  return new Set(subs.map((s) => s.id));
}

export async function listQueuedChargesForWeek(weekStart: string): Promise<Charge[]> {
  const end = new Date(weekStart + "T00:00:00");
  end.setDate(end.getDate() + 6);
  const weekEnd = [
    end.getFullYear(),
    String(end.getMonth() + 1).padStart(2, "0"),
    String(end.getDate()).padStart(2, "0"),
  ].join("-");
  const data = await api<{ charges: unknown[] }>(
    `/charges?status=queued&scheduled_at_min=${weekStart}&scheduled_at_max=${weekEnd}&limit=250`
  );
  return z.array(ChargeSchema).parse(data.charges);
}
