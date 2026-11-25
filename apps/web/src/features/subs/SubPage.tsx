/** One sub: their W-9 and insurance with what's current, their other papers and history, their pay and rates, their details and their sign-in. */
import { TRASH_DAYS } from "@crewtavo/core/drive";
import { paperworkRequirements, subDocumentLabel, taxClassificationLabel, usesIrsForms } from "@crewtavo/core/subs";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { Icon } from "@/components/ui/Icon";
import { DetailColumns, DetailHeader } from "@/components/ui/DetailPage";
import { MetaLine } from "@/components/ui/InboxList";
import { Menu, type MenuEntry } from "@/components/ui/Menu";
import { BackLink, useDocumentTitle } from "@/components/ui/PageHeader";
import { Fact, Facts, RelatedList, RelatedRow, Section } from "@/components/ui/Section";
import { DetailSkeleton, Skeleton } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState, NoAccess, PageError } from "@/components/ui/States";
import { StatusPill } from "@/components/ui/StatusPill";
import { api, supabase, unwrap, unwrapOne } from "@/lib/api";
import { addressLine, companyCountry, formatDate, todayIn } from "@/lib/format";
import { useRememberRecent } from "@/lib/recent";
import { useSession } from "@/lib/session";
import { toast } from "@/lib/toast";
import { storedUndoToast, TRASH_PATH } from "../drive/trash";
import { fileSize } from "../plans/plans";
import { documentTitle, endsText, inOrder, insuranceWarning, isInsurance, kindsFor, needsAttention, paperworkChip, type PaperworkRow } from "./paperwork";
import { RatesCard } from "./RatesCard";
import { SubAccessCard } from "./SubAccessCard";
import { DocumentDialog, SendLinkDialog, SubDialog } from "./SubDialogs";
import { SubPayCard } from "./SubPayCard";
import { deleteSubDocument, managesSubs, refreshSubs, SUB_FIELDS, useSubAccess, useSubDocuments, useSubPaperwork, type Sub, type SubDocument, type SubDocumentWithLink } from "./subsData";
import styles from "./Subs.module.css";

type DialogState = null | "edit" | "send" | { kinds: readonly string[]; replacing?: SubDocument | null } | { doc: SubDocument };

export function SubPage() {
  const session = useSession();
  if (!managesSubs(session)) return <NoAccess title="Subcontractors" />;
  return <SubDetail />;
}

