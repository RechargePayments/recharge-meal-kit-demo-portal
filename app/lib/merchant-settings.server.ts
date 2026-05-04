import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  DEFAULT_DELIVERY_OFFSET,
  DEFAULT_MODIFICATION_WINDOW,
  LEGACY_BUNDLE_VARIANT_ID,
} from "./bundle-config";

const STORE_PATH = join(process.cwd(), "data", "merchant-settings.json");

type BundleMerchantSettings = {
  deliveryDateOffset: number;
  modificationWindowDays: number;
};

type MerchantSettingsStore = {
  activeBundleVariantId: string | null;
  bundles: Record<string, BundleMerchantSettings>;
};

function defaultBundleSettings(): BundleMerchantSettings {
  return {
    deliveryDateOffset: DEFAULT_DELIVERY_OFFSET,
    modificationWindowDays: DEFAULT_MODIFICATION_WINDOW,
  };
}

function clampDeliveryOffset(value: number): number {
  return Math.max(1, Math.min(6, Math.round(value)));
}

function clampModificationWindow(value: number): number {
  return Math.max(0, Math.min(6, Math.round(value)));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function normalizeBundleSettings(value: unknown): BundleMerchantSettings {
  if (!isObject(value)) return defaultBundleSettings();
  return {
    deliveryDateOffset: clampDeliveryOffset(
      typeof value.deliveryDateOffset === "number"
        ? value.deliveryDateOffset
        : DEFAULT_DELIVERY_OFFSET
    ),
    modificationWindowDays: clampModificationWindow(
      typeof value.modificationWindowDays === "number"
        ? value.modificationWindowDays
        : DEFAULT_MODIFICATION_WINDOW
    ),
  };
}

function makeEmptyStore(): MerchantSettingsStore {
  return {
    activeBundleVariantId: null,
    bundles: {},
  };
}

function isLegacyStoreShape(raw: unknown): raw is {
  deliveryDateOffset?: number;
  modificationWindowDays?: number;
} {
  if (!isObject(raw)) return false;
  return "deliveryDateOffset" in raw || "modificationWindowDays" in raw;
}

function normalizeStore(raw: unknown): MerchantSettingsStore {
  if (!isObject(raw)) return makeEmptyStore();

  // Backfill old one-bundle format into the legacy bundle variant slot.
  if (isLegacyStoreShape(raw)) {
    return {
      activeBundleVariantId: LEGACY_BUNDLE_VARIANT_ID,
      bundles: {
        [LEGACY_BUNDLE_VARIANT_ID]: normalizeBundleSettings(raw),
      },
    };
  }

  const bundles: Record<string, BundleMerchantSettings> = {};
  if (isObject(raw.bundles)) {
    for (const [variantId, value] of Object.entries(raw.bundles)) {
      if (!variantId) continue;
      bundles[variantId] = normalizeBundleSettings(value);
    }
  }

  const activeBundleVariantId =
    typeof raw.activeBundleVariantId === "string" && raw.activeBundleVariantId.trim().length > 0
      ? raw.activeBundleVariantId.trim()
      : null;

  if (activeBundleVariantId && !bundles[activeBundleVariantId]) {
    bundles[activeBundleVariantId] = defaultBundleSettings();
  }

  return {
    activeBundleVariantId,
    bundles,
  };
}

function readStore(): MerchantSettingsStore {
  if (!existsSync(STORE_PATH)) return makeEmptyStore();
  try {
    const raw = JSON.parse(readFileSync(STORE_PATH, "utf-8")) as unknown;
    const normalized = normalizeStore(raw);
    // Persist one-time migration from legacy shape so existing config survives.
    if (isLegacyStoreShape(raw)) writeStore(normalized);
    return normalized;
  } catch {
    return makeEmptyStore();
  }
}

function writeStore(store: MerchantSettingsStore): void {
  const dir = dirname(STORE_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(STORE_PATH, JSON.stringify(store, null, 2), "utf-8");
}

function resolveBundleVariantId(
  store: MerchantSettingsStore,
  bundleVariantId?: string | null
): string {
  const fromArg =
    typeof bundleVariantId === "string" && bundleVariantId.trim().length > 0
      ? bundleVariantId.trim()
      : null;
  return fromArg ?? store.activeBundleVariantId ?? LEGACY_BUNDLE_VARIANT_ID;
}

function getBundleSettings(
  store: MerchantSettingsStore,
  bundleVariantId?: string | null
): BundleMerchantSettings {
  const resolvedVariantId = resolveBundleVariantId(store, bundleVariantId);
  return store.bundles[resolvedVariantId] ?? defaultBundleSettings();
}

export function getActiveBundleVariantId(): string | null {
  return readStore().activeBundleVariantId;
}

export function setActiveBundleVariantId(bundleVariantId: string | null): void {
  const store = readStore();
  if (bundleVariantId == null || bundleVariantId.trim().length === 0) {
    store.activeBundleVariantId = null;
    writeStore(store);
    return;
  }

  const resolvedVariantId = bundleVariantId.trim();
  if (!store.bundles[resolvedVariantId]) {
    store.bundles[resolvedVariantId] = defaultBundleSettings();
  }

  store.activeBundleVariantId = resolvedVariantId;
  writeStore(store);
}

export function getMerchantSettings(bundleVariantId?: string): BundleMerchantSettings {
  const store = readStore();
  return getBundleSettings(store, bundleVariantId);
}

export function getDeliveryDateOffset(bundleVariantId?: string): number {
  const store = readStore();
  return getBundleSettings(store, bundleVariantId).deliveryDateOffset;
}

export function saveDeliveryDateOffset(bundleVariantId: string, offset: number): void {
  const clamped = clampDeliveryOffset(offset);
  const store = readStore();
  const resolvedVariantId = resolveBundleVariantId(store, bundleVariantId);
  store.bundles[resolvedVariantId] = {
    ...getBundleSettings(store, resolvedVariantId),
    deliveryDateOffset: clamped,
  };
  if (!store.activeBundleVariantId) store.activeBundleVariantId = resolvedVariantId;
  writeStore(store);
}

export function getModificationWindowDays(bundleVariantId?: string): number {
  const store = readStore();
  return getBundleSettings(store, bundleVariantId).modificationWindowDays;
}

export function saveModificationWindowDays(bundleVariantId: string, days: number): void {
  const clamped = clampModificationWindow(days);
  const store = readStore();
  const resolvedVariantId = resolveBundleVariantId(store, bundleVariantId);
  store.bundles[resolvedVariantId] = {
    ...getBundleSettings(store, resolvedVariantId),
    modificationWindowDays: clamped,
  };
  if (!store.activeBundleVariantId) store.activeBundleVariantId = resolvedVariantId;
  writeStore(store);
}

export function isChargeLocked(
  scheduledAt: string,
  deliveryDateOffset: number,
  modificationWindowDays: number
): boolean {
  if (modificationWindowDays <= 0) return false;
  const delivery = new Date(scheduledAt.slice(0, 10) + "T00:00:00Z");
  delivery.setUTCDate(delivery.getUTCDate() + deliveryDateOffset);
  const cutoff = new Date(delivery);
  cutoff.setUTCDate(cutoff.getUTCDate() - modificationWindowDays);
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  return today >= cutoff;
}
