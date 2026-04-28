import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { getCharge } from "~/lib/recharge.server";

export async function loader({ params }: LoaderFunctionArgs) {
  const { id } = params;
  if (!id) throw new Response("Missing charge ID", { status: 400 });

  const charge = await getCharge(id);
  const customerId = charge.customer?.id;

  if (customerId) {
    return redirect(`/${customerId}?week=${charge.id}`);
  }

  return redirect(`/`);
}
