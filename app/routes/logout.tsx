import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { destroySession, getSession } from "~/lib/auth.server";

async function clearAndRedirect(request: Request) {
  const cookie = await getSession(request.headers.get("Cookie"));
  return redirect("/login", { headers: { "Set-Cookie": await destroySession(cookie) } });
}

export async function action({ request }: ActionFunctionArgs) {
  return clearAndRedirect(request);
}

export async function loader({ request }: LoaderFunctionArgs) {
  return clearAndRedirect(request);
}
