import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Link, useFetcher, useLoaderData, useNavigation, useRevalidator, useSearchParams } from "@remix-run/react";
import { useEffect, useRef, useState } from "react";
import {
  getCustomer,
  getCreditSummary,
  createOnetime,
  deleteOnetime,
  getBundleCollectionsFromShopify,
  getBundleProductInfo,
  getBundleSelections,
  getSubscription,
  listAddresses,
  listQueuedCharges,
  listSubscriptions,
  skipCharge,
  updateAddress,
  updateBundleSelection,
  updateSubscriptionProperties,
} from "~/lib/recharge.server";
import {
  filterCollectionsForWeek,
  getCollectionsWithAvailability,
} from "~/lib/shopify.server";
import { getWeekAssignments } from "~/lib/week-assignments.server";
import { getCustomerPreferences, saveCustomerPreferences, type CustomerPreference } from "~/lib/customer-preferences.server";
import { getDeliveryDateOffset } from "~/lib/merchant-settings.server";
import { getAddonCollectionIds } from "~/lib/addon-collections.server";
import type { Address, BundleCollection, BundleSelection, BundleSelectionItem, Charge, ChargeLineItem, CreditSummary, Customer, Property, Subscription } from "~/lib/types";
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

type AddonProduct = {
  externalProductId: string;
  externalVariantId: string;
  title: string;
  variantTitle: string;
  imageUrl: string | null;
  price: string;
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
  const [customer, subscriptions, queuedCharges, customerPreferences, creditSummary, addresses] = await Promise.all([
    getCustomer(customerId),
    listSubscriptions(customerId),
    listQueuedCharges(customerId),
    Promise.resolve(getCustomerPreferences(customerId)),
    getCreditSummary(customerId).catch(() => null),
    listAddresses(customerId),
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

  const deliveryDateOffset = getDeliveryDateOffset();

  // Fetch add-on products from merchant-configured collections
  let addonProducts: AddonProduct[] = [];
  const addonCollectionIds = getAddonCollectionIds();
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
          }))
      )
    );
  }

  const activeAddons = activeBundle
    ? activeBundle.charge.line_items.filter((li) => li.purchase_item_type === "onetime")
    : [];

  return json({ customer, subscriptions, queuedCharges, chargeTabs, activeBundle, customerPreferences, deliveryDateOffset, creditSummary, addonProducts, activeAddons, addresses });
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

  if (intent === "update_preferences") {
    const customerId = formData.get("customerId");
    const rawInclude = formData.getAll("include");
    const rawExclude = formData.getAll("exclude");
    if (typeof customerId !== "string") {
      return json({ error: "Missing customerId" }, { status: 400 });
    }
    const include = rawInclude.filter((v): v is string => typeof v === "string");
    const exclude = rawExclude.filter((v): v is string => typeof v === "string");

    saveCustomerPreferences(customerId, { include, exclude });

    const properties: Property[] = [
      { name: "meal_type_preference", value: JSON.stringify(include) },
      { name: "ingredient_exclusion", value: JSON.stringify(exclude) },
    ];
    const subs = await listSubscriptions(customerId);
    await Promise.all(subs.map((sub) => updateSubscriptionProperties(sub.id, properties)));

    return json({ success: true, intent: "update_preferences" } as const);
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
      const message = err instanceof Error ? err.message : "Failed to add add-on.";
      return json({ error: message, intent: "add_addon" as const });
    }
  }

  if (intent === "remove_addon") {
    const onetimeId = formData.get("onetimeId");
    if (typeof onetimeId !== "string") {
      return json({ error: "Missing onetimeId", intent: "remove_addon" as const }, { status: 400 });
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
  const { customer, subscriptions, queuedCharges, chargeTabs, activeBundle, customerPreferences, deliveryDateOffset, creditSummary, addonProducts, activeAddons, addresses } =
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
      <Header customer={customer} refreshing={state === "loading"} addresses={addresses} subscriptions={subscriptions} />

      <main className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-8">
        {/* Subscription summary */}
        <SubscriptionSummary subscriptions={subscriptions} totalQueued={queuedCharges.length} deliveryDateOffset={deliveryDateOffset} />

        {/* Credits balance */}
        <CreditsBanner creditSummary={creditSummary} />

        {/* Preferences banner */}
        <PreferencesBanner preferences={customerPreferences} customerId={String(customer.id)} />

        {/* Week tabs + Meal grid */}
        {tabsWithBundles.length > 0 ? (
          <section>
            <WeekTabs
              tabs={tabsWithBundles}
              activeIndex={activeIndex}
              deliveryDateOffset={deliveryDateOffset}
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
                    deliveryDateOffset={deliveryDateOffset}
                  />
                ))}

                {activeAddons.length > 0 && (
                  <AddedAddOns items={activeAddons} addonProducts={addonProducts} />
                )}

                {addonProducts.length > 0 && (
                  <AddOnsCarousel
                    products={addonProducts}
                    addressId={activeBundle.charge.address_id ?? 0}
                    scheduledAt={activeBundle.charge.scheduled_at}
                  />
                )}
              </div>
            ) : null}
          </section>
        ) : queuedCharges.length > 0 ? (
          <ChargesListSimple charges={queuedCharges} subscriptions={subscriptions} deliveryDateOffset={deliveryDateOffset} />
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
              <span className="text-xs text-stone-400 animate-pulse-soft ml-2">Syncing...</span>
            )}
          </div>

          <div className="flex items-center gap-3">
            <p className="text-sm text-stone-500 hidden sm:block">{customer.email}</p>
            <div className="w-10 h-10 rounded-full bg-brand-100 border-2 border-brand-200 flex items-center justify-center shrink-0">
              {customer.first_name?.[0] ? (
                <span className="text-sm font-bold text-brand-700">
                  {customer.first_name[0]}{customer.last_name?.[0]}
                </span>
              ) : (
                <svg className="w-5 h-5 text-brand-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0ZM4.501 20.118a7.5 7.5 0 0 1 14.998 0A17.933 17.933 0 0 1 12 21.75c-2.676 0-5.216-.584-7.499-1.632Z" />
                </svg>
              )}
            </div>
          </div>
        </div>

        {displayAddress && (
          <div className="border-t border-stone-100">
            <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-2 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 min-w-0">
                <svg className="w-4 h-4 text-brand-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 10.5a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1 1 15 0Z" />
                </svg>
                <span className="text-sm text-stone-600 truncate">
                  <span className="font-medium text-stone-700">Delivering to</span>{" "}
                  {formatAddress(displayAddress)}
                </span>

                {addresses.length > 1 && (
                  <select
                    className="ml-2 text-xs border border-stone-200 rounded-md px-2 py-1 bg-white text-stone-600 focus:outline-none focus:ring-1 focus:ring-brand-300"
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
              </div>

              <button
                type="button"
                onClick={() => setEditingAddress(displayAddress)}
                className="shrink-0 p-1.5 rounded-md text-stone-400 hover:text-brand-600 hover:bg-brand-50 transition-colors"
                title="Edit address"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0 1 15.75 21H5.25A2.25 2.25 0 0 1 3 18.75V8.25A2.25 2.25 0 0 1 5.25 6H10" />
                </svg>
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
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-xl w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto">
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
              <input name="first_name" defaultValue={address.first_name} className={fieldClass} />
            </div>
            <div>
              <label className="block text-xs font-medium text-stone-500 mb-1">Last name</label>
              <input name="last_name" defaultValue={address.last_name} className={fieldClass} />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-stone-500 mb-1">Address</label>
            <input name="address1" defaultValue={address.address1} className={fieldClass} />
          </div>

          <div>
            <label className="block text-xs font-medium text-stone-500 mb-1">Apartment, suite, etc.</label>
            <input name="address2" defaultValue={address.address2 ?? ""} placeholder="Optional" className={fieldClass} />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-stone-500 mb-1">City</label>
              <input name="city" defaultValue={address.city} className={fieldClass} />
            </div>
            <div>
              <label className="block text-xs font-medium text-stone-500 mb-1">State / Province</label>
              <input name="province" defaultValue={address.province} className={fieldClass} />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-stone-500 mb-1">ZIP / Postal code</label>
              <input name="zip" defaultValue={address.zip} className={fieldClass} />
            </div>
            <div>
              <label className="block text-xs font-medium text-stone-500 mb-1">Country</label>
              <select name="country_code" defaultValue={address.country_code} className={fieldClass}>
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

// ─── Subscription summary ─────────────────────────────────────────────────────

function SubscriptionSummary({ subscriptions, totalQueued, deliveryDateOffset }: { subscriptions: Subscription[]; totalQueued: number; deliveryDateOffset: number }) {
  if (subscriptions.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-4">
      {subscriptions.map((sub) => {
        const chargeDate = sub.next_charge_scheduled_at;
        const deliveryDate = chargeDate ? addDaysToDate(chargeDate, deliveryDateOffset) : null;
        return (
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
              {deliveryDate && chargeDate && (
                <div className="flex-none text-right">
                  <p className="text-xs text-stone-400">Next delivery</p>
                  <p className="text-sm font-semibold text-stone-700">{formatDate(deliveryDate)}</p>
                  <p className="text-xs text-stone-400 mt-0.5">Charged on {formatDate(chargeDate)}</p>
                </div>
              )}
            </div>
          </div>
        );
      })}
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

// ─── Credits banner ───────────────────────────────────────────────────────────

function CreditsBanner({ creditSummary }: { creditSummary: CreditSummary | null }) {
  if (!creditSummary) return null;

  const totalBalance = parseFloat(creditSummary.total_available_balance);
  if (totalBalance <= 0) return null;

  const accounts = creditSummary.include?.credit_details?.filter(
    (a) => parseFloat(a.available_balance) > 0
  );

  return (
    <div className="card p-5 bg-gradient-to-r from-emerald-50 to-teal-50 border-emerald-200">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-emerald-100 flex items-center justify-center">
            <svg className="w-5 h-5 text-emerald-600" viewBox="0 0 20 20" fill="currentColor">
              <path d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.736 6.979C9.208 6.193 9.696 6 10 6c.304 0 .792.193 1.264.979a1 1 0 001.715-1.029C12.279 4.784 11.232 4 10 4s-2.279.784-2.979 1.95c-.285.475-.507 1-.67 1.55H6a1 1 0 000 2h.013a9.358 9.358 0 000 1H6a1 1 0 100 2h.351c.163.55.385 1.075.67 1.55C7.721 15.216 8.768 16 10 16s2.279-.784 2.979-1.95a1 1 0 10-1.715-1.029c-.472.786-.96.979-1.264.979-.304 0-.792-.193-1.264-.979a5.38 5.38 0 01-.491-.921H10a1 1 0 100-2H8.003a7.364 7.364 0 010-1H10a1 1 0 100-2H8.245c.155-.347.335-.665.491-.921z" />
            </svg>
          </div>
          <div>
            <h3 className="font-display font-semibold text-stone-900">Store Credits</h3>
            <p className="text-sm text-emerald-700 font-bold">
              {formatCurrency(creditSummary.total_available_balance, creditSummary.currency_code)} available
            </p>
          </div>
        </div>
      </div>

      {accounts && accounts.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-2">
          {accounts.map((account) => (
            <div
              key={account.id}
              className="inline-flex items-center gap-2 px-3 py-1.5 bg-white/70 rounded-lg border border-emerald-200/60 text-sm"
            >
              <span className={`w-2 h-2 rounded-full ${
                account.type === "reward" ? "bg-amber-400" :
                account.type === "gift" ? "bg-purple-400" :
                "bg-emerald-400"
              }`} />
              <span className="font-medium text-stone-700">{account.name || account.type}</span>
              <span className="text-emerald-700 font-semibold">
                {formatCurrency(account.available_balance, account.currency_code)}
              </span>
              {account.expires_at && (
                <span className="text-xs text-stone-400">
                  expires {formatDate(account.expires_at)}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Preferences banner ───────────────────────────────────────────────────────

const MEAL_TYPE_OPTIONS = ["Gluten Free", "Vegetarian"];
const EXCLUSION_OPTIONS = ["Dairy", "Wheat", "Meat", "Fish"];

function PreferencesBanner({
  preferences,
  customerId,
}: {
  preferences: CustomerPreference | null;
  customerId: string;
}) {
  const fetcher = useFetcher();
  const [editing, setEditing] = useState(false);
  const [selectedIncludes, setSelectedIncludes] = useState<string[]>(preferences?.include ?? []);
  const [selectedExcludes, setSelectedExcludes] = useState<string[]>(preferences?.exclude ?? []);

  const isSaving = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data && !("error" in (fetcher.data as Record<string, unknown>))) {
      setEditing(false);
    }
  }, [fetcher.state, fetcher.data]);

  useEffect(() => {
    setSelectedIncludes(preferences?.include ?? []);
    setSelectedExcludes(preferences?.exclude ?? []);
  }, [preferences]);

  const toggleInclude = (tag: string) =>
    setSelectedIncludes((prev) => prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]);
  const toggleExclude = (tag: string) =>
    setSelectedExcludes((prev) => prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]);

  const hasPrefs = preferences && (preferences.include.length > 0 || preferences.exclude.length > 0);

  if (!editing && !hasPrefs) {
    return (
      <div className="card p-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-full bg-brand-50 flex items-center justify-center">
              <svg className="w-4 h-4 text-brand-600" viewBox="0 0 20 20" fill="currentColor">
                <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
              </svg>
            </div>
            <h3 className="font-display font-semibold text-stone-900">Your Taste Profile</h3>
          </div>
          <button
            onClick={() => setEditing(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-brand-700 bg-brand-50 hover:bg-brand-100 rounded-lg transition-colors border border-brand-200"
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
              <path d="M10 3a1 1 0 011 1v5h5a1 1 0 110 2h-5v5a1 1 0 11-2 0v-5H4a1 1 0 110-2h5V4a1 1 0 011-1z" />
            </svg>
            Set Preferences
          </button>
        </div>
        <p className="text-sm text-stone-500 mt-2">Tell us what you like and what to avoid so we can personalize your meals.</p>
      </div>
    );
  }

  if (editing) {
    return (
      <div className="card p-5 ring-2 ring-brand-200">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-full bg-brand-50 flex items-center justify-center">
              <svg className="w-4 h-4 text-brand-600" viewBox="0 0 20 20" fill="currentColor">
                <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
              </svg>
            </div>
            <h3 className="font-display font-semibold text-stone-900">Edit Taste Profile</h3>
          </div>
        </div>

        <div className="space-y-5">
          <div>
            <h4 className="text-sm font-semibold text-stone-700 mb-2.5">Meal Types I Prefer</h4>
            <div className="flex flex-wrap gap-2">
              {MEAL_TYPE_OPTIONS.map((tag) => {
                const active = selectedIncludes.includes(tag);
                return (
                  <button
                    key={tag}
                    type="button"
                    onClick={() => toggleInclude(tag)}
                    className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg border transition-all duration-150 ${
                      active
                        ? "bg-brand-50 text-brand-700 border-brand-300 ring-1 ring-brand-200"
                        : "bg-white text-stone-500 border-stone-200 hover:border-stone-300 hover:text-stone-700"
                    }`}
                  >
                    {active && (
                      <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
                        <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                      </svg>
                    )}
                    {tag}
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <h4 className="text-sm font-semibold text-stone-700 mb-2.5">Ingredients to Avoid</h4>
            <div className="flex flex-wrap gap-2">
              {EXCLUSION_OPTIONS.map((tag) => {
                const active = selectedExcludes.includes(tag);
                return (
                  <button
                    key={tag}
                    type="button"
                    onClick={() => toggleExclude(tag)}
                    className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg border transition-all duration-150 ${
                      active
                        ? "bg-amber-50 text-amber-700 border-amber-300 ring-1 ring-amber-200"
                        : "bg-white text-stone-500 border-stone-200 hover:border-stone-300 hover:text-stone-700"
                    }`}
                  >
                    {active && (
                      <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
                        <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
                      </svg>
                    )}
                    {tag}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-3 mt-5 pt-4 border-t border-stone-100">
          <button
            type="button"
            disabled={isSaving}
            onClick={() => {
              const formData = new FormData();
              formData.set("intent", "update_preferences");
              formData.set("customerId", customerId);
              for (const tag of selectedIncludes) formData.append("include", tag);
              for (const tag of selectedExcludes) formData.append("exclude", tag);
              fetcher.submit(formData, { method: "post" });
            }}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-brand-600 hover:bg-brand-700 disabled:opacity-50 rounded-lg transition-colors"
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
              "Save Preferences"
            )}
          </button>
          <button
            type="button"
            disabled={isSaving}
            onClick={() => {
              setSelectedIncludes(preferences?.include ?? []);
              setSelectedExcludes(preferences?.exclude ?? []);
              setEditing(false);
            }}
            className="px-4 py-2 text-sm font-medium text-stone-600 hover:text-stone-800 transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="card p-5">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-full bg-brand-50 flex items-center justify-center">
            <svg className="w-4 h-4 text-brand-600" viewBox="0 0 20 20" fill="currentColor">
              <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
            </svg>
          </div>
          <h3 className="font-display font-semibold text-stone-900">Your Taste Profile</h3>
        </div>
        <button
          onClick={() => setEditing(true)}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-stone-500 hover:text-brand-700 hover:bg-brand-50 rounded-lg transition-colors"
        >
          <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
            <path d="M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793L3 14.172V17h2.828l8.38-8.379-2.83-2.828z" />
          </svg>
          Edit
        </button>
      </div>
      <div className="flex flex-wrap gap-2">
        {preferences!.include.map((tag) => (
          <span key={tag} className="badge bg-brand-50 text-brand-700 border border-brand-200">
            <svg className="w-3 h-3" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
            </svg>
            {tag}
          </span>
        ))}
        {preferences!.exclude.map((tag) => (
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
    <div className="mb-6">
      <h2 className="font-display text-xl font-bold text-stone-900 mb-4">Choose Your Meals</h2>
      <div className="flex gap-2 overflow-x-auto scrollbar-hide pb-2">
        {tabs.map((tab, i) => {
          const isActive = i === activeIndex;
          const deliveryDate = addDaysToDate(tab.scheduledAt, deliveryDateOffset);
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
              <p className="font-semibold">Delivery {formatWeekLabel(deliveryDate)}</p>
              <p className={`text-xs mt-0.5 ${isActive ? "text-green-200" : "text-stone-400"}`}>
                {formatCurrency(tab.totalPrice)} · Charged {formatWeekLabel(tab.scheduledAt)}
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

const MEALS_PER_WEEK = 5;

function MealGrid({
  charge,
  bundleSelection,
  subscriptionTitle,
  availableCollections,
  quantityRanges,
  preferences,
  eligibleCollectionIds,
  deliveryDateOffset,
}: {
  charge: Charge;
  bundleSelection: BundleSelection;
  subscriptionTitle: string;
  availableCollections: BundleCollection[];
  quantityRanges: number[][];
  preferences: CustomerPreference | null;
  eligibleCollectionIds: string[];
  deliveryDateOffset: number;
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

  const totalItems = items.reduce((sum, item) => sum + item.quantity, 0);
  const isValidTotal = totalItems === MEALS_PER_WEEK;
  const targetTotal = MEALS_PER_WEEK;

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
              <span className="text-xs text-stone-400">
                delivering {formatDate(addDaysToDate(charge.scheduled_at, deliveryDateOffset))}
              </span>
              <span className="text-xs text-stone-300">
                (charged {formatDate(charge.scheduled_at)})
              </span>
            </div>
            <span className="text-sm font-bold tabular-nums" style={{ color: isValidTotal ? "#16a34a" : "#d97706" }}>
              {totalItems} / {MEALS_PER_WEEK} meals
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
                      disabled={totalItems >= MEALS_PER_WEEK}
                      className="stepper-btn disabled:opacity-40 disabled:cursor-not-allowed"
                      style={totalItems >= MEALS_PER_WEEK ? undefined : { backgroundColor: "#22c55e" }}
                      onMouseEnter={(e) => { if (totalItems < MEALS_PER_WEEK) e.currentTarget.style.backgroundColor = "#16a34a"; }}
                      onMouseLeave={(e) => { if (totalItems < MEALS_PER_WEEK) e.currentTarget.style.backgroundColor = "#22c55e"; }}
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

// ─── Added add-ons (onetime line items) ───────────────────────────────────────

function AddedAddOns({ items, addonProducts }: { items: ChargeLineItem[]; addonProducts: AddonProduct[] }) {
  if (items.length === 0) return null;

  const imageByVariantId = Object.fromEntries(
    addonProducts.filter((p) => p.imageUrl).map((p) => [p.externalVariantId, p.imageUrl])
  );

  return (
    <div className="mt-8">
      <div className="flex items-center gap-2 mb-4">
        <div className="w-8 h-8 rounded-full bg-purple-50 flex items-center justify-center">
          <svg className="w-4 h-4 text-purple-600" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M10 2a4 4 0 00-4 4v1H5a1 1 0 00-.994.89l-1 9A1 1 0 004 18h12a1 1 0 00.994-1.11l-1-9A1 1 0 0015 7h-1V6a4 4 0 00-4-4zm2 5V6a2 2 0 10-4 0v1h4zm-6 3a1 1 0 112 0 1 1 0 01-2 0zm7-1a1 1 0 100 2 1 1 0 000-2z" clipRule="evenodd" />
          </svg>
        </div>
        <h3 className="font-display text-lg font-bold text-stone-900">Your Add-Ons</h3>
        <span className="text-xs font-semibold bg-purple-100 text-purple-700 px-2 py-0.5 rounded-full">
          {items.length}
        </span>
      </div>

      <div className="card divide-y divide-stone-100 overflow-hidden">
        {items.map((item) => (
          <AddedAddonRow key={item.purchase_item_id} item={item} imageByVariantId={imageByVariantId} />
        ))}
      </div>
    </div>
  );
}

function AddedAddonRow({ item, imageByVariantId }: { item: ChargeLineItem; imageByVariantId: Record<string, string | null> }) {
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
      { intent: "remove_addon", onetimeId: String(item.purchase_item_id) },
      { method: "post" }
    );
  };

  const variantId = item.external_variant_id?.ecommerce ?? null;
  const imageUrl =
    item.images?.medium ?? item.images?.small ?? item.images?.original
    ?? (variantId ? imageByVariantId[variantId] : null)
    ?? null;

  return (
    <div className={`flex items-center gap-4 px-4 py-3 transition-opacity ${isRemoving ? "opacity-40" : ""}`}>
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
        <p className="text-sm font-semibold text-stone-800 truncate">{item.title}</p>
        {item.variant_title && item.variant_title !== "Default Title" && (
          <p className="text-xs text-stone-400 truncate">{item.variant_title}</p>
        )}
        {removeError && (
          <p className="text-xs text-red-600 mt-0.5">{removeError}</p>
        )}
      </div>

      <div className="flex items-center gap-1 flex-none">
        {item.quantity > 1 && (
          <span className="text-xs text-stone-400 mr-1">x{item.quantity}</span>
        )}
        <span className="text-sm font-bold text-stone-900">{formatCurrency(item.total_price)}</span>
      </div>

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
    </div>
  );
}

// ─── Add-ons carousel ─────────────────────────────────────────────────────────

function AddOnsCarousel({
  products,
  addressId,
  scheduledAt,
}: {
  products: AddonProduct[];
  addressId: number;
  scheduledAt: string;
}) {
  if (products.length === 0) return null;

  return (
    <div className="mt-8">
      <div className="flex items-center gap-2 mb-4">
        <div className="w-8 h-8 rounded-full bg-amber-50 flex items-center justify-center">
          <svg className="w-4 h-4 text-amber-600" viewBox="0 0 20 20" fill="currentColor">
            <path d="M10 3a1 1 0 011 1v5h5a1 1 0 110 2h-5v5a1 1 0 11-2 0v-5H4a1 1 0 110-2h5V4a1 1 0 011-1z" />
          </svg>
        </div>
        <h3 className="font-display text-lg font-bold text-stone-900">Add Something Extra</h3>
      </div>

      <div className="flex gap-4 overflow-x-auto pb-4 snap-x snap-mandatory scrollbar-hide -mx-1 px-1">
        {products.map((product) => (
          <AddOnCard
            key={product.externalVariantId}
            product={product}
            addressId={addressId}
            scheduledAt={scheduledAt}
          />
        ))}
      </div>
    </div>
  );
}

function AddOnCard({
  product,
  addressId,
  scheduledAt,
}: {
  product: AddonProduct;
  addressId: number;
  scheduledAt: string;
}) {
  const fetcher = useFetcher<typeof action>();
  const isAdding = fetcher.state !== "idle";
  const fetcherData = fetcher.data as
    | { success: true; intent: "add_addon" }
    | { error: string; intent: "add_addon" }
    | undefined;
  const wasAdded = fetcher.state === "idle" && fetcherData != null && "success" in fetcherData;
  const addError = fetcher.state === "idle" && fetcherData != null && "error" in fetcherData
    ? (fetcherData as { error: string }).error
    : null;

  const handleAdd = () => {
    fetcher.submit(
      {
        intent: "add_addon",
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
    <div className="card flex flex-col flex-none w-44 sm:w-48 snap-start overflow-hidden transition-all duration-200 hover:-translate-y-0.5">
      <div className="relative aspect-square bg-stone-50 overflow-hidden flex-none">
        {product.imageUrl ? (
          <img
            src={product.imageUrl}
            alt={product.title}
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-stone-50 to-stone-100">
            <svg className="w-10 h-10 text-stone-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
          </div>
        )}
      </div>

      <div className="flex flex-col flex-1 p-3 text-center">
        <h4 className="text-sm font-semibold text-stone-800 leading-tight line-clamp-2">
          {product.title}
        </h4>
        {product.variantTitle && product.variantTitle !== "Default Title" && (
          <p className="text-xs text-stone-400 line-clamp-1 mt-1">{product.variantTitle}</p>
        )}
        <p className="text-sm font-bold text-stone-900 mt-1">
          {formatCurrency(product.price)}
        </p>

        <div className="mt-auto pt-2">
        {wasAdded ? (
          <div className="flex items-center justify-center gap-1 py-2">
            <svg className="w-4 h-4 animate-check-pop" style={{ color: "#22c55e" }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
            <span className="text-sm font-medium" style={{ color: "#16a34a" }}>Added!</span>
          </div>
        ) : addError ? (
          <div className="space-y-1">
            <p className="text-xs text-red-600 line-clamp-2">{addError}</p>
            <button
              onClick={handleAdd}
              className="w-full py-2 text-sm font-semibold text-white rounded-lg transition-colors"
              style={{ backgroundColor: "#22c55e" }}
              onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = "#16a34a"; }}
              onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = "#22c55e"; }}
            >
              Retry
            </button>
          </div>
        ) : (
          <button
            onClick={handleAdd}
            disabled={isAdding}
            className="w-full py-2 text-sm font-semibold text-white rounded-lg transition-colors disabled:opacity-50"
            style={{ backgroundColor: "#22c55e" }}
            onMouseEnter={(e) => { if (!isAdding) e.currentTarget.style.backgroundColor = "#16a34a"; }}
            onMouseLeave={(e) => { if (!isAdding) e.currentTarget.style.backgroundColor = "#22c55e"; }}
          >
            {isAdding ? (
              <span className="flex items-center justify-center gap-1.5">
                <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Adding...
              </span>
            ) : (
              "Add to Order"
            )}
          </button>
        )}
        </div>
      </div>
    </div>
  );
}

// ─── Simple charge list (for charges without bundles) ─────────────────────────

function ChargesListSimple({ charges, subscriptions, deliveryDateOffset }: { charges: Charge[]; subscriptions: Subscription[]; deliveryDateOffset: number }) {
  return (
    <div className="card overflow-hidden">
      <div className="px-5 py-4 border-b border-stone-100">
        <h2 className="font-display font-semibold text-stone-900">Upcoming Deliveries</h2>
      </div>
      <div className="divide-y divide-stone-100">
        {charges.map((charge) => (
          <SimpleChargeRow key={charge.id} charge={charge} subscriptions={subscriptions} deliveryDateOffset={deliveryDateOffset} />
        ))}
      </div>
    </div>
  );
}

function SimpleChargeRow({ charge, subscriptions, deliveryDateOffset }: { charge: Charge; subscriptions: Subscription[]; deliveryDateOffset: number }) {
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
        <p className="text-sm font-semibold text-stone-800">{formatDate(addDaysToDate(charge.scheduled_at, deliveryDateOffset))}</p>
        <p className="text-xs text-stone-400">Charged on {formatDate(charge.scheduled_at)}</p>
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
