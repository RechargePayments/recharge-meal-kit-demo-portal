import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { Link, useFetcher, useLoaderData, useNavigation, useRevalidator, useSearchParams } from "@remix-run/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  activateSubscription,
  getCustomer,
  getCreditSummary,
  createBundleSelection,
  createOnetime,
  deleteOnetime,
  getBundleCollectionsFromShopify,
  getBundleProductInfo,
  getBundleSelections,
  getCharge,
  listBundleProducts,
  listBundleSelectionsByPurchaseItemIds,
  getSubscription,
  listActiveCharges,
  listAddresses,
  listSubscriptions,
  skipCharge,
  unskipCharge,
  updateAddress,
  updateBundleSelection,
  type SubscriptionDefaultSelection,
} from "~/lib/recharge.server";
import { requireCustomerOwnsId } from "~/lib/auth.server";
import { listPresetSchedules } from "~/lib/preset-schedules.server";
import { getCustomerPreferences, saveCustomerPreferences, type CustomerPreference } from "~/lib/customer-preferences.server";
import {
  getActiveBundleVariantId,
  getDeliveryDateOffset,
  getModificationWindowDays,
  isChargeLocked,
} from "~/lib/merchant-settings.server";
import { getAddonCollectionIds } from "~/lib/addon-collections.server";
import { getProductsByVariantIds } from "~/lib/shopify.server";
import { DEFAULT_DELIVERY_OFFSET, DEFAULT_MODIFICATION_WINDOW, LEGACY_BUNDLE_VARIANT_ID } from "~/lib/bundle-config";
import type { Address, BundleCollection, BundleItemPayload, BundleSelection, BundleSelectionItem, Charge, ChargeLineItem, CreditSummary, Customer, DefaultBundleItem, QuantityRange, Subscription } from "~/lib/types";
import { formatCurrency, formatDate } from "~/lib/utils";

export const meta: MetaFunction = () => [{ title: "NourishBox — My Deliveries" }];

// Turn default contents into selection items by finding each variant in the
// available collections. Defaults that aren't in any of them come back as
// `offMenu`.
function resolveDefaultItems(
  defaults: DefaultBundleItem[],
  collections: BundleCollection[]
): { items: BundleSelectionItem[]; offMenu: DefaultBundleItem[] } {
  const items: BundleSelectionItem[] = [];
  const offMenu: DefaultBundleItem[] = [];
  for (const item of defaults) {
    const candidates = item.collection_id
      ? collections.filter((c) => c.id === item.collection_id)
      : collections;
    const match = candidates
      .flatMap((collection) => collection.products.map((product) => ({ collection, product })))
      .find(({ product }) => product.variants.some((v) => String(v.id) === item.external_variant_id));
    if (match) {
      items.push({
        id: 0,
        collection_id: match.collection.id,
        collection_source: "shopify",
        external_product_id: match.product.external_product_id,
        external_variant_id: item.external_variant_id,
        quantity: item.quantity,
      });
    } else {
      offMenu.push(item);
    }
  }
  return { items, offMenu };
}

// Default meals that aren't in any bundle collection, shown from their Shopify
// product. Variants that no longer exist are dropped.
async function loadOffMenuItems(defaults: DefaultBundleItem[]): Promise<EditableItem[]> {
  const products = await getProductsByVariantIds(defaults.map((d) => d.external_variant_id));
  return defaults.flatMap((item) => {
    const product = products.get(item.external_variant_id);
    const variant = product?.variants.find((v) => String(v.id) === item.external_variant_id);
    if (!product || !variant) return [];
    return [{
      collection_id: null,
      collection_source: "shopify",
      external_product_id: String(product.id),
      external_variant_id: item.external_variant_id,
      quantity: item.quantity,
      productTitle: product.title,
      variantTitle: variant.title,
      imageUrl: product.image?.src ?? null,
      tags: product.tags ?? [],
      description: product.body_html ? product.body_html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : null,
      offMenu: true,
    }];
  });
}

