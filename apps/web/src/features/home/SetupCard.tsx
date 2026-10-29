/**
 * Home: the few things that make Crewtavo the business's own, for owners and the office, here rather
 * than inside the quotes and invoices being worked on. Each step ticks itself off once it's been done
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

/** Whether each step has been done: any contract section, any quote with options, any measurement. */
export function useSetupSteps(enabled: boolean) {
  const { company } = useSession();
  return useQuery({
    queryKey: ["setup", company.id],
    enabled,
    meta: { silent: true },
    queryFn: async () => {
      // One request: the company with at most one of each, by id.
      const row = unwrap(
        await supabase()
          .from("companies")
          .select("id, contract_sections(id), quote_options(id), measurements(id)")
          .eq("id", company.id)
          .limit(1, { referencedTable: "contract_sections" })
          .limit(1, { referencedTable: "quote_options" })
          .limit(1, { referencedTable: "measurements" })
          .single(),
      );
      return { contracts: row.contract_sections.length > 0, options: row.quote_options.length > 0, measured: row.measurements.length > 0 };
    },
  });
}

export function SetupCard() {
  const session = useSession();
  const key = hiddenKey(session.company.id, session.userId);
  const [hidden, setHidden] = useState(() => readHidden(key));
  const steps = useSetupSteps(seesSetup(session) && !hidden);
  if (hidden || !steps.data) return null;
  const list = [
    { key: "contracts", done: steps.data.contracts, title: "Add your contract terms", detail: "Payment, your warranty and the right to cancel, printed with your estimates.", to: "/settings?tab=contracts" },
    { key: "options", done: steps.data.options, title: "Offer options on a quote", detail: "Good, Better and Best side by side, and the client picks one.", to: "/quotes" },
    { key: "measure", done: steps.data.measured, title: "Measure a property from the map", detail: "Areas, lengths and roofs drawn over the satellite view.", to: "/measure" },
  ];
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
