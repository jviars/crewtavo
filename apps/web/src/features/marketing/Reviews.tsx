/**
 * Marketing → Reviews, Jobber's way: when clients are asked for a Google review automatically, by
 * which channels, after which recurring visit, and the reminders that follow every ask; the review
 * link and its two messages; asking a client now; and recent asks. With Google Business Profile
 * connected in Apps, the reviews themselves too (GoogleReviews.tsx): their numbers across the top,
 * the trend beside Ask a client now, and the list under the ask settings, so on a phone the form
 * people use comes before a long list. On a phone the numbers wait under the forms too: Marketing's
 * own numbers are already above the tabs.
 *
 * Laid out as App-Marketing.dc.html's sections: each part a heading on a hairline, never a box, the
 * settings in the wide column and Ask a client now (the tab's one green button) in the narrow one.
 * On a phone it's the grouped screen of Mobile-Apps.dc.html: each section an inset card.
 *
 * "Ask automatically" edits the two starter rules (review_after_job, review_recurring) through PUT
 * /api/reviews/asks, so they're still where asking is set and still show in Automations. A rule
 * someone changed there into something this can't show keeps its shape, with a link to it, and only
 * the switch turns it on and off.
 */
import {
  askChannels,
  askError,
  askRefusal,
  askStatus,
  askTiming,
  ASK_WHEN,
  DEFAULT_REVIEW_MESSAGE,
  MAX_RECURRING_VISITS,
  MAX_REMINDER_DAYS,
  notAsked,
  ordinal,
  reachOf,
  reminderLines,
  REVIEW_GAP_DAYS,
  reviewSettings,
  STOP_LINE,
  REVIEW_ASK_POLICY_URL,
  REVIEW_ASK_RULES,
  type AskChannel,
  type AskWhen,
} from "@crewtavo/core/marketing";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Button, cx, useJustDone } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { DetailColumns } from "@/components/ui/DetailPage";
import { Field, FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { RelatedList, RelatedRow, Section } from "@/components/ui/Section";
import { SectionSkeleton } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState } from "@/components/ui/States";
import { StatusPill } from "@/components/ui/StatusPill";
import { api, supabase, unwrap } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { formatDate, formatDateTime, timeAgo } from "@/lib/format";
import { can, hasRole, useSession } from "@/lib/session";
import { toast } from "@/lib/toast";
import { ClientPicker, type PickedClient } from "../clients/ClientForm";
import { ConnectEmailHint } from "../settings/ConnectEmailHint";
import { ReviewLinkOffer } from "../apps/GoogleBusinessPanel";
import { askBody, askRules, askToastKind, daysInOrder, reminderDropWords, remindersDroppedWords, type AskForm, type AskResult, type AskRuleRow } from "./askForm";
import { GoogleNumbers, GoogleReviewList, GoogleSide, useGoogleState, useReviewStats } from "./GoogleReviews";
import { hasNumbers, hasReviews, showsList, type GoogleState } from "./googleReviewData";
import styles from "./Presence.module.css";
import { ReviewCompare } from "./ReviewCompare";
import { useSettingsSaver } from "./useSettingsSaver";
import { Select } from "@/components/ui/Select";

/** Email, Text, Both: the same order wherever a review ask's channel is picked. */
const CHANNELS: Array<{ value: AskChannel; label: string }> = [
  { value: "email", label: "Email" },
  { value: "sms", label: "Text" },
  { value: "both", label: "Both" },
];
const WHEN_HINTS: Record<AskWhen, string> = {
  "job.completed": "When a job moves to Requires invoicing or Completed. A one-off job does when its last visit is finished, unless that's off in Settings → Company.",
  "visit.completed": "Each visit of a one-off job, not assessments or tasks.",
  "invoice.paid": "Not deposits or progress billing: the work isn't done yet.",
};
const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

/** Where the two columns stack (base.css .two-col), and a phone's numbers move under the forms. */
const STACKED = "(max-width: 900px)";

/** Whether the columns are stacked, following the window as it turns or resizes. */
function useStacked() {
  const [stacked, setStacked] = useState(() => window.matchMedia(STACKED).matches);
  useEffect(() => {
    const query = window.matchMedia(STACKED);
    const change = () => setStacked(query.matches);
    query.addEventListener("change", change);
    return () => query.removeEventListener("change", change);
  }, []);
  return stacked;
}

