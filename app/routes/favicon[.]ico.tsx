import type { LoaderFunctionArgs } from "@remix-run/node";

/**
 * Browsers request /favicon.ico automatically. Without this route, the root
 * `$customerId` segment would treat "favicon.ico" as a customer id and call Recharge.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method Not Allowed", { status: 405 });
  }
  return new Response(null, { status: 204 });
}
