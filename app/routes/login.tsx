import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { Form, Link, useActionData, useLoaderData, useNavigation, useSearchParams } from "@remix-run/react";
import {
  commitSession,
  getOptionalCustomer,
  getSession,
  startPasswordlessLogin,
} from "~/lib/auth.server";

export const meta: MetaFunction = () => [{ title: "Sign in — Recharge Meals" }];

export async function loader({ request }: LoaderFunctionArgs) {
  const auth = await getOptionalCustomer(request);
  if (auth) {
    const url = new URL(request.url);
    const next = url.searchParams.get("next");
    return redirect(next && next.startsWith("/") ? next : `/${auth.customerId}`);
  }

  const cookie = await getSession(request.headers.get("Cookie"));
  const pendingEmail = cookie.get("pendingEmail") ?? "";
  return json({ pendingEmail });
}

export async function action({ request }: ActionFunctionArgs) {
  const formData = await request.formData();
  const email = String(formData.get("email") ?? "").trim();
  const next = String(formData.get("next") ?? "");

  if (!email) {
    return json({ error: "Please enter an email address." }, { status: 400 });
  }

  let sessionToken: string;
  try {
    sessionToken = await startPasswordlessLogin(email);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not start sign-in.";
    return json({ error: message }, { status: 502 });
  }

  const cookie = await getSession(request.headers.get("Cookie"));
  cookie.set("pendingEmail", email);
  cookie.set("pendingSessionToken", sessionToken);

  const verifyUrl = next ? `/login/verify?next=${encodeURIComponent(next)}` : "/login/verify";
  return redirect(verifyUrl, { headers: { "Set-Cookie": await commitSession(cookie) } });
}

export default function LoginPage() {
  const { pendingEmail } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const [searchParams] = useSearchParams();
  const isSubmitting = navigation.state === "submitting";

  const reason = searchParams.get("reason");
  const next = searchParams.get("next") ?? "";
  const expired = reason === "expired";
  const required = reason === "required";

  return (
    <div className="min-h-screen bg-cream flex items-center justify-center px-4 py-10 relative overflow-hidden">
      <div className="pointer-events-none absolute -top-32 -right-24 w-[28rem] h-[28rem] rounded-full bg-brand-200/50 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-32 -left-24 w-[26rem] h-[26rem] rounded-full bg-accent/15 blur-3xl" />
      <div className="pointer-events-none absolute inset-0 bg-grain opacity-60" />

      <div className="relative w-full max-w-md animate-fade-in">
        <div className="bg-white/90 backdrop-blur-sm rounded-3xl shadow-warm-lg border border-stone-100 p-8 sm:p-10">
          <div className="flex justify-center mb-6">
            <img
              src="/logo.png"
              alt="Recharge Meals"
              className="h-14 sm:h-16 w-auto"
            />
          </div>

          <div className="text-center mb-7">
            <h1 className="text-2xl sm:text-[28px] font-display font-bold text-stone-900 tracking-tight">
              Welcome back
            </h1>
            <p className="text-stone-500 mt-1.5 text-sm">
              Sign in to manage your upcoming deliveries.
            </p>
          </div>

          {(expired || required) && !actionData?.error && (
            <div className="mb-5 rounded-2xl bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-900 animate-slide-up">
              {expired ? "Your session expired. Please sign in again." : "Please sign in to continue."}
            </div>
          )}

          <Form method="post" className="space-y-4">
            <input type="hidden" name="next" value={next} />
            <div>
              <label htmlFor="email" className="block text-sm font-medium text-stone-700 mb-1.5">
                Email address
              </label>
              <input
                id="email"
                name="email"
                type="email"
                placeholder="you@example.com"
                defaultValue={pendingEmail}
                autoFocus
                required
                className="w-full rounded-2xl border border-stone-200 bg-white px-4 py-3 text-sm text-stone-800 placeholder:text-stone-400 focus:outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-brand-500 transition-shadow"
              />
              <p className="mt-2 text-xs text-stone-500">
                We&apos;ll email you a 6-digit code to confirm it&apos;s you.
              </p>
            </div>
            <button type="submit" disabled={isSubmitting} className="btn-primary w-full py-3.5">
              {isSubmitting ? (
                <>
                  <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  Sending code…
                </>
              ) : (
                "Send sign-in code"
              )}
            </button>
          </Form>

          {actionData?.error && (
            <div className="mt-4 rounded-2xl bg-red-50 border border-red-200 px-4 py-3 flex items-center gap-2 animate-slide-up">
              <svg className="w-4 h-4 text-red-500 flex-none" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <p className="text-sm text-red-700">{actionData.error}</p>
            </div>
          )}
        </div>

        <div className="mt-6 flex items-center justify-center gap-4 text-xs text-stone-400">
          <span>Real food. Real fuel. Delivered.</span>
          <span aria-hidden="true">·</span>
          <Link to="/merchant" className="hover:text-brand-700 transition-colors">
            Merchant portal →
          </Link>
        </div>
      </div>
    </div>
  );
}
