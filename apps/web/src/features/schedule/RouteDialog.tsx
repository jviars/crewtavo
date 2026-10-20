/**
 * Organize route: a crew's day in the shortest order, starting (and ending) at the shop, with each
 * stop's time once mowing and driving are counted. Fixed times stay put. The person scheduling can
 * move stops up and down to set the order by hand, then save it to the calendar, with Undo. The
 * API plans it (apps/api/src/services/routes.ts); nothing changes until Save.
 */
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { Skeleton } from "@/components/ui/Skeleton";
import { ErrorState } from "@/components/ui/States";
import { statusLabel } from "@/components/ui/StatusPill";
import { api } from "@/lib/api";
import { formatTime } from "@/lib/format";
import { useSession } from "@/lib/session";
import { toast } from "@/lib/toast";

interface RouteStopRow {
  id: string;
  title: string;
  status: string;
  client: string | null;
  address: string | null;
  lat: number | null;
  lng: number | null;
  order: number | null;
  starts_at: string | null;
  ends_at: string | null;
  was_order: number | null;
  was_starts_at: string | null;
  minutes?: number;
  drive_min?: number;
  drive_miles?: number;
  fixed?: boolean;
  late?: boolean;
  located?: boolean;
}
interface RoutePreview {
  times: boolean;
  shop: { lat: number; lng: number } | null;
  return_to_shop: boolean;
  by_hand: boolean;
  organized_at: string | null;
  miles_before: number;
  miles_after: number;
  finish: string | null;
  late_finish: boolean;
  changes: number;
  warnings: string[];
  started: RouteStopRow[];
  stops: RouteStopRow[];
}
type Previous = Array<{ id: string; route_order: number | null; starts_at: string | null; ends_at: string | null }>;

const day = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: "UTC" });

export function RouteDialog({ date, crewId, crewName, onClose }: { date: string; crewId: string; crewName: string; onClose: () => void }) {
  const session = useSession();
  const tz = session.company.timezone;
  const queryClient = useQueryClient();
  // null: the shortest order. A list: the order someone set by hand.
  const [order, setOrder] = useState<string[] | null>(null);
  const crew = crewId || null;
  const preview = useQuery({
    queryKey: ["route-preview", session.company.id, date, crewId, order?.join(",") ?? "shortest"],
    placeholderData: keepPreviousData,
    queryFn: () => api.post<RoutePreview>("/schedule/route/preview", { date, crew_id: crew, ...(order && { order }) }),
  });
  const p = preview.data;

  const undo = useMutation({
    meta: { success: "Route put back" },
    mutationFn: (previous: Previous) => api.post("/schedule/route/undo", { date, crew_id: crew, visits: previous }),
    onSettled: () => refresh(),
  });
  const refresh = () => {
    for (const key of ["schedule", "field", "dashboard", "visit-details"]) queryClient.invalidateQueries({ queryKey: [key] });
  };
  const save = useMutation({
    meta: { inline: true },
    mutationFn: () => api.post<{ saved: number; previous: Previous }>("/schedule/route", { date, crew_id: crew, order: p!.stops.map((s) => s.id), by_hand: order !== null }),
    onSuccess: (r) => {
      refresh();
      toast.success(r.saved ? `Route saved: ${r.saved} ${r.saved === 1 ? "visit" : "visits"} changed` : "Route saved. Nothing needed to change.", r.saved ? { action: { label: "Undo", onClick: () => undo.mutate(r.previous) } } : undefined);
      onClose();
    },
  });

  const move = (index: number, by: -1 | 1) => {
    if (!p) return;
    const ids = p.stops.map((s) => s.id);
    const [id] = ids.splice(index, 1);
    ids.splice(index + by, 0, id!);
    setOrder(ids);
  };

  const timeOf = (s: RouteStopRow) => (s.starts_at ? formatTime(s.starts_at, tz) : p?.times ? "After midnight" : "Anytime");
  const saved = p && !p.changes && p.organized_at;

  return (
    <Dialog open onClose={onClose} title={`Route · ${crewName}`} description={day(date)} size="lg">
      <div className="dialog-body">
        {preview.error && !p && <ErrorState error={preview.error} onRetry={() => preview.refetch()} />}
        {preview.isPending && <><Skeleton height={170} radius={12} /><Skeleton width="70%" /><Skeleton width="50%" /></>}
        {p && (
          <>
            <div className="route-summary" aria-live="polite">
              {p.stops.length ? (
                <>
                  <span>
                    <Icon name="navigation" size={14} /> About <strong>{p.miles_after} miles</strong> of driving
                    {p.miles_before > p.miles_after + 0.05 && <span className="muted"> (now {p.miles_before})</span>}
                  </span>
                  {p.times && p.finish && <span style={p.late_finish ? { color: "var(--warning)" } : undefined}><Icon name="clock" size={14} /> Done around <strong>{p.finish}</strong></span>}
                  <span className="muted">{saved ? "This is the saved route." : order ? "Your order" : "Shortest order"}</span>
                </>
              ) : (
                <span className="muted">No open stops on this day.</span>
              )}
              {preview.isFetching && <span className="spinner" style={{ width: 14, height: 14 }} aria-label="Updating" />}
            </div>

            {p.stops.some((s) => s.located) && <RouteSketch shop={p.shop} back={p.return_to_shop} stops={p.stops} />}

            {p.warnings.length > 0 && (
              <div className="callout callout-warning">
                <Icon name="alert" size={16} />
                <div className="grow small stack-sm" style={{ fontWeight: 400 }}>{p.warnings.map((w) => <span key={w}>{w}</span>)}</div>
              </div>
            )}
            {!p.times && <p className="muted small" style={{ margin: 0 }}>Stops are numbered and left as anytime that day, as Settings → Schedule says. Fixed times stay.</p>}

            <ol className="route-list" aria-label="Stops in order">
              {p.started.map((s) => (
                <li key={s.id} className="route-stop" data-started>
                  <span className="route-num"><Icon name="check" size={12} strokeWidth={3} /></span>
                  <span style={{ minWidth: 0 }}>
                    <strong>{s.title}</strong>
                    <span className="muted small" style={{ display: "block" }}>{statusLabel(s.status)}{s.address ? ` · ${s.address}` : ""}</span>
                  </span>
                  <span />
                </li>
              ))}
              {p.stops.map((s, i) => (
                <li key={s.id} className="route-stop" data-fixed={s.fixed || undefined} data-late={s.late || undefined}>
                  {(s.drive_min ?? 0) > 0 && (
                    <span className="route-drive"><Icon name="truck" size={12} /> {s.drive_min} min drive · {s.drive_miles} mi</span>
                  )}
                  <span className="route-num">{s.order}</span>
                  <span style={{ minWidth: 0 }}>
                    <strong>{timeOf(s)}</strong> · {s.title}
                    <span className="muted small" style={{ display: "block" }}>
                      {[s.client, s.address].filter(Boolean).join(" · ") || "No address"}
                      {s.fixed && " · fixed time"}
                      {s.located === false && " · no map location"}
                      {s.was_starts_at && s.starts_at !== s.was_starts_at && !s.fixed && <> · was {formatTime(s.was_starts_at, tz)}</>}
                    </span>
                  </span>
                  <span className="route-moves">
                    <Button size="sm" variant="ghost" icon="chevronUp" aria-label={`Move ${s.title} earlier`} disabled={i === 0} onClick={() => move(i, -1)} />
                    <Button size="sm" variant="ghost" icon="chevronDown" aria-label={`Move ${s.title} later`} disabled={i === p.stops.length - 1} onClick={() => move(i, 1)} />
                  </span>
                </li>
              ))}
            </ol>
            <p className="muted small" style={{ margin: 0 }}>
              Times count each visit's length and the drive between stops ({p.return_to_shop ? "starting and ending at the shop" : "starting at the shop"}). Use the arrows to set the order by hand.
            </p>
            <FormError error={save.error} />
          </>
        )}
        <div className="form-actions">
          {order && <Button variant="ghost" icon="refresh" onClick={() => setOrder(null)}>Shortest route</Button>}
          <span className="spacer" />
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon="navigation" loading={save.isPending} disabled={!p?.stops.length || preview.isFetching} onClick={() => save.mutate()}>Save route</Button>
        </div>
      </div>
    </Dialog>
  );
}

