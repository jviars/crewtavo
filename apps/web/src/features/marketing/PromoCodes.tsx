/** Promo codes: a percent or dollar amount off, for quotes, invoices, booking forms and the Client Hub. */
import type { Tables } from "@crewtavo/core/database";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { Dialog } from "@/components/ui/Dialog";
import { Field, FormError } from "@/components/ui/Field";
import { Menu } from "@/components/ui/Menu";
import { TableSkeleton } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState } from "@/components/ui/States";
import { StatusPill, type Tone } from "@/components/ui/StatusPill";
import { supabase, unwrap } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { formatDate, formatMoney, formatMoneyCents, todayIn } from "@/lib/format";
import { useSession } from "@/lib/session";

type Promo = Tables<"promo_codes">;

export function offerLabel(p: { kind: string; value: number | string }) {
  return p.kind === "percent" ? `${Number(p.value)}% off` : `${formatMoneyCents(Number(p.value))} off`;
}

function promoStatus(p: Promo, uses: number, today: string): { label: string; tone: Tone } {
  if (!p.active) return { label: "Paused", tone: "muted" };
  if (p.ends_on && p.ends_on < today) return { label: "Ended", tone: "muted" };
  if (p.max_uses && uses >= p.max_uses) return { label: "Used up", tone: "muted" };
  if (p.starts_on && p.starts_on > today) return { label: "Starts later", tone: "info" };
  return { label: "Active", tone: "good" };
}

