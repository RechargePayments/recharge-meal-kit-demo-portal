import type { ActionFunctionArgs, MetaFunction } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Link, useFetcher, useLoaderData } from "@remix-run/react";
import { useEffect, useState } from "react";
import {
  getAllWeeklyConfigs,
  getUpcomingWeekStarts,
  getWeeklyConfig,
  saveWeeklyConfig,
} from "~/lib/bundle-defaults.server";
import {
  getAllCustomerPreferences,
} from "~/lib/customer-preferences.server";
import {
  computePersonalizedSelection,
  type SortedProduct,
} from "~/lib/personalize-defaults.server";
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
import {
  getAllWeekAssignments,
  saveWeekAssignments,
  getWeekAssignments,
} from "~/lib/week-assignments.server";
import {
  getDeliveryDateOffset,
  saveDeliveryDateOffset,
} from "~/lib/merchant-settings.server";
import type { BundleCollection } from "~/lib/types";

export const meta: MetaFunction = () => [{ title: "Merchant Portal — Weekly Collections" }];

type ApplyChargeResult = {
  chargeId: number;
  customerId: number | null;
  status: "success" | "created" | "error";
  error?: string;
};

type ViewMode = "assign" | "sort-order";

// ─── Loader ───────────────────────────────────────────────────────────────────

export async function loader() {
  const weekStarts = getUpcomingWeekStarts();

  const [collectionsWithAvailability, configs, allAssignments] = await Promise.all([
    getCollectionsWithAvailability(),
    Promise.resolve(getAllWeeklyConfigs()),
    Promise.resolve(getAllWeekAssignments()),
  ]);

  const allCollections = collectionsWithAvailability.map((c) => ({
    id: String(c.id),
    title: c.title,
    handle: c.handle,
    availableFrom: c.availableFrom?.toISOString().slice(0, 10) ?? null,
    availableUntil: c.availableUntil?.toISOString().slice(0, 10) ?? null,
  }));

  const assignedPerWeek: Record<string, string[]> = {};
  for (const w of weekStarts) {
    const saved = allAssignments[w];
    if (saved) {
      assignedPerWeek[w] = saved;
    } else {
      const eligible = filterCollectionsForWeek(collectionsWithAvailability, w);
      assignedPerWeek[w] = eligible.map((c) => String(c.id));
    }
  }

  const uniqueIds = [...new Set(Object.values(assignedPerWeek).flat())];
  const bundleCollections = await getBundleCollectionsFromShopify(uniqueIds, { sorted: true });
  const bundleCollectionMap = Object.fromEntries(bundleCollections.map((c) => [c.id, c]));

  const collectionsPerWeek = Object.fromEntries(
    weekStarts.map((w) => [
      w,
      (assignedPerWeek[w] ?? [])
        .map((id) => {
          const bc = bundleCollectionMap[id];
          const meta = allCollections.find((c) => c.id === id);
          return bc
            ? {
                ...bc,
                title: meta?.title ?? bc.title,
                availableFrom: meta?.availableFrom ?? null,
                availableUntil: meta?.availableUntil ?? null,
              }
            : null;
        })
        .filter((c): c is NonNullable<typeof c> => c !== null),
    ])
  );

  const deliveryDateOffset = getDeliveryDateOffset();

  return json({
    weekStarts,
    allCollections,
    assignedPerWeek,
    collectionsPerWeek,
    configs,
    deliveryDateOffset,
  });
}

// ─── Action ───────────────────────────────────────────────────────────────────

