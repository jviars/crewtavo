/**
 * Under one of Home's side figures: the change in green or red words and what it's against ("+12%
 * vs. Oct 1–21", "−4% vs. last week"). Unchanged, the words say "Same as …" on their own; with
 * nothing to compare with, there's no line.
 */
import { Change } from "../finance/change";
import styles from "./Home.module.css";

export function ChangeLine({ now, before, compared, same, vs }: { now: number; before: number; compared: string; same: string; vs: string }) {
  if (!before) return null;
  const changed = Math.round(((now - before) / Math.abs(before)) * 100) !== 0;
  return (
    <p className={styles.delta}>
      <Change now={now} before={before} compared={compared} same={same} />
      {changed && <span aria-hidden="true">vs. {vs}</span>}
    </p>
  );
}
