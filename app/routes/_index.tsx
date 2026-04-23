import type { ActionFunctionArgs, MetaFunction } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { Form, Link } from "@remix-run/react";

export const meta: MetaFunction = () => [{ title: "Future Charge Portal — Demo" }];

export async function action({ request }: ActionFunctionArgs) {
  const formData = await request.formData();
  const customerId = formData.get("customerId");
  if (typeof customerId !== "string" || !customerId.trim()) return null;
  return redirect(`/${customerId.trim()}`);
}

export default function Index() {
  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center">
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-8 w-full max-w-sm">
        <div className="flex items-center gap-2 mb-1">
          <div className="w-7 h-7 bg-indigo-600 rounded-lg flex items-center justify-center flex-none">
            <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </div>
          <span className="text-sm font-semibold text-gray-900">Subscription Portal</span>
          <span className="text-xs bg-amber-100 text-amber-700 font-medium px-1.5 py-0.5 rounded">Demo</span>
        </div>
        <p className="text-sm text-gray-500 mb-6 mt-3">Enter a Recharge customer ID to get started.</p>
        <Form method="post" className="flex gap-2">
          <input
            name="customerId"
            type="text"
            placeholder="e.g. 246712155"
            autoFocus
            className="flex-1 border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
          />
          <button
            type="submit"
            className="text-sm font-medium bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-xl transition-colors"
          >
            Go
          </button>
        </Form>
        <div className="mt-4 pt-4 border-t border-gray-100 text-center">
          <Link
            to="/merchant"
            className="text-xs text-gray-400 hover:text-indigo-600 transition-colors"
          >
            Merchant portal →
          </Link>
        </div>
      </div>
    </div>
  );
}
