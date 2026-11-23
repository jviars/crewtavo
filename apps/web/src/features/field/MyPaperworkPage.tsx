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
import { RelatedList, RelatedRow, Section } from "@/components/ui/Section";
import { Loading, SectionSkeleton } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState, NoAccess } from "@/components/ui/States";
import { StatusPill } from "@/components/ui/StatusPill";
import { MAX_BYTES } from "@/lib/files";
import { formatDate, todayIn } from "@/lib/format";
import { isSub, useSession, type SubLogin } from "@/lib/session";
import { ItemCard, type Item } from "../public/PaperworkPage";
import { asksForEndDate, documentTitle, endDateProblem, kindsFor, myPaperwork, myPaperworkSummary, myUploadProblem, withType, type MyPaperworkItem, type MyPaperworkState } from "../subs/paperwork";
import { addSubDocument, refreshSubs, useSubDocuments, useSubPaperwork } from "../subs/subsData";
import { FieldHeader } from "./fieldUi";
import { msg, t } from "@/lib/i18n";

type Sending = Pick<Item, "key" | "label" | "kinds">;

const SECTIONS: Array<{ state: MyPaperworkState; title: string }> = [
  { state: "needed", title: msg("Needed") },
  { state: "waiting", title: msg("Waiting for the office to check") },
  { state: "ok", title: msg("OK") },
];

export function MyPaperworkPage() {
  const session = useSession();
  useDocumentTitle(t("My paperwork"));
  if (!isSub(session) || !session.subcontractor) return <NoAccess title={t("My paperwork")} />;
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
    <div className="field-app m-grouped field-narrow">
      <FieldHeader kicker={sub.name} title={t("My paperwork")}>
        <p className="page-lede">{t("What {company} needs on file from you: your W-9, and your liability and workers' comp insurance.", { company: company.name })}</p>
      </FieldHeader>

      {paperwork.isPending && <Loading label={t("Loading your paperwork")}><SectionSkeleton rows={3} /></Loading>}
      {paperwork.error && !paperwork.data && <ErrorState error={paperwork.error} onRetry={() => paperwork.refetch()} />}

      {paperwork.data && (
        <>
          <div className={`callout ${items.some((i) => i.state === "needed") ? "callout-warning" : "callout-good"}`} role="status">
            <Icon name={items.some((i) => i.state === "needed") ? "alert" : "check"} size={16} />
            <div className="grow">{myPaperworkSummary(items)}</div>
          </div>
          {SECTIONS.map((section) => {
            const mine = items.filter((i) => i.state === section.state);
            if (!mine.length) return null;
            return (
              <Section key={section.state} title={t(section.title)} count={mine.length} icon={section.state === "needed" ? "alert" : undefined} className={section.state === "needed" ? "paper-needed" : undefined}>
                <RelatedList>
                  {mine.map((item) => (
                    <RelatedRow
                      key={item.requirement}
                      title={t(item.label)}
                      sub={[<StatusPill key="status" label={item.status} tone={item.tone} />, <span key="detail" className="meta-break">{item.detail}</span>]}
                      actions={
                        <Button variant={item.state === "needed" ? "primary" : "secondary"} icon="upload" onClick={() => sendFor(item)}>
                          {item.state === "needed" ? t("Send it") : t("Send another")}
                        </Button>
                      }
                    />
                  ))}
                </RelatedList>
              </Section>
            );
          })}
        </>
      )}

      <Section title={t("What you've sent")} count={sent.length || undefined} action={<button type="button" onClick={() => setSending({ key: "other", label: t("Something else"), kinds: ["license", "other"] })}><Icon name="plus" size={14} />{t("Send something else")}</button>}>
        {documents.isPending ? (
          <SectionSkeleton rows={2} />
        ) : documents.error && !documents.data ? (
          <ErrorState compact error={documents.error} onRetry={() => documents.refetch()} />
        ) : sent.length === 0 ? (
          <EmptyState inline title={t("Nothing on file yet")}>{t("What you send shows here, and the office checks it.")}</EmptyState>
        ) : (
          <RelatedList>
            {sent.map((d) => (
              <RelatedRow
                key={d.id}
                lead={<span className="rel-icon"><Icon name={d.content_type?.startsWith("image/") ? "image" : "file"} size={15} /></span>}
                title={d.url ? <a href={d.url} target="_blank" rel="noreferrer" className="paper-link">{t(documentTitle(d))}</a> : t(documentTitle(d))}
                sub={[d.verified_at ? <StatusPill key="status" label={t("Checked")} tone="good" /> : <StatusPill key="status" label={t("Waiting to be checked")} tone="pending" />, d.uploaded_via === "office" ? t("Added by the office") : t("Sent {date}", { date: formatDate(d.created_at) }), d.expires_on && t("Ends {date}", { date: formatDate(d.expires_on) })]}
              />
            ))}
          </RelatedList>
        )}
      </Section>

      {sending && <SendDialog sub={sub} sending={sending} today={today} onClose={() => setSending(null)} />}
    </div>
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
    meta: { inline: true, success: t("Sent to {company} to check", { company: company.name }) },
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
    <Dialog open onClose={onClose} title={required ? t("Send your {document}", { document: sending.label === "W-9" ? "W-9" : t(sending.label).toLowerCase() }) : t("Send something else")}>
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
          <Field label={t("What it is")} optional>
            <input className="input" value={title} maxLength={120} placeholder={item.kind === "license" ? t("Contractor's license") : t("Signed agreement")} disabled={send.isPending} onChange={(e) => setTitle(e.target.value)} />
          </Field>
        )}
        {touched && !item.file && <div className="form-error" role="alert">{t("Choose a file or take a photo to send.")}</div>}
        <FormError error={send.error} />
        <span className="muted small">{t("Only {company} sees what you send. They'll check it and let you know if anything's missing.", { company: company.name })}</span>
        <div className="form-actions">
          <Button onClick={onClose} disabled={send.isPending}>{t("Cancel")}</Button>
          <Button type="submit" variant="primary" icon="send" loading={send.isPending} slowHint={false}>{t("Send")}</Button>
        </div>
      </form>
    </Dialog>
  );
}