export function Reviews() {
  const session = useSession();
  // Rules a person can't see (no Automations area) don't come back, so the form waits on knowing.
  const rules = useQuery({
    queryKey: ["automation-rules", session.company.id, "review"],
    enabled: can(session, "automations"),
    queryFn: async () =>
      unwrap(
        await supabase()
          .from("automation_rules")
          .select("id, name, description, enabled, template_key, trigger, delay_minutes, conditions, actions")
          .eq("company_id", session.company.id)
          .in("template_key", ["review_after_job", "review_recurring"]),
      ) as unknown as AskRuleRow[],
  });

  const google = useGoogleState();
  const g = google.data;
  const connected = hasReviews(g);
  const stats = useReviewStats(connected);
  const stacked = useStacked();
  const numbers = hasNumbers(g) && <GoogleNumbers g={g!} stats={stats} />;

  // The lists run the full width under the rest, so on a phone Ask a client now comes before a long list.
  return (
    <div className={cx("m-grouped", styles.tab)}>
      {!stacked && numbers}
      <DetailColumns
        side={
          <>
            <AskNow />
            {google.error ? <ErrorState compact error={google.error} onRetry={() => google.refetch()} /> : <GoogleSide g={g} stats={stats} />}
          </>
        }
      >
        {!can(session, "automations") ? (
          <Section title="Ask automatically">
            <p className={styles.note}>Owners and admins with the Automations area choose when clients are asked for a review.</p>
          </Section>
        ) : rules.isPending ? (
          <SectionSkeleton rows={4} />
        ) : rules.error ? (
          <ErrorState compact error={rules.error} onRetry={() => rules.refetch()} />
        ) : (
          <AskAutomatically rules={rules.data} google={g} />
        )}
        <ReviewLink google={g} />
        <ReviewCompare />
      </DetailColumns>
      {stacked && numbers}
      {showsList(g) && <GoogleReviewList g={g!} />}
      <RecentRequests />
    </div>
  );
}

/** A starter rule changed in Automations into something the form can't show. */
function CustomRule({ rule }: { rule: AskRuleRow }) {
  return (
    <div className="callout callout-info">
      <Icon name="info" size={16} />
      <div className="grow">
        You changed “{rule.name}” in Automations, so only the switch above turns it on and off here.{" "}
        <Link to={`/automations/${rule.id}`}>Open the rule</Link>
      </div>
    </div>
  );
}

