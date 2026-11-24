/**
 * Marketing → Referrals, Jobber's way: what referrals brought in and the credits they earned; when
 * clients are asked for referrals automatically (the referral_after_job starter rule's switch, PUT
 * /api/referrals/asks); the credit for each friend who becomes a client, the line shown to friends
 * and the referral email; asking a client now; the top referrers; and every referral with its credit.
 *
 * A credit is earned when the friend pays their first invoice, and goes on the referrer's next
 * invoice by itself (supabase/migrations/20261031000100_referral_credits.sql). From a referral's
 * menu the office can put it on an invoice they choose, keep it off invoices, mark it given outside
 * Crewtavo, or say no credit (and overrule a "they referred themselves" or "already a client").
 */
import {
  creditLine,
  creditMoney,
  isReferralRule,
  referralAskRefusal,
  REFERRAL_EMAIL_NOT_CONNECTED,
  REFERRAL_GAP_DAYS,
  referralPill,
  referralRuleTiming,
  referralsReady,
  REFERRALS_NOT_SET_UP,
  type CreditPart,
} from "@crewtavo/core/marketing";
import { keepPreviousData, useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Button, useJustDone } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { DecimalInput } from "@/components/ui/DecimalInput";
import { DetailColumns } from "@/components/ui/DetailPage";
import { Dialog } from "@/components/ui/Dialog";
import { Field, FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { ListFoot, RowPerson } from "@/components/ui/InboxList";
import { Menu, type MenuEntry } from "@/components/ui/Menu";
import { RelatedList, RelatedRow, Section } from "@/components/ui/Section";
import { SectionSkeleton, StatsSkeleton } from "@/components/ui/Skeleton";
import { Stat, StatStrip } from "@/components/ui/StatStrip";
import { EmptyState, ErrorState } from "@/components/ui/States";
import { EntityStatus, statusText } from "@/components/ui/StatusPill";
import { api, supabase, unwrap } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { currencySymbol, formatDate, formatMoneyCents, timeAgo } from "@/lib/format";
import { can, hasRole, useSession } from "@/lib/session";
import { toast } from "@/lib/toast";
import { undoable } from "@/lib/undo";
import { ClientPicker, type PickedClient } from "../clients/ClientForm";
import { BOOKS, creditRoom, takesCredit } from "../invoices/creditRules";
import { ConnectEmailHint } from "../settings/ConnectEmailHint";
import styles from "./Marketing.module.css";
import { messageError, referralForm, referralPatch, rewardChanged, rewardError, type ReferralForm } from "./referralForm";
import { useSettingsSaver } from "./useSettingsSaver";

interface Stats {
  leads: number;
  won: number;
  revenue: number | null;
  credits: { pending: number; pending_count: number; pending_percent: number; earned: number; applied: number; given: number };
  top_referrers: Array<{ client_id: string; name: string; referrals: number; won: number; revenue: number | null }>;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
/** "Maria" from "Maria Lopez". */
const firstWord = (name: string) => name.trim().split(/\s+/)[0] ?? "";

/** Every place on the tab that changes when a referral or its credit does. */
function useRefresh() {
  const session = useSession();
  const queryClient = useQueryClient();
  return () => {
    for (const key of ["referrals", "referral-stats", "marketing-summary", "referral-asks"]) queryClient.invalidateQueries({ queryKey: [key, session.company.id] });
  };
}

export function Referrals() {
  const session = useSession();
  const stats = useQuery({
    queryKey: ["referral-stats", session.company.id],
    queryFn: async () => unwrap(await supabase().rpc("referral_stats", { p_company: session.company.id })) as unknown as Stats,
  });

  // The list runs the full width under the rest, so on a phone Ask for referrals comes before a long
  // list. Each part is a section on a hairline; a phone shows them as inset cards on the grey ground.
  return (
    <>
      <Numbers stats={stats} />
      <DetailColumns
        grouped
        side={
          <>
            <AskNow />
            <RecentAsks />
            <TopReferrers stats={stats} />
          </>
        }
      >
        <AskAutomatically />
        <CreditAndOffer />
      </DetailColumns>
      <DetailColumns grouped>
        <ReferralList />
      </DetailColumns>
    </>
  );
}

/** Under credits earned, as Marketing's overview has it: that figure is credit not on an invoice yet. */
export const EARNED_HINT = "Not on an invoice yet";

function Numbers({ stats }: { stats: UseQueryResult<Stats> }) {
  if (stats.isPending) return <StatsSkeleton count={4} />;
  if (stats.error || !stats.data) return <ErrorState compact error={stats.error} onRetry={() => stats.refetch()} />;
  const { revenue, credits } = stats.data;
  // A percent credit isn't a figure until the friend pays, so then it's how many are waiting.
  const waiting = credits.pending_count === 1 ? "1 friend hasn't" : `${credits.pending_count.toLocaleString()} friends haven't`;
  const pending = !credits.pending_count
    ? "No friends waiting to pay"
    : credits.pending_percent
      ? `${waiting} paid yet`
      : `${formatMoneyCents(credits.pending)} pending: ${waiting} paid yet`;
  return (
    <StatStrip label="Referrals">
      {revenue !== null && <Stat label="Revenue from referrals" value={formatMoneyCents(revenue)} note="What referred clients have paid, before tax" />}
      {/* Only what's not on an invoice yet, as Marketing's overview says it; friends still to pay are their own line. */}
      <Stat
        label={`Credits ${statusText("credit", "earned").toLowerCase()}`}
        value={formatMoneyCents(credits.earned)}
        note={<>{EARNED_HINT}<span className={styles.noteLine}>{pending}</span></>}
      />
      <Stat label={`Credits ${statusText("credit", "applied").toLowerCase()}`} value={formatMoneyCents(credits.applied)} note="On clients' invoices" />
      <Stat label={`Credits ${statusText("credit", "issued").toLowerCase()}`} value={formatMoneyCents(credits.given)} note="Outside Crewtavo" />
    </StatStrip>
  );
}

interface RuleRow {
  id: string;
  name: string;
  enabled: boolean;
  trigger: string;
  delay_minutes: number;
  conditions: unknown;
  actions: unknown;
}

/** The starter rule's switch. A rule changed in Automations keeps its shape; only the switch turns it on and off here. */
function AskAutomatically() {
  const session = useSession();
  const queryClient = useQueryClient();
  const allowed = can(session, "automations");
  const rule = useQuery({
    queryKey: ["automation-rules", session.company.id, "referral"],
    enabled: allowed,
    queryFn: async () =>
      unwrap(
        await supabase()
          .from("automation_rules")
          .select("id, name, enabled, trigger, delay_minutes, conditions, actions")
          .eq("company_id", session.company.id)
          .eq("template_key", "referral_after_job")
          .maybeSingle(),
      ) as RuleRow | null,
  });
  const ready = referralsReady(session.company.settings);
  const emailReady = session.config.features.email;
  const canSave = hasRole(session, "admin") && allowed;
  const save = useMutation({
    meta: { inline: true, success: (r: { enabled: boolean }) => (r.enabled ? "Referral asks turned on" : "Referral asks turned off") },
    mutationFn: (enabled: boolean) => api.put<{ kept: Array<{ id: string; name: string }>; rule_id: string }>("/referrals/asks", { enabled }).then((r) => ({ ...r, enabled })),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["automation-rules", session.company.id] }),
  });

  if (!allowed) {
    return (
      <Section title="Ask automatically">
        <p className={styles.fine}>Owners and admins with the Automations area choose when clients are asked for referrals.</p>
      </Section>
    );
  }
  if (rule.isPending) return <Section title="Ask automatically"><SectionSkeleton rows={2} /></Section>;
  if (rule.error) return <Section title="Ask automatically"><ErrorState compact error={rule.error} onRetry={() => rule.refetch()} /></Section>;
  const r = rule.data;
  const on = save.isPending ? save.variables : Boolean(r?.enabled);
  const custom = r && !isReferralRule(r);

  return (
    <Section
      title="Ask automatically"
      action={
        <label className={`switch-row ${styles.switchLabel}`}>
          <input type="checkbox" className="switch" aria-label="Ask for referrals automatically" checked={on} disabled={!canSave || save.isPending || (!on && (!ready || !emailReady))}
            onChange={(e) => save.mutate(e.target.checked)} />
          {on ? "On" : "Off"}
        </label>
      }
    >
      <div className="stack-sm">
        {!ready && (
          <div className="callout callout-warning"><Icon name="alert" size={16} /><div className="grow">{REFERRALS_NOT_SET_UP} Until then there's nothing to tell them.</div></div>
        )}
        {!emailReady && (
          <div className="callout callout-warning">
            <Icon name="alert" size={16} />
            <div className="grow">
              {on ? "Email isn't connected, so referral asks won't go out until it is." : "Email isn't connected yet, so referral asks can't go out."}
              <ConnectEmailHint then={on ? "to send them" : "to turn them on"} />
            </div>
          </div>
        )}
        {custom && (
          <div className="callout callout-info">
            <Icon name="info" size={16} />
            <div className="grow">You changed “{r.name}” in Automations, so only the switch above turns it on and off here. <Link to={`/automations/${r.id}`}>Open the rule</Link></div>
          </div>
        )}
        <p className={styles.autoLine}>
          {r ? referralRuleTiming(r) : "Goes out a week after a job is completed."} By email, at most once every 6 months per client.
        </p>
        <p className={styles.fine}>
          Recurring clients aren't asked automatically. Ask them with Ask for referrals.
          {r && <> Change it in Automations: <Link to={`/automations/${r.id}`}>{r.name}</Link>.</>}
        </p>
        {canSave && !r && <p className={styles.fine}>Turning it on puts the rule back in Automations.</p>}
        {!canSave && <p className={styles.fine}>Only owners and admins can change this.</p>}
        <FormError error={save.error} />
      </div>
    </Section>
  );
}

