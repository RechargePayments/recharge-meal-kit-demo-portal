import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { Link, useFetcher, useLoaderData } from "@remix-run/react";
import { useEffect, useRef, useState } from "react";
import {
  getBundleCollectionsFromShopify,
  getBundleProductInfo,
  getBundleSelections,
  getCharge,
  getSubscription,
  skipCharge,
  updateBundleSelection,
} from "~/lib/recharge.server";
import type { BundleCollection, BundleSelection, BundleSelectionItem, Charge } from "~/lib/types";
import { formatCurrency, formatDate, shortId } from "~/lib/utils";

export const meta: MetaFunction<typeof loader> = ({ data }) => [
  { title: data ? `Charge #${data.charge.id} — Demo` : "Charge — Demo" },
];

// ─── Loader ───────────────────────────────────────────────────────────────────

export async function loader({ params }: LoaderFunctionArgs) {
  const { id } = params;
  if (!id) throw json({ error: "Missing charge ID" }, { status: 400 });

  const charge = await getCharge(id);

  const bundleSelections = await getBundleSelections(charge.id);

  const uniquePurchaseItemIds = [...new Set(bundleSelections.map((bs) => bs.purchase_item_id))];
  const subscriptions = await Promise.all(uniquePurchaseItemIds.map((id) => getSubscription(id)));
  const subscriptionTitles = Object.fromEntries(
    subscriptions.map((s) => [s.id, s.product_title])
  );

  // Fetch the full set of available collection IDs from the bundle product configuration so
  // de-selected items remain in the list even after Recharge strips them from the selection.
  const uniqueProductIds = [...new Set(bundleSelections.map((bs) => bs.external_product_id).filter(Boolean))] as string[];
  const bundleProductInfoList = await Promise.all(uniqueProductIds.map(getBundleProductInfo));
  const selectionCollectionIds = bundleSelections.flatMap((bs) => bs.items.map((i) => i.collection_id));
  const collectionIds = [
    ...new Set([...selectionCollectionIds, ...bundleProductInfoList.flatMap((info) => info.collectionIds)]),
  ];
  const availableCollections = await getBundleCollectionsFromShopify(collectionIds);
  const collectionsByProductId = Object.fromEntries(
    uniqueProductIds.map((pid) => [pid, availableCollections])
  ) as Record<string, typeof availableCollections>;
  const bundleProductRangesByProductId = Object.fromEntries(
    uniqueProductIds.map((pid, i) => [pid, bundleProductInfoList[i].quantityRanges])
  ) as Record<string, number[][]>;

  return json({ charge, bundleSelections, subscriptionTitles, collectionsByProductId, bundleProductRangesByProductId });
}

// ─── Action ───────────────────────────────────────────────────────────────────

