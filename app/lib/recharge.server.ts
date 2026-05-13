import { z } from "zod";
import {
  CustomerSchema,
  SubscriptionSchema,
  ChargeSchema,
  BundleSelectionSchema,
  BundleCollectionSchema,
  BundleProductSchema,
  CreditSummarySchema,
  AddressSchema,
  PaymentMethodSchema,
  type Customer,
  type Subscription,
  type Charge,
  type BundleSelection,
  type BundleCollection,
  type BundleProduct,
  type BundleItemPayload,
  type CreditSummary,
  type Address,
  type PaymentMethod,
  type Property,
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

async function api<T>(
  path: string,
  options: RequestInit = {},
  maxRetries = 3
): Promise<T> {
  const headers = { ...authHeaders(), ...(options.headers as Record<string, string> ?? {}) };

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch(`${BASE_URL}${path}`, { ...options, headers });

    if (res.status === 429) {
      if (attempt === maxRetries) {
        throw new Error(`Recharge 429 — ${path}: rate limited after ${maxRetries + 1} attempts`);
      }
      const retryAfter = Number(res.headers.get("Retry-After")) || 0;
      const backoff = Math.max(retryAfter * 1000, 1000 * 2 ** attempt);
      await new Promise((r) => setTimeout(r, backoff));
      continue;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      throw new Error(`Recharge ${res.status} — ${path}: ${text}`);
    }

    return res.json() as Promise<T>;
  }

  throw new Error(`Recharge — ${path}: exhausted retries`);
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

export async function updateCustomer(
  customerId: string,
  fields: Partial<Pick<Customer, "email" | "first_name" | "last_name">> & { phone?: string }
): Promise<Customer> {
  const data = await api<{ customer: unknown }>(`/customers/${customerId}`, {
    method: "PUT",
    body: JSON.stringify(fields),
  });
  return CustomerSchema.parse(data.customer);
}

// ─── Payment Methods ─────────────────────────────────────────────────────────

export async function listPaymentMethods(customerId: string): Promise<PaymentMethod[]> {
  const data = await api<{ payment_methods: unknown[] }>(
    `/payment_methods?customer_id=${customerId}&limit=50`
  );
  return z.array(PaymentMethodSchema).parse(data.payment_methods);
}

export async function sendPaymentUpdateNotification(
  customerId: string,
  paymentMethodId: number
): Promise<void> {
  await api(`/notifications/customer`, {
    method: "POST",
    body: JSON.stringify({
      type: "SHOPIFY_UPDATE_PAYMENT_INFO",
      template_vars: { customer_id: Number(customerId), payment_method_id: String(paymentMethodId) },
    }),
  });
}

// ─── Credits ─────────────────────────────────────────────────────────────────

export async function getCreditSummary(customerId: string): Promise<CreditSummary> {
  const data = await api<{ credit_summary: unknown }>(
    `/customers/${customerId}/credit_summary?include[]=credit_details`
  );
  return CreditSummarySchema.parse(data.credit_summary);
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

export async function listActiveCharges(customerId: string): Promise<Charge[]> {
  const data = await api<{ charges: unknown[] }>(
    `/charges?customer_id=${customerId}&status=queued,skipped&sort_by=scheduled_at-asc&limit=250`
  );
  return z.array(ChargeSchema).parse(data.charges);
}

export async function listSuccessCharges(customerId: string): Promise<Charge[]> {
  const data = await api<{ charges: unknown[] }>(
    `/charges?customer_id=${customerId}&status=success&sort_by=scheduled_at-desc&limit=50`
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

export async function unskipCharge(chargeId: string, purchaseItemIds?: number[]): Promise<Charge> {
  const body = purchaseItemIds?.length ? { purchase_item_ids: purchaseItemIds } : {};
  const data = await api<{ charge: unknown }>(`/charges/${chargeId}/unskip`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  return ChargeSchema.parse(data.charge);
}

// ─── Subscription updates ─────────────────────────────────────────────────────

export async function updateSubscriptionProperties(
  subscriptionId: number,
  properties: Property[]
): Promise<Subscription> {
  const data = await api<{ subscription: unknown }>(
    `/subscriptions/${subscriptionId}`,
    { method: "PUT", body: JSON.stringify({ properties }) }
  );
  return SubscriptionSchema.parse(data.subscription);
}

// ─── Bundle Selections ────────────────────────────────────────────────────────

export async function getBundleSelections(chargeId: number): Promise<BundleSelection[]> {
  const data = await api<{ bundle_selections: unknown[] }>(
    `/bundle_selections?charge_ids=${chargeId}&limit=10`
  );
  return z.array(BundleSelectionSchema).parse(data.bundle_selections);
}

const BundleSelectionWithChargeIdSchema = BundleSelectionSchema.extend({
  charge_id: z.number(),
});

export async function listBundleSelectionsByPurchaseItemIds(
  purchaseItemIds: number[]
): Promise<Array<BundleSelection & { charge_id: number }>> {
  const uniqueIds = [...new Set(purchaseItemIds)];
  if (uniqueIds.length === 0) return [];

  const data = await api<{ bundle_selections: unknown[] }>(
    `/bundle_selections?purchase_item_ids=${uniqueIds.join(",")}&limit=250`
  );
  return z.array(BundleSelectionWithChargeIdSchema).parse(data.bundle_selections);
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
            price: v.price ?? undefined,
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

export async function listBundleProducts(): Promise<BundleProduct[]> {
  const data = await api<{ bundle_products: unknown[] }>(`/bundle_products?limit=250`);
  return z.array(BundleProductSchema).parse(data.bundle_products);
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

// ─── Onetimes (add-ons) ──────────────────────────────────────────────────────

export async function createOnetime(payload: {
  address_id: number;
  next_charge_scheduled_at: string;
  external_product_id: { ecommerce: string };
  external_variant_id: { ecommerce: string };
  quantity: number;
  price: string;
}): Promise<unknown> {
  return api("/onetimes", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function deleteOnetime(onetimeId: number): Promise<void> {
  await api(`/onetimes/${onetimeId}`, { method: "DELETE" });
}

// ─── Addresses ────────────────────────────────────────────────────────────────

export async function listAddresses(customerId: string): Promise<Address[]> {
  const data = await api<{ addresses: unknown[] }>(
    `/addresses?customer_id=${customerId}&limit=50`
  );
  return z.array(AddressSchema).parse(data.addresses);
}

export async function updateAddress(
  addressId: number,
  fields: Partial<Omit<Address, "id" | "customer_id">>
): Promise<Address> {
  const data = await api<{ address: unknown }>(`/addresses/${addressId}`, {
    method: "PUT",
    body: JSON.stringify(fields),
  });
  return AddressSchema.parse(data.address);
}

// ─── Merchant defaults application ───────────────────────────────────────────

export async function listBundleSubscriptionIds(externalVariantIds: string[]): Promise<Set<number>> {
  const uniqueVariantIds = [...new Set(externalVariantIds.map((id) => id.trim()).filter(Boolean))];
  if (uniqueVariantIds.length === 0) {
    throw new Error("No bundle variant selected. Choose a bundle in merchant admin first.");
  }

  const responses = await Promise.all(
    uniqueVariantIds.map((variantId) =>
      api<{ subscriptions: unknown[] }>(
        `/subscriptions?external_variant_id=${encodeURIComponent(variantId)}&limit=250`
      )
    )
  );

  const subs = responses.flatMap((response) =>
    z.array(z.object({ id: z.number() })).parse(response.subscriptions)
  );
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
