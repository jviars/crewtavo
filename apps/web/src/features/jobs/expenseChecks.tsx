/**
 * What Add expense shows the office about a supplier invoice's lines (expenseMaterials.ts has the
 * rule): under a line whose material the crew already logged, that it's there and isn't logged
 * again; and before saving, how the expense will count in the job's costs. The office's alone
 * (people who see job costs), so these lines are in English for now: see docs/spanish-support-plan.md.
 */
import { Icon } from "@/components/ui/Icon";
import styles from "./jobMoney.module.css";
import { alreadyLoggedNote, planWords, type LinePlan, type MaterialsPlan } from "./expenseMaterials";

/** Under one line of the invoice: the tickets already on the job for its material, and "Log it too". */
export function LineAlreadyLogged({ plan, again, onAgain }: { plan: LinePlan | undefined; again: boolean; onAgain: (again: boolean) => void }) {
  const note = plan ? alreadyLoggedNote(plan) : null;
  if (!note) return null;
  return (
    <div className={styles.logged}>
      <span className={styles.note}>{note}</span>
      <label className="checkbox"><input type="checkbox" checked={again} onChange={(e) => onAgain(e.target.checked)} /> Log it too</label>
    </div>
  );
}

/** How the expense will count in job costing, said before it's saved. */
export function CostingNote({ plan, logMaterials, ticked }: { plan: MaterialsPlan; logMaterials: boolean; ticked: boolean }) {
  const words = planWords(plan, { logMaterials, ticked });
  if (!words) return null;
  return (
    <div className="callout callout-info" role="status">
      <Icon name="info" size={16} />
      <span className="grow">{words}</span>
    </div>
  );
}
