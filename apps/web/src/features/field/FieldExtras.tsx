/**
 * The extra work on a visit as the crew sees it: names, notes and quantities, never prices
 * (public.visit_extra_scope, for the people job_scope answers). On a repeating job the job's own
 * work is the same every visit; this is what's different about this one, whether the office put it
 * there or the crew added it on site (add_field_line). Kept on the phone with the visit, and work
 * added on this phone that hasn't gone yet shows meanwhile.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase, unwrap } from "@/lib/api";
import { pendingVisitExtras, type JobLineAdd } from "./fieldActions";
import { intlLocale, t } from "@/lib/i18n";

const qty = (n: number) => new Intl.NumberFormat(intlLocale(), { maximumFractionDigits: 2 }).format(n);

export interface ExtraScopeLine {
  id: string;
  name: string;
  description: string | null;
  quantity: number;
  unit: string;
  /** Added on site by the crew, or (not sent yet) waiting on this phone. */
  added_in_field: boolean;
  waiting?: boolean;
}

export const visitExtrasKey = (visitId: string) => ["field-visit", visitId, "extras"];

/** Extra work waiting on this phone as the visit's list shows it. */
export const waitingExtra = (w: Pick<JobLineAdd, "lineId" | "name" | "unit" | "quantity">): ExtraScopeLine => ({ id: w.lineId, name: w.name, description: null, quantity: w.quantity, unit: w.unit, added_in_field: true, waiting: true });

/** What the server lists, with the extra work added on this phone for the visit that hasn't gone yet. */
export function withWaitingExtras(lines: readonly ExtraScopeLine[], waiting: ReadonlyArray<Pick<JobLineAdd, "lineId" | "name" | "unit" | "quantity">>): ExtraScopeLine[] {
  return [...lines, ...waiting.filter((w) => !lines.some((l) => l.id === w.lineId)).map(waitingExtra)];
}

export function useVisitExtraScope(visitId: string, enabled = true) {
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: visitExtrasKey(visitId),
    enabled,
    meta: { silent: true },
    queryFn: async () => {
      const lines = unwrap(await supabase().rpc("visit_extra_scope", { p_visit: visitId })) as ExtraScopeLine[];
      return withWaitingExtras(lines, pendingVisitExtras(queryClient, visitId));
    },
  });
}

/** Work lines as the crew sees them: what, how many, and the office's note; never a price. */
export function WorkLines({ lines }: { lines: ReadonlyArray<{ id: string; name: string; description?: string | null; quantity: number | string; unit: string; waiting?: boolean }> }) {
  return (
    <ul className="work-lines">
      {lines.map((l) => (
        <li key={l.id}>
          <span className="work-line-name">{l.name}</span>
          {Number(l.quantity) !== 1 || l.unit !== "ea" ? <span className="work-line-qty tabular">{qty(Number(l.quantity))} {l.unit}</span> : null}
          {l.waiting && <span className="work-line-note">{t("Sends when you have signal")}</span>}
          {l.description && <span className="work-line-note pre-wrap">{l.description}</span>}
        </li>
      ))}
    </ul>
  );
}

/** "Extra work on this visit", or nothing when there's none. */
export function VisitExtraScope({ visitId, title = t("Extra work on this visit") }: { visitId: string; title?: string }) {
  const extras = useVisitExtraScope(visitId);
  if (!extras.data?.length) return null;
  return (
    <div className="work-extra">
      <h3 className="work-extra-title">{title}</h3>
      <WorkLines lines={extras.data} />
    </div>
  );
}
