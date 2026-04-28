import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Link, useFetcher, useLoaderData, useNavigation, useRevalidator, useSearchParams } from "@remix-run/react";
import { useEffect, useRef, useState } from "react";
import {
  getCustomer,
  getBundleCollectionsFromShopify,
  getBundleProductInfo,
  getBundleSelections,
  getSubscription,
  listQueuedCharges,
  listSubscriptions,
  skipCharge,
  updateBundleSelection,
} from "~/lib/recharge.server";
import {
  filterCollectionsForWeek,
  getCollectionsWithAvailability,
} from "~/lib/shopify.server";
import { getWeekAssignments } from "~/lib/week-assignments.server";
import { getCustomerPreferences, type CustomerPreference } from "~/lib/customer-preferences.server";
import type { BundleCollection, BundleSelection, BundleSelectionItem, Charge, Customer, Subscription } from "~/lib/types";
import { formatCurrency, formatDate } from "~/lib/utils";

export const meta: MetaFunction = () => [{ title: "NourishBox — My Deliveries" }];

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
};

type ActiveChargeBundle = {
  charge: Charge;
  bundleSelections: BundleSelection[];
  subscriptionTitles: Record<number, string>;
  collectionsByProductId: Record<string, BundleCollection[]>;
  bundleProductRangesByProductId: Record<string, number[][]>;
  eligibleCollectionIds: string[];
};

// ─── Loader ───────────────────────────────────────────────────────────────────

export async function loader({ params, request }: LoaderFunctionArgs) {
  const { customerId } = params;
  if (!customerId) throw new Error("Missing customer ID");
  if (!/^\d+$/.test(customerId)) {
    throw new Response("Not Found", { status: 404 });
  }

  const url = new URL(request.url);
  const selectedWeek = url.searchParams.get("week");

  // Phase 1: Light data — Recharge only, no Shopify calls
  const [customer, subscriptions, queuedCharges, customerPreferences] = await Promise.all([
    getCustomer(customerId),
    listSubscriptions(customerId),
    listQueuedCharges(customerId),
    Promise.resolve(getCustomerPreferences(customerId)),
  ]);

  // Phase 2: Check which charges have bundles (Recharge API only)
  const chargesBundleCheck = await Promise.all(
    queuedCharges.map(async (charge) => ({
      charge,
      bundleSelections: await getBundleSelections(charge.id),
    }))
  );

  const chargeTabs: ChargeTabInfo[] = chargesBundleCheck.map((cb) => ({
    chargeId: cb.charge.id,
    scheduledAt: cb.charge.scheduled_at,
    totalPrice: cb.charge.total_price,
    hasBundles: cb.bundleSelections.length > 0,
  }));

  const chargesWithBundles = chargesBundleCheck.filter((cb) => cb.bundleSelections.length > 0);

  // Phase 3: Load full Shopify data ONLY for the active/selected charge
  const activeEntry = selectedWeek
    ? chargesWithBundles.find((cb) => String(cb.charge.id) === selectedWeek) ?? chargesWithBundles[0]
    : chargesWithBundles[0];

  let activeBundle: ActiveChargeBundle | null = null;

  if (activeEntry && activeEntry.bundleSelections.length > 0) {
    const { charge, bundleSelections } = activeEntry;

    const uniquePurchaseItemIds = [...new Set(bundleSelections.map((bs) => bs.purchase_item_id))];
    const subs = await Promise.all(uniquePurchaseItemIds.map((id) => getSubscription(id)));
    const subscriptionTitles = Object.fromEntries(subs.map((s) => [s.id, s.product_title]));

    const uniqueProductIds = [...new Set(bundleSelections.map((bs) => bs.external_product_id).filter(Boolean))] as string[];
    const [bundleProductInfoList, collectionsWithAvailability] = await Promise.all([
      Promise.all(uniqueProductIds.map(getBundleProductInfo)),
      getCollectionsWithAvailability(),
    ]);

    const selectionCollectionIds = bundleSelections.flatMap((bs) => bs.items.map((i) => i.collection_id));
    const collectionIds = [
      ...new Set([...selectionCollectionIds, ...bundleProductInfoList.flatMap((info) => info.collectionIds)]),
    ];

    const weekStart = getMondayOf(charge.scheduled_at);
    const savedAssignments = getWeekAssignments(weekStart);
    const eligibleCollectionIds = savedAssignments
      ?? filterCollectionsForWeek(collectionsWithAvailability, weekStart).map((c) => String(c.id));

    const availableCollections = await getBundleCollectionsFromShopify(collectionIds);
    const collectionsByProductId = Object.fromEntries(
      uniqueProductIds.map((pid) => [pid, availableCollections])
    ) as Record<string, typeof availableCollections>;
    const bundleProductRangesByProductId = Object.fromEntries(
      uniqueProductIds.map((pid, i) => [pid, bundleProductInfoList[i].quantityRanges])
    ) as Record<string, number[][]>;

    activeBundle = {
      charge,
      bundleSelections,
      subscriptionTitles,
      collectionsByProductId,
      bundleProductRangesByProductId,
      eligibleCollectionIds: [...new Set(eligibleCollectionIds)],
    };
  }

  return json({ customer, subscriptions, queuedCharges, chargeTabs, activeBundle, customerPreferences });
}

