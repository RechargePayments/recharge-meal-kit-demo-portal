import { createCookieSessionStorage } from "@remix-run/node";

const sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret) {
  throw new Error(
    "SESSION_SECRET is not set. Generate one with `openssl rand -hex 32` and add it to .env."
  );
}

export type CustomerSession = {
  customerId: string;
  apiToken: string;
  apiTokenExpiresAt: number;
  email: string;
  pendingEmail?: string;
  pendingSessionToken?: string;
  flashError?: string;
};

export const sessionStorage = createCookieSessionStorage<CustomerSession>({
  cookie: {
    name: "__demo_portal_session",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    secrets: [sessionSecret],
    maxAge: 60 * 60 * 24 * 7,
    path: "/",
  },
});

export const { getSession, commitSession, destroySession } = sessionStorage;