function getMondayOf(dateStr: string): string {
  const d = new Date(dateStr.slice(0, 10) + "T00:00:00");
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

type ChargeTabInfo = {
  chargeId: number;
  scheduledAt: string;
  totalPrice: string;
  hasBundles: boolean;
  locked: boolean;
  status: Charge["status"];
};

type ActiveChargeBundle = {
  charge: Charge;
  bundleSelections: BundleSelection[];
  subscriptionTitles: Record<number, string>;
  collectionsByProductId: Record<string, BundleCollection[]>;
  bundleProductRangesByProductId: Record<string, QuantityRange[]>;
  // Default meals for a charge without a selection that aren't in any bundle
  // collection. Only set on the synthetic placeholder selection.
  offMenuItems: EditableItem[];
  eligibleCollectionIds: string[];
  hasPresetForWeek: boolean;
};

type AddonProduct = {
  externalProductId: string;
  externalVariantId: string;
  title: string;
  variantTitle: string;
  imageUrl: string | null;
  price: string;
  tags: string[];
};

type BundleSubscriptionTab = {
  purchaseItemId: number;
  productTitle: string;
  externalVariantId: string | null;
  chargeIds: number[];
};

// ─── Loader ───────────────────────────────────────────────────────────────────

export async function loader({ params, request }: LoaderFunctionArgs) {
  const { customerId } = params;
  if (!customerId) throw new Error("Missing customer ID");
  if (!/^\d+$/.test(customerId)) {
    throw new Response("Not Found", { status: 404 });
  }
  await requireCustomerOwnsId(request, customerId);

  const url = new URL(request.url);
  const selectedWeek = url.searchParams.get("week");
  const selectedSubscription = url.searchParams.get("subscription");

  // Phase 1: Light data — Recharge only
  const [customer, subscriptions, activeCharges, creditSummary, addresses] = await Promise.all([
    getCustomer(customerId),
    listSubscriptions(customerId),
    listActiveCharges(customerId),
    getCreditSummary(customerId).catch(() => null),
    listAddresses(customerId),
  ]);

  // Exclusion preferences live on the Shopify customer; derive them from the
  // already-loaded Recharge customer to avoid a second customer fetch.
  const customerPreferences = await getCustomerPreferences(customer).catch(() => null);

  // Phase 2: Check which charges have bundles (Recharge API only)
  const subscriptionPurchaseItemIds = [
    ...new Set(
      activeCharges.flatMap((charge) =>
        charge.line_items
          .filter((lineItem) => lineItem.purchase_item_type === "subscription")
          .map((lineItem) => lineItem.purchase_item_id)
      )
    ),
  ];

  let chargesBundleCheck: Array<{ charge: Charge; bundleSelections: BundleSelection[] }>;
  // Subscription-level selections (no charge_id), keyed by purchase item. These
  // are the contents a charge gets when it has no charge-specific selection.
  let defaultSelectionByPurchaseItem = new Map<number, SubscriptionDefaultSelection>();

  if (subscriptionPurchaseItemIds.length === 0) {
    chargesBundleCheck = activeCharges.map((charge) => ({ charge, bundleSelections: [] }));
  } else {
    try {
      const { chargeSelections, defaultsByPurchaseItem } = await listBundleSelectionsByPurchaseItemIds([
        ...subscriptionPurchaseItemIds,
        ...subscriptions.map((subscription) => subscription.id),
      ]);
      defaultSelectionByPurchaseItem = defaultsByPurchaseItem;
      const bundleSelectionsByCharge = new Map<number, BundleSelection[]>();

      for (const { chargeId, selection } of chargeSelections) {
        const existing = bundleSelectionsByCharge.get(chargeId);
        if (existing) {
          existing.push(selection);
        } else {
          bundleSelectionsByCharge.set(chargeId, [selection]);
        }
      }

      chargesBundleCheck = activeCharges.map((charge) => ({
        charge,
        bundleSelections: bundleSelectionsByCharge.get(charge.id) ?? [],
      }));
    } catch {
      // Fallback for stores where purchase_item_ids is unavailable.
      chargesBundleCheck = await Promise.all(
        activeCharges.map(async (charge) => ({
          charge,
          bundleSelections: await getBundleSelections(charge.id),
        }))
      );
    }
  }

  const subscriptionById = new Map(subscriptions.map((subscription) => [subscription.id, subscription]));

  // Whether a charge belongs to a subscription. Normally that's a subscription
  // line item, but freshly generated future charges can arrive with no line
  // items at all — for those, fall back to matching the subscription's address.
  // A subscription can't own a charge scheduled before its next charge date,
  // which keeps empty charges from showing under every subscription at the
  // same address.
  function chargeReferencesSubscription(charge: Charge, subscriptionId: number): boolean {
    const subscriptionLineItems = charge.line_items.filter((li) => li.purchase_item_type === "subscription");
    if (subscriptionLineItems.length > 0) {
      return subscriptionLineItems.some((li) => li.purchase_item_id === subscriptionId);
    }
    const subscription = subscriptionById.get(subscriptionId);
    if (subscription == null || charge.address_id == null || charge.address_id !== subscription.address_id) {
      return false;
    }
    const nextChargeDate = subscription.next_charge_scheduled_at?.slice(0, 10);
    return nextChargeDate == null || charge.scheduled_at.slice(0, 10) >= nextChargeDate;
  }

  const bundleSubscriptionMap = new Map<number, BundleSubscriptionTab>();

  // Helper: register a charge under a subscription (deduped chargeIds)
  function registerChargeForSubscription(purchaseItemId: number, chargeId: number) {
    const existing = bundleSubscriptionMap.get(purchaseItemId);
    if (existing) {
      if (!existing.chargeIds.includes(chargeId)) existing.chargeIds.push(chargeId);
      return;
    }
    const subscription = subscriptionById.get(purchaseItemId);
    bundleSubscriptionMap.set(purchaseItemId, {
      purchaseItemId,
      productTitle: subscription?.product_title ?? `Subscription #${purchaseItemId}`,
      externalVariantId: subscription?.external_variant_id?.ecommerce ?? null,
      chargeIds: [chargeId],
    });
  }

  // Pass 1 — discover bundle subscriptions via existing bundle_selections.
  for (const { charge, bundleSelections } of chargesBundleCheck) {
    for (const bundleSelection of bundleSelections) {
      registerChargeForSubscription(bundleSelection.purchase_item_id, charge.id);
    }
  }

  // Pass 2 — also include charges (typically skipped) that reference a known
  // bundle subscription via their line_items, even if Recharge has dropped the
  // bundle_selection record. This keeps skipped weeks visible in the tabs.
  const knownBundleSubscriptionIds = new Set(bundleSubscriptionMap.keys());
  for (const { charge } of chargesBundleCheck) {
    for (const lineItem of charge.line_items) {
      if (
        lineItem.purchase_item_type === "subscription" &&
        knownBundleSubscriptionIds.has(lineItem.purchase_item_id)
      ) {
        registerChargeForSubscription(lineItem.purchase_item_id, charge.id);
      }
    }
  }

  // Pass 3 — a bundle subscription may have active charges with NO bundle_selection
  // at all (e.g. right after reactivation, which regenerates the charges without
  // selections). Passes 1–2 bootstrap discovery from existing selections, so they
  // miss this case entirely and the dashboard falls back to the read-only list.
  // Seed discovery from the customer's active bundle subscriptions so the editable
  // grid still renders (via the synthetic placeholder selection built below).
  const bundleProducts = await listBundleProducts();
  const bundleProductIds = new Set(bundleProducts.map((p) => p.external_product_id));
  for (const subscription of subscriptions) {
    const subProductId = subscription.external_product_id?.ecommerce;
    if (!subProductId || !bundleProductIds.has(subProductId)) continue;
    for (const { charge } of chargesBundleCheck) {
      if (chargeReferencesSubscription(charge, subscription.id)) {
        registerChargeForSubscription(subscription.id, charge.id);
      }
    }
  }

  const bundleSubscriptions = Array.from(bundleSubscriptionMap.values());

  // If the customer has no active bundle subscription, surface the most recent
  // cancelled bundle subscription so the dashboard can offer reactivation.
  let reactivatableSubscription: { id: number; productTitle: string } | null = null;
  if (bundleSubscriptions.length === 0) {
    const cancelledSubscriptions = await listSubscriptions(customerId, "cancelled");
    const cancelledBundle = cancelledSubscriptions
      .filter((s) => {
        const pid = s.external_product_id?.ecommerce;
        return pid != null && bundleProductIds.has(pid);
      })
      .sort((a, b) => b.id - a.id)[0];
    if (cancelledBundle) {
      reactivatableSubscription = { id: cancelledBundle.id, productTitle: cancelledBundle.product_title };
    }
  }
  const requestedSubscriptionId =
    selectedSubscription != null && /^\d+$/.test(selectedSubscription)
      ? Number(selectedSubscription)
      : null;
  const activeSubscription =
    (requestedSubscriptionId != null
      ? bundleSubscriptions.find((tab) => tab.purchaseItemId === requestedSubscriptionId)
      : null)
    ?? bundleSubscriptions[0]
    ?? null;

  const activeBundleVariantId =
    activeSubscription?.externalVariantId
    ?? getActiveBundleVariantId()
    ?? LEGACY_BUNDLE_VARIANT_ID;

  const deliveryDateOffset = activeBundleVariantId
    ? getDeliveryDateOffset(activeBundleVariantId)
    : DEFAULT_DELIVERY_OFFSET;
  const modificationWindowDays = activeBundleVariantId
    ? getModificationWindowDays(activeBundleVariantId)
    : DEFAULT_MODIFICATION_WINDOW;

  function chargeBelongsToSubscription(cb: { charge: Charge; bundleSelections: BundleSelection[] }, purchaseItemId: number): boolean {
    if (cb.bundleSelections.some((selection) => selection.purchase_item_id === purchaseItemId)) return true;
    return chargeReferencesSubscription(cb.charge, purchaseItemId);
  }

  const chargesForActiveSubscription = activeSubscription
    ? chargesBundleCheck.filter((cb) => chargeBelongsToSubscription(cb, activeSubscription.purchaseItemId))
    : chargesBundleCheck.filter((cb) => cb.bundleSelections.length > 0);

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const visibleCharges = chargesForActiveSubscription.filter((cb) => {
    if (cb.charge.status !== "skipped") return true;
    return new Date(cb.charge.scheduled_at) >= today;
  });

  const chargeTabs: ChargeTabInfo[] = visibleCharges.map((cb) => ({
    chargeId: cb.charge.id,
    scheduledAt: cb.charge.scheduled_at,
    totalPrice: cb.charge.total_price,
    hasBundles: cb.bundleSelections.length > 0,
    locked: isChargeLocked(cb.charge.scheduled_at, deliveryDateOffset, modificationWindowDays),
    status: cb.charge.status,
  }));

  // Phase 3: Load full Shopify data ONLY for the active/selected charge
  const activeEntry = selectedWeek
    ? visibleCharges.find((cb) => String(cb.charge.id) === selectedWeek) ?? visibleCharges[0]
    : visibleCharges[0];

  const activeCharge = activeEntry?.charge ?? null;

  let activeBundle: ActiveChargeBundle | null = null;

  if (activeEntry && activeSubscription) {
    const charge = activeEntry.charge;
    let bundleSelections = activeEntry.bundleSelections.filter(
      (selection) => selection.purchase_item_id === activeSubscription.purchaseItemId
    );

    // If this charge belongs to the active subscription via line_items but has
    // no bundle_selection (e.g. it was just unskipped, or was created without
    // any customer customization), build a synthetic placeholder using the
    // subscription's product info. The customer can then pick meals and we'll
    // create a real bundle_selection on save. Pre-fill it with what the charge
    // will ship: the subscription-level selection, else the bundle variant's
    // selection_defaults.
    let placeholderDefaults: DefaultBundleItem[] = [];
    if (bundleSelections.length === 0) {
      if (chargeReferencesSubscription(charge, activeSubscription.purchaseItemId)) {
        const subscription = subscriptionById.get(activeSubscription.purchaseItemId)
          ?? await getSubscription(activeSubscription.purchaseItemId).catch(() => null);
        const synthExternalProductId = subscription?.external_product_id?.ecommerce ?? null;
        const synthExternalVariantId = subscription?.external_variant_id?.ecommerce ?? null;
        const defaultSelection = defaultSelectionByPurchaseItem.get(activeSubscription.purchaseItemId);
        if (synthExternalProductId) {
          placeholderDefaults =
            defaultSelection?.external_product_id === synthExternalProductId
              ? defaultSelection.items
              : (bundleProducts
                  .flatMap((p) => p.variants)
                  .find((v) => v.external_variant_id === synthExternalVariantId)
                  ?.selection_defaults ?? []
                ).map((d) => ({ collection_id: null, ...d }));
          bundleSelections = [{
            id: 0,
            purchase_item_id: activeSubscription.purchaseItemId,
            external_product_id: synthExternalProductId,
            external_variant_id: synthExternalVariantId,
            items: [],
          }];
        }
      }
    }

    if (bundleSelections.length > 0) {

      const uniquePurchaseItemIds = [...new Set(bundleSelections.map((bs) => bs.purchase_item_id))];
      const subs = await Promise.all(uniquePurchaseItemIds.map((id) => getSubscription(id)));
      const subscriptionTitles = Object.fromEntries(subs.map((s) => [s.id, s.product_title]));

      const uniqueProductIds = [...new Set(bundleSelections.map((bs) => bs.external_product_id).filter(Boolean))] as string[];
      const bundleProductInfoList = await Promise.all(uniqueProductIds.map(getBundleProductInfo));

      const weekStart = getMondayOf(charge.scheduled_at);
      const activeBundleProductId =
        bundleProducts.find((p) =>
          p.variants.some((v) => v.external_variant_id === activeBundleVariantId)
        )?.id ?? null;
      const presetCollectionIds =
        activeBundleProductId != null
          ? await listPresetSchedules({ bundleProductId: activeBundleProductId })
              .then((rows) =>
                rows
                  .filter((row) => row.start_date === weekStart)
                  .map((row) => row.external_collection_id)
              )
              .catch(() => [] as string[])
          : [];

      // A preset schedule for the week is the merchant's curated menu. Without
      // one, fall back to the collections assigned to the bundle product so the
      // customer can browse the full bundle catalog, not just current picks.
      const bundleCollectionIds = bundleProductInfoList.flatMap((info) => info.collectionIds);
      const eligibleCollectionIds =
        presetCollectionIds.length > 0 ? presetCollectionIds : bundleCollectionIds;

      const hasPresetForWeek = eligibleCollectionIds.length > 0;

      // Defaults may come from anywhere in the bundle's catalog, not just this
      // week's menu, so load all of the bundle's collections to match them.
      const selectionCollectionIds = [
        ...bundleSelections.flatMap((bs) => bs.items.map((i) => i.collection_id)),
        ...placeholderDefaults.flatMap((d) => (d.collection_id ? [d.collection_id] : [])),
        ...(placeholderDefaults.length > 0 ? bundleCollectionIds : []),
      ];
      const collectionIds = [...new Set([...eligibleCollectionIds, ...selectionCollectionIds])];

      const availableCollections = await getBundleCollectionsFromShopify(collectionIds);
      let offMenuItems: EditableItem[] = [];
      if (placeholderDefaults.length > 0) {
        const resolved = resolveDefaultItems(placeholderDefaults, availableCollections);
        bundleSelections[0].items = resolved.items;
        offMenuItems = await loadOffMenuItems(resolved.offMenu);
      }
      const collectionsByProductId = Object.fromEntries(
        uniqueProductIds.map((pid) => [pid, availableCollections])
      ) as Record<string, typeof availableCollections>;
      const bundleProductRangesByProductId = Object.fromEntries(
        uniqueProductIds.map((pid, i) => [pid, bundleProductInfoList[i].quantityRanges])
      ) as Record<string, QuantityRange[]>;

      activeBundle = {
        charge,
        bundleSelections,
        subscriptionTitles,
        collectionsByProductId,
        bundleProductRangesByProductId,
        offMenuItems,
        eligibleCollectionIds: [...new Set(eligibleCollectionIds)],
        hasPresetForWeek,
      };
    }
  }

  // Fetch add-on products from merchant-configured collections
  let addonProducts: AddonProduct[] = [];
  const addonCollectionIds = activeBundleVariantId
    ? getAddonCollectionIds(activeBundleVariantId)
    : [];
  if (addonCollectionIds.length > 0) {
    const addonCollections = await getBundleCollectionsFromShopify(addonCollectionIds);
    const seen = new Set<string>();
    addonProducts = addonCollections.flatMap((col) =>
      col.products.flatMap((p) =>
        p.variants
          .filter((v) => {
            if (seen.has(String(v.id))) return false;
            seen.add(String(v.id));
            return true;
          })
          .map((v) => ({
            externalProductId: p.external_product_id,
            externalVariantId: String(v.id),
            title: p.title,
            variantTitle: v.title,
            imageUrl: p.image_url ?? null,
            price: v.price ?? "0.00",
            tags: p.tags ?? [],
          }))
      )
    );
  }

  const activeAddons = activeCharge
    ? activeCharge.line_items.filter((li) => li.purchase_item_type === "onetime")
    : [];

  return json({
    customer,
    subscriptions,
    activeCharges,
    bundleSubscriptions,
    reactivatableSubscription,
    activeSubscriptionId: activeSubscription?.purchaseItemId ?? null,
    activeBundleVariantId,
    chargeTabs,
    activeBundle,
    activeCharge,
    customerPreferences,
    deliveryDateOffset,
    modificationWindowDays,
    creditSummary,
    addonProducts,
    activeAddons,
    addresses,
  });
}

// ─── Action ───────────────────────────────────────────────────────────────────

export async function action({ params, request }: ActionFunctionArgs) {
  const { customerId } = params;
  if (!customerId || !/^\d+$/.test(customerId)) {
    throw new Response("Not Found", { status: 404 });
  }
  await requireCustomerOwnsId(request, customerId);

  const formData = await request.formData();
  const intent = formData.get("intent");
  const rawBundleVariantId = formData.get("bundleVariantId");
  const bundleVariantId =
    typeof rawBundleVariantId === "string" && rawBundleVariantId.trim().length > 0
      ? rawBundleVariantId.trim()
      : null;

  const LOCKED_ERROR = "This delivery is past the modification window and can no longer be changed.";

  function checkLockByScheduledAt(scheduledAt: string, variantId?: string | null): boolean {
    const resolvedBundleVariantId =
      variantId
      ?? getActiveBundleVariantId()
      ?? LEGACY_BUNDLE_VARIANT_ID;
    const offset = getDeliveryDateOffset(resolvedBundleVariantId);
    const window = getModificationWindowDays(resolvedBundleVariantId);
    return isChargeLocked(scheduledAt, offset, window);
  }

  if (intent === "reactivate_subscription") {
    const subscriptionId = formData.get("subscriptionId");
    if (typeof subscriptionId !== "string") {
      return json({ error: "Missing subscriptionId", intent: "reactivate_subscription" as const }, { status: 400 });
    }
    try {
      const sub = await getSubscription(Number(subscriptionId));
      if (sub.customer_id !== Number(customerId) || sub.status !== "cancelled") {
        throw new Response("Not Found", { status: 404 });
      }
      await activateSubscription(sub.id);
      return redirect(`/${customerId}`);
    } catch (err) {
      if (err instanceof Response) throw err;
      const message = err instanceof Error ? err.message : "Couldn't reactivate, please try again.";
      return json({ error: message, intent: "reactivate_subscription" as const });
    }
  }

  if (intent === "update_bundle") {
    const rawId = formData.get("bundleSelectionId");
    const rawItems = formData.get("items");
    const scheduledAt = formData.get("scheduledAt");
    if (typeof rawId !== "string" || typeof rawItems !== "string") {
      return json({ error: "Invalid payload" }, { status: 400 });
    }
    if (typeof scheduledAt === "string" && checkLockByScheduledAt(scheduledAt, bundleVariantId)) {
      return json({ error: LOCKED_ERROR, intent: "update_bundle" as const }, { status: 403 });
    }
    const items = JSON.parse(rawItems) as BundleItemPayload[];
    try {
      await updateBundleSelection(Number(rawId), items);
      return json({ success: true, intent: "update_bundle" } as const);
    } catch (err) {
      const raw = err instanceof Error ? err.message : "Failed to update bundle.";
      let message = "Failed to update bundle selection.";
      let ranges: number[][] | undefined;
      const colonIdx = raw.lastIndexOf(": ");
      if (colonIdx !== -1) {
        try {
          const parsed = JSON.parse(raw.slice(colonIdx + 2)) as {
            errors?: { message?: string; details?: { ranges?: number[][] } };
          };
          if (parsed.errors?.message) message = parsed.errors.message;
          if (parsed.errors?.details?.ranges) ranges = parsed.errors.details.ranges;
        } catch { /* not JSON */ }
      }
      return json({ error: message, ranges, intent: "update_bundle" as const });
    }
  }

  if (intent === "create_bundle") {
    const rawChargeId = formData.get("chargeId");
    const rawPurchaseItemId = formData.get("purchaseItemId");
    const rawItems = formData.get("items");
    const scheduledAt = formData.get("scheduledAt");
    if (typeof rawChargeId !== "string" || typeof rawPurchaseItemId !== "string" || typeof rawItems !== "string") {
      return json({ error: "Invalid payload", intent: "create_bundle" as const }, { status: 400 });
    }
    if (typeof scheduledAt === "string" && checkLockByScheduledAt(scheduledAt, bundleVariantId)) {
      return json({ error: LOCKED_ERROR, intent: "create_bundle" as const }, { status: 403 });
    }
    const items = JSON.parse(rawItems) as BundleItemPayload[];
    try {
      await createBundleSelection(Number(rawChargeId), Number(rawPurchaseItemId), items);
      return json({ success: true, intent: "create_bundle" } as const);
    } catch (err) {
      const raw = err instanceof Error ? err.message : "Failed to create bundle selection.";
      let message = "Failed to save selections.";
      let ranges: number[][] | undefined;
      const colonIdx = raw.lastIndexOf(": ");
      if (colonIdx !== -1) {
        try {
          const parsed = JSON.parse(raw.slice(colonIdx + 2)) as {
            errors?: { message?: string; details?: { ranges?: number[][] } };
          };
          if (parsed.errors?.message) message = parsed.errors.message;
          if (parsed.errors?.details?.ranges) ranges = parsed.errors.details.ranges;
        } catch { /* not JSON */ }
      }
      return json({ error: message, ranges, intent: "create_bundle" as const });
    }
  }

  if (intent === "update_preferences") {
    const customerId = formData.get("customerId");
    const rawExclude = formData.getAll("exclude");
    if (typeof customerId !== "string") {
      return json({ error: "Missing customerId" }, { status: 400 });
    }
    const exclude = rawExclude.filter((v): v is string => typeof v === "string");

    await saveCustomerPreferences(customerId, exclude);

    return json({ success: true, intent: "update_preferences" } as const);
  }

  if (intent === "skip") {
    const chargeId = formData.get("chargeId");
    const scheduledAt = formData.get("scheduledAt");
    const rawPurchaseItemId = formData.get("purchaseItemId");
    if (typeof chargeId !== "string") {
      return json({ error: "Missing chargeId" }, { status: 400 });
    }
    if (typeof scheduledAt === "string" && checkLockByScheduledAt(scheduledAt, bundleVariantId)) {
      return json({ error: LOCKED_ERROR, intent: "skip" as const }, { status: 403 });
    }
    const purchaseItemIds =
      typeof rawPurchaseItemId === "string" && rawPurchaseItemId
        ? [Number(rawPurchaseItemId)]
        : undefined;

    // Delete any onetime add-ons on this charge first, otherwise they would
    // still get charged when the subscription portion is skipped.
    try {
      const existingCharge = await getCharge(chargeId);
      const onetimeIds = existingCharge.line_items
        .filter((li) => li.purchase_item_type === "onetime")
        .map((li) => li.purchase_item_id);
      if (onetimeIds.length > 0) {
        await Promise.allSettled(onetimeIds.map((id) => deleteOnetime(id)));
      }
    } catch {
      // best-effort: continue with skip even if onetime cleanup fails
    }

    const charge = await skipCharge(chargeId, purchaseItemIds);
    return json({ success: true, intent: "skip" as const, chargeId: charge.id });
  }

  if (intent === "unskip") {
    const chargeId = formData.get("chargeId");
    const rawPurchaseItemId = formData.get("purchaseItemId");
    if (typeof chargeId !== "string") {
      return json({ error: "Missing chargeId", intent: "unskip" as const }, { status: 400 });
    }
    const purchaseItemIds =
      typeof rawPurchaseItemId === "string" && rawPurchaseItemId
        ? [Number(rawPurchaseItemId)]
        : undefined;
    try {
      const charge = await unskipCharge(chargeId, purchaseItemIds);
      return json({ success: true, intent: "unskip" as const, chargeId: charge.id });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to unskip charge.";
      return json({ error: message, intent: "unskip" as const });
    }
  }

  if (intent === "add_addon") {
    const addressId = formData.get("addressId");
    const scheduledAt = formData.get("scheduledAt");
    const externalProductId = formData.get("externalProductId");
    const externalVariantId = formData.get("externalVariantId");
    const price = formData.get("price");
    const rawQty = formData.get("quantity");

    if (
      typeof addressId !== "string" ||
      typeof scheduledAt !== "string" ||
      typeof externalProductId !== "string" ||
      typeof externalVariantId !== "string" ||
      typeof price !== "string"
    ) {
      return json({ error: "Missing required fields", intent: "add_addon" as const }, { status: 400 });
    }

    if (checkLockByScheduledAt(scheduledAt, bundleVariantId)) {
      return json({ error: LOCKED_ERROR, intent: "add_addon" as const }, { status: 403 });
    }

    const quantity = rawQty ? Number(rawQty) : 1;

    try {
      await createOnetime({
        address_id: Number(addressId),
        next_charge_scheduled_at: scheduledAt.slice(0, 10),
        external_product_id: { ecommerce: externalProductId },
        external_variant_id: { ecommerce: externalVariantId },
        quantity,
        price,
      });
      return json({ success: true, intent: "add_addon" as const });
    } catch (err) {
      const raw = err instanceof Error ? err.message : "Failed to add add-on.";
      let message = "Failed to add add-on.";
      const jsonStart = raw.indexOf("{");
      if (jsonStart !== -1) {
        try {
          const parsed = JSON.parse(raw.slice(jsonStart)) as {
            errors?: { general?: string };
            error?: string;
          };
          if (typeof parsed.errors?.general === "string" && parsed.errors.general.trim()) {
            message = parsed.errors.general;
          } else if (typeof parsed.error === "string" && parsed.error.trim()) {
            message = parsed.error;
          }
        } catch {
          message = raw;
        }
      } else {
        message = raw;
      }

      if (/must remove\/fix existing error charges first/i.test(message)) {
        message =
          "This customer has one or more failed charges. Fix or remove those failed charges in Recharge admin, then try adding this add-on again.";
      }
      return json({ error: message, intent: "add_addon" as const });
    }
  }

  if (intent === "remove_addon") {
    const onetimeId = formData.get("onetimeId");
    const scheduledAt = formData.get("scheduledAt");
    if (typeof onetimeId !== "string") {
      return json({ error: "Missing onetimeId", intent: "remove_addon" as const }, { status: 400 });
    }
    if (typeof scheduledAt === "string" && checkLockByScheduledAt(scheduledAt, bundleVariantId)) {
      return json({ error: LOCKED_ERROR, intent: "remove_addon" as const }, { status: 403 });
    }
    try {
      await deleteOnetime(Number(onetimeId));
      return json({ success: true, intent: "remove_addon" as const });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to remove add-on.";
      return json({ error: message, intent: "remove_addon" as const });
    }
  }

  if (intent === "update_address") {
    const addressId = formData.get("addressId");
    if (typeof addressId !== "string") {
      return json({ error: "Missing addressId", intent: "update_address" as const }, { status: 400 });
    }

    const fields: Record<string, string> = {};
    for (const key of ["first_name", "last_name", "address1", "address2", "city", "province", "zip", "country_code", "phone"]) {
      const val = formData.get(key);
      if (typeof val === "string" && val.trim() !== "") {
        fields[key] = val.trim();
      }
    }

    if (Object.keys(fields).length === 0) {
      return json({ error: "No fields to update", intent: "update_address" as const }, { status: 400 });
    }

    try {
      await updateAddress(Number(addressId), fields);
      return json({ success: true, intent: "update_address" as const });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to update address.";
      return json({ error: message, intent: "update_address" as const });
    }
  }

  return json({ error: "Unknown intent" }, { status: 400 });
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function Dashboard() {
  const {
    customer,
    subscriptions,
    activeCharges,
    bundleSubscriptions,
    reactivatableSubscription,
    activeSubscriptionId,
    activeBundleVariantId,
    chargeTabs,
    activeBundle,
    activeCharge,
    customerPreferences,
    deliveryDateOffset,
    modificationWindowDays,
    creditSummary,
    addonProducts,
    activeAddons,
    addresses,
  } =
    useLoaderData<typeof loader>();
  const { revalidate, state } = useRevalidator();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigation = useNavigation();

  useEffect(() => {
    const id = setInterval(revalidate, 30_000);
    return () => clearInterval(id);
  }, [revalidate]);

  // chargeTabs is already scoped to charges that belong to the active bundle
  // subscription (matched via bundle_selection or line_item). Show every one
  // of them so customers can edit, skip, or unskip every week — even charges
  // whose bundle_selection was dropped (e.g. unskipped weeks) where the
  // synthetic placeholder lets them pick meals from scratch.
  const tabsWithBundles = chargeTabs;
  const selectedWeek = searchParams.get("week");
  const activeIndex = selectedWeek
    ? Math.max(0, tabsWithBundles.findIndex((t) => String(t.chargeId) === selectedWeek))
    : 0;

  const activeTabLocked = tabsWithBundles[activeIndex]?.locked ?? false;
  const isLoadingTab = navigation.state === "loading";

  const activeChargeIsSkipped = activeCharge?.status === "skipped";
  // Active subscription's purchase_item_id, used by the SkippedBanner unskip form.
  // Prefer the bundleSelection's purchase_item_id when available; fall back to
  // the line_item match for skipped charges whose bundle_selection was dropped.
  const activeChargePurchaseItemId =
    activeBundle?.bundleSelections[0]?.purchase_item_id
    ?? (activeCharge && activeSubscriptionId != null
      ? activeCharge.line_items.find(
        (li) => li.purchase_item_type === "subscription" && li.purchase_item_id === activeSubscriptionId
      )?.purchase_item_id ?? activeSubscriptionId
      : null);

  const activeSub = subscriptions.find((s) => s.status === "active") ?? subscriptions[0];

  const selectWeek = (i: number) => {
    const params = new URLSearchParams(searchParams);
    params.set("week", String(tabsWithBundles[i].chargeId));
    setSearchParams(params, { preventScrollReset: true });
  };

  return (
    <div className="min-h-screen bg-cream bg-grain">
      <Header customer={customer} refreshing={state === "loading"} addresses={addresses} subscriptions={subscriptions} />

      <main className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
        {bundleSubscriptions.length > 1 && (
          <SubscriptionTabs
            subscriptions={bundleSubscriptions}
            activeSubscriptionId={activeSubscriptionId}
            onSelect={(purchaseItemId) => {
              const params = new URLSearchParams(searchParams);
              params.set("subscription", String(purchaseItemId));
              params.delete("week");
              setSearchParams(params, { preventScrollReset: true });
            }}
          />
        )}

        {tabsWithBundles.length > 0 ? (
          isLoadingTab && !activeBundle && !activeChargeIsSkipped ? (
            <LoadingGrid />
          ) : activeBundle ? (
            <WeekView
              key={activeBundle.charge.id}
              activeBundle={activeBundle}
              tabs={tabsWithBundles}
              activeIndex={activeIndex}
              onSelectWeek={selectWeek}
              deliveryDateOffset={deliveryDateOffset}
              modificationWindowDays={modificationWindowDays}
              bundleVariantId={activeBundleVariantId}
              locked={activeTabLocked}
              isLoadingTab={isLoadingTab}
              preferences={customerPreferences}
              customerId={String(customer.id)}
              addonProducts={addonProducts}
              activeAddons={activeAddons}
              creditSummary={creditSummary}
              purchaseItemId={activeChargePurchaseItemId}
              subscriptionFrequency={frequencyLabel(activeSub)}
            />
          ) : activeCharge && activeChargeIsSkipped ? (
            // Skipped charge whose bundle_selection was dropped by Recharge —
            // we still want the customer to see the week and unskip it.
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 animate-fade-in">
              <div className="lg:col-span-2 space-y-6">
                <NextDeliveryCard
                  scheduledAt={activeCharge.scheduled_at}
                  deliveryDateOffset={deliveryDateOffset}
                  mealsSelected={0}
                  minMeals={MEALS_PER_WEEK}
                  maxMeals={MEALS_PER_WEEK}
                  frequency={frequencyLabel(activeSub)}
                  skipped
                />
                <WeekTabs
                  tabs={tabsWithBundles}
                  activeIndex={activeIndex}
                  deliveryDateOffset={deliveryDateOffset}
                  onSelect={selectWeek}
                />
                <SkippedBanner
                  chargeId={activeCharge.id}
                  scheduledAt={activeCharge.scheduled_at}
                  deliveryDateOffset={deliveryDateOffset}
                  purchaseItemId={activeChargePurchaseItemId}
                  bundleVariantId={activeBundleVariantId}
                />
                <SkippedChargeSummary charge={activeCharge} deliveryDateOffset={deliveryDateOffset} />
              </div>
              <aside className="lg:col-span-1">
                <OrderTotalCard
                  totalPrice={activeCharge.total_price}
                  mealsSelected={0}
                  addonCount={0}
                  creditSummary={creditSummary}
                />
              </aside>
            </div>
          ) : null
        ) : activeCharges.length > 0 ? (
          <ChargesListSimple
            charges={activeCharges}
            subscriptions={subscriptions}
            deliveryDateOffset={deliveryDateOffset}
            modificationWindowDays={modificationWindowDays}
            bundleVariantId={activeBundleVariantId}
          />
        ) : reactivatableSubscription ? (
          <ReactivatePrompt subscription={reactivatableSubscription} />
        ) : (
          <EmptyState />
        )}
      </main>
    </div>
  );
}

function frequencyLabel(sub: Subscription | undefined): string | null {
  if (!sub?.charge_interval_frequency || !sub?.order_interval_unit) return null;
  const n = sub.charge_interval_frequency;
  const unit = sub.order_interval_unit;
  if (n === 1) {
    if (unit === "week") return "Delivered weekly";
    if (unit === "month") return "Delivered monthly";
  }
  return `Delivered every ${n} ${unit}${n > 1 ? "s" : ""}`;
}

// ─── Week view (two-column: meals + add-on sidebar) ───────────────────────────

function WeekView({
  activeBundle,
  tabs,
  activeIndex,
  onSelectWeek,
  deliveryDateOffset,
  modificationWindowDays,
  bundleVariantId,
  locked,
  isLoadingTab,
  preferences,
  customerId,
  addonProducts,
  activeAddons,
  creditSummary,
  purchaseItemId,
  subscriptionFrequency,
}: {
  activeBundle: ActiveChargeBundle;
  tabs: ChargeTabInfo[];
  activeIndex: number;
  onSelectWeek: (index: number) => void;
  deliveryDateOffset: number;
  modificationWindowDays: number;
  bundleVariantId: string;
  locked: boolean;
  isLoadingTab: boolean;
  preferences: CustomerPreference | null;
  customerId: string;
  addonProducts: AddonProduct[];
  activeAddons: ChargeLineItem[];
  creditSummary: CreditSummary | null;
  purchaseItemId: number | null;
  subscriptionFrequency: string | null;
}) {
  const charge = activeBundle.charge;
  const primary = activeBundle.bundleSelections[0] ?? null;
  const isSkipped = charge.status === "skipped";

  const initialCount = primary
    ? [...primary.items, ...activeBundle.offMenuItems].reduce((sum, item) => sum + item.quantity, 0)
    : 0;
  const [mealsSelected, setMealsSelected] = useState(initialCount);
  const [isPrefSaving, setIsPrefSaving] = useState(false);

  const quantityRanges = primary?.external_product_id
    ? (activeBundle.bundleProductRangesByProductId[primary.external_product_id] ?? [])
    : [];
  const { min: minMeals, max: maxMeals } = mealCountRange(quantityRanges);

  if (isLoadingTab) {
    return (
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 animate-fade-in">
        <div className="lg:col-span-2 space-y-6">
          <div className="card p-5">
            <div className="h-3 skeleton rounded w-32 mb-3" />
            <div className="flex gap-2.5 overflow-hidden">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="shrink-0 min-w-[120px] h-[72px] skeleton rounded-2xl" />
              ))}
            </div>
            <div className="border-t border-stone-100 mt-4 pt-4 flex items-center justify-between">
              <div className="space-y-2">
                <div className="h-2.5 skeleton rounded w-16" />
                <div className="h-7 skeleton rounded w-36" />
                <div className="h-2 skeleton rounded w-24" />
              </div>
              <div className="h-9 skeleton rounded-xl w-32" />
            </div>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="card overflow-hidden">
                <div className="aspect-square skeleton" />
                <div className="p-3 space-y-2">
                  <div className="h-3 skeleton rounded w-3/4 mx-auto" />
                  <div className="h-3 skeleton rounded w-1/2 mx-auto" />
                  <div className="flex justify-center gap-2 pt-1">
                    <div className="w-8 h-8 skeleton rounded-full" />
                    <div className="w-5 h-5 skeleton rounded self-center" />
                    <div className="w-8 h-8 skeleton rounded-full" />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
        <aside className="space-y-4">
          <div className="card p-5 space-y-3">
            <div className="h-3 skeleton rounded w-20" />
            <div className="h-16 skeleton rounded-lg" />
            <div className="h-16 skeleton rounded-lg" />
            <div className="h-16 skeleton rounded-lg" />
          </div>
          <div className="card p-5 space-y-3">
            <div className="h-3 skeleton rounded w-24" />
            <div className="h-8 skeleton rounded" />
          </div>
        </aside>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 animate-fade-in">
      <div className={`lg:col-span-2 space-y-6 ${charge.status === "queued" && !locked ? "pb-28" : ""}`}>
        <WeekContextCard
          tabs={tabs}
          activeIndex={activeIndex}
          onSelect={onSelectWeek}
          deliveryDateOffset={deliveryDateOffset}
          modificationWindowDays={modificationWindowDays}
          scheduledAt={charge.scheduled_at}
          frequency={subscriptionFrequency}
          isSkipped={isSkipped}
          locked={locked}
          chargeId={charge.id}
          purchaseItemId={primary?.purchase_item_id ?? purchaseItemId}
          bundleVariantId={bundleVariantId}
        />

        <div className="card p-4 sm:p-5">
          <MealsHeader
            mealsSelected={mealsSelected}
            minMeals={minMeals}
            maxMeals={maxMeals}
            preferences={preferences}
            customerId={customerId}
            scheduledAt={charge.scheduled_at}
            deliveryDateOffset={deliveryDateOffset}
            onSavingChange={setIsPrefSaving}
          />

          {primary && (
            <MealGrid
              key={primary.id}
              charge={charge}
              bundleSelection={primary}
              offMenuItems={activeBundle.offMenuItems}
              availableCollections={primary.external_product_id ? (activeBundle.collectionsByProductId[primary.external_product_id] ?? []) : []}
              quantityRanges={quantityRanges}
              preferences={preferences}
              eligibleCollectionIds={activeBundle.eligibleCollectionIds}
              hasPresetForWeek={activeBundle.hasPresetForWeek}
              bundleVariantId={bundleVariantId}
              locked={locked}
              onCountChange={setMealsSelected}
              isPrefSaving={isPrefSaving}
            />
          )}
        </div>
      </div>

      <aside className="lg:col-span-1 space-y-6">
        <AddOnsSidebar
          products={addonProducts}
          addedItems={activeAddons}
          addressId={charge.address_id ?? 0}
          scheduledAt={charge.scheduled_at}
          bundleVariantId={bundleVariantId}
          preferences={preferences}
          locked={locked}
        />
        <OrderTotalCard
          totalPrice={charge.total_price}
          mealsSelected={mealsSelected}
          addonCount={activeAddons.length}
          creditSummary={creditSummary}
        />
      </aside>
    </div>
  );
}