function SubDetail() {
  const { id = "" } = useParams();
  const session = useSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<DialogState>(null);
  const today = todayIn(session.company.timezone);

  const item = useQuery({
    queryKey: ["subs", session.company.id, "item", id],
    queryFn: async () => unwrapOne(await supabase().from("subcontractors").select(SUB_FIELDS).eq("company_id", session.company.id).eq("id", id).maybeSingle(), "This sub") as unknown as Sub,
  });
  const paperwork = useSubPaperwork(session.company.id, id);
  const documents = useSubDocuments(session.company.id, id);

  const s = item.data;
  useDocumentTitle(s?.name ?? "Subcontractor");
  useRememberRecent(session.company.id, s ? { kind: "sub", id: s.id, title: s.name, subtitle: s.trade ?? "Subcontractor", path: `/subs/${s.id}` } : null);

  const setActive = useMutation({
    meta: { success: (_: unknown, active: boolean) => (active ? "Turned back on" : "Turned off") },
    mutationFn: async (active: boolean) => unwrap(await supabase().from("subcontractors").update({ active }).eq("id", id)),
    onSuccess: () => refreshSubs(queryClient),
  });
  const access = useSubAccess(session.company.id, id);
  const remove = useMutation({
    // Through the server, so their sign-in goes too: every phone it's on is signed out. Their
    // documents go with them, and the database moves the documents' files to the Trash.
    mutationFn: async () => {
      await api.delete(`/subs/${id}`);
      return (documents.data ?? []).length > 0;
    },
    onSuccess: (hadPaperwork) => {
      toast.success("Sub deleted", hadPaperwork ? { description: `Their paperwork is in the Trash for ${TRASH_DAYS} days.`, action: { label: "Open the Trash", onClick: () => navigate(TRASH_PATH) } } : undefined);
      refreshSubs(queryClient);
      navigate("/subs", { replace: true });
    },
  });
  const verify = useMutation({
    meta: { success: (_: unknown, v: { on: boolean }) => (v.on ? "Verified" : "Marked as not verified") },
    mutationFn: async ({ docId, on }: { docId: string; on: boolean }) =>
      // The database stamps who checked it and when; any value turns it on.
      unwrap(await supabase().from("sub_documents").update({ verified_at: on ? new Date().toISOString() : null }).eq("id", docId)),
    onSuccess: () => refreshSubs(queryClient),
  });
  const removeDoc = useMutation({
    mutationFn: deleteSubDocument,
    onSuccess: (_, doc) => {
      refreshSubs(queryClient);
      storedUndoToast("Document deleted", session.company.id, doc.path, () => refreshSubs(queryClient));
    },
  });

  if (item.isPending) return <DetailSkeleton />;
  if (item.error || !s) return <PageError error={item.error} onRetry={() => item.refetch()} back={<BackLink to="/subs">Subcontractors</BackLink>} />;

  const docs = documents.data ?? [];
  const current = docs.filter((d) => !d.superseded_at);
  const history = docs.filter((d) => d.superseded_at);
  // Outside the US a W-9 isn't asked for: one kept from before shows with the other papers.
  const others = current.filter((d) => d.kind === "license" || d.kind === "other" || (d.kind === "w9" && !usesIrsForms(companyCountry())));
  // Turned-off subs have no rows in sub_paperwork; their documents still show.
  const statuses = inOrder(paperwork.data ?? []);
  const warning = s.active && paperwork.data ? insuranceWarning(statuses) : null;
  const attention = s.active && paperwork.data && needsAttention(statuses);

  const askDelete = async (d: SubDocument) => {
    const body = d.superseded_at ? `Its file goes to the Trash for ${TRASH_DAYS} days.` : `Its file goes to the Trash for ${TRASH_DAYS} days. If it replaced an older one, the older one counts again.`;
    if (await confirm({ title: d.kind === "w9" ? "Delete this W-9?" : "Delete this document?", body, confirmLabel: "Delete", danger: true })) removeDoc.mutate(d);
  };
  const docMenu = (d: SubDocument): MenuEntry[] => [
    { label: "Edit dates and details", icon: "edit", onSelect: () => setDialog({ doc: d }) },
    { label: "Mark as not verified", icon: "undo", hidden: !d.verified_at, onSelect: () => verify.mutate({ docId: d.id, on: false }) },
    { separator: true },
    { label: "Delete", icon: "trash", danger: true, onSelect: () => askDelete(d) },
  ];
  const askTurnOff = async () => (await confirm({ title: `Turn off ${s.name}?`, body: "They leave the list, stop getting reminders and can't sign in. Their paperwork stays, and you can turn them back on any time.", confirmLabel: "Turn off" })) && setActive.mutate(false);
  const askRemove = async () => {
    const signIn = access.data && access.data.state !== "none" ? " Their sign-in is removed too, and they're signed out." : "";
    const body = (docs.length ? `Their paperwork is deleted too (its files stay in the Trash for ${TRASH_DAYS} days). To keep it for your records, turn them off instead.` : "This can't be undone.") + signIn;
    if (await confirm({ title: `Delete ${s.name}?`, body, confirmLabel: "Delete", danger: true, typeToConfirm: docs.length ? "delete" : undefined })) remove.mutate();
  };
  const address = addressLine({ ...s.address, line1: [s.address.line1, s.address.line2].filter(Boolean).join(", ") }) || null;
  const hasDetails = Boolean(s.contact_name || s.phone || s.email || s.trade || address || s.tax_classification || s.notes);

  return (
    <>
      <DetailHeader
        crumb={{ to: "/subs", label: "Subcontractors" }}
        title={s.name}
        status={!s.active ? <StatusPill label="Turned off" tone="muted" /> : attention ? <StatusPill label="Needs attention" tone="warning" /> : paperwork.data ? <StatusPill label="Paperwork OK" tone="good" /> : null}
        meta={[s.trade, s.contact_name]}
        actions={s.active && <Button variant="primary" icon="send" onClick={() => setDialog("send")}>Send upload link</Button>}
        more={[
          { label: "Edit details", icon: "edit", kbd: "E", onSelect: () => setDialog("edit") },
          { label: "Add a document", icon: "upload", kbd: "D", onSelect: () => setDialog({ kinds: [] }) },
          { separator: true },
          { label: "Turn off", icon: "archive", hidden: !s.active, onSelect: () => void askTurnOff() },
          { label: "Turn back on", icon: "restore", hidden: s.active, onSelect: () => setActive.mutate(true) },
          { separator: true },
          { label: "Delete", icon: "trash", danger: true, onSelect: () => void askRemove() },
        ]}
      />

      {!s.active && (
        <div className="callout">
          <Icon name="archive" size={16} />
          <div className="grow">Turned off. They're not on the list, don't get reminders and can't sign in.</div>
          <button type="button" className="link-btn" disabled={setActive.isPending} onClick={() => setActive.mutate(true)}>Turn back on</button>
        </div>
      )}
      {warning && (
        <div className="callout callout-warning">
          <Icon name="alert" size={16} />
          <div className="grow">{warning}</div>
          <button type="button" className="link-btn" onClick={() => setDialog("send")}>Ask for it</button>
        </div>
      )}

      <DetailColumns
        grouped
        side={
          <>
            <Section title="Details" action={<button type="button" onClick={() => setDialog("edit")}>Edit</button>}>
              {hasDetails ? (
                <Facts>
                  <Fact label="Contact">{s.contact_name}</Fact>
                  <Fact label="Phone">{s.phone && <a href={`tel:${s.phone}`}>{s.phone}</a>}</Fact>
                  <Fact label="Email">{s.email && <a href={`mailto:${s.email}`}>{s.email}</a>}</Fact>
                  <Fact label="Trade">{s.trade}</Fact>
                  <Fact label="Address">{address}</Fact>
                  <Fact label="Tax classification">{taxClassificationLabel(s.tax_classification)}</Fact>
                  <Fact label="Notes" wide>{s.notes && <span className="pre-wrap">{s.notes}</span>}</Fact>
                </Facts>
              ) : (
                <EmptyState inline title="Add their phone and email so you can send them their link." />
              )}
            </Section>
            <SubAccessCard sub={s} />
          </>
        }
      >
        <Section title="Paperwork">
          {paperwork.error && !paperwork.data && s.active && <ErrorState compact title="Couldn't load their paperwork's status" error={paperwork.error} onRetry={() => paperwork.refetch()} />}
          <ul className={styles.reqs} role="list">
            {paperworkRequirements(companyCountry()).map((req) => {
              const status = statuses.find((p) => p.requirement === req.key)!;
              const mine = current.filter((d) => (req.kinds as readonly string[]).includes(d.kind));
              // The one that counts first.
              mine.sort((a, b) => (a.id === status.document_id ? -1 : b.id === status.document_id ? 1 : 0));
              const counting = mine.find((d) => d.id === status.document_id) ?? mine[0] ?? null;
              return (
                <li key={req.key} className={styles.req}>
                  <div className={styles.reqHead}>
                    <span className={styles.reqName}>{req.label}</span>
                    {s.active && (paperwork.isPending ? <Skeleton width={80} height={12} /> : paperwork.data ? <ChipFor row={status} /> : null)}
                    <Button size="sm" className={styles.reqAction} icon="upload" onClick={() => setDialog({ kinds: kindsFor(req.key), replacing: counting })}>{mine.length ? "Replace" : "Upload"}</Button>
                  </div>
                  {documents.isPending ? (
                    <Skeleton width="50%" height={10} />
                  ) : mine.length === 0 ? (
                    <span className={styles.none}>Nothing on file yet.</span>
                  ) : (
                    mine.map((d) => <DocumentLine key={d.id} doc={d} today={today} menu={docMenu(d)} verifying={verify.isPending && verify.variables?.docId === d.id} onVerify={() => verify.mutate({ docId: d.id, on: true })} />)
                  )}
                </li>
              );
            })}
          </ul>
        </Section>

        <Section title="Other documents" count={others.length || undefined} action={<Button icon="plus" onClick={() => setDialog({ kinds: ["license", "other"] })}>Add document</Button>}>
          {documents.isPending ? (
            <Skeleton width="50%" />
          ) : others.length === 0 ? (
            <EmptyState inline title="No other documents">Licenses, signed agreements, anything else you keep for them.</EmptyState>
          ) : (
            <ul className={styles.reqs} role="list">
              {others.map((d) => (
                <li key={d.id} className={styles.req}>
                  <div className={styles.reqHead}><span className={styles.reqName}>{documentTitle(d)}</span></div>
                  <DocumentLine doc={d} today={today} menu={docMenu(d)} verifying={verify.isPending && verify.variables?.docId === d.id} onVerify={() => verify.mutate({ docId: d.id, on: true })} />
                </li>
              ))}
            </ul>
          )}
        </Section>

        <SubPayCard subId={s.id} name={s.name} />

        <RatesCard payee={{ subcontractor_id: s.id }} />

        {history.length > 0 && (
          <Section title="Replaced" count={history.length}>
            <div className={styles.payRows}><RelatedList label="Kept for your records and audits">
              {history.map((d) => (
                <RelatedRow
                  key={d.id}
                  title={documentTitle(d)}
                  sub={[
                    d.starts_on && `${formatDate(d.starts_on)} to ${d.expires_on ? formatDate(d.expires_on) : "no end date"}`,
                    !d.starts_on && d.expires_on && endsText(d.expires_on, today),
                    d.carrier,
                    d.uploaded_via !== "office" && `Sent by them ${formatDate(d.created_at)}`,
                    `Replaced ${formatDate(d.superseded_at)}`,
                  ]}
                  actions={
                    <>
                      {d.url && <a className="btn btn-sm" href={d.url} target="_blank" rel="noreferrer"><Icon name="external" size={14} />Open</a>}
                      <Menu triggerClassName="btn btn-sm btn-ghost btn-icon" label={`${documentTitle(d)} actions`} title={documentTitle(d)} items={[{ label: "Delete", icon: "trash", danger: true, onSelect: () => askDelete(d) }]} />
                    </>
                  }
                />
              ))}
            </RelatedList></div>
            <p className={styles.kept}>Kept for your records and audits.</p>
          </Section>
        )}
      </DetailColumns>

      {dialog === "edit" && <SubDialog sub={s} onClose={() => setDialog(null)} onSaved={() => undefined} />}
      {dialog === "send" && <SendLinkDialog sub={s} paperwork={statuses} onClose={() => setDialog(null)} />}
      {dialog && typeof dialog === "object" && "kinds" in dialog && <DocumentDialog sub={s} kinds={dialog.kinds} replacing={dialog.replacing} onClose={() => setDialog(null)} />}
      {dialog && typeof dialog === "object" && "doc" in dialog && <DocumentDialog sub={s} doc={dialog.doc} onClose={() => setDialog(null)} />}
    </>
  );
}

