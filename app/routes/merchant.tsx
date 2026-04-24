import type { ActionFunctionArgs, MetaFunction } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Link, useFetcher, useLoaderData } from "@remix-run/react";
import { useEffect, useRef, useState } from "react";
import {
  getUpcomingWeekStarts,
  getWeeklyDefaults,
  saveWeeklyDefault,
} from "~/lib/bundle-defaults.server";
import {
  createBundleSelection,
  getBundleCollectionsFromShopify,
  getBundleSelections,
  listBundleSubscriptionIds,
  listQueuedChargesForWeek,
  updateBundleSelection,
} from "~/lib/recharge.server";
import {
  filterCollectionsForWeek,
  getCollectionsWithAvailability,
} from "~/lib/shopify.server";
import type { BundleCollection, BundleItemPayload } from "~/lib/types";

export const meta: MetaFunction = () => [{ title: "Merchant Portal — Bundle Defaults" }];

type ApplyChargeResult = {
  chargeId: number;
  status: "success" | "created" | "error";
  error?: string;
};

// ─── Loader ───────────────────────────────────────────────────────────────────

export async function loader() {
  const weekStarts = getUpcomingWeekStarts();

  const [collectionsWithAvailability, defaults] = await Promise.all([
    getCollectionsWithAvailability(),
    Promise.resolve(getWeeklyDefaults()),
  ]);

  const eligiblePerWeek = weekStarts.map((w) => ({
    weekStart: w,
    eligible: filterCollectionsForWeek(collectionsWithAvailability, w),
  }));

  // Fetch products once for the deduplicated set of eligible collection IDs
  const uniqueIds = [
    ...new Set(eligiblePerWeek.flatMap((w) => w.eligible.map((c) => String(c.id)))),
  ];
  const bundleCollections = await getBundleCollectionsFromShopify(uniqueIds);
  const bundleCollectionMap = Object.fromEntries(bundleCollections.map((c) => [c.id, c]));

  // Distribute per week, merging real Shopify titles
  const collectionsPerWeek = Object.fromEntries(
    eligiblePerWeek.map(({ weekStart, eligible }) => [
      weekStart,
      eligible
        .map((c) => {
          const bc = bundleCollectionMap[String(c.id)];
          return bc
            ? {
                ...bc,
                title: c.title,
                availableFrom: c.availableFrom?.toISOString().slice(0, 10) ?? null,
                availableUntil: c.availableUntil?.toISOString().slice(0, 10) ?? null,
              }
            : null;
        })
        .filter((c): c is NonNullable<typeof c> => c !== null),
    ])
  );

  return json({ weekStarts, collectionsPerWeek, defaults });
}

// ─── Action ───────────────────────────────────────────────────────────────────

