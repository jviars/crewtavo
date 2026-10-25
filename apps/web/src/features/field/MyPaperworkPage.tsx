/**
 * A sub's paperwork, in the field app (/field/paperwork, where reminders link): what the office
 * needs from them, what's waiting for the office to check, and what's OK, and sending a new W-9 or
 * certificate from the phone's camera or files. The file goes to <company>/subs/<their sub>/ and the
 * row to sub_documents, which the database marks as sent by them and not checked yet, and tells the
 * office about. A sub can't change or delete what they sent; the office does that.
 */
import { PAPERWORK_REQUIREMENTS, subDocumentLabel } from "@crewtavo/core/subs";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Field, FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { useDocumentTitle } from "@/components/ui/PageHeader";
import { CardSkeleton, Loading } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState, NoAccess } from "@/components/ui/States";
import { StatusPill } from "@/components/ui/StatusPill";
import { MAX_BYTES } from "@/lib/files";
import { formatDate, todayIn } from "@/lib/format";
import { isSub, useSession, type SubLogin } from "@/lib/session";
import { ItemCard, type Item } from "../public/PaperworkPage";
import { asksForEndDate, documentTitle, endDateProblem, kindsFor, myPaperwork, myPaperworkSummary, myUploadProblem, withType, type MyPaperworkItem, type MyPaperworkState } from "../subs/paperwork";
import { addSubDocument, refreshSubs, useSubDocuments, useSubPaperwork } from "../subs/subsData";

type Sending = Pick<Item, "key" | "label" | "kinds">;

const SECTIONS: Array<{ state: MyPaperworkState; title: string }> = [
  { state: "needed", title: "Needed" },
  { state: "waiting", title: "Waiting for the office to check" },
  { state: "ok", title: "OK" },
];

export function MyPaperworkPage() {
  const session = useSession();
  useDocumentTitle("My paperwork");
  if (!isSub(session) || !session.subcontractor) return <NoAccess title="My paperwork" />;
  return <MyPaperwork sub={session.subcontractor} />;
}

function MyPaperwork({ sub }: { sub: SubLogin }) {
  const { company } = useSession();
  const [sending, setSending] = useState<Sending | null>(null);
  const paperwork = useSubPaperwork(company.id, sub.id);
  const documents = useSubDocuments(company.id, sub.id);
  const today = todayIn(company.timezone);
  const items = paperwork.data ? myPaperwork(paperwork.data) : [];
  const sent = (documents.data ?? []).filter((d) => !d.superseded_at);
  const sendFor = (item: MyPaperworkItem) => setSending({ key: item.requirement, label: item.label, kinds: kindsFor(item.requirement) });

  return (
    <>
      <div>
        <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text-2)" }}>{sub.name}</div>
        <h1 className="page-title" style={{ marginTop: 4 }}>My paperwork</h1>
      </div>
      <p className="muted" style={{ margin: 0 }}>What {company.name} needs on file from you: your W-9, and your liability and workers' comp insurance.</p>

      {paperwork.isPending && <Loading label="Loading your paperwork"><div className="stack">{[0, 1, 2].map((i) => <CardSkeleton key={i} lines={2} />)}</div></Loading>}
      {paperwork.error && !paperwork.data && <div className="card"><ErrorState error={paperwork.error} onRetry={() => paperwork.refetch()} /></div>}

      {paperwork.data && (
        <>
          <div className={`callout ${items.some((i) => i.state === "needed") ? "callout-warning" : "callout-good"}`} role="status">
            <Icon name={items.some((i) => i.state === "needed") ? "alert" : "check"} size={18} />
            <div className="grow">{myPaperworkSummary(items)}</div>
          </div>
          {SECTIONS.map((section) => {
            const mine = items.filter((i) => i.state === section.state);
            if (!mine.length) return null;
            return (
              <section key={section.state} className="stack-sm">
                <h2 className="section-title">{section.title}</h2>
                <div className="card">
                  {mine.map((item) => (
                    <div key={item.requirement} className="card-row wrap" style={{ alignItems: "flex-start" }}>
                      <span className="grow stack-sm" style={{ minWidth: 200, gap: 4 }}>
                        <span className="row wrap" style={{ gap: 8 }}>
                          <strong>{item.label}</strong>
                          <StatusPill label={item.status} tone={item.tone} />
                        </span>
                        <span className="muted small">{item.detail}</span>
                      </span>
                      <Button size="sm" variant={item.state === "needed" ? "primary" : "secondary"} icon="upload" onClick={() => sendFor(item)}>
                        {item.state === "needed" ? "Send it" : "Send a new one"}
                      </Button>
                    </div>
                  ))}
                </div>
              </section>
            );
          })}
        </>
      )}

      <section className="stack-sm">
        <div className="section-head">
          <h2 className="section-title">What you've sent</h2>
          <Button size="sm" icon="plus" onClick={() => setSending({ key: "other", label: "Something else", kinds: ["license", "other"] })}>Send something else</Button>
        </div>
        <div className="card">
          {documents.isPending ? (
            <div className="card-row"><CardSkeleton lines={1} /></div>
          ) : documents.error && !documents.data ? (
            <div className="card-row"><ErrorState compact error={documents.error} onRetry={() => documents.refetch()} /></div>
          ) : sent.length === 0 ? (
            <EmptyState compact icon="file" title="Nothing on file yet">What you send shows here, and the office checks it.</EmptyState>
          ) : (
            sent.map((d) => (
              <div key={d.id} className="card-row" style={{ alignItems: "flex-start" }}>
                <Icon name={d.content_type?.startsWith("image/") ? "image" : "file"} size={16} />
                <span className="grow" style={{ minWidth: 0 }}>
                  {d.url ? <a href={d.url} target="_blank" rel="noreferrer" className="strong" style={{ overflowWrap: "anywhere" }}>{documentTitle(d)}</a> : <strong>{documentTitle(d)}</strong>}
                  <span className="muted small" style={{ display: "block" }}>
                    {[d.uploaded_via === "office" ? "Added by the office" : `Sent ${formatDate(d.created_at)}`, d.expires_on && `Ends ${formatDate(d.expires_on)}`].filter(Boolean).join(" · ")}
                  </span>
                </span>
                {d.verified_at ? <StatusPill label="Checked" tone="good" /> : <StatusPill label="Waiting to be checked" tone="info" />}
              </div>
            ))
          )}
        </div>
      </section>

      {sending && <SendDialog sub={sub} sending={sending} today={today} onClose={() => setSending(null)} />}
    </>
  );
}

