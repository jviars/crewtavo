/**
 * Sending a roof estimate to the homeowner: by email, by text, or as a link to paste anywhere.
 *
 * - "range": the price range (POST /roofing/:id/send-range). The message starts as the words the
 *   range goes out with; only a changed message is sent, so the server's range is the one quoted.
 * - "exact": the exact price, to sign online (POST /quotes/:id/send). When a range is out, the
 *   estimate leaves range mode first (exact_sent_at: sent from the office, not priced on site), so
 *   the link shows the exact price; if the send fails, it goes back.
 */
import { inRangeMode, rangeSettings } from "@crewtavo/core/estimates";
import { useMutation } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Field, FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { api, supabase, unwrap } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { formatMoneyCents } from "@/lib/format";
import { useSession } from "@/lib/session";
import type { EstimateQuote } from "../estimate";
import { capital, estimateSubject, homeownerName, OPEN, rangeIntro, rangeNow, rangeWords } from "./model";
import styles from "./flow.module.css";

type Channel = "email" | "sms" | "link";

export type SendQuote = Pick<EstimateQuote, "id" | "number" | "status" | "total" | "range_low" | "priced_on_site_at" | "exact_sent_at" | "client">;

interface Sent {
  link: string;
  sent: boolean;
  reason?: string;
}