export async function action({ request }: ActionFunctionArgs) {
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "save_defaults") {
    const weekStart = formData.get("weekStart");
    const rawItems = formData.get("items");
    if (typeof weekStart !== "string" || typeof rawItems !== "string") {
      return json({ error: "Invalid payload" }, { status: 400 });
    }
    try {
      const items = JSON.parse(rawItems) as BundleItemPayload[];
      saveWeeklyDefault(weekStart, items);
      return json({ success: true, weekStart } as const);
    } catch {
      return json({ error: "Failed to save defaults" }, { status: 500 });
    }
  }

  if (intent === "apply_defaults") {
    const weekStart = formData.get("weekStart");
    if (typeof weekStart !== "string") {
      return json({ error: "Invalid payload" }, { status: 400 });
    }
    const allDefaults = getWeeklyDefaults();
    const items = allDefaults[weekStart];
    if (!items?.length) {
      return json({ error: "No defaults saved for this week" }, { status: 400 });
    }
    try {
      const [bundleSubIds, charges] = await Promise.all([
        listBundleSubscriptionIds(),
        listQueuedChargesForWeek(weekStart),
      ]);
      const bundleCharges = charges.filter((charge) =>
        charge.line_items.some((li) => bundleSubIds.has(li.purchase_item_id))
      );
      const results: ApplyChargeResult[] = await Promise.all(
        bundleCharges.map(async (charge) => {
          const bundlePurchaseItemId = charge.line_items.find(
            (li) => bundleSubIds.has(li.purchase_item_id)
          )!.purchase_item_id;
          try {
            const selections = await getBundleSelections(charge.id);
            if (selections.length === 0) {
              await createBundleSelection(charge.id, bundlePurchaseItemId, items);
              return { chargeId: charge.id, status: "created" as const };
            }
            await Promise.all(selections.map((sel) => updateBundleSelection(sel.id, items)));
            return { chargeId: charge.id, status: "success" as const };
          } catch (err) {
            return {
              chargeId: charge.id,
              status: "error" as const,
              error: err instanceof Error ? err.message : "Unknown error",
            };
          }
        })
      );
      return json({
        type: "apply_result" as const,
        weekStart,
        totalCharges: charges.length,
        results,
      });
    } catch (err) {
      return json(
        { error: err instanceof Error ? err.message : "Failed to apply defaults" },
        { status: 500 }
      );
    }
  }

  return json({ error: "Unknown intent" }, { status: 400 });
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function MerchantPage() {
  const { weekStarts, collectionsPerWeek, defaults } = useLoaderData<typeof loader>();
  const [activeWeek, setActiveWeek] = useState(weekStarts[0]);

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200 sticky top-0 z-10">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 bg-indigo-600 rounded-lg flex items-center justify-center flex-none">
              <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10" />
              </svg>
            </div>
            <span className="text-sm font-semibold text-gray-900">Merchant Portal</span>
            <span className="text-xs bg-amber-100 text-amber-700 font-medium px-1.5 py-0.5 rounded">Demo</span>
          </div>
          <Link
            to="/"
            className="text-xs text-gray-500 hover:text-gray-800 transition-colors"
          >
            Customer portal →
          </Link>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 sm:px-6 py-8 space-y-6">
        <div>
          <h1 className="text-lg font-semibold text-gray-900">Default Bundle Selections</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Configure the default bundle items for each upcoming week's orders.
          </p>
        </div>

        {/* Week tabs */}
        <div className="flex gap-1 bg-gray-100 p-1 rounded-xl">
          {weekStarts.map((week) => (
            <button
              key={week}
              onClick={() => setActiveWeek(week)}
              className={`flex-1 text-sm font-medium py-1.5 px-2 rounded-lg transition-colors ${
                activeWeek === week
                  ? "bg-white text-gray-900 shadow-sm"
                  : "text-gray-500 hover:text-gray-800"
              }`}
            >
              {formatTabLabel(week)}
            </button>
          ))}
        </div>

        {/* Active week editor */}
        {weekStarts.map((week) =>
          week === activeWeek ? (
            <WeekEditor
              key={week}
              weekStart={week}
              collections={collectionsPerWeek[week] ?? []}
              savedSelections={defaults[week] ?? []}
            />
          ) : null
        )}
      </main>
    </div>
  );
}

// ─── Date helpers ─────────────────────────────────────────────────────────────