function AskAutomatically({ rules, google }: { rules: AskRuleRow[]; google: GoogleState | undefined }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const settings = session.company.settings as { review_url?: string };
  const { afterRule, recurringRule, afterCustom, recurringCustom, onlyRecurring, missing, form: initial } = askRules(rules, session.company.settings);
  const [form, setForm] = useState<AskForm>(initial);
  const set = (patch: Partial<AskForm>) => setForm((f) => ({ ...f, ...patch }));
  const canSave = hasRole(session, "admin") && can(session, "automations");
  const inOrder = daysInOrder(form);
  const [counted, setCounted] = useState<unknown>(null);
  const save = useMutation({
    meta: { inline: true },
    mutationFn: () => api.put<{ kept: Array<{ id: string; name: string }>; reminders_dropped?: number }>("/reviews/asks", askBody(form)),
    onSuccess: async (r) => {
      queryClient.invalidateQueries({ queryKey: ["automation-rules", session.company.id] });
      // New reminder days move the reminders still to come.
      queryClient.invalidateQueries({ queryKey: ["review-requests", session.company.id] });
      const dropped = remindersDroppedWords(r.reminders_dropped ?? 0);
      if (dropped) toast.success(dropped);
      await session.refresh();
    },
  });
  // Fewer reminders than now stops the ones still waiting for good: say how many first.
  const submit = async () => {
    setCounted(null);
    const before = reviewSettings(session.company.settings).reminderDays.length;
    if (form.reminders < before) {
      const { count, error } = await supabase()
        .from("review_requests")
        .select("id", { count: "exact", head: true })
        .eq("company_id", session.company.id)
        .eq("status", "sent")
        .is("clicked_at", null)
        .not("next_reminder_at", "is", null)
        .gte("reminders_sent", form.reminders);
      if (error) return setCounted(error);
      const words = reminderDropWords(before, form.reminders, count ?? 0);
      if (words && !(await confirm({ ...words, danger: true }))) return;
    }
    save.mutate();
  };
  const saved = useJustDone(save);
  const whenLabel = ASK_WHEN.find((w) => w.verb === form.when)?.label ?? "";
  const texts = form.channel !== "email";
  const emails = form.channel !== "sms";
  // With the after-job rule changed in Automations, Send by is the recurring rule's alone.
  const channelShown = !afterCustom || !recurringCustom;
  const timing = !afterCustom
    ? askTiming("after_job", form.when, afterRule?.delay_minutes ?? 1440)
    : channelShown && form.recurring ? askTiming("recurring", form.when, recurringRule?.delay_minutes ?? 1440) : "";
  const disabled = !canSave;
  // A rule changed in Automations may ask on recurring work itself, so then this says only what the recurring rule does.
  const recurringHint = form.recurring
    ? afterCustom ? "Asks once for each recurring job, after this visit." : "Recurring jobs wait for this visit instead."
    : afterCustom ? "Nothing asks after a recurring job's visits." : "Recurring work isn't asked automatically.";

  // Changed here and not saved yet: said by Save, since the switch in the heading saves with it.
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);

  return (
    <Section
      title="Ask automatically"
      action={
        <label className={styles.headSwitch}>
          <span>{form.enabled ? "On" : "Off"}</span>
          <input type="checkbox" role="switch" className="switch" aria-label="Ask automatically" checked={form.enabled} disabled={disabled} onChange={(e) => set({ enabled: e.target.checked })} />
        </label>
      }
    >
      <form className={styles.form} onSubmit={(e: FormEvent) => { e.preventDefault(); if (inOrder) void submit(); }}>
        {!settings.review_url && (
          <div className="callout callout-warning">
            <Icon name="alert" size={16} />
            <div className="grow">{google?.review_link.suggested ? "Use the link Google gives below first." : "Add your Google review link below first."} Until then there's nothing to send.</div>
          </div>
        )}
        {form.enabled && onlyRecurring && !afterCustom && (
          <p className={styles.note}>Only recurring work is asked right now. Saving with this on asks after {lowerFirst(whenLabel)} too.</p>
        )}

        <div className={styles.grid2}>
          {afterCustom ? (
            <div className={styles.full}><CustomRule rule={afterRule!} /></div>
          ) : (
            <Field label="Ask when" hint={WHEN_HINTS[form.when]}>
              <Select className="select" value={form.when} disabled={disabled} onChange={(e) => set({ when: e.target.value as AskWhen })}>
                {ASK_WHEN.map((w) => <option key={w.verb} value={w.verb}>{w.label}</option>)}
              </Select>
            </Field>
          )}
          {channelShown && (
            <Field label="Send by" hint={afterCustom ? "For recurring work. The rule you changed keeps its own." : undefined}>
              <div className="segmented" role="group" aria-label="Send by" style={{ justifySelf: "start" }}>
                {CHANNELS.map((c) => (
                  <button key={c.value} type="button" aria-pressed={form.channel === c.value} disabled={disabled} onClick={() => set({ channel: c.value })}>{c.label}</button>
                ))}
              </div>
            </Field>
          )}
        </div>
        {channelShown && texts && !session.config.features.sms && (
          <div className="callout callout-warning">
            <Icon name="alert" size={16} />
            <div className="grow">
              {emails && session.config.features.email
                ? "Texting isn't set up on this Crewtavo, so asks go by email only, or fail for clients with no email."
                : "Texting isn't set up on this Crewtavo, so asks can't go by text."}
            </div>
          </div>
        )}
        {channelShown && emails && !session.config.features.email && (
          <div className="callout callout-warning"><Icon name="alert" size={16} /><div className="grow">Email isn't connected yet, so asks can't go by email.<ConnectEmailHint /></div></div>
        )}

        {recurringCustom ? (
          <CustomRule rule={recurringRule!} />
        ) : (
          <Field label="Recurring work" hint={recurringHint}>
            <div className={styles.inline}>
              <label className="checkbox">
                <input type="checkbox" checked={form.recurring} disabled={disabled} onChange={(e) => set({ recurring: e.target.checked })} />
                Ask after the
              </label>
              <Select className="select" style={{ width: "auto" }} aria-label="Visit to ask after" value={form.visits} disabled={disabled || !form.recurring} onChange={(e) => set({ visits: Number(e.target.value) })}>
                {Array.from({ length: MAX_RECURRING_VISITS }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{ordinal(n)} visit</option>)}
              </Select>
            </div>
          </Field>
        )}

        {/* Reminders follow every ask, by hand too, so they're set here whether or not asking is on. */}
        <Field label="Reminders" hint="For every ask, automatic or by hand. At 1:30pm, to anyone who hasn't opened the link." error={inOrder ? null : "The second reminder comes after the first."}>
          <div className={styles.inline}>
            <div className="segmented" role="group" aria-label="Reminders">
              {(["None", "One", "Two"] as const).map((label, n) => (
                <button key={label} type="button" aria-pressed={form.reminders === n} disabled={disabled} onClick={() => set({ reminders: n })}>{label}</button>
              ))}
            </div>
            {[0, 1].filter((i) => i < form.reminders).map((i) => (
              <Select key={i} className="select" style={{ width: "auto" }} aria-label={i === 0 ? "First reminder" : "Second reminder"} value={form.days[i]} disabled={disabled}
                onChange={(e) => set({ days: (i === 0 ? [Number(e.target.value), form.days[1]] : [form.days[0], Number(e.target.value)]) as [number, number] })}>
                {Array.from({ length: MAX_REMINDER_DAYS }, (_, d) => d + 1).map((d) => <option key={d} value={d}>{d === 1 ? "1 day" : `${d} days`} after</option>)}
              </Select>
            ))}
          </div>
        </Field>

        <p className={styles.fine}>
          {timing} At most once every 6 months per client. Between 9pm and 9am the first ask goes by email.
          {/* Underlined: in grey text a link told apart by colour alone can't be seen by everyone. */}
          {(afterRule || recurringRule) && " In Automations: "}
          {afterRule && <Link to={`/automations/${afterRule.id}`} style={{ textDecoration: "underline" }}>{afterRule.name}</Link>}
          {afterRule && recurringRule && " · "}
          {recurringRule && <Link to={`/automations/${recurringRule.id}`} style={{ textDecoration: "underline" }}>{recurringRule.name}</Link>}
          {(afterRule || recurringRule) && "."}
        </p>
        {canSave && missing && <p className={styles.fine}>Saving puts the rules back in Automations.</p>}
        <FormError error={save.error ?? counted} />
        <div className={styles.saveBar}>
          {canSave ? (
            <>
              <Button type="submit" loading={save.isPending} done={saved} disabled={!inOrder}>Save</Button>
              {dirty && !save.isPending && <span className={styles.saveNote}>Not saved yet</span>}
            </>
          ) : (
            <span className={styles.saveNote}>Only owners and admins can change these.</span>
          )}
        </div>
      </form>
    </Section>
  );
}

