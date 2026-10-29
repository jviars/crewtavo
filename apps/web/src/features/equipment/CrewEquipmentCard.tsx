/** On My day: the equipment my crew has, what's due on it, and one tap to log hours or mark work done. */
import { dueSummary, dueTone, formatMeter } from "@crewtavo/core/equipment";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { StatusPill } from "@/components/ui/StatusPill";
import { supabase, unwrap } from "@/lib/api";
import { useSession } from "@/lib/session";
import { LogDialog, type LogKind } from "./EquipmentDialogs";
import { byUrgency, EQUIPMENT_FIELDS, type DueRow, type Equipment } from "./equipmentData";

export function CrewEquipmentCard() {
  const session = useSession();
  const [log, setLog] = useState<{ equipment: Equipment; kind: LogKind; planId?: string } | null>(null);
  const data = useQuery({
    queryKey: ["field-equipment", session.company.id, session.userId],
    queryFn: async () => {
      const crews = unwrap(await supabase().from("crew_members").select("crew_id").eq("user_id", session.userId)).map((c) => c.crew_id);
      if (!crews.length) return [];
      const [items, due] = await Promise.all([
        supabase().from("equipment").select(EQUIPMENT_FIELDS).eq("company_id", session.company.id).in("crew_id", crews).neq("status", "retired").order("name"),
        supabase().from("equipment_due").select("*").eq("company_id", session.company.id).in("crew_id", crews),
      ]);
      const plans = (unwrap(due) as unknown as DueRow[]).sort(byUrgency);
      return (unwrap(items) as unknown as Equipment[]).map((e) => ({ ...e, plans: plans.filter((p) => p.equipment_id === e.id) }));
    },
  });
  const rows = data.data ?? [];
  if (!rows.length) return null;

  return (
    <section className="stack-sm">
      <div className="section-head">
        <h2 className="section-title">Your equipment</h2>
        <Link to="/equipment" className="small">All equipment</Link>
      </div>
      <div className="card">
        {rows.map((e) => {
          const next = e.plans[0];
          const due = next && next.state !== "ok" ? next : null;
          return (
            <div key={e.id} className="card-row wrap">
              <Link to={`/equipment/${e.id}`} className="grow" style={{ color: "var(--ink)", minWidth: 160 }}>
                <strong>{e.name}</strong>
                <span className="muted small" style={{ display: "block" }}>
                  {e.status === "in_shop" ? "In the shop" : [e.meter !== "none" && e.meter_reading != null ? formatMeter(e.meter_reading, e.meter) : null, due ? `${due.name}: ${dueSummary(due).toLowerCase()}` : next ? `Next: ${next.name}` : null].filter(Boolean).join(" · ")}
                </span>
              </Link>
              {due && <StatusPill label={due.state === "overdue" ? "Overdue" : "Due soon"} tone={dueTone(due.state)} />}
              <span className="row" style={{ gap: 6 }}>
                {e.meter !== "none" && <Button size="sm" icon="gauge" onClick={() => setLog({ equipment: e, kind: "reading" })}>{e.meter === "miles" ? "Log miles" : "Log hours"}</Button>}
                {/* Outlined like Log hours: My day's green button is the visit's next step. */}
                {due && <Button size="sm" icon="check" onClick={() => setLog({ equipment: e, kind: "service", planId: due.plan_id })}>Mark done</Button>}
              </span>
            </div>
          );
        })}
      </div>
      {log && (
        <LogDialog
          equipment={log.equipment}
          plans={rows.find((r) => r.id === log.equipment.id)?.plans.map((p) => ({ plan_id: p.plan_id, name: p.name })) ?? []}
          kind={log.kind}
          planId={log.planId}
          onClose={() => setLog(null)}
        />
      )}
    </section>
  );
}
