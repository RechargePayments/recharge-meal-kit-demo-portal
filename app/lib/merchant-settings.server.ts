import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const STORE_PATH = join(process.cwd(), "data", "merchant-settings.json");

const DEFAULT_DELIVERY_OFFSET = 3;
const DEFAULT_MODIFICATION_WINDOW = 2;

type MerchantSettings = {
  deliveryDateOffset: number;
  modificationWindowDays: number;
};

function readStore(): MerchantSettings {
  const defaults: MerchantSettings = {
    deliveryDateOffset: DEFAULT_DELIVERY_OFFSET,
    modificationWindowDays: DEFAULT_MODIFICATION_WINDOW,
  };
  if (!existsSync(STORE_PATH)) return defaults;
  try {
    const raw = JSON.parse(readFileSync(STORE_PATH, "utf-8"));
    return { ...defaults, ...raw };
  } catch {
    return defaults;
  }
}

function writeStore(store: MerchantSettings): void {
  const dir = dirname(STORE_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(STORE_PATH, JSON.stringify(store, null, 2), "utf-8");
}

export function getMerchantSettings(): MerchantSettings {
  return readStore();
}

export function getDeliveryDateOffset(): number {
  return readStore().deliveryDateOffset;
}

export function saveDeliveryDateOffset(offset: number): void {
  const clamped = Math.max(1, Math.min(6, Math.round(offset)));
  const store = readStore();
  store.deliveryDateOffset = clamped;
  writeStore(store);
}

export function getModificationWindowDays(): number {
  return readStore().modificationWindowDays;
}

export function saveModificationWindowDays(days: number): void {
  const clamped = Math.max(0, Math.min(6, Math.round(days)));
  const store = readStore();
  store.modificationWindowDays = clamped;
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