function ReviewLink({ google }: { google: GoogleState | undefined }) {
  const session = useSession();
  const settings = session.company.settings as { review_url?: string; review_message?: string };
  const canSave = hasRole(session, "admin");
  const [url, setUrl] = useState(settings.review_url ?? "");
  // Google's own link for the location, when it would change this one: offered, never used without asking.
  const offer = canSave ? google?.review_link.suggested : null;
  const saveLink = useSettingsSaver();
  const [message, setMessage] = useState(settings.review_message ?? DEFAULT_REVIEW_MESSAGE);
  const [reminder, setReminder] = useState(reviewSettings(session.company.settings).reminderMessage);
  const save = useSettingsSaver();
  const saved = useJustDone(save);
  const validUrl = /^https:\/\/\S+\.\S+/.test(url.trim());
  const linked = message.includes("{{link}}") && reminder.includes("{{link}}");

  return (
    <Section title="Your review link">
      <form
        className={styles.form}
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          // settings.reviews is also saved by Ask automatically: what's there now is kept.
          save.mutate((current) => ({
            review_url: url.trim(),
            review_message: message.trim(),
            reviews: { ...((current.reviews as Record<string, unknown> | undefined) ?? {}), reminder_message: reminder.trim() },
          }));
        }}
      >
        {offer && (
          <ReviewLinkOffer
            link={offer}
            title={google?.location?.title ?? null}
            onUse={async () => {
              await saveLink.mutateAsync({ review_url: offer });
              setUrl(offer);
            }}
          />
        )}
        <Field label="Google review URL" error={url && !validUrl ? "Paste the full link, starting with https://" : null} hint={<a href="https://support.google.com/business/answer/3474122" target="_blank" rel="noreferrer">Where to find it</a>}>
          <input className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://g.page/r/…/review" disabled={!canSave} />
        </Field>
        <div className={styles.grid2}>
          <Field label="Message" hint={<>{`{{link}} is replaced with your review link. Texts end with “${STOP_LINE}” unless yours says STOP.`} {REVIEW_ASK_RULES} <a href={REVIEW_ASK_POLICY_URL} target="_blank" rel="noreferrer" style={{ textDecoration: "underline" }}>Google's policy</a></>}>
            <textarea className="textarea" style={{ minHeight: 132 }} value={message} maxLength={1000} onChange={(e) => setMessage(e.target.value)} disabled={!canSave} />
          </Field>
          <Field label="Reminder message" hint="Sent to anyone who hasn't opened the link, with the same link.">
            <textarea className="textarea" style={{ minHeight: 132 }} value={reminder} maxLength={1000} onChange={(e) => setReminder(e.target.value)} disabled={!canSave} />
          </Field>
        </div>
        {!linked && <p className="error-text" style={{ margin: 0 }}>Include {"{{link}}"} in both messages so clients can click through.</p>}
        <FormError error={save.error} />
        <div className={styles.saveBar}>
          {canSave ? <Button type="submit" loading={save.isPending} done={saved} disabled={!validUrl || !linked}>Save</Button> : <span className={styles.saveNote}>Only owners and admins can change these.</span>}
        </div>
      </form>
    </Section>
  );
}

