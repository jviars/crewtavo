/**
 * What Quo added to a call, under its title on the client's timeline and in a Messages bubble: the
 * voicemail's words, Quo's summary a line each, and its next steps as a short list. The words take
 * the colour of where they sit (a quiet timeline row, or a bubble of either side).
 */
import { t } from "@/lib/i18n";
import type { CallView } from "./callWords";
import styles from "./clients.module.css";

export function CallNotes({ view, clamp }: { view: Pick<CallView, "voicemail" | "summary" | "steps">; clamp?: boolean }) {
  if (!view.voicemail && !view.summary.length && !view.steps.length) return null;
  return (
    <div className={styles.callNotes}>
      {view.voicemail && <p className={clamp ? styles.clamped : undefined}>“{view.voicemail}”</p>}
      {view.summary.length > 0 && <div>{view.summary.map((line, i) => <p key={i}>{line}</p>)}</div>}
      {view.steps.length > 0 && (
        <div>
          <p className={styles.callLabel}>{t("Next steps")}</p>
          <ul>{view.steps.map((step, i) => <li key={i}>{step}</li>)}</ul>
        </div>
      )}
    </div>
  );
}
