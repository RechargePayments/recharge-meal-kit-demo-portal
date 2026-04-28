import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BundleItemPayload } from "./types";

const STORE_PATH = join(process.cwd(), "data", "bundle-defaults.json");

export const MEALS_PER_WEEK = 5;

export type WeeklyConfig = { targetQuantity: number };

type Store = {
  weeklyConfig?: Record<string, WeeklyConfig>;
  weeklyDefaults?: Record<string, BundleItemPayload[]>;
};

function readStore(): Store {
  if (!existsSync(STORE_PATH)) return {};
  try {
    return JSON.parse(readFileSync(STORE_PATH, "utf-8")) as Store;
  } catch {
    return {};
  }
}

function writeStore(store: Store): void {
  const dir = dirname(STORE_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(STORE_PATH, JSON.stringify(store, null, 2), "utf-8");
}

export function getWeeklyConfig(weekStart: string): WeeklyConfig {
  const store = readStore();
  return store.weeklyConfig?.[weekStart] ?? { targetQuantity: MEALS_PER_WEEK };
}

export function getAllWeeklyConfigs(): Record<string, WeeklyConfig> {
  return readStore().weeklyConfig ?? {};
}

export function saveWeeklyConfig(weekStart: string, config: WeeklyConfig): void {
  const store = readStore();
  if (!store.weeklyConfig) store.weeklyConfig = {};
  store.weeklyConfig[weekStart] = config;
  writeStore(store);
}

/** @deprecated Kept for backward compatibility with old store format */
export function getWeeklyDefaults(): Record<string, BundleItemPayload[]> {
  return readStore().weeklyDefaults ?? {};
}

/** @deprecated Kept for backward compatibility with old store format */
export function saveWeeklyDefault(weekStart: string, selections: BundleItemPayload[]): void {
  const store = readStore();
  if (!store.weeklyDefaults) store.weeklyDefaults = {};
  store.weeklyDefaults[weekStart] = selections;
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
