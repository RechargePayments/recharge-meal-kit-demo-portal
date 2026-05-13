import type { LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Link, useLoaderData } from "@remix-run/react";
import { getCustomer, listSuccessCharges } from "~/lib/recharge.server";
import { requireCustomerOwnsId } from "~/lib/auth.server";
import { formatCurrency, formatDate } from "~/lib/utils";
import type { Charge, ChargeLineItem } from "~/lib/types";

export const meta: MetaFunction = () => [{ title: "NourishBox — Previous Orders" }];

// ─── Loader ──────────────────────────────────────────────────────────────────

export async function loader({ params, request }: LoaderFunctionArgs) {
  const customerId = params.customerId!;
  await requireCustomerOwnsId(request, customerId);
  const [customer, charges] = await Promise.all([
    getCustomer(customerId),
    listSuccessCharges(customerId),
  ]);
  return json({ customer, charges });
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function OrdersPage() {
  const { customer, charges } = useLoaderData<typeof loader>();

  return (
    <div className="min-h-screen bg-cream bg-grain">
      <header className="bg-white border-b border-stone-200">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-4 flex items-center gap-3">
          <Link
            to={`/${customer.id}`}
            className="p-1.5 rounded-md text-stone-400 hover:text-brand-600 hover:bg-brand-50 transition-colors"
            aria-label="Back to dashboard"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 19.5 3 12m0 0 7.5-7.5M3 12h18" />
            </svg>
          </Link>
          <h1 className="font-display font-semibold text-xl text-stone-900">Previous Orders</h1>
          {charges.length > 0 && (
            <span className="ml-auto text-xs font-medium text-stone-400">
              {charges.length} {charges.length === 1 ? "order" : "orders"}
            </span>
          )}
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
        {charges.length === 0 ? (
          <EmptyState />
        ) : (
          charges.map((charge) => <OrderCard key={charge.id} charge={charge} />)
        )}
      </main>
    </div>
  );
}

// ─── Order card ──────────────────────────────────────────────────────────────

function OrderCard({ charge }: { charge: Charge }) {
  const deliveredOn = charge.processed_at ?? charge.scheduled_at;
  const currency = charge.currency ?? "USD";
  const mealCount = charge.line_items.reduce((sum, li) => sum + li.quantity, 0);

  return (
    <section className="bg-white rounded-2xl shadow-warm-sm border border-stone-100 overflow-hidden animate-fade-in">
      <div className="flex items-start justify-between gap-4 px-6 py-4 border-b border-stone-100">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-10 h-10 rounded-full bg-brand-50 border border-brand-100 flex items-center justify-center shrink-0">
            <svg className="w-5 h-5 text-brand-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 7.5l-9-5.25L3 7.5m18 0l-9 5.25m9-5.25v9l-9 5.25M3 7.5l9 5.25M3 7.5v9l9 5.25m0-9v9" />
            </svg>
          </div>
          <div className="min-w-0">
            <p className="font-display font-semibold text-stone-900">
              Delivered on {formatDate(deliveredOn)}
            </p>
            <p className="text-xs text-stone-400 mt-0.5">
              Order #{charge.id} &middot; {mealCount} {mealCount === 1 ? "item" : "items"}
            </p>
          </div>
        </div>
        <div className="text-right shrink-0">
          <p className="font-display font-semibold text-stone-900">
            {formatCurrency(charge.total_price, currency)}
          </p>
          <p className="text-[11px] uppercase tracking-wide text-stone-400 mt-0.5">Total</p>
        </div>
      </div>

      <div className="px-6 py-5">
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          {charge.line_items.map((item, idx) => (
            <MealTile key={`${item.purchase_item_id}-${idx}`} item={item} />
          ))}
        </div>
      </div>
    </section>
  );
}

// ─── Meal tile ───────────────────────────────────────────────────────────────

function MealTile({ item }: { item: ChargeLineItem }) {
  const image = item.images?.medium ?? item.images?.small ?? item.images?.original ?? null;

  return (
    <div className="group relative bg-stone-50 rounded-xl p-3 border border-stone-100 hover:border-brand-200 hover:bg-white transition-colors">
      <div className="relative aspect-square w-full overflow-hidden rounded-lg bg-stone-100 mb-3">
        {image ? (
          <img
            src={image}
            alt={item.title}
            loading="lazy"
            className="w-full h-full object-cover group-hover:scale-[1.03] transition-transform duration-300"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-stone-300">
            <svg className="w-10 h-10" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.25}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 0 0 1.5-1.5V6a1.5 1.5 0 0 0-1.5-1.5H3.75A1.5 1.5 0 0 0 2.25 6v12a1.5 1.5 0 0 0 1.5 1.5Zm10.5-11.25h.008v.008h-.008V8.25Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z" />
            </svg>
          </div>
        )}
        {item.quantity > 1 && (
          <span className="absolute top-1.5 right-1.5 inline-flex items-center justify-center min-w-[24px] h-6 px-1.5 rounded-full bg-stone-900/80 text-white text-[11px] font-semibold backdrop-blur-sm">
            ×{item.quantity}
          </span>
        )}
      </div>
      <p className="text-sm font-medium text-stone-900 leading-snug line-clamp-2">
        {item.title}
      </p>
      {item.variant_title && item.variant_title !== "Default Title" && (
        <p className="text-xs text-stone-500 mt-0.5 line-clamp-1">{item.variant_title}</p>
      )}
    </div>
  );
}

// ─── Empty state ─────────────────────────────────────────────────────────────

function EmptyState() {
  return (
    <section className="bg-white rounded-2xl shadow-warm-sm border border-stone-100 px-6 py-14 text-center animate-fade-in">
      <div className="mx-auto w-14 h-14 rounded-full bg-brand-50 border border-brand-100 flex items-center justify-center mb-4">
        <svg className="w-7 h-7 text-brand-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M21 7.5l-9-5.25L3 7.5m18 0l-9 5.25m9-5.25v9l-9 5.25M3 7.5l9 5.25M3 7.5v9l9 5.25m0-9v9" />
        </svg>
      </div>
      <h2 className="font-display font-semibold text-stone-900 text-lg">No orders yet</h2>
      <p className="text-sm text-stone-500 mt-1 max-w-sm mx-auto">
        Your first meal box is on the way. Once it ships, you'll see it here.
      </p>
    </section>
  );
}
