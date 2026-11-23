/**
 * On My day: the equipment my crew has, what's due on it (tags and stickers too), and one tap to log
 * hours or mark work done. A Section of hairline rows (an inset card on the phone's grouped My day).
 */
import { dueTone, formatMeter } from "@crewtavo/core/equipment";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { RelatedList, RelatedRow, Section } from "@/components/ui/Section";
import { StatusPill } from "@/components/ui/StatusPill";
import { supabase, unwrap } from "@/lib/api";
import { useSession } from "@/lib/session";
import { LogDialog, type LogKind } from "./EquipmentDialogs";
import { byUrgency, EQUIPMENT_FIELDS, nextUp, type DueRow, type Equipment, type PaperRow } from "./equipmentData";
import { t } from "@/lib/i18n";

export function CrewEquipmentCard() {
  const session = useSession();
  const [log, setLog] = useState<{ equipment: Equipment; kind: LogKind; planId?: string } | null>(null);
  const data = useQuery({
    queryKey: ["field-equipment", session.company.id, session.userId],
    queryFn: async () => {
      const crews = unwrap(await supabase().from("crew_members").select("crew_id").eq("user_id", session.userId)).map((c) => c.crew_id);
      if (!crews.length) return [];
      const [items, due, paperwork] = await Promise.all([
        supabase().from("equipment").select(EQUIPMENT_FIELDS).eq("company_id", session.company.id).in("crew_id", crews).neq("status", "retired").order("name"),
        supabase().from("equipment_due").select("*").eq("company_id", session.company.id).in("crew_id", crews),
        supabase().from("equipment_paperwork").select("*").eq("company_id", session.company.id).in("crew_id", crews),
      ]);
      const plans = (unwrap(due) as unknown as DueRow[]).sort(byUrgency);
      const papers = unwrap(paperwork) as unknown as PaperRow[];
      return (unwrap(items) as unknown as Equipment[]).map((e) => ({ ...e, plans: plans.filter((p) => p.equipment_id === e.id), papers: papers.filter((p) => p.equipment_id === e.id) }));
    },
  });
  const rows = data.data ?? [];
  if (!rows.length) return null;

  return (
    <Section title={t("Your equipment")} action={<Link to="/equipment">{t("All equipment")}</Link>}>
      <RelatedList className="crew-equipment">
        {rows.map((e) => {
          const next = e.plans[0];
          const n = nextUp(e.plans, e.papers);
          const due = n && n.state !== "ok" ? n : null;
          return (
            <RelatedRow
              key={e.id}
              to={`/equipment/${e.id}`}
              title={e.name}
              sub={e.status === "in_shop" ? t("In the shop") : [e.meter !== "none" && e.meter_reading != null ? formatMeter(e.meter_reading, e.meter) : null, due ? `${due.name}: ${due.summary.toLowerCase()}` : next ? t("Next: {name}", { name: next.name }) : null]}
              end={due && <StatusPill label={due.state === "overdue" ? t("Overdue") : t("Due soon")} tone={dueTone(due.state)} />}
              actions={(e.meter !== "none" || due?.plan) && (
                <>
                  {e.meter !== "none" && <Button size="sm" icon="gauge" onClick={() => setLog({ equipment: e, kind: "reading" })}>{e.meter === "miles" ? t("Log miles") : t("Log hours")}</Button>}
                  {/* Quiet like Log hours: My day's green button is the visit's next step. */}
                  {due?.plan && <Button size="sm" icon="check" onClick={() => setLog({ equipment: e, kind: "service", planId: due.plan!.plan_id })}>{t("Mark done")}</Button>}
                </>
              )}
            />
          );
        })}
      </RelatedList>
      {log && (
        <LogDialog
          equipment={log.equipment}
          plans={rows.find((r) => r.id === log.equipment.id)?.plans.map((p) => ({ plan_id: p.plan_id, name: p.name })) ?? []}
          kind={log.kind}
          planId={log.planId}
          onClose={() => setLog(null)}
        />
      )}
    </Section>
  );
}
