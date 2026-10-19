/**
 * The daily "plans" task: tidies Plans and files (supabase/migrations/20261019001700_plan_files.sql).
 *   - A file whose property, request, quote and job were all deleted (a spam request, say) is on
 *     nothing anyone can open: its file and row go.
 *   - A file uploaded but never recorded (a booking form closed before its files were recorded, an
 *     upload cut off before its row was saved) goes once it's a day old.
 */
import type { Db } from "../lib/supabase";

const DAY_MS = 24 * 60 * 60_000;
const PAGE = 1000;

export async function tidyPlanFiles(admin: Db, now = Date.now()): Promise<{ detached: number; unrecorded: number }> {
  const files = admin.storage.from("files");

  // On nothing at all.
  const { data: lost, error } = await admin
    .from("plan_files")
    .select("id, path")
    .is("property_id", null)
    .is("request_id", null)
    .is("quote_id", null)
    .is("job_id", null)
    .limit(500);
  if (error) throw new Error(error.message);
  let detached = 0;
  for (const row of lost ?? []) {
    await files.remove([row.path]);
    const { error: gone } = await admin.from("plan_files").delete().eq("id", row.id);
    if (!gone) detached++;
  }

  // Never recorded.
  const { data: companies, error: listError } = await admin.from("companies").select("id").limit(1000);
  if (listError) throw new Error(listError.message);
  let unrecorded = 0;
  for (const { id } of companies ?? []) {
    for (let offset = 0; ; offset += PAGE) {
      const { data: objects, error: storageError } = await files.list(`${id}/plans`, { limit: PAGE, offset, sortBy: { column: "created_at", order: "asc" } });
      if (storageError || !objects?.length) break;
      const old = objects.filter((o) => o.id && o.created_at && now - Date.parse(o.created_at) > DAY_MS).map((o) => `${id}/plans/${o.name}`);
      for (let i = 0; i < old.length; i += 100) {
        const chunk = old.slice(i, i + 100);
        const { data: known } = await admin.from("plan_files").select("path").in("path", chunk);
        const recorded = new Set((known ?? []).map((k) => k.path));
        const strays = chunk.filter((path) => !recorded.has(path));
        if (strays.length && !(await files.remove(strays)).error) unrecorded += strays.length;
      }
      if (objects.length < PAGE) break;
    }
  }
  return { detached, unrecorded };
}
