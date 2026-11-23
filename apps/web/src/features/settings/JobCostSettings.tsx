/**
 * Settings → Company → Job costing: "Tell me when a job's profit falls below X%"
 * (settings.profit_alert_percent, off unless set). The server checks every hour
 * (apps/api/src/services/profitAlerts.ts) and the people who see job costs are told as a job goes
 * below. Saved by itself, through merge_company_settings, which only owners and admins get through.
 *
 * And Receipts: reading receipts and supplier invoices with Claude (settings.receipt_reading), off
 * until an owner or admin turns it on, which the server does only once the Claude key answers.
 */
import { profitAlertPercent } from "@crewtavo/core/reports";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Button, useJustDone } from "@/components/ui/Button";
import { Field, FormChecks, FormError } from "@/components/ui/Field";
import { api, supabase, unwrap } from "@/lib/api";
import { Section } from "@/components/ui/Section";
import { useSession } from "@/lib/session";
import { readingOn } from "../jobs/receiptReading";
import p from "./Prefs.module.css";
import { Suffix, SwitchRow } from "./SettingsKit";

export function JobCostSettings({ settings }: { settings: Record<string, unknown> }) {
  const session = useSession();
  const { company } = session;
  const queryClient = useQueryClient();
  const saved = profitAlertPercent(settings);
  const [on, setOn] = useState(saved !== null);
  const [percent, setPercent] = useState(saved !== null ? String(saved) : "20");
  const save = useMutation({
    meta: { inline: true },
    mutationFn: async () => {
      const value = on ? Number(percent) : null;
      if (value !== null && !(Number.isInteger(value) && value >= 1 && value <= 99)) throw new Error("Enter a whole percent from 1 to 99.");
      unwrap(await supabase().rpc("merge_company_settings", { p_company: company.id, p_settings: { profit_alert_percent: value } as never }));
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["company", company.id] });
      session.refresh();
    },
  });
  const done = useJustDone(save);
  const changed = on !== (saved !== null) || (on && Number(percent) !== saved);
  // Reading receipts spends the company's Claude key, so the server checks the key before it turns on.
  const [reads, setReads] = useState(readingOn(settings));
  const reading = useMutation({
    meta: { inline: true },
    mutationFn: (next: boolean) => api.put<{ on: boolean }>("/receipts/reading", { on: next }),
    onSuccess: (r) => {
      setReads(r.on);
      queryClient.invalidateQueries({ queryKey: ["company", company.id] });
      session.refresh();
    },
  });

  return (
    <>
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(); }}>
        <Section level={3} title="Job costing">
          <div className="set-rows">
            <SwitchRow
              label="Tell me when a job's profit falls below a margin"
              hint={
                <>
                  Checked every hour, for one-off jobs with a price and some time, pay, expenses or materials on them, over the whole job, as job costing counts it. Repeating jobs aren&apos;t checked, since their price is for a visit or a month.
                  The people who see job costs get one notification as a job goes below, and another only if it comes back up and falls again.
                  After you change the margin, the jobs already below it are listed under Below your margin on the Jobs page instead of one notification each.
                </>
              }
              checked={on}
              onChange={setOn}
            >
              {on && (
                <Field label={<>Margin<span className="sr-only"> (%)</span></>} hint="A whole percent. Job costing on the job's page shows a warning while it's below." className="set-narrow">
                  <Suffix unit="%"><input className="input" inputMode="numeric" value={percent} onChange={(e) => setPercent(e.target.value.replace(/[^0-9]/g, "").slice(0, 2))} required /></Suffix>
                </Field>
              )}
            </SwitchRow>
          </div>
          <FormError error={save.error} />
          <div className={p.groupSave}>
            <Button type="submit" size="sm" loading={save.isPending} done={done} disabled={!changed}>Save</Button>
            {changed && !save.isPending && <span className="set-save-note">Not saved yet</span>}
            <FormChecks />
          </div>
        </Section>
      </form>
      <Section level={3} title="Receipts">
        <div className="set-rows">
          <SwitchRow
            label="Read receipts and supplier invoices with AI"
            hint={
              <>
                A photo or PDF added to an expense, by the office or the crew, fills in the vendor, date, total, tax and category, and a supplier invoice&apos;s lines, for whoever adds it to check before saving.
                The office can also drop several at once on a job&apos;s Expenses or on Finance → Profit. Each read uses your Claude or OpenAI key from the Apps page, which is checked before this turns on (or the ChatGPT plan of whoever adds the receipt, if they connected one).
                Off, or when a file can&apos;t be read, expenses are filled in by hand.
              </>
            }
            checked={reading.isPending ? Boolean(reading.variables) : reads}
            disabled={reading.isPending}
            onChange={(next) => reading.mutate(next)}
          />
        </div>
        <FormError error={reading.error} />
      </Section>
    </>
  );
}
