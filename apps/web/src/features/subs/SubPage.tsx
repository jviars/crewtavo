/** One sub: their W-9 and insurance with what's current, their other papers and history, their pay and rates, their details and their sign-in. */
import { PAPERWORK_REQUIREMENTS, subDocumentLabel, taxClassificationLabel } from "@crewtavo/core/subs";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { Icon } from "@/components/ui/Icon";
import { Menu, type MenuEntry } from "@/components/ui/Menu";
import { BackLink, PageHeader, useDocumentTitle } from "@/components/ui/PageHeader";
import { DetailSkeleton, Skeleton } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState, NoAccess, PageError } from "@/components/ui/States";
import { StatusPill } from "@/components/ui/StatusPill";
import { api, supabase, unwrap, unwrapOne } from "@/lib/api";
import { addressLine, formatDate, todayIn } from "@/lib/format";
import { useRememberRecent } from "@/lib/recent";
import { useSession } from "@/lib/session";
import { fileSize } from "../plans/plans";
import { documentTitle, endsText, inOrder, insuranceWarning, isInsurance, kindsFor, needsAttention, paperworkChip, type PaperworkRow } from "./paperwork";
import { RatesCard } from "./RatesCard";
import { SubAccessCard } from "./SubAccessCard";
import { DocumentDialog, SendLinkDialog, SubDialog } from "./SubDialogs";
import { SubPayCard } from "./SubPayCard";
import { deleteSubDocument, managesSubs, refreshSubs, SUB_FIELDS, useSubAccess, useSubDocuments, useSubPaperwork, type Sub, type SubDocument, type SubDocumentWithLink } from "./subsData";

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
    meta: { success: "Sub deleted" },
    mutationFn: async () => {
      const paths = (documents.data ?? []).map((d) => d.path);
      // Through the server, so their sign-in goes too: every phone it's on is signed out.
      await api.delete(`/subs/${id}`);
      // Their documents went with them; their files are only tidiness.
      if (paths.length) await supabase().storage.from("files").remove(paths).catch(() => undefined);
    },
    onSuccess: () => {
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
    meta: { success: "Document deleted" },
    mutationFn: deleteSubDocument,
    onSuccess: () => refreshSubs(queryClient),
  });

  if (item.isPending) return <DetailSkeleton />;
  if (item.error || !s) return <PageError error={item.error} onRetry={() => item.refetch()} back={<BackLink to="/subs">Subcontractors</BackLink>} />;

  const docs = documents.data ?? [];
  const current = docs.filter((d) => !d.superseded_at);
  const history = docs.filter((d) => d.superseded_at);
  const others = current.filter((d) => d.kind === "license" || d.kind === "other");
  // Turned-off subs have no rows in sub_paperwork; their documents still show.
  const statuses = inOrder(paperwork.data ?? []);
  const warning = s.active && paperwork.data ? insuranceWarning(statuses) : null;
  const attention = s.active && paperwork.data && needsAttention(statuses);

  const askDelete = async (d: SubDocument) => {
    const body = d.superseded_at ? "Its file is deleted too." : "Its file is deleted too. If it replaced an older one, the older one counts again.";
    if (await confirm({ title: d.kind === "w9" ? "Delete this W-9?" : "Delete this document?", body, confirmLabel: "Delete", danger: true })) removeDoc.mutate(d);
  };
  const docMenu = (d: SubDocument): MenuEntry[] => [
    { label: "Edit dates and details", icon: "edit", onSelect: () => setDialog({ doc: d }) },
    { label: "Mark as not verified", icon: "undo", hidden: !d.verified_at, onSelect: () => verify.mutate({ docId: d.id, on: false }) },
    { separator: true },
    { label: "Delete", icon: "trash", danger: true, onSelect: () => askDelete(d) },
  ];
  const details: Array<[string, React.ReactNode]> = [
    ["Contact", s.contact_name],
    ["Phone", s.phone && <a href={`tel:${s.phone}`}>{s.phone}</a>],
    ["Email", s.email && <a href={`mailto:${s.email}`}>{s.email}</a>],
    ["Trade", s.trade],
    ["Address", addressLine({ ...s.address, line1: [s.address.line1, s.address.line2].filter(Boolean).join(", ") }) || null],
    ["Tax classification", taxClassificationLabel(s.tax_classification)],
  ];

  return (
    <>
      <BackLink to="/subs">Subcontractors</BackLink>
      <PageHeader
        title={s.name}
        actions={
          <>
            {s.active && <Button variant="primary" icon="send" onClick={() => setDialog("send")}>Send upload link</Button>}
            <Menu
              items={[
                { label: "Edit details", icon: "edit", onSelect: () => setDialog("edit") },
                { label: "Add a document", icon: "upload", onSelect: () => setDialog({ kinds: [] }) },
                { separator: true },
                {
                  label: "Turn off",
                  icon: "archive",
                  hidden: !s.active,
                  onSelect: async () => (await confirm({ title: `Turn off ${s.name}?`, body: "They leave the list, stop getting reminders and can't sign in. Their paperwork stays, and you can turn them back on any time.", confirmLabel: "Turn off" })) && setActive.mutate(false),
                },
                { label: "Turn back on", icon: "restore", hidden: s.active, onSelect: () => setActive.mutate(true) },
                {
                  label: "Delete",
                  icon: "trash",
                  danger: true,
                  onSelect: async () => {
                    const signIn = access.data && access.data.state !== "none" ? " Their sign-in is removed too, and they're signed out." : "";
                    const body = (docs.length ? "Their paperwork is deleted too. To keep it for your records, turn them off instead." : "This can't be undone.") + signIn;
                    if (await confirm({ title: `Delete ${s.name}?`, body, confirmLabel: "Delete", danger: true, typeToConfirm: docs.length ? "delete" : undefined })) remove.mutate();
                  },
                },
              ]}
            />
          </>
        }
      />
      <div className="page-meta">
        {!s.active ? <StatusPill label="Turned off" tone="muted" /> : attention ? <StatusPill label="Needs attention" tone="warning" /> : paperwork.data ? <StatusPill label="Paperwork OK" tone="good" /> : null}
        {s.trade && <span className="muted">{s.trade}</span>}
      </div>

      {!s.active && (
        <div className="callout">
          <Icon name="archive" size={18} />
          <div className="grow" style={{ fontWeight: 400 }}>Turned off. They're not on the list, don't get reminders and can't sign in.</div>
          <Button size="sm" loading={setActive.isPending} onClick={() => setActive.mutate(true)}>Turn back on</Button>
        </div>
      )}
      {warning && (
        <div className="callout callout-warning">
          <Icon name="alert" size={18} />
          <div className="grow" style={{ fontWeight: 400 }}>{warning}</div>
          <Button size="sm" onClick={() => setDialog("send")}>Ask for it</Button>
        </div>
      )}

      <div className="two-col">
        <div className="wide stack-lg">
          <section className="stack">
            <div className="section-head"><h2 className="section-title">Paperwork</h2></div>
            <div className="card">
              {paperwork.error && !paperwork.data && s.active && (
                <div className="card-row"><ErrorState compact title="Couldn't load their paperwork's status" error={paperwork.error} onRetry={() => paperwork.refetch()} /></div>
              )}
              {PAPERWORK_REQUIREMENTS.map((req) => {
                const status = statuses.find((p) => p.requirement === req.key)!;
                const mine = current.filter((d) => (req.kinds as readonly string[]).includes(d.kind));
                // The one that counts first.
                mine.sort((a, b) => (a.id === status.document_id ? -1 : b.id === status.document_id ? 1 : 0));
                const counting = mine.find((d) => d.id === status.document_id) ?? mine[0] ?? null;
                return (
                  <div key={req.key} className="card-row" style={{ alignItems: "flex-start", flexWrap: "wrap" }}>
                    <span className="grow stack-sm" style={{ minWidth: 220 }}>
                      <span className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                        <strong>{req.label}</strong>
                        {s.active && (paperwork.isPending ? <Skeleton width={80} height={20} radius={10} /> : paperwork.data ? <ChipFor row={status} /> : null)}
                      </span>
                      {documents.isPending ? (
                        <Skeleton width="60%" height={10} />
                      ) : mine.length === 0 ? (
                        <span className="muted small">Nothing on file yet.</span>
                      ) : (
                        mine.map((d) => <DocumentLine key={d.id} doc={d} today={today} menu={docMenu(d)} verifying={verify.isPending && verify.variables?.docId === d.id} onVerify={() => verify.mutate({ docId: d.id, on: true })} />)
                      )}
                    </span>
                    <Button size="sm" icon="upload" onClick={() => setDialog({ kinds: kindsFor(req.key), replacing: counting })}>{mine.length ? "Replace" : "Upload"}</Button>
                  </div>
                );
              })}
            </div>
          </section>

          <section className="stack">
            <div className="section-head">
              <h2 className="section-title">Other documents</h2>
              <Button size="sm" icon="plus" onClick={() => setDialog({ kinds: ["license", "other"] })}>Add</Button>
            </div>
            <div className="card">
              {documents.isPending ? (
                <div className="card-row"><Skeleton width="50%" /></div>
              ) : others.length === 0 ? (
                <EmptyState compact icon="file" title="No other documents">Licenses, signed agreements, anything else you keep for them.</EmptyState>
              ) : (
                others.map((d) => (
                  <div key={d.id} className="card-row" style={{ alignItems: "flex-start" }}>
                    <span className="grow stack-sm">
                      <strong>{documentTitle(d)}</strong>
                      <DocumentLine doc={d} today={today} menu={docMenu(d)} verifying={verify.isPending && verify.variables?.docId === d.id} onVerify={() => verify.mutate({ docId: d.id, on: true })} />
                    </span>
                  </div>
                ))
              )}
            </div>
          </section>

          <SubPayCard subId={s.id} name={s.name} />

          <RatesCard payee={{ subcontractor_id: s.id }} />

          {history.length > 0 && (
            <section className="stack">
              <div className="section-head">
                <h2 className="section-title">Replaced</h2>
                <span className="muted small">Kept for your records and audits</span>
              </div>
              <div className="card">
                {history.map((d) => (
                  <div key={d.id} className="card-row" style={{ alignItems: "flex-start" }}>
                    <span className="grow" style={{ minWidth: 0 }}>
                      <strong>{documentTitle(d)}</strong>
                      <span className="muted small" style={{ display: "block" }}>
                        {[
                          d.starts_on && `${formatDate(d.starts_on)} to ${d.expires_on ? formatDate(d.expires_on) : "no end date"}`,
                          !d.starts_on && d.expires_on && endsText(d.expires_on, today),
                          d.carrier,
                          d.uploaded_via !== "office" && `Sent by them ${formatDate(d.created_at)}`,
                          `Replaced ${formatDate(d.superseded_at)}`,
                        ].filter(Boolean).join(" · ")}
                      </span>
                    </span>
                    {d.url && <a className="btn btn-sm" href={d.url} target="_blank" rel="noreferrer"><Icon name="external" size={14} />Open</a>}
                    <Menu triggerClassName="btn btn-sm btn-ghost btn-icon" label={`${documentTitle(d)} actions`} items={[{ label: "Delete", icon: "trash", danger: true, onSelect: () => askDelete(d) }]} />
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>

        <aside className="narrow stack">
          <div className="card card-pad stack-sm">
            <div className="row-between">
              <strong>Details</strong>
              <Button size="sm" variant="ghost" icon="edit" onClick={() => setDialog("edit")}>Edit</Button>
            </div>
            {details.some(([, v]) => v) ? (
              <dl className="kv">
                {details.filter(([, v]) => v).map(([k, v]) => <div key={k} style={{ display: "contents" }}><dt>{k}</dt><dd>{v}</dd></div>)}
              </dl>
            ) : (
              <span className="muted small">Add their phone and email so you can send them their link.</span>
            )}
            {s.notes && <p className="pre-wrap small" style={{ margin: 0, padding: 10, background: "var(--note)", borderRadius: 8, border: "1px solid var(--note-border)" }}>{s.notes}</p>}
          </div>
          <SubAccessCard sub={s} />
        </aside>
      </div>

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
  return (
    <span className="stack-sm" style={{ gap: 4 }}>
      <span className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <Icon name={doc.content_type?.startsWith("image/") ? "image" : "file"} size={15} />
        {doc.url ? (
          <a href={doc.url} target="_blank" rel="noreferrer" style={{ overflowWrap: "anywhere" }}>{doc.file_name || subDocumentLabel(doc.kind)}</a>
        ) : (
          <span style={{ overflowWrap: "anywhere" }}>{doc.file_name || subDocumentLabel(doc.kind)}</span>
        )}
        {doc.size_bytes ? <span className="muted small">{fileSize(doc.size_bytes)}</span> : null}
        {doc.kind === "wc_exemption" && <span className="chip">Exemption</span>}
        <span className="grow" />
        <Menu triggerClassName="btn btn-sm btn-ghost btn-icon" label={`${documentTitle(doc)} actions`} items={menu} />
      </span>
      {(dates || policy) && <span className="muted small">{[dates, policy].filter(Boolean).join(" · ")}</span>}
      {!doc.verified_at ? (
        <span className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <span className="small" style={{ color: "var(--info)" }}>{sentBy ?? "Added"}. Check that it's the right document and the dates match.</span>
          <Button size="sm" icon="check" loading={verifying} onClick={onVerify}>Verify</Button>
        </span>
      ) : (
        sentBy && <span className="muted small">{sentBy}</span>
      )}
    </span>
  );
}
