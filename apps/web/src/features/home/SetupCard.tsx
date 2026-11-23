/**
 * Home: the few things that make Crewtavo the business's own, for owners and the office, here rather
 * than inside the quotes and invoices being worked on: in any trade, prices, payments, logo, email and
 * texting (so the first quote can go out), team and a first client, then options on a quote, and
 * measuring for work priced by area or length. Each step ticks itself off once it's been done
 * (one small read finds out), the checklist goes when every step is done, and anyone can hide it for good.
 *
 * Setup-Flow.dc.html: done steps first and quiet, then the step that's up next with what it's for and
 * a button, then the rest with how long each takes. On a business's first visit it is Home (full);
 * once there's work it sits at the top of Home's side column (rail).
 */
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { cx } from "@/components/ui/Button";
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

/** One step: where it's done, about how long it takes, and the words on its button while it's up next. */
export interface SetupStep {
  key: string;
  show: boolean;
  done: boolean;
  title: string;
  detail: string;
  to: string;
  minutes: number;
  action: string;
}

/**
 * Email and texting, before the first quote goes out: connecting the business's own mailbox
 * (Settings → Email) and its own Twilio account (Apps → Twilio). Each is done once this business
 * can send that way, its own or the server's. For the people who can connect them.
 */
export function sendingSteps(session: Pick<Session, "role" | "permissions" | "config">): SetupStep[] {
  const admin = hasRole(session, "admin");
  return [
    {
      key: "email", show: admin && (can(session, "apps") || can(session, "settings")), done: session.config.features.email,
      title: "Connect your email", detail: "Quotes, invoices and reminders go out from your own address.", to: "/settings?tab=email", minutes: 2, action: "Connect email",
    },
    {
      key: "texting", show: admin && can(session, "apps"), done: session.config.features.sms,
      title: "Turn on texting", detail: "Reminders and on-my-way texts from your own number, with your Twilio account.", to: "/apps/twilio", minutes: 5, action: "Connect Twilio",
    },
  ];
}

/** Done steps first (they keep their order), then the rest in the order they're best done in. */
export function orderSteps<T extends { done: boolean }>(steps: T[]): { done: T[]; next: T | null; rest: T[] } {
  const done = steps.filter((s) => s.done);
  const [next = null, ...rest] = steps.filter((s) => !s.done);
  return { done, next, rest };
}

export type Setup =
  | { state: "off" }
  | { state: "loading" }
  | { state: "ready"; steps: SetupStep[]; done: number; hide: () => void };

/**
 * The checklist for this person: off when it isn't theirs, when it's hidden or when every step is
 * done; loading while its one read is under way.
 */
export function useSetup(): Setup {
  const session = useSession();
  const key = hiddenKey(session.company.id, session.userId);
  const [hidden, setHidden] = useState(() => readHidden(key));
  const mine = seesSetup(session) && !hidden;
  const steps = useSetupSteps(mine);
  // Online payments are for the people who look after money (Settings → Payments shows them the same).
  const takesMoney = hasRole(session, "admin") && can(session, "invoices");
  const payments = useAutopayStatus(mine && takesMoney);
  if (!mine || steps.isError) return { state: "off" };
  if (!steps.data || (takesMoney && payments.isPending)) return { state: "loading" };
  const logo = Boolean((session.company.settings.branding as { logo?: string } | undefined)?.logo);
  const list: SetupStep[] = [
    { key: "prices", show: true, done: steps.data.prices, title: "Set your prices", detail: "Your services and what you charge, so quotes and invoices fill themselves in.", to: "/settings?tab=prices", minutes: 5, action: "Set prices" },
    { key: "payments", show: takesMoney, done: Boolean(payments.data?.connected), title: "Take payments online", detail: "Clients pay their invoices by card or bank from the link you send.", to: "/settings?tab=payments", minutes: 3, action: "Connect Stripe" },
    { key: "logo", show: hasRole(session, "admin"), done: logo, title: "Add your logo", detail: "On your quotes, invoices and the client's portal.", to: "/settings?tab=company", minutes: 1, action: "Add logo" },
    ...sendingSteps(session),
    { key: "team", show: hasRole(session, "admin") && can(session, "team"), done: steps.data.team, title: "Invite your team", detail: "The office and your crews, each seeing what their role allows.", to: "/settings?tab=team", minutes: 3, action: "Invite people" },
    { key: "client", show: true, done: steps.data.client, title: "Add your first client", detail: "Or bring your clients over from Jobber or a spreadsheet.", to: "/clients", minutes: 1, action: "Add a client" },
    { key: "options", show: true, done: steps.data.options, title: "Offer options on a quote", detail: "Good, Better and Best side by side, and the client picks one.", to: "/quotes", minutes: 3, action: "Open quotes" },
    // Only for work priced by area or length: a plumber's price list has nothing to measure.
    { key: "measure", show: steps.data.measures, done: steps.data.measured, title: "Measure a property from the map", detail: "Areas, lengths and roofs drawn over the satellite view.", to: "/measure", minutes: 2, action: "Open the map" },
  ].filter((s) => s.show);
  const done = list.filter((s) => s.done).length;
  if (done === list.length) return { state: "off" };
  const hide = () =>
    undoable({
      title: "Setup checklist hidden",
      hide: () => setHidden(true),
      restore: () => setHidden(false),
      commit: () => storeHidden(key),
    });
  return { state: "ready", steps: list, done, hide };
}

