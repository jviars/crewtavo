/**
 * A quote's Contract card (the office quote page, the roofing estimate step): the contract sections
 * its paper prints from the estimate template and the option shown, read-only here (the template
 * and the package say which), and the business's other sections, to add to this job only
 * (quotes.section_ids). Once it's signed it lists what was signed: the template's terms and the
 * sections, as the approval kept them. With no sections in the library it's left out, except for a
 * tip to write some, shown once to each person who can (ContractTermsTip).
 * The library and its helpers are in settings/ContractSettings.tsx; core contracts.ts puts the
 * sections together (resolveSections), the same way the paper, the Client Hub and the iPad do.
 */
import { resolveSections, type ContractSection, type LibrarySection } from "@crewtavo/core/contracts";
import type { TemplateSettings } from "@crewtavo/core/documents";
import { useIsMutating, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Icon } from "@/components/ui/Icon";
import { CardSkeleton } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState } from "@/components/ui/States";
import { supabase, unwrap } from "@/lib/api";
import { can, hasRole, useSession } from "@/lib/session";
import { readApproval, type ApprovalSection } from "../documents/build";
import { isSignedQuote, useDocumentTemplate } from "../documents/data";
import { pickSection, placeLabel, useContractSections } from "../settings/ContractSettings";
import styles from "./QuoteSections.module.css";

const EDITABLE = ["draft", "sent", "changes_requested"];

export interface QuoteSectionsProps {
  quote: { id: string; status: string; template_id: string | null; option_id: string | null; section_ids: readonly string[] };
  /** The shown option's sections (quote_options.section_ids), when the quote offers options. */
  optionSectionIds?: readonly string[] | null;
  /** quotes.approval, so a signed quote lists the terms and sections it was signed with. */
  approval?: unknown;
  /** After this job's sections were saved. */
  onChanged?: () => void;
}

/**
 * What a quote prints: the template's sections and the shown option's (`printing`, each saying
 * which it came from), and the library's other sections, `added` when the quote adds them.
 */
export function quoteSections(input: {
  library: readonly LibrarySection[];
  template: Pick<TemplateSettings, "sections" | "invoice_sections">;
  optionSectionIds?: readonly string[] | null;
  quoteSectionIds: readonly string[];
}): { printing: Array<ContractSection & { from: "template" | "option" }>; others: Array<LibrarySection & { added: boolean }> } {
  const fromTemplate = new Set(input.template.sections.map((id) => id.toLowerCase()));
  const printing = resolveSections({ kind: "estimate", template: input.template, optionSectionIds: input.optionSectionIds, library: input.library }).map((s) => ({
    ...s,
    from: fromTemplate.has(s.id.toLowerCase()) ? ("template" as const) : ("option" as const),
  }));
  const printed = new Set(printing.map((s) => s.id.toLowerCase()));
  const added = new Set(input.quoteSectionIds.map((id) => id.toLowerCase()));
  const others = input.library.filter((s) => !printed.has(s.id.toLowerCase())).map((s) => ({ ...s, added: added.has(s.id.toLowerCase()) }));
  return { printing, others };
}

/**
 * What a signed quote was signed with, as its approval kept it: the template's terms (approval.
 * contract, or the template saved with an approval from before contracts) and the sections, each
 * initialed only when the customer's initials were kept too. Null when the approval kept neither.
 */
export function signedWith(approval: unknown): { terms: string; sections: ApprovalSection[] } | null {
  const a = readApproval(approval);
  if (a?.contract) return { terms: a.contract.terms.trim(), sections: a.contract.sections.map((s) => ({ ...s, initialed: s.initials && s.initialed && Boolean(a.initials) })) };
  if (a?.template) return { terms: a.template.terms.trim(), sections: [] };
  return null;
}

