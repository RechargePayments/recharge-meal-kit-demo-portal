import { z } from "zod";

let cachedToken: string | null = null;
let tokenExpiresAt = 0;

async function getAccessToken(): Promise<string> {
  if (cachedToken && Date.now() < tokenExpiresAt - 60_000) return cachedToken;

  const domain = process.env.SHOPIFY_STORE_DOMAIN;
  const clientId = process.env.SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;
  if (!domain || !clientId || !clientSecret) {
    throw new Error("SHOPIFY_STORE_DOMAIN, SHOPIFY_CLIENT_ID, and SHOPIFY_CLIENT_SECRET must all be set");
  }

  const res = await fetch(`https://${domain}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "client_credentials",
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Shopify token exchange failed ${res.status}: ${text}`);
  }
  const data = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + data.expires_in * 1000;
  return cachedToken;
}

async function shopifyFetch<T>(path: string): Promise<T> {
  const token = await getAccessToken();
  const domain = process.env.SHOPIFY_STORE_DOMAIN!;
  const res = await fetch(`https://${domain}/admin/api/2025-01${path}`, {
    headers: { "X-Shopify-Access-Token": token },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Shopify ${res.status} — ${path}: ${text}`);
  }
  return res.json() as Promise<T>;
}

const ShopifyVariantSchema = z.object({
  id: z.number(),
  title: z.string(),
  sku: z.string().nullable().optional(),
  price: z.string().optional(),
});

const ShopifyProductSchema = z.object({
  id: z.number(),
  title: z.string(),
  variants: z.array(ShopifyVariantSchema),
  image: z.object({ src: z.string() }).nullable().optional(),
  tags: z.preprocess(
    (v) => (typeof v === "string" ? v.split(",").map((t) => t.trim()).filter(Boolean) : v),
    z.array(z.string())
  ).optional(),
});

export type ShopifyProduct = z.infer<typeof ShopifyProductSchema>;

export async function getCollectionProducts(collectionId: string): Promise<ShopifyProduct[]> {
  const data = await shopifyFetch<{ products: unknown[] }>(
    `/products.json?collection_id=${collectionId}&fields=id,title,variants,image,tags&limit=250`
  );
  return z.array(ShopifyProductSchema).parse(data.products);
}

export async function getCollectionCollects(
  collectionId: string
): Promise<Map<number, number>> {
  const data = await shopifyFetch<{
    collects: Array<{ product_id: number; position: number }>;
  }>(`/collects.json?collection_id=${collectionId}&fields=product_id,position&limit=250`);
  return new Map(data.collects.map((c) => [c.product_id, c.position]));
}

export async function getCollectionProductsSorted(
  collectionId: string
): Promise<ShopifyProduct[]> {
  const [products, positionMap] = await Promise.all([
    getCollectionProducts(collectionId),
    getCollectionCollects(collectionId),
  ]);
  return products.sort(
    (a, b) => (positionMap.get(a.id) ?? Infinity) - (positionMap.get(b.id) ?? Infinity)
  );
}

const ShopifyCollectionSchema = z.object({
  id: z.number(),
  title: z.string(),
  handle: z.string(),
});

export type ShopifyCollection = z.infer<typeof ShopifyCollectionSchema>;

export async function listBundleCollections(): Promise<ShopifyCollection[]> {
  const data = await shopifyFetch<{ custom_collections: unknown[] }>(
    `/custom_collections.json?fields=id,title,handle&published_status=published&limit=250`
  );
  const collections = z.array(ShopifyCollectionSchema).parse(data.custom_collections);
  return collections;
}
