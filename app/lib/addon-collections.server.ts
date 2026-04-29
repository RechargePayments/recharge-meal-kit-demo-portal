import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const STORE_PATH = join(process.cwd(), "data", "addon-collections.json");

type AddonCollectionsStore = {
  collectionIds: string[];
};

function readStore(): AddonCollectionsStore {
  if (!existsSync(STORE_PATH)) return { collectionIds: [] };
  try {
    return JSON.parse(readFileSync(STORE_PATH, "utf-8")) as AddonCollectionsStore;
  } catch {
    return { collectionIds: [] };
  }
}

function writeStore(store: AddonCollectionsStore): void {
  const dir = dirname(STORE_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(STORE_PATH, JSON.stringify(store, null, 2), "utf-8");
}

export function getAddonCollectionIds(): string[] {
  return readStore().collectionIds;
}

export function saveAddonCollectionIds(ids: string[]): void {
  writeStore({ collectionIds: ids });
}