function ChipFor({ row }: { row: PaperworkRow }) {
  const chip = paperworkChip(row);
  return <StatusPill label={chip.label} tone={chip.tone} />;
}

/** A document on file: its file, dates and policy, who sent it, and checking it. */
function DocumentLine({ doc, today, menu, verifying, onVerify }: { doc: SubDocumentWithLink; today: string; menu: MenuEntry[]; verifying: boolean; onVerify: () => void }) {
  const dates = doc.kind === "w9" ? (doc.starts_on ? `Signed ${formatDate(doc.starts_on)}` : null) : [doc.starts_on && `Starts ${formatDate(doc.starts_on)}`, endsText(doc.expires_on, today)].filter(Boolean).join(" · ");
  const policy = isInsurance(doc.kind) ? [doc.carrier, doc.policy_number && `Policy ${doc.policy_number}`].filter(Boolean).join(" · ") : "";
  const sentBy = doc.uploaded_via === "office" ? null : `Sent by them ${formatDate(doc.created_at)}`;
  const rest = [policy, doc.verified_at && sentBy].filter(Boolean).join(" · ");
  return (
    <div className={styles.doc}>
      <div className={styles.docLine}>
        <Icon name={doc.content_type?.startsWith("image/") ? "image" : "file"} size={14} />
        {doc.url ? (
          <a href={doc.url} target="_blank" rel="noreferrer" className={styles.docName}>{doc.file_name || subDocumentLabel(doc.kind)}</a>
        ) : (
          <span className={styles.docName}>{doc.file_name || subDocumentLabel(doc.kind)}</span>
        )}
        {doc.size_bytes ? <span className={styles.docSize}>{fileSize(doc.size_bytes)}</span> : null}
        {doc.kind === "wc_exemption" && <span className="chip">Exemption</span>}
        <span className={styles.docMenu}><Menu triggerClassName="btn btn-sm btn-ghost btn-icon" label={`${documentTitle(doc)} actions`} title={documentTitle(doc)} items={menu} /></span>
      </div>
      {/* On a phone the policy starts a line of its own after the dates, so no line ends on a dangling dot. */}
      <MetaLine className={styles.docMeta} parts={[dates, rest && dates ? <span key="rest" className="meta-break">{rest}</span> : rest]} />
      {!doc.verified_at && (
        <div className={styles.verify}>
          <span>{sentBy ?? "Added"}. Check that it's the right document and the dates match.</span>
          <Button size="sm" icon="check" loading={verifying} onClick={onVerify}>Verify</Button>
        </div>
      )}
    </div>
  );
}
