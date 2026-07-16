import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { Link, useFetcher, useLoaderData } from "@remix-run/react";
import { useEffect, useRef, useState } from "react";
import {
  activateSubscription,
  cancelSubscription,
  getCustomer,
  getSubscription,
  listAddresses,
  listPaymentMethods,
  listSubscriptions,
  sendPaymentUpdateNotification,
  updateAddress,
  updateCustomer,
} from "~/lib/recharge.server";
import {
  getCancellationSurveyUrl,
  isDemoBypassSession,
  requireCustomerOwnsId,
} from "~/lib/auth.server";
import type { Address, Customer, PaymentMethod, Subscription } from "~/lib/types";

export const meta: MetaFunction = () => [{ title: "NourishBox — My Account" }];

// ─── Loader ──────────────────────────────────────────────────────────────────

// The subset of the subscription the account page needs. Selected from the
// customer's subscriptions regardless of status so a cancelled subscription can
// still be shown with a Reactivate option.
type AccountSubscription = Pick<Subscription, "id" | "product_title" | "status">;

function selectPrimarySubscription(subscriptions: Subscription[]): AccountSubscription | null {
  const active = subscriptions.find((s) => s.status === "active");
  // Fall back to the most recent (highest id) cancelled/expired subscription.
  const primary = active ?? [...subscriptions].sort((a, b) => b.id - a.id)[0] ?? null;
  if (!primary) return null;
  return { id: primary.id, product_title: primary.product_title, status: primary.status };
}

export async function loader({ params, request }: LoaderFunctionArgs) {
  const customerId = params.customerId!;
  const auth = await requireCustomerOwnsId(request, customerId);
  const [customer, addresses, paymentMethods, subscriptions] = await Promise.all([
    getCustomer(customerId),
    listAddresses(customerId),
    listPaymentMethods(customerId),
    listSubscriptions(customerId, null),
  ]);
  const subscription = selectPrimarySubscription(subscriptions);
  // The demo-bypass session can't reach the hosted churn survey (no real customer
  // token), so the UI offers a simple confirm-and-cancel dialog instead.
  const isDemoSession = isDemoBypassSession(auth);
  return json({ customer, addresses, paymentMethods, subscription, isDemoSession });
}

// ─── Action ──────────────────────────────────────────────────────────────────