function CreditAndOffer() {
  const session = useSession();
  const settings = session.company.settings;
  const canSave = hasRole(session, "admin");
  const [form, setForm] = useState<ReferralForm>(() => referralForm(settings));
  const set = (patch: Partial<ReferralForm>) => setForm((f) => ({ ...f, ...patch }));
  const save = useSettingsSaver();
  const saved = useJustDone(save);
  const valueError = rewardError(form);
  const emailError = messageError(form);
  const percent = form.kind === "percent";

  return (
    <Section title="Credit, offer and email" flush>
      <form
        className="stack"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          if (valueError || emailError) return;
          // settings.referrals has more than this form: what's there now is kept.
          save.mutate((current) => referralPatch(form, current));
        }}
      >
        <Field
          label="Credit for each friend who becomes a client"
          error={valueError}
          hint={percent
            ? "A percentage of the friend's first job, after discounts and before tax. It goes on the client's next invoice once their friend pays their first one."
            : "Goes on the client's next invoice once their friend pays their first one."}
        >
          <div className="row wrap" style={{ gap: 8 }}>
            <div className="segmented" role="group" aria-label="Kind of credit">
              <button type="button" aria-pressed={!percent} disabled={!canSave} onClick={() => set({ kind: "amount" })}>{currencySymbol()} amount</button>
              <button type="button" aria-pressed={percent} disabled={!canSave} onClick={() => set({ kind: "percent" })}>% of their first job</button>
            </div>
            <span className="input-group" style={{ width: 130 }}>
              {!percent && <span className="addon">{currencySymbol()}</span>}
              <DecimalInput className="input" inputMode="decimal" aria-label={percent ? "Percent" : "Amount"} value={form.value} disabled={!canSave}
                placeholder={percent ? "10" : "50"} onChange={(e) => set({ value: e.target.value.replace(/[^0-9.]/g, "") })} />
              {percent && <span className="addon addon-right">%</span>}
            </span>
          </div>
        </Field>
        <Field label="Offer shown to friends" optional hint="Written to the friend, like “10% off your first service”. It's on their referral page, and quoted in the Client Hub and the referral email.">
          <input className="input" value={form.offer} maxLength={200} onChange={(e) => set({ offer: e.target.value })} disabled={!canSave} placeholder="10% off your first service" />
        </Field>
        <Field label="Referral email" error={emailError} hint="{{link}} is the client's own link. {{rewards}} says what they and their friend get.">
          <textarea className="textarea" style={{ minHeight: 130 }} value={form.message} maxLength={2000} onChange={(e) => set({ message: e.target.value })} disabled={!canSave} />
        </Field>
        <FormError error={save.error} />
        <div className="form-actions" style={{ justifyContent: "flex-start", alignItems: "center" }}>
          {canSave ? (
            <>
              <Button type="submit" loading={save.isPending} done={saved} disabled={Boolean(valueError || emailError)}>Save</Button>
              {rewardChanged(form, settings) && <span className="muted small">Friends already referred keep the credit they were offered.</span>}
            </>
          ) : (
            <span className="muted small">Only owners and admins can change these.</span>
          )}
        </div>
      </form>
    </Section>
  );
}

