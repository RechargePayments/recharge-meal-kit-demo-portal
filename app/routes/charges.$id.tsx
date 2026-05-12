import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { getCharge } from "~/lib/recharge.server";
import { requireCustomer } from "~/lib/auth.server";

export async function loader({ params, request }: LoaderFunctionArgs) {
  const { id } = params;
  if (!id) throw new Response("Missing charge ID", { status: 400 });

  const auth = await requireCustomer(request);
  const charge = await getCharge(id);
  const chargeCustomerId = charge.customer?.id ? String(charge.customer.id) : null;

  if (!chargeCustomerId || chargeCustomerId !== auth.customerId) {
    throw new Response("Not Found", { status: 404 });
  }

  return redirect(`/${chargeCustomerId}?week=${charge.id}`);
}
