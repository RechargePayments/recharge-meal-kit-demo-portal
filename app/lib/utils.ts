export function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function formatCurrency(amount: string | number, currency = "USD"): string {
  const value = typeof amount === "string" ? parseFloat(amount) : amount;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
  }).format(value);
}

export function cn(...classes: (string | undefined | null | false)[]): string {
  return classes.filter(Boolean).join(" ");
}

/** Shorten a Shopify-style external ID for display: "gid://shopify/Product/12345" → "#12345" */
export function shortId(externalId: string | undefined | null): string {
  if (!externalId) return "—";
  const parts = externalId.split("/");
  return `#${parts[parts.length - 1]}`;
}
