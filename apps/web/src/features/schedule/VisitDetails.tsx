/**
 * A visit at a glance, the way Google Calendar opens an event: when, where (tap for directions in
 * your maps app), who it's for, the crew and people, equipment, gate code and instructions. Edit
 * opens the visit form; nothing changes from here by accident. A sheet on phones.
 */
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Icon } from "@/components/ui/Icon";
import { MapsLink } from "@/components/ui/MapsLink";
import { Skeleton } from "@/components/ui/Skeleton";
import { ErrorState } from "@/components/ui/States";
import { StatusPill, statusLabel, statusText, visitTone } from "@/components/ui/StatusPill";
import { supabase, unwrap, unwrapOne } from "@/lib/api";
import { addressLine, formatTime } from "@/lib/format";
import { hasRole, useSession } from "@/lib/session";
import { lengthLabel } from "./VisitDialog";

const day = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });

export function VisitDetails({ visitId, onClose, onEdit }: { visitId: string; onClose: () => void; onEdit?: () => void }) {
  const session = useSession();
  const tz = session.company.timezone;
  const office = hasRole(session, "admin", "office", "estimator");
  const visit = useQuery({
    queryKey: ["visit-details", visitId],
    queryFn: async () =>
      unwrapOne(
        await supabase()
          .from("visits")
          .select(
            "id, title, kind, status, scheduled_on, starts_at, ends_at, route_order, time_fixed, notes, hold_reason, series_day, series_total, crew:crews(name, color), assignees:visit_assignees(user_id), equipment:visit_equipment(equipment:equipment(name)), job:jobs(id, number, title, instructions, client:clients(id, display_name, phone, email)), request:requests(id, title, details, client:clients(id, display_name, phone, email)), property:properties(id, label, line1, line2, city, region, postal_code, lat, lng, notes)",
          )
          .eq("id", visitId)
          .maybeSingle(),
        "This visit",
      ),
  });
  const v = visit.data;
  const people = useQuery({
    queryKey: ["visit-details", visitId, "people", v?.assignees.map((a) => a.user_id).join(",")],
    enabled: Boolean(v?.assignees.length),
    meta: { silent: true },
    queryFn: async () => unwrap(await supabase().from("profiles").select("user_id, full_name").in("user_id", v!.assignees.map((a) => a.user_id))),
  });
  const access = useQuery({
    queryKey: ["visit-details", visitId, "access"],
    enabled: Boolean(v?.property),
    meta: { silent: true },
    queryFn: async () => unwrap(await supabase().from("property_access").select("gate_code, lockbox_code, instructions").eq("property_id", v!.property!.id))[0] ?? null,
  });

  const client = v?.job?.client ?? v?.request?.client ?? null;
  const minutes = v?.starts_at && v.ends_at ? Math.round((Date.parse(v.ends_at) - Date.parse(v.starts_at)) / 60_000) : null;
  const when = v
    ? `${v.scheduled_on ? day(v.scheduled_on) : "Not scheduled yet"}${v.starts_at ? ` · ${formatTime(v.starts_at, tz)}${v.ends_at ? ` – ${formatTime(v.ends_at, tz)}` : ""}` : v.scheduled_on ? " · Anytime" : ""}`
    : "";
  const codes = access.data;
  const names = (people.data ?? []).map((p) => p.full_name).filter(Boolean);

  return (
    <Dialog open onClose={onClose} title={v?.title ?? "Visit"} description={v?.job ? <>Job #{v.job.number}{client ? ` · ${client.display_name}` : ""}</> : client?.display_name}>
      <div className="dialog-body">
        {visit.error && <ErrorState error={visit.error} onRetry={() => visit.refetch()} />}
        {visit.isPending && <><Skeleton width="60%" /><Skeleton width="80%" /><Skeleton width="40%" /></>}
        {v && (
          <>
            <div className="row wrap" style={{ gap: 6 }}>
              <StatusPill label={statusText("visit", v.status)} tone={visitTone(v.status)} />
              {v.kind !== "job" && <span className="chip">{statusLabel(v.kind)}</span>}
              {v.route_order && v.status === "scheduled" && <span className="chip"><Icon name="navigation" size={12} />Stop {v.route_order}</span>}
              {v.time_fixed && v.starts_at && <span className="chip chip-blue"><Icon name="lock" size={12} />Fixed time</span>}
              {v.series_total && v.series_total > 1 && <span className="chip chip-blue">Day {v.series_day} of {v.series_total}</span>}
            </div>

            <div className="visit-facts">
              <Icon name="clock" size={16} />
              <div>
                {when}
                {minutes != null && <span className="muted"> ({lengthLabel(minutes)})</span>}
              </div>

              {v.property && (
                <>
                  <Icon name="pin" size={16} />
                  <div>
                    {v.property.label && <strong style={{ display: "block" }}>{v.property.label}</strong>}
                    <MapsLink className="address-link" place={v.property}>{addressLine(v.property)}</MapsLink>
                    {(codes?.gate_code || codes?.lockbox_code) && (
                      <span className="row wrap small" style={{ gap: 12, marginTop: 4 }}>
                        {codes.gate_code && <span><Icon name="lock" size={13} /> Gate <strong>{codes.gate_code}</strong></span>}
                        {codes.lockbox_code && <span><Icon name="lock" size={13} /> Lockbox <strong>{codes.lockbox_code}</strong></span>}
                      </span>
                    )}
                    {codes?.instructions && <span className="muted small pre-wrap" style={{ display: "block", marginTop: 4 }}>{codes.instructions}</span>}
                    {v.property.notes && <span className="muted small pre-wrap" style={{ display: "block", marginTop: 4 }}>{v.property.notes}</span>}
                  </div>
                </>
              )}

              {client && (
                <>
                  <Icon name="user" size={16} />
                  <div>
                    {office ? <Link to={`/clients/${client.id}`}>{client.display_name}</Link> : client.display_name}
                    {client.phone && <> · <a href={`tel:${client.phone}`}>{client.phone}</a></>}
                    {office && client.email && <span className="muted small" style={{ display: "block" }}>{client.email}</span>}
                  </div>
                </>
              )}

              {(v.crew || names.length > 0) && (
                <>
                  <Icon name="users" size={16} />
                  <div>
                    {v.crew && <span className="row" style={{ gap: 6, display: "inline-flex" }}><i style={{ width: 10, height: 10, borderRadius: 3, background: v.crew.color ?? "var(--text-4)" }} />{v.crew.name}</span>}
                    {names.length > 0 && <span className="muted" style={{ display: "block" }}>{names.join(", ")}</span>}
                  </div>
                </>
              )}

              {v.equipment.length > 0 && (
                <>
                  <Icon name="truck" size={16} />
                  <div>{v.equipment.map((e) => e.equipment?.name).filter(Boolean).join(", ")}</div>
                </>
              )}

              {v.hold_reason && (
                <>
                  <Icon name="cloud" size={16} />
                  <div style={{ color: "var(--warning)", fontWeight: 700 }}>Weather: {v.hold_reason}</div>
                </>
              )}

              {(v.notes || v.job?.instructions || v.request?.details) && (
                <>
                  <Icon name="note" size={16} />
                  <div className="stack-sm">
                    {v.notes && <span className="pre-wrap">{v.notes}</span>}
                    {v.job?.instructions && <span className="pre-wrap muted">{v.job.instructions}</span>}
                    {!v.job && v.request?.details && <span className="pre-wrap muted">{v.request.details}</span>}
                  </div>
                </>
              )}
            </div>

            <div className="visit-actions">
              {onEdit && <Button variant="primary" icon="edit" onClick={onEdit}>Edit</Button>}
              {v.property && <MapsLink className="btn" place={v.property}><Icon name="navigation" size={16} />Directions</MapsLink>}
              {client?.phone && <a className="btn" href={`tel:${client.phone}`}><Icon name="phone" size={16} />Call</a>}
              {client?.phone && <a className="btn" href={`sms:${client.phone}`}><Icon name="messages" size={16} />Text</a>}
              {office && v.job && <Link className="btn" to={`/jobs/${v.job.id}`} onClick={onClose}><Icon name="job" size={16} />Open job</Link>}
              {!office && <Link className="btn" to={`/field/visits/${v.id}`} onClick={onClose}><Icon name="clipboard" size={16} />Open visit</Link>}
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}
