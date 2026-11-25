/**
 * A part of Reviews' or Referrals' setup that's done, folded to what it does in a line or two, with
 * Edit to open its form (Teachable's referral program summary). Setup is set once and asking happens
 * every day, so once it's done the asking comes first and the setup takes a line each.
 */
import type { ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import styles from "./Presence.module.css";

export function SetupSummary({ lines, onEdit, editLabel = "Edit" }: { lines: ReactNode[]; onEdit: () => void; editLabel?: string }) {
  return (
    <div className={styles.summary}>
      <div className={styles.summaryText}>
        {lines.filter(Boolean).map((line, i) => <p key={i} className={i ? styles.note : styles.summaryLead}>{line}</p>)}
      </div>
      <Button size="sm" icon="edit" onClick={onEdit}>{editLabel}</Button>
    </div>
  );
}
