import { z } from "zod";
import { rechargeFetch } from "./recharge.server";

const PresetScheduleSchema = z.object({
  id: z.number(),
  bundle_product_id: z.number(),
  external_collection_id: z.string(),
  start_date: z.string(),
  end_date: z.string(),
});

export type PresetSchedule = z.infer<typeof PresetScheduleSchema>;

const StartDateOnly = z.string().transform((value) => value.slice(0, 10));

const PresetScheduleRowSchema = PresetScheduleSchema.extend({
  start_date: StartDateOnly,
  end_date: StartDateOnly,
});

export class PresetScheduleApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "PresetScheduleApiError";
    this.status = status;
  }
}

function extractStatus(err: unknown): number | null {
  if (!(err instanceof Error)) return null;
  const match = err.message.match(/^Recharge (\d{3}) /);
  return match ? Number(match[1]) : null;
}

function rethrow(err: unknown): never {
  const status = extractStatus(err);
  if (status === 403) {
    throw new PresetScheduleApiError(
      403,
      "Bundle selection presets are not enabled for this store (enable_bundle_selection_presets beta flag is off)."
    );
  }
  if (status != null) {
    throw new PresetScheduleApiError(status, err instanceof Error ? err.message : String(err));
  }
  throw err;
}

export async function listPresetSchedules(args: {
  bundleProductId: number;
}): Promise<PresetSchedule[]> {
  try {
    const data = await rechargeFetch<{ bundle_selection_preset_schedules: unknown[] }>(
      `/bundle_selections/preset_schedules?bundle_product_id=${args.bundleProductId}&limit=250&sort_by=created_at-asc`
    );
    return z.array(PresetScheduleRowSchema).parse(data.bundle_selection_preset_schedules);
  } catch (err) {
    return rethrow(err);
  }
}

export async function createPresetSchedule(args: {
  bundleProductId: number;
  externalCollectionId: string;
  startDate: string;
  endDate: string;
}): Promise<PresetSchedule> {
  try {
    const data = await rechargeFetch<{ bundle_selection_preset_schedule: unknown }>(
      `/bundle_selections/preset_schedules`,
      {
        method: "POST",
        body: JSON.stringify({
          bundle_product_id: args.bundleProductId,
          external_collection_id: args.externalCollectionId,
          start_date: args.startDate,
          end_date: args.endDate,
        }),
      }
    );
    return PresetScheduleRowSchema.parse(data.bundle_selection_preset_schedule);
  } catch (err) {
    return rethrow(err);
  }
}

export async function deletePresetSchedule(id: number): Promise<void> {
  try {
    await rechargeFetch(`/bundle_selections/preset_schedules/${id}`, { method: "DELETE" });
  } catch (err) {
    rethrow(err);
  }
}

export function weekEndFor(weekStart: string): string {
  const d = new Date(`${weekStart}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 6);
  return [
    d.getUTCFullYear(),
    String(d.getUTCMonth() + 1).padStart(2, "0"),
    String(d.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

/**
 * Bucket preset_schedule rows back into a `{ [weekStart]: collectionIds[] }` map.
 * Only rows whose start_date matches one of `weekStarts` are kept; rows for
 * other date ranges are ignored (e.g. multi-week or custom ranges set outside
 * the portal).
 */
export function bucketByWeek(
  rows: PresetSchedule[],
  weekStarts: string[]
): Record<string, string[]> {
  const allowed = new Set(weekStarts);
  const out: Record<string, string[]> = {};
  for (const w of weekStarts) out[w] = [];
  for (const row of rows) {
    if (!allowed.has(row.start_date)) continue;
    out[row.start_date].push(row.external_collection_id);
  }
  return out;
}

/**
 * Make the API match `desiredCollectionIds` for the given week. Diffs existing
 * rows (filtered to those whose start_date equals weekStart) against desired
 * and issues the minimum set of create + delete calls.
 */
export async function syncWeekAssignments(args: {
  bundleProductId: number;
  weekStart: string;
  weekEnd: string;
  desiredCollectionIds: string[];
}): Promise<void> {
  const existing = await listPresetSchedules({ bundleProductId: args.bundleProductId });
  const weekRows = existing.filter((row) => row.start_date === args.weekStart);

  const existingIds = new Set(weekRows.map((r) => r.external_collection_id));
  const desiredIds = new Set(args.desiredCollectionIds);

  const toCreate = [...desiredIds].filter((id) => !existingIds.has(id));
  const toDelete = weekRows.filter((r) => !desiredIds.has(r.external_collection_id));

  for (const row of toDelete) {
    await deletePresetSchedule(row.id);
  }
  for (const collectionId of toCreate) {
    await createPresetSchedule({
      bundleProductId: args.bundleProductId,
      externalCollectionId: collectionId,
      startDate: args.weekStart,
      endDate: args.weekEnd,
    });
  }
}
