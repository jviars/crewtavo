/**
 * Extra work on one visit of a repeating job (core visitExtras; the database's rules are in
 * 20261113000900_visit_extras.sql): the office's list for a visit, with adding from the price list
 * or by typing a line, used by the visit dialog on the schedule and by the job page; the lines the
 * job page shows under a visit; and what the job page asks the office about (extras that weren't
 * billed because their visit was cancelled or removed, and ones the crew added on site).
 *
 * They carry prices, so they're read by the office and estimators only and never kept on a phone
 * (the crew's list, without prices, is features/field/FieldExtras.tsx).
 */
import { lineTotal } from "@crewtavo/core/money";
import { extraBillingHint, extraState, extraStateText, extrasToReview, takesExtras, visitTakesExtras, type ExtraVisit } from "@crewtavo/core/visitExtras";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { Select } from "@/components/ui/Select";
import { Skeleton } from "@/components/ui/Skeleton";
import { supabase, unwrap, unwrapOne } from "@/lib/api";
import { currencySymbol, formatDate, formatDateTime, formatMoneyCents } from "@/lib/format";
import { everyRow } from "@/lib/paging";
import { can, hasRole, useSession } from "@/lib/session";
import { priceListColumns } from "../quotes/LineItems";
import styles from "./jobs.module.css";

const qty = (n: number | string) => new Intl.NumberFormat("en-US", { maximumFractionDigits: 3 }).format(Number(n));

export interface ExtraRow {
  id: string;
  visit_id: string | null;
  service_id: string | null;
  name: string;
  description: string | null;
  quantity: number;
  unit: string;
  unit_price: number;
  unit_cost: number | null;
  unit_labor_cost: number | null;
  taxable: boolean;
  invoice_id: string | null;
  visit_was_on: string | null;
  added_in_field_by: string | null;
  added_in_field_at: string | null;
  invoice: { number: number; status: string } | null;
}

export const extrasKey = (jobId: string | null | undefined) => ["job", jobId, "extras"];

/** Whether the person reads extras (with their prices): the office and estimators, as job lines. */
export const useSeesExtras = () => hasRole(useSession(), "admin", "office", "estimator");
/** Whether they add and change them: with Quotes and sales, as they edit a job's lines. */
export const useEditsExtras = () => {
  const session = useSession();
  return hasRole(session, "admin", "office", "estimator") && can(session, "sales");
};

/** Every extra on a job's visits, oldest first, each with the invoice that bills it. */
export function useJobExtras(jobId: string | null | undefined, enabled = true) {
  const sees = useSeesExtras();
  return useQuery({
    queryKey: extrasKey(jobId),
    enabled: Boolean(jobId) && enabled && sees,
    queryFn: async () =>
      (await everyRow(
        () => supabase().from("visit_extras").select("id, visit_id, service_id, name, description, quantity, unit, unit_price, unit_cost, unit_labor_cost, taxable, invoice_id, visit_was_on, added_in_field_by, added_in_field_at, invoice:invoices(number, status)").eq("job_id", jobId!),
        { order: "created_at" },
      )) as ExtraRow[],
  });
}

/** One extra as a line of text: "Mulch · 2 yd · $120.00". */
export const extraText = (e: Pick<ExtraRow, "name" | "quantity" | "unit" | "unit_price">) =>
  `${e.name}${Number(e.quantity) !== 1 || e.unit !== "ea" ? ` · ${qty(e.quantity)} ${e.unit}` : ""} · ${formatMoneyCents(lineTotal(e.quantity, e.unit_price))}`;

/** What a typed extra needs before it's saved, or the problem with it. */
export function readExtraDraft(draft: { name: string; quantity: string; price: string }): { name: string; quantity: number; unit_price: number } | string {
  const name = draft.name.trim();
  const quantity = Number(draft.quantity);
  const price = Number(draft.price);
  if (!name) return "Say what the extra work is.";
  if (!(quantity > 0 && quantity <= 100_000)) return "Enter how many.";
  if (draft.price.trim() === "" || !Number.isFinite(price)) return "Enter the price.";
  return { name, quantity: Math.round(quantity * 1000) / 1000, unit_price: Math.round(price * 100) / 100 };
}

interface PriceListItem { id: string; name: string; description: string | null; unit: string; unit_price: number; unit_cost?: number | null; taxable: boolean }

