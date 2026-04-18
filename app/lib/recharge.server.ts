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
import { getCollectionProducts } from "./shopify.server";

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

export async function getBundleCollectionsFromShopify(collectionIds: string[]): Promise<BundleCollection[]> {
  const unique = [...new Set(collectionIds)];
  if (unique.length === 0) return [];

  const collections = await Promise.all(
    unique.map(async (collectionId) => {
      const products = await getCollectionProducts(collectionId);
      return {
        id: collectionId,
        title: collectionId,
        products: products.map((p) => ({
          id: p.id,
          external_product_id: String(p.id),
          title: p.title,
          image_url: p.image?.src ?? null,
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
