import { redirect } from "@remix-run/node";
import {
  initRecharge,
  sendPasswordlessCode,
  validatePasswordlessCode,
  type Session as RechargeSession,
} from "@rechargeapps/storefront-client";
import { getSession, commitSession, destroySession } from "./session.server";

const storeIdentifier = process.env.SHOPIFY_STORE_DOMAIN;
const storefrontAccessToken = process.env.RECHARGE_STOREFRONT_ACCESS_TOKEN;

if (!storeIdentifier) {
  throw new Error("SHOPIFY_STORE_DOMAIN must be set in .env");
}

initRecharge({
  storeIdentifier,
  storefrontAccessToken: storefrontAccessToken || undefined,
  appName: "future-charge-manipulation-demo-portal",
});

// Recharge issues ~1h tokens. Use 55 min as a conservative TTL so the cookie's
// `apiTokenExpiresAt` always trips slightly before the server-side token actually expires.
const APITOKEN_TTL_MS = 55 * 60 * 1000;

function assertStorefrontTokenConfigured() {
  if (!storefrontAccessToken) {
    throw new Error(
      "RECHARGE_STOREFRONT_ACCESS_TOKEN is not set. Create one in the Recharge admin (must start with `strfnt`) and add it to .env."
    );
  }
}

export async function startPasswordlessLogin(email: string): Promise<string> {
  assertStorefrontTokenConfigured();
  return sendPasswordlessCode(email, { send_email: true });
}

export type ResolvedCustomerSession = {
  apiToken: string;
  customerId: string;
  apiTokenExpiresAt: number;
  email: string;
};

export async function completePasswordlessLogin(
  email: string,
  sessionToken: string,
  code: string
): Promise<ResolvedCustomerSession> {
  assertStorefrontTokenConfigured();
  const result = await validatePasswordlessCode(email, sessionToken, code);
  if (!result.apiToken || !result.customerId) {
    throw new Error("Recharge did not return a valid session");
  }
  return {
    apiToken: result.apiToken,
    customerId: String(result.customerId),
    apiTokenExpiresAt: Date.now() + APITOKEN_TTL_MS,
    email,
  };
}

export type AuthenticatedCustomer = {
  apiToken: string;
  customerId: string;
  email: string;
  rechargeSession: RechargeSession;
};

function buildLoginRedirect(request: Request, reason: "required" | "expired"): never {
  const url = new URL(request.url);
  const next = url.pathname + url.search;
  const params = new URLSearchParams({ reason });
  if (next && next !== "/" && next !== "/login") params.set("next", next);
  throw redirect(`/login?${params.toString()}`);
}

export async function requireCustomer(request: Request): Promise<AuthenticatedCustomer> {
  const cookie = await getSession(request.headers.get("Cookie"));
  const apiToken = cookie.get("apiToken");
  const customerId = cookie.get("customerId");
  const expiresAt = cookie.get("apiTokenExpiresAt") ?? 0;
  const email = cookie.get("email") ?? "";

  if (!apiToken || !customerId) buildLoginRedirect(request, "required");
  if (Date.now() >= expiresAt) buildLoginRedirect(request, "expired");

  return {
    apiToken: apiToken!,
    customerId: customerId!,
    email,
    rechargeSession: { apiToken: apiToken!, customerId: customerId! },
  };
}

export async function requireCustomerOwnsId(
  request: Request,
  urlCustomerId: string
): Promise<AuthenticatedCustomer> {
  const auth = await requireCustomer(request);
  if (auth.customerId !== urlCustomerId) {
    throw new Response("Not Found", { status: 404 });
  }
  return auth;
}

export async function getOptionalCustomer(
  request: Request
): Promise<AuthenticatedCustomer | null> {
  const cookie = await getSession(request.headers.get("Cookie"));
  const apiToken = cookie.get("apiToken");
  const customerId = cookie.get("customerId");
  const expiresAt = cookie.get("apiTokenExpiresAt") ?? 0;
  const email = cookie.get("email") ?? "";
  if (!apiToken || !customerId || Date.now() >= expiresAt) return null;
  return {
    apiToken,
    customerId,
    email,
    rechargeSession: { apiToken, customerId },
  };
}

export { getSession, commitSession, destroySession };