export async function action({ request, params }: ActionFunctionArgs) {
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "update_bundle") {
    const rawId = formData.get("bundleSelectionId");
    const rawItems = formData.get("items");
    if (typeof rawId !== "string" || typeof rawItems !== "string") {
      return json({ error: "Invalid payload" }, { status: 400 });
    }
    const items = JSON.parse(rawItems) as Array<
      Pick<
        BundleSelectionItem,
        "collection_id" | "collection_source" | "external_product_id" | "external_variant_id" | "quantity"
      >
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
        } catch {
          // not JSON — fall through to generic message
        }
      }
      return json({ error: message, ranges, intent: "update_bundle" as const });
    }
  }

  if (intent === "skip") {
    const customerId = formData.get("customerId");
    await skipCharge(params.id!);
    return redirect(typeof customerId === "string" && customerId ? `/${customerId}` : "/");
  }

  return json({ error: "Unknown intent" }, { status: 400 });
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function ChargePage() {
  const { charge, bundleSelections, subscriptionTitles, collectionsByProductId, bundleProductRangesByProductId } = useLoaderData<typeof loader>();
  const skipFetcher = useFetcher();
  const isSkipping = skipFetcher.state !== "idle";
  const customerId = charge.customer_id ? String(charge.customer_id) : null;
  const backUrl = customerId ? `/${customerId}` : "/";

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 sticky top-0 z-10">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 py-3 flex items-center gap-2.5">
          <div className="w-7 h-7 bg-indigo-600 rounded-lg flex items-center justify-center flex-none">
            <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </div>
          <span className="text-sm font-semibold text-gray-900">Subscription Portal</span>
          <span className="text-xs bg-amber-100 text-amber-700 font-medium px-1.5 py-0.5 rounded">
            Demo
          </span>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 sm:px-6 py-8 space-y-5">
        {/* Back */}
        <Link
          to={backUrl}
          className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-800 group"
        >
          <svg
            className="w-4 h-4 group-hover:-translate-x-0.5 transition-transform"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          Back to subscriptions
        </Link>

        {/* Charge summary card */}
        <ChargeCard charge={charge} />

        {/* Bundle editors */}
        {bundleSelections.length > 0 ? (
          bundleSelections.map((bs) => {
            return (
              <BundleEditor
                key={bs.id}
                bundleSelection={bs}
                chargeIsQueued={charge.status === "queued"}
                subscriptionTitle={subscriptionTitles[bs.purchase_item_id] ?? `Subscription #${bs.purchase_item_id}`}
                lineItems={charge.line_items}
                availableCollections={bs.external_product_id ? (collectionsByProductId[bs.external_product_id] ?? []) : []}
                quantityRanges={bs.external_product_id ? (bundleProductRangesByProductId[bs.external_product_id] ?? []) : []}
              />
            );
          })
        ) : (
          <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-8 text-center text-sm text-gray-400">
            No bundle selections found for this charge.
          </div>
        )}

        {/* Skip */}
        {charge.status === "queued" && (
          <div className="flex justify-center pt-2 pb-4">
            <skipFetcher.Form method="post">
              <input type="hidden" name="intent" value="skip" />
              {customerId && <input type="hidden" name="customerId" value={customerId} />}
              <button
                type="submit"
                disabled={isSkipping}
                className="text-sm font-medium text-gray-500 hover:text-red-600 border border-gray-200 hover:border-red-200 hover:bg-red-50 px-5 py-2 rounded-xl transition-colors disabled:opacity-40"
              >
                {isSkipping ? "Skipping charge…" : "Skip this charge"}
              </button>
            </skipFetcher.Form>
          </div>
        )}
      </main>
    </div>
  );
}

// ─── Charge summary card ──────────────────────────────────────────────────────

