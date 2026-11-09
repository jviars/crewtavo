/**
 * A roof that can't be measured from the air (trees over it, an old or blurry aerial, too cut up to
 * trace): the salesperson measures it on site instead. It's flagged on the quote, with why
 * (quotes.measure_on_site_at); with nobody picked it goes to whoever covers the address's zip
 * (Settings → Sales areas), and whoever it goes to is told (supabase/migrations/…_sales_areas.sql).
 * Until the roof is drawn, the first step says who's going and why.
 */
import { useMutation } from "@tanstack/react-query";
import { useId, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Field, FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { supabase, unwrap } from "@/lib/api";
import type { EstimateQuote } from "../estimate";
import { useRefreshProject, useTeam } from "./data";
import styles from "./flow.module.css";
import { personName, salesPeople } from "./model";
import { SalespersonSelect } from "./RangeCard";

const REASONS = ["Trees cover the roof", "The aerial is old or blurry", "Too cut up to trace", "Something else"] as const;
const OTHER = REASONS[3];

/** "Trees cover the roof. The back half is under the oaks", or just the note for something else. */
export function onSiteReason(choice: string, note: string): string {
  const said = note.trim();
  if (choice === OTHER) return said;
  return said ? `${choice}. ${said}` : choice;
}

/** Flag the roof to measure on site (with why, and who goes), or take the flag off with null. */
function useMeasureOnSite(quoteId: string) {
  const refresh = useRefreshProject(quoteId);
  return useMutation({
    meta: { inline: true },
    mutationFn: async (flag: { reason: string; salespersonId: string | null } | null) =>
      unwrap(
        await supabase()
          .from("quotes")
          .update(flag ? { measure_on_site_at: new Date().toISOString(), measure_on_site_reason: flag.reason, salesperson_id: flag.salespersonId } : { measure_on_site_at: null, measure_on_site_reason: null })
          .eq("id", quoteId),
      ),
    onSuccess: refresh,
  });
}

/** Under "Measure the roof": for a roof the map can't measure. */
export function CantMeasureButton({ quote, disabled }: { quote: EstimateQuote; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={`${styles.linkBtn} ${styles.quiet}`} disabled={disabled} onClick={() => setOpen(true)}>
        Can't measure it from the air?
      </button>
      {open && <MeasureOnSiteDialog quote={quote} onClose={() => setOpen(false)} />}
    </>
  );
}

function MeasureOnSiteDialog({ quote, onClose }: { quote: EstimateQuote; onClose: () => void }) {
  const group = useId();
  const team = useTeam();
  const [choice, setChoice] = useState<string>(REASONS[0]);
  const [note, setNote] = useState("");
  const [who, setWho] = useState(quote.salesperson_id ?? "");
  const flag = useMeasureOnSite(quote.id);
  const reason = onSiteReason(choice, note);
  const zip = quote.property?.postal_code?.trim();
  return (
    <Dialog open size="sm" onClose={onClose} title="Measure it on site instead?" description="A salesperson goes out and measures the roof by hand. Whoever goes gets a notification with the address and why.">
      <form
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          if (reason) flag.mutate({ reason, salespersonId: who || null }, { onSuccess: onClose });
        }}
      >
        <fieldset className={styles.leaning}>
          <legend>Why can't it be measured from the air?</legend>
          {REASONS.map((r) => (
            <label key={r} className={styles.lean} data-on={choice === r || undefined}>
              <input type="radio" name={group} value={r} checked={choice === r} onChange={() => setChoice(r)} />
              <span className={styles.leanText}><strong>{r}</strong></span>
            </label>
          ))}
        </fieldset>
        <Field label={choice === OTHER ? "What's in the way" : "Anything to add"} optional={choice !== OTHER} requiredMessage="Say what's in the way.">
          <textarea className={`textarea ${styles.agreedNote}`} value={note} maxLength={400} required={choice === OTHER} placeholder="Like “The back half is under the oaks”" onChange={(e) => setNote(e.target.value)} />
        </Field>
        <Field label="Who goes out to measure">
          <select className="select" value={who} disabled={team.isPending} onChange={(e) => setWho(e.target.value)}>
            <option value="">{zip ? `Whoever covers ${zip}` : "Whoever covers the area"}</option>
            {salesPeople(team.data ?? [], quote.salesperson_id).map((p) => (
              <option key={p.id} value={p.id}>{p.name}{!p.active ? " (no longer on the team)" : ""}</option>
            ))}
          </select>
        </Field>
        <FormError error={flag.error} />
        <div className="form-actions">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" icon="user" loading={flag.isPending} disabled={!reason}>Measure on site</Button>
        </div>
      </form>
    </Dialog>
  );
}

/** The first step while the roof waits to be measured on site: who's going, why, and the way back. */
export function MeasureOnSiteCard({ quote, measureLink, canSell }: { quote: EstimateQuote; measureLink: string | null; canSell: boolean }) {
  const team = useTeam();
  const unflag = useMeasureOnSite(quote.id);
  const who = personName(team.data, quote.salesperson_id);
  return (
    <div className="stack-sm">
      <p className={styles.pricingStatus}>
        <Icon name="user" size={16} />
        {who ? `${who} measures it on site` : "To be measured on site"}
      </p>
      <p className={styles.note}>
        {quote.measure_on_site_reason ? `Not from the air: ${quote.measure_on_site_reason.replace(/[.!?]+$/, "")}. ` : ""}
        {who ? "Once it's measured, draw the roof on the map with the pitch found on site, and the estimate prices from it." : "Nobody covers this address. Pick who goes out."}
      </p>
      <SalespersonSelect quoteId={quote.id} value={quote.salesperson_id} disabled={!canSell} label="Who goes out to measure" />
      <div className={styles.tools}>
        {measureLink && <Link className="btn" to={measureLink}>Draw the roof</Link>}
        {canSell && (
          <button type="button" className={styles.linkBtn} disabled={unflag.isPending} onClick={() => unflag.mutate(null)}>
            Measure it from the air after all
          </button>
        )}
      </div>
      <FormError error={unflag.error} />
    </div>
  );
}
