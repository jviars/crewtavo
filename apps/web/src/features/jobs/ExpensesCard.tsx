/** Materials, dump fees and other costs on a job, with receipt photos. Feeds job costing. */
import { TRASH_DAYS } from "@crewtavo/core/drive";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { Dialog } from "@/components/ui/Dialog";
import { Field, FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { Menu } from "@/components/ui/Menu";
import { Skeleton } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/ui/States";
import { supabase, unwrap } from "@/lib/api";
import { signedUrls, uploadFile } from "@/lib/files";
import { formatDate, formatMoneyCents, todayIn } from "@/lib/format";
import { useSession } from "@/lib/session";
import { toast } from "@/lib/toast";
import { TRASH_PATH } from "../drive/trash";

export const EXPENSE_CATEGORIES = ["Materials", "Equipment rental", "Equipment upkeep", "Fuel", "Dump fees", "Subcontractor", "Permits", "Supplies", "Other"];

interface Expense {
  id: string;
  vendor: string | null;
  description: string | null;
  category: string | null;
  amount: number;
  incurred_on: string;
  receipt_path: string | null;
  reimbursable: boolean;
  reimbursed_at: string | null;
}

export function ExpensesCard({ jobId, onChanged }: { jobId: string; onChanged: () => void }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [editing, setEditing] = useState<Expense | "new" | null>(null);
  const key = ["job", jobId, "expenses"];
  const expenses = useQuery({
    queryKey: key,
    queryFn: async () => {
      const rows = unwrap(await supabase().from("expenses").select("id, vendor, description, category, amount, incurred_on, receipt_path, reimbursable, reimbursed_at").eq("job_id", jobId).order("incurred_on", { ascending: false }));
      const urls = await signedUrls(rows.flatMap((r) => (r.receipt_path ? [r.receipt_path] : []))).catch(() => ({}) as Record<string, string>);
      return rows.map((r) => ({ ...r, receipt_url: r.receipt_path ? urls[r.receipt_path] ?? null : null }));
    },
  });
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: key });
    onChanged();
  };
  // Its receipt photo goes to the Trash by itself (the database moves it).
  const remove = useMutation({
    mutationFn: async (e: Expense) => unwrap(await supabase().from("expenses").delete().eq("id", e.id)),
    onSuccess: (_, e) => {
      toast.success("Expense deleted", e.receipt_path ? { description: `Its receipt photo is in the Trash for ${TRASH_DAYS} days.`, action: { label: "Open the Trash", onClick: () => navigate(TRASH_PATH) } } : undefined);
      refresh();
    },
  });
  const reimburse = useMutation({
    meta: { success: "Marked reimbursed" },
    mutationFn: async (id: string) => unwrap(await supabase().from("expenses").update({ reimbursed_at: new Date().toISOString() }).eq("id", id)),
    onSuccess: refresh,
  });
  const total = expenses.data?.reduce((s, e) => s + Number(e.amount), 0) ?? 0;

  return (
    <section className="stack">
      <div className="section-head">
        <h2 className="section-title">Expenses</h2>
        {!!expenses.data?.length && <span className="muted tabular">{formatMoneyCents(total)}</span>}
        <Button size="sm" icon="plus" onClick={() => setEditing("new")}>Add expense</Button>
      </div>
      <div className="card">
        {expenses.isPending && [0, 1].map((i) => <div key={i} className="card-row"><Skeleton width={36} height={36} radius={8} /><span className="grow stack-sm"><Skeleton width="40%" /><Skeleton width="25%" height={10} /></span><Skeleton width={70} /></div>)}
        {expenses.data?.length === 0 && <EmptyState compact icon="receipt" title="No expenses yet" />}
        {expenses.data?.map((e) => (
          <div key={e.id} className="card-row">
            {e.receipt_url ? (
              <a href={e.receipt_url} target="_blank" rel="noreferrer" className="thumb" style={{ width: 40, height: 40, flex: "none" }} aria-label="Open receipt"><img src={e.receipt_url} alt="" /></a>
            ) : (
              <span className="n-icon" style={{ width: 40, height: 40, borderRadius: 10, display: "grid", placeItems: "center", background: "var(--fill-2)", color: "var(--text-3)", flex: "none" }}><Icon name="receipt" size={18} /></span>
            )}
            <span className="grow">
              <strong>{e.vendor || e.category || "Expense"}</strong>
              <span className="muted small" style={{ display: "block" }}>
                {[e.category, e.description, formatDate(e.incurred_on)].filter(Boolean).join(" · ")}
                {e.reimbursable && (e.reimbursed_at ? " · reimbursed" : " · to reimburse")}
              </span>
            </span>
            <strong className="tabular">{formatMoneyCents(e.amount)}</strong>
            <Menu
              triggerClassName="btn btn-sm btn-ghost btn-icon"
              label="Expense actions"
              items={[
                { label: "Edit", icon: "edit", onSelect: () => setEditing(e) },
                { label: "Mark reimbursed", icon: "check", hidden: !e.reimbursable || Boolean(e.reimbursed_at), onSelect: () => reimburse.mutate(e.id) },
                { label: "Delete", icon: "trash", danger: true, onSelect: async () => (await confirm({ title: "Delete this expense?", confirmLabel: "Delete", danger: true })) && remove.mutate(e) },
              ]}
            />
          </div>
        ))}
      </div>
      {editing && <ExpenseDialog jobId={jobId} expense={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={refresh} />}
    </section>
  );
}

