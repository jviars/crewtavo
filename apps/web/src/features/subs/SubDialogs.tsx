/** Adding and editing a sub, filing their paperwork, and sending them the link to send it in themselves. */
import { neededPaperwork, PAPERWORK_REQUIREMENTS, paperworkLinkIntro, paperworkLinkMessages, SUB_DOCUMENT_KINDS, subDocumentLabel, subSettings, TAX_CLASSIFICATIONS } from "@crewtavo/core/subs";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Field, FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { api, supabase, unwrap } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { useSession } from "@/lib/session";
import { fileSize } from "../plans/plans";
import { asksForEndDate, documentTitle, isInsurance, needsEndDate, type PaperworkRow } from "./paperwork";
import { SUB_PHONE_HINT, signInPhoneNote } from "./signInCountries";
import { addSubDocument, blankToNull, refreshSubs, type Sub, type SubDocument } from "./subsData";

// ---------------------------------------------------------------------------------------------
// The sub
// ---------------------------------------------------------------------------------------------

export function SubDialog({ sub, onClose, onSaved }: { sub: Sub | null; onClose: () => void; onSaved: (id: string) => void }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const a = sub?.address ?? {};
  const [f, setF] = useState({
    name: sub?.name ?? "",
    contact_name: sub?.contact_name ?? "",
    phone: sub?.phone ?? "",
    email: sub?.email ?? "",
    trade: sub?.trade ?? "",
    line1: a.line1 ?? "",
    line2: a.line2 ?? "",
    city: a.city ?? "",
    region: a.region ?? "",
    postal_code: a.postal_code ?? "",
    tax_classification: sub?.tax_classification ?? "",
    notes: sub?.notes ?? "",
    active: sub?.active ?? true,
  });
  const set = (key: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [key]: e.target.value });
  const emailOk = !f.email.trim() || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.email.trim());
  // How the number reads for sign-in codes by text, once it's typed: where codes go, or why none can.
  const phoneNote = signInPhoneNote(f.phone, subSettings(session.company.settings).sign_in_countries, session.config.features.sms);

  const save = useMutation({
    meta: { inline: true, success: sub ? "Sub saved" : "Sub added" },
    mutationFn: async () => {
      // Only the parts filled in, so an empty address stays {}.
      const address = Object.fromEntries(
        Object.entries({ line1: f.line1, line2: f.line2, city: f.city, region: f.region, postal_code: f.postal_code }).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v),
      );
      const row = {
        name: f.name.trim(),
        contact_name: blankToNull(f.contact_name),
        phone: blankToNull(f.phone),
        email: blankToNull(f.email),
        trade: blankToNull(f.trade),
        address,
        tax_classification: f.tax_classification || null,
        notes: blankToNull(f.notes),
        active: f.active,
      };
      if (sub) {
        unwrap(await supabase().from("subcontractors").update(row).eq("id", sub.id));
        return sub.id;
      }
      return unwrap(await supabase().from("subcontractors").insert({ ...row, company_id: session.company.id }).select("id").single()).id;
    },
    onSuccess: (id) => {
      refreshSubs(queryClient);
      onClose();
      onSaved(id);
    },
  });

  return (
    <Dialog open onClose={onClose} title={sub ? "Edit sub" : "Add a sub"} description={sub ? undefined : "A business you hire for jobs. You can send them a link to upload their W-9 and insurance next."} size="lg">
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); if (emailOk) save.mutate(); }}>
        <div className="form-grid">
          <Field label="Business name" hint="As it's written on their W-9."><input className="input" value={f.name} onChange={set("name")} required maxLength={120} placeholder="Apex Roofing LLC" autoFocus /></Field>
          <Field label="Trade" optional><input className="input" value={f.trade} onChange={set("trade")} maxLength={80} placeholder="Roofing, gutters, concrete" /></Field>
          <Field label="Contact name" optional><input className="input" value={f.contact_name} onChange={set("contact_name")} maxLength={120} autoComplete="off" /></Field>
          <Field label="Mobile phone" optional hint={phoneNote?.text ?? SUB_PHONE_HINT}><input className="input" type="tel" value={f.phone} onChange={set("phone")} maxLength={30} autoComplete="off" /></Field>
          <Field label="Email" optional error={emailOk ? null : "Enter an email like name@example.com"}><input className="input" type="email" value={f.email} onChange={set("email")} maxLength={254} autoComplete="off" /></Field>
          <Field label="Tax classification" optional hint="Box 3 on their W-9.">
            <select className="select" value={f.tax_classification} onChange={set("tax_classification")}>
              <option value="">Not set</option>
              {TAX_CLASSIFICATIONS.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
            </select>
          </Field>
        </div>
        <details className="more-options" open={Boolean(sub && (a.line1 || a.city || sub.notes)) || undefined}>
          <summary>Mailing address and notes</summary>
          <Field label="Street" optional><input className="input" value={f.line1} onChange={set("line1")} maxLength={200} /></Field>
          <Field label="Suite or unit" optional><input className="input" value={f.line2} onChange={set("line2")} maxLength={200} /></Field>
          <div className="form-grid-3">
            <Field label="City" optional><input className="input" value={f.city} onChange={set("city")} maxLength={100} /></Field>
            <Field label="State" optional><input className="input" value={f.region} onChange={set("region")} maxLength={20} /></Field>
            <Field label="ZIP" optional><input className="input" value={f.postal_code} onChange={set("postal_code")} maxLength={12} /></Field>
          </div>
          <Field label="Notes" optional hint="Only the office sees these."><textarea className="textarea" value={f.notes} onChange={set("notes")} maxLength={4000} rows={3} /></Field>
        </details>
        {sub && (
          <label className="switch-row" style={{ fontWeight: 500 }}>
            <input type="checkbox" className="switch" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} />
            Active. Turned off, they leave the list and stop getting reminders. Their paperwork stays.
          </label>
        )}
        <FormError error={save.error} />
        <div className="form-actions">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending}>{sub ? "Save" : "Add sub"}</Button>
        </div>
      </form>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------------------------
