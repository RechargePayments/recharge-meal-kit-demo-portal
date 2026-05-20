import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { Form, Link, useActionData, useLoaderData, useNavigation, useSearchParams } from "@remix-run/react";
import {
  commitSession,
  completePasswordlessLogin,
  getSession,
  startPasswordlessLogin,
} from "~/lib/auth.server";

export const meta: MetaFunction = () => [{ title: "Verify code — Recharge Meals" }];

export async function loader({ request }: LoaderFunctionArgs) {
  const cookie = await getSession(request.headers.get("Cookie"));
  const pendingEmail = cookie.get("pendingEmail");
  const pendingSessionToken = cookie.get("pendingSessionToken");

  if (!pendingEmail || !pendingSessionToken) {
    const url = new URL(request.url);
    const next = url.searchParams.get("next");
    return redirect(next ? `/login?next=${encodeURIComponent(next)}` : "/login");
  }
  return json({ pendingEmail });
}

export async function action({ request }: ActionFunctionArgs) {
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "verify");
  const cookie = await getSession(request.headers.get("Cookie"));
  const pendingEmail = cookie.get("pendingEmail");
  const pendingSessionToken = cookie.get("pendingSessionToken");

  if (!pendingEmail || !pendingSessionToken) {
    return redirect("/login");
  }

  if (intent === "resend") {
    try {
      const newToken = await startPasswordlessLogin(pendingEmail);
      cookie.set("pendingSessionToken", newToken);
      cookie.set("flashError", "");
      return json(
        { resent: true as const, error: null },
        { headers: { "Set-Cookie": await commitSession(cookie) } }
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not resend code.";
      return json({ resent: false as const, error: message }, { status: 502 });
    }
  }

  const code = String(formData.get("code") ?? "").trim();
  if (!code) {
    return json({ resent: false as const, error: "Please enter the code from your email." }, { status: 400 });
  }

  try {
    const resolved = await completePasswordlessLogin(pendingEmail, pendingSessionToken, code);
    cookie.set("customerId", resolved.customerId);
    cookie.set("apiToken", resolved.apiToken);
    cookie.set("apiTokenExpiresAt", resolved.apiTokenExpiresAt);
    cookie.set("email", resolved.email);
    cookie.unset("pendingEmail");
    cookie.unset("pendingSessionToken");

    const url = new URL(request.url);
    const next = url.searchParams.get("next");
    const destination = next && next.startsWith("/") ? next : `/${resolved.customerId}`;
    return redirect(destination, { headers: { "Set-Cookie": await commitSession(cookie) } });
  } catch (err) {
    const raw = err instanceof Error ? err.message : "Could not verify code.";
    const friendly = /code|invalid|expired/i.test(raw)
      ? "That code didn't match or expired. Please try again or request a new one."
      : raw;
    return json({ resent: false as const, error: friendly }, { status: 400 });
  }
}

export default function VerifyPage() {
  const { pendingEmail } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const [searchParams] = useSearchParams();
  const next = searchParams.get("next") ?? "";
  const submittedIntent =
    typeof navigation.formData?.get === "function"
      ? String(navigation.formData?.get("intent") ?? "verify")
      : "verify";
  const isVerifying = navigation.state === "submitting" && submittedIntent === "verify";
  const isResending = navigation.state === "submitting" && submittedIntent === "resend";

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
              Check your inbox
            </h1>
            <p className="text-stone-500 mt-1.5 text-sm">
              We sent a 6-digit code to{" "}
              <span className="font-medium text-stone-700">{pendingEmail}</span>.
            </p>
            <p className="mt-2 text-xs text-stone-400">
              <Link
                to={next ? `/login?next=${encodeURIComponent(next)}` : "/login"}
                className="hover:text-brand-700 transition-colors"
              >
                ← Use a different email
              </Link>
            </p>
          </div>

          {actionData && "resent" in actionData && actionData.resent && (
            <div className="mb-5 rounded-2xl bg-emerald-50 border border-emerald-200 px-4 py-3 text-sm text-emerald-800 animate-slide-up">
              A new code is on its way.
            </div>
          )}

          <Form method="post" className="space-y-4">
            <input type="hidden" name="intent" value="verify" />
            <div>
              <label htmlFor="code" className="block text-sm font-medium text-stone-700 mb-1.5">
                Verification code
              </label>
              <input
                id="code"
                name="code"
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                autoComplete="one-time-code"
                placeholder="000000"
                autoFocus
                required
                maxLength={8}
                className="w-full rounded-2xl border border-stone-200 bg-white px-4 py-3 text-center text-lg font-mono tracking-[0.4em] text-stone-800 placeholder:text-stone-300 focus:outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-brand-500 transition-shadow"
              />
            </div>
            <button type="submit" disabled={isVerifying} className="btn-primary w-full py-3.5">
              {isVerifying ? (
                <>
                  <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  Verifying…
                </>
              ) : (
                "Verify and sign in"
              )}
            </button>
          </Form>

          <Form method="post" className="mt-3">
            <input type="hidden" name="intent" value="resend" />
            <button
              type="submit"
              disabled={isResending}
              className="w-full text-sm text-stone-500 hover:text-brand-700 transition-colors py-2 disabled:opacity-50"
            >
              {isResending ? "Resending…" : "Didn't get it? Resend code"}
            </button>
          </Form>

          {actionData && "error" in actionData && actionData.error && (
            <div className="mt-4 rounded-2xl bg-red-50 border border-red-200 px-4 py-3 flex items-center gap-2 animate-slide-up">
              <svg className="w-4 h-4 text-red-500 flex-none" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <p className="text-sm text-red-700">{actionData.error}</p>
            </div>
          )}
        </div>

        <div className="mt-6 text-center text-xs text-stone-400">
          Real food. Real fuel. Delivered.
        </div>
      </div>
    </div>
  );
}