export function ExpenseDialog({ jobId, expense, onClose, onSaved }: { jobId: string | null; expense: Expense | null; onClose: () => void; onSaved: () => void }) {
  const session = useSession();
  const [f, setF] = useState({
    vendor: expense?.vendor ?? "",
    category: expense?.category ?? "Materials",
    description: expense?.description ?? "",
    amount: expense ? String(expense.amount) : "",
    incurred_on: expense?.incurred_on ?? todayIn(session.company.timezone),
    reimbursable: expense?.reimbursable ?? false,
  });
  const [file, setFile] = useState<File | null>(null);
  const amount = Number(f.amount);
  const save = useMutation({
    meta: { inline: true, success: expense ? "Expense saved" : "Expense added" },
    mutationFn: async () => {
      if (!(amount > 0)) throw new Error("Enter an amount greater than zero.");
      const receipt_path = file ? await uploadFile(session.company.id, "receipts", file) : expense?.receipt_path ?? null;
      const row = {
        vendor: f.vendor.trim() || null, category: f.category, description: f.description.trim() || null,
        amount: Math.round(amount * 100) / 100, incurred_on: f.incurred_on, reimbursable: f.reimbursable, receipt_path,
      };
      if (expense) unwrap(await supabase().from("expenses").update(row).eq("id", expense.id));
      else unwrap(await supabase().from("expenses").insert({ ...row, company_id: session.company.id, job_id: jobId }));
    },
    onSuccess: () => {
      onSaved();
      onClose();
    },
  });
  return (
    <Dialog open onClose={onClose} title={expense ? "Edit expense" : "Add expense"}>
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(); }}>
        <div className="form-grid">
          <Field label="Amount"><span className="input-group"><span className="addon">$</span><input className="input" inputMode="decimal" style={{ paddingLeft: 22 }} value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value.replace(/[^0-9.]/g, "") })} required autoFocus /></span></Field>
          <Field label="Date"><input className="input" type="date" value={f.incurred_on} onChange={(e) => setF({ ...f, incurred_on: e.target.value })} required /></Field>
          <Field label="Vendor" optional><input className="input" value={f.vendor} onChange={(e) => setF({ ...f, vendor: e.target.value })} maxLength={120} placeholder="Home Depot, quarry…" /></Field>
          <Field label="Category">
            <select className="select" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>
              {EXPENSE_CATEGORIES.map((c) => <option key={c}>{c}</option>)}
            </select>
          </Field>
        </div>
        <Field label="Description" optional><input className="input" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} maxLength={300} /></Field>
        <label className="dropzone" style={{ padding: 14 }}>
          <Icon name="camera" size={20} />
          <span className="small strong">{file ? file.name : expense?.receipt_path ? "Replace the receipt photo" : "Add a receipt photo"}</span>
          <input type="file" accept="image/*,application/pdf" capture="environment" className="sr-only" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </label>
        <label className="checkbox"><input type="checkbox" checked={f.reimbursable} onChange={(e) => setF({ ...f, reimbursable: e.target.checked })} /> Paid with my own money (reimburse me)</label>
        <FormError error={save.error} />
        <div className="form-actions">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!(amount > 0)}>{expense ? "Save" : "Add expense"}</Button>
        </div>
      </form>
    </Dialog>
  );
}
