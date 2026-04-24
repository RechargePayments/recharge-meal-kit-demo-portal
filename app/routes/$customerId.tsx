import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Link, useFetcher, useLoaderData, useRevalidator } from "@remix-run/react";
import { useEffect } from "react";
import {
  getCustomer,
  listQueuedCharges,
  listSubscriptions,
  skipCharge,
} from "~/lib/recharge.server";
import type { Charge, Customer, Subscription } from "~/lib/types";
import { formatCurrency, formatDate } from "~/lib/utils";

export const meta: MetaFunction = () => [{ title: "Future Charge Portal — Demo" }];

// ─── Loader ───────────────────────────────────────────────────────────────────

export async function loader({ params }: LoaderFunctionArgs) {
  const { customerId } = params;
  if (!customerId) throw new Error("Missing customer ID");

  const [customer, subscriptions, queuedCharges] = await Promise.all([
    getCustomer(customerId),
    listSubscriptions(customerId),
    listQueuedCharges(customerId),
  ]);

  return json({ customer, subscriptions, queuedCharges });
}

// ─── Action ───────────────────────────────────────────────────────────────────

export async function action({ request }: ActionFunctionArgs) {
  const formData = await request.formData();
  const intent = formData.get("intent");

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
  const { customer, subscriptions, queuedCharges } = useLoaderData<typeof loader>();
  const { revalidate, state } = useRevalidator();

  // Poll every 30 s so the page stays fresh during a demo
  useEffect(() => {
    const id = setInterval(revalidate, 30_000);
    return () => clearInterval(id);
  }, [revalidate]);

  const totalQueued = queuedCharges.length;

  return (
    <div className="min-h-screen bg-gray-50">
      <Header customer={customer} refreshing={state === "loading"} />

      <main className="max-w-3xl mx-auto px-4 sm:px-6 py-8 space-y-6">
        {/* Summary bar */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold text-gray-900">Subscriptions</h1>
            <p className="text-sm text-gray-500 mt-0.5">
              {customer.subscriptions_active_count} active
              {totalQueued > 0 && (
                <span className="ml-2 text-indigo-600 font-medium">
                  · {totalQueued} upcoming charge{totalQueued !== 1 ? "s" : ""} queued
                </span>
              )}
            </p>
          </div>
        </div>

        {/* Subscription cards */}
        {subscriptions.length === 0 ? (
          <EmptyState message="No active subscriptions found." />
        ) : (
          subscriptions.map((sub) => {
            const charges = queuedCharges.filter((c) =>
              c.line_items.some((li) => li.purchase_item_id === sub.id)
            );
            return <SubscriptionCard key={sub.id} subscription={sub} charges={charges} />;
          })
        )}
      </main>
    </div>
  );
}

// ─── Components ───────────────────────────────────────────────────────────────

function Header({ customer, refreshing }: { customer: Customer; refreshing: boolean }) {
  return (
    <header className="bg-white border-b border-gray-200 sticky top-0 z-10">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <Link to="/" className="w-7 h-7 bg-indigo-600 rounded-lg flex items-center justify-center flex-none hover:bg-indigo-700 transition-colors">
            <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </Link>
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-gray-900">Subscription Portal</span>
            <span className="text-xs bg-amber-100 text-amber-700 font-medium px-1.5 py-0.5 rounded">
              Demo
            </span>
          </div>
          {refreshing && (
            <span className="text-xs text-gray-400 animate-pulse ml-1">Refreshing…</span>
          )}
        </div>
        <div className="text-right">
          <p className="text-sm font-medium text-gray-900 leading-none">
            {customer.first_name} {customer.last_name}
          </p>
          <p className="text-xs text-gray-500 mt-0.5">{customer.email}</p>
        </div>
      </div>
    </header>
  );
}

function SubscriptionCard({
  subscription,
  charges,
}: {
  subscription: Subscription;
  charges: Charge[];
}) {
  const hasMultipleQueued = charges.length > 1;

  return (
    <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
      {/* Card header */}
      <div className="px-5 py-4 flex items-start gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="font-semibold text-gray-900 truncate">{subscription.product_title}</h2>
          </div>
          <div className="flex items-center gap-2 mt-1.5 flex-wrap">
            <StatusBadge status={subscription.status} />
            <span className="text-sm text-gray-500">
              {subscription.charge_interval_frequency && subscription.order_interval_unit
                ? ` · every ${subscription.charge_interval_frequency} ${subscription.order_interval_unit}`
                : ""}
            </span>
          </div>
        </div>

        {/* "N queued charges" callout — the key demo highlight */}
        {charges.length > 0 && (
          <div
            className={`flex-none flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-full border ${
              hasMultipleQueued
                ? "bg-indigo-50 text-indigo-700 border-indigo-200"
                : "bg-blue-50 text-blue-700 border-blue-100"
            }`}
          >
            <svg className="w-3.5 h-3.5 flex-none" viewBox="0 0 20 20" fill="currentColor">
              <path
                fillRule="evenodd"
                d="M6 2a1 1 0 00-1 1v1H4a2 2 0 00-2 2v10a2 2 0 002 2h12a2 2 0 002-2V6a2 2 0 00-2-2h-1V3a1 1 0 10-2 0v1H7V3a1 1 0 00-1-1zm0 5a1 1 0 000 2h8a1 1 0 100-2H6z"
                clipRule="evenodd"
              />
            </svg>
            {charges.length} queued charge{charges.length !== 1 ? "s" : ""}
          </div>
        )}
      </div>

      {/* Charge rows */}
      {charges.length > 0 ? (
        <>
          <div className="border-t border-gray-100 px-5 py-1.5 bg-gray-50 grid grid-cols-[1fr_80px_72px_120px] gap-3 items-center">
            <span className="text-xs font-medium text-gray-400 uppercase tracking-wide">Date</span>
            <span className="text-xs font-medium text-gray-400 uppercase tracking-wide text-right">Amount</span>
            <span className="text-xs font-medium text-gray-400 uppercase tracking-wide text-center">Status</span>
            <span />
          </div>
          <div className="divide-y divide-gray-200">
            {charges.map((charge) => (
              <ChargeRow key={charge.id} charge={charge} subscriptionId={subscription.id} />
            ))}
          </div>
        </>
      ) : (
        <div className="border-t border-gray-100 px-5 py-3 text-sm text-gray-400">
          {subscription.next_charge_scheduled_at
            ? `Next charge on ${formatDate(subscription.next_charge_scheduled_at)}`
            : "No upcoming charges scheduled."}
        </div>
      )}
    </div>
  );
}

function ChargeRow({
  charge,
  subscriptionId,
}: {
  charge: Charge;
  subscriptionId: number;
}) {
  const fetcher = useFetcher<typeof action>();
  const isSubmitting = fetcher.state !== "idle";
  // Optimistic skip state: show "skipped" immediately while revalidation runs
  const wasSkipped =
    fetcher.state === "idle" &&
    fetcher.data != null &&
    "success" in fetcher.data &&
    fetcher.data.success === true;

  const displayStatus = wasSkipped ? "skipped" : charge.status;
  const isQueued = displayStatus === "queued";

  // Show only the line items that belong to this subscription
  const ownLineItems = charge.line_items.filter((li) => li.purchase_item_id === subscriptionId);
  const lineItemsToShow = ownLineItems.length > 0 ? ownLineItems : charge.line_items;

  return (
    <div className="px-5 py-3 grid grid-cols-[1fr_80px_72px_120px] gap-3 items-start hover:bg-gray-50/60 transition-colors">
      {/* Date + items summary */}
      <div className="min-w-0">
        <p className="text-sm font-medium text-gray-800">{formatDate(charge.scheduled_at)}</p>
        <ul className="mt-1 space-y-0.5">
          {lineItemsToShow.map((li, i) => (
            <li key={i} className="text-xs text-gray-500 flex items-baseline gap-1.5">
              <span className="font-medium text-gray-700 tabular-nums">{li.quantity}×</span>
              <span>{li.title}</span>
            </li>
          ))}
        </ul>
      </div>

      {/* Amount */}
      <p className="text-sm font-semibold text-gray-900 text-right">
        {formatCurrency(charge.total_price)}
      </p>

      {/* Status badge */}
      <div className="flex justify-center">
        <ChargeBadge status={displayStatus} />
      </div>

      {/* Actions */}
      <div className="flex items-center justify-end gap-1">
        {isQueued && (
          <>
            <Link
              to={`/charges/${charge.id}`}
              className="text-xs font-medium text-indigo-600 hover:text-indigo-800 hover:bg-indigo-50 px-2 py-1 rounded-lg transition-colors whitespace-nowrap"
            >
              Edit bundle
            </Link>
            <fetcher.Form method="post">
              <input type="hidden" name="intent" value="skip" />
              <input type="hidden" name="chargeId" value={String(charge.id)} />
              <input type="hidden" name="purchaseItemId" value={String(subscriptionId)} />
              <button
                type="submit"
                disabled={isSubmitting}
                className="text-xs font-medium text-gray-500 hover:text-gray-800 hover:bg-gray-100 px-2 py-1 rounded-lg transition-colors disabled:opacity-40 whitespace-nowrap"
              >
                {isSubmitting ? "Skipping…" : "Skip"}
              </button>
            </fetcher.Form>
          </>
        )}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const variants: Record<string, string> = {
    active: "bg-green-100 text-green-700",
    cancelled: "bg-gray-100 text-gray-600",
    expired: "bg-orange-100 text-orange-700",
  };
  return (
    <span
      className={`inline-flex items-center text-xs font-medium px-2.5 py-0.5 rounded-full ${variants[status] ?? "bg-gray-100 text-gray-600"}`}
    >
      {status}
    </span>
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
      className={`inline-flex items-center text-xs font-medium px-2 py-0.5 rounded-full whitespace-nowrap ${variants[status] ?? "bg-gray-100 text-gray-600"}`}
    >
      {status}
    </span>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="bg-white rounded-2xl border border-gray-200 p-12 text-center shadow-sm">
      <p className="text-gray-400 text-sm">{message}</p>
    </div>
  );
}
