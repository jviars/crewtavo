/**
 * Home: the few things that make Crewtavo the business's own, for owners and the office, here rather
 * than inside the quotes and invoices being worked on: in any trade, prices, payments, logo, team and
 * a first client, then options on a quote, and measuring for work priced by area or length. Each step ticks itself off once it's been done
 * (one small read finds out), the card goes when every step is done, and anyone can hide it for good.
 */
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { supabase, unwrap } from "@/lib/api";
import { can, hasRole, useSession, type Session } from "@/lib/session";
import { undoable } from "@/lib/undo";
import { useAutopayStatus } from "../settings/PaymentSettings";
import styles from "./Home.module.css";

export const seesSetup = (session: Session) => hasRole(session, "admin", "office") && can(session, "settings");

// Hidden on this device for this person in this company: there's no per-person setting to keep it in.
const hiddenKey = (companyId: string, userId: string) => `crewtavo.setup-hidden.${companyId}.${userId}`;

function readHidden(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function storeHidden(key: string) {
  try {
    localStorage.setItem(key, "1");
  } catch {
    // Storage full or blocked: it shows again next time, which is harmless.
  }
}

// Price list units a measurement fills in (areas, lengths, and tons worked out from an area).
const MEASURED_UNITS = "sq ?ft|sf|sq ?yd|sy|squares?|ft|feet|lf|linear ft|tons?";
const MEASURED_UNIT = new RegExp(`^(${MEASURED_UNITS})$`, "i");
// The same items, found by the database: a formula, or one of those units in any case with spaces around it.
const MEASURED_FILTER = `formula.neq."",unit.imatch."^[[:space:]]*(${MEASURED_UNITS})[[:space:]]*$"`;

/** One price list item: what's needed to tell whether the business made the list its own. */
type PriceRow = { unit: string; formula: string | null; created_at: string; updated_at: string };

/**
 * The price list is theirs once an item was changed (updated_at moves on an edit) or added after the
 * starter list (an hour after the business was made); it's priced by measuring when an item's unit
 * is an area or length, or a formula works it out from a measurement.
 */
export function priceListState(companyCreatedAt: string, services: PriceRow[]) {
  const settled = new Date(companyCreatedAt).getTime() + 60 * 60_000;
  return {
    prices: services.some((s) => s.updated_at > s.created_at || new Date(s.created_at).getTime() > settled),
    measures: services.some((s) => Boolean(s.formula) || MEASURED_UNIT.test(s.unit.trim())),
  };
}

/**
 * Whether each step has been done, from one small read: the team, any client, quote with options or
 * measurement, and of the price list only the items the rules need: the one changed last, the one
 * added last, and one priced by measuring.
 * shortcut: an item changed and then another added, both in the business's first hour and nothing
 * since, reads as the starter list; fetch every item's dates if that ever matters.
 */
export function useSetupSteps(enabled: boolean) {
  const { company } = useSession();
  return useQuery({
    queryKey: ["setup", company.id],
    enabled,
    meta: { silent: true },
    queryFn: async () => {
      // One request: the company with at most one or two of each, by id, and three price list items.
      const item = "unit, formula, created_at, updated_at";
      const row = unwrap(
        await supabase()
          .from("companies")
          .select(`id, created_at, clients!clients_company_id_fkey(id), memberships(user_id), quote_options(id), measurements(id), changed:services(${item}), added:services(${item}), measured:services(${item})`)
          .eq("id", company.id)
          .limit(1, { referencedTable: "clients" })
          .limit(2, { referencedTable: "memberships" })
          .limit(1, { referencedTable: "quote_options" })
          .limit(1, { referencedTable: "measurements" })
          .order("updated_at", { referencedTable: "changed", ascending: false })
          .limit(1, { referencedTable: "changed" })
          .order("created_at", { referencedTable: "added", ascending: false })
          .limit(1, { referencedTable: "added" })
          .or(MEASURED_FILTER, { referencedTable: "measured" })
          .limit(1, { referencedTable: "measured" })
          .single(),
      );
      return {
        ...priceListState(row.created_at, [...row.changed, ...row.added, ...row.measured]),
        client: row.clients.length > 0,
        team: row.memberships.length > 1,
        options: row.quote_options.length > 0,
        measured: row.measurements.length > 0,
      };
    },
  });
}

export function SetupCard() {
  const session = useSession();
  const key = hiddenKey(session.company.id, session.userId);
  const [hidden, setHidden] = useState(() => readHidden(key));
  const steps = useSetupSteps(seesSetup(session) && !hidden);
  // Online payments are for the people who look after money (Settings → Payments shows them the same).
  const takesMoney = hasRole(session, "admin") && can(session, "invoices");
  const payments = useAutopayStatus(seesSetup(session) && !hidden && takesMoney);
  if (hidden || !steps.data || (takesMoney && payments.isPending)) return null;
  const logo = Boolean((session.company.settings.branding as { logo?: string } | undefined)?.logo);
  const list = [
    { key: "prices", show: true, done: steps.data.prices, title: "Set your prices", detail: "Your services and what you charge, so quotes and invoices fill themselves in.", to: "/settings?tab=prices" },
    { key: "payments", show: takesMoney, done: Boolean(payments.data?.connected), title: "Take payments online", detail: "Clients pay their invoices by card or bank from the link you send.", to: "/settings?tab=payments" },
    { key: "logo", show: hasRole(session, "admin"), done: logo, title: "Add your logo", detail: "On your quotes, invoices and the client's portal.", to: "/settings?tab=company" },
    { key: "team", show: hasRole(session, "admin") && can(session, "team"), done: steps.data.team, title: "Invite your team", detail: "The office and your crews, each seeing what their role allows.", to: "/settings?tab=team" },
    { key: "client", show: true, done: steps.data.client, title: "Add your first client", detail: "Or bring your clients over from Jobber or a spreadsheet.", to: "/clients" },
    { key: "options", show: true, done: steps.data.options, title: "Offer options on a quote", detail: "Good, Better and Best side by side, and the client picks one.", to: "/quotes" },
    // Only for work priced by area or length: a plumber's price list has nothing to measure.
    { key: "measure", show: steps.data.measures, done: steps.data.measured, title: "Measure a property from the map", detail: "Areas, lengths and roofs drawn over the satellite view.", to: "/measure" },
  ].filter((s) => s.show);
  const done = list.filter((s) => s.done).length;
  if (done === list.length) return null;
  const hide = () =>
    undoable({
      title: "Setup checklist hidden",
      hide: () => setHidden(true),
      restore: () => setHidden(false),
      commit: () => storeHidden(key),
    });
  return (
    // Its check usually lands after the rest of Home, so it fades in rather than popping in.
    <section className="card" aria-labelledby="setup-title" style={{ animation: "fade-in var(--dur-enter) var(--ease-enter)" }}>
      <div className="card-head">
        <strong id="setup-title">Set up Crewtavo</strong>
        <span className="muted small">{done} of {list.length} done</span>
        <Button size="sm" variant="ghost" onClick={hide}>Hide</Button>
      </div>
      {list.map((s) => (
        <Link key={s.key} to={s.to} className={`card-row ${styles.step}`} data-done={s.done || undefined}>
          <span className={styles.mark} aria-hidden="true">{s.done && <Icon name="check" size={12} strokeWidth={2} />}</span>
          <span className="grow" style={{ minWidth: 0 }}>
            <span className={styles.stepTitle}>
              {s.title}
              {s.done && <span className="sr-only"> (done)</span>}
            </span>
            <span className="muted small" style={{ display: "block" }}>{s.detail}</span>
          </span>
          <Icon name="chevronRight" size={16} />
        </Link>
      ))}
    </section>
  );
}
