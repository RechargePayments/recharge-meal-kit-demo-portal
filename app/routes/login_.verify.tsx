import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { Form, Link, useActionData, useLoaderData, useNavigation, useSearchParams } from "@remix-run/react";
import {
  commitSession,
  completePasswordlessLogin,
  getSession,
  startPasswordlessLogin,
} from "~/lib/auth.server";

export const meta: MetaFunction = () => [{ title: "Verify code — NourishBox" }];

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

function LeafIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 32 32" fill="none">
      <path d="M16 2C10 2 4 8 4 16c0 6 4 12 12 14C24 28 28 22 28 16 28 8 22 2 16 2z" fill="currentColor" opacity="0.15" />
      <path d="M8 24C10 14 18 6 28 4c0 0-2 10-8 16s-12 8-12 8z" fill="currentColor" opacity="0.9" />
      <path d="M12 26C14 20 18 14 26 8" stroke="white" strokeWidth="1.5" strokeLinecap="round" opacity="0.6" />
    </svg>
  );
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
    <div className="min-h-screen flex flex-col lg:flex-row">
      <div className="relative flex-1 bg-gradient-to-br from-brand-800 via-brand-700 to-brand-600 flex items-center justify-center p-8 lg:p-16 overflow-hidden">
        <div className="absolute top-0 right-0 w-96 h-96 bg-brand-500/20 rounded-full -translate-y-1/2 translate-x-1/3" />
        <div className="absolute bottom-0 left-0 w-72 h-72 bg-brand-400/10 rounded-full translate-y-1/3 -translate-x-1/4" />
        <div className="relative z-10 text-center lg:text-left max-w-md">
          <div className="flex items-center gap-3 justify-center lg:justify-start mb-8">
            <LeafIcon className="w-10 h-10 text-brand-300" />
            <span className="text-2xl font-display font-bold text-white tracking-tight">NourishBox</span>
          </div>
          <h1 className="text-3xl lg:text-5xl font-display font-bold text-white leading-tight mb-4">
            Check your inbox.
          </h1>
          <p className="text-brand-200/80 text-lg leading-relaxed">
            We sent a 6-digit code to confirm it&apos;s really you. Enter it on the right to finish signing in.
          </p>
        </div>
      </div>

      <div className="flex items-center justify-center p-8 lg:p-16 lg:w-[480px] lg:flex-none">
        <div className="w-full max-w-sm animate-fade-in">
          <div className="flex items-center gap-2 lg:hidden mb-8">
            <LeafIcon className="w-7 h-7 text-brand-600" />
            <span className="text-lg font-display font-bold text-stone-900">NourishBox</span>
          </div>

          <h2 className="text-2xl font-display font-bold text-stone-900 mb-2">Enter your code</h2>
          <p className="text-stone-500 mb-8">
            Sent to <span className="font-medium text-stone-700">{pendingEmail}</span>.{" "}
            <Link
              to={next ? `/login?next=${encodeURIComponent(next)}` : "/login"}
              className="text-brand-600 hover:text-brand-700"
            >
              Use a different email
            </Link>
            .
          </p>

          {actionData && "resent" in actionData && actionData.resent && (
            <div className="mb-4 rounded-2xl bg-emerald-50 border border-emerald-200 px-4 py-3 text-sm text-emerald-800">
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
                className="w-full rounded-2xl border border-stone-200 bg-white px-4 py-3 text-base font-mono tracking-[0.3em] text-stone-800 placeholder:text-stone-300 focus:outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-brand-500 transition-shadow"
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

          <Form method="post" className="mt-4">
            <input type="hidden" name="intent" value="resend" />
            <button
              type="submit"
              disabled={isResending}
              className="w-full text-sm text-stone-500 hover:text-brand-600 transition-colors py-2"
            >
              {isResending ? "Resending…" : "Resend code"}
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
      </div>
    </div>
  );
}
