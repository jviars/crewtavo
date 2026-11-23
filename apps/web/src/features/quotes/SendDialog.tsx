/**
 * Email, text or copy a client link for a quote or invoice. It can go to several people at once:
 * the client and their contacts are listed to tick (the client's own address starts ticked, and so
 * do contacts ticked for reminders once the company sends to contacts), and another address can
 * still be typed in.
 */
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Field, FormChecks, FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { api } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { useSession } from "@/lib/session";
import { formatPhoneTyping } from "@/lib/validate";
import { listWords, ownChoices, sendList, sendListProblem, sendPayload, type SendChannel, type SendChoices } from "./sendRecipients";
import { translateError } from "@crewtavo/core/i18n/patterns";
import { getLocale, t } from "@/lib/i18n";

type Channel = SendChannel | "link";

interface Sent {
  link: string;
  sent: boolean;
  reason?: string;
  /** Who it went to, and anyone it didn't reach (a server from before it sent to several says neither). */
  sent_to?: string[];
  not_sent?: Array<{ to: string; reason: string }>;
}

export function SendDialog({
  kind,
  id,
  number,
  email,
  phone,
  textsOffSince,
  onClose,
  onSent,
}: {
  kind: "quote" | "invoice";
  id: string;
  number?: number | null;
  email: string | null;
  phone: string | null;
  /** When the client's texts went off: Crewtavo doesn't text their number, though another one can be texted. */
  textsOffSince?: string | null;
  onClose: () => void;
  onSent?: () => void;
}) {
  const { company, config } = useSession();
  const [channel, setChannel] = useState<Channel>(email ? "email" : phone && !textsOffSince ? "sms" : "link");
  const label = (kind === "quote" ? t("Quote #{number}", { number: number ?? "" }) : t("Invoice #{number}", { number: number ?? "" })).trim();
  // i18n-ignore: the email's subject, which the client reads (clients are written to in English for now)
  const [subject, setSubject] = useState(`${label} from ${company.name}`);
  const [message, setMessage] = useState("");
  // The client and their contacts, from the server. Until it answers (or if it can't: offline, or
  // a server from before this), the client's own email and phone, as the dialog always offered.
  const choices = useQuery({
    queryKey: ["send-choices", kind, id],
    queryFn: () => api.get<SendChoices>(`/${kind}s/${id}/recipients`),
    retry: false,
    staleTime: 0,
    meta: { silent: true },
  });
  const offered = choices.data ?? ownChoices({ email, phone, textsOffSince });
  // Who's ticked by email and by text, once the person has changed it; before that, who starts ticked.
  const [picked, setPicked] = useState<Partial<Record<SendChannel, string[]>>>({});
  const [typed, setTyped] = useState<Record<SendChannel, string>>({ email: "", sms: "" });
  const people = channel === "link" ? [] : offered[channel];
  const ticked = channel === "link" ? [] : (picked[channel] ?? people.filter((p) => p.ticked).map((p) => p.to));
  const list = channel === "link" ? [] : sendList(channel, ticked, typed[channel]);
  const problem = channel === "link" ? null : sendListProblem(channel, list, offered.max);
  const [tried, setTried] = useState(false);
  const toggle = (to: string, on: boolean) => {
    if (channel === "link") return;
    setPicked({ ...picked, [channel]: on ? [...ticked, to] : ticked.filter((t) => t !== to) });
  };

  const send = useMutation({
    meta: { inline: true },
    mutationFn: () => api.post<Sent>(`/${kind}s/${id}/send`, sendPayload({ channel, list, subject, message })),
    onSuccess: (r) => {
      onSent?.();
      if (channel === "link") copyText(r.link, t("Link copied. Paste it into a message to your client."));
    },
  });

  const unavailable = (channel === "email" && !config.features.email) || (channel === "sms" && !config.features.sms);
  const done = send.data;
  // A server from before it sent to several sent to the first one only, and doesn't say who.
  const reached = done?.sent_to ?? list.slice(0, 1);
  // Contacts who aren't ticked to start with only because the company hasn't turned that on.
  const contactsHeld = !offered.contacts_on && people.some((p) => p.contact_id);

  return (
    <Dialog open onClose={onClose} title={done ? (done.sent ? t("Sent") : t("Link ready")) : kind === "quote" ? t("Send quote") : t("Send invoice")} description={done ? undefined : kind === "quote" ? t("{label} for your client to review and approve online.", { label }) : t("{label} for your client to view and pay online.", { label })}>
      {done ? (
        <div className="dialog-body">
          {done.sent ? (
            <div className="stack-sm" style={{ justifyItems: "center", textAlign: "center", padding: "8px 0" }}>
              <span className="success-mark"><Icon name="check" size={30} bold /></span>
              <strong style={{ fontSize: 16 }}>{channel === "email" ? t("Emailed to {who}", { who: listWords(reached) }) : t("Texted to {who}", { who: listWords(reached) })}</strong>
              {config.features.devMail && <span className="muted small">{t("Development mode: it's in the local Mailpit inbox.")}</span>}
            </div>
          ) : (
            done.reason && done.reason !== "Link only" && <div className="callout callout-warning"><Icon name="alert" size={16} /><div className="grow">{translateError(getLocale(), done.reason)} {t("Copy the link and send it yourself.")}</div></div>
          )}
          {done.not_sent?.map((missed) => (
            <div key={missed.to} className="callout callout-warning"><Icon name="alert" size={16} /><div className="grow">{t("It didn't reach {who}.", { who: missed.to })} <span style={{ fontWeight: 400 }}>{translateError(getLocale(), missed.reason)}</span></div></div>
          ))}
          <div className="field">
            <span>{t("Client link")}</span>
            <div className="row">
              <input className="input" readOnly value={done.link} onFocus={(e) => e.target.select()} />
              <Button icon="copy" onClick={() => copyText(done.link, t("Link copied"))}>{t("Copy")}</Button>
            </div>
          </div>
          <div className="form-actions">
            <a className="btn" href={done.link} target="_blank" rel="noreferrer"><Icon name="external" size={16} />{t("Preview")}</a>
            <Button variant="primary" onClick={onClose}>{t("Done")}</Button>
          </div>
        </div>
      ) : (
        <form
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            setTried(true);
            if (!problem) send.mutate();
          }}
        >
          <div className="segmented" role="group" aria-label={t("How to send")}>
            <button type="button" aria-pressed={channel === "email"} onClick={() => setChannel("email")}>Email</button>
            <button type="button" aria-pressed={channel === "sms"} onClick={() => setChannel("sms")}>{t("Text")}</button>
            <button type="button" aria-pressed={channel === "link"} onClick={() => setChannel("link")}>{t("Copy link")}</button>
          </div>
          {textsOffSince && <p className="muted small" style={{ margin: 0 }}>{t("Their texts are off, so their own number can't be texted. You can text a different one.")}</p>}
          {unavailable && (
            <div className="callout callout-info">
              <Icon name="info" size={16} />
              <div className="grow">{channel === "email" ? t("Email isn't turned on yet. Use “Copy link” and send it yourself.") : t("Texting isn't turned on yet. Use “Copy link” and send it yourself.")}</div>
            </div>
          )}
          {channel !== "link" && people.length > 0 && (
            <fieldset className="stack-sm" style={{ border: 0, padding: 0, margin: 0, gap: 6 }}>
              <legend className="strong small" style={{ padding: 0, marginBottom: 4 }}>{t("Send to")}</legend>
              {people.map((p) => (
                <label key={p.to} className="checkbox" style={{ alignItems: "flex-start" }}>
                  <input type="checkbox" checked={!p.blocked && ticked.includes(p.to)} disabled={Boolean(p.blocked)} onChange={(e) => toggle(p.to, e.target.checked)} />
                  <span style={{ minWidth: 0 }}>
                    {p.name}
                    <span className="muted small" style={{ display: "block", overflowWrap: "anywhere" }}>
                      {p.to}{p.contact_id ? t(" · Contact") : ""}{p.blocked ? ` · ${t("{reason}, so they can't be texted", { reason: translateError(getLocale(), p.blocked) })}` : ""}
                    </span>
                  </span>
                </label>
              ))}
              {contactsHeld && <span className="muted small">{t("Contacts aren't ticked to start with. Tick anyone this should go to.")}</span>}
            </fieldset>
          )}
          {channel !== "link" && (
            <Field
              label={people.length ? (channel === "email" ? t("Another address") : t("Another number")) : channel === "email" ? t("To") : t("Mobile number")}
              optional={people.length > 0}
              hint={channel === "email" && people.length > 0 ? t("For more than one, put a comma between them.") : undefined}
              requiredMessage={channel === "email" ? t("Add the email to send it to.") : t("Add the number to text it to.")}
            >
              <input
                className="input"
                type={channel === "email" ? "email" : "tel"}
                multiple={channel === "email"}
                value={typed[channel]}
                onChange={(e) => setTyped({ ...typed, [channel]: channel === "sms" ? formatPhoneTyping(e.target.value) : e.target.value })}
                required={people.length === 0}
                placeholder={channel === "email" ? "client@example.com" : "(555) 555-0123"}
              />
            </Field>
          )}
          {channel !== "link" && tried && problem && <span className="field-error" role="alert">{problem}</span>}
          {channel === "email" && <Field label={t("Subject")}><input className="input" value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200} required /></Field>}
          {channel !== "link" && (
            <Field label={t("Message")} optional hint={t("The link is added automatically.")}>
              <textarea className="textarea" value={message} onChange={(e) => setMessage(e.target.value)} maxLength={channel === "sms" ? 400 : 4000} placeholder={kind === "quote" ? t("Thanks for having us out. Here's what we recommend…") : t("Thanks for your business.")} />
            </Field>
          )}
          {channel === "link" && <p className="muted" style={{ margin: 0 }}>{kind === "quote" ? t("Copies a link you can paste into any message, and marks the quote as sent.") : t("Copies a link you can paste into any message, and marks the invoice as sent.")}</p>}
          <FormError error={send.error} />
          <div className="form-actions">
            <FormChecks />
            <Button onClick={onClose}>{t("Cancel")}</Button>
            <Button type="submit" variant="primary" icon={channel === "link" ? "copy" : "send"} loading={send.isPending} disabled={unavailable}>
              {channel === "link" ? t("Copy link") : channel === "email" ? (list.length > 1 ? t("Send {count} emails", { count: list.length }) : t("Send email")) : list.length > 1 ? t("Send {count} texts", { count: list.length }) : t("Send text")}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
