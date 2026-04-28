import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const STORE_PATH = join(process.cwd(), "data", "merchant-settings.json");

const DEFAULT_DELIVERY_OFFSET = 3;

type MerchantSettings = {
  deliveryDateOffset: number;
};

function readStore(): MerchantSettings {
  if (!existsSync(STORE_PATH)) return { deliveryDateOffset: DEFAULT_DELIVERY_OFFSET };
  try {
    return JSON.parse(readFileSync(STORE_PATH, "utf-8")) as MerchantSettings;
  } catch {
    return { deliveryDateOffset: DEFAULT_DELIVERY_OFFSET };
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
