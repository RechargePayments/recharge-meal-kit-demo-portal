import type { ActionFunctionArgs, MetaFunction } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { Form, Link, useActionData, useNavigation } from "@remix-run/react";
import { getCustomerByEmail } from "~/lib/recharge.server";

export const meta: MetaFunction = () => [{ title: "NourishBox — Your weekly box, your way" }];

export async function action({ request }: ActionFunctionArgs) {
  const formData = await request.formData();
  const email = formData.get("email");
  if (typeof email !== "string" || !email.trim()) return null;
  const customer = await getCustomerByEmail(email.trim());
  if (!customer) return { error: "No customer found with that email." };
  return redirect(`/${customer.id}`);
}

function LeafIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 32 32" fill="none">
      <path
        d="M16 2C10 2 4 8 4 16c0 6 4 12 12 14C24 28 28 22 28 16 28 8 22 2 16 2z"
        fill="currentColor"
        opacity="0.15"
      />
      <path
        d="M8 24C10 14 18 6 28 4c0 0-2 10-8 16s-12 8-12 8z"
        fill="currentColor"
        opacity="0.9"
      />
      <path
        d="M12 26C14 20 18 14 26 8"
        stroke="white"
        strokeWidth="1.5"
        strokeLinecap="round"
        opacity="0.6"
      />
    </svg>
  );
}

export default function Index() {
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  return (
    <div className="min-h-screen flex flex-col lg:flex-row">
      {/* Left: Brand hero */}
      <div className="relative flex-1 bg-gradient-to-br from-brand-800 via-brand-700 to-brand-600 flex items-center justify-center p-8 lg:p-16 overflow-hidden">
        {/* Decorative circles */}
        <div className="absolute top-0 right-0 w-96 h-96 bg-brand-500/20 rounded-full -translate-y-1/2 translate-x-1/3" />
        <div className="absolute bottom-0 left-0 w-72 h-72 bg-brand-400/10 rounded-full translate-y-1/3 -translate-x-1/4" />
        <div className="absolute top-1/2 left-1/4 w-48 h-48 bg-accent/10 rounded-full" />

        <div className="relative z-10 text-center lg:text-left max-w-md">
          <div className="flex items-center gap-3 justify-center lg:justify-start mb-8">
            <LeafIcon className="w-10 h-10 text-brand-300" />
            <span className="text-2xl font-display font-bold text-white tracking-tight">
              NourishBox
            </span>
          </div>
          <h1 className="text-3xl lg:text-5xl font-display font-bold text-white leading-tight mb-4">
            Your weekly box,
            <br />
            <span className="text-brand-300">your way.</span>
          </h1>
          <p className="text-brand-200/80 text-lg leading-relaxed">
            Choose your favorite chef-crafted meals, customize every delivery, and eat well without the effort.
          </p>

          {/* Floating meal previews */}
          <div className="hidden lg:flex items-center gap-3 mt-10">
            {["Herb Chicken", "Salmon Bowl", "Veggie Risotto"].map((name, i) => (
              <div
                key={name}
                className="bg-white/10 backdrop-blur-sm rounded-2xl p-3 border border-white/10"
                style={{ animationDelay: `${i * 0.15}s` }}
              >
                <div className="w-16 h-16 rounded-xl bg-white/10 flex items-center justify-center mb-2">
                  <svg className="w-8 h-8 text-brand-300/60" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
                  </svg>
                </div>
                <p className="text-xs text-white/70 font-medium text-center">{name}</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Right: Login form */}
      <div className="flex items-center justify-center p-8 lg:p-16 lg:w-[480px] lg:flex-none">
        <div className="w-full max-w-sm animate-fade-in">
          <div className="flex items-center gap-2 lg:hidden mb-8">
            <LeafIcon className="w-7 h-7 text-brand-600" />
            <span className="text-lg font-display font-bold text-stone-900">NourishBox</span>
          </div>

          <h2 className="text-2xl font-display font-bold text-stone-900 mb-2">
            Welcome back
          </h2>
          <p className="text-stone-500 mb-8">
            Sign in to manage your upcoming deliveries.
          </p>

          <Form method="post" className="space-y-4">
            <div>
              <label htmlFor="email" className="block text-sm font-medium text-stone-700 mb-1.5">
                Email address
              </label>
              <input
                id="email"
                name="email"
                type="email"
                placeholder="you@example.com"
                autoFocus
                required
                className="w-full rounded-2xl border border-stone-200 bg-white px-4 py-3 text-sm text-stone-800 placeholder:text-stone-400 focus:outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-brand-500 transition-shadow"
              />
            </div>
            <button
              type="submit"
              disabled={isSubmitting}
              className="btn-primary w-full py-3.5"
            >
              {isSubmitting ? (
                <>
                  <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  Signing in...
                </>
              ) : (
                "Sign in"
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

          <div className="mt-8 pt-6 border-t border-stone-100 text-center">
            <Link
              to="/merchant"
              className="text-xs text-stone-400 hover:text-brand-600 transition-colors"
            >
              Merchant portal →
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