export async function action({ request, params }: ActionFunctionArgs) {
  const customerId = params.customerId!;
  const auth = await requireCustomerOwnsId(request, customerId);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "update_profile") {
    const fields: Record<string, string> = {};
    for (const key of ["email", "first_name", "last_name", "phone"]) {
      const val = formData.get(key);
      if (typeof val === "string" && val.trim() !== "") {
        fields[key] = val.trim();
      }
    }
    if (Object.keys(fields).length === 0) {
      return json({ error: "No fields to update", intent: "update_profile" as const }, { status: 400 });
    }
    try {
      await updateCustomer(customerId, fields);
      return json({ success: true, intent: "update_profile" as const });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to update profile.";
      return json({ error: message, intent: "update_profile" as const });
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

  if (intent === "send_payment_update") {
    const paymentMethodId = formData.get("paymentMethodId");
    if (typeof paymentMethodId !== "string") {
      return json({ error: "Missing paymentMethodId", intent: "send_payment_update" as const }, { status: 400 });
    }
    try {
      await sendPaymentUpdateNotification(customerId, Number(paymentMethodId));
      return json({ success: true, intent: "send_payment_update" as const });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to send notification.";
      return json({ error: message, intent: "send_payment_update" as const });
    }
  }

  if (intent === "cancel_subscription") {
    const subscriptionId = formData.get("subscriptionId");
    if (typeof subscriptionId !== "string") {
      return json({ error: "Missing subscriptionId", intent: "cancel_subscription" as const }, { status: 400 });
    }
    if (isDemoBypassSession(auth)) {
      return json({
        error: "Cancellation isn't available in demo mode. Log in as a real customer to use the cancellation flow.",
        intent: "cancel_subscription" as const,
      });
    }
    try {
      const sub = await getSubscription(Number(subscriptionId));
      if (sub.customer_id !== Number(customerId) || sub.status !== "active") {
        throw new Response("Not Found", { status: 404 });
      }
      const origin = new URL(request.url).origin;
      const surveyUrl = await getCancellationSurveyUrl(auth.rechargeSession, sub.id, `${origin}/${customerId}`);
      return redirect(surveyUrl);
    } catch (err) {
      if (err instanceof Response) throw err;
      const message = err instanceof Error ? err.message : "Couldn't start cancellation, please try again.";
      return json({ error: message, intent: "cancel_subscription" as const });
    }
  }

  if (intent === "cancel_subscription_demo") {
    const subscriptionId = formData.get("subscriptionId");
    if (typeof subscriptionId !== "string") {
      return json({ error: "Missing subscriptionId", intent: "cancel_subscription_demo" as const }, { status: 400 });
    }
    // Direct cancel (no churn survey) is only for the demo-bypass session; real
    // customers must go through the hosted survey.
    if (!isDemoBypassSession(auth)) {
      throw new Response("Not Found", { status: 404 });
    }
    try {
      const sub = await getSubscription(Number(subscriptionId));
      if (sub.customer_id !== Number(customerId) || sub.status !== "active") {
        throw new Response("Not Found", { status: 404 });
      }
      await cancelSubscription(sub.id);
      return json({ success: true, intent: "cancel_subscription_demo" as const });
    } catch (err) {
      if (err instanceof Response) throw err;
      const message = err instanceof Error ? err.message : "Couldn't cancel, please try again.";
      return json({ error: message, intent: "cancel_subscription_demo" as const });
    }
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

  return json({ error: "Unknown intent" }, { status: 400 });
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function AccountPage() {
  const { customer, addresses, paymentMethods, subscription, isDemoSession } = useLoaderData<typeof loader>();

  const [editingProfile, setEditingProfile] = useState(false);
  const [editingAddress, setEditingAddress] = useState<Address | null>(null);
  const [updatingPayment, setUpdatingPayment] = useState<PaymentMethod | null>(null);
  const [paymentEmailSent, setPaymentEmailSent] = useState<number | null>(null);

  return (
    <div className="min-h-screen bg-cream bg-grain">
      <header className="bg-white border-b border-stone-200">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-4 flex items-center gap-3">
          <Link
            to={`/${customer.id}`}
            className="p-1.5 rounded-md text-stone-400 hover:text-brand-600 hover:bg-brand-50 transition-colors"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 19.5 3 12m0 0 7.5-7.5M3 12h18" />
            </svg>
          </Link>
          <h1 className="font-display font-semibold text-xl text-stone-900">My Account</h1>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
        {/* ── Profile ── */}
        <section className="bg-white rounded-2xl shadow-sm border border-stone-100 overflow-hidden">
          <div className="flex items-center justify-between px-6 py-4 border-b border-stone-100">
            <div className="flex items-center gap-2">
              <svg className="w-5 h-5 text-brand-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0ZM4.501 20.118a7.5 7.5 0 0 1 14.998 0A17.933 17.933 0 0 1 12 21.75c-2.676 0-5.216-.584-7.499-1.632Z" />
              </svg>
              <h2 className="font-display font-semibold text-stone-900">Profile</h2>
            </div>
            <button
              type="button"
              onClick={() => setEditingProfile(true)}
              className="text-sm font-medium text-brand-600 hover:text-brand-700 transition-colors"
            >
              Edit
            </button>
          </div>
          <div className="px-6 py-5 space-y-3">
            <ProfileRow label="Name" value={`${customer.first_name} ${customer.last_name}`} />
            <ProfileRow label="Email" value={customer.email} />
          </div>
        </section>

        {/* ── Payment Methods ── */}
        <section className="bg-white rounded-2xl shadow-sm border border-stone-100 overflow-hidden">
          <div className="flex items-center gap-2 px-6 py-4 border-b border-stone-100">
            <svg className="w-5 h-5 text-brand-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 8.25h19.5M2.25 9h19.5m-16.5 5.25h6m-6 2.25h3m-3.75 3h15a2.25 2.25 0 0 0 2.25-2.25V6.75a2.25 2.25 0 0 0-2.25-2.25h-15a2.25 2.25 0 0 0-2.25 2.25v10.5a2.25 2.25 0 0 0 2.25 2.25Z" />
            </svg>
            <h2 className="font-display font-semibold text-stone-900">Payment Methods</h2>
          </div>
          {paymentMethods.length === 0 ? (
            <div className="px-6 py-8 text-center text-sm text-stone-400">
              No payment methods on file.
            </div>
          ) : (
            <div className="divide-y divide-stone-100">
              {paymentMethods.map((pm) => (
                <div key={pm.id} className="px-6 py-4 flex items-center justify-between gap-4">
                  <div className="flex items-center gap-3 min-w-0">
                    <CardBrandIcon brand={pm.payment_details?.brand} />
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-stone-900">
                        {pm.payment_details?.brand ?? "Card"} ending in {pm.payment_details?.last4 ?? "????"}
                      </p>
                      <p className="text-xs text-stone-400">
                        Expires {pm.payment_details?.exp_month ?? "?"}/{pm.payment_details?.exp_year ?? "?"}
                        {pm.billing_address?.first_name && (
                          <> &middot; {pm.billing_address.first_name} {pm.billing_address.last_name}</>
                        )}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {paymentEmailSent === pm.id ? (
                      <span className="text-xs text-emerald-600 font-medium flex items-center gap-1">
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
                        </svg>
                        Email sent
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setUpdatingPayment(pm)}
                        className="text-sm font-medium text-brand-600 hover:text-brand-700 transition-colors"
                      >
                        Update
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className="px-6 py-3 bg-stone-50 border-t border-stone-100">
            <p className="text-xs text-stone-400">
              Card details are managed by Shopify. Clicking "Update" sends you an email with a secure link to change your card.
            </p>
          </div>
        </section>

        {/* ── Shipping Addresses ── */}
        <section className="bg-white rounded-2xl shadow-sm border border-stone-100 overflow-hidden">
          <div className="flex items-center gap-2 px-6 py-4 border-b border-stone-100">
            <svg className="w-5 h-5 text-brand-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 10.5a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1 1 15 0Z" />
            </svg>
            <h2 className="font-display font-semibold text-stone-900">Shipping Addresses</h2>
          </div>
          {addresses.length === 0 ? (
            <div className="px-6 py-8 text-center text-sm text-stone-400">
              No addresses on file.
            </div>
          ) : (
            <div className="divide-y divide-stone-100">
              {addresses.map((addr) => (
                <div key={addr.id} className="px-6 py-4 flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-stone-900">
                      {addr.first_name} {addr.last_name}
                    </p>
                    <p className="text-xs text-stone-500 truncate">
                      {addr.address1}
                      {addr.address2 ? `, ${addr.address2}` : ""}
                    </p>
                    <p className="text-xs text-stone-400">
                      {addr.city}{addr.province ? `, ${addr.province}` : ""} {addr.zip} {addr.country_code}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setEditingAddress(addr)}
                    className="text-sm font-medium text-brand-600 hover:text-brand-700 transition-colors shrink-0"
                  >
                    Edit
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* ── Subscription ── */}
        {subscription && <SubscriptionSection subscription={subscription} isDemoSession={isDemoSession} />}
      </main>

      {editingProfile && (
        <ProfileEditModal customer={customer} onClose={() => setEditingProfile(false)} />
      )}
      {editingAddress && (
        <AddressEditModal address={editingAddress} onClose={() => setEditingAddress(null)} />
      )}
      {updatingPayment && (
        <PaymentUpdateModal
          paymentMethod={updatingPayment}
          onClose={() => setUpdatingPayment(null)}
          onSent={(pmId) => {
            setPaymentEmailSent(pmId);
            setUpdatingPayment(null);
          }}
        />
      )}
    </div>
  );
}

// ─── Subscription section ────────────────────────────────────────────────────

function SubscriptionStatusBadge({ status }: { status: AccountSubscription["status"] }) {
  const styles: Record<AccountSubscription["status"], string> = {
    active: "bg-brand-100 text-brand-700",
    cancelled: "bg-red-50 text-red-600",
    expired: "bg-stone-100 text-stone-500",
  };
  const label = { active: "Active", cancelled: "Cancelled", expired: "Expired" }[status];
  return <span className={`badge mt-1 ${styles[status]}`}>{label}</span>;
}

function SubscriptionSection({
  subscription,
  isDemoSession,
}: {
  subscription: AccountSubscription;
  isDemoSession: boolean;
}) {
  const fetcher = useFetcher<typeof action>();
  const busy = fetcher.state !== "idle";
  const submittingIntent = fetcher.formData?.get("intent");
  const error =
    fetcher.data != null && "error" in fetcher.data ? (fetcher.data as { error: string }).error : null;

  const [confirmingCancel, setConfirmingCancel] = useState(false);

  // Close the confirm dialog once the demo cancel succeeds (the loader
  // revalidates and the section flips to the cancelled state).
  useEffect(() => {
    if (
      fetcher.state === "idle" &&
      fetcher.data != null &&
      "success" in fetcher.data &&
      (fetcher.data as { intent?: string }).intent === "cancel_subscription_demo"
    ) {
      setConfirmingCancel(false);
    }
  }, [fetcher.state, fetcher.data]);

  return (
    <section className="bg-white rounded-2xl shadow-sm border border-stone-100 overflow-hidden">
      <div className="flex items-center gap-2 px-6 py-4 border-b border-stone-100">
        <svg className="w-5 h-5 text-brand-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M21 7.5l-9-5.25L3 7.5m18 0l-9 5.25m9-5.25v9l-9 5.25M3 7.5l9 5.25M3 7.5v9l9 5.25m0-9v9" />
        </svg>
        <h2 className="font-display font-semibold text-stone-900">Subscription</h2>
      </div>
      <div className="px-6 py-5">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <p className="text-sm font-medium text-stone-900 truncate">{subscription.product_title}</p>
            <SubscriptionStatusBadge status={subscription.status} />
          </div>

          {subscription.status === "active" &&
            (isDemoSession ? (
              // The demo-bypass session can't reach the hosted churn survey, so
              // offer a simple confirm-and-cancel dialog instead of redirecting.
              <button
                type="button"
                onClick={() => setConfirmingCancel(true)}
                disabled={busy}
                className="shrink-0 text-sm font-medium text-brand-600 hover:text-brand-700 transition-colors disabled:opacity-60"
              >
                Cancel subscription
              </button>
            ) : (
              <fetcher.Form method="post" className="shrink-0">
                <input type="hidden" name="intent" value="cancel_subscription" />
                <input type="hidden" name="subscriptionId" value={subscription.id} />
                <button
                  type="submit"
                  disabled={busy}
                  className="text-sm font-medium text-brand-600 hover:text-brand-700 transition-colors disabled:opacity-60"
                >
                  {busy && submittingIntent === "cancel_subscription" ? "Starting…" : "Cancel subscription"}
                </button>
              </fetcher.Form>
            ))}

          {subscription.status === "cancelled" && (
            <fetcher.Form method="post" className="shrink-0">
              <input type="hidden" name="intent" value="reactivate_subscription" />
              <input type="hidden" name="subscriptionId" value={subscription.id} />
              <button type="submit" disabled={busy} className="btn-primary text-sm px-4 py-2">
                {busy && submittingIntent === "reactivate_subscription" ? "Reactivating…" : "Reactivate"}
              </button>
            </fetcher.Form>
          )}
        </div>

        {error && !confirmingCancel && <p className="mt-3 text-sm text-red-600">{error}</p>}
      </div>

      {confirmingCancel && (
        <ModalShell title="Cancel subscription" onClose={() => { if (!busy) setConfirmingCancel(false); }}>
          <div className="px-6 py-5">
            <p className="text-sm text-stone-600">
              Do you want to cancel your subscription? You can reactivate it anytime.
            </p>
            {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
            <div className="flex items-center gap-3 mt-5">
              <fetcher.Form method="post">
                <input type="hidden" name="intent" value="cancel_subscription_demo" />
                <input type="hidden" name="subscriptionId" value={subscription.id} />
                <button
                  type="submit"
                  disabled={busy}
                  className="inline-flex items-center rounded-lg bg-red-600 px-5 py-2 text-sm font-semibold text-white hover:bg-red-700 transition-colors disabled:opacity-60"
                >
                  {busy && submittingIntent === "cancel_subscription_demo" ? "Cancelling…" : "Yes, cancel"}
                </button>
              </fetcher.Form>
              <button
                type="button"
                disabled={busy}
                onClick={() => setConfirmingCancel(false)}
                className="px-4 py-2 text-sm font-medium text-stone-600 hover:text-stone-800 transition-colors"
              >
                Keep subscription
              </button>
            </div>
          </div>
        </ModalShell>
      )}
    </section>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function ProfileRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-xs font-medium text-stone-400 uppercase tracking-wide">{label}</span>
      <span className="text-sm text-stone-700">{value}</span>
    </div>
  );
}

function CardBrandIcon({ brand }: { brand?: string | null }) {
  const label = brand?.toLowerCase() ?? "";
  let color = "bg-stone-100 text-stone-500";
  let text = "Card";

  if (label.includes("visa")) { color = "bg-blue-50 text-blue-600"; text = "Visa"; }
  else if (label.includes("master")) { color = "bg-orange-50 text-orange-600"; text = "MC"; }
  else if (label.includes("amex") || label.includes("american")) { color = "bg-indigo-50 text-indigo-600"; text = "Amex"; }
  else if (label.includes("discover")) { color = "bg-amber-50 text-amber-600"; text = "Disc"; }
  else if (brand) { text = brand.slice(0, 4); }

  return (
    <div className={`w-10 h-7 rounded-md flex items-center justify-center text-[10px] font-bold ${color}`}>
      {text}
    </div>
  );
}

const FIELD_CLASS =
  "w-full rounded-lg border border-stone-200 px-3 py-2 text-sm text-stone-800 placeholder:text-stone-400 focus:outline-none focus:ring-2 focus:ring-brand-300 focus:border-brand-300 transition-colors";

// ─── Modal shell ─────────────────────────────────────────────────────────────

function ModalShell({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    function handleKey(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-xl w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-stone-100">
          <h2 className="font-display font-semibold text-lg text-stone-900">{title}</h2>
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
        {children}
      </div>
    </div>
  );
}

// ─── Profile edit modal ──────────────────────────────────────────────────────

function ProfileEditModal({ customer, onClose }: { customer: Customer; onClose: () => void }) {
  const fetcher = useFetcher();
  const isSubmitting = fetcher.state !== "idle";
  const prevState = useRef(fetcher.state);

  useEffect(() => {
    if (prevState.current === "loading" && fetcher.state === "idle" && fetcher.data) {
      const data = fetcher.data as { success?: boolean };
      if (data.success) onClose();
    }
    prevState.current = fetcher.state;
  }, [fetcher.state, fetcher.data, onClose]);

  const error = (fetcher.data as { error?: string } | undefined)?.error;

  return (
    <ModalShell title="Edit profile" onClose={onClose}>
      <fetcher.Form method="post" className="px-6 py-5 space-y-4">
        <input type="hidden" name="intent" value="update_profile" />

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-stone-500 mb-1">First name</label>
            <input name="first_name" defaultValue={customer.first_name} className={FIELD_CLASS} />
          </div>
          <div>
            <label className="block text-xs font-medium text-stone-500 mb-1">Last name</label>
            <input name="last_name" defaultValue={customer.last_name} className={FIELD_CLASS} />
          </div>
        </div>

        <div>
          <label className="block text-xs font-medium text-stone-500 mb-1">Email</label>
          <input name="email" type="email" defaultValue={customer.email} className={FIELD_CLASS} />
        </div>

        {error && (
          <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</p>
        )}

        <div className="flex justify-end gap-3 pt-2">
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
            className="px-5 py-2 text-sm font-medium text-white rounded-lg shadow-sm transition-colors disabled:opacity-50"
            style={{ backgroundColor: "#16a34a" }}
          >
            {isSubmitting ? "Saving..." : "Save changes"}
          </button>
        </div>
      </fetcher.Form>
    </ModalShell>
  );
}

// ─── Address edit modal ──────────────────────────────────────────────────────

function AddressEditModal({ address, onClose }: { address: Address; onClose: () => void }) {
  const fetcher = useFetcher();
  const isSubmitting = fetcher.state !== "idle";
  const prevState = useRef(fetcher.state);

  useEffect(() => {
    if (prevState.current === "loading" && fetcher.state === "idle" && fetcher.data) {
      const data = fetcher.data as { success?: boolean };
      if (data.success) onClose();
    }
    prevState.current = fetcher.state;
  }, [fetcher.state, fetcher.data, onClose]);

  const error = (fetcher.data as { error?: string } | undefined)?.error;

  return (
    <ModalShell title="Edit shipping address" onClose={onClose}>
      <fetcher.Form method="post" className="px-6 py-5 space-y-4">
        <input type="hidden" name="intent" value="update_address" />
        <input type="hidden" name="addressId" value={address.id} />

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-stone-500 mb-1">First name</label>
            <input name="first_name" defaultValue={address.first_name ?? ""} className={FIELD_CLASS} />
          </div>
          <div>
            <label className="block text-xs font-medium text-stone-500 mb-1">Last name</label>
            <input name="last_name" defaultValue={address.last_name ?? ""} className={FIELD_CLASS} />
          </div>
        </div>

        <div>
          <label className="block text-xs font-medium text-stone-500 mb-1">Address</label>
          <input name="address1" defaultValue={address.address1 ?? ""} className={FIELD_CLASS} />
        </div>

        <div>
          <label className="block text-xs font-medium text-stone-500 mb-1">Apartment, suite, etc.</label>
          <input name="address2" defaultValue={address.address2 ?? ""} placeholder="Optional" className={FIELD_CLASS} />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-stone-500 mb-1">City</label>
            <input name="city" defaultValue={address.city ?? ""} className={FIELD_CLASS} />
          </div>
          <div>
            <label className="block text-xs font-medium text-stone-500 mb-1">State / Province</label>
            <input name="province" defaultValue={address.province ?? ""} className={FIELD_CLASS} />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-stone-500 mb-1">ZIP / Postal code</label>
            <input name="zip" defaultValue={address.zip ?? ""} className={FIELD_CLASS} />
          </div>
          <div>
            <label className="block text-xs font-medium text-stone-500 mb-1">Country code</label>
            <input name="country_code" defaultValue={address.country_code ?? ""} className={FIELD_CLASS} />
          </div>
        </div>

        <div>
          <label className="block text-xs font-medium text-stone-500 mb-1">Phone</label>
          <input name="phone" defaultValue={address.phone ?? ""} placeholder="Optional" className={FIELD_CLASS} />
        </div>

        {error && (
          <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</p>
        )}

        <div className="flex justify-end gap-3 pt-2">
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
            className="px-5 py-2 text-sm font-medium text-white rounded-lg shadow-sm transition-colors disabled:opacity-50"
            style={{ backgroundColor: "#16a34a" }}
          >
            {isSubmitting ? "Saving..." : "Save changes"}
          </button>
        </div>
      </fetcher.Form>
    </ModalShell>
  );
}

// ─── Payment update modal ────────────────────────────────────────────────────

function PaymentUpdateModal({
  paymentMethod,
  onClose,
  onSent,
}: {
  paymentMethod: PaymentMethod;
  onClose: () => void;
  onSent: (pmId: number) => void;
}) {
  const fetcher = useFetcher();
  const isSubmitting = fetcher.state !== "idle";
  const prevState = useRef(fetcher.state);

  useEffect(() => {
    if (prevState.current === "loading" && fetcher.state === "idle" && fetcher.data) {
      const data = fetcher.data as { success?: boolean };
      if (data.success) onSent(paymentMethod.id);
    }
    prevState.current = fetcher.state;
  }, [fetcher.state, fetcher.data, onSent, paymentMethod.id]);

  const error = (fetcher.data as { error?: string } | undefined)?.error;

  return (
    <ModalShell title="Update payment method" onClose={onClose}>
      <div className="px-6 py-5 space-y-4">
        <div className="flex items-center gap-3 p-4 bg-stone-50 rounded-xl">
          <CardBrandIcon brand={paymentMethod.payment_details?.brand} />
          <div>
            <p className="text-sm font-medium text-stone-900">
              {paymentMethod.payment_details?.brand ?? "Card"} ending in {paymentMethod.payment_details?.last4 ?? "????"}
            </p>
            <p className="text-xs text-stone-400">
              Expires {paymentMethod.payment_details?.exp_month ?? "?"}/{paymentMethod.payment_details?.exp_year ?? "?"}
            </p>
          </div>
        </div>

        <div className="flex items-start gap-3 p-4 bg-blue-50 rounded-xl">
          <svg className="w-5 h-5 text-blue-500 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="m11.25 11.25.041-.02a.75.75 0 0 1 1.063.852l-.708 2.836a.75.75 0 0 0 1.063.853l.041-.021M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9-3.75h.008v.008H12V8.25Z" />
          </svg>
          <p className="text-sm text-blue-700">
            We'll send an email to <span className="font-medium">your address on file</span> with
            a secure link from Shopify to update your card details.
          </p>
        </div>

        {error && (
          <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</p>
        )}

        <fetcher.Form method="post">
          <input type="hidden" name="intent" value="send_payment_update" />
          <input type="hidden" name="paymentMethodId" value={paymentMethod.id} />

          <div className="flex justify-end gap-3 pt-2">
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
              className="px-5 py-2 text-sm font-medium text-white rounded-lg shadow-sm transition-colors disabled:opacity-50"
              style={{ backgroundColor: isSubmitting ? "#15803d" : "#16a34a" }}
            >
              {isSubmitting ? "Sending..." : "Send update email"}
            </button>
          </div>
        </fetcher.Form>
      </div>
    </ModalShell>
  );
}
