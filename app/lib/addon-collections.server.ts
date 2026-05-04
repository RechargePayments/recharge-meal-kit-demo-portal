import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { LEGACY_BUNDLE_VARIANT_ID } from "./bundle-config";

const STORE_PATH = join(process.cwd(), "data", "addon-collections.json");

type AddonCollectionsStore = {
  collectionIds: string[];
};

type Store = Record<string, AddonCollectionsStore>;

function isObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function normalizeAddonStore(value: unknown): AddonCollectionsStore {
  if (!isObject(value) || !Array.isArray(value.collectionIds)) return { collectionIds: [] };
  return {
    collectionIds: value.collectionIds.filter((id): id is string => typeof id === "string"),
  };
}

function isLegacyStoreShape(raw: unknown): raw is AddonCollectionsStore {
  return isObject(raw) && "collectionIds" in raw;
}

function normalizeStore(raw: unknown): Store {
  if (!isObject(raw)) return {};
  if (isLegacyStoreShape(raw)) {
    return {
      [LEGACY_BUNDLE_VARIANT_ID]: normalizeAddonStore(raw),
    };
  }

  const normalized: Store = {};
  for (const [variantId, value] of Object.entries(raw)) {
    if (!variantId) continue;
    normalized[variantId] = normalizeAddonStore(value);
  }
  return normalized;
}

function readStore(): Store {
  if (!existsSync(STORE_PATH)) return {};
  try {
    const raw = JSON.parse(readFileSync(STORE_PATH, "utf-8")) as unknown;
    const normalized = normalizeStore(raw);
    if (isLegacyStoreShape(raw)) writeStore(normalized);
    return normalized;
  } catch {
    return {};
  }
}

function writeStore(store: Store): void {
  const dir = dirname(STORE_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(STORE_PATH, JSON.stringify(store, null, 2), "utf-8");
}

export function getAddonCollectionIds(bundleVariantId: string): string[] {
  return readStore()[bundleVariantId]?.collectionIds ?? [];
}

export function saveAddonCollectionIds(bundleVariantId: string, ids: string[]): void {
  const store = readStore();
  store[bundleVariantId] = { collectionIds: ids };
  writeStore(store);
}
