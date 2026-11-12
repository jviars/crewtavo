/**
 * Time and materials: the step after Create invoice on a job, and Add logged work on its draft. The
 * hours and materials logged on the job that no invoice bills yet (core workToBill), priced from the
 * price list: hours at an item sold by the hour (Labor unless the office picks another), never at
 * what the worker is paid; materials at their item's price, and ones logged without an item priced
 * here. The database holds each to one invoice (20261104000300_time_and_materials.sql).
 */
import { entryHours, laborRates, minimumTopUp, workLines, workToBill, type LoggedTime, type MaterialGroup } from "@crewtavo/core/billing";
import { lineTotal } from "@crewtavo/core/money";
import { localDate } from "@crewtavo/core/time";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { FormChecks, FormError } from "@/components/ui/Field";
import { Skeleton } from "@/components/ui/Skeleton";
import { supabase, unwrap } from "@/lib/api";
import { formatDate, formatMoneyCents } from "@/lib/format";
import { everyRow } from "@/lib/paging";
import { useSession } from "@/lib/session";

const qty = (n: number) => new Intl.NumberFormat("en-US", { maximumFractionDigits: 3 }).format(n);

/** The job's logged work and what its invoices bill already, and the draft it would go on. */
function useLoggedWork(invoiceId: string, jobId: string) {
  const { company } = useSession();
  return useQuery({
    queryKey: ["invoice", invoiceId, "logged-work"],
    queryFn: async () => {
      const db = supabase();
      const [invoice, time, materials, invoices, services] = await Promise.all([
        db.from("invoices").select("id, status, kind, minimum_charge, lines:invoice_line_items(quantity, unit_price, kind, sort)").eq("id", invoiceId).maybeSingle(),
        // All of the job's time and materials, however long it has run: what isn't read can't be billed.
        everyRow(() => db.from("time_entries").select("id, user_id, started_at, ended_at, category, approved_at").eq("job_id", jobId).not("ended_at", "is", null), { order: "started_at" }),
        everyRow(() => db.from("job_materials").select("id, name, quantity, unit, service_id, logged_at").eq("job_id", jobId), { order: "logged_at" }),
        db.from("invoices").select("lines:invoice_line_items(time_entry_ids, material_ids)").eq("job_id", jobId).neq("status", "void").limit(500),
        db.from("services").select("id, name, unit, unit_price, taxable, active").eq("company_id", company.id),
      ]);
      const time_ = time as LoggedTime[];
      const ids = [...new Set(time_.map((t) => t.user_id))];
      const people = ids.length ? unwrap(await db.from("profiles").select("user_id, full_name").in("user_id", ids)) : [];
      const services_ = unwrap(services);
      return {
        invoice: unwrap(invoice),
        names: new Map(people.map((p) => [p.user_id, p.full_name?.trim() || "Someone"])),
        rates: laborRates(services_),
        ...workToBill({ time: time_, materials, billed: unwrap(invoices).flatMap((i) => i.lines), services: services_ }),
      };
    },
  });
}

/**
 * skipEmpty: as the step after Create invoice, it closes by itself when there's nothing to add (or
 * the invoice isn't one that bills the job's work), so the office goes straight on to the invoice.
 */
