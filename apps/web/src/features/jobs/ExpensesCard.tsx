/** Materials, dump fees and other costs on a job, with receipt photos. Feeds job costing. */
import { TRASH_DAYS } from "@crewtavo/core/drive";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { AnimatedNumber, MONEY_CENTS } from "@/components/ui/AnimatedNumber";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Field, FormChecks, FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { Menu } from "@/components/ui/Menu";
import { Skeleton } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/ui/States";
import { supabase, unwrap } from "@/lib/api";
import { signedUrls, uploadFile } from "@/lib/files";
import { formatDate, formatMoneyCents, todayIn } from "@/lib/format";
import { useListAnimation } from "@/lib/motion";
import { useSession } from "@/lib/session";
import { undoable } from "@/lib/undo";

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

const expensesKey = (jobId: string) => ["job", jobId, "expenses"];

/** A job's expenses with their receipt links, newest first. The job page asks too, to know whether to show the card. */
export function useJobExpenses(jobId: string, enabled = true) {
  return useQuery({
    queryKey: expensesKey(jobId),
    enabled,
    queryFn: async () => {
      const rows = unwrap(await supabase().from("expenses").select("id, vendor, description, category, amount, incurred_on, receipt_path, reimbursable, reimbursed_at").eq("job_id", jobId).order("incurred_on", { ascending: false }));
      const urls = await signedUrls(rows.flatMap((r) => (r.receipt_path ? [r.receipt_path] : []))).catch(() => ({}) as Record<string, string>);
      return rows.map((r) => ({ ...r, receipt_url: r.receipt_path ? urls[r.receipt_path] ?? null : null }));
    },
  });
}
type ExpenseRow = NonNullable<ReturnType<typeof useJobExpenses>["data"]>[number];

/**
 * The job page shows it once the job has an expense, or opens it with the dialog up (startAdding)
 * from its add buttons; onAddClosed tells it that dialog has closed, so an empty card can go again.
 */
export function ExpensesCard({ jobId, onChanged, startAdding = false, onAddClosed }: { jobId: string; onChanged: () => void; startAdding?: boolean; onAddClosed?: () => void }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<Expense | "new" | null>(startAdding ? "new" : null);
  const listRef = useListAnimation<HTMLDivElement>();
  const key = expensesKey(jobId);
  const expenses = useJobExpenses(jobId);
  const refresh = () => {
    onChanged();
    return queryClient.invalidateQueries({ queryKey: key });
  };
  // Its receipt photo goes to the Trash by itself (the database moves it).
  const remove = useMutation({
    meta: { inline: true },
    mutationFn: async (e: Expense) => unwrap(await supabase().from("expenses").delete().eq("id", e.id)),
    onSuccess: () => void refresh(),
  });
  // Gone at once with Undo on the toast; deleted for real once the toast leaves, its receipt to the Trash.
  const removeLater = (e: ExpenseRow) =>
    undoable({
      title: "Expense deleted",
      description: e.receipt_path ? `Its receipt photo goes to the Trash for ${TRASH_DAYS} days.` : undefined,
      tone: "job",
      hide: () => {
        void queryClient.cancelQueries({ queryKey: key });
        queryClient.setQueryData<ExpenseRow[]>(key, (rows) => rows?.filter((r) => r.id !== e.id));
      },
      restore: () => queryClient.setQueryData<ExpenseRow[]>(key, (rows) => (rows && !rows.some((r) => r.id === e.id) ? [...rows, e].sort((a, b) => b.incurred_on.localeCompare(a.incurred_on)) : rows)),
      commit: () => remove.mutateAsync(e),
    });
  const close = () => {
    setEditing(null);
    onAddClosed?.();
  };
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
        {!!expenses.data?.length && <AnimatedNumber className="muted tabular" value={total} format={MONEY_CENTS} />}
        <Button size="sm" icon="plus" onClick={() => setEditing("new")}>Add expense</Button>
      </div>
      <div className="card" ref={listRef}>
        {expenses.isPending && [0, 1].map((i) => <div key={i} className="card-row"><Skeleton width={40} height={40} radius={8} /><span className="grow stack-sm"><Skeleton width="40%" /><Skeleton width="25%" height={10} /></span><Skeleton width={70} /></div>)}
        {expenses.data?.length === 0 && <EmptyState inline title="No expenses yet" />}
        {expenses.data?.map((e) => (
          <div key={e.id} className="card-row">
            {e.receipt_url ? (
              <a href={e.receipt_url} target="_blank" rel="noreferrer" className="thumb" style={{ width: 40, height: 40, flex: "none" }} aria-label="Open receipt"><img src={e.receipt_url} alt="" /></a>
            ) : (
              <span className="n-icon" style={{ width: 40, height: 40, borderRadius: 8, display: "grid", placeItems: "center", background: "var(--fill-2)", color: "var(--text-3)", flex: "none" }}><Icon name="receipt" size={20} /></span>
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
                { label: "Delete", icon: "trash", danger: true, onSelect: () => removeLater(e) },
              ]}
            />
          </div>
        ))}
      </div>
      {editing && <ExpenseDialog jobId={jobId} expense={editing === "new" ? null : editing} onClose={close} onSaved={refresh} />}
    </section>
  );
}

/** onSaved may return a promise (a refetch): the dialog stays until it's done, so the change is there as it closes. */
export function ExpenseDialog({ jobId, expense, onClose, onSaved }: { jobId: string | null; expense: Expense | null; onClose: () => void; onSaved: () => unknown }) {
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
    onSuccess: async () => {
      await onSaved();
      onClose();
    },
  });
  return (
    <Dialog open onClose={onClose} title={expense ? "Edit expense" : "Add expense"}>
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(); }}>
        <div className="form-grid">
          <Field label="Amount" requiredMessage="Enter what it cost."><span className="input-group"><span className="addon">$</span><input className="input" inputMode="decimal" style={{ paddingLeft: 22 }} value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value.replace(/[^0-9.]/g, "") })} required autoFocus /></span></Field>
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
          <FormChecks />
          <Button onClick={onClose}>Cancel</Button>
          {/* With a receipt photo it uploads, which is slow anyway. */}
          <Button type="submit" variant="primary" loading={save.isPending} slowHint={file ? false : undefined}>{expense ? "Save" : "Add expense"}</Button>
        </div>
      </form>
    </Dialog>
  );
}
