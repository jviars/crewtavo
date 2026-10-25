/**
 * A rate card: what a sub, or someone on the team on piece pay, is paid per square (or other unit) of
 * a price-list service, per job or per day. Pay on a job is filled in from it (job_pay_suggest), and
 * can still be changed there. For a rate per square, which squares it counts: the job's, or the
 * roof's without waste.
 */
import { isSquareUnit, SQUARES_BASES, type PayBasis, type SquaresBasis } from "@crewtavo/core/jobPay";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { Dialog } from "@/components/ui/Dialog";
import { Field, FormError } from "@/components/ui/Field";
import { Menu } from "@/components/ui/Menu";
import { Skeleton } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState } from "@/components/ui/States";
import { supabase, unwrap } from "@/lib/api";
import { useSession } from "@/lib/session";
import { perUnit, rateText, readRate, squaresText } from "./pay";
import { refreshPay, usePayRates, useServices, type PayeeRef, type PayRate } from "./payData";

export function RatesCard({ payee, bare }: { payee: PayeeRef; bare?: boolean }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const rates = usePayRates(session.company.id, payee);
  const [editing, setEditing] = useState<PayRate | "new" | null>(null);
  const setActive = useMutation({
    meta: { success: (_: unknown, v: { active: boolean }) => (v.active ? "Rate turned back on" : "Rate turned off") },
    mutationFn: async ({ id, active }: { id: string; active: boolean }) => unwrap(await supabase().from("pay_rates").update({ active }).eq("id", id)),
    onSuccess: () => refreshPay(queryClient),
  });
  const remove = useMutation({
    meta: { success: "Rate deleted" },
    mutationFn: async (id: string) => unwrap(await supabase().from("pay_rates").delete().eq("id", id)),
    onSuccess: () => refreshPay(queryClient),
  });
  const list = rates.data ?? [];
  const team = !payee.subcontractor_id;

  const body = (
    <>
      {rates.isPending ? (
        <div className="card-row"><Skeleton width="60%" /></div>
      ) : rates.error ? (
        <div className="card-row"><ErrorState compact error={rates.error} onRetry={() => rates.refetch()} /></div>
      ) : list.length === 0 ? (
        <EmptyState compact icon="dollar" title="No rates yet" action={<Button size="sm" icon="plus" onClick={() => setEditing("new")}>Add a rate</Button>}>
          {team
            ? "What they earn per square, per job or per day. Pay on a job is filled in from these."
            : "What you pay them per square, per job or per day. Pay on a job is filled in from these, and you can still change it there."}
        </EmptyState>
      ) : (
        list.map((r) => (
          <div key={r.id} className="card-row" style={{ alignItems: "flex-start", opacity: r.active ? undefined : 0.6 }}>
            <span className="grow" style={{ minWidth: 0 }}>
              <strong>{r.description || rateText(r)}</strong>
              <span className="muted small" style={{ display: "block" }}>
                {[r.description ? rateText(r) : null, squaresText(r), r.active ? null : "Turned off"].filter(Boolean).join(" · ")}
              </span>
            </span>
            <Menu
              triggerClassName="btn btn-sm btn-ghost btn-icon"
              label={`Actions for ${rateText(r)}`}
              items={[
                { label: "Edit", icon: "edit", onSelect: () => setEditing(r) },
                { label: r.active ? "Turn off" : "Turn back on", icon: r.active ? "archive" : "restore", onSelect: () => setActive.mutate({ id: r.id, active: !r.active }) },
                { separator: true },
                {
                  label: "Delete",
                  icon: "trash",
                  danger: true,
                  onSelect: async () => (await confirm({ title: "Delete this rate?", body: "Pay already on jobs stays as it is.", confirmLabel: "Delete", danger: true })) && remove.mutate(r.id),
                },
              ]}
            />
          </div>
        ))
      )}
      {editing && <RateDialog payee={payee} rate={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </>
  );

  if (bare) {
    return (
      <div className="stack-sm">
        <div className="card">{body}</div>
        {list.length > 0 && <span><Button size="sm" icon="plus" onClick={() => setEditing("new")}>Add a rate</Button></span>}
      </div>
    );
  }
  return (
    <section className="stack">
      <div className="section-head">
        <h2 className="section-title">Rates</h2>
        {list.length > 0 && <Button size="sm" icon="plus" onClick={() => setEditing("new")}>Add a rate</Button>}
      </div>
      <div className="card">{body}</div>
    </section>
  );
}

const BASES: ReadonlyArray<{ key: PayBasis; label: string }> = [
  { key: "per_unit", label: "Per square or unit" },
  { key: "per_job", label: "Per job" },
  { key: "per_day", label: "Per day" },
];

function RateDialog({ payee, rate, onClose }: { payee: PayeeRef; rate: PayRate | null; onClose: () => void }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const services = useServices(session.company.id);
  const [basis, setBasis] = useState<PayBasis>(rate?.basis ?? "per_unit");
  const [serviceId, setServiceId] = useState(rate?.service_id ?? "");
  const [squares, setSquares] = useState<SquaresBasis>(rate?.squares_basis ?? "job");
  const [amount, setAmount] = useState(rate ? String(Number(rate.rate)) : "");
  const [description, setDescription] = useState(rate?.description ?? "");
  const choices = (services.data ?? []).filter((s) => s.active || s.id === serviceId);
  const service = choices.find((s) => s.id === serviceId);
  const square = basis === "per_unit" && isSquareUnit(service?.unit);

  const save = useMutation({
    meta: { inline: true, success: rate ? "Rate saved" : "Rate added" },
    mutationFn: async () => {
      const value = readRate(amount);
      if (value === null) throw new Error("Enter the rate: a dollar amount, up to 4 decimal places.");
      if (basis === "per_unit" && !serviceId) throw new Error("Choose the service it's counted on.");
      const row = {
        basis,
        service_id: basis === "per_unit" ? serviceId : null,
        squares_basis: square ? squares : ("job" as const),
        rate: value,
        description: description.trim() || null,
      };
      if (rate) unwrap(await supabase().from("pay_rates").update(row).eq("id", rate.id));
      else unwrap(await supabase().from("pay_rates").insert({ ...row, company_id: session.company.id, subcontractor_id: payee.subcontractor_id ?? null, user_id: payee.user_id ?? null }));
    },
    onSuccess: () => {
      refreshPay(queryClient);
      onClose();
    },
  });

  const per = basis === "per_unit" ? (service ? perUnit(service.unit) : "per unit") : basis === "per_day" ? "per day" : "per job";
  return (
    <Dialog open onClose={onClose} title={rate ? "Edit rate" : "Add a rate"}>
      <form
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <Field label="Paid">
          <div className="segmented" role="group" aria-label="Paid" style={{ justifySelf: "start", flexWrap: "wrap" }}>
            {BASES.map((b) => <button key={b.key} type="button" aria-pressed={basis === b.key} onClick={() => setBasis(b.key)}>{b.label}</button>)}
          </div>
        </Field>
        {basis === "per_unit" && (
          <Field label="Counted on" hint="Its quantity on the job's line items, change orders included.">
            {services.isPending ? (
              <Skeleton height={36} />
            ) : (
              <select className="select" value={serviceId} onChange={(e) => setServiceId(e.target.value)} required>
                <option value="">Choose a service from your price list</option>
                {choices.map((s) => <option key={s.id} value={s.id}>{s.name}{s.unit ? ` (${s.unit})` : ""}</option>)}
              </select>
            )}
          </Field>
        )}
        {square && (
          <Field label="Which squares">
            <div className="stack-sm">
              {SQUARES_BASES.map((b) => (
                <label key={b.key} className="checkbox" style={{ alignItems: "flex-start" }}>
                  <input type="radio" name="squares" checked={squares === b.key} onChange={() => setSquares(b.key)} />
                  <span>
                    {b.key === "job" ? "The job's squares (what the client pays for)" : b.label}
                    <span className="muted small" style={{ display: "block" }}>{b.hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </Field>
        )}
        <Field label="Rate">
          <span className="row" style={{ gap: 8 }}>
            <span className="input-group" style={{ width: 160 }}>
              <span className="addon">$</span>
              <input className="input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} required style={{ paddingLeft: 24, textAlign: "right" }} aria-label="Rate" />
            </span>
            <span className="muted">{per}</span>
          </span>
        </Field>
        <Field label="Description" optional hint="How it reads on their pay. Leave blank to use the service's name.">
          <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={200} placeholder={basis === "per_day" ? "Day rate" : basis === "per_job" ? "Price for the job" : service?.name ?? ""} />
        </Field>
        <FormError error={save.error} />
        <div className="form-actions">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending}>{rate ? "Save" : "Add rate"}</Button>
        </div>
      </form>
    </Dialog>
  );
}