// Paperwork
// ---------------------------------------------------------------------------------------------

/** The required paperwork a kind counts toward (a workers' comp certificate or exemption both count as workers' comp). */
const requirementOf = (kind: string) => PAPERWORK_REQUIREMENTS.find((r) => (r.kinds as readonly string[]).includes(kind))?.key ?? null;

/** "Liability insurance" as part of a sentence: "Replace liability insurance". The W-9 keeps its capitals. */
const inSentence = (label: string) => (/^[A-Z][a-z]/.test(label) ? label.charAt(0).toLowerCase() + label.slice(1) : label);

/**
 * Filing a document (`kinds` limits what it can be: a W-9, liability, or workers' comp as a
 * certificate or an exemption), or changing the dates and policy details of one on file (`doc`).
 */
export function DocumentDialog({
  sub,
  kinds,
  doc,
  replacing,
  onClose,
}: {
  sub: Pick<Sub, "id" | "name">;
  kinds?: readonly string[];
  doc?: SubDocument;
  /** The document a new one takes the place of, to say so. */
  replacing?: SubDocument | null;
  onClose: () => void;
}) {
  const session = useSession();
  const queryClient = useQueryClient();
  const choices = kinds?.length ? kinds : SUB_DOCUMENT_KINDS.map((k) => k.key);
  const [f, setF] = useState({
    kind: doc?.kind ?? (replacing && choices.includes(replacing.kind) ? replacing.kind : choices[0]!),
    title: doc?.title ?? "",
    carrier: doc?.carrier ?? (replacing && isInsurance(replacing.kind) ? replacing.carrier : null) ?? "",
    policy_number: doc?.policy_number ?? "",
    starts_on: doc?.starts_on ?? "",
    expires_on: doc?.expires_on ?? "",
  });
  const [file, setFile] = useState<File | null>(null);
  const set = (key: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [key]: e.target.value });
  const endDate = asksForEndDate(f.kind);
  const datesOk = !f.starts_on || !f.expires_on || f.expires_on >= f.starts_on;

  const save = useMutation({
    meta: { inline: true, success: doc ? "Saved" : replacing ? "Replaced" : "Added" },
    mutationFn: async () => {
      const row = {
        title: f.kind === "license" || f.kind === "other" ? blankToNull(f.title) : null,
        carrier: isInsurance(f.kind) ? blankToNull(f.carrier) : null,
        policy_number: isInsurance(f.kind) ? blankToNull(f.policy_number) : null,
        starts_on: f.starts_on || null,
        expires_on: endDate ? f.expires_on || null : null,
      };
      if (doc) {
        unwrap(await supabase().from("sub_documents").update(row).eq("id", doc.id));
        return;
      }
      if (!file) throw new Error("Choose the file first.");
      await addSubDocument(session.company.id, sub.id, file, { kind: f.kind, ...row });
    },
    onSuccess: () => {
      refreshSubs(queryClient);
      onClose();
    },
  });

  const title = doc ? `Edit ${inSentence(documentTitle(doc))}` : replacing ? `Replace ${inSentence(subDocumentLabel(replacing.kind))}` : choices.length === 1 ? `Add ${inSentence(subDocumentLabel(choices[0]!))}` : "Add a document";

  return (
    <Dialog open onClose={onClose} title={title} description={doc ? undefined : `For ${sub.name}.`}>
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); if (datesOk) save.mutate(); }}>
        {!doc && choices.length > 1 && (
          <Field label="What is it">
            <select className="select" value={f.kind} onChange={set("kind")}>
              {choices.map((k) => <option key={k} value={k}>{subDocumentLabel(k)}</option>)}
            </select>
          </Field>
        )}
        {!doc && (
          <div className="field">
            <span className="field-label">File</span>
            {file ? (
              <div className="row" style={{ gap: 8 }}>
                <Icon name={file.type.startsWith("image/") ? "image" : "file"} size={16} />
                <span className="grow" style={{ overflowWrap: "anywhere" }}>{file.name} <span className="muted small">{fileSize(file.size)}</span></span>
                <button type="button" className="btn btn-sm btn-ghost btn-icon" aria-label={`Remove ${file.name}`} onClick={() => setFile(null)}><Icon name="x" size={14} /></button>
              </div>
            ) : (
              <label className="dropzone" style={{ padding: 16 }}>
                <Icon name="upload" size={20} />
                <span className="strong">Choose a PDF or a photo</span>
                <input type="file" className="sr-only" accept="application/pdf,image/*" onChange={(e) => { setFile(e.target.files?.[0] ?? null); e.target.value = ""; }} />
              </label>
            )}
            {replacing && requirementOf(replacing.kind) && requirementOf(replacing.kind) === requirementOf(f.kind) && <span className="hint">The one on file now moves to the history.</span>}
          </div>
        )}
        {(f.kind === "license" || f.kind === "other") && (
          <Field label="Name" optional><input className="input" value={f.title} onChange={set("title")} maxLength={200} placeholder={f.kind === "license" ? "Contractor license" : "Signed agreement"} /></Field>
        )}
        {isInsurance(f.kind) && (
          <div className="form-grid">
            <Field label="Insurance company" optional><input className="input" value={f.carrier} onChange={set("carrier")} maxLength={120} /></Field>
            <Field label="Policy number" optional><input className="input" value={f.policy_number} onChange={set("policy_number")} maxLength={80} /></Field>
          </div>
        )}
        <div className="form-grid">
          {f.kind !== "w9" && <Field label="Starts" optional><input className="input" type="date" value={f.starts_on} onChange={set("starts_on")} /></Field>}
          {endDate && (
            <Field label="Ends" optional={!needsEndDate(f.kind)} hint={needsEndDate(f.kind) ? "The policy's expiration date. We remind you 30 and 7 days before." : undefined} error={datesOk ? null : "This has to be after it starts"}>
              <input className="input" type="date" value={f.expires_on} onChange={set("expires_on")} required={needsEndDate(f.kind)} min={f.starts_on || undefined} />
            </Field>
          )}
          {f.kind === "w9" && <Field label="Signed on" optional><input className="input" type="date" value={f.starts_on} onChange={set("starts_on")} /></Field>}
        </div>
        <FormError error={save.error} />
        <div className="form-actions">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" icon={doc ? undefined : "upload"} loading={save.isPending} disabled={!doc && !file}>{doc ? "Save" : replacing ? "Replace" : "Add"}</Button>
        </div>
      </form>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------------------------