// ─── Action ───────────────────────────────────────────────────────────────────

export async function action({ request }: ActionFunctionArgs) {
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "update_bundle") {
    const rawId = formData.get("bundleSelectionId");
    const rawItems = formData.get("items");
    if (typeof rawId !== "string" || typeof rawItems !== "string") {
      return json({ error: "Invalid payload" }, { status: 400 });
    }
    const items = JSON.parse(rawItems) as Array<
      Pick<BundleSelectionItem, "collection_id" | "collection_source" | "external_product_id" | "external_variant_id" | "quantity">
    >;
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

  if (intent === "skip") {
    const chargeId = formData.get("chargeId");
    const rawPurchaseItemId = formData.get("purchaseItemId");
    if (typeof chargeId !== "string") {
      return json({ error: "Missing chargeId" }, { status: 400 });
    }
    const purchaseItemIds =
      typeof rawPurchaseItemId === "string" && rawPurchaseItemId
        ? [Number(rawPurchaseItemId)]
        : undefined;
    const charge = await skipCharge(chargeId, purchaseItemIds);
    return json({ success: true, chargeId: charge.id });
  }

  return json({ error: "Unknown intent" }, { status: 400 });
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function Dashboard() {
  const { customer, subscriptions, queuedCharges, chargeTabs, activeBundle, customerPreferences } =
    useLoaderData<typeof loader>();
  const { revalidate, state } = useRevalidator();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigation = useNavigation();

  useEffect(() => {
    const id = setInterval(revalidate, 30_000);
    return () => clearInterval(id);
  }, [revalidate]);

  const tabsWithBundles = chargeTabs.filter((t) => t.hasBundles);
  const selectedWeek = searchParams.get("week");
  const activeIndex = selectedWeek
    ? Math.max(0, tabsWithBundles.findIndex((t) => String(t.chargeId) === selectedWeek))
    : 0;

  const isLoadingTab = navigation.state === "loading";

  return (
    <div className="min-h-screen bg-cream bg-grain">
      <Header customer={customer} refreshing={state === "loading"} />

      <main className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-8">
        {/* Subscription summary */}
        <SubscriptionSummary subscriptions={subscriptions} totalQueued={queuedCharges.length} />

        {/* Preferences banner */}
        {customerPreferences && <PreferencesBanner preferences={customerPreferences} />}

        {/* Week tabs + Meal grid */}
        {tabsWithBundles.length > 0 ? (
          <section>
            <WeekTabs
              tabs={tabsWithBundles}
              activeIndex={activeIndex}
              onSelect={(i) => {
                const params = new URLSearchParams(searchParams);
                params.set("week", String(tabsWithBundles[i].chargeId));
                setSearchParams(params, { preventScrollReset: true });
              }}
            />

            {isLoadingTab && !activeBundle ? (
              <LoadingGrid />
            ) : activeBundle ? (
              <div key={activeBundle.charge.id} className={`animate-fade-in ${isLoadingTab ? "opacity-50 pointer-events-none" : ""}`}>
                {activeBundle.bundleSelections.map((bs) => (
                  <MealGrid
                    key={bs.id}
                    charge={activeBundle.charge}
                    bundleSelection={bs}
                    subscriptionTitle={activeBundle.subscriptionTitles[bs.purchase_item_id] ?? `Subscription #${bs.purchase_item_id}`}
                    availableCollections={bs.external_product_id ? (activeBundle.collectionsByProductId[bs.external_product_id] ?? []) : []}
                    quantityRanges={bs.external_product_id ? (activeBundle.bundleProductRangesByProductId[bs.external_product_id] ?? []) : []}
                    preferences={customerPreferences}
                    eligibleCollectionIds={activeBundle.eligibleCollectionIds}
                  />
                ))}
              </div>
            ) : null}
          </section>
        ) : queuedCharges.length > 0 ? (
          <ChargesListSimple charges={queuedCharges} subscriptions={subscriptions} />
        ) : (
          <EmptyState />
        )}
      </main>
    </div>
  );
}

function LoadingGrid() {
  return (
    <div className="space-y-5">
      <div className="card p-5 animate-pulse">
        <div className="h-4 bg-stone-200 rounded w-48 mb-3" />
        <div className="h-2.5 bg-stone-100 rounded-full" />
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="card overflow-hidden animate-pulse">
            <div className="aspect-square bg-stone-100" />
            <div className="p-3 space-y-2">
              <div className="h-3 bg-stone-200 rounded w-3/4 mx-auto" />
              <div className="h-3 bg-stone-100 rounded w-1/2 mx-auto" />
              <div className="flex justify-center gap-3 pt-1">
                <div className="w-9 h-9 rounded-full bg-stone-100" />
                <div className="w-5 h-5 rounded bg-stone-100" />
                <div className="w-9 h-9 rounded-full bg-stone-100" />
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

function Header({ customer, refreshing }: { customer: Customer; refreshing: boolean }) {
  return (
    <header className="relative overflow-hidden">
      <div className="bg-gradient-to-r from-brand-800 via-brand-700 to-brand-600">
        {/* Decorative bg */}
        <div className="absolute inset-0 overflow-hidden">
          <div className="absolute -top-20 -right-20 w-80 h-80 bg-brand-500/20 rounded-full" />
          <div className="absolute -bottom-16 -left-16 w-64 h-64 bg-brand-400/10 rounded-full" />
        </div>

        <div className="relative max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-6 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link to="/" className="flex items-center gap-2.5 group">
              <LeafIcon className="w-8 h-8 text-brand-300 group-hover:scale-110 transition-transform" />
              <span className="text-lg font-display font-bold text-white tracking-tight">
                NourishBox
              </span>
            </Link>
            {refreshing && (
              <span className="text-xs text-brand-300/60 animate-pulse-soft ml-2">Syncing...</span>
            )}
          </div>

          <div className="flex items-center gap-3">
            <div className="text-right hidden sm:block">
              <p className="text-sm font-medium text-white leading-none">
                {customer.first_name} {customer.last_name}
              </p>
              <p className="text-xs text-brand-300/70 mt-0.5">{customer.email}</p>
            </div>
            <div className="w-10 h-10 rounded-full bg-brand-500/30 border-2 border-brand-400/40 flex items-center justify-center">
              <span className="text-sm font-bold text-white">
                {customer.first_name?.[0]}{customer.last_name?.[0]}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Wave separator */}
      <svg className="w-full h-6 text-cream -mt-px" viewBox="0 0 1200 30" preserveAspectRatio="none" fill="currentColor">
        <path d="M0 30V0c200 25 400 25 600 0s400-25 600 0v30z" />
      </svg>
    </header>
  );
}

// ─── Subscription summary ─────────────────────────────────────────────────────

function SubscriptionSummary({ subscriptions, totalQueued }: { subscriptions: Subscription[]; totalQueued: number }) {
  if (subscriptions.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-4">
      {subscriptions.map((sub) => (
        <div key={sub.id} className="card card-hover flex-1 min-w-[260px] p-5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="font-display font-semibold text-stone-900 truncate">{sub.product_title}</h3>
              <div className="flex items-center gap-2 mt-1.5">
                <StatusBadge status={sub.status} />
                {sub.charge_interval_frequency && sub.order_interval_unit && (
                  <span className="text-xs text-stone-400">
                    Every {sub.charge_interval_frequency} {sub.order_interval_unit}
                    {sub.charge_interval_frequency > 1 ? "s" : ""}
                  </span>
                )}
              </div>
            </div>
            {sub.next_charge_scheduled_at && (
              <div className="flex-none text-right">
                <p className="text-xs text-stone-400">Next delivery</p>
                <p className="text-sm font-semibold text-stone-700">{formatDate(sub.next_charge_scheduled_at)}</p>
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const config: Record<string, { bg: string; text: string; dot: string }> = {
    active: { bg: "bg-brand-50", text: "text-brand-700", dot: "bg-brand-500" },
    cancelled: { bg: "bg-stone-100", text: "text-stone-600", dot: "bg-stone-400" },
    expired: { bg: "bg-amber-50", text: "text-amber-700", dot: "bg-amber-500" },
  };
  const c = config[status] ?? config.cancelled;
  return (
    <span className={`badge ${c.bg} ${c.text}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${c.dot} ${status === "active" ? "animate-pulse-soft" : ""}`} />
      {status}
    </span>
  );
}

// ─── Preferences banner ───────────────────────────────────────────────────────

function PreferencesBanner({ preferences }: { preferences: CustomerPreference }) {
  const hasIncludes = preferences.include.length > 0;
  const hasExcludes = preferences.exclude.length > 0;
  if (!hasIncludes && !hasExcludes) return null;

  return (
    <div className="card p-5">
      <div className="flex items-center gap-2 mb-3">
        <div className="w-8 h-8 rounded-full bg-brand-50 flex items-center justify-center">
          <svg className="w-4 h-4 text-brand-600" viewBox="0 0 20 20" fill="currentColor">
            <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
          </svg>
        </div>
        <h3 className="font-display font-semibold text-stone-900">Your Taste Profile</h3>
      </div>
      <div className="flex flex-wrap gap-2">
        {preferences.include.map((tag) => (
          <span key={tag} className="badge bg-brand-50 text-brand-700 border border-brand-200">
            <svg className="w-3 h-3" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
            </svg>
            {tag}
          </span>
        ))}
        {preferences.exclude.map((tag) => (
          <span key={tag} className="badge bg-amber-50 text-amber-700 border border-amber-200">
            <svg className="w-3 h-3" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
            </svg>
            {tag}
          </span>
        ))}
      </div>
    </div>
  );
}

// ─── Week tabs ────────────────────────────────────────────────────────────────

function formatWeekLabel(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

function WeekTabs({
  tabs,
  activeIndex,
  onSelect,
}: {
  tabs: ChargeTabInfo[];
  activeIndex: number;
  onSelect: (index: number) => void;
}) {
  return (
    <div className="mb-6">
      <h2 className="font-display text-xl font-bold text-stone-900 mb-4">Choose Your Meals</h2>
      <div className="flex gap-2 overflow-x-auto scrollbar-hide pb-2">
        {tabs.map((tab, i) => {
          const isActive = i === activeIndex;
          return (
            <button
              key={tab.chargeId}
              onClick={() => onSelect(i)}
              className={`flex-none rounded-2xl px-5 py-3 text-sm font-medium transition-all duration-200 border ${
                isActive
                  ? "text-white border-transparent scale-[1.02]"
                  : "bg-white text-stone-600 border-stone-200 hover:border-green-300 hover:text-green-700"
              }`}
              style={isActive ? { backgroundColor: "#16a34a", borderColor: "#16a34a", boxShadow: "0 4px 12px rgba(28, 25, 23, 0.07)" } : undefined}
            >
              <p className="font-semibold">Week of {formatWeekLabel(tab.scheduledAt)}</p>
              <p className={`text-xs mt-0.5 ${isActive ? "text-green-200" : "text-stone-400"}`}>
                {formatCurrency(tab.totalPrice)}
              </p>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ─── Meal grid (bundle editor) ────────────────────────────────────────────────

type EditableItem = {
  collection_id: string;
  collection_source: string;
  external_product_id: string;
  external_variant_id: string;
  quantity: number;
  productTitle: string;
  variantTitle: string;
  imageUrl: string | null;
  tags: string[];
};

function matchesTags(itemTags: string[], prefTags: string[]): boolean {
  return itemTags.some((t) => prefTags.some((p) => p.toLowerCase() === t.toLowerCase()));
}

function tierOf(item: EditableItem, preferences: CustomerPreference | null): number {
  if (item.quantity > 0) return 0;
  if (!preferences) return 1;
  if (matchesTags(item.tags, preferences.exclude)) return 3;
  if (matchesTags(item.tags, preferences.include)) return 1;
  return 2;
}

function buildEditableItems(
  bundleSelection: BundleSelection,
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
      });
    }
  }

  return result.sort((a, b) => tierOf(a, preferences) - tierOf(b, preferences));
}

function formatRangeLabel(ranges: number[][]): string {
  if (ranges.length === 0) return "";
  const [min, max] = ranges[0];
  if (min === max) return `${min} meal${min !== 1 ? "s" : ""}`;
  return `${min}–${max} meals`;
}

function MealGrid({
  charge,
  bundleSelection,
  subscriptionTitle,
  availableCollections,
  quantityRanges,
  preferences,
  eligibleCollectionIds,
}: {
  charge: Charge;
  bundleSelection: BundleSelection;
  subscriptionTitle: string;
  availableCollections: BundleCollection[];
  quantityRanges: number[][];
  preferences: CustomerPreference | null;
  eligibleCollectionIds: string[];
}) {
  const fetcher = useFetcher<typeof action>();
  const skipFetcher = useFetcher();
  const eligibleSet = new Set(eligibleCollectionIds);
  const [items, setItems] = useState<EditableItem[]>(() =>
    buildEditableItems(bundleSelection, availableCollections, preferences, eligibleSet)
  );
  const [savedQty, setSavedQty] = useState<Record<string, number>>(
    () => Object.fromEntries(bundleSelection.items.map((i) => [i.external_variant_id, i.quantity]))
  );
  const [errorDismissed, setErrorDismissed] = useState(false);
  const [knownRanges, setKnownRanges] = useState<number[][]>(quantityRanges);
  const submittedQtyRef = useRef<Record<string, number>>({});

  const isSaving = fetcher.state !== "idle";
  const isSkipping = skipFetcher.state !== "idle";
  const fetcherData = fetcher.data as
    | { success: true; intent: "update_bundle" }
    | { error: string; ranges?: number[][]; intent: "update_bundle" }
    | undefined;

  const savedOk = fetcher.state === "idle" && fetcherData != null && "success" in fetcherData;
  const fetcherError =
    fetcher.state === "idle" && fetcherData != null && "error" in fetcherData ? fetcherData : null;
  const showError = fetcherError != null && !errorDismissed;

  const effectiveRanges = knownRanges;
  const rangeLabel = formatRangeLabel(effectiveRanges);
  const totalItems = items.reduce((sum, item) => sum + item.quantity, 0);
  const isValidTotal =
    effectiveRanges.length === 0 ||
    effectiveRanges.some(([min, max]) => totalItems >= min && totalItems <= max);
  const targetTotal = effectiveRanges.length > 0 ? effectiveRanges[0][1] : 0;

  const hasChanges = items.some((item) => {
    const orig = savedQty[item.external_variant_id] ?? 0;
    return item.quantity !== orig;
  });

  useEffect(() => {
    if (fetcherError?.ranges?.length) setKnownRanges(fetcherError.ranges);
  }, [fetcherError]);

  useEffect(() => {
    if (isSaving) setErrorDismissed(false);
  }, [isSaving]);

  useEffect(() => {
    if (savedOk) {
      setSavedQty(submittedQtyRef.current);
      setItems((prev) => [...prev].sort((a, b) => tierOf(a, preferences) - tierOf(b, preferences)));
    }
  }, [savedOk]);

  const adjustQty = (index: number, delta: number) => {
    setItems((prev) =>
      prev.map((item, i) =>
        i === index ? { ...item, quantity: Math.max(0, item.quantity + delta) } : item
      )
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
      {
        intent: "update_bundle",
        bundleSelectionId: String(bundleSelection.id),
        items: JSON.stringify(payload),
      },
      { method: "post" }
    );
  };

  const chargeIsQueued = charge.status === "queued";
  const customerId = charge.customer?.id ? String(charge.customer.id) : null;
  const progressPercent = targetTotal > 0 ? Math.min(100, (totalItems / targetTotal) * 100) : 0;

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

      {/* Progress bar */}
      {chargeIsQueued && targetTotal > 0 && (
        <div className="card p-5">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <h3 className="font-display font-semibold text-stone-900">{subscriptionTitle}</h3>
              <span className="text-xs text-stone-400">for {formatDate(charge.scheduled_at)}</span>
            </div>
            <span className="text-sm font-bold tabular-nums" style={{ color: isValidTotal ? "#16a34a" : "#d97706" }}>
              {totalItems} / {rangeLabel}
            </span>
          </div>
          <div className="h-2.5 bg-stone-100 rounded-full overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-500 ease-out"
              style={{
                width: `${progressPercent}%`,
                background: isValidTotal
                  ? "linear-gradient(to right, #22c55e, #4ade80)"
                  : "#fbbf24",
              }}
            />
          </div>
        </div>
      )}

      {/* Meal cards grid */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
        {items.map((item, index) => {
          const isSelected = item.quantity > 0;
          const isPrefMatch = preferences && matchesTags(item.tags, preferences.include);
          const isPrefExclude = preferences && matchesTags(item.tags, preferences.exclude);

          return (
            <div
              key={item.external_variant_id}
              className={`card overflow-hidden transition-all duration-200 ${
                isSelected
                  ? "ring-2 ring-green-500"
                  : "hover:-translate-y-0.5"
              }`}
              style={{
                animationDelay: `${Math.min(index, 8) * 0.03}s`,
                ...(isSelected ? { boxShadow: "0 0 0 3px rgba(34, 197, 94, 0.2)" } : {}),
              }}
            >
              {/* Image area */}
              <div className="relative aspect-square bg-stone-50 overflow-hidden">
                {item.imageUrl ? (
                  <img
                    src={item.imageUrl}
                    alt={item.productTitle}
                    className={`w-full h-full object-cover transition-all duration-300 ${
                      isSelected ? "" : "saturate-[0.85]"
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
                  <div className="absolute top-2 right-2 w-6 h-6 rounded-full flex items-center justify-center animate-check-pop" style={{ backgroundColor: "#22c55e", boxShadow: "0 1px 3px rgba(28,25,23,0.06)" }}>
                    <svg className="w-3.5 h-3.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  </div>
                )}

                {/* Preference badges */}
                {isPrefMatch && !isSelected && (
                  <div className="absolute top-2 left-2">
                    <span className="badge text-white text-[10px]" style={{ backgroundColor: "#22c55e", boxShadow: "0 1px 3px rgba(28,25,23,0.06)" }}>
                      <svg className="w-2.5 h-2.5" viewBox="0 0 20 20" fill="currentColor">
                        <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                      </svg>
                      Match
                    </span>
                  </div>
                )}
                {isPrefExclude && (
                  <div className="absolute top-2 left-2">
                    <span className="badge bg-amber-500 text-white text-[10px] shadow-warm-sm">Avoid</span>
                  </div>
                )}
              </div>

              {/* Card body */}
              <div className="p-3 text-center">
                <h4 className="text-sm font-semibold text-stone-800 leading-tight line-clamp-2 mb-0.5">
                  {item.productTitle}
                </h4>
                {item.variantTitle && item.variantTitle !== "Default Title" && (
                  <p className="text-xs text-stone-400 line-clamp-1">{item.variantTitle}</p>
                )}

                {/* Stepper */}
                {chargeIsQueued ? (
                  <div className="flex items-center justify-center gap-3 mt-3">
                    <button
                      onClick={() => adjustQty(index, -1)}
                      disabled={item.quantity <= 0}
                      className="stepper-btn disabled:bg-stone-200"
                      style={item.quantity > 0 ? { backgroundColor: "#ef4444" } : undefined}
                      onMouseEnter={(e) => { if (item.quantity > 0) e.currentTarget.style.backgroundColor = "#dc2626"; }}
                      onMouseLeave={(e) => { if (item.quantity > 0) e.currentTarget.style.backgroundColor = "#ef4444"; }}
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                        <path strokeLinecap="round" d="M20 12H4" />
                      </svg>
                    </button>
                    <span className={`text-base font-bold tabular-nums min-w-[20px] ${
                      isSelected ? "text-stone-900" : "text-stone-300"
                    }`}>
                      {item.quantity}
                    </span>
                    <button
                      onClick={() => adjustQty(index, 1)}
                      className="stepper-btn"
                      style={{ backgroundColor: "#22c55e" }}
                      onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = "#16a34a"; }}
                      onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = "#22c55e"; }}
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                        <path strokeLinecap="round" d="M12 6v12M6 12h12" />
                      </svg>
                    </button>
                  </div>
                ) : (
                  <p className="text-sm font-semibold text-stone-400 mt-3">
                    {item.quantity > 0 ? `x${item.quantity}` : "—"}
                  </p>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Sticky footer */}
      {chargeIsQueued && (
        <div className="sticky bottom-0 z-20 -mx-4 sm:-mx-6 lg:-mx-8 px-4 sm:px-6 lg:px-8">
          <div className="card rounded-b-none border-b-0 border-x-0 sm:border-x px-5 py-4 flex items-center justify-between gap-4 backdrop-blur-sm bg-white/95">
            <div className="flex items-center gap-4">
              <skipFetcher.Form method="post">
                <input type="hidden" name="intent" value="skip" />
                <input type="hidden" name="chargeId" value={String(charge.id)} />
                {bundleSelection.purchase_item_id && (
                  <input type="hidden" name="purchaseItemId" value={String(bundleSelection.purchase_item_id)} />
                )}
                <button type="submit" disabled={isSkipping} className="btn-danger-ghost text-xs sm:text-sm">
                  {isSkipping ? "Skipping..." : "Skip this week"}
                </button>
              </skipFetcher.Form>

              {savedOk && (
                <span className="text-sm font-medium flex items-center gap-1 animate-fade-in" style={{ color: "#16a34a" }}>
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                  Saved!
                </span>
              )}
            </div>

            <div className="flex items-center gap-4">
              <div className="hidden sm:block text-right">
                <p className="text-xs text-stone-400">
                  {totalItems} meal{totalItems !== 1 ? "s" : ""} selected
                </p>
                <p className="text-sm font-bold text-stone-800">{formatCurrency(charge.total_price)}</p>
              </div>
              <button
                onClick={handleSave}
                disabled={isSaving || !hasChanges}
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
                  "Save Selections"
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Simple charge list (for charges without bundles) ─────────────────────────

function ChargesListSimple({ charges, subscriptions }: { charges: Charge[]; subscriptions: Subscription[] }) {
  return (
    <div className="card overflow-hidden">
      <div className="px-5 py-4 border-b border-stone-100">
        <h2 className="font-display font-semibold text-stone-900">Upcoming Charges</h2>
      </div>
      <div className="divide-y divide-stone-100">
        {charges.map((charge) => (
          <SimpleChargeRow key={charge.id} charge={charge} subscriptions={subscriptions} />
        ))}
      </div>
    </div>
  );
}

function SimpleChargeRow({ charge, subscriptions }: { charge: Charge; subscriptions: Subscription[] }) {
  const fetcher = useFetcher<typeof action>();
  const isSubmitting = fetcher.state !== "idle";
  const wasSkipped =
    fetcher.state === "idle" &&
    fetcher.data != null &&
    "success" in fetcher.data &&
    (fetcher.data as { success: boolean }).success === true;

  const displayStatus = wasSkipped ? "skipped" : charge.status;
  const isQueued = displayStatus === "queued";

  return (
    <div className="px-5 py-4 flex items-center gap-4 hover:bg-cream-dark/50 transition-colors">
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-stone-800">{formatDate(charge.scheduled_at)}</p>
        <div className="flex flex-wrap gap-1 mt-1">
          {charge.line_items.slice(0, 3).map((li, i) => (
            <span key={i} className="text-xs text-stone-500">
              {li.quantity > 1 && <span className="font-medium">{li.quantity}x </span>}
              {li.title}
              {i < Math.min(charge.line_items.length, 3) - 1 && ","}
            </span>
          ))}
          {charge.line_items.length > 3 && (
            <span className="text-xs text-stone-400">+{charge.line_items.length - 3} more</span>
          )}
        </div>
      </div>
      <p className="text-sm font-bold text-stone-800 flex-none">{formatCurrency(charge.total_price)}</p>
      <ChargeBadge status={displayStatus} />
      {isQueued && (
        <fetcher.Form method="post">
          <input type="hidden" name="intent" value="skip" />
          <input type="hidden" name="chargeId" value={String(charge.id)} />
          <button type="submit" disabled={isSubmitting} className="btn-danger-ghost text-xs whitespace-nowrap">
            {isSubmitting ? "Skipping..." : "Skip"}
          </button>
        </fetcher.Form>
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
      <p className="text-sm text-stone-400">Your next delivery hasn't been scheduled yet.</p>
    </div>
  );
}