export async function action({ request }: ActionFunctionArgs) {
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "save_assignments") {
    const weekStart = formData.get("weekStart");
    const rawIds = formData.get("collectionIds");
    if (typeof weekStart !== "string" || typeof rawIds !== "string") {
      return json({ error: "Invalid payload" }, { status: 400 });
    }
    const collectionIds = rawIds ? rawIds.split(",").filter(Boolean) : [];
    saveWeekAssignments(weekStart, collectionIds);
    return json({ success: true, intent: "save_assignments" as const, weekStart });
  }

  if (intent === "save_config") {
    const weekStart = formData.get("weekStart");
    const rawQty = formData.get("targetQuantity");
    if (typeof weekStart !== "string" || typeof rawQty !== "string") {
      return json({ error: "Invalid payload" }, { status: 400 });
    }
    const targetQuantity = 5;
    saveWeeklyConfig(weekStart, { targetQuantity });
    return json({ success: true, intent: "save_config" as const, weekStart });
  }

  if (intent === "apply_defaults") {
    const weekStart = formData.get("weekStart");
    if (typeof weekStart !== "string") {
      return json({ error: "Invalid payload" }, { status: 400 });
    }

    const { targetQuantity } = getWeeklyConfig(weekStart);

    try {
      const saved = getWeekAssignments(weekStart);
      let collectionIds: string[];
      if (saved) {
        collectionIds = saved;
      } else {
        const collectionsWithAvailability = await getCollectionsWithAvailability();
        const eligible = filterCollectionsForWeek(collectionsWithAvailability, weekStart);
        collectionIds = eligible.map((c) => String(c.id));
      }

      const [bundleCollections, allPreferences, bundleSubIds, charges] = await Promise.all([
        getBundleCollectionsFromShopify(collectionIds, { sorted: true }),
        Promise.resolve(getAllCustomerPreferences()),
        listBundleSubscriptionIds(),
        listQueuedChargesForWeek(weekStart),
      ]);

      const sortedProducts: SortedProduct[] = bundleCollections.flatMap((col) =>
        col.products.flatMap((p) =>
          p.variants.map((v) => ({
            collection_id: col.id,
            external_product_id: p.external_product_id,
            external_variant_id: String(v.id),
            tags: p.tags ?? [],
          }))
        )
      );

      if (sortedProducts.length === 0) {
        return json({ error: "No products found in eligible collections" }, { status: 400 });
      }

      const bundleCharges = charges.filter((charge) =>
        charge.line_items.some((li) => bundleSubIds.has(li.purchase_item_id))
      );

      const results: ApplyChargeResult[] = await Promise.all(
        bundleCharges.map(async (charge) => {
          const bundlePurchaseItemId = charge.line_items.find(
            (li) => bundleSubIds.has(li.purchase_item_id)
          )!.purchase_item_id;
          const customerId = charge.customer?.id ? String(charge.customer.id) : null;
          const preferences = customerId ? (allPreferences[customerId] ?? null) : null;
          const items = computePersonalizedSelection(sortedProducts, targetQuantity, preferences);

          try {
            const selections = await getBundleSelections(charge.id);
            if (selections.length === 0) {
              await createBundleSelection(charge.id, bundlePurchaseItemId, items);
              return { chargeId: charge.id, customerId: charge.customer?.id ?? null, status: "created" as const };
            }
            await Promise.all(selections.map((sel) => updateBundleSelection(sel.id, items)));
            return { chargeId: charge.id, customerId: charge.customer?.id ?? null, status: "success" as const };
          } catch (err) {
            return {
              chargeId: charge.id,
              customerId: charge.customer?.id ?? null,
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

  if (intent === "save_delivery_offset") {
    const rawOffset = formData.get("deliveryDateOffset");
    if (typeof rawOffset !== "string") {
      return json({ error: "Invalid payload" }, { status: 400 });
    }
    const offset = parseInt(rawOffset, 10);
    if (isNaN(offset) || offset < 1 || offset > 6) {
      return json({ error: "Offset must be between 1 and 6" }, { status: 400 });
    }
    saveDeliveryDateOffset(offset);
    return json({ success: true, intent: "save_delivery_offset" as const });
  }

  return json({ error: "Unknown intent" }, { status: 400 });
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function MerchantPage() {
  const { weekStarts, allCollections, assignedPerWeek, collectionsPerWeek, configs, deliveryDateOffset } =
    useLoaderData<typeof loader>();
  const [activeWeek, setActiveWeek] = useState(weekStarts[0]);
  const [activeView, setActiveView] = useState<ViewMode>("assign");

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
          <h1 className="text-lg font-semibold text-gray-900">Weekly Collection Manager</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Assign collections to upcoming weeks, then review sort order and apply personalized defaults.
          </p>
        </div>

        <DeliveryOffsetPanel savedOffset={deliveryDateOffset} />

        {/* View navigation */}
        <div className="flex border-b border-gray-200">
          <button
            onClick={() => setActiveView("assign")}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
              activeView === "assign"
                ? "border-indigo-600 text-indigo-600"
                : "border-transparent text-gray-500 hover:text-gray-800 hover:border-gray-300"
            }`}
          >
            Assign Collections
          </button>
          <button
            onClick={() => setActiveView("sort-order")}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
              activeView === "sort-order"
                ? "border-indigo-600 text-indigo-600"
                : "border-transparent text-gray-500 hover:text-gray-800 hover:border-gray-300"
            }`}
          >
            Sort Order & Defaults
          </button>
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

        {/* Active view content */}
        {activeView === "assign" &&
          weekStarts.map((week) =>
            week === activeWeek ? (
              <AssignPanel
                key={week}
                weekStart={week}
                allCollections={allCollections}
                assignedIds={assignedPerWeek[week] ?? []}
              />
            ) : null
          )}

        {activeView === "sort-order" &&
          weekStarts.map((week) =>
            week === activeWeek ? (
              <WeekPanel
                key={week}
                weekStart={week}
                collections={collectionsPerWeek[week] ?? []}
                savedConfig={configs[week] ?? null}
              />
            ) : null
          )}
      </main>
    </div>
  );
}

// ─── Delivery offset panel ────────────────────────────────────────────────────

function DeliveryOffsetPanel({ savedOffset }: { savedOffset: number }) {
  const fetcher = useFetcher<typeof action>();
  const [offset, setOffset] = useState(savedOffset);

  const isSaving = fetcher.state !== "idle";
  const fetcherData = fetcher.data as
    | { success: true; intent: "save_delivery_offset" }
    | { error: string }
    | undefined;
  const savedOk = fetcher.state === "idle" && fetcherData != null && "success" in fetcherData;
  const hasChanges = offset !== savedOffset;

  useEffect(() => {
    setOffset(savedOffset);
  }, [savedOffset]);

  const handleSave = () => {
    fetcher.submit(
      { intent: "save_delivery_offset", deliveryDateOffset: String(offset) },
      { method: "post" }
    );
  };

  return (
    <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
      <div className="px-5 py-4 flex items-center justify-between gap-4">
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <svg className="w-4 h-4 text-indigo-500 flex-none" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
            <h2 className="font-semibold text-gray-900">Delivery Date Offset</h2>
          </div>
          <p className="text-sm text-gray-400 mt-0.5">
            Days between when the customer is charged and when the meal kit is delivered.
          </p>
        </div>

        <div className="flex items-center gap-3 flex-none">
          {savedOk && !hasChanges && (
            <span className="text-green-600 text-xs font-medium flex items-center gap-1">
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              Saved
            </span>
          )}

          <select
            value={offset}
            onChange={(e) => setOffset(Number(e.target.value))}
            className="text-sm font-semibold text-gray-900 bg-gray-100 border border-gray-200 rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
          >
            {[1, 2, 3, 4, 5, 6].map((n) => (
              <option key={n} value={n}>
                {n} day{n !== 1 ? "s" : ""}
              </option>
            ))}
          </select>

          <button
            onClick={handleSave}
            disabled={isSaving || !hasChanges}
            className="text-sm font-medium bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-xl transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {isSaving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
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

// ─── Assign panel ─────────────────────────────────────────────────────────────

type SimpleCollection = {
  id: string;
  title: string;
  handle: string;
  availableFrom: string | null;
  availableUntil: string | null;
};

function AssignPanel({
  weekStart,
  allCollections,
  assignedIds,
}: {
  weekStart: string;
  allCollections: SimpleCollection[];
  assignedIds: string[];
}) {
  const fetcher = useFetcher<typeof action>();
  const [selected, setSelected] = useState<Set<string>>(() => new Set(assignedIds));

  const isSaving = fetcher.state !== "idle";
  const fetcherData = fetcher.data as
    | { success: true; intent: "save_assignments"; weekStart: string }
    | { error: string }
    | undefined;
  const savedOk = fetcher.state === "idle" && fetcherData != null && "success" in fetcherData;
  const saveError =
    fetcher.state === "idle" && fetcherData != null && "error" in fetcherData
      ? (fetcherData as { error: string }).error
      : null;

  const hasChanges =
    selected.size !== assignedIds.length ||
    [...selected].some((id) => !assignedIds.includes(id));

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = () => setSelected(new Set(allCollections.map((c) => c.id)));
  const deselectAll = () => setSelected(new Set());

  const handleSave = () => {
    fetcher.submit(
      {
        intent: "save_assignments",
        weekStart,
        collectionIds: [...selected].join(","),
      },
      { method: "post" }
    );
  };

  return (
    <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
      {saveError && (
        <div className="mx-4 mt-4 rounded-xl bg-red-50 border border-red-200 px-4 py-3">
          <p className="text-sm text-red-800">{saveError}</p>
        </div>
      )}

      <div className="px-5 py-4 border-b border-gray-100">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="font-semibold text-gray-900">
              Week of {formatWeekRangeLabel(weekStart)}
            </h2>
            <p className="text-sm text-gray-400 mt-0.5">
              {selected.size} of {allCollections.length} collection{allCollections.length !== 1 ? "s" : ""} assigned
            </p>
          </div>
          <div className="flex items-center gap-2">
            {savedOk && (
              <span className="text-green-600 text-xs font-medium flex items-center gap-1 flex-none">
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
                Saved
              </span>
            )}
          </div>
        </div>
        <div className="mt-2 flex items-center gap-2">
          <button
            onClick={selectAll}
            className="text-xs text-indigo-600 hover:text-indigo-800 font-medium transition-colors"
          >
            Select all
          </button>
          <span className="text-gray-300">|</span>
          <button
            onClick={deselectAll}
            className="text-xs text-indigo-600 hover:text-indigo-800 font-medium transition-colors"
          >
            Deselect all
          </button>
        </div>
      </div>

      {allCollections.length === 0 ? (
        <div className="px-5 py-8 text-center text-sm text-gray-400">
          No Shopify collections found.
        </div>
      ) : (
        <div className="divide-y divide-gray-50">
          {allCollections.map((collection) => {
            const isSelected = selected.has(collection.id);
            return (
              <label
                key={collection.id}
                className={`flex items-center gap-4 px-5 py-3.5 cursor-pointer transition-colors ${
                  isSelected ? "bg-indigo-50/40" : "hover:bg-gray-50"
                }`}
              >
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={() => toggle(collection.id)}
                  className="w-4 h-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500 flex-none"
                />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-800">{collection.title}</p>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-xs text-gray-400">{collection.handle}</span>
                    {(collection.availableFrom || collection.availableUntil) && (
                      <>
                        <span className="text-gray-200">·</span>
                        <span className="text-xs text-gray-400">
                          {formatDateRange(collection.availableFrom, collection.availableUntil)}
                        </span>
                      </>
                    )}
                  </div>
                </div>
                {isSelected && (
                  <svg className="w-4 h-4 text-indigo-500 flex-none" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                )}
              </label>
            );
          })}
        </div>
      )}

      <div className="px-5 py-3 border-t border-gray-100 flex items-center justify-between gap-4">
        <p className="text-xs text-gray-400">
          Assigned collections will appear in the Sort Order & Defaults view for this week.
        </p>
        <button
          onClick={handleSave}
          disabled={isSaving || !hasChanges}
          className="text-sm font-medium bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-xl transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex-none"
        >
          {isSaving ? "Saving…" : "Save assignments"}
        </button>
      </div>
    </div>
  );
}

// ─── Sort-order / defaults panel ──────────────────────────────────────────────

type CollectionWithDates = BundleCollection & {
  availableFrom: string | null;
  availableUntil: string | null;
};

type WeeklyConfig = { targetQuantity: number };

function formatDateRange(from: string | null, until: string | null): string {
  const fmt = (d: string) =>
    new Date(d + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" });
  if (from && until) return `${fmt(from)} – ${fmt(until)}`;
  if (from) return `From ${fmt(from)}`;
  if (until) return `Until ${fmt(until)}`;
  return "";
}

const DIETARY_TAGS = ["dairy", "wheat", "gluten free", "vegetarian", "vegan", "meat", "fish", "nut", "soy", "egg"];

function getDietaryTags(tags: string[]): string[] {
  return tags.filter((t) =>
    DIETARY_TAGS.some((dt) => t.toLowerCase() === dt.toLowerCase())
  );
}

function WeekPanel({
  weekStart,
  collections,
  savedConfig,
}: {
  weekStart: string;
  collections: CollectionWithDates[];
  savedConfig: WeeklyConfig | null;
}) {
  const saveFetcher = useFetcher<typeof action>();
  const applyFetcher = useFetcher<typeof action>();
  const [targetQuantity, setTargetQuantity] = useState(savedConfig?.targetQuantity ?? 5);
  const [savedQuantity, setSavedQuantity] = useState(savedConfig?.targetQuantity ?? 5);
  const [applyConfirming, setApplyConfirming] = useState(false);

  const isSaving = saveFetcher.state !== "idle";
  const isApplying = applyFetcher.state !== "idle";

  const saveData = saveFetcher.data as
    | { success: true; intent: "save_config"; weekStart: string }
    | { error: string }
    | undefined;
  const savedOk = saveFetcher.state === "idle" && saveData != null && "success" in saveData;
  const saveError =
    saveFetcher.state === "idle" && saveData != null && "error" in saveData
      ? (saveData as { error: string }).error
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

  const hasConfigChanges = targetQuantity !== savedQuantity;

  const totalProducts = collections.reduce(
    (sum, c) => sum + c.products.length,
    0
  );

  useEffect(() => {
    if (savedOk) setSavedQuantity(targetQuantity);
  }, [savedOk]);

  useEffect(() => {
    if (isApplying) setApplyConfirming(false);
  }, [isApplying]);

  const handleSave = () => {
    saveFetcher.submit(
      { intent: "save_config", weekStart, targetQuantity: String(targetQuantity) },
      { method: "post" }
    );
  };

  const handleApply = () => {
    applyFetcher.submit(
      { intent: "apply_defaults", weekStart },
      { method: "post" }
    );
  };

  let positionCounter = 0;

  return (
    <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
      {saveError && (
        <div className="mx-4 mt-4 rounded-xl bg-red-50 border border-red-200 px-4 py-3">
          <p className="text-sm text-red-800">{saveError}</p>
        </div>
      )}

      <div className="px-5 py-4 border-b border-gray-100">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="font-semibold text-gray-900">
              Week of {formatWeekRangeLabel(weekStart)}
            </h2>
            <p className="text-sm text-gray-400 mt-0.5">
              {totalProducts} product{totalProducts !== 1 ? "s" : ""} available across {collections.length} collection{collections.length !== 1 ? "s" : ""}
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

        <div className="mt-3 flex items-center gap-3">
          <span className="text-sm text-gray-600">Meals per bundle:</span>
          <span className="text-sm font-semibold text-gray-900 tabular-nums bg-gray-100 px-2.5 py-1 rounded-lg">
            {targetQuantity}
          </span>
        </div>
      </div>

      {collections.length === 0 ? (
        <div className="px-5 py-8 text-center text-sm text-gray-400">
          No collections assigned for this week. Go to Assign Collections to add some.
        </div>
      ) : (
        <div className="divide-y divide-gray-50">
          {collections.map((collection) => (
            <div key={collection.id}>
              <div className="px-5 py-2 bg-gray-50">
                <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">
                  {collection.title}
                </p>
                {(collection.availableFrom || collection.availableUntil) && (
                  <p className="text-xs text-gray-400 mt-0.5">
                    {formatDateRange(collection.availableFrom, collection.availableUntil)}
                  </p>
                )}
              </div>
              {collection.products.map((product) => {
                positionCounter++;
                const position = positionCounter;
                const dietaryTags = getDietaryTags(product.tags ?? []);
                const isWithinTarget = position <= targetQuantity;
                return (
                  <div
                    key={product.id}
                    className={`px-5 py-3.5 flex items-center gap-4 transition-colors ${
                      isWithinTarget ? "bg-indigo-50/40" : "opacity-50"
                    }`}
                  >
                    <span
                      className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold flex-none ${
                        isWithinTarget
                          ? "bg-indigo-100 text-indigo-700"
                          : "bg-gray-100 text-gray-400"
                      }`}
                    >
                      {position}
                    </span>

                    {product.image_url ? (
                      <img
                        src={product.image_url}
                        alt={product.title}
                        className="w-10 h-10 rounded-lg object-cover flex-none bg-gray-100"
                      />
                    ) : (
                      <div className="w-10 h-10 rounded-lg bg-gray-100 flex-none" />
                    )}

                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-800">{product.title}</p>
                      {dietaryTags.length > 0 && (
                        <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                          {dietaryTags.map((tag) => (
                            <span
                              key={tag}
                              className="text-xs font-medium bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded"
                            >
                              {tag}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>

                    {isWithinTarget && (
                      <span className="text-xs text-indigo-500 font-medium flex-none">Default</span>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}

      <div className="px-5 py-3 bg-gray-50 border-t border-gray-100">
        <p className="text-xs text-gray-400">
          Priority order is controlled by collection sort order in Shopify admin.
          Items matching a customer's excluded ingredients will be skipped; preferred items are boosted to the top.
        </p>
      </div>

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
                      Personalized and applied to {appliedCount} of {applyResult.results.length} eligible charge{applyResult.results.length !== 1 ? "s" : ""}
                      {createdCount > 0 && (
                        <span className="text-gray-400 font-normal"> · {createdCount} new</span>
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
                            {r.customerId && <span className="text-gray-400"> (customer {r.customerId})</span>}
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

      <div className="px-5 py-3 border-t border-gray-100 flex items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          {isApplying ? (
            <span className="text-sm text-gray-500 flex items-center gap-1.5">
              <svg className="animate-spin w-3.5 h-3.5" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
              </svg>
              Personalizing & applying…
            </span>
          ) : applyConfirming ? (
            <>
              <span className="text-sm text-gray-600">Apply personalized defaults to all queued charges this week?</span>
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
              disabled={totalProducts === 0 || hasConfigChanges}
              title={hasConfigChanges ? "Save config first" : totalProducts === 0 ? "No products available" : undefined}
              className="text-sm font-medium text-indigo-600 hover:text-indigo-800 border border-indigo-200 hover:border-indigo-400 px-4 py-2 rounded-xl transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Apply to all charges
            </button>
          )}
        </div>

        <button
          onClick={handleSave}
          disabled={isSaving || !hasConfigChanges || isApplying}
          className="text-sm font-medium bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-xl transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {isSaving ? "Saving…" : "Save config"}
        </button>
      </div>
    </div>
  );
}