// ─── Next delivery hero card ──────────────────────────────────────────────────

// Derive the allowed meal-count envelope from a bundle's quantity ranges.
// quantityRanges is a list of [min, max] pairs; we collapse it to the overall
// min/max. Falls back to MEALS_PER_WEEK when the bundle exposes no ranges.
// A range with no upper limit makes max Infinity.
function mealCountRange(quantityRanges: QuantityRange[]): { min: number; max: number } {
  if (quantityRanges.length === 0) return { min: MEALS_PER_WEEK, max: MEALS_PER_WEEK };
  return {
    min: Math.min(...quantityRanges.map(([min]) => min)),
    max: Math.max(...quantityRanges.map(([, max]) => max ?? Infinity)),
  };
}

// Formats an allowed range for display: "3-5" for a range, "5" when fixed,
// "3+" when there's no upper limit.
function mealRangeLabel(min: number, max: number): string {
  if (!Number.isFinite(max)) return `${min}+`;
  return min === max ? `${max}` : `${min}-${max}`;
}

// Contextual helper text under the next-delivery progress bar: nudge to reach
// the minimum while under it, then invite adding up to the maximum, then confirm.
function mealHelperText(count: number, min: number, max: number): string {
  // Fixed-size bundle (min === max): "at least" is misleading, so say exactly.
  if (count < min) return min === max ? `Select ${min} meals` : `Select at least ${min} meals`;
  if (count >= max) return "All meals selected";
  if (!Number.isFinite(max)) return "Add as many meals as you like";
  const remaining = max - count;
  return `Add up to ${remaining} more ${remaining === 1 ? "meal" : "meals"}`;
}

function NextDeliveryCard({
  scheduledAt,
  deliveryDateOffset,
  mealsSelected,
  minMeals,
  maxMeals,
  frequency,
  skipped = false,
  editHref,
}: {
  scheduledAt: string;
  deliveryDateOffset: number;
  mealsSelected: number;
  minMeals: number;
  maxMeals: number;
  frequency: string | null;
  skipped?: boolean;
  editHref?: string;
}) {
  const deliveryDate = addDaysToDate(scheduledAt, deliveryDateOffset);
  // "Complete" (green) means the selection is within the allowed range, not
  // exactly max — so 3-5 meals all read as valid.
  const complete = maxMeals > 0 && mealsSelected >= minMeals && mealsSelected <= maxMeals;
  // Fill tracks progress toward the minimum required, so the bar reads full &
  // green as soon as the selection is valid/savable (3 of 3-5 = 100%).
  const pct = minMeals > 0 ? Math.min(100, (mealsSelected / minMeals) * 100) : 0;

  return (
    <div className="card p-5 sm:p-6">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wider text-stone-500">Next delivery</p>
          <p className="font-display text-2xl sm:text-3xl font-bold text-stone-900 mt-1 leading-tight">
            {formatDate(deliveryDate)}
          </p>
          {frequency && <p className="text-xs text-stone-500 mt-1">{frequency}</p>}
        </div>

        <div className="flex items-center gap-3 flex-none">
          <span
            className={`badge ${complete ? "bg-brand-100 text-brand-700" : "bg-amber-100 text-amber-700"}`}
          >
            {mealsSelected} of {maxMeals} meals
          </span>
        </div>
      </div>

      <div className="mt-4 h-2 bg-stone-100 rounded-full overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-500 ease-out"
          style={{
            width: `${pct}%`,
            background: skipped
              ? "#d6d3d1"
              : complete
                ? "linear-gradient(to right, #6aab28, #88cf42)"
                : "#fbbf24",
          }}
        />
      </div>

      {!skipped && (
        <p className={`mt-2 text-xs font-medium ${complete ? "text-stone-400" : "text-amber-600"}`}>
          {mealHelperText(mealsSelected, minMeals, maxMeals)}
        </p>
      )}
    </div>
  );
}

// ─── Meals header + taste-profile preferences ─────────────────────────────────

