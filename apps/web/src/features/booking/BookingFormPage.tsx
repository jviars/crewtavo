/** Public booking / request form: /book/:company/:form (add ?embed=1 inside an iframe). No account needed. */
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { Field, FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { Skeleton } from "@/components/ui/Skeleton";
import { publicFetch, useTurnstile } from "@/lib/publicApi";
import { fileSize, isAbort, PLAN_MAX_BYTES, TooLargeError, uploadToLink } from "../plans/plans";

/** The most files a request can bring (the API's limit too). */
const MAX_FILES = 10;
const isFileQuestion = (q: Question) => q.type === "files" || q.type === "photos";
interface Sent { reference: number; uploads?: Array<{ name: string; path: string; token: string } | null>; files_token?: string }

interface Question {
  key: string;
  label: string;
  type: "address" | "text" | "long_text" | "number" | "yes_no" | "choice" | "multi_choice" | "photos" | "files";
  required: boolean;
  options?: string[];
}
interface FormView {
  company: { name: string; phone: string | null };
  form: { name: string; kind: string; questions: Question[] };
}

export function BookingFormPage() {
  const { company = "", form = "" } = useParams();
  const [params] = useSearchParams();
  const embedded = params.get("embed") === "1";
  const path = `/public/forms/${encodeURIComponent(company)}/${encodeURIComponent(form)}`;
  const view = useQuery({ queryKey: ["booking", company, form], retry: false, queryFn: () => publicFetch<FormView>(path) });
  const [contact, setContact] = useState({ name: "", email: "", phone: "", line1: "", city: "", postal_code: "" });
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  // Files picked for "Files" and "Photos" questions; they go up after the request is in.
  const [files, setFiles] = useState<Record<string, File[]>>({});
  const [sending, setSending] = useState<{ done: number; total: number; progress: number } | null>(null);
  const fileCount = Object.values(files).reduce((n, list) => n + list.length, 0);
  const [touched, setTouched] = useState(false);
  // A promo code from the link (?promo=SPRING10) or typed in, checked before sending.
  const [promo, setPromo] = useState({ code: (params.get("promo") ?? "").toUpperCase().slice(0, 24), offer: "" as string, open: Boolean(params.get("promo")) });
  const checkPromo = useMutation({
    mutationFn: (code: string) => publicFetch<{ code: string; offer: string }>(`${path}/promo`, { code }),
    onSuccess: (r) => setPromo((p) => ({ ...p, code: r.code, offer: r.offer })),
  });
  useEffect(() => {
    if (view.data && promo.code && !promo.offer && !checkPromo.isPending && !checkPromo.isError && !checkPromo.isSuccess) checkPromo.mutate(promo.code);
  }, [view.data]);
  const turnstile = useTurnstile(Boolean(view.data));
  const questions = (view.data?.form.questions ?? []).filter((q) => q.type !== "address");
  const unanswered = questions.filter(
    (q) => q.required && (isFileQuestion(q) ? !files[q.key]?.length : q.type === "multi_choice" ? !(answers[q.key] as string[] | undefined)?.length : !String(answers[q.key] ?? "").trim()),
  );
  const noContact = !contact.email.trim() && !contact.phone.trim();

  useEffect(() => {
    if (view.data) document.title = `${view.data.form.name} · ${view.data.company.name}`;
  }, [view.data]);

  const submit = useMutation({
    mutationFn: async () => {
      const picked = Object.entries(files).flatMap(([question, list]) => list.map((file) => ({ question, file })));
      const sent = await publicFetch<Sent>(path, {
        name: contact.name.trim(),
        email: contact.email.trim() || undefined,
        phone: contact.phone.trim() || undefined,
        address: { line1: contact.line1.trim(), city: contact.city.trim() || undefined, postal_code: contact.postal_code.trim() || undefined },
        // Which files came with each question, by name.
        answers: { ...answers, ...Object.fromEntries(Object.entries(files).filter(([, list]) => list.length).map(([key, list]) => [key, list.map((f) => f.name)])) },
        files: picked.map(({ question, file }) => ({ question, name: file.name, size: file.size, type: file.type || undefined })),
        promo_code: promo.offer ? promo.code : undefined,
        turnstile_token: turnstile.token || undefined,
      });
      // The request is in. Now the files, one at a time, each on its own one-time link.
      const failed: string[] = [];
      const uploaded: Array<{ path: string; name: string }> = [];
      const links = sent.uploads ?? [];
      for (const [i, { file }] of picked.entries()) {
        const link = links[i]?.name === file.name ? links[i] : undefined;
        if (!link) {
          failed.push(file.name);
          continue;
        }
        setSending({ done: i, total: picked.length, progress: 0 });
        try {
          uploaded.push({ path: await uploadToLink(link, file, (progress) => setSending({ done: i, total: picked.length, progress })).promise, name: file.name });
        } catch (error) {
          if (!isAbort(error)) failed.push(file.name);
        }
      }
      let recorded = 0;
      if (uploaded.length && sent.files_token) {
        recorded = (await publicFetch<{ added: number }>(`${path}/files`, { files_token: sent.files_token, uploaded: uploaded.map((u) => u.path) }).catch(() => ({ added: 0 }))).added;
        // Sent but not recorded: as good as not sent.
        if (!recorded) failed.push(...uploaded.map((u) => u.name));
      }
      return { reference: sent.reference, sentFiles: recorded, failed };
    },
    onSettled: () => setSending(null),
    onSuccess: () => window.scrollTo({ top: 0, behavior: "smooth" }),
  });
  const set = (key: keyof typeof contact) => (e: { target: { value: string } }) => setContact({ ...contact, [key]: e.target.value });

  return (
    <div className="public-page" style={embedded ? { padding: 0, background: "transparent", minHeight: 0 } : undefined}>
      <div className="public-wrap" style={{ maxWidth: 640 }}>
        {view.isPending && <div className="card card-pad stack-sm"><Skeleton width="40%" height={12} /><Skeleton width="65%" height={26} /><Skeleton height={300} radius={10} /></div>}
        {view.error && (
          <div className="card"><div className="empty-state error-state"><span className="empty-icon"><Icon name="search" size={24} /></span><h3>This form isn't available</h3><p>{(view.error as Error).message}</p></div></div>
        )}
        {view.data && submit.data && (
          <div className="card card-pad stack-sm" style={{ textAlign: "center", justifyItems: "center", padding: 32 }}>
            <span className="success-mark"><Icon name="check" size={30} strokeWidth={2.5} /></span>
            <h1 style={{ fontSize: 24, fontWeight: 800 }}>Thanks, {contact.name.trim().split(" ")[0]}!</h1>
            <p style={{ margin: 0 }}>{view.data.company.name} got your request (reference #{submit.data.reference}) and will be in touch soon.</p>
            {submit.data.sentFiles > 0 && <p className="muted" style={{ margin: 0 }}>{submit.data.sentFiles === 1 ? "Your file came with it." : `Your ${submit.data.sentFiles} files came with it.`}</p>}
            {submit.data.failed.length > 0 && (
              <div className="callout callout-warning" style={{ textAlign: "left", width: "100%" }}>
                <Icon name="alert" size={18} />
                <div className="grow">
                  <div>{submit.data.failed.length === 1 ? "One file didn't come through:" : `${submit.data.failed.length} files didn't come through:`} {submit.data.failed.join(", ")}</div>
                  <div className="small" style={{ fontWeight: 400 }}>Your request is in. Email {submit.data.failed.length === 1 ? "it" : "them"} to {view.data.company.name}{view.data.company.phone ? `, or call ${view.data.company.phone}` : ""}.</div>
                </div>
              </div>
            )}
            {view.data.company.phone && <p className="muted" style={{ margin: 0 }}>Questions? Call <a href={`tel:${view.data.company.phone}`}>{view.data.company.phone}</a>.</p>}
          </div>
        )}
        {view.data && !submit.data && (
          <form
            className="card card-pad stack"
            noValidate
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              setTouched(true);
              const form = e.currentTarget as HTMLFormElement;
              if (!form.checkValidity() || unanswered.length || noContact) {
                form.querySelector<HTMLElement>(":invalid, [aria-invalid='true']")?.focus();
                return;
              }
              submit.mutate();
            }}
          >
            <div>
              {!embedded && <div className="muted strong">{view.data.company.name}</div>}
              <h1 style={{ fontSize: 26, fontWeight: 800, letterSpacing: "-0.02em" }}>{view.data.form.name}</h1>
            </div>
            <div className="form-grid">
              <Field label="Your name" error={touched && contact.name.trim().length < 2 ? "Enter your name" : null}><input className="input" value={contact.name} onChange={set("name")} required minLength={2} maxLength={120} autoComplete="name" /></Field>
              <Field label="Email" error={touched && noContact ? "Add an email or a phone number" : null}><input className="input" type="email" value={contact.email} onChange={set("email")} maxLength={200} autoComplete="email" aria-invalid={touched && noContact} /></Field>
              <Field label="Phone"><input className="input" type="tel" value={contact.phone} onChange={set("phone")} maxLength={30} autoComplete="tel" aria-invalid={touched && noContact} /></Field>
            </div>
            <Field label="Service address" error={touched && contact.line1.trim().length < 3 ? "Enter the address for the work" : null}><input className="input" value={contact.line1} onChange={set("line1")} required minLength={3} maxLength={200} autoComplete="street-address" /></Field>
            <div className="form-grid">
              <Field label="City"><input className="input" value={contact.city} onChange={set("city")} maxLength={100} autoComplete="address-level2" /></Field>
              <Field label="ZIP"><input className="input" value={contact.postal_code} onChange={set("postal_code")} maxLength={12} autoComplete="postal-code" inputMode="numeric" /></Field>
            </div>
            {questions.map((q) => (
              isFileQuestion(q) ? (
                <FileQuestion key={q.key} q={q} files={files[q.key] ?? []} room={MAX_FILES - fileCount} invalid={touched && unanswered.includes(q)} disabled={submit.isPending} onChange={(list) => setFiles((all) => ({ ...all, [q.key]: list }))} />
              ) : (
                <QuestionField key={q.key} q={q} value={answers[q.key]} invalid={touched && unanswered.includes(q)} onChange={(v) => setAnswers({ ...answers, [q.key]: v })} />
              )
            ))}
            {promo.offer ? (
              <div className="callout callout-good">
                <Icon name="tag" size={18} />
                <div className="grow"><strong className="mono">{promo.code}</strong>: {promo.offer}. It'll be applied to your quote.</div>
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => { setPromo({ code: "", offer: "", open: false }); checkPromo.reset(); }}>Remove</button>
              </div>
            ) : promo.open ? (
              <Field label="Promo code" optional error={checkPromo.error ? (checkPromo.error as Error).message : null}>
                <div className="promo-entry">
                  <input className="input mono grow" value={promo.code} onChange={(e) => { setPromo({ ...promo, code: e.target.value.toUpperCase() }); checkPromo.reset(); }} maxLength={24} autoCapitalize="characters" />
                  <Button loading={checkPromo.isPending} disabled={!promo.code.trim()} onClick={() => checkPromo.mutate(promo.code.trim())}>Apply</Button>
                </div>
              </Field>
            ) : (
              <button type="button" className="btn btn-sm btn-ghost" style={{ justifySelf: "start" }} onClick={() => setPromo({ ...promo, open: true })}><Icon name="tag" size={14} />Have a promo code?</button>
            )}
            <div ref={turnstile.ref} />
            <FormError error={submit.error} />
            {sending && (
              <div className="stack-sm" role="status" aria-live="polite">
                <div className="row-between small"><span className="strong">Sending your files: {sending.done + 1} of {sending.total}</span><span className="muted tabular">{Math.round(sending.progress * 100)}%</span></div>
                <div className="progress"><span style={{ width: `${Math.round(((sending.done + sending.progress) / sending.total) * 100)}%` }} /></div>
                <span className="muted small">Keep this page open until they're done.</span>
              </div>
            )}
            <Button type="submit" variant="primary" size="lg" icon="send" loading={submit.isPending} disabled={turnstile.required && !turnstile.token}>Send request</Button>
          </form>
        )}
      </div>
    </div>
  );
}

