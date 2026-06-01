import { getCustomer } from "./recharge.server";
import { getCustomerTags, setCustomerTags } from "./shopify.server";
import type { Customer } from "./types";

/**
 * Customer dietary preferences are stored as Shopify customer tags and are
 * exclude-only: an ingredient the customer wants kept out of their bundles.
 *
 * Each excluded ingredient is encoded as a `rc_exclude_<slug>` tag, where the
 * slug is the lowercased ingredient with spaces replaced by underscores. The
 * slug (de-slugged back to a label) is matched case-insensitively against
 * Shopify product tags. For example, the customer tag `rc_exclude_eggs`
 * excludes every product carrying an `eggs` tag.
 */
export type CustomerPreference = { exclude: string[] };

const EXCLUDE_TAG_PREFIX = "rc_exclude_";

function toExcludeTag(label: string): string {
  const slug = label.trim().toLowerCase().replace(/\s+/g, "_");
  return `${EXCLUDE_TAG_PREFIX}${slug}`;
}

function isExcludeTag(tag: string): boolean {
  return tag.toLowerCase().startsWith(EXCLUDE_TAG_PREFIX);
}

function fromExcludeTag(tag: string): string {
  const slug = tag.slice(EXCLUDE_TAG_PREFIX.length).replace(/_/g, " ");
  return slug.replace(/\b\w/g, (c) => c.toUpperCase());
}

function shopifyCustomerIdOf(customer: Customer | null): string | null {
  return customer?.external_customer_id?.ecommerce ?? null;
}

/**
 * Read exclusion preferences from an already-loaded Recharge customer. Preferred
 * entry point for callers that have the customer in hand (e.g. the subscriber
 * loader) since it avoids a redundant Recharge fetch.
 */
export async function getCustomerPreferences(
  customer: Customer | null
): Promise<CustomerPreference | null> {
  const shopifyCustomerId = shopifyCustomerIdOf(customer);
  if (!shopifyCustomerId) return null;

  const tags = await getCustomerTags(shopifyCustomerId);
  const exclude = tags.filter(isExcludeTag).map(fromExcludeTag);
  return { exclude };
}

/**
 * Read exclusion preferences when only the Recharge customer id is known
 * (e.g. the merchant apply-defaults flow, which iterates charges).
 */
export async function getCustomerPreferencesById(
  customerId: string | null
): Promise<CustomerPreference | null> {
  if (!customerId) return null;
  const customer = await getCustomer(customerId);
  return getCustomerPreferences(customer);
}

export async function saveCustomerPreferences(customerId: string, exclude: string[]): Promise<void> {
  const customer = await getCustomer(customerId);
  const shopifyCustomerId = shopifyCustomerIdOf(customer);
  if (!shopifyCustomerId) {
    throw new Error(`Customer ${customerId} has no linked Shopify customer; cannot save preferences`);
  }

  const existingTags = await getCustomerTags(shopifyCustomerId);
  const preservedTags = existingTags.filter((t) => !isExcludeTag(t));
  const excludeTags = exclude.map(toExcludeTag);
  await setCustomerTags(shopifyCustomerId, [...preservedTags, ...excludeTags]);
}