function MealsHeader({
  mealsSelected,
  minMeals,
  maxMeals,
  preferences,
  customerId,
  scheduledAt,
  deliveryDateOffset,
  onSavingChange,
}: {
  mealsSelected: number;
  minMeals: number;
  maxMeals: number;
  preferences: CustomerPreference | null;
  customerId: string;
  scheduledAt: string;
  deliveryDateOffset: number;
  onSavingChange?: (saving: boolean) => void;
}) {
  const fetcher = useFetcher<typeof action>();
  const persisted = preferences?.exclude ?? [];

  // While a save is in flight, optimistically reflect the submitted values so
  // chips toggle instantly instead of waiting for the loader to revalidate.
  const optimistic =
    fetcher.formData && fetcher.formData.get("intent") === "update_preferences"
      ? (fetcher.formData.getAll("exclude").filter((v): v is string => typeof v === "string"))
      : null;
  const current = optimistic ?? persisted;
  const saving = fetcher.state !== "idle";

  useEffect(() => {
    onSavingChange?.(saving);
  }, [saving, onSavingChange]);

  const justSaved =
    fetcher.state === "idle" &&
    fetcher.data != null &&
    "success" in fetcher.data &&
    (fetcher.data as { intent?: string }).intent === "update_preferences";

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string[]>(persisted);

  const persist = (next: string[]) => {
    const formData = new FormData();
    formData.set("intent", "update_preferences");
    formData.set("customerId", customerId);
    for (const tag of next) formData.append("exclude", tag);
    fetcher.submit(formData, { method: "post" });
  };

  const toggleQuick = (filter: (typeof DIET_FILTERS)[number]) => {
    const active = filter.tags.some((t) => excludeIncludes(current, t));
    const next = active
      ? current.filter((e) => !filter.tags.some((t) => t.toLowerCase() === e.toLowerCase()))
      : [...new Set([...current, ...filter.tags])];
    persist(next);
  };

  const openEditor = () => {
    setDraft(current);
    setEditing(true);
  };

  const toggleDraft = (tag: string) =>
    setDraft((prev) =>
      excludeIncludes(prev, tag) ? prev.filter((e) => e.toLowerCase() !== tag.toLowerCase()) : [...prev, tag]
    );

  // Surface any saved exclusion that isn't one of the predefined options so the
  // customer can still see and remove it.
  const extraOptions = current.filter((e) => !PREFERENCE_OPTIONS.some((o) => o.toLowerCase() === e.toLowerCase()));
  const editorOptions = [...PREFERENCE_OPTIONS, ...extraOptions];

  const activeCount = current.length;

  return (
    <div className="mb-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-display text-xl font-bold text-stone-900">
          Your meals for {formatDate(addDaysToDate(scheduledAt, deliveryDateOffset))}
          <span className="ml-2 text-sm font-medium text-stone-500">
            · Choose {mealRangeLabel(minMeals, maxMeals)} meals
          </span>
        </h2>

        <button
          type="button"
          onClick={openEditor}
          className="inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold transition-all duration-150 border-stone-200 bg-white text-stone-600 hover:border-stone-300 hover:text-stone-800"
        >
          {activeCount > 0 ? (
            <>
              <span className="w-1.5 h-1.5 rounded-full bg-amber-400 flex-none" />
              Avoiding {current.join(" · ")}
            </>
          ) : (
            "Dietary preferences"
          )}
        </button>
      </div>

      {editing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm animate-fade-in" onClick={() => setEditing(false)} />
          <div className="relative bg-white rounded-2xl shadow-xl w-full max-w-sm mx-4 animate-scale-in">
            <div className="flex items-center justify-between px-5 py-4 border-b border-stone-100">
              <h3 className="font-display text-base font-bold text-stone-900">Ingredients I avoid</h3>
              <button
                type="button"
                onClick={() => setEditing(false)}
                className="p-1 rounded-md text-stone-400 hover:text-stone-600 hover:bg-stone-100 transition-colors"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="px-5 py-4">
              <p className="text-sm text-stone-500 mb-4">
                Select ingredients you'd like to avoid. Meals containing them won't show up in your menu. Saved to your account.
              </p>

              <div className="flex flex-wrap gap-2">
                {editorOptions.map((tag) => {
                  const active = excludeIncludes(draft, tag);
                  return (
                    <button
                      key={tag}
                      type="button"
                      onClick={() => toggleDraft(tag)}
                      className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-medium transition-all duration-150 ${
                        active
                          ? "border-amber-300 bg-amber-50 text-amber-700"
                          : "border-stone-200 bg-stone-50 text-stone-500 hover:border-stone-300 hover:text-stone-700 hover:bg-white"
                      }`}
                    >
                      {active ? (
                        <svg className="w-3.5 h-3.5 text-amber-500 flex-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M3.98 8.223A10.477 10.477 0 0 0 1.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.451 10.451 0 0 1 12 4.5c4.756 0 8.773 3.162 10.065 7.498a10.522 10.522 0 0 1-4.293 5.774M6.228 6.228 3 3m3.228 3.228 3.65 3.65m7.894 7.894L21 21m-3.228-3.228-3.65-3.65m0 0a3 3 0 1 0-4.243-4.243m4.242 4.242L9.88 9.88" />
                        </svg>
                      ) : (
                        <svg className="w-3.5 h-3.5 text-stone-300 flex-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 0 1 0-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178Z" /><path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
                        </svg>
                      )}
                      {tag}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="flex items-center justify-end gap-3 px-5 py-4 border-t border-stone-100">
              <button
                type="button"
                disabled={saving}
                onClick={() => setEditing(false)}
                className="px-3 py-2 text-sm font-medium text-stone-500 hover:text-stone-700 transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={saving}
                onClick={() => { persist(draft); setEditing(false); }}
                className="btn-primary text-sm px-5 py-2"
              >
                {saving ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Unified week context card (tabs + date hero + status + skip action) ────────

function WeekContextCard({
  tabs,
  activeIndex,
  onSelect,
  deliveryDateOffset,
  modificationWindowDays,
  scheduledAt,
  frequency,
  isSkipped,
  locked,
  chargeId,
  purchaseItemId,
  bundleVariantId,
}: {
  tabs: ChargeTabInfo[];
  activeIndex: number;
  onSelect: (i: number) => void;
  deliveryDateOffset: number;
  modificationWindowDays: number;
  scheduledAt: string;
  frequency: string | null;
  isSkipped: boolean;
  locked: boolean;
  chargeId: number;
  purchaseItemId: number | null;
  bundleVariantId: string;
}) {
  const deliveryDate = addDaysToDate(scheduledAt, deliveryDateOffset);
  const deliveryStr = formatDate(deliveryDate);
  const cutoff = new Date(deliveryDate + "T00:00:00Z");
  cutoff.setUTCDate(cutoff.getUTCDate() - modificationWindowDays);
  const cutoffStr = cutoff.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

  const scrollRef = useRef<HTMLDivElement>(null);
  const [canScrollRight, setCanScrollRight] = useState(false);
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const check = () => setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 4);
    check();
    el.addEventListener("scroll", check, { passive: true });
    window.addEventListener("resize", check);
    return () => { el.removeEventListener("scroll", check); window.removeEventListener("resize", check); };
  }, [tabs]);

  // Scroll the active tab into view whenever activeIndex changes.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const btn = el.querySelectorAll("button[data-tab]")[activeIndex] as HTMLElement | undefined;
    btn?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
  }, [activeIndex]);

  return (
    <div className="card p-5">
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs font-semibold uppercase tracking-wider text-stone-500">Upcoming deliveries</p>
        {frequency && <span className="text-xs text-stone-500">{frequency}</span>}
      </div>

      <div className="relative -mx-5">
        {canScrollRight && (
          <div className="absolute right-0 top-0 bottom-1 w-16 bg-gradient-to-l from-white to-transparent z-10 pointer-events-none rounded-r-2xl" />
        )}
        <div className="absolute left-0 top-0 bottom-1 w-4 bg-gradient-to-r from-white to-transparent z-10 pointer-events-none rounded-l-2xl" />
      <div
        ref={scrollRef}
        className="flex gap-2.5 overflow-x-auto scrollbar-hide px-5 pb-1"
        onTouchStart={(e) => { touchStartRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY }; }}
        onTouchEnd={(e) => {
          const start = touchStartRef.current;
          if (!start) return;
          const dx = e.changedTouches[0].clientX - start.x;
          const dy = e.changedTouches[0].clientY - start.y;
          if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 48) {
            if (dx < 0) onSelect(Math.min(tabs.length - 1, activeIndex + 1));
            else onSelect(Math.max(0, activeIndex - 1));
          }
          touchStartRef.current = null;
        }}
      >
        {tabs.map((tab, i) => {
          const isActive = i === activeIndex;
          const tabIsSkipped = tab.status === "skipped";
          const tabDeliveryDate = addDaysToDate(tab.scheduledAt, deliveryDateOffset);
          const inactiveClass = tabIsSkipped
            ? "bg-amber-50/60 text-amber-700 border-amber-200 hover:border-amber-400 hover:shadow-warm-sm"
            : "bg-white text-stone-600 border-stone-200 hover:border-stone-400 hover:shadow-warm-sm";
          const activeStyle = isActive
            ? tabIsSkipped
              ? { backgroundColor: "#fef9ec", borderColor: "#d97706", boxShadow: "0 2px 8px rgba(28,25,23,0.08)" }
              : { backgroundColor: "#edf2e6", borderColor: "rgba(80,133,25,0.6)", boxShadow: "0 2px 8px rgba(28,25,23,0.08)" }
            : undefined;
          return (
            <button
              key={tab.chargeId}
              data-tab={i}
              onClick={() => onSelect(i)}
              className={`shrink-0 min-w-[120px] rounded-2xl px-3 py-2.5 text-left transition-all duration-200 border ${isActive ? "" : inactiveClass}`}
              style={activeStyle}
            >
              <p className="flex items-center gap-1 text-[11px] font-semibold leading-tight">
                {tab.locked && (
                  <svg className="w-3 h-3 flex-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                  </svg>
                )}
                <span className={`truncate ${tabIsSkipped ? "line-through opacity-70" : ""}`}>
                  {formatWeekLabel(tabDeliveryDate)}
                </span>
              </p>
              <p className="mt-1 text-base font-bold tabular-nums text-stone-800">
                {formatCurrency(tab.totalPrice)}
              </p>
              {tabIsSkipped && (
                <span className={`mt-1 inline-flex items-center text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-full ${isActive ? "bg-amber-200 text-amber-900" : "bg-amber-100 text-amber-800"}`}>
                  Skipped
                </span>
              )}
            </button>
          );
        })}
      </div>
      </div>

      {tabs.length > 1 && tabs.length <= 8 && (
        <div className="flex md:hidden items-center justify-center gap-2 mt-3">
          {tabs.map((_, i) => (
            <button
              key={i}
              onClick={() => onSelect(i)}
              aria-label={`Go to delivery ${i + 1}`}
              className={`rounded-full transition-all duration-200 ${
                i === activeIndex
                  ? "w-5 h-2 bg-stone-600"
                  : "w-2 h-2 bg-stone-300 hover:bg-stone-500"
              }`}
            />
          ))}
        </div>
      )}

      <div className="border-t border-stone-100 mt-4 pt-4 flex items-center justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-stone-500 mb-1">Delivering</p>
          <p className={`font-display text-2xl sm:text-3xl font-bold leading-tight ${isSkipped ? "text-stone-400 line-through" : "text-stone-900"}`}>{deliveryStr}</p>
          {locked ? (
            <p className="text-xs font-medium text-amber-700 mt-1">Editing closed · last day was {cutoffStr}</p>
          ) : !isSkipped ? (
            <p className="text-xs text-stone-500 mt-1">Last day to make changes: {cutoffStr}</p>
          ) : null}
        </div>

        {locked ? (
          <div className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-amber-50 border border-amber-200 shrink-0">
            <svg className="w-4 h-4 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
            <span className="text-xs font-semibold text-amber-800">Locked</span>
          </div>
        ) : !isSkipped ? (
          <SkipWeekButton chargeId={chargeId} scheduledAt={scheduledAt} purchaseItemId={purchaseItemId} bundleVariantId={bundleVariantId} />
        ) : null}
      </div>

      {isSkipped && (
        <div className="mt-3 rounded-xl bg-amber-50 border border-amber-200 px-4 py-3 flex flex-col sm:flex-row sm:items-center gap-3">
          <div className="flex items-start gap-2.5 flex-1">
            <svg className="w-4 h-4 text-amber-600 flex-none mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <p className="text-sm text-amber-800">
              <span className="font-semibold">This week is skipped</span> — your delivery won't be sent. Any add-ons have been removed and will need to be re-added if you unskip.
            </p>
          </div>
          <WeekContextUnskipButton chargeId={chargeId} purchaseItemId={purchaseItemId} bundleVariantId={bundleVariantId} />
        </div>
      )}
    </div>
  );
}

function WeekContextUnskipButton({
  chargeId,
  purchaseItemId,
  bundleVariantId,
}: {
  chargeId: number;
  purchaseItemId: number | null;
  bundleVariantId: string;
}) {
  const fetcher = useFetcher<typeof action>();
  const isUnskipping = fetcher.state !== "idle";
  const error =
    fetcher.state === "idle" && fetcher.data != null && "error" in fetcher.data
      ? (fetcher.data as { error: string }).error
      : null;
  return (
    <div className="shrink-0">
      <fetcher.Form method="post">
        <input type="hidden" name="intent" value="unskip" />
        <input type="hidden" name="bundleVariantId" value={bundleVariantId} />
        <input type="hidden" name="chargeId" value={String(chargeId)} />
        {purchaseItemId != null && <input type="hidden" name="purchaseItemId" value={String(purchaseItemId)} />}
        <button
          type="submit"
          disabled={isUnskipping}
          className="inline-flex items-center gap-2 rounded-lg border border-stone-200 bg-white px-4 py-2.5 text-sm font-semibold text-stone-500 transition-all duration-150 hover:bg-stone-50 hover:text-stone-700 hover:border-stone-300 active:scale-[0.99] disabled:opacity-60 shadow-warm-sm"
        >
          {isUnskipping ? "Unskipping..." : "Unskip this week"}
        </button>
      </fetcher.Form>
      {error && <p className="mt-1 text-xs font-medium text-red-700">{error}</p>}
    </div>
  );
}

// ─── Skip week button (under the week picker) ─────────────────────────────────

function SkipWeekButton({
  chargeId,
  scheduledAt,
  purchaseItemId,
  bundleVariantId,
}: {
  chargeId: number;
  scheduledAt: string;
  purchaseItemId: number | null;
  bundleVariantId: string;
}) {
  const fetcher = useFetcher<typeof action>();
  const isSkipping = fetcher.state !== "idle";
  const error =
    fetcher.state === "idle" && fetcher.data != null && "error" in fetcher.data
      ? (fetcher.data as { error: string }).error
      : null;

  return (
    <div>
      <fetcher.Form method="post">
        <input type="hidden" name="intent" value="skip" />
        <input type="hidden" name="bundleVariantId" value={bundleVariantId} />
        <input type="hidden" name="chargeId" value={String(chargeId)} />
        <input type="hidden" name="scheduledAt" value={scheduledAt} />
        {purchaseItemId != null && <input type="hidden" name="purchaseItemId" value={String(purchaseItemId)} />}
        <button
          type="submit"
          disabled={isSkipping}
          className="inline-flex items-center gap-2 rounded-lg border border-stone-200 bg-white px-4 py-2.5 text-sm font-semibold text-stone-500 transition-all duration-150 hover:bg-stone-50 hover:text-stone-700 hover:border-stone-300 active:scale-[0.99] disabled:opacity-60 shadow-warm-sm"
        >
          {isSkipping ? (
            <>
              <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              Skipping this week...
            </>
          ) : (
            <>
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 5l7 7-7 7M13 5l7 7-7 7" />
              </svg>
              Skip this week
            </>
          )}
        </button>
      </fetcher.Form>
      {error && <p className="mt-1.5 text-xs font-medium text-red-700">{error}</p>}
    </div>
  );
}

// ─── Order total summary ──────────────────────────────────────────────────────

function OrderTotalCard({
  totalPrice,
  mealsSelected,
  addonCount,
  creditSummary,
}: {
  totalPrice: string;
  mealsSelected: number;
  addonCount: number;
  creditSummary: CreditSummary | null;
}) {
  const hasCredits = creditSummary && parseFloat(creditSummary.total_available_balance) > 0;

  return (
    <div className="card p-5 lg:sticky lg:top-6">
      <p className="text-xs font-semibold uppercase tracking-wider text-stone-500">Order total</p>
      <div className="mt-2 space-y-1">
        <div className="flex items-center gap-1.5 text-xs text-stone-500">
          <svg className="w-3.5 h-3.5 text-brand-600 flex-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
          </svg>
          {mealsSelected} meal{mealsSelected !== 1 ? "s" : ""}
        </div>
        {addonCount > 0 && (
          <div className="flex items-center gap-1.5 text-xs text-stone-500">
            <svg className="w-3.5 h-3.5 text-brand-600 flex-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
            </svg>
            {addonCount} add-on{addonCount !== 1 ? "s" : ""}
          </div>
        )}
      </div>
      <p className="font-display text-2xl font-bold text-stone-900 tabular-nums mt-3">{formatCurrency(totalPrice)}</p>

      {hasCredits && (
        <div className="mt-3 flex items-center gap-1.5 rounded-lg bg-brand-50 px-3 py-2 text-xs font-medium text-brand-700">
          <svg className="w-4 h-4 flex-none" viewBox="0 0 20 20" fill="currentColor">
            <path d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.736 6.979C9.208 6.193 9.696 6 10 6c.304 0 .792.193 1.264.979a1 1 0 001.715-1.029C12.279 4.784 11.232 4 10 4s-2.279.784-2.979 1.95c-.285.475-.507 1-.67 1.55H6a1 1 0 000 2h.013a9.358 9.358 0 000 1H6a1 1 0 100 2h.351c.163.55.385 1.075.67 1.55C7.721 15.216 8.768 16 10 16s2.279-.784 2.979-1.95a1 1 0 10-1.715-1.029c-.472.786-.96.979-1.264.979-.304 0-.792-.193-1.264-.979a5.38 5.38 0 01-.491-.921H10a1 1 0 100-2H8.003a7.364 7.364 0 010-1H10a1 1 0 100-2H8.245c.155-.347.335-.665.491-.921z" />
          </svg>
          {formatCurrency(creditSummary!.total_available_balance, creditSummary!.currency_code)} credit available
        </div>
      )}
    </div>
  );
}

// ─── Add-ons sidebar ──────────────────────────────────────────────────────────

function AddOnsSidebar({
  products,
  addedItems,
  addressId,
  scheduledAt,
  bundleVariantId,
  preferences,
  locked = false,
}: {
  products: AddonProduct[];
  addedItems: ChargeLineItem[];
  addressId: number;
  scheduledAt: string;
  bundleVariantId: string;
  preferences: CustomerPreference | null;
  locked?: boolean;
}) {
  if (products.length === 0 && addedItems.length === 0) return null;

  const exclude = preferences?.exclude ?? [];
  const imageByVariantId = Object.fromEntries(
    products.filter((p) => p.imageUrl).map((p) => [p.externalVariantId, p.imageUrl])
  );
  const addedVariantIds = new Set(
    addedItems.map((i) => i.external_variant_id?.ecommerce).filter(Boolean) as string[]
  );
  const available = products.filter((p) => !addedVariantIds.has(p.externalVariantId));

  return (
    <div className="card overflow-hidden">
      <div className="px-5 pt-5 pb-3">
        <h3 className="font-display text-base font-bold text-stone-900">Add something extra</h3>
        <p className="text-xs text-stone-500 mt-1">Add-ons are separate from your meal plan.</p>
      </div>

      <div className="divide-y divide-stone-100">
        {addedItems.map((item) => (
          <AddedAddonRow
            key={item.purchase_item_id}
            item={item}
            imageByVariantId={imageByVariantId}
            locked={locked}
            scheduledAt={scheduledAt}
            bundleVariantId={bundleVariantId}
          />
        ))}
        {available.map((product) => (
          <AddonSidebarRow
            key={product.externalVariantId}
            product={product}
            addressId={addressId}
            scheduledAt={scheduledAt}
            bundleVariantId={bundleVariantId}
            excluded={matchesTags(product.tags, exclude)}
            allergens={allergenLabel(product.tags, exclude)}
            locked={locked}
          />
        ))}
      </div>
    </div>
  );
}

function AddonSidebarRow({
  product,
  addressId,
  scheduledAt,
  bundleVariantId,
  excluded,
  allergens,
  locked = false,
}: {
  product: AddonProduct;
  addressId: number;
  scheduledAt: string;
  bundleVariantId: string;
  excluded: boolean;
  allergens: string | null;
  locked?: boolean;
}) {
  const fetcher = useFetcher<typeof action>();
  const isAdding = fetcher.state !== "idle";
  const fetcherData = fetcher.data as
    | { success: true; intent: "add_addon" }
    | { error: string; intent: "add_addon" }
    | undefined;
  const wasAdded = fetcher.state === "idle" && fetcherData != null && "success" in fetcherData;
  const addError =
    fetcher.state === "idle" && fetcherData != null && "error" in fetcherData
      ? (fetcherData as { error: string }).error
      : null;

  const handleAdd = () => {
    fetcher.submit(
      {
        intent: "add_addon",
        bundleVariantId,
        addressId: String(addressId),
        scheduledAt,
        externalProductId: product.externalProductId,
        externalVariantId: product.externalVariantId,
        price: product.price,
        quantity: "1",
      },
      { method: "post" }
    );
  };

  return (
    <div className={`flex items-center gap-3 px-5 py-3 transition-opacity ${excluded ? "opacity-60" : ""}`}>
      {product.imageUrl ? (
        <img
          src={product.imageUrl}
          alt={product.title}
          className={`w-11 h-11 rounded-lg object-cover flex-none bg-stone-100 ${excluded ? "grayscale" : ""}`}
        />
      ) : (
        <div className="w-11 h-11 rounded-lg bg-stone-100 flex items-center justify-center flex-none">
          <svg className="w-5 h-5 text-stone-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
          </svg>
        </div>
      )}

      <div className="flex-1 min-w-0">
        <p className={`text-sm font-semibold leading-tight truncate ${excluded ? "text-stone-400 line-through" : "text-stone-800"}`}>
          {product.title}
        </p>
        {excluded && allergens ? (
          <p className="text-xs font-medium mt-0.5" style={{ color: "#E87B30" }}>{allergens}</p>
        ) : (
          <p className="text-sm font-bold text-stone-900 mt-0.5">{formatCurrency(product.price)}</p>
        )}
        {addError && <p className="text-xs text-red-600 mt-0.5 line-clamp-2">{addError}</p>}
      </div>

      <div className="flex-none">
        {excluded || locked ? (
          <span className="inline-flex items-center rounded-lg bg-stone-100 px-3 py-1.5 text-xs font-semibold text-stone-400">
            Avoid
          </span>
        ) : wasAdded ? (
          <span className="inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-semibold" style={{ color: "#508519", backgroundColor: "#e5f6d0" }}>
            <svg className="w-3.5 h-3.5 animate-check-pop" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
            Added
          </span>
        ) : (
          <button
            type="button"
            onClick={handleAdd}
            disabled={isAdding}
            className="inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-bold text-white transition-colors disabled:opacity-50"
            style={{ backgroundColor: "#508519" }}
            onMouseEnter={(e) => { if (!isAdding) e.currentTarget.style.backgroundColor = "#3d6813"; }}
            onMouseLeave={(e) => { if (!isAdding) e.currentTarget.style.backgroundColor = "#508519"; }}
          >
            {isAdding ? (
              <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            ) : (
              <>
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v12M6 12h12" />
                </svg>
                Add
              </>
            )}
          </button>
        )}
      </div>
    </div>
  );
}

function LoadingGrid() {
  return (
    <div className="space-y-5">
      <div className="card p-5">
        <div className="h-4 skeleton rounded w-48 mb-3" />
        <div className="h-2.5 skeleton rounded-full" />
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="card overflow-hidden">
            <div className="aspect-square skeleton" />
            <div className="p-3 space-y-2">
              <div className="h-3 skeleton rounded w-3/4 mx-auto" />
              <div className="h-3 skeleton rounded w-1/2 mx-auto" />
              <div className="flex justify-center gap-2 pt-1">
                <div className="w-8 h-8 skeleton rounded-full" />
                <div className="w-5 h-5 skeleton rounded" />
                <div className="w-8 h-8 skeleton rounded-full" />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Header ───────────────────────────────────────────────────────────────────

function LeafIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 32 32" fill="none">
      <path d="M16 2C10 2 4 8 4 16c0 6 4 12 12 14C24 28 28 22 28 16 28 8 22 2 16 2z" fill="currentColor" opacity="0.15" />
      <path d="M8 24C10 14 18 6 28 4c0 0-2 10-8 16s-12 8-12 8z" fill="currentColor" opacity="0.9" />
      <path d="M12 26C14 20 18 14 26 8" stroke="white" strokeWidth="1.5" strokeLinecap="round" opacity="0.6" />
    </svg>
  );
}

const COUNTRIES: Record<string, string> = {
  US: "United States",
  CA: "Canada",
  GB: "United Kingdom",
  AU: "Australia",
  NZ: "New Zealand",
  IE: "Ireland",
  DE: "Germany",
  FR: "France",
  ES: "Spain",
  IT: "Italy",
  NL: "Netherlands",
  BE: "Belgium",
  AT: "Austria",
  CH: "Switzerland",
  SE: "Sweden",
  NO: "Norway",
  DK: "Denmark",
  FI: "Finland",
  PT: "Portugal",
  JP: "Japan",
  SG: "Singapore",
  HK: "Hong Kong",
  IN: "India",
  BR: "Brazil",
  MX: "Mexico",
  IL: "Israel",
  AE: "United Arab Emirates",
  ZA: "South Africa",
  PL: "Poland",
  CZ: "Czech Republic",
};

function countryName(code: string): string {
  return COUNTRIES[code.toUpperCase()] ?? code;
}

function formatAddress(addr: Address): string {
  const parts = [addr.address1];
  if (addr.address2) parts.push(addr.address2);
  parts.push(addr.city);
  const stateZip = [addr.province, addr.zip].filter(Boolean).join(" ");
  if (stateZip) parts.push(stateZip);
  if (addr.country_code) parts.push(countryName(addr.country_code));
  return parts.filter(Boolean).join(", ");
}

function Header({
  customer,
  refreshing,
  addresses,
  subscriptions,
}: {
  customer: Customer;
  refreshing: boolean;
  addresses: Address[];
  subscriptions: Subscription[];
}) {
  const [editingAddress, setEditingAddress] = useState<Address | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const closeMenu = useCallback(() => setMenuOpen(false), []);

  useEffect(() => {
    if (!menuOpen) return;
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) closeMenu();
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [menuOpen, closeMenu]);

  const primaryAddressId = subscriptions.find((s) => s.status === "active")?.address_id;
  const primaryAddress = addresses.find((a) => a.id === primaryAddressId) ?? addresses[0] ?? null;
  const [selectedAddressId, setSelectedAddressId] = useState<number | null>(null);
  const displayAddress = (selectedAddressId ? addresses.find((a) => a.id === selectedAddressId) : primaryAddress) ?? primaryAddress;

  return (
    <>
      <header className="bg-white border-b border-stone-200">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link to="/" className="flex items-center group">
              <img
                src="/logo.png"
                alt="Recharge Meals"
                className="h-12 sm:h-14 w-auto group-hover:scale-[1.02] transition-transform"
              />
            </Link>
            {refreshing && (
              <svg className="w-4 h-4 text-stone-400 animate-spin ml-2" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            )}
          </div>

          <div className="relative flex items-center gap-3" ref={menuRef}>
            <button
              type="button"
              onClick={() => setMenuOpen((v) => !v)}
              className="flex items-center gap-3 rounded-lg px-2 py-1 -mx-2 -my-1 hover:bg-stone-50 transition-colors"
            >
              <p className="text-sm text-stone-500 hidden sm:block">{customer.email}</p>
              <div className="w-10 h-10 rounded-full bg-stone-100 border-2 border-stone-200 flex items-center justify-center shrink-0">
                {customer.first_name?.[0] ? (
                  <span className="text-sm font-bold text-stone-600">
                    {customer.first_name[0]}{customer.last_name?.[0]}
                  </span>
                ) : (
                  <svg className="w-5 h-5 text-stone-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0ZM4.501 20.118a7.5 7.5 0 0 1 14.998 0A17.933 17.933 0 0 1 12 21.75c-2.676 0-5.216-.584-7.499-1.632Z" />
                  </svg>
                )}
              </div>
            </button>

            {menuOpen && (
              <div className="absolute right-0 top-full mt-2 w-48 bg-white rounded-xl shadow-lg border border-stone-200 py-1 z-50">
                <Link
                  to={`/${customer.id}/account`}
                  onClick={closeMenu}
                  className="flex items-center gap-2 px-4 py-2.5 text-sm text-stone-700 hover:bg-stone-50 transition-colors"
                >
                  <svg className="w-4 h-4 text-stone-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M17.982 18.725A7.488 7.488 0 0 0 12 15.75a7.488 7.488 0 0 0-5.982 2.975m11.963 0a9 9 0 1 0-11.963 0m11.963 0A8.966 8.966 0 0 1 12 21a8.966 8.966 0 0 1-5.982-2.275M15 9.75a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
                  </svg>
                  My Account
                </Link>
                <Link
                  to={`/${customer.id}/orders`}
                  onClick={closeMenu}
                  className="flex items-center gap-2 px-4 py-2.5 text-sm text-stone-700 hover:bg-stone-50 transition-colors"
                >
                  <svg className="w-4 h-4 text-stone-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M21 7.5l-9-5.25L3 7.5m18 0l-9 5.25m9-5.25v9l-9 5.25M3 7.5l9 5.25M3 7.5v9l9 5.25m0-9v9" />
                  </svg>
                  Previous orders
                </Link>
                <div className="border-t border-stone-100 my-1" />
                <Link
                  to="/logout"
                  onClick={closeMenu}
                  className="flex items-center gap-2 px-4 py-2.5 text-sm text-stone-700 hover:bg-stone-50 transition-colors"
                >
                  <svg className="w-4 h-4 text-stone-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 9V5.25A2.25 2.25 0 0 0 13.5 3h-6a2.25 2.25 0 0 0-2.25 2.25v13.5A2.25 2.25 0 0 0 7.5 21h6a2.25 2.25 0 0 0 2.25-2.25V15m3 0 3-3m0 0-3-3m3 3H9" />
                  </svg>
                  Sign out
                </Link>
              </div>
            )}
          </div>
        </div>

        {displayAddress && (
          <div className="border-t border-stone-100">
            <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-2 flex items-center gap-3">
              <svg className="w-4 h-4 text-brand-600 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 10.5a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1 1 15 0Z" />
              </svg>
              <span className="text-sm text-stone-600 truncate min-w-0">
                <span className="font-medium text-stone-700">Delivering to</span>{" "}
                {formatAddress(displayAddress)}
              </span>

              {addresses.length > 1 && (
                <select
                  className="text-xs border border-stone-200 rounded-md px-2 py-1 bg-white text-stone-600 focus:outline-none focus:ring-1 focus:ring-brand-300 shrink-0"
                  value={displayAddress.id}
                  onChange={(e) => setSelectedAddressId(Number(e.target.value))}
                >
                  {addresses.map((addr) => (
                    <option key={addr.id} value={addr.id}>
                      {addr.address1}, {addr.city}
                    </option>
                  ))}
                </select>
              )}

              <button
                type="button"
                onClick={() => setEditingAddress(displayAddress)}
                className="shrink-0 flex items-center gap-1 text-sm font-medium text-stone-600 hover:text-brand-600 transition-colors"
              >
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L6.832 19.82a4.5 4.5 0 0 1-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 0 1 1.13-1.897L16.863 4.487z" />
                </svg>
                Edit
              </button>
            </div>
          </div>
        )}
      </header>

      {editingAddress && (
        <AddressEditModal
          address={editingAddress}
          onClose={() => setEditingAddress(null)}
        />
      )}
    </>
  );
}

// ─── Address edit modal ───────────────────────────────────────────────────────

function AddressEditModal({ address, onClose }: { address: Address; onClose: () => void }) {
  const fetcher = useFetcher();
  const formRef = useRef<HTMLFormElement>(null);
  const isSubmitting = fetcher.state !== "idle";
  const prevState = useRef(fetcher.state);

  useEffect(() => {
    if (prevState.current === "loading" && fetcher.state === "idle" && fetcher.data) {
      const data = fetcher.data as { success?: boolean; error?: string };
      if (data.success) onClose();
    }
    prevState.current = fetcher.state;
  }, [fetcher.state, fetcher.data, onClose]);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose]);

  const error = (fetcher.data as { error?: string } | undefined)?.error;

  const fieldClass =
    "w-full rounded-lg border border-stone-200 px-3 py-2 text-sm text-stone-800 placeholder:text-stone-400 focus:outline-none focus:ring-2 focus:ring-brand-300 focus:border-brand-300 transition-colors";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm animate-fade-in" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-xl w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto animate-scale-in">
        <div className="flex items-center justify-between px-6 py-4 border-b border-stone-100">
          <h2 className="font-display font-semibold text-lg text-stone-900">Edit shipping address</h2>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-md text-stone-400 hover:text-stone-600 hover:bg-stone-100 transition-colors"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <fetcher.Form method="post" ref={formRef} className="px-6 py-5 space-y-4">
          <input type="hidden" name="intent" value="update_address" />
          <input type="hidden" name="addressId" value={address.id} />

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-stone-500 mb-1">First name</label>
              <input name="first_name" defaultValue={address.first_name ?? ""} className={fieldClass} />
            </div>
            <div>
              <label className="block text-xs font-medium text-stone-500 mb-1">Last name</label>
              <input name="last_name" defaultValue={address.last_name ?? ""} className={fieldClass} />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-stone-500 mb-1">Address</label>
            <input name="address1" defaultValue={address.address1 ?? ""} className={fieldClass} />
          </div>

          <div>
            <label className="block text-xs font-medium text-stone-500 mb-1">Apartment, suite, etc.</label>
            <input name="address2" defaultValue={address.address2 ?? ""} placeholder="Optional" className={fieldClass} />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-stone-500 mb-1">City</label>
              <input name="city" defaultValue={address.city ?? ""} className={fieldClass} />
            </div>
            <div>
              <label className="block text-xs font-medium text-stone-500 mb-1">State / Province</label>
              <input name="province" defaultValue={address.province ?? ""} className={fieldClass} />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-stone-500 mb-1">ZIP / Postal code</label>
              <input name="zip" defaultValue={address.zip ?? ""} className={fieldClass} />
            </div>
            <div>
              <label className="block text-xs font-medium text-stone-500 mb-1">Country</label>
              <select name="country_code" defaultValue={address.country_code ?? ""} className={fieldClass}>
                <option value="" disabled>Select country</option>
                {Object.entries(COUNTRIES).map(([code, name]) => (
                  <option key={code} value={code}>{name}</option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-stone-500 mb-1">Phone</label>
            <input name="phone" defaultValue={address.phone ?? ""} placeholder="Optional" className={fieldClass} />
          </div>

          {error && (
            <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-2.5 text-sm text-red-700">
              {error}
            </div>
          )}

          <div className="flex items-center justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-stone-600 hover:text-stone-800 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isSubmitting ? "Saving..." : "Save address"}
            </button>
          </div>
        </fetcher.Form>
      </div>
    </div>
  );
}

// ─── Skipped banner ───────────────────────────────────────────────────────────

function SkippedBanner({
  chargeId,
  scheduledAt,
  deliveryDateOffset,
  purchaseItemId,
  bundleVariantId,
}: {
  chargeId: number;
  scheduledAt: string;
  deliveryDateOffset: number;
  purchaseItemId: number | null;
  bundleVariantId: string;
}) {
  const fetcher = useFetcher<typeof action>();
  const isUnskipping = fetcher.state !== "idle";
  const fetcherData = fetcher.data as
    | { success: true; intent: "unskip"; chargeId: number }
    | { error: string; intent: "unskip" }
    | undefined;
  const unskipError =
    fetcher.state === "idle" && fetcherData != null && "error" in fetcherData
      ? (fetcherData as { error: string }).error
      : null;

  const deliveryDate = addDaysToDate(scheduledAt, deliveryDateOffset);
  const deliveryStr = new Date(deliveryDate).toLocaleDateString("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });

  return (
    <div className="card border-2 border-amber-300 bg-amber-50 px-5 py-5 mb-5 animate-slide-up">
      <div className="flex flex-col sm:flex-row sm:items-center gap-4">
        <div className="flex items-start gap-3 flex-1 min-w-0">
          <div className="w-10 h-10 rounded-full bg-amber-200 flex items-center justify-center flex-none">
            <svg className="w-5 h-5 text-amber-800" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 5l7 7-7 7" />
            </svg>
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-base font-bold text-amber-900 uppercase tracking-wide">This week is skipped</p>
            <p className="text-sm text-amber-800 mt-1">
              Your delivery for {deliveryStr} will not be sent. Any add-ons that were on this charge have been removed and will need to be re-added if you unskip.
            </p>
            {unskipError && (
              <p className="text-xs text-red-700 mt-2 font-medium">{unskipError}</p>
            )}
          </div>
        </div>

        <fetcher.Form method="post" className="flex-none">
          <input type="hidden" name="intent" value="unskip" />
          <input type="hidden" name="bundleVariantId" value={bundleVariantId} />
          <input type="hidden" name="chargeId" value={String(chargeId)} />
          {purchaseItemId != null && (
            <input type="hidden" name="purchaseItemId" value={String(purchaseItemId)} />
          )}
          <button
            type="submit"
            disabled={isUnskipping}
            className="w-full sm:w-auto px-6 py-3 text-base font-bold text-white rounded-lg uppercase tracking-wide shadow-lg transition-all disabled:opacity-60 disabled:cursor-not-allowed hover:scale-[1.02] active:scale-[0.98]"
            style={{ backgroundColor: "#b45309" }}
            onMouseEnter={(e) => { if (!isUnskipping) e.currentTarget.style.backgroundColor = "#92400e"; }}
            onMouseLeave={(e) => { if (!isUnskipping) e.currentTarget.style.backgroundColor = "#b45309"; }}
          >
            {isUnskipping ? (
              <span className="flex items-center justify-center gap-2">
                <svg className="w-5 h-5 animate-spin" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Unskipping...
              </span>
            ) : (
              "Unskip this week"
            )}
          </button>
        </fetcher.Form>
      </div>
    </div>
  );
}

// ─── Read-only summary for a skipped charge without bundle data ──────────────

function SkippedChargeSummary({
  charge,
  deliveryDateOffset,
}: {
  charge: Charge;
  deliveryDateOffset: number;
}) {
  const subscriptionItems = charge.line_items.filter((li) => li.purchase_item_type === "subscription");
  const onetimeItems = charge.line_items.filter((li) => li.purchase_item_type === "onetime");
  const deliveryDate = addDaysToDate(charge.scheduled_at, deliveryDateOffset);

  return (
    <div className="card p-5 mt-2 opacity-75">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="font-display font-semibold text-stone-900">Selections from this skipped week</h3>
          <p className="text-xs text-stone-500 mt-0.5">
            Was scheduled to deliver {formatDate(deliveryDate)} (charged {formatDate(charge.scheduled_at)})
          </p>
        </div>
        <span className="text-sm font-bold text-stone-700">{formatCurrency(charge.total_price)}</span>
      </div>

      {subscriptionItems.length > 0 ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
          {subscriptionItems.map((item, index) => (
            <div key={`${item.purchase_item_id}-${index}`} className="flex items-center gap-3 p-3 rounded-xl bg-stone-50">
              {item.images?.small || item.images?.medium ? (
                <img
                  src={(item.images?.small ?? item.images?.medium) ?? undefined}
                  alt={item.title}
                  className="w-12 h-12 rounded-lg object-cover flex-none bg-white"
                />
              ) : (
                <div className="w-12 h-12 rounded-lg bg-stone-200 flex-none" />
              )}
              <div className="min-w-0">
                <p className="text-sm font-semibold text-stone-800 truncate">{item.title}</p>
                {item.quantity > 1 && (
                  <p className="text-xs text-stone-500">x{item.quantity}</p>
                )}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-stone-500">No items were selected for this week.</p>
      )}

      {onetimeItems.length > 0 && (
        <p className="mt-4 text-xs text-stone-500 italic">
          {onetimeItems.length} add-on{onetimeItems.length !== 1 ? "s" : ""} from this week have been removed.
        </p>
      )}
    </div>
  );
}

// ─── Locked banner ────────────────────────────────────────────────────────────

function LockedBanner({
  scheduledAt,
  deliveryDateOffset,
  modificationWindowDays,
}: {
  scheduledAt: string;
  deliveryDateOffset: number;
  modificationWindowDays: number;
}) {
  const delivery = new Date(scheduledAt.slice(0, 10) + "T00:00:00Z");
  delivery.setUTCDate(delivery.getUTCDate() + deliveryDateOffset);
  const cutoff = new Date(delivery);
  cutoff.setUTCDate(cutoff.getUTCDate() - modificationWindowDays);
  const cutoffStr = cutoff.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

  return (
    <div className="card border-amber-200 bg-amber-50 px-5 py-4 flex items-start gap-3 mb-5 animate-slide-up">
      <div className="w-8 h-8 rounded-full bg-amber-100 flex items-center justify-center flex-none">
        <svg className="w-4 h-4 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
        </svg>
      </div>
      <div className="flex-1">
        <p className="text-sm font-semibold text-amber-800">Changes are no longer available for this delivery</p>
        <p className="text-sm text-amber-700 mt-0.5">
          The modification window closed on {cutoffStr}. Your selections below are final.
        </p>
      </div>
    </div>
  );
}

function SubscriptionTabs({
  subscriptions,
  activeSubscriptionId,
  onSelect,
}: {
  subscriptions: BundleSubscriptionTab[];
  activeSubscriptionId: number | null;
  onSelect: (purchaseItemId: number) => void;
}) {
  return (
    <div className="mb-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-stone-500 mb-2">Your Bundles</p>
      <div className="flex gap-2 overflow-x-auto scrollbar-hide pb-1">
        {subscriptions.map((subscription) => {
          const isActive = subscription.purchaseItemId === activeSubscriptionId;
          return (
            <button
              key={subscription.purchaseItemId}
              onClick={() => onSelect(subscription.purchaseItemId)}
              className={`flex-none rounded-lg px-4 py-2 text-sm font-medium border transition-colors ${
                isActive
                  ? "bg-brand-600 text-white border-brand-600"
                  : "bg-white text-stone-600 border-stone-200 hover:border-brand-300 hover:text-brand-700"
              }`}
            >
              <span className="block">{subscription.productTitle}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ─── Week tabs ────────────────────────────────────────────────────────────────

function addDaysToDate(dateStr: string, days: number): string {
  const d = new Date(dateStr.slice(0, 10) + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function formatWeekLabel(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

function WeekTabs({
  tabs,
  activeIndex,
  deliveryDateOffset,
  onSelect,
}: {
  tabs: ChargeTabInfo[];
  activeIndex: number;
  deliveryDateOffset: number;
  onSelect: (index: number) => void;
}) {
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-wider text-stone-500 mb-2">Upcoming deliveries</p>
      <div className="flex gap-2.5 overflow-x-auto scrollbar-hide -mx-5 px-5 pb-1">
        {tabs.map((tab, i) => {
          const isActive = i === activeIndex;
          const isSkipped = tab.status === "skipped";
          const deliveryDate = addDaysToDate(tab.scheduledAt, deliveryDateOffset);
          const activeBg = isSkipped
            ? { backgroundColor: "#b45309", borderColor: "#b45309", boxShadow: "0 4px 12px rgba(28, 25, 23, 0.07)" }
            : { backgroundColor: "#508519", borderColor: "#508519", boxShadow: "0 4px 12px rgba(28, 25, 23, 0.07)" };
          const inactiveClass = isSkipped
            ? "bg-amber-50 text-amber-800 border-amber-200 hover:border-amber-400"
            : "bg-white text-stone-600 border-stone-200 hover:border-brand-300 hover:text-brand-700";
          return (
            <button
              key={tab.chargeId}
              onClick={() => onSelect(i)}
              className={`rounded-2xl px-3 py-2.5 text-left transition-all duration-200 border ${
                isActive ? "text-white border-transparent" : inactiveClass
              }`}
              style={isActive ? activeBg : undefined}
            >
              <p className="flex items-center gap-1 text-[11px] font-semibold leading-tight">
                {tab.locked && (
                  <svg className="w-3 h-3 flex-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                  </svg>
                )}
                <span className={`truncate ${isSkipped ? "line-through opacity-80" : ""}`}>
                  {formatWeekLabel(deliveryDate)}
                </span>
              </p>
              <p className={`mt-1 text-base font-bold tabular-nums ${isActive ? "text-white" : "text-stone-800"}`}>
                {formatCurrency(tab.totalPrice)}
              </p>
              {isSkipped && (
                <span
                  className={`mt-1 inline-flex items-center text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-full ${
                    isActive ? "bg-white/25 text-white" : "bg-amber-200 text-amber-900"
                  }`}
                >
                  Skipped
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ─── Meal grid (bundle editor) ────────────────────────────────────────────────

type EditableItem = {
  // null for a default meal that isn't in any bundle collection.
  collection_id: string | null;
  collection_source: string;
  external_product_id: string;
  external_variant_id: string;
  quantity: number;
  productTitle: string;
  variantTitle: string;
  imageUrl: string | null;
  tags: string[];
  description: string | null;
  // A default meal from outside the bundle's collections: it can be removed but
  // not added to.
  offMenu: boolean;
};

function matchesTags(itemTags: string[], prefTags: string[]): boolean {
  return itemTags.some((t) => prefTags.some((p) => p.toLowerCase() === t.toLowerCase()));
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** Human-readable "Contains X + Y" label from the item tags that the customer
 *  has chosen to avoid. Returns null when nothing conflicts. */
function allergenLabel(itemTags: string[], prefTags: string[]): string | null {
  const matched = itemTags.filter((t) => prefTags.some((p) => p.toLowerCase() === t.toLowerCase()));
  const unique = [...new Set(matched.map((t) => capitalize(t)))];
  if (unique.length === 0) return null;
  return `Contains ${unique.join(" + ")}`;
}

// Quick dietary filters surfaced above the meal grid. Toggling one persists the
// underlying exclusion tags to the customer's taste profile (Shopify customer tags).
const DIET_FILTERS: { id: string; label: string; tags: string[]; tone: string; activeTone: string }[] = [
  { id: "gf", label: "GF Only", tags: ["Gluten"], tone: "border-amber-200 text-amber-700 bg-amber-50/60 hover:border-amber-300", activeTone: "border-amber-400 text-amber-800 bg-amber-100 ring-1 ring-amber-200" },
  { id: "df", label: "Dairy Free", tags: ["Dairy"], tone: "border-violet-200 text-violet-700 bg-violet-50/60 hover:border-violet-300", activeTone: "border-violet-400 text-violet-800 bg-violet-100 ring-1 ring-violet-200" },
  { id: "veg", label: "Veg", tags: ["Meat", "Fish"], tone: "border-brand-200 text-brand-700 bg-brand-50 hover:border-brand-300", activeTone: "border-brand-400 text-brand-800 bg-brand-100 ring-1 ring-brand-200" },
];

// Full set of ingredients a customer can exclude from the "Edit preferences"
// panel. Each is matched case-insensitively against Shopify product tags and
// stored as an `rc_exclude_<slug>` tag on the Shopify customer.
const PREFERENCE_OPTIONS = ["Gluten", "Dairy", "Eggs", "Meat", "Fish", "Shellfish", "Nuts", "Soy"];

function excludeIncludes(set: string[], tag: string): boolean {
  return set.some((e) => e.toLowerCase() === tag.toLowerCase());
}

function tierOf(item: EditableItem, preferences: CustomerPreference | null): number {
  if (item.quantity > 0) return 0;
  if (preferences && matchesTags(item.tags, preferences.exclude)) return 3;
  return 1;
}

function buildEditableItems(
  bundleSelection: BundleSelection,
  offMenuItems: EditableItem[],
  availableCollections: BundleCollection[],
  preferences: CustomerPreference | null,
  eligibleCollectionIds: Set<string>
): EditableItem[] {
  const currentQty: Record<string, number> = {};
  for (const item of bundleSelection.items) {
    currentQty[item.external_variant_id] = item.quantity;
  }

  const seen = new Set<string>();
  const result: EditableItem[] = [];

  for (const collection of availableCollections) {
    const isEligible = eligibleCollectionIds.has(collection.id);
    for (const product of collection.products) {
      for (const variant of product.variants) {
        const qty = currentQty[String(variant.id)] ?? 0;
        if (!isEligible && qty === 0) continue;
        if (seen.has(variant.id.toString())) continue;
        seen.add(variant.id.toString());
        result.push({
          collection_id: collection.id,
          collection_source: "shopify",
          external_product_id: product.external_product_id,
          external_variant_id: String(variant.id),
          quantity: currentQty[String(variant.id)] ?? 0,
          productTitle: product.title,
          variantTitle: variant.title,
          imageUrl: product.image_url ?? null,
          tags: product.tags ?? [],
          description: product.description ?? null,
          offMenu: false,
        });
      }
    }
  }

  for (const item of bundleSelection.items) {
    if (!seen.has(item.external_variant_id)) {
      result.push({
        collection_id: item.collection_id,
        collection_source: item.collection_source,
        external_product_id: item.external_product_id,
        external_variant_id: item.external_variant_id,
        quantity: item.quantity,
        productTitle: `Product #${item.external_product_id.split("/").pop()}`,
        variantTitle: `Variant #${item.external_variant_id.split("/").pop()}`,
        imageUrl: null,
        tags: [],
        description: null,
        offMenu: false,
      });
    }
  }

  result.push(...offMenuItems);

  return result.sort((a, b) => tierOf(a, preferences) - tierOf(b, preferences));
}

const MEALS_PER_WEEK = 5;

function MealGrid({
  charge,
  bundleSelection,
  offMenuItems,
  availableCollections,
  quantityRanges,
  preferences,
  eligibleCollectionIds,
  hasPresetForWeek,
  bundleVariantId,
  locked = false,
  onCountChange,
  isPrefSaving = false,
}: {
  charge: Charge;
  bundleSelection: BundleSelection;
  offMenuItems: EditableItem[];
  availableCollections: BundleCollection[];
  quantityRanges: QuantityRange[];
  preferences: CustomerPreference | null;
  eligibleCollectionIds: string[];
  hasPresetForWeek: boolean;
  bundleVariantId: string;
  locked?: boolean;
  onCountChange?: (count: number) => void;
  isPrefSaving?: boolean;
}) {
  const fetcher = useFetcher<typeof action>();
  const eligibleSet = new Set(eligibleCollectionIds);
  const [items, setItems] = useState<EditableItem[]>(() =>
    buildEditableItems(bundleSelection, offMenuItems, availableCollections, preferences, eligibleSet)
  );
  const [savedQty, setSavedQty] = useState<Record<string, number>>(
    () => Object.fromEntries(
      [...bundleSelection.items, ...offMenuItems].map((i) => [i.external_variant_id, i.quantity])
    )
  );
  const [detailItem, setDetailItem] = useState<{ item: EditableItem; index: number } | null>(null);
  const [errorDismissed, setErrorDismissed] = useState(false);
  const submittedQtyRef = useRef<Record<string, number>>({});

  const isSaving = fetcher.state !== "idle";
  const fetcherData = fetcher.data as
    | { success: true; intent: "update_bundle" | "create_bundle" }
    | { error: string; ranges?: number[][]; intent: "update_bundle" | "create_bundle" }
    | undefined;
  // bundleSelection.id === 0 is the synthetic placeholder built by the loader
  // for charges that don't yet have a bundle_selection record. Saving from
  // this state should CREATE the bundle_selection, not update one.
  const isCreating = bundleSelection.id === 0;

  const savedOk = fetcher.state === "idle" && fetcherData != null && "success" in fetcherData;
  const fetcherError =
    fetcher.state === "idle" && fetcherData != null && "error" in fetcherData ? fetcherData : null;
  const showError = fetcherError != null && !errorDismissed;

  const totalItems = items.reduce((sum, item) => sum + item.quantity, 0);
  const { min: minMeals, max: maxMeals } = mealCountRange(quantityRanges);
  const hasMaxMeals = Number.isFinite(maxMeals);
  const isValidTotal = quantityRanges.length > 0
    ? quantityRanges.some(([min, max]) => totalItems >= min && (max == null || totalItems <= max))
    : totalItems === MEALS_PER_WEEK;

  const hasChanges = items.some((item) => {
    const orig = savedQty[item.external_variant_id] ?? 0;
    return item.quantity !== orig;
  });

  useEffect(() => {
    if (isSaving) setErrorDismissed(false);
  }, [isSaving]);

  useEffect(() => {
    if (savedOk) {
      setSavedQty(submittedQtyRef.current);
      setItems((prev) => [...prev].sort((a, b) => tierOf(a, preferences) - tierOf(b, preferences)));
    }
  }, [savedOk]);

  useEffect(() => {
    onCountChange?.(totalItems);
  }, [totalItems, onCountChange]);

  // Off-menu meals can't be added to, and removing one removes all of it.
  const nextQty = (item: EditableItem, delta: number) =>
    item.offMenu ? (delta < 0 ? 0 : item.quantity) : Math.max(0, item.quantity + delta);

  const adjustQty = (index: number, delta: number) => {
    setItems((prev) =>
      prev.map((item, i) => (i === index ? { ...item, quantity: nextQty(item, delta) } : item))
    );
  };

  const handleSave = () => {
    submittedQtyRef.current = Object.fromEntries(items.map((i) => [i.external_variant_id, i.quantity]));
    const payload = items
      .filter((item) => item.quantity > 0)
      .map(({ collection_id, collection_source, external_product_id, external_variant_id, quantity }) => ({
        collection_id,
        collection_source,
        external_product_id,
        external_variant_id,
        quantity,
      }));
    fetcher.submit(
      isCreating
        ? {
            intent: "create_bundle",
            bundleVariantId,
            chargeId: String(charge.id),
            purchaseItemId: String(bundleSelection.purchase_item_id),
            items: JSON.stringify(payload),
            scheduledAt: charge.scheduled_at,
          }
        : {
            intent: "update_bundle",
            bundleVariantId,
            bundleSelectionId: String(bundleSelection.id),
            items: JSON.stringify(payload),
            scheduledAt: charge.scheduled_at,
          },
      { method: "post" }
    );
  };

  const chargeIsQueued = charge.status === "queued";

  return (
    <div className="space-y-5">
      {/* Error banner */}
      {showError && (
        <div className="card border-red-200 bg-red-50 px-5 py-4 flex items-start gap-3 animate-slide-up">
          <div className="w-8 h-8 rounded-full bg-red-100 flex items-center justify-center flex-none">
            <svg className="w-4 h-4 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <div className="flex-1">
            <p className="text-sm font-medium text-red-800">{fetcherError.error}</p>
          </div>
          <button onClick={() => setErrorDismissed(true)} className="text-red-400 hover:text-red-600 transition-colors flex-none">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}

      {/* Meal cards grid */}
      {!hasPresetForWeek && items.length === 0 ? (
        <div className="card p-8 text-center">
          <div className="mx-auto w-12 h-12 rounded-full bg-stone-100 flex items-center justify-center mb-4">
            <svg className="w-6 h-6 text-stone-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
          </div>
          <h3 className="font-display font-semibold text-stone-900 mb-1">
            No menu available for this week
          </h3>
          <p className="text-sm text-stone-500 max-w-md mx-auto">
            The menu for this delivery date hasn&rsquo;t been published yet. Check back later, or contact support if you need help.
          </p>
        </div>
      ) : isPrefSaving ? (
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="card overflow-hidden flex flex-col">
            <div className="aspect-square skeleton" />
            <div className="p-3 space-y-2 flex-1 flex flex-col justify-between">
              <div className="space-y-1.5">
                <div className="h-3 skeleton rounded w-3/4 mx-auto" />
                <div className="h-3 skeleton rounded w-1/2 mx-auto" />
              </div>
              <div className="flex items-center justify-center gap-2 pt-1">
                <div className="w-8 h-8 skeleton rounded-full" />
                <div className="w-5 h-5 skeleton rounded" />
                <div className="w-8 h-8 skeleton rounded-full" />
              </div>
            </div>
          </div>
        ))}
      </div>
      ) : (
      <div className={`grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4 transition-opacity duration-300 ${isSaving ? "opacity-50 pointer-events-none" : ""}`}>
        {items.map((item, index) => {
          const isSelected = item.quantity > 0;
          const isPrefExclude = Boolean(preferences && matchesTags(item.tags, preferences.exclude));

          if (isPrefExclude) return null;
          // A removed off-menu meal can't be added back, so stop showing it.
          if (item.offMenu && !isSelected) return null;

          return (
            <div
              key={item.external_variant_id}
              className={`card transition-all duration-200 flex flex-col ${
                isSelected ? "" : "hover:-translate-y-0.5"
              }`}
              style={{ animationDelay: `${Math.min(index, 8) * 0.03}s` }}
            >
              {/* Image area — clickable to open detail modal */}
              <div
                className="relative aspect-square bg-stone-50 overflow-hidden rounded-t-3xl cursor-pointer group"
                onClick={() => setDetailItem({ item, index })}
              >
                {item.imageUrl ? (
                  <img
                    src={item.imageUrl}
                    alt={item.productTitle}
                    className={`w-full h-full object-cover transition-all duration-300 group-hover:scale-105 ${
                      isPrefExclude ? "grayscale opacity-70" : isSelected ? "" : "saturate-[0.85]"
                    }`}
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-stone-50 to-stone-100">
                    <svg className="w-12 h-12 text-stone-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                    </svg>
                  </div>
                )}

                {/* Selected overlay */}
                {isSelected && (
                  <div className="absolute top-2 right-2 w-6 h-6 rounded-full flex items-center justify-center animate-check-pop" style={{ backgroundColor: "#508519", boxShadow: "0 1px 3px rgba(28,25,23,0.06)" }}>
                    <svg className="w-3.5 h-3.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  </div>
                )}

              </div>

              {/* Card body */}
              <div className="p-3 text-center flex flex-col flex-1">
                <div className="flex-1">
                  <h4 className="text-sm font-semibold leading-tight line-clamp-2 mb-0.5 text-stone-800">
                    {item.productTitle}
                  </h4>
                  {item.variantTitle && item.variantTitle !== "Default Title" && (
                    <p className="text-xs text-stone-500 line-clamp-1">{item.variantTitle}</p>
                  )}
                </div>

                {/* Stepper / quantity display */}
                {chargeIsQueued && !locked ? (
                  <div className="flex items-center justify-center gap-2 mt-3">
                    <StepperTip tip={item.quantity <= 0 ? "Not in your box yet" : undefined}>
                      <button
                        onClick={() => adjustQty(index, -1)}
                        disabled={item.quantity <= 0 || isSaving}
                        className="stepper-btn"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                          <path strokeLinecap="round" d="M20 12H4" />
                        </svg>
                      </button>
                    </StepperTip>
                    <span className={`text-base font-bold tabular-nums min-w-[20px] ${
                      isSelected ? "text-stone-900" : "text-stone-300"
                    }`}>
                      {item.quantity}
                    </span>
                    <StepperTip tip={item.offMenu ? "Not on this week's menu — you can only remove it" : totalItems >= maxMeals ? `Box is full — remove a meal to swap` : undefined}>
                      <button
                        onClick={() => { if (!item.offMenu && totalItems < maxMeals) adjustQty(index, 1); }}
                        disabled={item.offMenu || totalItems >= maxMeals || isSaving}
                        className="stepper-btn"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                          <path strokeLinecap="round" d="M12 6v12M6 12h12" />
                        </svg>
                      </button>
                    </StepperTip>
                  </div>
                ) : (
                  <p className="text-sm font-semibold text-stone-400 mt-3">
                    {item.quantity > 0 ? `×${item.quantity}` : "—"}
                  </p>
                )}
              </div>
            </div>
          );
        })}
      </div>
      )}

      {/* Fixed footer — mirrors the page grid so the bar aligns with this column */}
      {chargeIsQueued && !locked && !(items.length === 0 && !hasPresetForWeek) && (
        <div key={charge.id} className="fixed bottom-4 left-0 right-0 z-20 pointer-events-none" style={{ animation: "footerIn 0.45s cubic-bezier(0.34,1.56,0.64,1) forwards" }}>
          <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 pointer-events-none">
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 pointer-events-none">
              <div className="lg:col-span-2 pointer-events-auto">
          <div className="card overflow-hidden backdrop-blur-sm bg-white/95 mx-10" style={{ boxShadow: "0 8px 32px rgba(28,25,23,0.18), 0 2px 8px rgba(28,25,23,0.10)" }}>
          {/* Progress bar inside the footer card */}
          <div className="h-2 w-full bg-stone-100 flex overflow-hidden">
            {/* Required zone: fills to minMeals */}
            <div
              className="relative h-full flex-none"
              style={{ width: `${hasMaxMeals && maxMeals > 0 ? (minMeals / maxMeals) * 100 : 100}%` }}
            >
              <div
                className="h-full transition-all duration-300"
                style={{
                  width: `${minMeals > 0 ? Math.min(100, (Math.min(totalItems, minMeals) / minMeals) * 100) : 100}%`,
                  backgroundColor: totalItems >= minMeals ? "#6aab28" : "#f59e0b",
                }}
              />
              {hasMaxMeals && maxMeals > minMeals && <div className="absolute right-0 top-0 bottom-0 w-px bg-white/70 z-10" />}
            </div>
            {/* Extra zone: fills from minMeals to maxMeals in a lighter green */}
            {hasMaxMeals && maxMeals > minMeals && (
              <div className="flex-1 h-full">
                <div
                  className="h-full transition-all duration-300"
                  style={{
                    width: `${totalItems > minMeals ? Math.min(100, ((totalItems - minMeals) / (maxMeals - minMeals)) * 100) : 0}%`,
                    backgroundColor: "#8aaa70",
                  }}
                />
              </div>
            )}
          </div>
          <div className="px-5 py-4 flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <p className={`text-sm font-semibold tabular-nums ${isValidTotal ? "text-stone-700" : "text-amber-700"}`}>
                {isValidTotal && totalItems >= maxMeals ? "🎉 " : ""}{hasMaxMeals ? `${totalItems}/${maxMeals}` : totalItems} meals
              </p>
              {!isValidTotal && minMeals > totalItems && (
                <span className="text-xs text-stone-600">Pick at least {minMeals - totalItems} more</span>
              )}
              {isValidTotal && hasMaxMeals && totalItems < maxMeals && (
                <span className="text-xs text-stone-500">You can add up to {maxMeals - totalItems} more</span>
              )}
              {savedOk && !hasChanges && (
                <span className="text-sm font-medium flex items-center gap-1 animate-fade-in" style={{ color: "#508519" }}>
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                  Saved!
                </span>
              )}
            </div>

            <button
              onClick={handleSave}
              disabled={isSaving || !hasChanges || !isValidTotal}
              className="btn-primary text-sm"
            >
              {isSaving ? (
                <>
                  <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  Saving...
                </>
              ) : (
                "Save selections"
              )}
            </button>
          </div>
          </div>
              </div>
            </div>
          </div>
        </div>
      )}
    {detailItem && (
      <MealDetailModal
        item={detailItem.item}
        index={detailItem.index}
        totalItems={totalItems}
        maxMeals={maxMeals}
        chargeIsQueued={chargeIsQueued}
        locked={locked}
        isSaving={isSaving}
        onAdjust={(delta) => { adjustQty(detailItem.index, delta); setDetailItem(d => d ? { ...d, item: { ...d.item, quantity: nextQty(d.item, delta) } } : null); }}
        onClose={() => setDetailItem(null)}
      />
    )}
    </div>
  );
}

