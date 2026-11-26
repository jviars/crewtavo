/**
 * The office's "Texts" switch for a client's or a contact's number. Someone who phones, emails or
 * says in person "please stop texting me" has to be honoured as much as someone who texts STOP, so
 * owners, admins and the office can turn texts off here, saying how they were asked, and back on
 * only when the person asked for that. The server keeps it in the stop list every send checks
 * (POST /clients/:id/texts), with who set it.
 *
 * A number that texted STOP can't be turned back on here: the texting service (Quo or Twilio) refuses it until they text START.
 */
import { STOP_HOW_LABELS, STOP_HOWS, textsOffWhy, twilioHasStop, type StopHow, type TextStop } from "@crewtavo/core/marketing";
import { phoneMatchKey } from "@crewtavo/core/recipients";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { Dialog } from "@/components/ui/Dialog";
import { Field } from "@/components/ui/Field";
import { Select } from "@/components/ui/Select";
import { api, supabase, unwrap } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { useSession } from "@/lib/session";

export interface StopRow extends TextStop {
  phone_key: string;
  stopped_at: string;
}

const stopsKey = (companyId: string) => ["text-stops", companyId];

/** The stops among these numbers (a client's and their contacts'), by the number's last 10 digits. */
export function useTextStops(phones: ReadonlyArray<string | null | undefined>, enabled = true) {
  const { company } = useSession();
  const keys = [...new Set(phones.map(phoneMatchKey).filter(Boolean))].sort();
  const stops = useQuery({
    queryKey: [...stopsKey(company.id), keys.join(",")],
    enabled: enabled && keys.length > 0,
    meta: { silent: true },
    queryFn: async () => unwrap(await supabase().from("sms_stops").select("phone_key, stopped_at, source, how, note, set_by_name").eq("company_id", company.id).in("phone_key", keys)) as StopRow[],
  });
  return (phone: string | null | undefined): StopRow | null => stops.data?.find((row) => row.phone_key === phoneMatchKey(phone)) ?? null;
}

/** What was asked before turning texts back on by hand. */
export const TEXTS_BACK_ON_BODY =
  "Only turn texts back on if they asked you to. Texting rules want that in writing, so keep their email or message if you can.";

export function TextsSwitch({ clientId, contactId, name, phone, stop, since, label = "Gets texts" }: {
  clientId: string;
  contactId?: string;
  name: string;
  phone: string;
  /** The number's stop, when it has one. */
  stop: StopRow | null;
  /** For the client's own phone: when their texts went off (clients.sms_opt_out_at). */
  since?: string | null;
  label?: string;
}) {
  const { company } = useSession();
  const queryClient = useQueryClient();
  const [asking, setAsking] = useState(false);
  const [how, setHow] = useState<StopHow>("phone");
  const [note, setNote] = useState("");
  const off = Boolean(stop || since);
  // Twilio has their STOP: only their START turns texts back on.
  const locked = Boolean(stop && twilioHasStop(stop.source));
  const set = useMutation({
    meta: { success: (r: { on: boolean }) => (r.on ? "Texts turned back on" : "Texts turned off") },
    mutationFn: (body: { on: boolean; how?: StopHow; note?: string }) => api.post<{ on: boolean; phone: string }>(`/clients/${clientId}/texts`, { ...body, ...(contactId ? { contact_id: contactId } : {}) }),
    onSuccess: () => {
      setAsking(false);
      setNote("");
      queryClient.invalidateQueries({ queryKey: ["client", clientId] });
      queryClient.invalidateQueries({ queryKey: stopsKey(company.id) });
    },
  });
  const flip = async () => {
    if (!off) return setAsking(true);
    if (await confirm({ title: `Turn texts back on for ${name}?`, body: TEXTS_BACK_ON_BODY, confirmLabel: "They asked, turn texts on" })) set.mutate({ on: true });
  };
  const when = stop?.stopped_at ?? since;
  return (
    <>
      <label className="switch-row" style={{ fontWeight: 400 }}>
        <input type="checkbox" className="switch" checked={!off} disabled={locked || set.isPending} onChange={() => void flip()} />
        {label}
      </label>
      {off && (
        <span className="muted small" style={{ display: "block" }}>
          {when ? `Off since ${formatDate(when)}. ` : ""}
          {textsOffWhy(stop)}
        </span>
      )}
      <Dialog open={asking} onClose={() => setAsking(false)} title={`Turn off texts for ${name}?`} size="sm">
        <form onSubmit={(e: FormEvent) => { e.preventDefault(); set.mutate({ on: false, how, ...(note.trim() ? { note: note.trim() } : {}) }); }}>
          <p className="muted" style={{ marginTop: 0 }}>
            Crewtavo won't text {phone} again: no reminders, visit notices, on-my-way texts, quotes, invoices or review asks. Emails still go.
          </p>
          <Field label="How did they ask?">
            <Select className="input" value={how} onChange={(e) => setHow(e.target.value as StopHow)}>
              {STOP_HOWS.map((value) => <option key={value} value={value}>{STOP_HOW_LABELS[value]}</option>)}
            </Select>
          </Field>
          <Field label="Note" optional>
            <input className="input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="What they said, if it helps later" />
          </Field>
          <div className="form-actions">
            <Button onClick={() => setAsking(false)}>Cancel</Button>
            <Button type="submit" variant="primary" loading={set.isPending}>Turn texts off</Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
