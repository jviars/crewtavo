/**
 * Materials used on a job: tons of asphalt, gallons of sealer, loads of stone, logged from the
 * field with the plant ticket number and a photo of the ticket. Job costing values them at the
 * price list's cost; crews see quantities, never prices.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { Dialog } from "@/components/ui/Dialog";
import { Field, FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { Skeleton } from "@/components/ui/Skeleton";
import { supabase, unwrap } from "@/lib/api";
import { signedUrls, uploadFile } from "@/lib/files";
import { formatDate, formatMoneyCents } from "@/lib/format";
import { hasRole, useSession } from "@/lib/session";

const UNITS = ["ton", "yd³", "gal", "load", "bag", "ea", "lf", "sq yd"];
const qty = (n: number) => new Intl.NumberFormat("en-US", { maximumFractionDigits: 3 }).format(n);

export function useJobMaterials(jobId: string) {
  return useQuery({
    queryKey: ["job", jobId, "materials"],
    queryFn: async () => {
      const rows = unwrap(await supabase().from("job_materials").select("id, visit_id, name, quantity, unit, ticket, supplier, photo_path, logged_by, logged_at").eq("job_id", jobId).order("logged_at", { ascending: false }));
      const urls = await signedUrls(rows.flatMap((r) => (r.photo_path ? [r.photo_path] : []))).catch(() => ({}) as Record<string, string>);
      return rows.map((r) => ({ ...r, photo_url: r.photo_path ? urls[r.photo_path] ?? null : null }));
    },
  });
}

/** On the job page (all of it) or a visit (just that day's), with a "Log material" button. */
export function MaterialsCard({ jobId, visitId, showCosts, compact = false }: { jobId: string; visitId?: string; showCosts?: boolean; compact?: boolean }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const [logging, setLogging] = useState(false);
  const materials = useJobMaterials(jobId);
  const costs = useQuery({
    queryKey: ["job", jobId, "material-costs"],
    enabled: Boolean(showCosts),
    queryFn: async () => unwrap(await supabase().rpc("job_material_costs", { p_job: jobId })),
  });
  const remove = useMutation({
    meta: { success: "Removed" },
    mutationFn: async (id: string) => unwrap(await supabase().from("job_materials").delete().eq("id", id)),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["job", jobId] }),
  });
  const rows = (materials.data ?? []).filter((m) => !visitId || m.visit_id === visitId);
  const canFix = (m: { logged_by: string | null; logged_at: string }) => hasRole(session, "admin", "office", "crew_lead") || (m.logged_by === session.userId && Date.now() - Date.parse(m.logged_at) < 86_400_000);
  // Totals by material, for the whole job.
  const totals = Object.values(
    (materials.data ?? []).reduce<Record<string, { name: string; unit: string; quantity: number }>>((acc, m) => {
      const k = `${m.name}|${m.unit}`;
      acc[k] = { name: m.name, unit: m.unit, quantity: (acc[k]?.quantity ?? 0) + Number(m.quantity) };
      return acc;
    }, {}),
  );

  return (
    <section className={compact ? "card card-pad stack-sm" : "stack"}>
      <div className={compact ? "row-between" : "section-head"}>
        {compact ? <strong>Materials used</strong> : <h2 className="section-title">Materials used</h2>}
        <Button size="sm" icon="plus" onClick={() => setLogging(true)}>Log material</Button>
      </div>
      <div className={compact ? undefined : "card"}>
        {materials.isPending && <div className="card-row"><Skeleton width="50%" /></div>}
        {materials.data && rows.length === 0 && <div className={compact ? "muted small" : "card-row muted small"}>{visitId ? "Log tons, gallons or loads as they come in, with the ticket number." : "Nothing logged yet. Crews log materials from the visit on their phone."}</div>}
        {rows.map((m) => (
          <div key={m.id} className="card-row" style={compact ? { paddingLeft: 0, paddingRight: 0 } : undefined}>
            {m.photo_url ? (
              <a href={m.photo_url} target="_blank" rel="noreferrer" className="thumb" style={{ width: 38, height: 38, flex: "none" }} aria-label="Open ticket photo"><img src={m.photo_url} alt="" /></a>
            ) : (
              <span style={{ width: 38, height: 38, borderRadius: 10, display: "grid", placeItems: "center", background: "var(--fill-2)", color: "var(--text-3)", flex: "none" }}><Icon name="truck" size={17} /></span>
            )}
            <span className="grow" style={{ minWidth: 0 }}>
              <strong>{qty(Number(m.quantity))} {m.unit} · {m.name}</strong>
              <span className="muted small" style={{ display: "block" }}>{[m.ticket && `Ticket ${m.ticket}`, m.supplier, formatDate(m.logged_at)].filter(Boolean).join(" · ")}</span>
            </span>
            {canFix(m) && <Button size="sm" variant="ghost" icon="trash" aria-label={`Remove ${m.name}`} onClick={async () => (await confirm({ title: "Remove this entry?", confirmLabel: "Remove", danger: true })) && remove.mutate(m.id)} />}
          </div>
        ))}
        {!visitId && totals.length > 1 && (
          <div className="list-foot"><span className="muted small">Totals: {totals.map((t) => `${qty(t.quantity)} ${t.unit} ${t.name}`).join(" · ")}</span></div>
        )}
      </div>
      {showCosts && !!costs.data?.length && (
        <span className="muted small">
          At price-list cost: {formatMoneyCents(costs.data.reduce((s, c) => s + Number(c.cost), 0))}
          {costs.data.some((c) => c.unit_cost == null) ? ". Some materials have no cost in the price list yet." : ""}
        </span>
      )}
      {logging && <MaterialDialog jobId={jobId} visitId={visitId ?? null} onClose={() => setLogging(false)} onSaved={() => queryClient.invalidateQueries({ queryKey: ["job", jobId] })} />}
    </section>
  );
}