function StepperTip({ tip, children }: { tip?: string; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  if (!tip) return <>{children}</>;

  const handleMouseEnter = () => {
    const rect = ref.current?.getBoundingClientRect();
    if (rect) setPos({ top: rect.bottom + 8, left: rect.left + rect.width / 2 });
  };

  return (
    <div ref={ref} onMouseEnter={handleMouseEnter} onMouseLeave={() => setPos(null)}>
      {children}
      {pos && typeof document !== "undefined" && createPortal(
        <div
          className="fixed pointer-events-none z-[9999]"
          style={{ top: pos.top, left: pos.left, transform: "translateX(-50%)" }}
        >
          <div className="bg-stone-800 text-white text-xs rounded-md px-2.5 py-1.5 whitespace-nowrap shadow-lg" style={{ animation: "fadeIn 0.15s ease-out 0.25s both" }}>
            <div className="absolute bottom-full left-1/2 -translate-x-1/2 border-4 border-transparent border-b-stone-800" />
            {tip}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}

function MealDetailModal({
  item,
  index,
  totalItems,
  maxMeals,
  chargeIsQueued,
  locked,
  isSaving,
  onAdjust,
  onClose,
}: {
  item: EditableItem;
  index: number;
  totalItems: number;
  maxMeals: number;
  chargeIsQueued: boolean;
  locked: boolean;
  isSaving: boolean;
  onAdjust: (delta: number) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  const ALLERGEN_TAGS = ["Gluten", "Dairy", "Eggs", "Meat", "Fish", "Shellfish", "Nuts", "Soy"];
  const allergenTags = item.tags.filter(t => ALLERGEN_TAGS.some(a => a.toLowerCase() === t.toLowerCase()));
  const otherTags = item.tags.filter(t => !ALLERGEN_TAGS.some(a => a.toLowerCase() === t.toLowerCase()));

  const findMeta = (keys: string[]) => {
    for (const key of keys) {
      const tag = item.tags.find(t => t.toLowerCase().startsWith(key.toLowerCase() + ":"));
      if (tag) return tag.split(":").slice(1).join(":").trim();
    }
    return null;
  };

  const prepTime = findMeta(["prep", "prep_time"]);
  const cookTime = findMeta(["cook", "cook_time"]);
  const totalTime = findMeta(["time", "total_time"]);
  const calories = findMeta(["calories", "cal", "kcal"]);
  const protein = findMeta(["protein"]);
  const carbs = findMeta(["carbs", "carbohydrates"]);
  const fat = findMeta(["fat"]);
  const servings = findMeta(["servings", "serves"]);

  const hasMeta = prepTime || cookTime || totalTime || calories;
  const hasMacros = protein || carbs || fat;

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm animate-fade-in" onClick={onClose} />
      <div className="relative bg-white w-full sm:w-auto sm:max-w-md sm:mx-4 rounded-t-3xl sm:rounded-3xl shadow-2xl max-h-[92vh] overflow-y-auto scrollbar-hide animate-slide-up">
        {/* Image */}
        <div className="relative w-full aspect-[4/3] bg-stone-100 overflow-hidden rounded-t-3xl sm:rounded-t-3xl">
          {item.imageUrl ? (
            <img src={item.imageUrl} alt={item.productTitle} className="w-full h-full object-cover" />
          ) : (
            <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-stone-50 to-stone-100">
              <svg className="w-16 h-16 text-stone-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
            </div>
          )}
          <button
            onClick={onClose}
            className="absolute top-3 right-3 w-8 h-8 rounded-full bg-black/40 backdrop-blur-sm flex items-center justify-center text-white hover:bg-black/60 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="px-5 pt-4 pb-6 space-y-4">
          {/* Title */}
          <div>
            <h2 className="font-display text-xl font-bold text-stone-900 leading-tight">{item.productTitle}</h2>
            {item.variantTitle && item.variantTitle !== "Default Title" && (
              <p className="text-sm text-stone-500 mt-0.5">{item.variantTitle}</p>
            )}
          </div>

          {/* Time + calorie badges */}
          {hasMeta && (
            <div className="flex flex-wrap gap-2">
              {prepTime && (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-stone-100 px-3 py-1 text-xs font-medium text-stone-600">
                  <svg className="w-3.5 h-3.5 text-stone-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6l4 2m4-2a8 8 0 11-16 0 8 8 0 0116 0z" />
                  </svg>
                  Prep: {prepTime}
                </span>
              )}
              {cookTime && (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-stone-100 px-3 py-1 text-xs font-medium text-stone-600">
                  <svg className="w-3.5 h-3.5 text-stone-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15.362 5.214A8.252 8.252 0 0112 21 8.25 8.25 0 016.038 7.047 8.287 8.287 0 009 9.601a8.983 8.983 0 013.361-6.867 8.21 8.21 0 003 2.48z" />
                  </svg>
                  Cook: {cookTime}
                </span>
              )}
              {calories && (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-stone-100 px-3 py-1 text-xs font-medium text-stone-600">
                  <svg className="w-3.5 h-3.5 text-stone-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v2.25m6.364.386l-1.591 1.591M21 12h-2.25m-.386 6.364l-1.591-1.591M12 18.75V21m-4.773-4.227l-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0z" />
                  </svg>
                  {calories} cal{servings ? ` · serves ${servings}` : ""}
                </span>
              )}
            </div>
          )}

          {/* Description */}
          {item.description && (
            <p className="text-sm text-stone-600 leading-relaxed">{item.description}</p>
          )}

          {/* Macros */}
          {hasMacros && (
            <div className="border border-stone-100 rounded-2xl p-4">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-stone-400 mb-3">Nutrition</p>
              <div className="grid grid-cols-3 gap-3 text-center">
                {protein && (
                  <div>
                    <p className="text-lg font-bold text-stone-900">{protein}</p>
                    <p className="text-xs text-stone-400">Protein</p>
                  </div>
                )}
                {carbs && (
                  <div>
                    <p className="text-lg font-bold text-stone-900">{carbs}</p>
                    <p className="text-xs text-stone-400">Carbs</p>
                  </div>
                )}
                {fat && (
                  <div>
                    <p className="text-lg font-bold text-stone-900">{fat}</p>
                    <p className="text-xs text-stone-400">Fat</p>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Allergen tags */}
          {allergenTags.length > 0 && (
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-stone-400 mb-2">Contains</p>
              <div className="flex flex-wrap gap-1.5">
                {allergenTags.map(t => (
                  <span key={t} className="inline-flex items-center rounded-full bg-amber-50 border border-amber-200 px-2.5 py-0.5 text-xs font-medium text-amber-700">{t}</span>
                ))}
              </div>
            </div>
          )}

          {/* Other tags */}
          {otherTags.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {otherTags.map(t => (
                <span key={t} className="inline-flex items-center rounded-full bg-stone-100 px-2.5 py-0.5 text-xs font-medium text-stone-500">{t}</span>
              ))}
            </div>
          )}

          {/* Quantity stepper */}
          {chargeIsQueued && !locked && (
            <div className="flex items-center justify-between pt-2 border-t border-stone-100">
              <p className="text-sm font-semibold text-stone-700">Add to box</p>
              <div className="flex items-center gap-3">
                <StepperTip tip={item.quantity <= 0 ? "Not in your box yet" : undefined}>
                  <button onClick={() => onAdjust(-1)} disabled={item.quantity <= 0 || isSaving} className="stepper-btn">
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                      <path strokeLinecap="round" d="M20 12H4" />
                    </svg>
                  </button>
                </StepperTip>
                <span className={`text-lg font-bold tabular-nums min-w-[24px] text-center ${item.quantity > 0 ? "text-stone-900" : "text-stone-300"}`}>
                  {item.quantity}
                </span>
                <StepperTip tip={item.offMenu ? "Not on this week's menu — you can only remove it" : totalItems >= maxMeals ? `Box is full — remove a meal to swap` : undefined}>
                  <button onClick={() => onAdjust(1)} disabled={item.offMenu || totalItems >= maxMeals || isSaving} className="stepper-btn">
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                      <path strokeLinecap="round" d="M12 6v12M6 12h12" />
                    </svg>
                  </button>
                </StepperTip>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Added add-on row (onetime line item) ─────────────────────────────────────

function AddedAddonRow({
  item,
  imageByVariantId,
  locked = false,
  scheduledAt,
  bundleVariantId,
}: {
  item: ChargeLineItem;
  imageByVariantId: Record<string, string | null>;
  locked?: boolean;
  scheduledAt: string;
  bundleVariantId: string;
}) {
  const fetcher = useFetcher<typeof action>();
  const isRemoving = fetcher.state !== "idle";
  const fetcherData = fetcher.data as
    | { success: true; intent: "remove_addon" }
    | { error: string; intent: "remove_addon" }
    | undefined;
  const removeError =
    fetcher.state === "idle" && fetcherData != null && "error" in fetcherData
      ? (fetcherData as { error: string }).error
      : null;

  const handleRemove = () => {
    fetcher.submit(
      {
        intent: "remove_addon",
        bundleVariantId,
        onetimeId: String(item.purchase_item_id),
        scheduledAt,
      },
      { method: "post" }
    );
  };

  const variantId = item.external_variant_id?.ecommerce ?? null;
  const imageUrl =
    item.images?.medium ?? item.images?.small ?? item.images?.original
    ?? (variantId ? imageByVariantId[variantId] : null)
    ?? null;

  return (
    <div className={`flex items-center gap-4 px-4 py-3 bg-brand-50/60 animate-bounce-in transition-opacity ${isRemoving ? "opacity-40" : ""}`}>
      {imageUrl ? (
        <img
          src={imageUrl}
          alt={item.title}
          className="w-12 h-12 rounded-lg object-cover flex-none bg-stone-100"
        />
      ) : (
        <div className="w-12 h-12 rounded-lg bg-stone-100 flex items-center justify-center flex-none">
          <svg className="w-5 h-5 text-stone-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
          </svg>
        </div>
      )}

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 mb-0.5">
          <svg className="w-3.5 h-3.5 text-brand-600 flex-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
          <p className="text-sm font-semibold text-stone-800 truncate">{item.title}</p>
        </div>
        {item.variant_title && item.variant_title !== "Default Title" && (
          <p className="text-xs text-stone-500 truncate">{item.variant_title}</p>
        )}
        {removeError && (
          <p className="text-xs text-red-600 mt-0.5">{removeError}</p>
        )}
      </div>

      <div className="flex items-center gap-1 flex-none">
        {item.quantity > 1 && (
          <span className="text-xs text-stone-500 mr-1">x{item.quantity}</span>
        )}
        <span className="text-sm font-bold text-stone-900">{formatCurrency(item.total_price)}</span>
      </div>

      {!locked && (
        <button
          onClick={handleRemove}
          disabled={isRemoving}
          className="flex-none w-8 h-8 rounded-lg flex items-center justify-center text-stone-400 hover:text-red-500 hover:bg-red-50 transition-colors disabled:opacity-40"
          title="Remove add-on"
        >
          {isRemoving ? (
            <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
          ) : (
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
          )}
        </button>
      )}
    </div>
  );
}

// ─── Simple charge list (for charges without bundles) ─────────────────────────

function ChargesListSimple({
  charges,
  subscriptions,
  deliveryDateOffset,
  modificationWindowDays,
  bundleVariantId,
}: {
  charges: Charge[];
  subscriptions: Subscription[];
  deliveryDateOffset: number;
  modificationWindowDays: number;
  bundleVariantId: string;
}) {
  return (
    <div className="card overflow-hidden">
      <div className="px-5 py-4 border-b border-stone-100">
        <h2 className="font-display font-semibold text-stone-900">Upcoming Deliveries</h2>
      </div>
      <div className="divide-y divide-stone-100">
        {charges.map((charge) => {
          const chargeLocked = isChargeLockedClient(charge.scheduled_at, deliveryDateOffset, modificationWindowDays);
          return (
            <SimpleChargeRow
              key={charge.id}
              charge={charge}
              subscriptions={subscriptions}
              deliveryDateOffset={deliveryDateOffset}
              bundleVariantId={bundleVariantId}
              locked={chargeLocked}
            />
          );
        })}
      </div>
    </div>
  );
}

function isChargeLockedClient(scheduledAt: string, deliveryDateOffset: number, modificationWindowDays: number): boolean {
  if (modificationWindowDays <= 0) return false;
  const delivery = new Date(scheduledAt.slice(0, 10) + "T00:00:00Z");
  delivery.setUTCDate(delivery.getUTCDate() + deliveryDateOffset);
  const cutoff = new Date(delivery);
  cutoff.setUTCDate(cutoff.getUTCDate() - modificationWindowDays);
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  return today >= cutoff;
}

function SimpleChargeRow({
  charge,
  subscriptions,
  deliveryDateOffset,
  bundleVariantId,
  locked = false,
}: {
  charge: Charge;
  subscriptions: Subscription[];
  deliveryDateOffset: number;
  bundleVariantId: string;
  locked?: boolean;
}) {
  const fetcher = useFetcher<typeof action>();
  const isSubmitting = fetcher.state !== "idle";
  const fetcherData = fetcher.data as
    | { success: true; intent: "skip" | "unskip"; chargeId: number }
    | { error: string; intent: "skip" | "unskip" }
    | undefined;
  const lastSuccessIntent =
    fetcher.state === "idle" && fetcherData != null && "success" in fetcherData
      ? fetcherData.intent
      : null;

  const displayStatus =
    lastSuccessIntent === "skip"
      ? "skipped"
      : lastSuccessIntent === "unskip"
        ? "queued"
        : charge.status;
  const isQueued = displayStatus === "queued";
  const isSkipped = displayStatus === "skipped";

  return (
    <div className="px-5 py-4 flex items-center gap-4 hover:bg-cream-dark/50 transition-colors">
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-stone-800">{formatDate(addDaysToDate(charge.scheduled_at, deliveryDateOffset))}</p>
        <p className="text-xs text-stone-500">Charged on {formatDate(charge.scheduled_at)}</p>
        <div className="flex flex-wrap gap-1 mt-1">
          {charge.line_items.slice(0, 3).map((li, i) => (
            <span key={i} className="text-xs text-stone-500">
              {li.quantity > 1 && <span className="font-medium">{li.quantity}x </span>}
              {li.title}
              {i < Math.min(charge.line_items.length, 3) - 1 && ","}
            </span>
          ))}
          {charge.line_items.length > 3 && (
            <span className="text-xs text-stone-500">+{charge.line_items.length - 3} more</span>
          )}
        </div>
      </div>
      <p className="text-sm font-bold text-stone-800 flex-none">{formatCurrency(charge.total_price)}</p>
      <ChargeBadge status={displayStatus} />
      {isQueued && !locked && (
        <fetcher.Form method="post">
          <input type="hidden" name="intent" value="skip" />
          <input type="hidden" name="bundleVariantId" value={bundleVariantId} />
          <input type="hidden" name="chargeId" value={String(charge.id)} />
          <input type="hidden" name="scheduledAt" value={charge.scheduled_at} />
          <button type="submit" disabled={isSubmitting} className="btn-danger-ghost text-xs whitespace-nowrap">
            {isSubmitting ? "Skipping..." : "Skip"}
          </button>
        </fetcher.Form>
      )}
      {isSkipped && (
        <fetcher.Form method="post">
          <input type="hidden" name="intent" value="unskip" />
          <input type="hidden" name="bundleVariantId" value={bundleVariantId} />
          <input type="hidden" name="chargeId" value={String(charge.id)} />
          <button
            type="submit"
            disabled={isSubmitting}
            className="px-3 py-1.5 text-xs font-bold text-white rounded-lg uppercase tracking-wide whitespace-nowrap transition-colors disabled:opacity-60"
            style={{ backgroundColor: "#b45309" }}
            onMouseEnter={(e) => { if (!isSubmitting) e.currentTarget.style.backgroundColor = "#92400e"; }}
            onMouseLeave={(e) => { if (!isSubmitting) e.currentTarget.style.backgroundColor = "#b45309"; }}
          >
            {isSubmitting ? "Unskipping..." : "Unskip"}
          </button>
        </fetcher.Form>
      )}
      {isQueued && locked && (
        <span className="badge flex-none bg-amber-50 text-amber-700">Locked</span>
      )}
    </div>
  );
}

function ChargeBadge({ status }: { status: string }) {
  const config: Record<string, string> = {
    queued: "bg-blue-50 text-blue-700",
    success: "bg-brand-50 text-brand-700",
    skipped: "bg-amber-50 text-amber-700",
    error: "bg-red-50 text-red-700",
    refunded: "bg-stone-100 text-stone-500",
    pending: "bg-purple-50 text-purple-700",
  };
  return (
    <span className={`badge flex-none ${config[status] ?? "bg-stone-100 text-stone-600"}`}>
      {status}
    </span>
  );
}

// ─── Empty state ──────────────────────────────────────────────────────────────

function EmptyState() {
  return (
    <div className="card p-16 text-center">
      <div className="w-16 h-16 rounded-full bg-stone-100 flex items-center justify-center mx-auto mb-4">
        <svg className="w-8 h-8 text-stone-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
        </svg>
      </div>
      <h3 className="font-display font-semibold text-stone-700 mb-1">No upcoming deliveries</h3>
      <p className="text-sm text-stone-500">Your next delivery hasn't been scheduled yet.</p>
    </div>
  );
}

function ReactivatePrompt({ subscription }: { subscription: { id: number; productTitle: string } }) {
  const fetcher = useFetcher<typeof action>();
  const busy = fetcher.state !== "idle";
  const error =
    fetcher.data != null && "error" in fetcher.data ? (fetcher.data as { error: string }).error : null;

  return (
    <div className="card p-16 text-center">
      <div className="w-16 h-16 rounded-full bg-stone-100 flex items-center justify-center mx-auto mb-4">
        <svg className="w-8 h-8 text-stone-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
        </svg>
      </div>
      <h3 className="font-display font-semibold text-stone-700 mb-1">Your subscription is cancelled</h3>
      <p className="text-sm text-stone-500 mb-5">
        {subscription.productTitle} is currently cancelled. Reactivate it to start choosing meals again.
      </p>
      <fetcher.Form method="post">
        <input type="hidden" name="intent" value="reactivate_subscription" />
        <input type="hidden" name="subscriptionId" value={subscription.id} />
        <button type="submit" disabled={busy} className="btn-primary text-sm px-5 py-2">
          {busy ? "Reactivating…" : "Reactivate subscription"}
        </button>
      </fetcher.Form>
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
    </div>
  );
}
