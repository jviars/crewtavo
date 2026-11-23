/**
 * My day: "Snow is coming. Can you go out?" for someone the snow task asked (a subcontractor on a
 * snow customer whose forecast calls for service: snow_availability). Yes or no,
 * theirs to change until the day; a no is news for the people who schedule the team (snow_answer).
 * Nothing shows for someone nobody asked.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { supabase, unwrap } from "@/lib/api";
import { formatDay, todayIn } from "@/lib/format";
import { t } from "@/lib/i18n";
import { useSession } from "@/lib/session";
import styles from "./snow.module.css";

export function SnowAvailabilityCard() {
  const session = useSession();
  const { company } = session;
  const queryClient = useQueryClient();
  const key = ["snow", company.id, "my-availability"];
  const asked = useQuery({
    queryKey: key,
    queryFn: async () =>
      unwrap(await supabase().from("snow_availability").select("snow_date, can").eq("company_id", company.id).eq("user_id", session.userId).gte("snow_date", todayIn(company.timezone)).order("snow_date")),
  });
  const answer = useMutation({
    meta: { success: (_: unknown, v: { can: boolean }) => (v.can ? t("Thanks. The office knows you're in.") : t("The office has been told you can't.")) },
    mutationFn: async (v: { date: string; can: boolean }) => unwrap(await supabase().rpc("snow_answer", { p_company: company.id, p_date: v.date, p_can: v.can })),
    onSettled: () => queryClient.invalidateQueries({ queryKey: key }),
  });
  return (asked.data ?? []).map((day) => {
    const when = formatDay(`${day.snow_date}T12:00:00`);
    const busy = answer.isPending && answer.variables?.date === day.snow_date;
    return (
      // The question, then its answers under it where a thumb reaches them; once answered, a quiet line with a way to change it.
      <div key={day.snow_date} className={`callout ${day.can == null ? "callout-warning" : ""} ${styles.ask}`}>
        <Icon name="snow" size={16} />
        <div className="grow">
          <div>{day.can == null ? t("Snow is coming for {when}. Can you go out?", { when }) : day.can ? t("You said you can go out for snow on {when}.", { when }) : t("You said you can't go out for snow on {when}.", { when })}</div>
          {day.can == null && <div className={styles.askHint}>{t("The office is waiting to hear. Your snow customers are in the notice you got.")}</div>}
        </div>
        {day.can == null ? (
          <div className={styles.askAnswers}>
            <Button size="sm" variant="primary" loading={busy && answer.variables?.can === true} disabled={busy} onClick={() => answer.mutate({ date: day.snow_date, can: true })}>{t("Yes")}</Button>
            <Button size="sm" loading={busy && answer.variables?.can === false} disabled={busy} onClick={() => answer.mutate({ date: day.snow_date, can: false })}>{t("No")}</Button>
          </div>
        ) : (
          <Button size="sm" variant="ghost" className={styles.askChange} loading={busy} onClick={() => answer.mutate({ date: day.snow_date, can: !day.can })}>{day.can ? t("I can't after all") : t("I can after all")}</Button>
        )}
      </div>
    );
  });
}
