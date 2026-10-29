/**
 * A sub's link to send in their paperwork (/paperwork/:token), from the office's "Send upload link"
 * or a reminder. No account: they see the company's name and logo, what's needed from them, and
 * send each document from their phone's camera or files. Each file goes straight to Storage on a
 * one-time link (the booking form's way), then is recorded for the office to check (routes/subs.ts).
 */
import { askingFor } from "@crewtavo/core/subs";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { Field, FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { Skeleton } from "@/components/ui/Skeleton";
import { publicFetch } from "@/lib/publicApi";
import { fileSize, isAbort, uploadToLink } from "../plans/plans";
import { asksForEndDate, endDateProblem, greeting, kindsFor, needsEndDate, neededWhy, UPLOAD_ACCEPT, uploadProblem, withType } from "../subs/paperwork";

interface PaperworkView {
  company: { name: string; logo: string | null };
  sub: { name: string };
  needed: Array<{ requirement: string; label: string; state: "missing" | "expiring" | "expired"; expires_on: string | null }>;
  waiting: string[];
  kinds: Array<{ key: string; label: string; expires: boolean }>;
  max_bytes: number;
}

/** One thing to send: a required document, or something else the sub adds. */
export interface Item {
  key: string;
  label: string;
  /** What it can be sent as (workers' comp: a certificate or an exemption). */
  kinds: string[];
  kind: string;
  why: string | null;
  file: File | null;
  expires_on: string;
}

const REQUIREMENT_LABELS: Record<string, string> = { w9: "W-9", liability: "Liability insurance", workers_comp: "Workers' comp" };
const localToday = () => new Date().toLocaleDateString("en-CA");

export function PaperworkPage() {
  const { token = "" } = useParams();
  const path = `/public/paperwork/${encodeURIComponent(token)}`;
  const view = useQuery({ queryKey: ["paperwork", token], retry: false, queryFn: () => publicFetch<PaperworkView>(path) });
  const [items, setItems] = useState<Item[] | null>(null);
  const [touched, setTouched] = useState(false);
  const [sending, setSending] = useState<{ label: string; progress: number } | null>(null);
  const [failed, setFailed] = useState<Record<string, string>>({});
  const [sent, setSent] = useState<string[]>([]);
  const data = view.data;

  useEffect(() => {
    if (data) document.title = `Paperwork for ${data.company.name}`;
    if (data && !items) setItems(data.needed.map((n) => ({ key: n.requirement, label: n.label, kinds: kindsFor(n.requirement), kind: kindsFor(n.requirement)[0]!, why: neededWhy(n), file: null, expires_on: "" })));
  }, [data, items]);

  const kindLabel = (kind: string) => data?.kinds.find((k) => k.key === kind)?.label ?? kind;
  const list = items ?? [];
  const picked = list.filter((i) => i.file);
  const today = localToday();
  const fileProblem = (i: Item) => (i.file ? uploadProblem(i.file, data?.max_bytes ?? 0) : null);
  const dateProblem = (i: Item) => (i.file ? endDateProblem(i.kind, i.expires_on, today) : null);
  const problemOf = (i: Item) => fileProblem(i) ?? dateProblem(i);
  const update = (key: string, patch: Partial<Item>) => {
    setItems((all) => (all ?? []).map((i) => (i.key === key ? { ...i, ...patch } : i)));
    setFailed((all) => Object.fromEntries(Object.entries(all).filter(([k]) => k !== key)));
  };

  // Something else to send: a required document that isn't asked for (to send a newer one early), a license, anything.
  const extras = [
    ...Object.keys(REQUIREMENT_LABELS).map((key) => ({ key, label: REQUIREMENT_LABELS[key]!, kinds: kindsFor(key) })),
    { key: "license", label: kindLabel("license"), kinds: ["license"] },
    { key: "other", label: "Other document", kinds: ["other"] },
  ].filter((e) => !list.some((i) => i.key === e.key));

  const submit = useMutation({
    mutationFn: async () => {
      const done: string[] = [];
      const problems: Record<string, string> = {};
      for (const item of picked) {
        const file = withType(item.file!);
        setSending({ label: item.label, progress: 0 });
        try {
          const link = await publicFetch<{ path: string; token: string; files_token: string }>(`${path}/uploads`, { kind: item.kind, file: { name: file.name, size: file.size, type: file.type || undefined } });
          await uploadToLink(link, file, (progress) => setSending({ label: item.label, progress })).promise;
          const recorded = await publicFetch<{ added: number }>(`${path}/files`, { files_token: link.files_token, expires_on: asksForEndDate(item.kind) && item.expires_on ? item.expires_on : null });
          if (recorded.added) done.push(item.key);
          else problems[item.key] = "That file didn't come through. Try sending it again.";
        } catch (error) {
          if (!isAbort(error)) problems[item.key] = error instanceof Error ? error.message : "That file didn't come through. Try sending it again.";
        }
      }
      return { done, problems };
    },
    onSettled: () => setSending(null),
    onSuccess: ({ done, problems }) => {
      setFailed(problems);
      setSent((s) => [...s, ...list.filter((i) => done.includes(i.key)).map((i) => i.label)]);
      setItems((all) => (all ?? []).filter((i) => !done.includes(i.key)));
      setTouched(false);
      window.scrollTo({ top: 0, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    },
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (!picked.length || picked.some(problemOf)) return;
    submit.mutate();
  };

  const allSent = sent.length > 0 && list.length === 0;

  return (
    <div className="public-page" style={{ paddingTop: 20 }}>
      <div className="public-wrap" style={{ maxWidth: 560 }}>
        {view.isPending && <div className="card card-pad stack-sm"><Skeleton width="45%" height={14} /><Skeleton width="80%" height={26} /><Skeleton height={220} radius={8} /></div>}
        {view.error && (
          <div className="card">
            <div className="empty-state error-state">
              <span className="empty-icon"><Icon name="link" size={24} /></span>
              <h3>This link isn't working</h3>
              <p>{(view.error as Error).message}</p>
            </div>
          </div>
        )}
        {data && (
          <>
            <header className="public-brand">
              {data.company.logo ? <img className="logo" src={data.company.logo} alt="" /> : <span className="tile" aria-hidden="true">{data.company.name.slice(0, 2).toUpperCase()}</span>}
              <strong>{data.company.name}</strong>
            </header>

            {sent.length > 0 && (
              <div className="card card-pad stack-sm" style={{ textAlign: "center", justifyItems: "center", padding: 28 }} role="status">
                <span className="success-mark"><Icon name="check" size={30} strokeWidth={3} /></span>
                <h1 style={{ fontSize: 24, fontWeight: 800, letterSpacing: "var(--tracking-display)" }}>Thanks, it's in</h1>
                <p style={{ margin: 0 }}>{data.company.name} got {askingFor(sent.map((label) => ({ label })))}. They'll check {sent.length === 1 ? "it" : "them"} and get in touch if anything's missing.</p>
                {allSent && <Button variant="ghost" onClick={() => setSent([])}>Send something else</Button>}
              </div>
            )}

            {!allSent && (
              <form className="card card-pad stack" noValidate onSubmit={onSubmit}>
                {sent.length === 0 && (
                  <h1 style={{ fontSize: 24, fontWeight: 800, letterSpacing: "var(--tracking-display)", margin: 0 }}>
                    {list.length ? greeting(data.sub.name, data.company.name) : `Hi ${data.sub.name}, you're all set`}
                  </h1>
                )}
                {list.length === 0 && sent.length === 0 && (
                  <p className="muted" style={{ margin: 0 }}>{data.company.name} has everything they need from you right now. If your insurance changed, you can still send the new one below.</p>
                )}
                {data.waiting.length > 0 && sent.length === 0 && (
                  <div className="callout callout-info">
                    <Icon name="info" size={18} />
                    <div className="grow" style={{ fontWeight: 400 }}>Already sent, waiting for {data.company.name} to check: {data.waiting.map((w) => REQUIREMENT_LABELS[w] ?? w).join(", ")}.</div>
                  </div>
                )}

                {list.map((item) => (
                  <ItemCard
                    key={item.key}
                    item={item}
                    kindLabel={kindLabel}
                    maxBytes={data.max_bytes}
                    disabled={submit.isPending}
                    fileProblem={failed[item.key] ?? fileProblem(item)}
                    dateProblem={touched || item.expires_on ? dateProblem(item) : null}
                    onChange={(patch) => update(item.key, patch)}
                    onRemove={data.needed.some((n) => n.requirement === item.key) ? undefined : () => setItems((all) => (all ?? []).filter((i) => i.key !== item.key))}
                  />
                ))}

                {extras.length > 0 && (
                  <details className="more-options" open={list.length === 0 || undefined}>
                    <summary>Send something else</summary>
                    <div className="row wrap" style={{ gap: 8 }}>
                      {extras.map((e) => (
                        <button key={e.key} type="button" className="btn" onClick={() => setItems([...list, { key: e.key, label: e.label, kinds: e.kinds, kind: e.kinds[0]!, why: null, file: null, expires_on: "" }])}>
                          <Icon name="plus" size={14} />{e.label}
                        </button>
                      ))}
                    </div>
                  </details>
                )}

                {sending && (
                  <div className="stack-sm" role="status" aria-live="polite">
                    <div className="row-between small"><span className="strong">Sending your {sending.label === "W-9" ? "W-9" : sending.label.toLowerCase()}</span><span className="muted tabular">{Math.round(sending.progress * 100)}%</span></div>
                    <div className="progress"><span style={{ width: `${Math.round(sending.progress * 100)}%` }} /></div>
                    <span className="muted small">Keep this page open until it's done.</span>
                  </div>
                )}
                {touched && !picked.length && list.length > 0 && <div className="form-error" role="alert">Choose a file or take a photo to send.</div>}
                <FormError error={submit.error} />
                {list.length > 0 && (
                  <Button type="submit" variant="primary" size="lg" icon="send" loading={submit.isPending} block>
                    {picked.length > 1 ? `Send ${picked.length} documents` : "Send"}
                  </Button>
                )}
              </form>
            )}
            <p className="public-foot">Only {data.company.name} sees what you send.</p>
          </>
        )}
      </div>
    </div>
  );
}

/** One document to send: what it is, the file (camera or files), and the date it ends. Also on a signed-in sub's My paperwork. */
export function ItemCard({
  item,
  kindLabel,
  maxBytes,
  disabled,
  fileProblem,
  dateProblem,
  onChange,
  onRemove,
  today = localToday(),
}: {
  item: Item;
  kindLabel: (kind: string) => string;
  maxBytes: number;
  disabled: boolean;
  fileProblem: string | null;
  dateProblem: string | null;
  onChange: (patch: Partial<Item>) => void;
  onRemove?: () => void;
  /** The earliest end date offered: the phone's today here, the company's for a signed-in sub. */
  today?: string;
}) {
  const pick = (files: FileList | null) => {
    const file = files?.[0];
    if (file) onChange({ file });
  };
  return (
    <section className="stack-sm" style={{ padding: 14, borderRadius: "var(--radius-card)", border: `1px solid ${fileProblem || dateProblem ? "var(--danger)" : "var(--border)"}` }} aria-label={item.label}>
      <div className="row" style={{ gap: 8, alignItems: "flex-start" }}>
        <span className="grow">
          <strong style={{ fontSize: 16 }}>{item.label}</strong>
          {item.why && <span className="muted small" style={{ display: "block" }}>{item.why}</span>}
        </span>
        {onRemove && <button type="button" className="btn btn-sm btn-ghost btn-icon" aria-label={`Don't send ${item.label}`} disabled={disabled} onClick={onRemove}><Icon name="x" size={14} /></button>}
      </div>
      {item.kinds.length > 1 && (
        <div className="segmented" role="group" aria-label={`What you're sending for ${item.label}`}>
          {item.kinds.map((k) => (
            <button key={k} type="button" aria-pressed={item.kind === k} disabled={disabled} onClick={() => onChange({ kind: k })}>
              {k === "wc_exemption" ? "I'm exempt" : k === "workers_comp" ? "Certificate" : kindLabel(k)}
            </button>
          ))}
        </div>
      )}
      {item.file ? (
        <div className="row" style={{ gap: 8 }}>
          <Icon name={item.file.type.startsWith("image/") ? "image" : "file"} size={16} />
          <span className="grow" style={{ overflowWrap: "anywhere" }}>{item.file.name} <span className="muted small">{fileSize(item.file.size)}</span></span>
          <button type="button" className="btn btn-sm btn-ghost" disabled={disabled} onClick={() => onChange({ file: null })}>Change</button>
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 8 }}>
          <label className="btn" aria-disabled={disabled}>
            <Icon name="camera" size={16} />Take a photo
            <input type="file" className="sr-only" accept="image/*" capture="environment" disabled={disabled} onChange={(e) => { pick(e.target.files); e.target.value = ""; }} />
          </label>
          <label className="btn" aria-disabled={disabled}>
            <Icon name="upload" size={16} />Choose a file
            <input type="file" className="sr-only" accept={UPLOAD_ACCEPT} disabled={disabled} onChange={(e) => { pick(e.target.files); e.target.value = ""; }} />
          </label>
        </div>
      )}
      {fileProblem && <span className="field-error" role="alert">{fileProblem}</span>}
      {asksForEndDate(item.kind) && (
        <Field label="Ends on" optional={!needsEndDate(item.kind)} hint={dateProblem ? undefined : "The expiration date on it."} error={dateProblem}>
          <input className="input" type="date" value={item.expires_on} min={today} disabled={disabled} onChange={(e) => onChange({ expires_on: e.target.value })} />
        </Field>
      )}
      {!item.file && !fileProblem && <span className="muted small">A PDF or a clear photo, up to {fileSize(maxBytes)}.</span>}
    </section>
  );
}