export function SendEstimateDialog({ quote, mode, startWith, onClose, onSent }: {
  quote: SendQuote;
  mode: "range" | "exact";
  /** Open on this tab ("link" for Copy link). */
  startWith?: Channel;
  onClose: () => void;
  onSent: () => void;
}) {
  const { company, config } = useSession();
  const email = quote.client?.email ?? null;
  const phone = quote.client?.phone ?? null;
  const who = homeownerName(quote.client?.display_name);
  const range = rangeNow(quote, rangeSettings(company.settings));
  const defaultMessage = mode === "range" ? rangeIntro(range) : "";
  const defaultSubject = estimateSubject(company.name);
  const [channel, setChannel] = useState<Channel>(startWith ?? (email ? "email" : phone ? "sms" : "link"));
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState(defaultSubject);
  const [message, setMessage] = useState(defaultMessage);
  useEffect(() => setTo(channel === "email" ? email ?? "" : channel === "sms" ? phone ?? "" : ""), [channel, email, phone]);
  const leavesRange = mode === "exact" && inRangeMode(quote);

  const send = useMutation({
    meta: { inline: true },
    mutationFn: async (): Promise<Sent> => {
      const body = {
        channel,
        to: channel === "link" ? undefined : to.trim() || undefined,
        // A range's own subject is the server's; the exact price goes out as a roof estimate, not "Quote #1042".
        subject: channel !== "email" ? undefined : mode === "exact" ? subject.trim() || defaultSubject : subject.trim() && subject.trim() !== defaultSubject ? subject.trim() : undefined,
        message: channel !== "link" && message.trim() && message.trim() !== defaultMessage.trim() ? message.trim() : undefined,
      };
      if (mode === "range") return api.post<Sent>(`/roofing/${quote.id}/send-range`, body);
      if (!leavesRange) return api.post<Sent>(`/quotes/${quote.id}/send`, body);
      // The link has to show the exact price, not the range: set it before sending, undo it if the send fails.
      const db = supabase();
      unwrap(await db.from("quotes").update({ exact_sent_at: new Date().toISOString() }).eq("id", quote.id).in("status", OPEN));
      try {
        return await api.post<Sent>(`/quotes/${quote.id}/send`, body);
      } catch (error) {
        await db.from("quotes").update({ exact_sent_at: null }).eq("id", quote.id).in("status", OPEN);
        throw error;
      }
    },
    onSuccess: (r) => {
      onSent();
      if (channel === "link") void copyText(r.link, `Link copied. Paste it into a message to ${who}.`);
    },
  });

  const unavailable = (channel === "email" && !config.features.email) || (channel === "sms" && !config.features.sms);
  const done = send.data;
  const title = done ? (done.sent ? "Sent" : "Link ready") : mode === "range" ? `Send the range to ${who}` : `Send ${who} the exact price`;
  const description = done
    ? undefined
    : mode === "range"
      ? `${capital(who)} sees ${rangeWords(range)}, what's included, and a button to ask for a visit.`
      : `The link shows the estimate at its exact price, ${formatMoneyCents(quote.total)}, ready to sign online.`;

  return (
    <Dialog open onClose={onClose} title={title} description={description}>
      {done ? (
        <div className="dialog-body">
          {done.sent ? (
            <div className="stack-sm" style={{ justifyItems: "center", textAlign: "center", padding: "8px 0" }}>
              <span className="success-mark"><Icon name="check" size={30} strokeWidth={2.5} /></span>
              <strong style={{ fontSize: 16 }}>{channel === "email" ? `Emailed to ${to}` : `Texted to ${to}`}</strong>
              {config.features.devMail && <span className="muted small">Development mode: it's in the local Mailpit inbox.</span>}
            </div>
          ) : (
            done.reason && done.reason !== "Link only" && <div className="callout callout-warning"><Icon name="alert" size={18} /><div className="grow">{done.reason} Copy the link and send it yourself.</div></div>
          )}
          <div className="field">
            <span>{capital(who)}'s link</span>
            <div className="row">
              <input className="input" readOnly value={done.link} aria-label="The link" onFocus={(e) => e.target.select()} />
              <Button icon="copy" onClick={() => copyText(done.link, "Link copied")}>Copy</Button>
            </div>
          </div>
          <div className="form-actions">
            <a className="btn" href={done.link} target="_blank" rel="noreferrer"><Icon name="external" size={16} />Open it</a>
            <Button variant="primary" onClick={onClose}>Done</Button>
          </div>
        </div>
      ) : (
        <form onSubmit={(e: FormEvent) => { e.preventDefault(); send.mutate(); }}>
          <div className="segmented" role="group" aria-label="How to send it">
            <button type="button" aria-pressed={channel === "email"} onClick={() => setChannel("email")}>Email</button>
            <button type="button" aria-pressed={channel === "sms"} onClick={() => setChannel("sms")}>Text</button>
            <button type="button" aria-pressed={channel === "link"} onClick={() => setChannel("link")}>Copy link</button>
          </div>
          {leavesRange && (
            <div className="callout callout-info">
              <Icon name="info" size={18} />
              <div className="grow">From now on, {who}'s link shows this exact price instead of the range.</div>
            </div>
          )}
          {unavailable && (
            <div className="callout callout-info">
              <Icon name="info" size={18} />
              <div className="grow">{channel === "email" ? "Email" : "Texting"} isn't turned on yet. Use “Copy link” and send it yourself.</div>
            </div>
          )}
          {channel !== "link" && (
            <Field label={channel === "email" ? "To" : "Mobile number"}>
              <input className="input" type={channel === "email" ? "email" : "tel"} value={to} onChange={(e) => setTo(e.target.value)} required placeholder={channel === "email" ? "client@example.com" : "(555) 555-0123"} />
            </Field>
          )}
          {channel === "email" && <Field label="Subject"><input className="input" value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200} required /></Field>}
          {channel !== "link" && (
            <Field label="Message" optional={mode === "exact"} hint="The link is added at the end.">
              <textarea
                className={`textarea ${styles.message}`}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                maxLength={channel === "sms" ? 400 : 4000}
                placeholder={mode === "exact" ? "Thanks for having us out. Here's the exact price for your new roof…" : undefined}
              />
            </Field>
          )}
          {channel === "link" && (
            <p className="muted" style={{ margin: 0 }}>
              Copies a link to paste into any message{mode === "range" ? `. ${capital(who)} sees the range on it` : ""}, and marks the estimate as sent.
            </p>
          )}
          <FormError error={send.error} />
          <div className="form-actions">
            <Button onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="primary" icon={channel === "link" ? "copy" : "send"} loading={send.isPending} disabled={unavailable}>
              {channel === "link" ? "Copy link" : channel === "email" ? "Send email" : "Send text"}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