function formatTabLabel(weekStart: string): string {
  const d = new Date(weekStart + "T00:00:00");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function formatWeekRangeLabel(weekStart: string): string {
  const start = new Date(weekStart + "T00:00:00");
  const end = new Date(weekStart + "T00:00:00");
  end.setDate(start.getDate() + 6);
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
  return `${start.toLocaleDateString("en-US", opts)} – ${end.toLocaleDateString("en-US", opts)}`;
}

// ─── Week editor ──────────────────────────────────────────────────────────────

type CollectionWithDates = BundleCollection & {
  availableFrom: string | null;
  availableUntil: string | null;
};

function formatDateRange(from: string | null, until: string | null): string {
  const fmt = (d: string) =>
    new Date(d + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" });
  if (from && until) return `${fmt(from)} – ${fmt(until)}`;
  if (from) return `From ${fmt(from)}`;
  if (until) return `Until ${fmt(until)}`;
  return "";
}

type EditableItem = {
  collection_id: string;
  collection_source: "shopify";
  external_product_id: string;
  external_variant_id: string;
  quantity: number;
  productTitle: string;
  variantTitle: string;
  imageUrl: string | null;
};

function buildItems(
  collections: BundleCollection[],
  savedSelections: BundleItemPayload[]
): EditableItem[] {
  const savedQty: Record<string, number> = {};
  for (const s of savedSelections) {
    savedQty[s.external_variant_id] = s.quantity;
  }

  const seen = new Set<string>();
  const result: EditableItem[] = [];

  for (const collection of collections) {
    for (const product of collection.products) {
      for (const variant of product.variants) {
        const vid = String(variant.id);
        if (seen.has(vid)) continue;
        seen.add(vid);
        result.push({
          collection_id: collection.id,
          collection_source: "shopify",
          external_product_id: product.external_product_id,
          external_variant_id: vid,
          quantity: savedQty[vid] ?? 0,
          productTitle: product.title,
          variantTitle: variant.title,
          imageUrl: product.image_url ?? null,
        });
      }
    }
  }

  return result;
}

function WeekEditor({
  weekStart,
  collections,
  savedSelections,
}: {
  weekStart: string;
  collections: CollectionWithDates[];
  savedSelections: BundleItemPayload[];
}) {
  const fetcher = useFetcher<typeof action>();
  const applyFetcher = useFetcher<typeof action>();
  const [items, setItems] = useState<EditableItem[]>(() =>
    buildItems(collections, savedSelections)
  );
  const [savedQty, setSavedQty] = useState<Record<string, number>>(
    () => Object.fromEntries(savedSelections.map((s) => [s.external_variant_id, s.quantity]))
  );
  const [applyConfirming, setApplyConfirming] = useState(false);
  const submittedRef = useRef<Record<string, number>>({});

  const isSaving = fetcher.state !== "idle";
  const isApplying = applyFetcher.state !== "idle";
  const fetcherData = fetcher.data as
    | { success: true; weekStart: string }
    | { error: string }
    | undefined;
  const savedOk = fetcher.state === "idle" && fetcherData != null && "success" in fetcherData;
  const fetcherError =
    fetcher.state === "idle" && fetcherData != null && "error" in fetcherData
      ? fetcherData.error
      : null;

  const applyData = applyFetcher.data;
  const applyResult =
    applyFetcher.state === "idle" &&
    applyData != null &&
    "type" in applyData &&
    applyData.type === "apply_result"
      ? (applyData as { type: "apply_result"; weekStart: string; totalCharges: number; results: ApplyChargeResult[] })
      : null;
  const applyError =
    applyFetcher.state === "idle" &&
    applyData != null &&
    "error" in applyData
      ? (applyData as { error: string }).error
      : null;

  const hasDefaults = savedSelections.length > 0;
  const hasChanges = items.some(
    (item) => (savedQty[item.external_variant_id] ?? 0) !== item.quantity
  );
  const totalSelected = items.reduce((sum, item) => sum + item.quantity, 0);

  useEffect(() => {
    if (savedOk) setSavedQty(submittedRef.current);
  }, [savedOk]);

  useEffect(() => {
    if (isApplying) setApplyConfirming(false);
  }, [isApplying]);

  const adjustQty = (index: number, delta: number) => {
    setItems((prev) =>
      prev.map((item, i) =>
        i === index ? { ...item, quantity: Math.max(0, item.quantity + delta) } : item
      )
    );
  };

  const handleSave = () => {
    submittedRef.current = Object.fromEntries(
      items.map((i) => [i.external_variant_id, i.quantity])
    );
    const payload: BundleItemPayload[] = items
      .filter((i) => i.quantity > 0)
      .map(({ collection_id, collection_source, external_product_id, external_variant_id, quantity }) => ({
        collection_id,
        collection_source,
        external_product_id,
        external_variant_id,
        quantity,
      }));
    fetcher.submit(
      { intent: "save_defaults", weekStart, items: JSON.stringify(payload) },
      { method: "post" }
    );
  };

  const handleApply = () => {
    applyFetcher.submit(
      { intent: "apply_defaults", weekStart },
      { method: "post" }
    );
  };

  // Group items by collection for display
  const grouped = collections
    .map((c) => ({
      collection: c,
      label: c.title,
      items: items.filter((item) => item.collection_id === c.id),
    }))
    .filter((g) => g.items.length > 0);

  return (
    <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
      {/* Error banner */}
      {fetcherError && (
        <div className="mx-4 mt-4 rounded-xl bg-red-50 border border-red-200 px-4 py-3">
          <p className="text-sm text-red-800">{fetcherError}</p>
        </div>
      )}

      {/* Header */}
      <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between gap-4">
        <div>
          <h2 className="font-semibold text-gray-900">
            Week of {formatWeekRangeLabel(weekStart)}
          </h2>
          <p className="text-sm text-gray-400 mt-0.5">
            {totalSelected} item{totalSelected !== 1 ? "s" : ""} selected
          </p>
        </div>
        {savedOk && (
          <span className="text-green-600 text-xs font-medium flex items-center gap-1 flex-none">
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
            Saved
          </span>
        )}
      </div>

      {/* Collections */}
      {grouped.length === 0 ? (
        <div className="px-5 py-8 text-center text-sm text-gray-400">
          No products found in the configured collections.
        </div>
      ) : (
        <div className="divide-y divide-gray-50">
          {grouped.map(({ collection, label, items: groupItems }) => (
            <div key={collection.id}>
              <div className="px-5 py-2 bg-gray-50">
                <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">
                  {label}
                </p>
                {(collection.availableFrom || collection.availableUntil) && (
                  <p className="text-xs text-gray-400 mt-0.5">
                    {formatDateRange(collection.availableFrom, collection.availableUntil)}
                  </p>
                )}
              </div>
              {groupItems.map((item) => {
                const index = items.indexOf(item);
                return (
                  <div
                    key={item.external_variant_id}
                    className={`px-5 py-3.5 flex items-center gap-4 hover:bg-gray-50/60 transition-colors ${
                      item.quantity === 0 ? "opacity-50" : ""
                    }`}
                  >
                    {item.imageUrl ? (
                      <img
                        src={item.imageUrl}
                        alt={item.productTitle}
                        className="w-10 h-10 rounded-lg object-cover flex-none bg-gray-100"
                      />
                    ) : (
                      <div className="w-10 h-10 rounded-lg bg-gray-100 flex-none" />
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-800">{item.productTitle}</p>
                      {item.variantTitle && item.variantTitle !== "Default Title" && (
                        <p className="text-xs text-gray-400 mt-0.5">{item.variantTitle}</p>
                      )}
                    </div>
                    <div className="flex-none flex items-center gap-2">
                      <button
                        onClick={() => adjustQty(index, -1)}
                        disabled={item.quantity <= 0}
                        aria-label="Decrease quantity"
                        className="w-7 h-7 rounded-full border border-gray-200 hover:border-gray-300 hover:bg-gray-50 flex items-center justify-center text-gray-500 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                      >
                        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 12H4" />
                        </svg>
                      </button>
                      <span className="w-6 text-center text-sm font-semibold text-gray-900 tabular-nums">
                        {item.quantity}
                      </span>
                      <button
                        onClick={() => adjustQty(index, 1)}
                        aria-label="Increase quantity"
                        className="w-7 h-7 rounded-full border border-gray-200 hover:border-gray-300 hover:bg-gray-50 flex items-center justify-center text-gray-500 transition-colors"
                      >
                        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v12M6 12h12" />
                        </svg>
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}

      {/* Apply results panel */}
      {(applyResult || applyError) && (
        <div className="border-t border-gray-100 px-5 py-4 space-y-2">
          {applyError && (
            <p className="text-sm text-red-700 font-medium">{applyError}</p>
          )}
          {applyResult && (() => {
            const appliedCount = applyResult.results.filter((r) => r.status === "success" || r.status === "created").length;
            const createdCount = applyResult.results.filter((r) => r.status === "created").length;
            return (
              <>
                {applyResult.totalCharges === 0 ? (
                  <p className="text-sm text-gray-500">No queued charges found for this week.</p>
                ) : applyResult.results.length === 0 ? (
                  <p className="text-sm text-gray-500">
                    No bundle subscription charges found among {applyResult.totalCharges} queued charge{applyResult.totalCharges !== 1 ? "s" : ""} this week.
                  </p>
                ) : (
                  <>
                    <p className="text-sm font-medium text-gray-800">
                      Applied to {appliedCount} of {applyResult.results.length} eligible charge{applyResult.results.length !== 1 ? "s" : ""}
                      {createdCount > 0 && (
                        <span className="text-gray-400 font-normal"> · {createdCount} created</span>
                      )}
                    </p>
                    <ul className="space-y-1.5 mt-1">
                      {applyResult.results.map((r) => (
                        <li key={r.chargeId} className="flex items-start gap-2 text-sm">
                          {(r.status === "success" || r.status === "created") && (
                            <svg className="w-3.5 h-3.5 text-green-600 mt-0.5 flex-none" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                            </svg>
                          )}
                          {r.status === "error" && (
                            <svg className="w-3.5 h-3.5 text-red-500 mt-0.5 flex-none" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                            </svg>
                          )}
                          <span className={r.status === "error" ? "text-red-700" : "text-gray-600"}>
                            Charge #{r.chargeId}
                            {r.status === "created" && " — created"}
                            {r.status === "error" && r.error && ` — ${r.error}`}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </>
            );
          })()}
        </div>
      )}

      {/* Footer */}
      <div className="px-5 py-3 border-t border-gray-100 flex items-center justify-between gap-4">
        {/* Left: Apply button / confirmation / spinner */}
        <div className="flex items-center gap-2">
          {isApplying ? (
            <span className="text-sm text-gray-500 flex items-center gap-1.5">
              <svg className="animate-spin w-3.5 h-3.5" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
              </svg>
              Applying…
            </span>
          ) : applyConfirming ? (
            <>
              <span className="text-sm text-gray-600">Apply saved defaults to all queued charges this week?</span>
              <button
                onClick={() => setApplyConfirming(false)}
                className="text-xs text-gray-500 hover:text-gray-800 px-2.5 py-1.5 rounded-lg border border-gray-200 hover:border-gray-300 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleApply}
                className="text-xs font-medium bg-indigo-600 hover:bg-indigo-700 text-white px-2.5 py-1.5 rounded-lg transition-colors"
              >
                Confirm
              </button>
            </>
          ) : (
            <button
              onClick={() => setApplyConfirming(true)}
              disabled={!hasDefaults}
              title={!hasDefaults ? "Save defaults first to enable" : undefined}
              className="text-sm font-medium text-indigo-600 hover:text-indigo-800 border border-indigo-200 hover:border-indigo-400 px-4 py-2 rounded-xl transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Apply to all charges
            </button>
          )}
        </div>

        {/* Right: Save defaults */}
        <button
          onClick={handleSave}
          disabled={isSaving || !hasChanges || isApplying}
          className="text-sm font-medium bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-xl transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {isSaving ? "Saving…" : "Save defaults"}
        </button>
      </div>
    </div>
  );
}
