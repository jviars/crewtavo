/**
 * The one-time note for a business that was running before clients could be told a visit was
 * booked, moved or cancelled. Its three rules were added switched off, so nobody's clients started
 * getting messages nobody chose to send (companies.settings.visit_notices, core
 * visitNoticesPending). Automations and Settings → Client notifications say so once, with how the
 * day-before reminder is set, and let the office turn them on or leave them. Either answer is saved
 * by set_visit_notices, which settles it. A business made since has them on and never sees this.
 */
import { VISIT_NOTICE_SETTLE_MIN, visitNoticesPending } from "@crewtavo/core/automations";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { supabase, unwrap } from "@/lib/api";
import { useSession } from "@/lib/session";
import type { RuleRow } from "../automations/AutomationsPage";
import styles from "./VisitNotices.module.css";

type Answer = "on" | "with-reminder" | "off";

/** `rules`: the company's rules, once loaded. `link`: point to the settings screen where each message is (not needed there). */
export function VisitNoticesNotice({ rules, link }: { rules: RuleRow[] | undefined; link?: boolean }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const answer = useMutation({
    meta: { inline: true, success: (_: unknown, a: Answer) => (a === "off" ? "Left off" : "Turned on") },
    mutationFn: async (a: Answer) => unwrap(await supabase().rpc("set_visit_notices", { p_company: session.company.id, p_enabled: a !== "off", p_reminder: a === "with-reminder" })),
    onSuccess: async () => {
      await session.refresh();
      await queryClient.invalidateQueries({ queryKey: ["automation-rules", session.company.id] });
    },
  });
  if (!visitNoticesPending(session.company.settings) || !rules) return null;
  // The starter itself: the note's second button turns that one on.
  const reminder = rules.find((r) => r.template_key === "visit_reminder");
  const reminderOn = rules.some((r) => r.trigger === "visit.reminder" && r.enabled);
  const busy = (a: Answer) => answer.isPending && answer.variables === a;
  return (
    <div className="callout" role="note">
      <Icon name="info" size={16} />
      <div className="grow">
        <div>Clients can now be told when a visit is booked, moved or cancelled</div>
        <p className={styles.text}>
          These three messages are off for you until you turn them on. Each goes {VISIT_NOTICE_SETTLE_MIN} minutes after a change, so a visit moved twice is one message. Your
          day-before reminder is {reminderOn ? "on" : "off"}.
          {link && <> Read and reword them in <Link to="/settings?tab=client-notifications">Settings → Client notifications</Link>.</>}
        </p>
        {/* Quiet buttons: the page's own green (New rule) stays its only one. */}
        <div className={styles.actions}>
          <Button size="sm" loading={busy("on")} disabled={answer.isPending} onClick={() => answer.mutate("on")}>Turn on all three</Button>
          {reminder && !reminderOn && (
            <Button size="sm" loading={busy("with-reminder")} disabled={answer.isPending} onClick={() => answer.mutate("with-reminder")}>Turn on with the reminder</Button>
          )}
          <Button size="sm" variant="ghost" loading={busy("off")} disabled={answer.isPending} onClick={() => answer.mutate("off")}>Keep them off</Button>
        </div>
        <FormError error={answer.error} />
      </div>
    </div>
  );
}
