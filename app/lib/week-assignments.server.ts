import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const STORE_PATH = join(process.cwd(), "data", "week-assignments.json");

type Store = Record<string, string[]>;

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

export function getWeekAssignments(weekStart: string): string[] | null {
  return readStore()[weekStart] ?? null;
}

export function getAllWeekAssignments(): Record<string, string[]> {
  return readStore();
}

export function saveWeekAssignments(weekStart: string, collectionIds: string[]): void {
  const store = readStore();
  store[weekStart] = collectionIds;
  writeStore(store);
}