export function QuoteSections({ quote, optionSectionIds, approval, onChanged }: QuoteSectionsProps) {
  const session = useSession();
  const queryClient = useQueryClient();
  const canSell = hasRole(session, "admin", "office", "estimator") && can(session, "sales");
  const managesSettings = hasRole(session, "admin", "office") && can(session, "settings");
  const library = useContractSections();
  const { template, isPending } = useDocumentTemplate(quote.template_id);
  const signed = isSignedQuote(quote.status);
  const editable = canSell && EDITABLE.includes(quote.status);
  const headingId = useId();
  const addId = useId();

  // Ticks show at once. The saved list takes over when it changes, unless a tick is still being
  // saved (the refresh after it brings the list it saved), and when a save fails.
  const savedKey = JSON.stringify(quote.section_ids);
  const [ids, setIds] = useState<readonly string[]>(quote.section_ids);
  const saving = useRef(0);
  saving.current = useIsMutating({ mutationKey: ["quote-sections", quote.id] });
  useEffect(() => {
    if (!saving.current) setIds(JSON.parse(savedKey) as string[]);
  }, [savedKey]);
  const save = useMutation({
    mutationKey: ["quote-sections", quote.id],
    // One at a time, in order, so the last tick is the one saved.
    scope: { id: `quote-sections-${quote.id}` },
    mutationFn: async (next: string[]) => unwrap(await supabase().from("quotes").update({ section_ids: next }).eq("id", quote.id)),
    onError: () => setIds(JSON.parse(savedKey) as string[]),
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: ["quote", quote.id] });
      onChanged?.();
    },
  });

  const head = (
    <div className="card-head">
      <strong id={headingId}>Contract</strong>
      {managesSettings && <Link className={styles.headLink} to="/settings?tab=contracts">Contract terms</Link>}
    </div>
  );

  // Signed: what it was signed with, whatever the template and the library say now.
  if (signed) {
    const kept = signedWith(approval);
    const any = Boolean(kept && (kept.terms || kept.sections.length));
    if (!any && !library.data?.length) return null;
    return (
      <section className="card" aria-labelledby={headingId}>
        {head}
        <div className={styles.body}>
          {kept && any ? (
            <>
              <p className={styles.note}>Signed with these. Changing your template or your contract terms doesn't change them.</p>
              <ul className={styles.list}>
                {kept.terms && <Item title="The terms on your template" meta={placeLabel("signatures")} initials={null} />}
                {kept.sections.map((s) => (
                  <Item key={s.id} title={s.title} meta={placeLabel(s.place)} initials={s.initials ? (s.initialed ? "Initialed by the customer" : "Not initialed") : null} />
                ))}
              </ul>
            </>
          ) : (
            <p className={styles.note}>
              {kept ? "It was signed without any contract terms." : "It was approved before its contract was kept with it, so its copy shows the terms on its template as they read now."}
            </p>
          )}
        </div>
      </section>
    );
  }

  if (library.isPending || isPending) return <CardSkeleton lines={3} />;
  if (library.error) return <div className="card"><ErrorState compact title="Your contract sections couldn't load" error={library.error} onRetry={() => library.refetch()} /></div>;
  const rows = library.data;
  if (!rows.length) return managesSettings ? <ContractTermsTip /> : null;

  const { printing, others } = quoteSections({ library: rows, template, optionSectionIds, quoteSectionIds: ids });
  const terms = template.terms.trim();
  const toggle = (id: string, on: boolean) => {
    const next = pickSection(ids, id, on, rows);
    setIds(next);
    save.mutate(next);
  };

  return (
    <section className="card" aria-labelledby={headingId}>
      {head}
      <div className={styles.body}>
        <div className={styles.group}>
          <span className={styles.label}>What prints</span>
          {terms || printing.length ? (
            <ul className={styles.list}>
              {terms && <Item title="The terms on your template" meta={`${placeLabel("signatures")} · Every estimate`} initials={null} />}
              {printing.map((s) => (
                <Item key={s.id} title={s.title} meta={`${placeLabel(s.place)} · ${s.from === "template" ? "Every estimate" : "With this option"}`} initials={s.initials ? "The customer initials it when they sign" : null} />
              ))}
            </ul>
          ) : (
            <EmptyState inline title={`Nothing from your template${optionSectionIds ? " or this option" : ""} yet`} />
          )}
        </div>
        {others.length > 0 && (
          <div className={styles.group} role="group" aria-labelledby={addId}>
            <span className={styles.label} id={addId}>{editable ? "Add for this job" : "Added for this job"}</span>
            {editable ? (
              others.map((s) => (
                <label key={s.id} className="checkbox">
                  <input type="checkbox" checked={s.added} onChange={(e) => toggle(s.id, e.target.checked)} />
                  <span className={styles.pick}>
                    {s.title}
                    <span className={styles.meta}>
                      {placeLabel(s.place)}
                      {s.initials ? " · The customer initials it" : ""}
                    </span>
                  </span>
                </label>
              ))
            ) : others.some((s) => s.added) ? (
              <ul className={styles.list}>
                {others.filter((s) => s.added).map((s) => (
                  <Item key={s.id} title={s.title} meta={placeLabel(s.place)} initials={s.initials ? "The customer initials it when they sign" : null} />
                ))}
              </ul>
            ) : (
              <EmptyState inline title="None added" />
            )}
          </div>
        )}
      </div>
    </section>
  );
}

/** A section that prints, read-only: its title, where it prints, and a note when it's initialed. */
function Item({ title, meta, initials }: { title: string; meta: string; initials: string | null }) {
  return (
    <li className={styles.item}>
      <Icon name="file" size={14} />
      <span className={styles.pick}>
        {title}
        <span className={styles.meta}>{meta}</span>
        {initials && (
          <span className={styles.initials}>
            <Icon name="pen" size={14} />
            {initials}
          </span>
        )}
      </span>
    </li>
  );
}

/**
 * Whether this person has had the contract-terms tip, in this business. There's no per-person store
 * for tips, so it's kept on this device; without storage (private mode) it can show again next visit.
 */
const tipKey = (companyId: string, userId: string) => `crewtavo.tip.contract-terms.${companyId}.${userId}`;
function tipSeen(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}
function markTipSeen(key: string) {
  try {
    localStorage.setItem(key, "1");
  } catch {
    // Private mode: it may show once more.
  }
}

/**
 * "Print your own contract terms…", for people who can set them up while the business has none: shown
 * once, the first time a quote has none to print, and then not again (× puts it away at once). Home's
 * setup list keeps the step after that, so a quote never carries it for long.
 */
function ContractTermsTip() {
  const { company, userId } = useSession();
  const key = tipKey(company.id, userId);
  // Read as it first shows, so it stays for this visit even though it's marked seen straight away.
  const [shown, setShown] = useState(() => !tipSeen(key));
  useEffect(() => {
    if (shown) markTipSeen(key);
  }, [shown, key]);
  if (!shown) return null;
  return (
    <div className={`card card-pad ${styles.setup}`}>
      <Icon name="file" size={20} />
      <span className="grow">
        Print your own contract terms with your estimates, like payment, your warranty and the right to cancel. <Link to="/settings?tab=contracts">Set them up</Link>
      </span>
      <button type="button" className="icon-btn" aria-label="Don't show this again" title="Don't show this again" onClick={() => setShown(false)}>
        <Icon name="x" size={16} />
      </button>
    </div>
  );
}