/** How an ask went, as a round quiet icon at the start of its row: by text, email, both, or a copied link. */
function ChannelIcon({ channel }: { channel: string }) {
  const label = channel === "both" ? "Text and email" : channel === "sms" ? "Text" : channel === "email" ? "Email" : "Link copied";
  return (
    <span className="rel-icon" role="img" aria-label={label}>
      <Icon name={channel === "both" ? "send" : channel === "sms" ? "messages" : channel === "email" ? "mail" : "link"} size={15} />
    </span>
  );
}

const RECENT_SHOWN = 10;

function RecentRequests() {
  const session = useSession();
  const [all, setAll] = useState(false);
  const requests = useQuery({
    queryKey: ["review-requests", session.company.id],
    queryFn: async () =>
      unwrap(
        await supabase()
          .from("review_requests")
          .select("id, channel, status, sent_at, clicked_at, error, reminders_sent, reminders_failed, next_reminder_at, reminder_note, reminder_error, reviewed_at, client:clients(id, display_name)")
          .eq("company_id", session.company.id)
          .order("sent_at", { ascending: false })
          .limit(50),
      ),
  });
  const timeZone = session.company.timezone;
  const remindersSet = reviewSettings(session.company.settings).reminderDays.length;
  const rows = requests.data ?? [];
  return (
    <Section
      title="Recent requests"
      count={rows.length || undefined}
      action={rows.length > RECENT_SHOWN && <button type="button" onClick={() => setAll(!all)}>{all ? "Show less" : `Show all ${rows.length}`}</button>}
    >
      {requests.isPending && <SectionSkeleton rows={3} />}
      {requests.error && <ErrorState compact error={requests.error} onRetry={() => requests.refetch()} />}
      {requests.data?.length === 0 && <EmptyState inline title="No review requests yet" />}
      {rows.length > 0 && (
        <RelatedList label="Review requests">
          {(all ? rows : rows.slice(0, RECENT_SHOWN)).map((r) => {
            const client = r.client as { id: string; display_name: string } | null;
            const notes = [timeAgo(r.sent_at), askError(r), ...reminderLines(r, remindersSet, (iso) => formatDateTime(iso, timeZone))];
            return (
              <RelatedRow
                key={r.id}
                to={client ? `/clients/${client.id}` : undefined}
                lead={<ChannelIcon channel={r.channel} />}
                title={client?.display_name ?? "Client"}
                sub={notes}
                end={<StatusPill {...askStatus(r)} />}
              />
            );
          })}
        </RelatedList>
      )}
    </Section>
  );
}

/**
 * Asking a client by hand: right away, whatever the time and however lately they were asked, unless
 * they opted out or are archived. The channels this Crewtavo can't send by aren't offered.
 */
