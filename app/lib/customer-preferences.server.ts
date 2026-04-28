import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const STORE_PATH = join(process.cwd(), "data", "customer-preferences.json");

export type CustomerPreference = { include: string[]; exclude: string[] };

type Store = { preferences: Record<string, CustomerPreference> };

function readStore(): Store {
  if (!existsSync(STORE_PATH)) return { preferences: {} };
  try {
    return JSON.parse(readFileSync(STORE_PATH, "utf-8")) as Store;
  } catch {
    return { preferences: {} };
  }
}

function writeStore(store: Store): void {
  const dir = dirname(STORE_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(STORE_PATH, JSON.stringify(store, null, 2), "utf-8");
}

export function getCustomerPreferences(customerId: string | null): CustomerPreference | null {
  if (!customerId) return null;
  const store = readStore();
  return store.preferences[customerId] ?? null;
}

export function getAllCustomerPreferences(): Record<string, CustomerPreference> {
  return readStore().preferences;
}

export function saveCustomerPreferences(customerId: string, preferences: CustomerPreference): void {
  const store = readStore();
  store.preferences[customerId] = preferences;
  writeStore(store);
}