/** A "Files" or "Photos" question: pick or drop files; they're sent once the request is in. */
function FileQuestion({ q, files, room, invalid, disabled, onChange }: { q: Question; files: File[]; room: number; invalid: boolean; disabled: boolean; onChange: (files: File[]) => void }) {
  const [problem, setProblem] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const photos = q.type === "photos";
  const add = (picked: File[]) => {
    const fitting = picked.filter((f) => f.size > 0 && f.size <= PLAN_MAX_BYTES && (!photos || f.type.startsWith("image/")));
    const tooBig = picked.filter((f) => f.size > PLAN_MAX_BYTES);
    const taken = fitting.slice(0, Math.max(0, room));
    setProblem(
      tooBig.length ? new TooLargeError(`${tooBig[0]!.name} is larger than ${fileSize(PLAN_MAX_BYTES)}. Split it into smaller files, or send it another way.`).message
        : fitting.length > taken.length ? `You can send up to ${MAX_FILES} files with a request.`
          : picked.length > fitting.length ? (photos ? "Only pictures here." : "Some of those files are empty.") : null,
    );
    if (taken.length) onChange([...files, ...taken]);
  };
  const label = <>{q.label}{!q.required && <span className="optional"> (optional)</span>}</>;
  return (
    <div
      className="field"
      onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); setOver(true); } }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); if (!disabled) add([...e.dataTransfer.files]); }}
      style={over ? { outline: "2px dashed var(--green)", outlineOffset: 4, borderRadius: 8 } : undefined}
    >
      <span>{label}</span>
      {files.length > 0 && (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 6 }}>
          {files.map((f, i) => (
            <li key={`${f.name}-${i}`} className="row" style={{ gap: 8 }}>
              <Icon name={f.type.startsWith("image/") ? "image" : "file"} size={16} />
              <span className="grow" style={{ overflowWrap: "anywhere" }}>{f.name} <span className="muted small">{fileSize(f.size)}</span></span>
              <button type="button" className="btn btn-sm btn-ghost btn-icon" aria-label={`Remove ${f.name}`} disabled={disabled} onClick={() => onChange(files.filter((_, j) => j !== i))}><Icon name="x" size={14} /></button>
            </li>
          ))}
        </ul>
      )}
      <label className="btn" style={{ justifySelf: "start" }} aria-disabled={disabled || room <= 0}>
        <Icon name={photos ? "camera" : "upload"} size={16} />{photos ? "Add photos" : "Add files"}
        <input type="file" multiple hidden accept={photos ? "image/*" : undefined} disabled={disabled || room <= 0} onChange={(e) => { const picked = [...(e.target.files ?? [])]; e.target.value = ""; add(picked); }} />
      </label>
      <span className="muted small">{photos ? "Pictures" : "Plans, PDFs or pictures"}, up to {fileSize(PLAN_MAX_BYTES)} each. You can also drop them here.</span>
      {(problem || invalid) && <span className="field-error">{problem ?? "Please add a file"}</span>}
    </div>
  );
}

