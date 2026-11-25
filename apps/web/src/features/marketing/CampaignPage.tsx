/**
 * Write, target, preview, test and send an email campaign; after sending, what it brought in and
 * who got it (CampaignResults). An automated campaign's page is its results, with a link to where
 * it's set (Marketing → Campaigns).
 */
import { greetingName } from "@crewtavo/core/automations";
import { audienceKeys, hasTrackableLink, HUB_HOME_BUTTON, RECURRING_CHOICES, recurringChoice, type CampaignAudience } from "@crewtavo/core/campaigns";
import { businessCountry } from "@crewtavo/core/countries";
import { hasPostalAddress } from "@crewtavo/core/postcards";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useDeferredValue, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { featureOn } from "@/components/shell/nav";
import { Button, cx } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { DetailColumns, DetailHeader } from "@/components/ui/DetailPage";
import { Dialog } from "@/components/ui/Dialog";
import { Field, FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { Menu } from "@/components/ui/Menu";
import { SaveStatus, useSaveStatus } from "@/components/ui/SaveStatus";
import { BackLink } from "@/components/ui/PageHeader";
import { Section } from "@/components/ui/Section";
import { DetailSkeleton } from "@/components/ui/Skeleton";
import { NoAccess, PageError } from "@/components/ui/States";
import { EntityStatus, statusText } from "@/components/ui/StatusPill";
import { api, supabase, unwrap, unwrapOne } from "@/lib/api";
import { addDaysIso, formatDateTime, todayIn } from "@/lib/format";
import { can, hasRole, useSession } from "@/lib/session";
import { toast } from "@/lib/toast";
import { AudienceFields, labelOf, useAudienceChoices, VISIT_OPTIONS, type Choice } from "./AudienceFields";
import { CampaignRecipients, CampaignStats } from "./CampaignResults";
import { companyAddressLine, EmailPreview, MessageField, SubjectField, TestEmailDialog } from "./EmailEditor";
import { MarketingPage } from "./MarketingPage";
import { ConnectEmailHint } from "../settings/ConnectEmailHint";
import styles from "./Marketing.module.css";
import { NameInput } from "./NameInput";
import { SenderAddressNote } from "./SenderAddress";
import { UsingChatGptPlan } from "@/features/apps/UsingChatGptPlan";

interface Draft {
  name: string;
  subject: string;
  body: string;
  audience: CampaignAudience;
}

const TOKENS = [
  { token: "client.first_name", label: "First name" },
  { token: "client.name", label: "Full name" },
  { token: "company.name", label: "Your company" },
  { token: "company.phone", label: "Your phone" },
  { token: "link", label: "Client Hub link" },
];
const TEMPLATES = [
  { label: "Seasonal reminder", icon: "calendar" as const, subject: "Time to book your {{season}} service", body: "Hi {{client.first_name}},\n\nThe season is almost here and our schedule fills up quickly. Book online, reply to this email or call us to get on the calendar.\n\n{{link}}\n\nThanks,\n{{company.name}}\n{{company.phone}}" },
  { label: "We miss you", icon: "history" as const, subject: "It's been a while, {{client.first_name}}", body: "Hi {{client.first_name}},\n\nIt's been a while since we last worked together, and we'd love to help again. If anything around the property needs attention, you can ask for a visit online, or just reply and we'll put together a quote.\n\n{{link}}\n\nThanks,\n{{company.name}}" },
  { label: "Thank you", icon: "thumbsUp" as const, subject: "Thank you from {{company.name}}", body: "Hi {{client.first_name}},\n\nThank you for trusting us with your property this year. If you know anyone who could use our help, we'd be grateful for the introduction.\n\nThanks again,\n{{company.name}}" },
];

/** Who a sent campaign went to, in words: the audience it was sent with, its cities and services as the business writes them. */
export function audienceSummary(audience: CampaignAudience, choices?: { cities?: Choice[]; services?: Choice[] }): string {
  const a = audienceKeys(audience);
  const cities = (a.cities ?? []).map(labelOf(choices?.cities));
  const services = (a.services ?? []).map(labelOf(choices?.services));
  const statuses = a.statuses?.length ? a.statuses.map((s) => statusText("client", s)).join(", ") : "Every status";
  const parts = [
    statuses,
    a.tags_any?.length ? `tagged ${a.tags_any.join(", ")}` : null,
    a.tags_none?.length ? `not tagged ${a.tags_none.join(", ")}` : null,
    a.no_visit_days ? `no completed visit in ${VISIT_OPTIONS.find(([d]) => Number(d) === a.no_visit_days)?.[1] ?? `${a.no_visit_days} days`}` : null,
    cities.length ? `in ${cities.join(", ")}` : null,
    services.length ? `had ${services.join(", ")}` : null,
    recurringChoice(a) !== "any" ? RECURRING_CHOICES.find((c) => c.value === recurringChoice(a))!.label.toLowerCase() : null,
  ];
  return parts.filter(Boolean).join(" · ");
}

export function CampaignPage() {
  const session = useSession();
  if (!hasRole(session, "admin", "office") || !can(session, "marketing")) return <NoAccess title="Campaign" />;
  // Uninstalled, Marketing's pages say so, as Drive's do.
  if (!featureOn(session.company.settings, "marketing")) return <MarketingPage />;
  return <CampaignPageScreen />;
}

function CampaignPageScreen() {
  const { id = "" } = useParams();
  const session = useSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [dialog, setDialog] = useState<null | "send" | "ai" | "test">(null);

  const campaign = useQuery({
    queryKey: ["campaign", id],
    // Also for half a minute after it stops: an email that was going out then still finishes and is counted.
    refetchInterval: (q) => {
      const d = q.state.data as { status?: string; finished_at?: string | null } | undefined;
      const settling = d?.status === "cancelled" && d.finished_at && Date.now() - Date.parse(d.finished_at) < 30_000;
      return d?.status === "sending" || settling ? 3000 : false;
    },
    queryFn: async () =>
      unwrapOne(
        await supabase()
          .from("campaigns")
          .select("id, kind, template_key, name, subject, body, audience, status, scheduled_at, started_at, finished_at, recipients_count, sent_count, failed_count")
          .eq("id", id)
          .maybeSingle(),
        "This campaign",
      ),
  });
  const c = campaign.data;
  useEffect(() => {
    if (c && !draft && c.kind !== "automated") setDraft({ name: c.name, subject: c.subject, body: c.body, audience: (c.audience ?? {}) as CampaignAudience });
  }, [c, draft]);
  const editable = c?.status === "draft";
  const audience = useDeferredValue(draft?.audience);
  // Sending just finished, or an email counted after a stop: the numbers and the list are fetched
  // once more, so they end where the header does instead of stopping at the last look while it sent.
  const last = useRef({ status: c?.status, sent: c?.sent_count, failed: c?.failed_count });
  useEffect(() => {
    const was = last.current;
    last.current = { status: c?.status, sent: c?.sent_count, failed: c?.failed_count };
    const ended = was.status === "sending" && c?.status !== "sending";
    const late = was.status === "cancelled" && c?.status === "cancelled" && (was.sent !== c.sent_count || was.failed !== c.failed_count);
    if (ended || late) {
      for (const key of [["campaign-results", session.company.id, id], ["campaign-recipients", id], ["campaign-results", session.company.id]]) {
        void queryClient.invalidateQueries({ queryKey: key });
      }
    }
  }, [c?.status, c?.sent_count, c?.failed_count, id, queryClient, session.company.id]);

  const recipients = useQuery({
    queryKey: ["campaign-audience", session.company.id, JSON.stringify(audience)],
    enabled: Boolean(audience) && editable,
    meta: { silent: true },
    queryFn: async () => unwrap(await supabase().rpc("campaign_audience", { p_company_id: session.company.id, p_audience: audienceKeys(audience) as never })),
  });
  // A sent campaign's preview greets someone who got it, not a made-up name.
  const firstRecipient = useQuery({
    queryKey: ["campaign-first-recipient", id],
    enabled: Boolean(c) && c?.kind !== "automated" && !editable,
    meta: { silent: true },
    queryFn: async () => unwrap(await supabase().from("campaign_recipients").select("name").eq("campaign_id", id).order("id").limit(1))[0]?.name ?? null,
  });
  // A sent campaign's summary reads its cities and services with the business's own spelling too.
  const choices = useAudienceChoices(Boolean(c) && c?.kind !== "automated");

  // Autosave drafts a moment after typing stops, and say so beside the status.
  const saving = useSaveStatus();
  const save = useMutation({
    meta: { inline: true },
    mutationFn: async (d: Draft) => {
      unwrap(await supabase().from("campaigns").update({ name: d.name.trim() || "Untitled campaign", subject: d.subject, body: d.body, audience: audienceKeys(d.audience) as never }).eq("id", id));
      return d;
    },
    onSuccess: (d) => {
      // The page's own copy says what was saved too, so a draft built from it again (after Send) isn't the one from when the page opened.
      queryClient.setQueryData<typeof c>(["campaign", id], (old) => (old ? { ...old, name: d.name.trim() || "Untitled campaign", subject: d.subject, body: d.body, audience: audienceKeys(d.audience) as never } : old));
      void queryClient.invalidateQueries({ queryKey: ["campaigns", session.company.id] });
    },
  });
  const savedRef = useRef<string>("");
  useEffect(() => {
    if (!draft || !editable) return;
    const json = JSON.stringify(draft);
    if (!savedRef.current) {
      savedRef.current = json;
      return;
    }
    if (json === savedRef.current) return;
    saving.edited();
    const t = setTimeout(() => {
      savedRef.current = json;
      void saving.track(save.mutateAsync(draft));
    }, 700);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, editable]);

  const cancel = useMutation({
    meta: { success: (r: { status: string }) => (r.status === "draft" ? "Campaign unscheduled" : "Sending stopped") },
    mutationFn: () => api.post<{ status: string }>(`/campaigns/${id}/cancel`),
    onSuccess: () => {
      setDraft(null);
      savedRef.current = "";
      queryClient.invalidateQueries({ queryKey: ["campaign", id] });
      queryClient.invalidateQueries({ queryKey: ["campaigns", session.company.id] });
    },
  });
  const duplicate = useMutation({
    meta: { success: "Copied as a new draft" },
    mutationFn: async () => unwrap(await supabase().from("campaigns").insert({ company_id: session.company.id, name: `${c!.name} (copy)`.slice(0, 120), subject: c!.subject, body: c!.body, audience: c!.audience }).select("id").single()),
    onSuccess: (row) => {
      setDraft(null);
      savedRef.current = "";
      navigate(`/marketing/campaigns/${row.id}`);
    },
  });
  const remove = useMutation({
    meta: { success: "Campaign deleted" },
    mutationFn: async () => unwrap(await supabase().from("campaigns").delete().eq("id", id)),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["campaigns", session.company.id] });
      navigate("/marketing", { replace: true });
    },
  });

  if (c?.kind === "automated") return <AutomatedCampaignView id={c.id} name={c.name} />;
  if (campaign.isPending || (c && !draft)) return <DetailSkeleton />;
  if (campaign.error || !c || !draft) return <PageError error={campaign.error} onRetry={() => campaign.refetch()} back={<BackLink to="/marketing">Marketing</BackLink>} />;

  const set = (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d));
  // Once it's sent (or sending, or scheduled), what it says is the campaign's own, as saved.
  const shown: Draft = editable ? draft : { name: c.name, subject: c.subject, body: c.body, audience: (c.audience ?? {}) as CampaignAudience };
  const count = recipients.data?.length ?? 0;
  const sampleName = editable ? recipients.data?.[0]?.display_name : firstRecipient.data;
  const vars = {
    "client.first_name": sampleName ? greetingName(sampleName) : "Jordan",
    "client.name": sampleName ?? "Jordan Rivera",
    "company.name": session.company.name,
    // As the email has it: the phone as the business saved it (GET /me sends it).
    "company.phone": session.company.phone ?? "",
    link: window.location.origin,
  };
  // No marketing email goes without the company's postal address under it.
  const hasAddress = hasPostalAddress(session.company.address, businessCountry(session.company));
  const problems = [
    !draft.subject.trim() && "Add a subject line.",
    draft.body.trim().length < 10 && "Write the email.",
    editable && recipients.data && !count && "No one matches this audience.",
  ].filter(Boolean) as string[];

  const stopOrUnschedule = async () =>
    (await confirm({ title: c.status === "scheduled" ? "Unschedule this campaign?" : "Stop sending?", body: c.status === "sending" ? "Emails already sent can't be recalled." : "It goes back to being a draft.", confirmLabel: c.status === "scheduled" ? "Unschedule" : "Stop", danger: c.status === "sending" })) && cancel.mutate();

  return (
    <>
      <DetailHeader
        crumb={{ to: "/marketing", label: "Marketing" }}
        title={editable ? <h1 className="page-title"><NameInput value={draft.name} onChange={(name) => set({ name })} label="Campaign name" /></h1> : c.name}
        documentTitle={c.name}
        status={<EntityStatus kind="campaign" status={c.status} />}
        meta={[
          editable && <SaveStatus status={saving.status} />,
          c.status === "scheduled" && c.scheduled_at && `Sends ${formatDateTime(c.scheduled_at)}`,
          c.status !== "draft" && `${c.sent_count} of ${c.recipients_count} sent${c.failed_count ? ` · ${c.failed_count} failed` : ""}`,
        ]}
        actions={
          <>
            {editable && <Button icon="mail" onClick={() => setDialog("test")} disabled={!session.config.features.email || !hasAddress || problems.slice(0, 2).length > 0}>Send test</Button>}
            {editable && <Button variant="primary" icon="send" onClick={() => setDialog("send")} disabled={problems.length > 0 || !session.config.features.email || !hasAddress}>Send</Button>}
            {(c.status === "scheduled" || c.status === "sending") && <Button variant="danger" icon="x" loading={cancel.isPending} onClick={stopOrUnschedule}>{c.status === "scheduled" ? "Unschedule" : "Stop sending"}</Button>}
          </>
        }
        moreTitle={c.name}
        more={[
          { label: "Duplicate", icon: "copy", kbd: "D", onSelect: () => duplicate.mutate() },
          { separator: true, hidden: c.status === "sending" },
          { label: "Delete", icon: "trash", danger: true, hidden: c.status === "sending", onSelect: async () => (await confirm({ title: "Delete this campaign?", confirmLabel: "Delete", danger: true })) && remove.mutate() },
        ]}
      />
      {!session.config.features.email && editable && <div className="callout callout-info"><Icon name="info" size={16} /><div className="grow">Email isn't connected yet, so this can't be sent.<ConnectEmailHint /></div></div>}
      {editable && <SenderAddressNote what="this can't be sent or tested" />}
      {c.status === "sending" && <div className="progress"><span style={{ width: `${c.recipients_count ? (c.sent_count / c.recipients_count) * 100 : 0}%` }} /></div>}
      {/* Across the page, so the five numbers sit in one row. */}
      {!editable && <CampaignStats campaignId={c.id} live={c.status === "sending"} />}

      <DetailColumns
        grouped
        side={
          <>
            <Section title="Audience" count={editable ? (recipients.isFetching ? "…" : count.toLocaleString("en-US")) : undefined} flush={editable}>
              {editable ? (
                <div className="stack">
                  <AudienceFields audience={draft.audience} onChange={(audience) => set({ audience })} choices={choices.data} />
                  <div className="stack-sm">
                    <p className={styles.count}><b>{count.toLocaleString("en-US")}</b> {count === 1 ? "client" : "clients"} will get this.</p>
                    {Boolean(recipients.data?.length) && (
                      <ul className={styles.sample} aria-label="Who gets it">
                        {recipients.data!.slice(0, 5).map((r) => <li key={r.client_id}><span>{r.display_name}</span><span>{r.email}</span></li>)}
                      </ul>
                    )}
                    {count > 5 && <p className={styles.fine}>and {count - 5} more</p>}
                  </div>
                </div>
              ) : (
                <p className={styles.audienceLine}>{audienceSummary(shown.audience, choices.data)}</p>
              )}
            </Section>
            {editable && problems.length > 0 && (
              <div className="callout callout-warning" role="note">
                <Icon name="alert" size={16} />
                <ul className={`grow ${styles.problems}`}>{problems.map((p) => <li key={p}>{p}</li>)}</ul>
              </div>
            )}
          </>
        }
      >
        {editable ? (
          <Section
            title="Email"
            flush
            action={
              <>
                <UsingChatGptPlan />
                <Menu label="Start from a template" title="Templates" triggerClassName="btn btn-sm btn-ghost" trigger={<><Icon name="file" size={14} />Templates</>} items={TEMPLATES.map((t) => ({ label: t.label, icon: t.icon, onSelect: async () => { if (draft.body.trim().length > 20 && !(await confirm({ title: "Replace your email?", body: "The template replaces the subject and message.", confirmLabel: "Replace" }))) return; set({ subject: t.subject.replace("{{season}}", "spring"), body: t.body }); } }))} />
                {session.config.features.ai && <Button size="sm" variant="ghost" icon="sparkle" onClick={() => setDialog("ai")}>Write with AI</Button>}
              </>
            }
          >
            <div className={cx("stack", styles.editor)}>
              <SubjectField value={draft.subject} onChange={(subject) => set({ subject })} placeholder="Spring cleanup spots are filling up" />
              <MessageField
                value={draft.body}
                onChange={(body) => set({ body })}
                tokens={TOKENS}
                hint={`${hasAddress ? "Your address and an unsubscribe link are added at the bottom." : "An unsubscribe link is added at the bottom. Your address goes there too, once it's filled in."} Client Hub link is each client's own, where they can ask for work.`}
              />
              {!hasTrackableLink(draft.body) && <p className={styles.autoNote} data-tone="warning">Add a link so clicks and bookings can be counted.</p>}
              <FormError error={save.error} />
            </div>
          </Section>
        ) : (
          <CampaignRecipients campaignId={c.id} live={c.status === "sending"} />
        )}

        <Section title="Preview" flush>
          <EmailPreview companyName={session.company.name} address={companyAddressLine(session.company.address)} subject={shown.subject} body={shown.body} vars={vars} unsubscribe linkLabel={HUB_HOME_BUTTON} heading={false} />
        </Section>
      </DetailColumns>

      {dialog === "send" && (
        <SendCampaignDialog
          id={id}
          count={count}
          onClose={() => setDialog(null)}
          onDone={async () => {
            // Fresh from the server first, so nothing is drawn from an older copy meanwhile.
            await campaign.refetch();
            setDraft(null);
            savedRef.current = "";
          }}
        />
      )}
      {dialog === "test" && <TestEmailDialog path={`/campaigns/${id}/test`} defaultTo={session.profile.email ?? ""} onClose={() => setDialog(null)} />}
      {dialog === "ai" && <AiDialog onClose={() => setDialog(null)} onDraft={(d) => { set(d); setDialog(null); }} />}
    </>
  );
}