export function AddWorkDialog({ invoiceId, jobId, onClose, skipEmpty = false }: { invoiceId: string; jobId: string; onClose: () => void; skipEmpty?: boolean }) {
  const { company } = useSession();
  const queryClient = useQueryClient();
  const work = useLoggedWork(invoiceId, jobId);
  const data = work.data;
  const billable = Boolean(data?.invoice && data.invoice.status === "draft" && ["standard", "visits"].includes(data.invoice.kind));
  const empty = Boolean(data && (!billable || (!data.hours.length && !data.materials.length)));
  const closed = useRef(false);
  useEffect(() => {
    if ((empty || work.error) && skipEmpty && !closed.current) {
      closed.current = true;
      onClose();
    }
  }, [empty, work.error, skipEmpty, onClose]);

  const [hours, setHours] = useState<string[] | null>(null);
  const [rateId, setRateId] = useState("");
  const [picked, setPicked] = useState<string[] | null>(null);
  const [prices, setPrices] = useState<Record<string, string>>({});
  // Everything ticked to start, but materials still to price (and hours with no hourly item to bill them at).
  const shownHours = hours ?? (data?.rates.length ? data.hours.map((t) => t.id) : []);
  const shownPicked = picked ?? data?.materials.filter((m) => m.unit_price !== null).map((m) => m.key) ?? [];
  const rate = data?.rates.find((r) => r.id === rateId) ?? data?.rates[0] ?? null;
  const priceOf = (m: MaterialGroup) => m.unit_price ?? (prices[m.key]?.trim() ? Number(prices[m.key]) : null);

  const lines = data
    ? workLines({
        hours: data.hours.filter((t) => shownHours.includes(t.id)),
        rate,
        materials: data.materials.filter((m) => shownPicked.includes(m.key)),
        prices: Object.fromEntries(data.materials.flatMap((m) => (priceOf(m) == null ? [] : [[m.key, priceOf(m)!]]))),
        timeZone: company.timezone,
      })
    : [];
  // What the draft comes to with them: its Minimum charge line shrinks as they go on.
  const others = (data?.invoice?.lines ?? []).filter((l) => l.kind !== "minimum");
  const after = [...others, ...lines];
  const subtotal = after.reduce((sum, l) => sum + lineTotal(l.quantity, l.unit_price), 0) + minimumTopUp(after, data?.invoice?.minimum_charge ?? null);

  const add = useMutation({
    meta: { inline: true, success: "Logged work added", tone: "invoice" },
    mutationFn: async () => {
      const unpriced = data!.materials.filter((m) => shownPicked.includes(m.key) && !(Number(priceOf(m)) >= 0 && priceOf(m) !== null));
      if (unpriced.length) throw new Error(`Enter a price for ${unpriced.map((m) => m.name).join(", ")}.`);
      if (shownHours.length && !rate) throw new Error("Add an item sold by the hour, like Labor, to your price list to bill hours.");
      if (!lines.length) throw new Error("Pick the hours or materials to add.");
      const sort = Math.max(0, ...(data!.invoice?.lines ?? []).map((l) => l.sort ?? 0));
      unwrap(await supabase().from("invoice_line_items").insert(lines.map((l, i) => ({ ...l, company_id: company.id, invoice_id: invoiceId, sort: sort + i + 1 }))));
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["invoice", invoiceId] });
      queryClient.invalidateQueries({ queryKey: ["invoices"] });
      onClose();
    },
  });

  if ((skipEmpty && (!data || empty)) && !work.error) return null;
  const toggle = (list: string[], id: string, on: boolean) => (on ? [...list, id] : list.filter((x) => x !== id));
  return (
    <Dialog open onClose={onClose} title="Add logged work" description="Hours and materials logged on this job that no invoice has yet." size="lg">
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); add.mutate(); }} className="stack">
        {work.isPending && <Skeleton height={120} radius={8} />}
        {data && empty && <p className="muted">{billable ? "Nothing logged on this job is waiting to be billed." : "Logged work goes on a draft invoice for the job's work."}</p>}
        {data && !empty && data.hours.length > 0 && (
          <section className="stack-sm">
            <div className="row-between wrap" style={{ gap: 8 }}>
              <strong>Hours</strong>
              {data.rates.length > 0 && (
                <select className="select input-sm" style={{ width: "auto" }} value={rate?.id ?? ""} onChange={(e) => setRateId(e.target.value)} aria-label="Bill hours at">
                  {data.rates.map((r) => <option key={r.id} value={r.id}>{r.name} · {formatMoneyCents(Number(r.unit_price))}/{r.unit}</option>)}
                </select>
              )}
            </div>
            {!data.rates.length && <span className="muted small">To bill hours, add an item sold by the hour (unit hr), like Labor, to your price list.</span>}
            <div className="card" style={{ boxShadow: "none", maxHeight: 240, overflowY: "auto" }}>
              {data.hours.map((t) => (
                <label key={t.id} className="card-row" style={{ cursor: "pointer" }}>
                  <input type="checkbox" checked={shownHours.includes(t.id)} onChange={(e) => setHours(toggle(shownHours, t.id, e.target.checked))} />
                  <span className="grow" style={{ minWidth: 0 }}>
                    <strong>{data.names.get(t.user_id) ?? "Someone"}</strong>
                    <span className="muted small" style={{ display: "block" }}>{formatDate(localDate(new Date(t.started_at), company.timezone))}{t.approved_at ? "" : " · not approved yet"}</span>
                  </span>
                  <span className="tabular">{qty(entryHours(t))} hr</span>
                </label>
              ))}
            </div>
          </section>
        )}
        {data && !empty && data.materials.length > 0 && (
          <section className="stack-sm">
            <strong>Materials</strong>
            <div className="card" style={{ boxShadow: "none", maxHeight: 240, overflowY: "auto" }}>
              {data.materials.map((m) => (
                <label key={m.key} className="card-row" style={{ cursor: "pointer" }}>
                  <input type="checkbox" checked={shownPicked.includes(m.key)} onChange={(e) => setPicked(toggle(shownPicked, m.key, e.target.checked))} />
                  <span className="grow" style={{ minWidth: 0 }}>
                    <strong>{m.name}</strong>
                    <span className="muted small" style={{ display: "block" }}>{qty(m.quantity)} {m.unit}{m.unit_price === null ? " · not on your price list" : ""}</span>
                  </span>
                  {m.unit_price !== null ? (
                    <span className="tabular">{formatMoneyCents(lineTotal(m.quantity, m.unit_price))}</span>
                  ) : (
                    <input
                      className="input input-sm"
                      inputMode="decimal"
                      style={{ width: 110 }}
                      placeholder={`Price / ${m.unit}`}
                      aria-label={`Price for each ${m.unit} of ${m.name}`}
                      value={prices[m.key] ?? ""}
                      onChange={(e) => {
                        setPrices({ ...prices, [m.key]: e.target.value.replace(/[^0-9.]/g, "") });
                        if (e.target.value && !shownPicked.includes(m.key)) setPicked([...shownPicked, m.key]);
                      }}
                    />
                  )}
                </label>
              ))}
            </div>
          </section>
        )}
        <FormError error={add.error ?? work.error} />
        <div className="form-actions">
          <FormChecks />
          {data && !empty && <span className="muted small" style={{ marginRight: "auto" }}>Invoice subtotal {formatMoneyCents(subtotal)}</span>}
          <Button onClick={onClose}>{data && !empty ? "Skip" : "Close"}</Button>
          {data && !empty && <Button type="submit" variant="primary" icon="plus" loading={add.isPending}>Add {lines.length === 1 ? "1 line" : `${lines.length} lines`}</Button>}
        </div>
      </form>
    </Dialog>
  );
}