function QuestionField({ q, value, invalid, onChange }: { q: Question; value: unknown; invalid: boolean; onChange: (v: unknown) => void }) {
  const label = <>{q.label}{!q.required && <span className="optional"> (optional)</span>}</>;
  const error = invalid ? "Please answer this" : null;
  switch (q.type) {
    case "long_text":
      return <Field label={label} error={error}><textarea className="textarea" value={String(value ?? "")} maxLength={4000} onChange={(e) => onChange(e.target.value)} aria-invalid={invalid} /></Field>;
    case "number":
      return <Field label={label} error={error}><input className="input" inputMode="decimal" value={String(value ?? "")} onChange={(e) => onChange(e.target.value.replace(/[^0-9.]/g, ""))} aria-invalid={invalid} /></Field>;
    case "yes_no":
    case "choice":
    case "multi_choice": {
      const options = q.type === "yes_no" ? ["Yes", "No"] : q.options ?? [];
      const list = Array.isArray(value) ? (value as string[]) : [];
      return (
        <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend style={{ marginBottom: 6 }}>{label}</legend>
          <div className="row wrap" style={{ gap: 6 }}>
            {options.map((o) => {
              const on = q.type === "multi_choice" ? list.includes(o) : value === o;
              return (
                <button key={o} type="button" className="tab" aria-pressed={on} style={{ height: 38, padding: "0 14px" }} onClick={() => onChange(q.type === "multi_choice" ? (on ? list.filter((x) => x !== o) : [...list, o]) : o)}>
                  {on && <Icon name="check" size={13} strokeWidth={3} />}{o}
                </button>
              );
            })}
          </div>
          {error && <span className="field-error">{error}</span>}
        </fieldset>
      );
    }
    default:
      return <Field label={label} error={error}><input className="input" value={String(value ?? "")} maxLength={500} onChange={(e) => onChange(e.target.value)} aria-invalid={invalid} /></Field>;
  }
}