/** Asking a client by hand: right away, however lately they were asked, unless they opted out of marketing or are archived. */
function AskNow() {
  const session = useSession();
  const refresh = useRefresh();
  const queryClient = useQueryClient();
  const emailReady = session.config.features.email;
  const ready = referralsReady(session.company.settings);
  const [client, setClient] = useState<PickedClient>(null);
  const picked = useQuery({
    queryKey: ["referral-ask", client?.id],
    enabled: Boolean(client),
    queryFn: async () => {
      const [who, last] = await Promise.all([
        supabase().from("clients").select("display_name, email, status, marketing_opt_out").eq("id", client!.id).maybeSingle(),
        supabase().rpc("last_referral_ask", { p_company: session.company.id, p_client: client!.id }),
      ]);
      return { client: unwrap(who), last: unwrap(last) ?? null };
    },
  });
  const ask = useMutation({
    mutationFn: () => api.post<{ sent: boolean; detail: string }>("/referrals/request", { client_id: client!.id }),
    onSuccess: (r) => {
      toast.success(r.detail);
      setClient(null);
    },
    // An ask that failed is listed too, saying why.
    onSettled: () => {
      refresh();
      queryClient.invalidateQueries({ queryKey: ["referral-ask"] });
    },
  });
  const link = useMutation({
    mutationFn: () => api.get<{ link: string }>(`/referrals/link/${client!.id}`),
    onSuccess: (r) => copyText(r.link, `Referral link for ${client!.display_name} copied`),
  });

  const who = picked.data?.client;
  const refusal = who ? referralAskRefusal(who, emailReady) : null;
  const last = picked.data?.last;
  const waitsUntil = last ? new Date(Date.parse(last) + REFERRAL_GAP_DAYS * 86_400_000) : null;

  return (
    <Section title="Ask for referrals" flush>
      <form className="stack-sm" onSubmit={(e: FormEvent) => { e.preventDefault(); if (client && !refusal && ready) ask.mutate(); }}>
        <ClientPicker value={client} onChange={setClient} allowCreate={false} />
        {client && picked.data && (
          <p className={styles.fine}>
            {last ? `Last asked ${timeAgo(last)}` : "Not asked yet"}
            {waitsUntil && waitsUntil > new Date() ? `, so automatic asks wait until ${formatDate(waitsUntil)}.` : "."}
          </p>
        )}
        {!ready && <p className={styles.autoNote} data-tone="warning">{REFERRALS_NOT_SET_UP}</p>}
        {refusal && <p className={styles.autoNote} data-tone="warning">{refusal}</p>}
        {!emailReady && refusal !== REFERRAL_EMAIL_NOT_CONNECTED && <p className={styles.fine}>Email isn't connected yet.<ConnectEmailHint /></p>}
        <div className="row wrap" style={{ gap: 8 }}>
          <Button type="submit" variant="primary" icon="mail" loading={ask.isPending} disabled={!client || !ready || Boolean(refusal)}>Email their link</Button>
          <Button icon="copy" loading={link.isPending} disabled={!client} onClick={() => link.mutate()}>Copy link</Button>
        </div>
      </form>
    </Section>
  );
}

/** The last few asks, by hand or automatic, each with how it went. Nothing shows until there's one. */
function RecentAsks() {
  const session = useSession();
  const asks = useQuery({
    queryKey: ["referral-asks", session.company.id],
    queryFn: async () =>
      unwrap(
        await supabase()
          .from("referral_asks")
          .select("id, automatic, status, error, sent_at, client:clients(id, display_name)")
          .eq("company_id", session.company.id)
          .order("sent_at", { ascending: false })
          .limit(5),
      ),
  });
  if (!asks.data?.length) return null;
  return (
    <Section title="Recent asks">
      <RelatedList label="Recent asks">
        {asks.data.map((a) => {
          const c = a.client as { id: string; display_name: string } | null;
          return (
            <RelatedRow
              key={a.id}
              to={c ? `/clients/${c.id}` : undefined}
              title={c?.display_name ?? "Client"}
              sub={[timeAgo(a.sent_at), a.automatic && "automatic", a.status === "failed" && <span className={styles.failed}>Failed{a.error ? `: ${a.error}` : ""}</span>]}
            />
          );
        })}
      </RelatedList>
    </Section>
  );
}

function TopReferrers({ stats }: { stats: UseQueryResult<Stats> }) {
  const top = stats.data?.top_referrers;
  return (
    <Section title="Top referrers">
      {stats.isPending && <SectionSkeleton rows={2} />}
      {stats.error && <ErrorState compact error={stats.error} onRetry={() => stats.refetch()} />}
      {top?.length === 0 && <EmptyState inline title="Nobody has referred a friend yet" />}
      {Boolean(top?.length) && (
        <RelatedList label="Top referrers">
          {top!.map((t) => (
            <RelatedRow
              key={t.client_id}
              to={`/clients/${t.client_id}`}
              lead={<RowPerson name={t.name} />}
              title={t.name}
              sub={[plural(t.referrals, "referral"), `${t.won.toLocaleString()} won`]}
              end={t.revenue === null ? null : <b>{formatMoneyCents(t.revenue)}</b>}
            />
          ))}
        </RelatedList>
      )}
    </Section>
  );
}

interface Referral {
  id: string;
  referred_name: string;
  status: string;
  reward_kind: string;
  reward_value: number;
  reward_amount: number;
  given_amount: number;
  reward_status: string;
  no_reward_reason: string | null;
  auto_apply: boolean;
  created_at: string;
  referrer: { id: string; display_name: string } | null;
  referred: { id: string; display_name: string } | null;
  credits: Array<{ id: string; amount: number; invoice: { id: string; number: number | null; status: string } | null }>;
}

/** A page of the list, and how many referrals there are in all. */
type ReferralPage = { rows: Referral[]; total: number };

const SHOWN = 10;
const PAGE = 50;

/** What's left of a referral's credit to put on invoices: what was earned, less what was given and what's on invoices. */
function creditLeft(r: Referral) {
  const applied = r.credits.reduce((sum, c) => sum + Number(c.amount), 0);
  return Math.round((Number(r.reward_amount) - Number(r.given_amount) - applied) * 100) / 100;
}

/** A referral's menu, or a space as wide as its button when there's nothing in it, so the pills line up. */
function RowMenu({ items, title }: { items: MenuEntry[]; title: string }) {
  if (!items.some((i) => !i.hidden && "onSelect" in i)) return <span aria-hidden="true" className={styles.menuSpace} />;
  return <Menu triggerClassName="btn btn-sm btn-ghost btn-icon" label="Referral actions" title={title} items={items} />;
}

/** creditLine, with the invoices it names linked. */
function CreditWords({ parts }: { parts: CreditPart[] }) {
  return <>{parts.map((p, i) => (typeof p === "string" ? <span key={i}>{p}</span> : <Link key={i} to={`/invoices/${p.invoice.id}`}>#{p.invoice.number}</Link>))}</>;
}

function ReferralList() {
  const session = useSession();
  const queryClient = useQueryClient();
  const refresh = useRefresh();
  const [limit, setLimit] = useState(SHOWN);
  // The dialog keeps its referral while it animates out.
  const [applying, setApplying] = useState<Referral | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const invoices = can(session, "invoices");
  const key = ["referrals", session.company.id, limit];
  const referrals = useQuery({
    queryKey: key,
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const { data, error, count } = await supabase()
        .from("referrals")
        .select(
          "id, referred_name, status, reward_kind, reward_value, reward_amount, given_amount, reward_status, no_reward_reason, auto_apply, created_at, referrer:clients!referrals_company_id_referrer_client_id_fkey(id, display_name), referred:clients!referrals_company_id_referred_client_id_fkey(id, display_name), credits:referral_credits(id, amount, invoice:invoices(id, number, status))",
          { count: "exact" },
        )
        .eq("company_id", session.company.id)
        .order("created_at", { ascending: false })
        .order("id")
        .limit(limit);
      return { rows: unwrap({ data, error }) as unknown as Referral[], total: count ?? 0 };
    },
  });
  const call = useMutation({
    meta: { success: (_: unknown, v: { fn: string }) => ({ referral_no_reward: "No credit for this one" })[v.fn] ?? null },
    mutationFn: async (v: { fn: "referral_no_reward" | "referral_give_credit" | "referral_auto_apply" | "referral_set_given"; id: string; on?: boolean; friend?: string; referrer?: string }) =>
      v.fn === "referral_auto_apply"
        ? unwrap(await supabase().rpc("referral_auto_apply", { p_referral: v.id, p_on: v.on ?? true }))
        : unwrap(await supabase().rpc(v.fn, { p_referral: v.id })),
    onSuccess: (result, v) => {
      if (v.fn === "referral_auto_apply") toast.success(v.on === false ? "Kept off invoices" : Number(result) > 0 ? `${creditMoney(Number(result), session.company.currency)} went on an invoice` : "It goes on their next invoice");
      // Nothing is given yet: the credit is earned once the friend pays, or now if they have.
      if (v.fn === "referral_give_credit") {
        const status = String(result);
        toast.success(status === "pending" ? `${v.referrer} gets the credit when ${v.friend} pays.` : status === "applied" ? `${v.friend} has paid, so the credit went on ${v.referrer}'s invoice.` : `${v.friend} has paid, so ${v.referrer} has earned the credit.`);
      }
    },
    onSettled: refresh,
  });

  // Marked given at once, with Undo; saved once the toast leaves. What's given is what isn't on invoices.
  const given = (r: Referral): Referral => {
    if (r.reward_status === "pending") return { ...r, reward_status: "issued", reward_amount: r.reward_value, given_amount: r.reward_value };
    const applied = r.credits.reduce((sum, c) => sum + Number(c.amount), 0);
    return { ...r, reward_status: "issued", given_amount: Math.round((Number(r.reward_amount) - applied) * 100) / 100 };
  };
  const markGiven = (r: Referral) =>
    undoable({
      title: "Credit marked as given",
      hide: () => {
        void queryClient.cancelQueries({ queryKey: key });
        queryClient.setQueryData<ReferralPage>(key, (old) => old && { ...old, rows: old.rows.map((x) => (x.id === r.id ? given(r) : x)) });
      },
      restore: () => queryClient.setQueryData<ReferralPage>(key, (old) => old && { ...old, rows: old.rows.map((x) => (x.id === r.id ? r : x)) }),
      commit: () => call.mutateAsync({ fn: "referral_set_given", id: r.id }),
    });
  const noCredit = async (r: Referral) => {
    if (await confirm({ title: "No credit for this referral?", body: `${r.referrer?.display_name ?? "The client"} won't get a credit for referring ${r.referred_name}.`, confirmLabel: "No credit", danger: true })) {
      call.mutate({ fn: "referral_no_reward", id: r.id });
    }
  };
  const giveAnyway = async (r: Referral) => {
    if (await confirm({ title: "Give a credit anyway?", body: `${r.referrer?.display_name ?? "The client"} gets the credit they were offered once ${r.referred_name} pays their first invoice, or now if they already have.`, confirmLabel: "Give a credit" })) {
      call.mutate({ fn: "referral_give_credit", id: r.id, friend: firstWord(r.referred_name), referrer: firstWord(r.referrer?.display_name ?? "") || "The client" });
    }
  };

  const rows = referrals.data?.rows ?? [];
  const total = referrals.data?.total ?? 0;
  return (
    <Section title="Referrals" count={total || undefined}>
      {referrals.isPending && <SectionSkeleton rows={2} />}
      {referrals.error && <ErrorState compact error={referrals.error} onRetry={() => referrals.refetch()} />}
      {referrals.data?.rows.length === 0 && <EmptyState inline title="No referrals yet">Share a client's link, or ask for referrals with Ask for referrals.</EmptyState>}
      {rows.length > 0 && (
        <RelatedList label="Referrals">
          {rows.map((r) => {
            const left = creditLeft(r);
            const earned = r.reward_status === "earned";
            const pill = referralPill(r);
            const friend = r.referred?.display_name ?? r.referred_name;
            return (
              <RelatedRow
                key={r.id}
                title={r.referred ? <Link to={`/clients/${r.referred.id}`} className={styles.plainLink}>{friend}</Link> : friend}
                detail={<>referred by {r.referrer ? <Link to={`/clients/${r.referrer.id}`} className={styles.plainLink}>{r.referrer.display_name}</Link> : "a client"}</>}
                sub={[timeAgo(r.created_at), <span key="credit"><CreditWords parts={creditLine(r, r.credits, session.company.currency)} /></span>]}
                end={<EntityStatus kind={pill.kind} status={pill.status} />}
                actions={
                  <RowMenu
                    title={friend}
                    items={[
                      { label: "Apply to an invoice…", icon: "invoice", hidden: !invoices || !earned || left <= 0, onSelect: () => { setApplying(r); setDialogOpen(true); } },
                      { label: "Apply automatically again", icon: "refresh", hidden: !invoices || !earned || r.auto_apply, onSelect: () => call.mutate({ fn: "referral_auto_apply", id: r.id, on: true }) },
                      { label: "Keep off invoices", icon: "pause", hidden: !invoices || !earned || !r.auto_apply, onSelect: () => call.mutate({ fn: "referral_auto_apply", id: r.id, on: false }) },
                      { label: "Mark given", icon: "gift", hidden: !(earned || (r.reward_status === "pending" && r.reward_kind === "amount" && Number(r.reward_value) > 0)), onSelect: () => markGiven(r) },
                      {
                        label: "Give a credit anyway", icon: "gift",
                        hidden: !(r.reward_status === "none" && ["self", "already_client", "by_hand"].includes(r.no_reward_reason ?? "") && Number(r.reward_value) > 0 && r.referrer?.id !== r.referred?.id),
                        onSelect: () => giveAnyway(r),
                      },
                      { separator: true },
                      { label: "No credit for this one", icon: "x", danger: true, hidden: !(r.reward_status === "pending" || (earned && !r.credits.length && !Number(r.given_amount))), onSelect: () => noCredit(r) },
                    ]}
                  />
                }
              />
            );
          })}
        </RelatedList>
      )}
      {total > SHOWN && (
        <ListFoot more={rows.length < total ? { onClick: () => setLimit((l) => (l < PAGE ? PAGE : l + PAGE)), loading: referrals.isFetching } : { onClick: () => setLimit(SHOWN), label: "Show less" }}>
          Showing {rows.length.toLocaleString()} of {total.toLocaleString()}
        </ListFoot>
      )}
      <ApplyDialog referral={applying} open={dialogOpen} onClose={() => setDialogOpen(false)} onExited={() => setApplying(null)} onApplied={refresh} />
    </Section>
  );
}

/** The referrer's open invoices, to put what's left of the credit on one. */
function ApplyDialog({ referral: r, open: isOpen, onClose, onExited, onApplied }: { referral: Referral | null; open: boolean; onClose: () => void; onExited: () => void; onApplied: () => void }) {
  const session = useSession();
  const referrerId = r?.referrer?.id;
  const open = useQuery({
    queryKey: ["referral-invoices", referrerId],
    enabled: isOpen && Boolean(referrerId),
    queryFn: async () => {
      const rows = unwrap(
        await supabase()
          .from("invoices")
          .select("id, number, status, kind, subtotal, discount_amount, credit_amount, total, balance_due, payments(id), stripe:stripe_invoices(origin, status)")
          .eq("company_id", session.company.id)
          .eq("client_id", referrerId!)
          .in("status", ["draft", "sent", "overdue"])
          .order("issued_on"),
      );
      const ids = rows.map((i) => i.id);
      const books = ids.length
        ? unwrap(await supabase().from("sync_links").select("local_id, provider").eq("entity", "invoice").in("provider", Object.keys(BOOKS)).in("local_id", ids))
        : [];
      // Only invoices with room left after their discounts and credits: one they already cover can't take more.
      return rows.filter((i) => takesCredit(i) && creditRoom(i) > 0).map((i) => ({ ...i, books: books.find((b) => b.local_id === i.id)?.provider ?? null }));
    },
  });
  const apply = useMutation({
    meta: { success: (put: number) => `${creditMoney(put, session.company.currency)} referral credit applied` },
    mutationFn: async (invoice: string) => Number(unwrap(await supabase().rpc("apply_referral_credit", { p_referral: r!.id, p_invoice: invoice }))),
    onSuccess: () => {
      onApplied();
      onClose();
    },
  });
  const first = r?.referrer?.display_name.split(/\s+/)[0] ?? "They";
  const left = r ? creditLeft(r) : 0;
  return (
    <Dialog open={isOpen} onClose={onClose} onExited={onExited} title="Apply the referral credit" description={r ? `For referring ${r.referred_name}.` : undefined}>
      {open.isPending ? (
        <SectionSkeleton rows={2} />
      ) : open.error ? (
        <ErrorState compact error={open.error} onRetry={() => open.refetch()} />
      ) : !open.data?.length ? (
        <EmptyState inline title={`${first} has no open invoice with room for a credit`}>
          {r?.auto_apply ? "It goes on their next one." : "It's kept off invoices, so apply it from here once they have one, or turn on Apply automatically again."}
        </EmptyState>
      ) : (
        <RelatedList label="Open invoices">
          {open.data.map((i) => (
            <RelatedRow
              key={i.id}
              title={`Invoice #${i.number}`}
              detail={statusText("invoice", i.status)}
              sub={[
                creditRoom(i) >= left ? `Takes all ${formatMoneyCents(left)}` : `Takes ${formatMoneyCents(creditRoom(i))} of ${formatMoneyCents(left)}`,
                `Invoice total ${formatMoneyCents(Number(i.total))}`,
                i.books && `${BOOKS[i.books]} has this invoice: the credit goes there too`,
              ]}
              actions={<Button size="sm" loading={apply.isPending && apply.variables === i.id} onClick={() => apply.mutate(i.id)}>Apply</Button>}
            />
          ))}
        </RelatedList>
      )}
      <FormError error={apply.error} />
    </Dialog>
  );
}