export function MaterialDialog({ jobId, visitId, onClose, onSaved }: { jobId: string; visitId: string | null; onClose: () => void; onSaved: () => void }) {
  const session = useSession();
  const choices = useQuery({
    queryKey: ["material-choices", session.company.id],
    staleTime: 5 * 60_000,
    queryFn: async () => unwrap(await supabase().rpc("material_choices", { p_company: session.company.id })),
  });
  const [serviceId, setServiceId] = useState("");
  const [name, setName] = useState("");
  const [quantity, setQuantity] = useState("");
  const [unit, setUnit] = useState("ton");
  const [ticket, setTicket] = useState("");
  const [supplier, setSupplier] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const amount = Number(quantity);
  const pick = (id: string) => {
    setServiceId(id);
    const c = choices.data?.find((x) => x.id === id);
    if (c) {
      setName(c.name);
      setUnit(c.unit);
    }
  };
  const save = useMutation({
    meta: { inline: true, success: "Material logged" },
    mutationFn: async () => {
      if (!(amount > 0)) throw new Error("Enter how much was used.");
      if (!name.trim()) throw new Error("Say what material it was.");
      const photo_path = file ? await uploadFile(session.company.id, `tickets/${jobId}`, file) : null;
      unwrap(
        await supabase().from("job_materials").insert({
          company_id: session.company.id, job_id: jobId, visit_id: visitId, service_id: serviceId || null,
          name: name.trim(), quantity: amount, unit, ticket: ticket.trim() || null, supplier: supplier.trim() || null, photo_path,
          logged_by: session.userId,
        }),
      );
    },
    onSuccess: () => {
      onSaved();
      onClose();
    },
  });
  return (
    <Dialog open onClose={onClose} title="Log material">
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(); }}>
        <Field label="Material">
          {choices.isPending ? <Skeleton height={38} radius={8} /> : (
            <select className="select" value={serviceId} onChange={(e) => pick(e.target.value)}>
              <option value="">Something else (type it below)</option>
              {choices.data?.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.unit})</option>)}
            </select>
          )}
        </Field>
        {!serviceId && <Field label="What was it"><input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={200} placeholder="Surface mix, #57 stone, sealer…" required /></Field>}
        <div className="form-grid">
          <Field label="How much"><input className="input" inputMode="decimal" value={quantity} onChange={(e) => setQuantity(e.target.value.replace(/[^0-9.]/g, ""))} required autoFocus /></Field>
          <Field label="Unit">
            <select className="select" value={unit} onChange={(e) => setUnit(e.target.value)}>
              {[...new Set([unit, ...UNITS])].map((u) => <option key={u}>{u}</option>)}
            </select>
          </Field>
          <Field label="Ticket number" optional><input className="input" value={ticket} onChange={(e) => setTicket(e.target.value)} maxLength={60} /></Field>
          <Field label="Supplier or plant" optional><input className="input" value={supplier} onChange={(e) => setSupplier(e.target.value)} maxLength={120} /></Field>
        </div>
        <label className="dropzone" style={{ padding: 14 }}>
          <Icon name="camera" size={20} />
          <span className="small strong">{file ? file.name : "Add a photo of the ticket"}</span>
          <input type="file" accept="image/*" capture="environment" className="sr-only" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </label>
        <FormError error={save.error} />
        <div className="form-actions">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!(amount > 0)}>Log it</Button>
        </div>
      </form>
    </Dialog>
  );
}