/** A small drawing of the route: the shop (square), numbered stops and the way between them. */
function RouteSketch({ shop, back, stops }: { shop: { lat: number; lng: number } | null; back: boolean; stops: RouteStopRow[] }) {
  const located = stops.filter((s) => s.lat != null && s.lng != null) as Array<RouteStopRow & { lat: number; lng: number }>;
  const points = [...(shop ? [shop] : []), ...located];
  const W = 600;
  const H = 170;
  const pad = 18;
  const lat0 = (points.reduce((sum, q) => sum + q.lat, 0) / points.length) * (Math.PI / 180);
  const xs = points.map((q) => q.lng * Math.cos(lat0));
  const ys = points.map((q) => -q.lat);
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const scale = Math.min((W - 2 * pad) / (maxX - minX || 1e-9), (H - 2 * pad) / (maxY - minY || 1e-9));
  const offX = (W - (maxX - minX) * scale) / 2;
  const offY = (H - (maxY - minY) * scale) / 2;
  const at = (q: { lat: number; lng: number }) => [offX + (q.lng * Math.cos(lat0) - minX) * scale, offY + (-q.lat - minY) * scale] as const;
  const line = (list: Array<{ lat: number; lng: number }>) => list.map((q, i) => `${i ? "L" : "M"}${at(q).join(" ")}`).join(" ");
  return (
    <svg className="route-sketch" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" role="img" aria-label={`Map sketch of ${located.length} stops`}>
      <path d={line([...(shop ? [shop] : []), ...located])} />
      {shop && back && located.length > 0 && <path data-back d={line([located.at(-1)!, shop])} />}
      {shop && (() => {
        const [x, y] = at(shop);
        return <rect x={x - 6} y={y - 6} width={12} height={12} rx={2}><title>Shop</title></rect>;
      })()}
      {located.map((s) => {
        const [x, y] = at(s);
        return (
          <g key={s.id}>
            <circle cx={x} cy={y} r={9}><title>{s.title}</title></circle>
            <text x={x} y={y}>{s.order}</text>
          </g>
        );
      })}
    </svg>
  );
}
