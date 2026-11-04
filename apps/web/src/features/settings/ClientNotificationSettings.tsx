/**
 * Settings → Client notifications: one switch for each message sent to clients by itself. Each is
 * an automation rule (clientNotifications.ts), so it still shows, and is edited, in Automations.
 */
import { describeRuleSentence } from "@crewtavo/core/automations";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { CardSkeleton } from "@/components/ui/Skeleton";
import { ErrorState } from "@/components/ui/States";
import { supabase, unwrap } from "@/lib/api";
import { useSession } from "@/lib/session";
import type { RuleRow } from "../automations/AutomationsPage";
import { CLIENT_NOTIFICATIONS, ruleFor, type ClientNotification } from "./clientNotifications";
import { ConnectEmailHint } from "./ConnectEmailHint";

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
    mutationFn: async ({ n, rule, enabled }: { n: ClientNotification; rule?: RuleRow; enabled: boolean }) => {
      if (rule) return unwrap(await supabase().from("automation_rules").update({ enabled }).eq("id", rule.id));
      // None yet (it was deleted): put the starter back.
      unwrap(await supabase().from("automation_rules").insert({ ...n.recipe, conditions: n.recipe.conditions as never, actions: n.recipe.actions as never, enabled, company_id: company.id }));
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["automation-rules", company.id] }),
  });

  if (rules.isPending) return <CardSkeleton lines={6} />;
  if (rules.error) return <div className="card"><ErrorState error={rules.error} onRetry={() => rules.refetch()} /></div>;
  const rows = CLIENT_NOTIFICATIONS.map((n) => ({ n, rule: ruleFor(n, rules.data) }));
  const on = (r: (typeof rows)[number]) => (toggle.isPending && toggle.variables.n === r.n ? toggle.variables.enabled : Boolean(r.rule?.enabled));
  const emails = rows.some((r) => on(r) && (r.rule ?? r.n.recipe).actions.some((a) => a.type === "send_email" || a.type === "request_review"));

  return (
    <div className="stack" style={{ maxWidth: 760 }}>
      {emails && !config.features.email && (
        <div className="callout callout-warning">
          <Icon name="alert" size={20} />
          <div className="grow small" style={{ fontWeight: 400 }}>Email isn't connected, so emails to clients won't go out until it is.<ConnectEmailHint /></div>
        </div>
      )}
      <div className="card card-pad stack">
        <span className="muted small">What Crewtavo sends your clients for you. Each one is a rule in <Link to="/automations">Automations</Link>, where you can change its wording.</span>
        {rows.map((r) => (
          <div key={r.n.label} className="row" style={{ alignItems: "flex-start", gap: 14 }}>
            <label className="switch-row grow">
              <input type="checkbox" className="switch" checked={on(r)} disabled={toggle.isPending} onChange={(e) => toggle.mutate({ n: r.n, rule: r.rule, enabled: e.target.checked })} />
              <span>
                {r.n.label}
                <span className="muted small" style={{ display: "block", fontWeight: 400 }}>{describeRuleSentence(r.rule ?? r.n.recipe)}</span>
              </span>
            </label>
            {r.rule && <Link to={`/automations/${r.rule.id}`} className="small">Edit the message</Link>}
          </div>
        ))}
      </div>
      <FormError error={toggle.error} />
    </div>
  );
}