function ChargeCard({ charge }: { charge: Charge }) {
  return (
    <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold text-gray-900">Charge #{charge.id}</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Scheduled for{" "}
            <span className="font-medium text-gray-700">{formatDate(charge.scheduled_at)}</span>
          </p>
          {charge.error && (
            <p className="text-xs text-red-500 mt-1">{charge.error}</p>
          )}
        </div>
        <div className="text-right flex-none">
          <p className="text-2xl font-bold text-gray-900 tabular-nums">
            {formatCurrency(charge.total_price, charge.currency ?? "USD")}
          </p>
          <ChargeBadge status={charge.status} />
        </div>
      </div>

      {/* Line items */}
      {charge.line_items.length > 0 && (
        <div className="mt-4 pt-4 border-t border-gray-100 space-y-1.5">
          <p className="text-xs font-medium text-gray-400 uppercase tracking-wide mb-2">
            Line items
          </p>
          {charge.line_items.map((li, i) => (
            <div key={i} className="flex items-center justify-between text-sm gap-3">
              <span className="text-gray-700 truncate">
                {li.quantity > 1 && (
                  <span className="font-medium">{li.quantity}× </span>
                )}
                {li.title}
                {li.variant_title && (
                  <span className="text-gray-400"> — {li.variant_title}</span>
                )}
              </span>
              <span className="text-gray-500 flex-none">{formatCurrency(li.total_price)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Bundle editor ────────────────────────────────────────────────────────────

type EditableItem = {
  collection_id: string;
  collection_source: string;
  external_product_id: string;
  external_variant_id: string;
  quantity: number;
  productTitle: string;
  variantTitle: string;
  imageUrl: string | null;
};

function buildEditableItems(
  bundleSelection: BundleSelection,
  availableCollections: BundleCollection[]
): EditableItem[] {
  const currentQty: Record<string, number> = {};
  for (const item of bundleSelection.items) {
    currentQty[item.external_variant_id] = item.quantity;
  }

  const seen = new Set<string>();
  const result: EditableItem[] = [];

  for (const collection of availableCollections) {
    for (const product of collection.products) {
      for (const variant of product.variants) {
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
        });
      }
    }
  }

  // Preserve any selected items not found in collections (safety net)
  for (const item of bundleSelection.items) {
    if (!seen.has(item.external_variant_id)) {
      result.push({
        collection_id: item.collection_id,
        collection_source: item.collection_source,
        external_product_id: item.external_product_id,
        external_variant_id: item.external_variant_id,
        quantity: item.quantity,
        productTitle: `Product ${shortId(item.external_product_id)}`,
        variantTitle: `Variant ${shortId(item.external_variant_id)}`,
        imageUrl: null,
      });
    }
  }

  return result.sort((a, b) => {
    if (a.quantity > 0 && b.quantity === 0) return -1;
    if (a.quantity === 0 && b.quantity > 0) return 1;
    return 0;
  });
}

function formatRangeLabel(ranges: number[][]): string {
  if (ranges.length === 0) return "";
  const [min, max] = ranges[0];
  if (min === max) return `Select exactly ${min} item${min !== 1 ? "s" : ""}`;
  return `Select ${min}–${max} items`;
}

function BundleEditor({
  bundleSelection,
  chargeIsQueued,
  subscriptionTitle,
  availableCollections,
  quantityRanges,
}: {
  bundleSelection: BundleSelection;
  chargeIsQueued: boolean;
  subscriptionTitle: string;
  lineItems: Charge["line_items"];
  availableCollections: BundleCollection[];
  quantityRanges: number[][];
}) {
  const fetcher = useFetcher<typeof action>();
  const [items, setItems] = useState<EditableItem[]>(() =>
    buildEditableItems(bundleSelection, availableCollections)
  );
  const [savedQty, setSavedQty] = useState<Record<string, number>>(
    () => Object.fromEntries(bundleSelection.items.map((i) => [i.external_variant_id, i.quantity]))
  );
  const [errorDismissed, setErrorDismissed] = useState(false);
  const submittedQtyRef = useRef<Record<string, number>>({});

  const isSaving = fetcher.state !== "idle";
  const fetcherData = fetcher.data as
    | { success: true; intent: "update_bundle" }
    | { error: string; ranges?: number[][]; intent: "update_bundle" }
    | undefined;

  const savedOk =
    fetcher.state === "idle" && fetcherData != null && "success" in fetcherData;

  const fetcherError =
    fetcher.state === "idle" && fetcherData != null && "error" in fetcherData
      ? fetcherData
      : null;

  const showError = fetcherError != null && !errorDismissed;

  // Ranges from the loader (proactive) or from the error response (reactive)
  const effectiveRanges = fetcherError?.ranges ?? quantityRanges;
  const rangeLabel = formatRangeLabel(effectiveRanges);
  const totalItems = items.reduce((sum, item) => sum + item.quantity, 0);
  const isValidTotal =
    effectiveRanges.length === 0 ||
    effectiveRanges.some(([min, max]) => totalItems >= min && totalItems <= max);

  const hasChanges = items.some((item) => {
    const orig = savedQty[item.external_variant_id] ?? 0;
    return item.quantity !== orig;
  });

  // Reset dismissed state when a new save starts
  useEffect(() => {
    if (isSaving) setErrorDismissed(false);
  }, [isSaving]);

  // Only commit savedQty on confirmed success (not optimistically)
  useEffect(() => {
    if (savedOk) setSavedQty(submittedQtyRef.current);
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

  return (
    <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
      {/* Error banner */}
      {showError && (
        <div className="mx-4 mt-4 rounded-xl bg-red-50 border border-red-200 px-4 py-3 flex items-start gap-3">
          <svg className="w-4 h-4 text-red-500 flex-none mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <p className="flex-1 text-sm text-red-800">{fetcherError.error}</p>
          <button
            onClick={() => setErrorDismissed(true)}
            aria-label="Dismiss error"
            className="flex-none text-red-400 hover:text-red-600 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}

      {/* Header */}
      <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between gap-4">
        <div>
          <h2 className="font-semibold text-gray-900">Bundle Selection</h2>
          <p className="text-sm text-gray-500 mt-0.5">{subscriptionTitle}</p>
          {rangeLabel && chargeIsQueued && (
            <p className={`text-xs mt-1.5 font-medium ${isValidTotal ? "text-gray-400" : "text-amber-600"}`}>
              {rangeLabel} · {totalItems} selected
            </p>
          )}
        </div>
        <span className="text-xs text-gray-400 flex-none">ID #{bundleSelection.id}</span>
      </div>

      {/* Items */}
      <div className="divide-y divide-gray-50">
        {items.map((item, index) => (
          <div
            key={item.external_variant_id}
            className={`px-5 py-3.5 flex items-center gap-4 ${item.quantity === 0 ? "opacity-40" : ""}`}
          >
            {/* Thumbnail */}
            {item.imageUrl ? (
              <img
                src={item.imageUrl}
                alt={item.productTitle}
                className="w-10 h-10 rounded-lg object-cover flex-none bg-gray-100"
              />
            ) : (
              <div className="w-10 h-10 rounded-lg bg-gray-100 flex-none" />
            )}

            {/* Identity */}
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-gray-800">{item.productTitle}</p>
              {item.variantTitle && item.variantTitle !== "Default Title" && (
                <p className="text-xs text-gray-400 mt-0.5">{item.variantTitle}</p>
              )}
            </div>

            {/* Quantity stepper */}
            {chargeIsQueued ? (
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
            ) : (
              <span className="text-sm font-semibold text-gray-500 flex-none">
                {item.quantity > 0 ? `×${item.quantity}` : "—"}
              </span>
            )}
          </div>
        ))}
      </div>

      {/* Footer */}
      {chargeIsQueued && (
        <div className="px-5 py-3 border-t border-gray-100 flex items-center justify-between">
          <div className="text-xs">
            {savedOk && (
              <span className="text-green-600 font-medium flex items-center gap-1">
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
                Changes saved
              </span>
            )}
          </div>
          <button
            onClick={handleSave}
            disabled={isSaving || !hasChanges}
            className="text-sm font-medium bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-xl transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {isSaving ? "Saving…" : "Save changes"}
          </button>
        </div>
      )}
    </div>
  );
}

function ChargeBadge({ status }: { status: string }) {
  const variants: Record<string, string> = {
    queued: "bg-blue-50 text-blue-700",
    success: "bg-green-50 text-green-700",
    skipped: "bg-amber-50 text-amber-700",
    error: "bg-red-50 text-red-700",
    refunded: "bg-gray-100 text-gray-500",
    pending: "bg-purple-50 text-purple-700",
  };
  return (
    <span
      className={`inline-flex items-center mt-1 text-xs font-medium px-2.5 py-0.5 rounded-full ${variants[status] ?? "bg-gray-100 text-gray-600"}`}
    >
      {status}
    </span>
  );
}
