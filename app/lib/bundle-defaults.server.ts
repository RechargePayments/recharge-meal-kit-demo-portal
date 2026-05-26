import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { LEGACY_BUNDLE_VARIANT_ID } from "./bundle-config";

const STORE_PATH = join(process.cwd(), "data", "bundle-defaults.json");

export const MEALS_PER_WEEK = 5;

export type WeeklyConfig = { targetQuantity: number };

type BundleDefaults = {
  weeklyConfig?: Record<string, WeeklyConfig>;
};

type Store = Record<string, BundleDefaults>;

function isObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function isLegacyStoreShape(raw: unknown): raw is BundleDefaults {
  return isObject(raw) && "weeklyConfig" in raw;
}

function normalizeBundleDefaults(raw: unknown): BundleDefaults {
  if (!isObject(raw)) return {};
  const normalized: BundleDefaults = {};

  if (isObject(raw.weeklyConfig)) {
    normalized.weeklyConfig = Object.fromEntries(
      Object.entries(raw.weeklyConfig)
        .flatMap(([weekStart, value]) => {
          if (weekStart.length === 0 || !isObject(value)) return [];
          const targetQuantity =
            typeof value.targetQuantity === "number" && value.targetQuantity > 0
              ? Math.round(value.targetQuantity)
              : MEALS_PER_WEEK;
          return [[weekStart, { targetQuantity }] as const];
        })
    );
  }

  return normalized;
}

function normalizeStore(raw: unknown): Store {
  if (!isObject(raw)) return {};

  if (isLegacyStoreShape(raw)) {
    return {
      [LEGACY_BUNDLE_VARIANT_ID]: normalizeBundleDefaults(raw),
    };
  }

  const normalized: Store = {};
  for (const [variantId, value] of Object.entries(raw)) {
    if (!variantId) continue;
    normalized[variantId] = normalizeBundleDefaults(value);
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

function getBundleDefaults(store: Store, bundleVariantId: string): BundleDefaults {
  return store[bundleVariantId] ?? {};
}

export function getWeeklyConfig(bundleVariantId: string, weekStart: string): WeeklyConfig {
  const store = readStore();
  return getBundleDefaults(store, bundleVariantId).weeklyConfig?.[weekStart] ?? {
    targetQuantity: MEALS_PER_WEEK,
  };
}

export function getAllWeeklyConfigs(bundleVariantId: string): Record<string, WeeklyConfig> {
  const store = readStore();
  return getBundleDefaults(store, bundleVariantId).weeklyConfig ?? {};
}

export function saveWeeklyConfig(
  bundleVariantId: string,
  weekStart: string,
  config: WeeklyConfig
): void {
  const store = readStore();
  if (!store[bundleVariantId]) store[bundleVariantId] = {};
  if (!store[bundleVariantId].weeklyConfig) store[bundleVariantId].weeklyConfig = {};
  store[bundleVariantId].weeklyConfig![weekStart] = config;
  writeStore(store);
}

export function getUpcomingWeekStarts(): string[] {
  const today = new Date();
  const day = today.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  // If today is Monday, target next Monday (+7); otherwise target the coming Monday
  const daysUntil = day === 0 ? 1 : day === 1 ? 7 : 8 - day;

  return Array.from({ length: 4 }, (_, i) => {
    const d = new Date(today);
    d.setDate(today.getDate() + daysUntil + i * 7);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const dayStr = String(d.getDate()).padStart(2, "0");
    return `${year}-${month}-${dayStr}`;
  });
}
