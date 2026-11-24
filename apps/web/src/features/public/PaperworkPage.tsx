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
import { Button, cx } from "@/components/ui/Button";
import { Field, FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { linkToken } from "@/lib/linkToken";
import { publicFetch } from "@/lib/publicApi";
import { Broken, ClientBody, ClientHeader, ClientPage, ClientSkeleton, Done, kit as k } from "./ClientKit";
import p from "./paperwork.module.css";
import { fileSize, isAbort, uploadToLink } from "../plans/plans";
import { asksForEndDate, endDateProblem, greeting, kindsFor, needsEndDate, neededWhy, UPLOAD_ACCEPT, uploadProblem, withType } from "../subs/paperwork";
import { getLocale, msg, t } from "@/lib/i18n";

interface PaperworkView {
  /** `color`: the business's brand color, when the server sends it (else the kit's navy). */
  company: { name: string; logo: string | null; color?: string | null };
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

const REQUIREMENT_LABELS: Record<string, string> = { w9: "W-9", liability: msg("Liability insurance"), workers_comp: msg("Workers' comp") };
const localToday = () => new Date().toLocaleDateString("en-CA");

export function PaperworkPage() {
  const { token: raw = "" } = useParams();
  const token = linkToken(raw);
  const path = `/public/paperwork/${encodeURIComponent(token)}`;
  const view = useQuery({ queryKey: ["paperwork", token], retry: false, queryFn: () => publicFetch<PaperworkView>(path) });
  const [items, setItems] = useState<Item[] | null>(null);
  const [touched, setTouched] = useState(false);
  const [sending, setSending] = useState<{ label: string; progress: number } | null>(null);
  const [failed, setFailed] = useState<Record<string, string>>({});
  const [sent, setSent] = useState<string[]>([]);
  const data = view.data;

  useEffect(() => {
    if (data) document.title = t("Paperwork for {company}", { company: data.company.name });
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
  // Only what the business takes: no W-9 outside the US (the kinds the server lists).
  const extras = [
    ...Object.keys(REQUIREMENT_LABELS)
      .filter((key) => !data || kindsFor(key).some((kind) => data.kinds.some((k) => k.key === kind)))
      .map((key) => ({ key, label: REQUIREMENT_LABELS[key]!, kinds: kindsFor(key) })),
    { key: "license", label: kindLabel("license"), kinds: ["license"] },
    { key: "other", label: t("Other document"), kinds: ["other"] },
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
          else problems[item.key] = t("That file didn't come through. Try sending it again.");
        } catch (error) {
          if (!isAbort(error)) problems[item.key] = error instanceof Error ? error.message : t("That file didn't come through. Try sending it again.");
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
    <ClientPage color={data?.company.color}>
      {data && <ClientHeader name={data.company.name} logo={data.company.logo} sub={t("Paperwork")} />}
      <ClientBody width="narrow">
        {view.isPending && <ClientSkeleton lines={2} />}
        {view.error && <Broken title={t("This link isn't working")}>{(view.error as Error).message}</Broken>}
        {data && (
          <>
            {sent.length > 0 && (
              <Done role="status" headingLevel={allSent ? 1 : 2} title={t("Thanks, it's in")}>
                <p className={k.doneText}>{t.plural(sent.length, { one: "{company} got {list}. They'll check it and get in touch if anything's missing.", other: "{company} got {list}. They'll check them and get in touch if anything's missing." }, { company: data.company.name, list: getLocale() === "en" ? askingFor(sent.map((label) => ({ label }))) : sent.map((label) => t(label)).join(", ") })}</p>
                {allSent && <Button className={k.soft} onClick={() => setSent([])}>{t("Send something else")}</Button>}
              </Done>
            )}

            {!allSent && (
              <form className={cx(k.form, k.loose)} noValidate onSubmit={onSubmit} aria-labelledby={sent.length === 0 ? "paperwork-title" : undefined}>
                {sent.length === 0 && (
                  <section className={p.intro}>
                    <h1 id="paperwork-title" className={k.titleMd}>
                      {list.length ? greeting(data.sub.name, data.company.name) : t("Hi {sub}, you're all set", { sub: data.sub.name })}
                    </h1>
                    {list.length === 0 && (
                      <p className={k.text}>{t("{company} has everything they need from you right now. If your insurance changed, you can still send the new one below.", { company: data.company.name })}</p>
                    )}
                    {data.waiting.length > 0 && (
                      <div className="callout callout-info">
                        <Icon name="info" size={16} />
                        <div className="grow" style={{ fontWeight: 400 }}>{t("Already sent, waiting for {company} to check: {list}.", { company: data.company.name, list: data.waiting.map((w) => t(REQUIREMENT_LABELS[w] ?? w)).join(", ") })}</div>
                      </div>
                    )}
                  </section>
                )}

                <div className={p.items}>
                  {list.map((item) => (
                    <ItemCard
                      key={item.key}
                      className={k.card}
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
                    <details className={cx("more-options", p.extras)} open={list.length === 0 || undefined}>
                      <summary>{t("Send something else")}</summary>
                      <div className={p.extraList}>
                        {extras.map((e) => (
                          <button key={e.key} type="button" className={k.choice} onClick={() => setItems([...list, { key: e.key, label: e.label, kinds: e.kinds, kind: e.kinds[0]!, why: null, file: null, expires_on: "" }])}>
                            <Icon name="plus" size={16} />{t(e.label)}
                          </button>
                        ))}
                      </div>
                    </details>
                  )}
                </div>

                {list.length > 0 && (
                  <div className={k.bar}>
                    {sending && (
                      <div className={k.sending} role="status" aria-live="polite">
                        <div className={k.sendingHead}><span>{t("Sending your {document}", { document: sending.label === "W-9" ? "W-9" : t(sending.label).toLowerCase() })}</span><span>{Math.round(sending.progress * 100)}%</span></div>
                        <div className="progress"><span style={{ width: `${Math.round(sending.progress * 100)}%` }} /></div>
                        <span className={k.note}>{t("Keep this page open until it's done.")}</span>
                      </div>
                    )}
                    {touched && !picked.length && <div className="form-error" role="alert">{t("Choose a file or take a photo to send.")}</div>}
                    <FormError error={submit.error} />
                    <Button type="submit" variant="primary" size="lg" className={k.cta} icon="send" loading={submit.isPending} block>
                      {picked.length > 1 ? t("Send {count} documents", { count: picked.length }) : t("Send")}
                    </Button>
                  </div>
                )}
              </form>
            )}
            <p className={k.foot}>{t("Only {company} sees what you send.", { company: data.company.name })}</p>
          </>
        )}
      </ClientBody>
    </ClientPage>
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
  className,
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
  /** A card of its own on the paperwork link; flat inside a signed-in sub's dialog. */
  className?: string;
}) {
  const pick = (files: FileList | null) => {
    const file = files?.[0];
    if (file) onChange({ file });
  };
  return (
    <section className={cx(p.item, className)} data-problem={fileProblem || dateProblem ? true : undefined} aria-label={t(item.label)}>
      <div className={p.itemHead}>
        <span className="grow">
          <strong className={p.itemName}>{t(item.label)}</strong>
          {item.why && <span className={p.itemWhy}>{item.why}</span>}
        </span>
        {onRemove && <button type="button" className={k.iconBtn} aria-label={t("Don't send {document}", { document: t(item.label) })} disabled={disabled} onClick={onRemove}><Icon name="x" size={16} /></button>}
      </div>
      {item.kinds.length > 1 && (
        <div className={cx("segmented", p.kinds)} role="group" aria-label={t("What you're sending for {document}", { document: t(item.label) })}>
          {item.kinds.map((kind) => (
            <button key={kind} type="button" aria-pressed={item.kind === kind} disabled={disabled} onClick={() => onChange({ kind })}>
              {kind === "wc_exemption" ? t("I'm exempt") : kind === "workers_comp" ? t("Certificate") : t(kindLabel(kind))}
            </button>
          ))}
        </div>
      )}
      {item.file ? (
        <div className={p.file}>
          <Icon name={item.file.type.startsWith("image/") ? "image" : "file"} size={18} />
          <span className={k.fileName}>{item.file.name}<small>{fileSize(item.file.size)}</small></span>
          <button type="button" className={k.link} disabled={disabled} onClick={() => onChange({ file: null })}>{t("Change")}</button>
        </div>
      ) : (
        <div className={p.picks}>
          <label className={cx("btn", p.pick)} aria-disabled={disabled}>
            <Icon name="camera" size={18} />{t("Take a photo")}
            <input type="file" className="sr-only" accept="image/*" capture="environment" disabled={disabled} onChange={(e) => { pick(e.target.files); e.target.value = ""; }} />
          </label>
          <label className={cx("btn", p.pick)} aria-disabled={disabled}>
            <Icon name="upload" size={18} />{t("Choose a file")}
            <input type="file" className="sr-only" accept={UPLOAD_ACCEPT} disabled={disabled} onChange={(e) => { pick(e.target.files); e.target.value = ""; }} />
          </label>
        </div>
      )}
      {fileProblem && <span className="field-error" role="alert">{fileProblem}</span>}
      {/* What the file can be, under the buttons that pick it. */}
      {!item.file && !fileProblem && <span className={p.hint}>{t("A PDF or a clear photo, up to {size}.", { size: fileSize(maxBytes) })}</span>}
      {asksForEndDate(item.kind) && (
        <Field label={t("Ends on")} optional={!needsEndDate(item.kind)} hint={dateProblem ? undefined : t("The expiration date on it.")} error={dateProblem}>
          <input className="input" type="date" value={item.expires_on} min={today} disabled={disabled} onChange={(e) => onChange({ expires_on: e.target.value })} />
        </Field>
      )}
    </section>
  );
}
