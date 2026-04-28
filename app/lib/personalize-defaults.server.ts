import type { CustomerPreference } from "./customer-preferences.server";
import type { BundleItemPayload } from "./types";

export type SortedProduct = {
  collection_id: string;
  external_product_id: string;
  external_variant_id: string;
  tags: string[];
};

function matchesTags(itemTags: string[], prefTags: string[]): boolean {
  return itemTags.some((t) =>
    prefTags.some((p) => p.toLowerCase() === t.toLowerCase())
  );
}

/**
 * Build a personalized bundle selection from a priority-sorted product list.
 *
 * 1. Hard-exclude products matching the customer's exclude tags
 * 2. Boost products matching include tags to the front (stable order)
 * 3. Take the first `targetQuantity` items, each with quantity 1
 */
export function computePersonalizedSelection(
  sortedProducts: SortedProduct[],
  targetQuantity: number,
  preferences: CustomerPreference | null
): BundleItemPayload[] {
  let candidates = sortedProducts;

  if (preferences) {
    if (preferences.exclude.length > 0) {
      candidates = candidates.filter(
        (p) => !matchesTags(p.tags, preferences.exclude)
      );
    }

    if (preferences.include.length > 0) {
      const included: SortedProduct[] = [];
      const neutral: SortedProduct[] = [];
      for (const p of candidates) {
        if (matchesTags(p.tags, preferences.include)) {
          included.push(p);
        } else {
          neutral.push(p);
        }
      }
      candidates = [...included, ...neutral];
    }
  }

  return candidates.slice(0, targetQuantity).map((p) => ({
    collection_id: p.collection_id,
    collection_source: "shopify",
    external_product_id: p.external_product_id,
    external_variant_id: p.external_variant_id,
    quantity: 1,
  }));
}
