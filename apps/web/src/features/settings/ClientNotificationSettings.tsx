/**
 * Settings → Client notifications: one switch for each message sent to clients by itself. Each is
 * an automation rule (clientNotifications.ts), so it still shows, and is edited, in Automations.
 * Everything a client can hear about a visit is together at the top, in the order it happens:
 * booked, moved, cancelled, the reminder, on the way, and any rule of the business's own.
 */
import { describeRuleSentence } from "@crewtavo/core/automations";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { Section } from "@/components/ui/Section";
import { SectionSkeleton } from "@/components/ui/Skeleton";
import { ErrorState } from "@/components/ui/States";
import { supabase, unwrap } from "@/lib/api";
import { useSession } from "@/lib/session";
import type { RuleRow } from "../automations/AutomationsPage";
import { ContactMessagesSwitch } from "../clients/ContactMessages";
import { channelsOf, CLIENT_NOTIFICATIONS, otherVisitRules, ruleFor, sendsEmail, sendsText, type ClientNotification } from "./clientNotifications";
import { ConnectEmailHint, ConnectTextingHint } from "./ConnectEmailHint";
import { SwitchRow } from "./SettingsKit";
import { VisitNoticesNotice } from "./VisitNotices";

/** A switch's row: the starter it stands for (`n`), or one of the business's own rules (`rule` alone). */
interface Row {
  key: string;
  label: string;
  n?: ClientNotification;
  rule?: RuleRow;
}

export function ClientNotificationSettings() {
  const session = useSession();
  const { company, config } = session;
  const queryClient = useQueryClient();
  const rules = useQuery({
    queryKey: ["automation-rules", company.id, "client-notifications"],
    queryFn: async () => unwrap(await supabase().from("automation_rules").select("id, name, description, trigger, delay_minutes, conditions, actions, enabled, run_count, last_run_at, template_key").eq("company_id", company.id).order("created_at")) as unknown as RuleRow[],
  });
  const toggle = useMutation({
    meta: { inline: true, success: (_: unknown, v: { enabled: boolean }) => (v.enabled ? "Turned on" : "Turned off") },
    mutationFn: async ({ row, enabled }: { row: Row; enabled: boolean }) => {
      if (row.rule) return unwrap(await supabase().from("automation_rules").update({ enabled }).eq("id", row.rule.id));
      // None yet (it was deleted): put the starter back.
      const recipe = row.n!.recipe;
      unwrap(await supabase().from("automation_rules").insert({ ...recipe, conditions: recipe.conditions as never, actions: recipe.actions as never, enabled, company_id: company.id }));
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["automation-rules", company.id] }),
  });

  if (rules.isPending) return <SectionSkeleton rows={6} />;
  if (rules.error) return <ErrorState error={rules.error} onRetry={() => rules.refetch()} />;
  const starters: Row[] = CLIENT_NOTIFICATIONS.map((n) => ({ key: n.recipe.template_key, label: n.label, n, rule: ruleFor(n, rules.data) }));
  const about = starters.filter((r) => r.n!.visit);
  // The business's own rules that message a client about a visit: every message they can get is here.
  const own: Row[] = otherVisitRules(rules.data, starters.map((r) => r.rule)).map((rule) => ({ key: rule.id, label: rule.name, rule }));
  const rest = starters.filter((r) => !r.n!.visit);
  const all = [...about, ...own, ...rest];
  const on = (r: Row) => (toggle.isPending && toggle.variables.row.key === r.key ? toggle.variables.enabled : Boolean(r.rule?.enabled));
  const emails = all.some((r) => on(r) && sendsEmail(r.rule ?? r.n!.recipe));
  const texts = all.some((r) => on(r) && sendsText(r.rule ?? r.n!.recipe));

  const row = (r: Row) => (
    <SwitchRow
      key={r.key}
      label={<>{r.label} <span className="set-tag">{on(r) ? channelsOf(r.rule ?? r.n!.recipe) : "Off"}</span></>}
      hint={<>{describeRuleSentence(r.rule ?? r.n!.recipe)}{r.n?.note && <span className="set-row-more">{r.n.note}</span>}</>}
      checked={on(r)}
      disabled={toggle.isPending}
      onChange={(enabled) => toggle.mutate({ row: r, enabled })}
      end={r.rule && <Link to={`/automations/${r.rule.id}`} aria-label={`Edit the message: ${r.label}`}>Edit the message</Link>}
    />
  );

  return (
    <>
      <VisitNoticesNotice rules={rules.data} />
      {emails && !config.features.email && (
        <div className="callout callout-warning">
          <Icon name="alert" size={16} />
          <div className="grow">Email isn't connected, so emails to clients won't go out until it is.<ConnectEmailHint /></div>
        </div>
      )}
      {texts && !config.features.sms && (
        <div className="callout callout-warning">
          <Icon name="alert" size={16} />
          <div className="grow">Texting isn't set up, so texts to clients won't go out until it is.<ConnectTextingHint /></div>
        </div>
      )}
      <Section level={3} title="About their visits">
        <p className="set-note">
          Every message a client can get about a visit, and whether it's on. Each one is a rule in <Link to="/automations">Automations</Link>, where you can change its wording or add a text.
        </p>
        <div className="set-rows">
          {about.map(row)}
          {own.map(row)}
        </div>
        <p className="set-note">
          A client who asks to move or cancel a visit in the Client Hub is always emailed your answer when you approve or decline it. That change isn't told a second time by the messages above.
        </p>
      </Section>
      <Section level={3} title="Requests, quotes, invoices and reviews">
        <p className="set-note">The rest of what Crewtavo sends your clients for you, each a rule in <Link to="/automations">Automations</Link> too.</p>
        <div className="set-rows">{rest.map(row)}</div>
      </Section>
      <FormError error={toggle.error} />
      <Section level={3} title="A client's other contacts">
        <ContactMessagesSwitch />
      </Section>
    </>
  );
}