/** An automated campaign's page: what it brought in and who got it. It's set on Marketing → Campaigns. */
function AutomatedCampaignView({ id, name }: { id: string; name: string }) {
  return (
    <>
      <DetailHeader
        crumb={{ to: "/marketing", label: "Marketing" }}
        title={name}
        status={<EntityStatus kind="campaign" status="automated" />}
        meta={<span>Sends by itself. <Link to="/marketing?tab=campaigns">Edit on Marketing → Campaigns</Link></span>}
      />
      <CampaignStats campaignId={id} />
      <DetailColumns grouped>
        <CampaignRecipients campaignId={id} />
      </DetailColumns>
    </>
  );
}

function SendCampaignDialog({ id, count, onClose, onDone }: { id: string; count: number; onClose: () => void; onDone: () => void }) {
  const session = useSession();
  const [when, setWhen] = useState<"now" | "later">("now");
  // 9 AM today, or tomorrow once that's gone, so picking Schedule doesn't open on "Pick a time in the future".
  const [date, setDate] = useState(() => {
    const today = todayIn(session.company.timezone);
    return new Date(`${today}T09:00:00`).getTime() > Date.now() + 60_000 ? today : addDaysIso(today, 1);
  });
  const [time, setTime] = useState("09:00");
  const at = new Date(`${date}T${time}:00`);
  const past = when === "later" && at.getTime() < Date.now() + 60_000;
  const send = useMutation({
    meta: { inline: true, success: (r: { status: string; recipients: number }) => (r.status === "scheduled" ? `Scheduled for ${r.recipients} clients` : `Sending to ${r.recipients} clients`) },
    mutationFn: () => api.post<{ status: string; recipients: number }>(`/campaigns/${id}/send`, when === "later" ? { scheduled_at: at.toISOString() } : {}),
    onSuccess: () => {
      onDone();
      onClose();
    },
  });
  return (
    <Dialog open onClose={onClose} title="Send campaign" description={`To ${count} ${count === 1 ? "client" : "clients"}.`} size="sm">
      <form onSubmit={(e) => { e.preventDefault(); if (!past) send.mutate(); }}>
        <div className={cx("segmented", styles.segStart)} role="group" aria-label="When">
          <button type="button" aria-pressed={when === "now"} onClick={() => setWhen("now")}>Send now</button>
          <button type="button" aria-pressed={when === "later"} onClick={() => setWhen("later")}>Schedule</button>
        </div>
        {when === "later" && (
          <div className="form-grid">
            <Field label="Date"><input className="input" type="date" value={date} min={todayIn(session.company.timezone)} onChange={(e) => setDate(e.target.value)} required /></Field>
            <Field label="Time"><input className="input" type="time" value={time} onChange={(e) => setTime(e.target.value)} required /></Field>
          </div>
        )}
        {past && <p className="error-text">Pick a time in the future.</p>}
        <FormError error={send.error} />
        <div className="form-actions">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" icon={when === "now" ? "send" : "calendar"} loading={send.isPending} disabled={past || !count}>{when === "now" ? `Send to ${count}` : "Schedule"}</Button>
        </div>
      </form>
    </Dialog>
  );
}