/**
 * The checklist itself. `full` is the first visit's (Setup-Flow.dc.html, Home, first visit): a
 * progress bar, what each step is for, and the step up next as the screen's one green button. In the
 * side column it's shorter: titles and minutes, the step up next with an outlined button.
 */
export function SetupChecklist({ steps, done, full }: { steps: SetupStep[]; done: number; full?: boolean }) {
  const order = orderSteps(steps);
  return (
    <div className={styles.setup} data-full={full || undefined}>
      {full && (
        <div className={styles.progress}>
          <span className={styles.meter} aria-hidden="true"><span style={{ width: `${(done / steps.length) * 100}%` }} /></span>
          {done} of {steps.length} done
        </div>
      )}
      {order.done.length > 0 && (
        <ul className={styles.steps} role="list" aria-label="Done">
          {order.done.map((s) => (
            <li key={s.key}>
              <Link to={s.to} className={styles.step} data-done>
                <span className={styles.ring} aria-hidden="true"><Icon name="check" size={12} bold /></span>
                <span className={styles.stepText}>
                  <span className={styles.stepTitle}>{s.title}<span className="sr-only"> (done)</span></span>
                </span>
                {/* The side column's done steps are the check and the struck title alone (Page-Home.dc.html). */}
                {full && <span className={styles.stepEnd} aria-hidden="true">Done</span>}
              </Link>
            </li>
          ))}
        </ul>
      )}
      {order.next && (
        <Link to={order.next.to} className={styles.next}>
          <span className={styles.ring} aria-hidden="true" />
          <span className={styles.stepText}>
            <span className={styles.stepTitle}>
              {order.next.title}
              <span className={styles.upNext}>Up next</span>
            </span>
            <span className={styles.stepDetail}>{order.next.detail}</span>
          </span>
          <span className={cx("btn btn-sm", full && "btn-primary", styles.nextButton)} aria-hidden="true">{order.next.action}</span>
        </Link>
      )}
      {order.rest.length > 0 && (
        <ul className={styles.steps} role="list" aria-label="Still to do">
          {order.rest.map((s) => (
            <li key={s.key}>
              <Link to={s.to} className={styles.step}>
                <span className={styles.ring} aria-hidden="true" />
                <span className={styles.stepText}>
                  <span className={styles.stepTitle}>{s.title}</span>
                  {full && <span className={styles.stepDetail}>{s.detail}</span>}
                </span>
                <span className={styles.stepEnd}>{minutes(s.minutes)}</span>
                <span className={styles.stepChevron} aria-hidden="true"><Icon name="chevronRight" size={16} /></span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const minutes = (n: number) => `${n} min`;
