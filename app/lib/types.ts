import { z } from "zod";

// ─── Customer ─────────────────────────────────────────────────────────────────

export const CustomerSchema = z.object({
  id: z.number(),
  first_name: z.string(),
  last_name: z.string(),
  email: z.string(),
  has_valid_payment_method: z.boolean(),
  has_payment_method_in_dunning: z.boolean(),
  subscriptions_active_count: z.number(),
  subscriptions_total_count: z.number(),
});

export type Customer = z.infer<typeof CustomerSchema>;

// ─── Subscription ─────────────────────────────────────────────────────────────

export const PropertySchema = z.object({
  name: z.string(),
  value: z.string(),
});

export type Property = z.infer<typeof PropertySchema>;

export const SubscriptionSchema = z.object({
  id: z.number(),
  address_id: z.number(),
  customer_id: z.number(),
  status: z.enum(["active", "cancelled", "expired"]),
  product_title: z.string(),
  variant_title: z.string().nullable().optional(),
  price: z.string(),
  quantity: z.number(),
  next_charge_scheduled_at: z.string().nullable().optional(),
  charge_interval_frequency: z.number().nullable().optional(),
  order_interval_unit: z.enum(["day", "week", "month"]).nullable().optional(),
  has_queued_charges: z.boolean().nullable().optional(),
  is_skippable: z.boolean().nullable().optional(),
  is_swappable: z.boolean().nullable().optional(),
  sku: z.string().nullable().optional(),
  properties: z.array(PropertySchema).optional(),
});

export type Subscription = z.infer<typeof SubscriptionSchema>;

// ─── Charge ───────────────────────────────────────────────────────────────────

export const ChargeLineItemSchema = z.object({
  purchase_item_id: z.number(),
  purchase_item_type: z.string().optional(),
  title: z.string(),
  variant_title: z.string().nullable().optional(),
  quantity: z.number(),
  unit_price: z.string(),
  total_price: z.string(),
  sku: z.string().nullable().optional(),
  images: z
    .object({
      small: z.string().nullable().optional(),
      medium: z.string().nullable().optional(),
      large: z.string().nullable().optional(),
      original: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
  external_product_id: z
    .object({ ecommerce: z.string().nullable().optional() })
    .nullable()
    .optional(),
  external_variant_id: z
    .object({ ecommerce: z.string().nullable().optional() })
    .nullable()
    .optional(),
});

export type ChargeLineItem = z.infer<typeof ChargeLineItemSchema>;

export const ChargeStatusSchema = z.enum([
  "queued",
  "success",
  "error",
  "skipped",
  "refunded",
  "partially_refunded",
  "pending_manual_payment",
  "pending",
]);

export const ChargeSchema = z.object({
  id: z.number(),
  status: ChargeStatusSchema,
  scheduled_at: z.string(),
  total_price: z.string(),
  subtotal_price: z.string().nullable().optional(),
  total_tax: z.string().nullable().optional(),
  currency: z.string().nullable().optional(),
  line_items: z.array(ChargeLineItemSchema),
  has_uncommitted_changes: z.boolean().nullable().optional(),
  customer: z.object({ id: z.number() }).nullable().optional(),
  address_id: z.number().nullable().optional(),
  error: z.string().nullable().optional(),
  error_type: z.string().nullable().optional(),
  retry_date: z.string().nullable().optional(),
  processed_at: z.string().nullable().optional(),
});

export type Charge = z.infer<typeof ChargeSchema>;

// ─── Bundle Selection ─────────────────────────────────────────────────────────

export const BundleSelectionItemSchema = z.object({
  id: z.number(),
  collection_id: z.string(),
  collection_source: z.string(),
  external_product_id: z.string(),
  external_variant_id: z.string(),
  quantity: z.number(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
});

export type BundleSelectionItem = z.infer<typeof BundleSelectionItemSchema>;

export const BundleSelectionSchema = z.object({
  id: z.number(),
  purchase_item_id: z.number(),
  bundle_variant: z.number().optional(),
  external_product_id: z.string().nullable().optional(),
  external_variant_id: z.string().nullable().optional(),
  items: z.array(BundleSelectionItemSchema),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
});

export type BundleSelection = z.infer<typeof BundleSelectionSchema>;

// ─── Bundle Collections ───────────────────────────────────────────────────────

export const BundleCollectionVariantSchema = z.object({
  id: z.number(),
  title: z.string(),
  sku: z.string().optional(),
  external_product_id: z.string(),
  prices: z
    .object({
      unit_price: z.string(),
      compare_at_price: z.string().nullable(),
      discounted_price: z.string(),
    })
    .optional(),
});

export type BundleCollectionVariant = z.infer<typeof BundleCollectionVariantSchema>;

export const BundleCollectionProductSchema = z.object({
  id: z.number(),
  external_product_id: z.string(),
  title: z.string(),
  image_url: z.string().nullable().optional(),
  tags: z.array(z.string()).optional(),
  variants: z.array(BundleCollectionVariantSchema),
});

export type BundleCollectionProduct = z.infer<typeof BundleCollectionProductSchema>;

export const BundleCollectionSchema = z.object({
  id: z.string(),
  title: z.string(),
  products: z.array(BundleCollectionProductSchema),
});

export type BundleCollection = z.infer<typeof BundleCollectionSchema>;

// ─── API update payload ───────────────────────────────────────────────────────

export type BundleItemPayload = Pick<
  BundleSelectionItem,
  "collection_id" | "collection_source" | "external_product_id" | "external_variant_id" | "quantity"
>;