function AiDialog({ onClose, onDraft }: { onClose: () => void; onDraft: (d: { subject: string; body: string }) => void }) {
  const [goal, setGoal] = useState("");
  const [tone, setTone] = useState<"friendly" | "professional" | "urgent">("friendly");
  const draft = useMutation({
    meta: { inline: true },
    mutationFn: () => api.post<{ subject: string; body: string }>("/campaigns/draft", { goal: goal.trim(), tone }),
    onSuccess: (d) => {
      toast.success("Draft ready", { description: "Read it over before sending." });
      onDraft(d);
    },
  });
  return (
    <Dialog open onClose={onClose} title="Write with AI">
      <form onSubmit={(e) => { e.preventDefault(); draft.mutate(); }}>
        <Field label="What's this email for?"><textarea className="textarea" value={goal} onChange={(e) => setGoal(e.target.value)} maxLength={600} required minLength={5} placeholder="Remind past sealcoating clients to book before June, 10% off if they book this month" /></Field>
        <div className={cx("segmented", styles.segStart)} role="group" aria-label="Tone">
          {(["friendly", "professional", "urgent"] as const).map((t) => <button key={t} type="button" aria-pressed={tone === t} onClick={() => setTone(t)}>{t[0].toUpperCase() + t.slice(1)}</button>)}
        </div>
        <FormError error={draft.error} />
        <div className="form-actions">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" icon="sparkle" loading={draft.isPending}>Write draft</Button>
        </div>
      </form>
    </Dialog>
  );
}
