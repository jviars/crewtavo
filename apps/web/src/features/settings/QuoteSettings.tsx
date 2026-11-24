/**
 * Settings → Company → Quotes and payments: the company's switches for its quotes, saved on their
 * own (merge_company_settings), so they never undo a change made elsewhere meanwhile.
 *   settings.payment_schedule.send   a scheduled payment's invoice goes to the client by itself
 *                                    (services/installments.ts), off unless set
 *   settings.quotes.alert_over       "Tell me about quotes over $X": owners, admins and the quote's
 *                                    salesperson hear when one is sent, approved or sent back for
 *                                    changes (20261113001120_high_value_quote_alerts.sql); off empty
 *   settings.quotes.draft_requests   a request from a booking form or the Client Hub gets a draft
 *                                    quote by itself (services/quoteDrafts.ts), off unless set
 *   settings.quote_ai                Draft a quote uses Claude: its own switch, saved at once by the
 *                                    server once Claude answers with the company's key (PUT
 *                                    /quotes/drafting), never with the Save button
 */
import { toUnits } from "@crewtavo/core/money";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Button, useJustDone } from "@/components/ui/Button";
import { DecimalInput } from "@/components/ui/DecimalInput";
import { Field, FormError } from "@/components/ui/Field";
import { api, supabase, unwrap } from "@/lib/api";
import { Section } from "@/components/ui/Section";
import { currencySymbol } from "@/lib/format";
import { useSession } from "@/lib/session";
import p from "./Prefs.module.css";
import { SwitchRow } from "./SettingsKit";
import { loadSettings } from "@/lib/companySettings";

interface QuoteForm {
  sendPayments: boolean;
  draftRequests: boolean;
  /** The amount as typed; empty is off. */
  alertOver: string;
}

/** The form's values from the company's settings. */
export function quoteForm(settings: unknown): QuoteForm {
  const s = (settings ?? {}) as Record<string, any>;
  const over = Number(s.quotes?.alert_over);
  return { sendPayments: s.payment_schedule?.send === true, draftRequests: s.quotes?.draft_requests === true, alertOver: typeof s.quotes?.alert_over === "number" && over > 0 ? String(over) : "" };
}

/** The alert amount to save: a number above 0 to the cent, null for off. Throws the field's message when it isn't one. */
export function alertAmount(typed: string): number | null {
  if (!typed.trim()) return null;
  const n = Number(typed);
  if (!(n > 0 && n <= 100_000_000)) throw new Error("Enter an amount above $0 for quote alerts, or leave it empty.");
  // Read as typed, so 2500.555 is $2,500.56 as the database rounds it.
  return Number(toUnits(typed, 2)) / 100;
}

export function QuoteSettings() {
  const session = useSession();
  const { company } = session;
  const queryClient = useQueryClient();
  const details = useQuery({
    queryKey: ["company", company.id],
    queryFn: async () => {
      const [row, settings] = await Promise.all([supabase().from("companies").select("name, slug, phone, email, website, address, timezone, currency, trade_preset").eq("id", company.id).single(), loadSettings(company.id)]);
      return { ...unwrap(row), settings };
    },
  });
  const [f, setF] = useState<QuoteForm | null>(null);
  useEffect(() => {
    if (details.data && !f) setF(quoteForm(details.data.settings));
  }, [details.data, f]);
  const save = useMutation({
    meta: { inline: true },
    mutationFn: async (v: QuoteForm) => {
      const settings = { payment_schedule: { send: v.sendPayments }, quotes: { alert_over: alertAmount(v.alertOver), draft_requests: v.draftRequests } };
      unwrap(await supabase().rpc("merge_company_settings", { p_company: company.id, p_settings: settings as never }));
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["company", company.id] });
      session.refresh();
    },
  });
  const saved = useJustDone(save);
  // Claude for drafts: the server checks the key with Claude before it turns on.
  const ai = useMutation({
    meta: { inline: true },
    mutationFn: (on: boolean) => api.put<{ on: boolean }>("/quotes/drafting", { ai: on }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["company", company.id] });
      session.refresh();
    },
  });
  const aiOn = ((details.data?.settings ?? {}) as { quote_ai?: { on?: boolean } }).quote_ai?.on === true;
  if (!f) return null;
  // Saved values as the form shows them, to say what's waiting to be saved.
  const dirty = details.data ? JSON.stringify(f) !== JSON.stringify(quoteForm(details.data.settings)) : false;
  return (
    <form onSubmit={(e) => { e.preventDefault(); save.mutate(f); }}>
      <Section level={3} title="Quotes and payments">
        <Field label="Tell me about quotes over" optional hint="When a quote of at least this much is sent, approved, or the client asks for changes, owners, admins and its salesperson hear about it on the bell and their phone, except whoever did it. Empty is off.">
          <span className="input-group set-narrow">
            <span className="addon">{currencySymbol()}</span>
            <DecimalInput className="input" inputMode="decimal" style={{ paddingLeft: 22 }} value={f.alertOver} placeholder="Off" onChange={(e) => setF({ ...f, alertOver: e.target.value.replace(/[^0-9.]/g, "") })} />
          </span>
        </Field>
        <div className={`set-rows ${p.after}`}>
          <SwitchRow
            label="Draft quotes with AI"
            hint="Draft a quote, on a request, has AI read what the client asked for and pick lines from your price list, with quantities when they gave them. It never makes up an item or a price, and nothing is sent: you look it over. Each draft is an ask of your Claude or OpenAI key from the Apps page (or, when someone presses Draft a quote themselves, of their own ChatGPT plan if they connected one). Off, drafts take the price list items whose names match their answers. Saved as you switch it."
            checked={ai.isPending ? Boolean(ai.variables) : aiOn}
            disabled={ai.isPending}
            onChange={(on) => ai.mutate(on)}
          >
            {/* Saved on its own, so what went wrong is said right under it. */}
            <FormError error={ai.error} />
          </SwitchRow>
          <SwitchRow
            label="Draft a quote when a request comes in"
            hint="For requests from your booking forms and the Client Hub. The person the request is assigned to, or else the office, is told when the draft is ready."
            checked={f.draftRequests}
            onChange={(on) => setF({ ...f, draftRequests: on })}
          />
          <SwitchRow
            label="Send scheduled payments to clients by themselves"
            hint="A quote's payment schedule becomes invoices on its job as each payment comes due. Off, each one waits in Drafts and the people who handle invoices are told. On, it's sent to the client the usual way, and they're told only if it couldn't be sent. A payment due when the work starts waits 30 minutes after the first visit is started, and isn't sent if that visit is put back in that time."
            checked={f.sendPayments}
            onChange={(on) => setF({ ...f, sendPayments: on })}
          />
        </div>
        <FormError error={save.error} />
        <div className={p.groupSave}>
          <Button type="submit" size="sm" loading={save.isPending} done={saved} disabled={!dirty && !saved}>Save</Button>
          {dirty && !save.isPending && <span className="set-save-note">Not saved yet</span>}
        </div>
      </Section>
    </form>
  );
}
