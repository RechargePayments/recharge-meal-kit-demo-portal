import type { LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { getOptionalCustomer } from "~/lib/auth.server";

export const meta: MetaFunction = () => [{ title: "NourishBox" }];

export async function loader({ request }: LoaderFunctionArgs) {
  const auth = await getOptionalCustomer(request);
  if (auth) return redirect(`/${auth.customerId}`);
  return redirect("/login");
}

export default function Index() {
  return null;
}