function AskNow() {
  const session = useSession();
  const queryClient = useQueryClient();
  const settings = session.company.settings as { review_url?: string };
  const ready = { email: session.config.features.email, sms: session.config.features.sms };
  const [client, setClient] = useState<PickedClient>(null);
  const [channel, setChannel] = useState<AskChannel | "link">(ready.email ? "email" : ready.sms ? "sms" : "link");
  const remindersOn = reviewSettings(session.company.settings).reminderDays.length > 0;
  // The picked client's opt-outs, and when they were last asked as the 6 months count it.
  const picked = useQuery({
    queryKey: ["review-ask", client?.id],
    enabled: Boolean(client),
    queryFn: async () => {
      const [who, last] = await Promise.all([
        supabase().from("clients").select("display_name, email, phone, status, review_opt_out, marketing_opt_out, sms_opt_out_at, reviewed_at").eq("id", client!.id).maybeSingle(),
        supabase().rpc("last_review_ask", { p_company: session.company.id, p_client: client!.id }),
      ]);
      return { client: unwrap(who), last: unwrap(last) ?? null };
    },
  });
  const ask = useMutation({
    mutationFn: () => api.post<AskResult>("/reviews/request", { client_id: client!.id, channel }),
    onSuccess: (r) => {
      if (channel === "link") copyText(r.link, "Review link copied");
      // One way went and the other didn't: a warning that says why, so it isn't missed.
      else toast[askToastKind(r)](r.detail);
      setClient(null);
    },
    // An ask that failed is listed too, saying why.
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["review-requests", session.company.id] });
      queryClient.invalidateQueries({ queryKey: ["marketing-summary", session.company.id] });
      // Picked again, the client says they were just asked.
      queryClient.invalidateQueries({ queryKey: ["review-ask"] });
    },
  });

  const who = picked.data?.client;
  const refusal = !who ? null : channel === "link" ? notAsked(who) : askRefusal(who, channel, ready);
  // By text and email, but only one of them can go: which, and why not the other.
  const oneWay = who && channel === "both" && !refusal ? askChannels("both", reachOf(who, ready), false).send : [];
  const only = oneWay.length === 1 ? oneWay[0]! : null;
  const last = picked.data?.last;
  const waitsUntil = last ? new Date(Date.parse(last) + REVIEW_GAP_DAYS * 86_400_000) : null;

  // A client who already left a Google review isn't asked at all, so the rest of the form is moot.
  const reviewed = Boolean(client && who?.reviewed_at);

  return (
    <Section title="Ask a client now">
      <form className={styles.form} onSubmit={(e: FormEvent) => { e.preventDefault(); if (client && !refusal && !reviewed) ask.mutate(); }}>
        <ClientPicker value={client} onChange={setClient} allowCreate={false} />
        {reviewed ? (
          <p className={styles.warnLine}>
            {who!.display_name} already left a Google review, so they aren't asked again. Not them?{" "}
            <Link to={`/marketing?tab=reviews&client=${client!.id}`}>See their review</Link> and undo the match.
          </p>
        ) : (
          <>
            {client && picked.data && (
              <p className={styles.note}>
                {last ? `Last asked ${timeAgo(last)}` : "Not asked yet"}
                {waitsUntil && waitsUntil > new Date() ? `, so automatic asks wait until ${formatDate(waitsUntil)}.` : "."}
              </p>
            )}
            <div className={cx("segmented", styles.fill)} role="group" aria-label="Send by">
              {CHANNELS.map((c) => (
                <button key={c.value} type="button" aria-pressed={channel === c.value} disabled={c.value === "both" ? !ready.email && !ready.sms : !ready[c.value]} onClick={() => setChannel(c.value)}>{c.label}</button>
              ))}
              <button type="button" aria-pressed={channel === "link"} onClick={() => setChannel("link")}>Copy link</button>
            </div>
            <div className={styles.notes}>
              {!ready.sms && <p className={styles.note}>Texting isn't set up on this Crewtavo.</p>}
              {!ready.email && <p className={styles.note}>Email isn't connected yet.<ConnectEmailHint /></p>}
              {!settings.review_url && <p className={styles.warnLine}>Save your Google review link first.</p>}
              {refusal && <p className={styles.warnLine}>{refusal}</p>}
              {only && <p className={styles.note}>Goes by {only === "email" ? "email" : "text"} only. {askRefusal(who!, only === "email" ? "sms" : "email", ready)}</p>}
              {channel === "link" && !refusal && <p className={styles.note}>Automatic asks don't count it until the link is opened.</p>}
              {!refusal && channel !== "link" && remindersOn && <p className={styles.note}>Reminders follow if they don't open it.</p>}
            </div>
            <Button type="submit" variant="primary" block icon={channel === "link" ? "link" : "star"} loading={ask.isPending} disabled={!client || !settings.review_url || Boolean(refusal)}>
              {channel === "link" ? "Copy review link" : "Ask for a review"}
            </Button>
          </>
        )}
      </form>
    </Section>
  );
}
