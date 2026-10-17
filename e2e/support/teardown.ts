/**
 * After the run: remove every client the tests made (named with TEST_PREFIX) and everything
 * attached to it, plus test equipment, using the service key. Same order as the cleanup in
 * scripts/e2e-lifecycle.mjs. Set CREWTAVO_KEEP_TEST_DATA=1 to leave it all in place.
 */
import { createClient } from "@supabase/supabase-js";
import { SUPABASE_SECRET, SUPABASE_URL, TEST_PREFIX } from "./env";

export default async function teardown() {
  if (process.env.CREWTAVO_KEEP_TEST_DATA === "1") return;
  if (!SUPABASE_URL || !SUPABASE_SECRET) {
    console.log("(No SUPABASE_SECRET_KEY, so the browser tests' data was left in place.)");
    return;
  }
  const admin = createClient(SUPABASE_URL, SUPABASE_SECRET, { auth: { persistSession: false } });
  const ids = async (table: string, column: string, values: string[]) => {
    if (!values.length) return [];
    const { data, error } = await admin.from(table).select("id").in(column, values);
    if (error) throw new Error(`Finding ${table}: ${error.message}`);
    return (data ?? []).map((row) => row.id as string);
  };
  const del = async (table: string, column: string, values: string[]) => {
    if (!values.length) return;
    const { error } = await admin.from(table).delete().in(column, values);
    if (error) throw new Error(`Cleaning ${table}: ${error.message}`);
  };

  const gear = (await admin.from("equipment").select("id").like("name", `${TEST_PREFIX} %`)).data?.map((e) => e.id as string) ?? [];
  await del("expenses", "equipment_id", gear);
  await del("notifications", "link", gear.map((id) => `/equipment/${id}`));
  await del("activity", "subject_id", gear);
  await del("equipment", "id", gear);

  const clients = (await admin.from("clients").select("id").like("display_name", `${TEST_PREFIX} %`)).data?.map((c) => c.id as string) ?? [];
  if (!clients.length) return;
  const jobs = await ids("jobs", "client_id", clients);
  const quotes = await ids("quotes", "client_id", clients);
  const requests = await ids("requests", "client_id", clients);
  const invoices = await ids("invoices", "client_id", clients);
  const visits = await ids("visits", "job_id", jobs);
  await del("payments", "invoice_id", invoices);
  if (invoices.length) await admin.from("visits").update({ invoice_id: null }).in("invoice_id", invoices);
  await del("invoices", "id", invoices);
  await del("time_entries", "job_id", jobs);
  await del("visits", "id", visits);
  await del("jobs", "id", jobs);
  await del("quotes", "id", quotes);
  await del("requests", "id", requests);
  const subjects = [...clients, ...jobs, ...quotes, ...requests, ...invoices, ...visits];
  await del("automation_runs", "subject_id", subjects);
  await del("activity", "subject_id", subjects);
  await del("messages", "client_id", clients);
  await del("clients", "id", clients);
  const links = [...quotes.map((id) => `/quotes/${id}`), ...invoices.map((id) => `/invoices/${id}`), ...requests.map((id) => `/requests/${id}`), ...jobs.map((id) => `/jobs/${id}`), ...clients.map((id) => `/clients/${id}`)];
  await del("notifications", "link", links);
  await admin.from("notifications").delete().or(`title.ilike.%${TEST_PREFIX}%,body.ilike.%${TEST_PREFIX}%`);
}