export function PromoCodes() {
  const session = useSession();
  const queryClient = useQueryClient();
  const today = todayIn(session.company.timezone);
  const [editing, setEditing] = useState<Promo | "new" | null>(null);
  const codes = useQuery({
    queryKey: ["promo-codes", session.company.id],
    queryFn: async () => {
      const [rows, usage, forms] = await Promise.all([
        supabase().from("promo_codes").select("*").eq("company_id", session.company.id).order("created_at", { ascending: false }),
        supabase().rpc("promo_code_usage", { p_company: session.company.id }),
        supabase().from("intake_forms").select("slug, name").eq("company_id", session.company.id).eq("active", true).order("created_at").limit(1),
      ]);
      const used = new Map((unwrap(usage) ?? []).map((u) => [u.promo_code_id, u]));
      return { rows: unwrap(rows), used, form: unwrap(forms)[0] ?? null };
    },
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["promo-codes", session.company.id] });
  const update = useMutation({
    meta: { success: (_: unknown, v: { active?: boolean }) => (v.active === false ? "Code paused" : v.active ? "Code turned back on" : null) },
    mutationFn: async ({ id, ...patch }: { id: string; active?: boolean }) => unwrap(await supabase().from("promo_codes").update(patch).eq("id", id)),
    onSuccess: refresh,
  });
  const remove = useMutation({
    meta: { success: "Code deleted" },
    mutationFn: async (id: string) => unwrap(await supabase().from("promo_codes").delete().eq("id", id)),
    onSuccess: refresh,
  });

  const form = codes.data?.form;
  const bookingLink = (code: string) => (form ? `${window.location.origin}/book/${session.company.slug}/${form.slug}?promo=${encodeURIComponent(code)}` : null);

  return (
    <div className="stack">
      <div className="row-between">
        <span className="muted small">Clients can enter a code on your booking form or when they open a quote or invoice. You can also add one for them.</span>
        <Button variant="primary" icon="plus" onClick={() => setEditing("new")}>New promo code</Button>
      </div>
      {codes.isPending ? <TableSkeleton columns={4} rows={3} /> : codes.error ? (
        <div className="card"><ErrorState error={codes.error} onRetry={() => codes.refetch()} /></div>
      ) : !codes.data.rows.length ? (
        <div className="card">
          <EmptyState icon="tag" title="No promo codes yet" action={<Button variant="primary" icon="plus" onClick={() => setEditing("new")}>Create a promo code</Button>}>
            Offer a percent or dollar amount off, like SPRING10 for 10% off spring cleanups.
          </EmptyState>
        </div>
      ) : (
        <div className="card">
          {codes.data.rows.map((p) => {
            const usage = codes.data.used.get(p.id);
            const uses = usage?.uses ?? 0;
            const status = promoStatus(p, uses, today);
            const rules = [
              Number(p.min_subtotal) > 0 && `orders over ${formatMoney(p.min_subtotal)}`,
              p.new_clients_only ? "new customers only" : p.once_per_client && "once per client",
              p.starts_on && p.starts_on > today && `starts ${formatDate(p.starts_on)}`,
              p.ends_on && `${p.ends_on < today ? "ended" : "ends"} ${formatDate(p.ends_on)}`,
            ].filter(Boolean);
            const link = bookingLink(p.code);
            return (
              <div key={p.id} className="card-row">
                <span className="promo-code">{p.code}</span>
                <span className="grow" style={{ minWidth: 0 }}>
                  <strong>{offerLabel(p)}</strong>
                  {p.description && <span className="muted"> · {p.description}</span>}
                  <span className="muted small ellipsis" style={{ display: "block" }}>
                    {[`${uses}${p.max_uses ? ` of ${p.max_uses}` : ""} ${uses === 1 && !p.max_uses ? "use" : "uses"}`, Number(usage?.discounted ?? 0) > 0 && `${formatMoney(usage!.discounted)} off so far`, ...rules].filter(Boolean).join(" · ")}
                  </span>
                </span>
                <StatusPill label={status.label} tone={status.tone} />
                <Menu
                  triggerClassName="btn btn-sm btn-ghost btn-icon"
                  label={`Actions for ${p.code}`}
                  items={[
                    { label: "Edit", icon: "edit", onSelect: () => setEditing(p) },
                    { label: "Copy code", icon: "copy", onSelect: () => copyText(p.code, "Code copied") },
                    { label: "Copy booking link with this code", icon: "link", hidden: !link, onSelect: () => copyText(link!, "Booking link copied") },
                    { separator: true },
                    { label: p.active ? "Pause" : "Turn back on", icon: p.active ? "pause" : "play", onSelect: () => update.mutate({ id: p.id, active: !p.active }) },
                    {
                      label: "Delete",
                      icon: "trash",
                      danger: true,
                      onSelect: async () => {
                        const body = uses ? "Quotes and invoices that used it keep their discount. To stop new uses but keep the history, pause it instead." : undefined;
                        if (await confirm({ title: `Delete ${p.code}?`, body, confirmLabel: "Delete", danger: true })) remove.mutate(p.id);
                      },
                    },
                  ]}
                />
              </div>
            );
          })}
        </div>
      )}
      {editing && <PromoDialog promo={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={refresh} />}
    </div>
  );
}

function PromoDialog({ promo, onClose, onSaved }: { promo: Promo | null; onClose: () => void; onSaved: () => void }) {
  const session = useSession();
  const [f, setF] = useState({
    code: promo?.code ?? "",
    kind: (promo?.kind ?? "percent") as "percent" | "amount",
    value: promo ? String(Number(promo.value)) : "",
    description: promo?.description ?? "",
    min_subtotal: promo && Number(promo.min_subtotal) > 0 ? String(Number(promo.min_subtotal)) : "",
    starts_on: promo?.starts_on ?? "",
    ends_on: promo?.ends_on ?? "",
    max_uses: promo?.max_uses ? String(promo.max_uses) : "",
    once_per_client: promo?.once_per_client ?? true,
    new_clients_only: promo?.new_clients_only ?? false,
  });
  const value = Number(f.value);
  const codeOk = /^[A-Z0-9-]{3,24}$/.test(f.code);
  const valueError = f.value && (!(value > 0) || (f.kind === "percent" && value > 100)) ? (f.kind === "percent" ? "Between 1 and 100" : "More than $0") : null;
  const datesError = f.starts_on && f.ends_on && f.ends_on < f.starts_on ? "Ends before it starts" : null;
  const save = useMutation({
    meta: { inline: true, success: promo ? "Promo code saved" : "Promo code created" },
    mutationFn: async () => {
      if (!codeOk) throw new Error("Use 3 to 24 letters, numbers or dashes for the code.");
      if (!(value > 0) || valueError) throw new Error(f.kind === "percent" ? "Enter a percent between 1 and 100." : "Enter an amount more than $0.");
      if (datesError) throw new Error("The end date is before the start date.");
      const row = {
        code: f.code,
        kind: f.kind,
        value: Math.round(value * 100) / 100,
        description: f.description.trim() || null,
        min_subtotal: Math.max(Number(f.min_subtotal) || 0, 0),
        starts_on: f.starts_on || null,
        ends_on: f.ends_on || null,
        max_uses: Number(f.max_uses) > 0 ? Math.round(Number(f.max_uses)) : null,
        once_per_client: f.new_clients_only || f.once_per_client,
        new_clients_only: f.new_clients_only,
      };
      const result = promo
        ? await supabase().from("promo_codes").update(row).eq("id", promo.id)
        : await supabase().from("promo_codes").insert({ ...row, company_id: session.company.id });
      if (result.error?.code === "23505") throw new Error(`You already have a code called ${f.code}.`);
      unwrap(result);
    },
    onSuccess: () => {
      onSaved();
      onClose();
    },
  });
  return (
    <Dialog open onClose={onClose} title={promo ? `Edit ${promo.code}` : "New promo code"}>
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(); }}>
        <Field label="Code" hint="What clients type in. Letters, numbers and dashes." error={f.code && !codeOk ? "3 to 24 letters, numbers or dashes" : null}>
          <input className="input mono" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, "") })} maxLength={24} placeholder="SPRING10" required autoFocus />
        </Field>
        <div className="form-grid">
          <Field label="Discount">
            <div className="segmented" role="group" aria-label="Discount type">
              <button type="button" aria-pressed={f.kind === "percent"} onClick={() => setF({ ...f, kind: "percent" })}>Percent off</button>
              <button type="button" aria-pressed={f.kind === "amount"} onClick={() => setF({ ...f, kind: "amount" })}>Dollars off</button>
            </div>
          </Field>
          <Field label={f.kind === "percent" ? "Percent" : "Amount"} error={valueError}>
            <span className="input-group">
              {f.kind === "amount" && <span className="addon">$</span>}
              <input className="input" style={f.kind === "amount" ? { paddingLeft: 22 } : undefined} inputMode="decimal" value={f.value} onChange={(e) => setF({ ...f, value: e.target.value.replace(/[^0-9.]/g, "") })} placeholder={f.kind === "percent" ? "10" : "50.00"} required />
              {f.kind === "percent" && <span className="addon addon-right">%</span>}
            </span>
          </Field>
        </div>
        <Field label="What clients see" optional hint="Shown next to the discount, like “Spring cleanup special”.">
          <input className="input" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} maxLength={120} />
        </Field>
        <div className="form-grid">
          <Field label="Starts" optional><input className="input" type="date" value={f.starts_on} onChange={(e) => setF({ ...f, starts_on: e.target.value })} /></Field>
          <Field label="Ends" optional error={datesError}><input className="input" type="date" value={f.ends_on} min={f.starts_on || undefined} onChange={(e) => setF({ ...f, ends_on: e.target.value })} /></Field>
          <Field label="Minimum order" optional>
            <span className="input-group"><span className="addon">$</span><input className="input" style={{ paddingLeft: 22 }} inputMode="decimal" value={f.min_subtotal} onChange={(e) => setF({ ...f, min_subtotal: e.target.value.replace(/[^0-9.]/g, "") })} placeholder="0" /></span>
          </Field>
          <Field label="Total uses allowed" optional hint="Leave empty for no limit.">
            <input className="input" type="number" min={1} value={f.max_uses} onChange={(e) => setF({ ...f, max_uses: e.target.value })} />
          </Field>
        </div>
        <div className="stack-sm">
          <label className="switch-row" style={{ fontWeight: 500 }}>
            <input type="checkbox" className="switch" checked={f.once_per_client || f.new_clients_only} disabled={f.new_clients_only} onChange={(e) => setF({ ...f, once_per_client: e.target.checked })} />
            Each client can use it once
          </label>
          <label className="switch-row" style={{ fontWeight: 500 }}>
            <input type="checkbox" className="switch" checked={f.new_clients_only} onChange={(e) => setF({ ...f, new_clients_only: e.target.checked })} />
            New customers only
          </label>
        </div>
        <FormError error={save.error} />
        <div className="form-actions">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!codeOk || !(value > 0) || Boolean(valueError) || Boolean(datesError)}>{promo ? "Save" : "Create code"}</Button>
        </div>
      </form>
    </Dialog>
  );
}