// The sub's link
// ---------------------------------------------------------------------------------------------

interface LinkSent {
  link: string;
  expires_at: string;
  email?: { sent: boolean; reason: string | null } | null;
  sms?: { sent: boolean; reason: string | null } | null;
}

/** Text or email the sub their link to send in paperwork, or copy it to send another way. */
export function SendLinkDialog({ sub, paperwork, onClose }: { sub: Sub; paperwork: readonly PaperworkRow[]; onClose: () => void }) {
  const { company, config } = useSession();
  const { needed } = neededPaperwork(paperwork);
  const intro = paperworkLinkIntro(needed);
  const canText = config.features.sms && Boolean(sub.phone);
  const canEmail = config.features.email && Boolean(sub.email);
  const [channels, setChannels] = useState({ sms: canText, email: canEmail });
  const [message, setMessage] = useState(intro);
  const chosen = (["sms", "email"] as const).filter((c) => channels[c]);

  const send = useMutation({
    meta: { inline: true },
    mutationFn: () => api.post<LinkSent>(`/subs/${sub.id}/send-upload-link`, { channels: chosen, message: message.trim() && message.trim() !== intro ? message.trim() : null }),
  });
  const copy = useMutation({
    meta: { inline: true },
    mutationFn: () => api.post<LinkSent>(`/subs/${sub.id}/upload-link`, {}),
    // The link shows next either way, with its own Copy button, so a blocked clipboard isn't an error here.
    onSuccess: (r) => {
      void copyText(r.link, "Link copied. Paste it into a text or email to them.").catch(() => undefined);
    },
  });
  const done = send.data ?? copy.data;

  if (done) {
    const outcomes = [
      done.sms && { label: done.sms.sent ? `Texted to ${sub.phone}` : null, reason: done.sms.reason },
      done.email && { label: done.email.sent ? `Emailed to ${sub.email}` : null, reason: done.email.reason },
    ].filter((o): o is { label: string | null; reason: string | null } => Boolean(o));
    const sent = outcomes.filter((o) => o.label);
    return (
      <Dialog open onClose={onClose} title={sent.length ? "Sent" : "Link ready"}>
        <div className="dialog-body">
          {sent.length > 0 && (
            <div className="stack-sm" style={{ justifyItems: "center", textAlign: "center", padding: "8px 0" }}>
              <span className="success-mark"><Icon name="check" size={30} strokeWidth={3} /></span>
              {sent.map((o) => <strong key={o.label}>{o.label}</strong>)}
              {config.features.devMail && done.email?.sent && <span className="muted small">Development mode: it's in the local Mailpit inbox.</span>}
            </div>
          )}
          {outcomes.filter((o) => !o.label && o.reason).map((o) => (
            <div key={o.reason} className="callout callout-warning"><Icon name="alert" size={18} /><div className="grow" style={{ fontWeight: 400 }}>{o.reason}</div></div>
          ))}
          <div className="field">
            <span>Their link</span>
            <div className="row">
              <input className="input" readOnly value={done.link} onFocus={(e) => e.target.select()} aria-label="Their link" />
              <Button icon="copy" onClick={() => copyText(done.link, "Link copied")}>Copy</Button>
            </div>
            <span className="hint">It works for 30 days. Anyone with it can send paperwork for {sub.name}, but can't see anything.</span>
          </div>
          <div className="form-actions">
            <a className="btn" href={done.link} target="_blank" rel="noreferrer"><Icon name="external" size={16} />Preview</a>
            <Button variant="primary" onClick={onClose}>Done</Button>
          </div>
        </div>
      </Dialog>
    );
  }

  // Exactly what goes out (services/subs.ts builds the same), for each way it's sent.
  const out = paperworkLinkMessages({ companyName: company.name, subName: sub.name, contactName: sub.contact_name, intro: message.trim() || intro, link: "[their link]" });
  const previews = [
    channels.sms && canText && { key: "sms", label: "By text", body: out.sms },
    channels.email && canEmail && { key: "email", label: `By email · ${out.subject}`, body: out.text },
  ].filter((p): p is { key: string; label: string; body: string } => Boolean(p));
  return (
    <Dialog open onClose={onClose} title="Send upload link" description={`${sub.name} opens it on their phone or computer and sends in their paperwork. No account needed.`}>
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); if (chosen.length) send.mutate(); }}>
        <fieldset className="stack-sm" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="strong small" style={{ marginBottom: 6 }}>Send it by</legend>
          <label className="checkbox">
            <input type="checkbox" checked={channels.sms} disabled={!canText} onChange={(e) => setChannels({ ...channels, sms: e.target.checked })} />
            <span>Text{sub.phone ? ` to ${sub.phone}` : ""}{!sub.phone ? <span className="muted"> · Add their phone number first</span> : !config.features.sms ? <span className="muted"> · Texting isn't set up. Copy the link instead.</span> : null}</span>
          </label>
          <label className="checkbox">
            <input type="checkbox" checked={channels.email} disabled={!canEmail} onChange={(e) => setChannels({ ...channels, email: e.target.checked })} />
            <span>Email{sub.email ? ` to ${sub.email}` : ""}{!sub.email ? <span className="muted"> · Add their email first</span> : !config.features.email ? <span className="muted"> · Email isn't connected yet. Copy the link instead.</span> : null}</span>
          </label>
        </fieldset>
        <Field label="Message" hint={chosen.length === 1 && chosen[0] === "sms" ? "We add your company's name and their link." : "We add a greeting, their link and your company's name."}>
          <textarea className="textarea" value={message} onChange={(e) => setMessage(e.target.value)} maxLength={1000} rows={3} />
        </Field>
        {previews.length > 0 && (
          <div className="stack-sm">
            <span className="strong small">What they'll get</span>
            {previews.map((p) => (
              <div key={p.key} className="stack-sm" style={{ gap: 4 }}>
                <span className="muted small">{p.label}</span>
                <div className="small pre-wrap" style={{ padding: 12, borderRadius: 8, background: "var(--fill)", border: "1px solid var(--border)", overflowWrap: "anywhere" }}>{p.body}</div>
              </div>
            ))}
          </div>
        )}
        <FormError error={send.error ?? copy.error} />
        <div className="form-actions">
          <Button icon="copy" loading={copy.isPending} onClick={() => copy.mutate()}>Copy link</Button>
          <span className="spacer" />
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" icon="send" loading={send.isPending} disabled={!chosen.length}>{chosen.length === 2 ? "Send text and email" : chosen[0] === "email" ? "Send email" : chosen[0] === "sms" ? "Send text" : "Send"}</Button>
        </div>
      </form>
    </Dialog>
  );
}
