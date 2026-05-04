import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { LEGACY_BUNDLE_VARIANT_ID } from "./bundle-config";

const STORE_PATH = join(process.cwd(), "data", "week-assignments.json");

type WeekAssignments = Record<string, string[]>;
type Store = Record<string, WeekAssignments>;

const WEEK_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function normalizeAssignments(value: unknown): WeekAssignments {
  if (!isObject(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(([weekStart, ids]) => WEEK_KEY_PATTERN.test(weekStart) && Array.isArray(ids))
      .map(([weekStart, ids]) => [
        weekStart,
        (ids as unknown[]).filter((id): id is string => typeof id === "string"),
      ])
  );
}

function isLegacyStoreShape(raw: unknown): raw is WeekAssignments {
  if (!isObject(raw)) return false;
  const keys = Object.keys(raw);
  if (keys.length === 0) return false;
  return keys.every((key) => WEEK_KEY_PATTERN.test(key));
}

function normalizeStore(raw: unknown): Store {
  if (!isObject(raw)) return {};
  if (isLegacyStoreShape(raw)) {
    return { [LEGACY_BUNDLE_VARIANT_ID]: normalizeAssignments(raw) };
  }

  const normalized: Store = {};
  for (const [variantId, assignments] of Object.entries(raw)) {
    if (!variantId) continue;
    normalized[variantId] = normalizeAssignments(assignments);
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

function getBundleAssignments(store: Store, bundleVariantId: string): WeekAssignments {
  return store[bundleVariantId] ?? {};
}

export function getWeekAssignments(bundleVariantId: string, weekStart: string): string[] | null {
  return getBundleAssignments(readStore(), bundleVariantId)[weekStart] ?? null;
}

export function getAllWeekAssignments(bundleVariantId: string): WeekAssignments {
  return getBundleAssignments(readStore(), bundleVariantId);
}

export function saveWeekAssignments(
  bundleVariantId: string,
  weekStart: string,
  collectionIds: string[]
): void {
  const store = readStore();
  if (!store[bundleVariantId]) store[bundleVariantId] = {};
  store[bundleVariantId][weekStart] = collectionIds;
  writeStore(store);
}
