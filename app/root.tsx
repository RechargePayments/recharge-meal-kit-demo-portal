import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useRouteError,
} from "@remix-run/react";
import type { LinksFunction } from "@remix-run/node";
import stylesheet from "./tailwind.css?url";

export const links: LinksFunction = () => [
  { rel: "stylesheet", href: stylesheet },
];

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="h-full bg-gray-50">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body className="h-full antialiased text-gray-900">
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  return (
    <html lang="en">
      <head>
        <title>Error</title>
        <Meta />
        <Links />
      </head>
      <body className="p-8 bg-gray-50">
        <div className="max-w-lg mx-auto bg-white rounded-2xl border border-gray-200 p-8 shadow-sm">
          <h1 className="text-lg font-semibold text-red-600 mb-2">Something went wrong</h1>
          {isRouteErrorResponse(error) ? (
            <p className="text-sm text-gray-600">
              {error.status} — {error.data?.error ?? error.statusText}
            </p>
          ) : error instanceof Error ? (
            <p className="text-sm text-gray-600">{error.message}</p>
          ) : (
            <p className="text-sm text-gray-600">An unexpected error occurred.</p>
          )}
        </div>
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}