/** Sending one document: the camera or a file, and the date it ends. It waits for the office to check it. */
function SendDialog({ sub, sending, today, onClose }: { sub: SubLogin; sending: Sending; today: string; onClose: () => void }) {
  const { company } = useSession();
  const queryClient = useQueryClient();
  const [item, setItem] = useState<Item>({ ...sending, kind: sending.kinds[0]!, why: null, file: null, expires_on: "" });
  const [title, setTitle] = useState("");
  const [touched, setTouched] = useState(false);
  const fileProblem = item.file ? myUploadProblem(item.file, MAX_BYTES) : null;
  const dateProblem = item.file ? endDateProblem(item.kind, item.expires_on, today) : null;
  const named = item.kind === "license" || item.kind === "other";
  const send = useMutation({
    meta: { inline: true, success: `Sent. ${company.name} will check it.` },
    mutationFn: () =>
      addSubDocument(company.id, sub.id, withType(item.file!), {
        kind: item.kind,
        title: named ? title.trim() || null : null,
        carrier: null,
        policy_number: null,
        starts_on: null,
        expires_on: asksForEndDate(item.kind) && item.expires_on ? item.expires_on : null,
      }),
    onSuccess: () => {
      refreshSubs(queryClient);
      onClose();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (!item.file || fileProblem || dateProblem) return;
    send.mutate();
  };
  const required = PAPERWORK_REQUIREMENTS.some((r) => r.key === sending.key);

  return (
    <Dialog open onClose={onClose} title={required ? `Send your ${sending.label === "W-9" ? "W-9" : sending.label.toLowerCase()}` : "Send something else"}>
      <form className="dialog-body" noValidate onSubmit={submit}>
        <ItemCard
          item={item}
          kindLabel={subDocumentLabel}
          maxBytes={MAX_BYTES}
          disabled={send.isPending}
          fileProblem={fileProblem}
          dateProblem={touched || item.expires_on ? dateProblem : null}
          today={today}
          onChange={(patch) => setItem((current) => ({ ...current, ...patch }))}
        />
        {named && (
          <Field label="What it is" optional>
            <input className="input" value={title} maxLength={120} placeholder={item.kind === "license" ? "Contractor's license" : "Signed agreement"} disabled={send.isPending} onChange={(e) => setTitle(e.target.value)} />
          </Field>
        )}
        {touched && !item.file && <div className="form-error" role="alert">Choose a file or take a photo to send.</div>}
        <FormError error={send.error} />
        <span className="muted small">Only {company.name} sees what you send. They'll check it and let you know if anything's missing.</span>
        <div className="form-actions">
          <Button onClick={onClose} disabled={send.isPending}>Cancel</Button>
          <Button type="submit" variant="primary" icon="send" loading={send.isPending}>Send</Button>
        </div>
      </form>
    </Dialog>
  );
}
