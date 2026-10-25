/**
 * Marking subs' pay paid, one or several at once (POST /api/job-pay/mark-paid), after the business has
 * paid them: Crewtavo moves no money. The day, how, a reference, and for one, the amount if it wasn't
 * the total. A team member's piece pay is paid with their pay period instead (Timesheets → Pay).
 */
import { jobPayMethodLabel, SUB_PAY_METHODS, type SubPayMethod } from "@crewtavo/core/jobPay";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Field, FormError } from "@/components/ui/Field";
import { readAmount } from "@/components/ui/MoneyInput";
import { formatMoneyCents, todayIn } from "@/lib/format";
import { useSession } from "@/lib/session";
import { markPaid, refreshPay } from "./payData";

export interface ToPay { id: string; total: number | string; label: string }

export function MarkPaidDialog({ pays, onClose, onPaid }: { pays: readonly ToPay[]; onClose: () => void; onPaid?: () => void }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const today = todayIn(session.company.timezone);
  const total = Math.round(pays.reduce((s, p) => s + Number(p.total) * 100, 0)) / 100;
  const one = pays.length === 1;
  const [paidOn, setPaidOn] = useState(today);
  const [method, setMethod] = useState<SubPayMethod>("check");
  const [reference, setReference] = useState("");
  const [amount, setAmount] = useState(String(total));
  const save = useMutation({
    meta: { inline: true, success: (r: { paid: unknown[] }) => (r.paid.length === 1 ? "Marked paid" : `Marked ${r.paid.length} paid`) },
    mutationFn: () => {
      const value = one ? readAmount(amount, { max: 10_000_000 }) : null;
      if (one && value === null) throw new Error("Enter the amount you paid.");
      return markPaid({ ids: pays.map((p) => p.id), method, paid_on: paidOn, reference: reference.trim() || null, amount: one && value !== total ? value : null });
    },
    onSuccess: () => {
      refreshPay(queryClient);
      onPaid?.();
      onClose();
    },
  });
  const description = one
    ? `${pays[0]!.label}, ${formatMoneyCents(total)}. Record this after you've paid them: Crewtavo doesn't send money.`
    : `${pays.length} jobs, ${formatMoneyCents(total)}. Record this after you've paid them: Crewtavo doesn't send money.`;
  return (
    <Dialog open onClose={onClose} title="Mark paid" description={description}>
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(); }}>
        <div className="form-grid">
          <Field label="Paid on"><input className="input" type="date" value={paidOn} max={today} onChange={(e) => e.target.value && setPaidOn(e.target.value)} required /></Field>
          {one ? (
            <Field label="Amount" hint={Number(amount) !== total ? `Their pay comes to ${formatMoneyCents(total)}.` : undefined}>
              <span className="input-group">
                <span className="addon">$</span>
                <input className="input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} style={{ paddingLeft: 24, textAlign: "right" }} required />
              </span>
            </Field>
          ) : (
            <Field label="Amount" hint="Each job's total. To pay a different amount, mark them one at a time.">
              <input className="input" value={formatMoneyCents(total)} readOnly disabled />
            </Field>
          )}
        </div>
        <Field
          label="How you paid"
          hint={
            method === "card_or_app" ? "Card and payment-app payments are left out of their 1099 total: the card company or app reports those."
              : method === "payroll" ? "Counted in their 1099 total. If your payroll service paid them, it may file their 1099 itself: check before you send one."
                : undefined
          }
        >
          <select className="select" value={method} onChange={(e) => setMethod(e.target.value as SubPayMethod)}>
            {SUB_PAY_METHODS.map((m) => <option key={m} value={m}>{jobPayMethodLabel(m)}</option>)}
          </select>
        </Field>
        <Field label="Reference" optional hint="A check number or the transfer's confirmation."><input className="input" value={reference} onChange={(e) => setReference(e.target.value)} maxLength={200} /></Field>
        <FormError error={save.error} />
        <div className="form-actions">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" icon="check" loading={save.isPending}>Mark paid</Button>
        </div>
      </form>
    </Dialog>
  );
}