/**
 * The extra work on one visit, with adding and removing for those who may. It loads what it needs
 * from the visit's id, so the schedule's visit dialog and the job page use it alike. Nothing shows
 * for a visit that isn't a repeating job's. No form of its own: it sits inside the visit dialog's.
 * `titled={false}` leaves out its heading, in a dialog whose title already says it.
 */
export function VisitExtrasEditor({ visitId, jobId, onChanged, titled = true }: { visitId: string; jobId: string; onChanged?: () => void; titled?: boolean }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const sees = useSeesExtras();
  const edits = useEditsExtras();
  const seesCosts = hasRole(session, "admin", "office") && can(session, "job_costs");
  const about = useQuery({
    queryKey: ["job", jobId, "extras-visit", visitId],
    enabled: sees,
    meta: { silent: true },
    queryFn: async () => {
      const [job, visit] = await Promise.all([
        supabase().from("jobs").select("id, kind, status, billing_mode, pricing, invoice_schedule").eq("id", jobId).maybeSingle(),
        supabase().from("visits").select("id, kind, status, invoice_id").eq("id", visitId).maybeSingle(),
      ]);
      return { job: unwrapOne(job, "This job"), visit: unwrapOne(visit, "This visit") };
    },
  });
  const repeats = about.data?.job.kind === "recurring" && about.data.visit.kind === "job";
  const extras = useJobExtras(jobId, repeats);
  const open = Boolean(about.data && takesExtras(about.data.job) && visitTakesExtras(about.data.visit));
  const services = useQuery({
    queryKey: ["services", session.company.id, seesCosts ? "with-costs" : "without-costs"],
    enabled: edits && open,
    staleTime: 5 * 60_000,
    queryFn: async () => unwrap(await supabase().from("services").select(priceListColumns(seesCosts)).eq("company_id", session.company.id).eq("active", true).order("sort")) as unknown as PriceListItem[],
  });

  const [serviceId, setServiceId] = useState("");
  const [draft, setDraft] = useState({ name: "", quantity: "1", price: "", unit: "ea", taxable: true });
  const [problem, setProblem] = useState<string | null>(null);
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["job", jobId] });
    void queryClient.invalidateQueries({ queryKey: ["visit-details", visitId] });
    onChanged?.();
  };
  const add = useMutation({
    meta: { inline: true, success: "Extra work added", tone: "job" },
    mutationFn: async (row: { name: string; quantity: number; unit_price: number }) => {
      const item = services.data?.find((s) => s.id === serviceId);
      unwrap(
        await supabase().from("visit_extras").insert({
          company_id: session.company.id, job_id: jobId, visit_id: visitId, service_id: item?.id ?? null, ...row,
          description: item?.description ?? null, unit: draft.unit.trim() || "ea", taxable: draft.taxable,
          // Its cost, for someone shown costs; for anyone else the database takes the item's.
          ...(item?.unit_cost != null && { unit_cost: item.unit_cost }),
        }),
      );
    },
    onSuccess: () => {
      setServiceId("");
      setDraft({ name: "", quantity: "1", price: "", unit: "ea", taxable: true });
      refresh();
    },
  });
  const remove = useMutation({
    meta: { success: "Extra work removed", tone: "job" },
    mutationFn: async (id: string) => unwrap(await supabase().from("visit_extras").delete().eq("id", id)),
    onSuccess: refresh,
  });

  if (!sees || !about.data || !repeats) return null;
  const mine = (extras.data ?? []).filter((e) => e.visit_id === visitId);
  if (!mine.length && !(edits && open)) return null;
  const pick = (id: string) => {
    setServiceId(id);
    const item = services.data?.find((s) => s.id === id);
    if (item) setDraft({ name: item.name, quantity: draft.quantity || "1", price: String(item.unit_price), unit: item.unit, taxable: item.taxable });
  };
  const submit = () => {
    const row = readExtraDraft(draft);
    if (typeof row === "string") return setProblem(row);
    setProblem(null);
    add.mutate(row);
  };
  // Enter adds the extra rather than saving the dialog it sits in.
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    submit();
  };
  return (
    <section className={styles.extras} aria-label="Extra work on this visit">
      {titled && (
        <div className={styles.extrasHead}>
          <span className={styles.extrasTitle}>Extra work on this visit</span>
          <span className={styles.extrasHint}>{extraBillingHint(about.data.job)}</span>
        </div>
      )}
      {extras.isPending && <Skeleton height={36} radius={8} />}
      {mine.length > 0 && (
        <ul className="rel" role="list" aria-label="Extra work">
          {mine.map((e) => {
            const state = extraState(e, about.data.visit);
            return (
              <li key={e.id} className="rel-row">
                <div className="rel-body">
                  <span className="rel-head"><span className="rel-title">{e.name}</span></span>
                  <div className="rel-sub">
                    {qty(e.quantity)} {e.unit} at {formatMoneyCents(Number(e.unit_price))}{e.taxable ? "" : " · not taxed"} · {extraStateText(state, e.invoice?.number).toLowerCase()}{e.added_in_field_at ? " · added by the crew" : ""}
                  </div>
                </div>
                <span className="rel-end"><b>{formatMoneyCents(lineTotal(e.quantity, e.unit_price))}</b></span>
                {edits && !e.invoice_id && (
                  <span className="rel-actions">
                    <Button size="sm" variant="ghost" icon="trash" aria-label={`Remove ${e.name}`} title="Remove" loading={remove.isPending && remove.variables === e.id} onClick={() => remove.mutate(e.id)} />
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {edits && open && (
        <div className="stack-sm">
          <div className="row wrap" style={{ gap: 8, alignItems: "flex-end" }}>
            <Select className="select input-sm" style={{ width: "auto", maxWidth: 220 }} value={serviceId} onChange={(e) => pick(e.target.value)} aria-label="From the price list">
              <option value="">{services.data?.length ? "From the price list…" : "Type a line"}</option>
              {services.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
            <input className="input input-sm grow" style={{ minWidth: 140 }} placeholder="What was done" aria-label="Extra work" value={draft.name} maxLength={200} onKeyDown={onKey} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            <input className="input input-sm" style={{ width: 70 }} inputMode="decimal" aria-label="Quantity" title="Quantity" value={draft.quantity} onKeyDown={onKey} onChange={(e) => setDraft({ ...draft, quantity: e.target.value.replace(/[^0-9.]/g, "") })} />
            <span className="input-group" style={{ width: 110 }}>
              <span className="addon">{currencySymbol()}</span>
              <input className="input input-sm" style={{ paddingLeft: 22 }} inputMode="decimal" placeholder="Price" aria-label={`Price for each ${draft.unit || "one"}`} title="Price for each" value={draft.price} onKeyDown={onKey} onChange={(e) => setDraft({ ...draft, price: e.target.value.replace(/[^0-9.-]/g, "") })} />
            </span>
            <label className="row small" style={{ gap: 6 }}>
              <input type="checkbox" checked={draft.taxable} onChange={(e) => setDraft({ ...draft, taxable: e.target.checked })} />
              Taxed
            </label>
            <Button size="sm" icon="plus" loading={add.isPending} onClick={submit}>Add</Button>
          </div>
          <FormError error={problem ?? add.error} />
        </div>
      )}
      {edits && !open && about.data.visit.invoice_id && <span className={styles.extrasHint}>This visit is on an invoice, so more work goes on the invoice itself.</span>}
    </section>
  );
}

/** The job page's Extra work for one of its visits, in a dialog of its own. */
export function ExtraWorkDialog({ visit, jobId, onClose }: { visit: { id: string; title: string; scheduled_on: string | null }; jobId: string; onClose: () => void }) {
  return (
    <Dialog open onClose={onClose} title="Extra work on this visit" description={`${visit.title}${visit.scheduled_on ? ` · ${formatDate(visit.scheduled_on)}` : ""}. It's billed once, with this visit, and doesn't change the job's price.`} size="lg">
      <div className="dialog-body stack">
        <VisitExtrasEditor visitId={visit.id} jobId={jobId} titled={false} />
        <div className="form-actions">
          <Button variant="primary" onClick={onClose}>Done</Button>
        </div>
      </div>
    </Dialog>
  );
}

/** A visit's extras, as short lines under its row on the job page. */
export function VisitExtraLines({ extras, visit }: { extras: readonly ExtraRow[]; visit: ExtraVisit }) {
  if (!extras.length) return null;
  return (
    <>
      {extras.map((e) => (
        <span key={e.id} className={styles.extraLine}>
          <Icon name="plus" size={12} />
          <span>{extraText(e)} <span className={styles.extraState}>· {extraStateText(extraState(e, visit), e.invoice?.number).toLowerCase()}{e.added_in_field_at ? " · added by the crew" : ""}</span></span>
        </span>
      ))}
    </>
  );
}

/**
 * What the office should look at on a repeating job: extra work that wasn't billed because its
 * visit was cancelled or removed (put it on another visit, or remove it), and extra work the crew
 * added on site that isn't invoiced yet, as lines added in the field are flagged on a one-off job.
 */
export function ExtrasToReview({ jobId, extras, visits }: { jobId: string; extras: readonly ExtraRow[]; visits: ReadonlyArray<ExtraVisit & { title: string; scheduled_on: string | null }> }) {
  const { company } = useSession();
  const queryClient = useQueryClient();
  const edits = useEditsExtras();
  const { notBilled, fromField } = extrasToReview(extras, visits);
  const ids = [...new Set(fromField.flatMap((e) => (e.added_in_field_by ? [e.added_in_field_by] : [])))].sort();
  const people = useQuery({
    queryKey: ["job", jobId, "added-by", ids],
    enabled: ids.length > 0,
    staleTime: 5 * 60_000,
    meta: { silent: true },
    queryFn: async () => unwrap(await supabase().from("profiles").select("user_id, full_name").in("user_id", ids)),
  });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["job", jobId] });
  const move = useMutation({
    meta: { success: "Extra work moved", tone: "job" },
    mutationFn: async (v: { id: string; visitId: string }) => unwrap(await supabase().from("visit_extras").update({ visit_id: v.visitId }).eq("id", v.id)),
    onSuccess: refresh,
  });
  const remove = useMutation({
    meta: { success: "Extra work removed", tone: "job" },
    mutationFn: async (id: string) => unwrap(await supabase().from("visit_extras").delete().eq("id", id)),
    onSuccess: refresh,
  });
  if (!notBilled.length && !fromField.length) return null;
  const byId = new Map(visits.map((v) => [v.id, v]));
  // Where one can go: the job's visits that aren't cancelled or invoiced, soonest first.
  const targets = visits.filter((v) => visitTakesExtras(v)).sort((a, b) => (a.scheduled_on ?? "9999").localeCompare(b.scheduled_on ?? "9999"));
  const who = (id: string | null) => people.data?.find((p) => p.user_id === id)?.full_name || "The crew";
  return (
    <>
      {notBilled.length > 0 && (
        <div className="callout callout-warning">
          <Icon name="alert" size={16} />
          <div className="grow stack-sm">
            <div>Extra work that wasn't billed</div>
            {notBilled.map((e) => {
              const was = e.visit_id ? byId.get(e.visit_id)?.scheduled_on ?? null : e.visit_was_on;
              return (
                <div key={e.id} className="row wrap" style={{ gap: 8 }}>
                  <span className="grow">{extraText(e)} · its visit{was ? ` on ${formatDate(was)}` : ""} was {e.visit_id ? "cancelled" : "removed"}</span>
                  {edits && targets.length > 0 && (
                    <Select className="select input-sm" style={{ width: "auto" }} value="" aria-label={`Put ${e.name} on another visit`} onChange={(ev) => ev.target.value && move.mutate({ id: e.id, visitId: ev.target.value })}>
                      <option value="">Put on another visit…</option>
                      {targets.slice(0, 60).map((v) => <option key={v.id} value={v.id}>{v.scheduled_on ? formatDate(v.scheduled_on) : "Not scheduled"} · {v.status === "completed" ? "done" : v.title}</option>)}
                    </Select>
                  )}
                  {edits && <Button size="sm" variant="ghost" icon="trash" loading={remove.isPending && remove.variables === e.id} onClick={() => remove.mutate(e.id)}>Remove</Button>}
                </div>
              );
            })}
          </div>
        </div>
      )}
      {fromField.length > 0 && (
        <div className="callout callout-info">
          <Icon name="truck" size={16} />
          <div className="grow">
            <div>Extra work added in the field</div>
            {fromField.map((e) => {
              const on = e.visit_id ? byId.get(e.visit_id)?.scheduled_on : null;
              return (
                <div key={e.id}>
                  {extraText(e)}{on ? ` · visit on ${formatDate(on)}` : ""} <span className="muted">· {who(e.added_in_field_by)}, {formatDateTime(e.added_in_field_at!, company.timezone)}</span>
                </div>
              );
            })}
            <div className="muted">Look it over before the visit is invoiced. It's billed once, with that visit.</div>
          </div>
        </div>
      )}
    </>
  );
}
