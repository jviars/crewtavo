/**
 * Settings → Contract terms: the business's contract wording, a section at a time (contract_sections),
 * like payment, changes to the work, the warranty and the right to cancel. Each section prints above
 * the signatures or on the terms pages after the estimate, and can ask the customer to initial it.
 * The estimate template picks the sections every estimate and invoice prints, in the order listed
 * here (TemplateSettings); a package brings its own and a quote can add more for one job (quotes/
 * QuoteSections), after the template's. Core contracts.ts puts them together and fills in
 * {Customer name} and the rest; the paper is features/documents.
 *
 * The library's data and the small helpers those screens share live here too. The editor (Tiptap)
 * loads only when a section is opened, so the screens that use the helpers don't download it.
 */
import {
  CONTRACT_LIMITS,
  contractStarters,
  contractValues,
  FILL_INS,
  fillIn,
  resolveSections,
  STARTER_NOTE,
  type ContractPlace,
  type LibrarySection,
} from "@crewtavo/core/contracts";
import { templateSettings, type TemplateSettings } from "@crewtavo/core/documents";
import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { Dialog } from "@/components/ui/Dialog";
import { Field, FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { Menu } from "@/components/ui/Menu";
import { CardSkeleton, Loading, Skeleton } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState } from "@/components/ui/States";
import { supabase, unwrap } from "@/lib/api";
import { ApiError } from "@/lib/errors";
import { useListAnimation } from "@/lib/motion";
import { can, hasRole, useSession } from "@/lib/session";
import { templatesKey, templatesQuery } from "../documents/data";
import { packagesKey } from "../roofing/packages";
import type { DocumentData } from "../documents/types";
import styles from "./ContractSettings.module.css";

const RichTextEditor = lazy(() => import("@/components/ui/RichTextEditor").then((m) => ({ default: m.RichTextEditor })));

// ---------------------------------------------------------------------------------------------
// The library
// ---------------------------------------------------------------------------------------------

/** A contract_sections row as the app reads it. */
export interface ContractSectionRow {
  id: string;
  title: string;
  body: string;
  place: string;
  initials: boolean;
  sort: number;
}

export const contractSectionsKey = (companyId: string) => ["contract-sections", companyId] as const;

/** The business's contract sections, in the order they print (two with the same number in the order they were made, then by id, as the server reads them). */
export const contractSectionsQuery = (companyId: string) =>
  queryOptions({
    queryKey: contractSectionsKey(companyId),
    queryFn: async (): Promise<ContractSectionRow[]> =>
      unwrap(await supabase().from("contract_sections").select("id, title, body, place, initials, sort").eq("company_id", companyId).order("sort").order("created_at").order("id")),
  });

/** The library, for whoever can read it (the office and estimators; anyone else gets none). */
export function useContractSections() {
  const { company } = useSession();
  return useQuery(contractSectionsQuery(company.id));
}

/** Where a section prints, as the business picks it. */
export const PLACES: ReadonlyArray<{ id: ContractPlace; label: string }> = [
  { id: "signatures", label: "Above the signatures" },
  { id: "terms", label: "On the terms pages" },
];

export const placeLabel = (place: string) => (place === "signatures" ? PLACES[0]!.label : PLACES[1]!.label);

const lower = (id: string) => id.toLowerCase();

/** The sort number after every section's: a new section goes at the end. */
export const nextSort = (rows: ReadonlyArray<{ sort: number }>) => (rows.length ? Math.max(...rows.map((r) => r.sort)) + 1 : 0);

/**
 * Moving a section one place up (-1) or down (1): every section numbered by its new place, and only
 * the ones whose number changes, to write. Nothing when it can't move that way.
 */
export function moveSection(rows: ReadonlyArray<{ id: string; sort: number }>, id: string, by: -1 | 1): Array<{ id: string; sort: number }> {
  const order = rows.map((r) => r.id);
  const from = order.indexOf(id);
  const to = from + by;
  if (from < 0 || to < 0 || to >= order.length) return [];
  [order[from], order[to]] = [order[to]!, order[from]!];
  const sorts = new Map(rows.map((r) => [r.id, r.sort]));
  return order.flatMap((rowId, sort) => (sorts.get(rowId) === sort ? [] : [{ id: rowId, sort }]));
}

/** The sections with new sort numbers, in their new order. */
export function applySorts<T extends { id: string; sort: number }>(rows: readonly T[], changes: ReadonlyArray<{ id: string; sort: number }>): T[] {
  const sorts = new Map(changes.map((c) => [c.id, c.sort]));
  return rows
    .map((row, i) => ({ row: sorts.has(row.id) ? { ...row, sort: sorts.get(row.id)! } : row, i }))
    .sort((a, b) => a.row.sort - b.row.sort || a.i - b.i)
    .map(({ row }) => row);
}

/** Section ids in the library's order, each once. Ids no longer in the library (deleted) are left out. */
export function inLibraryOrder(ids: readonly string[], library: ReadonlyArray<{ id: string }>): string[] {
  const wanted = new Set(ids.map(lower));
  return library.filter((s) => wanted.has(lower(s.id))).map((s) => s.id);
}

/** A section ticked or unticked in a list of them (a template's, a quote's), which keeps the library's order. */
export const pickSection = (ids: readonly string[], id: string, on: boolean, library: ReadonlyArray<{ id: string }>) =>
  inLibraryOrder(on ? [...ids, id] : ids.filter((x) => lower(x) !== lower(id)), library);

/** Whether two lists of section ids are the same ids in the same order (in any case). */
const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((id, i) => lower(id) === lower(b[i]!));

/**
 * The templates whose sections would print out of the library's order, with them put back in it:
 * moving a section moves it on every estimate and invoice too.
 */
export function templatesInOrder(templates: ReadonlyArray<{ id: string; settings: unknown }>, library: ReadonlyArray<{ id: string }>): Array<{ id: string; settings: TemplateSettings }> {
  return templates.flatMap((row) => {
    const t = templateSettings(row.settings);
    const sections = inLibraryOrder(t.sections, library);
    const invoice = inLibraryOrder(t.invoice_sections, library);
    return same(sections, t.sections) && same(invoice, t.invoice_sections) ? [] : [{ id: row.id, settings: { ...t, sections, invoice_sections: invoice } }];
  });
}

/**
 * The packages whose sections (roof_packages.section_ids) would print out of the library's order,
 * with them put back in it, as the package editor keeps them: moving a section moves it on the
 * options offered from a package too.
 */
export function packagesInOrder(packages: ReadonlyArray<{ id: string; section_ids: readonly string[] | null }>, library: ReadonlyArray<{ id: string }>): Array<{ id: string; section_ids: string[] }> {
  return packages.flatMap((row) => {
    const ids = row.section_ids ?? [];
    const sections = inLibraryOrder(ids, library);
    return same(sections, ids) ? [] : [{ id: row.id, section_ids: sections }];
  });
}

/** The example sections for the business's trade (core contractStarters), as rows to add after `from`. */
export const starterRows = (trade: string | null | undefined, companyId: string, from: number) =>
  contractStarters(trade).map((s, i) => ({ company_id: companyId, title: s.title, body: s.body, place: s.place, initials: s.initials, sort: from + i }));

/** The sections whose words are still an example's, word for word: the ones STARTER_NOTE is about. */
export function exampleIds(rows: ReadonlyArray<{ id: string; body: string }>, trade: string | null | undefined): Set<string> {
  const examples = new Set(contractStarters(trade).map((s) => s.body));
  return new Set(rows.filter((r) => examples.has(r.body)).map((r) => r.id));
}

/** The start of a section's words as plain text, for the list. */
export function sectionSnippet(html: string, max = 200): string {
  const text = html
    .replace(/<(br|\/p|\/li|\/h\d|\/tr|\/td|\/th|\/blockquote)\b[^>]*>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

// ---------------------------------------------------------------------------------------------
// The template editor's preview and summary
// ---------------------------------------------------------------------------------------------

/**
 * The template editor's sample as an estimate or an invoice, with the contract the template prints:
 * its sections from the library and its terms, filled in from the sample's facts the way a real
 * estimate's (or invoice's) are (core contractValues). The sample offers no options, so {Option}
 * and {Warranty} are blank, as on any estimate without them (core contractInput).
 */
export function contractPreview(input: {
  kind: "estimate" | "invoice";
  sample: DocumentData;
  template: TemplateSettings;
  library: readonly LibrarySection[];
  company: { name: string; phone: string | null; timezone: string | null };
}): { template: TemplateSettings; data: DocumentData } {
  const { kind, sample, template } = input;
  const estimate = kind === "estimate";
  const data: DocumentData = estimate ? sample : { ...sample, kind, validUntil: null, dueOn: sample.validUntil ?? null, deposit: null, payments: [], balanceDue: sample.total, signatures: undefined };
  const values = contractValues({
    customerName: data.client.name,
    customerAddress: data.client.lines,
    jobAddress: data.client.lines,
    businessName: input.company.name,
    businessPhone: input.company.phone,
    license: template.license,
    estimateNumber: data.number,
    date: data.date,
    timeZone: input.company.timezone,
    total: data.total,
    // An invoice has no deposit (core invoiceInput).
    deposit: estimate ? data.deposit : null,
    optionName: null,
    warranty: null,
  });
  // Nobody initials an invoice (build.ts invoiceContract), so its sample has no box for it.
  const sections = resolveSections({ kind, template, library: input.library }).map((s) => ({ id: s.id, title: s.title, html: fillIn(s.body, values), place: s.place, initials: estimate && s.initials }));
  return { template: { ...template, terms: fillIn(template.terms, values, { text: true }) }, data: { ...data, contract: { sections } } };
}

/** The template editor's line for its Contract part: how many sections, then the terms' first line. */
export function contractSummary(terms: string, estimates: number, invoices: number): string {
  const count = (n: number) => `${n} section${n === 1 ? "" : "s"}`;
  const sections = estimates && invoices ? `${count(estimates)} on estimates, ${invoices} on invoices` : estimates ? `${count(estimates)} on estimates` : invoices ? `${count(invoices)} on invoices` : null;
  const words = terms.trim().split("\n")[0]?.trim() || null;
  return [sections, words].filter(Boolean).join(" · ") || "Nothing printed above the signatures";
}

// ---------------------------------------------------------------------------------------------
// The screen
// ---------------------------------------------------------------------------------------------

/** A move that was saved, with the estimate templates or packages still printing the old order. */
class TemplatesBehind extends ApiError {}

type Move = { id: string; by: -1 | 1 };

export function ContractSettings() {
  const session = useSession();
  const { company } = session;
  const canEdit = hasRole(session, "admin", "office") && can(session, "settings");
  const queryClient = useQueryClient();
  const sections = useContractSections();
  const listRef = useListAnimation<HTMLOListElement>();
  const listId = useId();
  const [editing, setEditing] = useState<ContractSectionRow | "new" | null>(null);
  const key = contractSectionsKey(company.id);
  const refresh = () => queryClient.invalidateQueries({ queryKey: key });
  const arrowId = (id: string, by: -1 | 1) => `${listId}${id}-${by < 0 ? "up" : "down"}`;

  // After a move, focus stays on the section's arrow, or goes to its other one at either end.
  const refocus = useRef<Move | null>(null);
  useEffect(() => {
    const want = refocus.current;
    const rows = sections.data;
    if (!want || !rows) return;
    refocus.current = null;
    const at = rows.findIndex((r) => r.id === want.id);
    const end = want.by < 0 ? at === 0 : at === rows.length - 1;
    document.getElementById(arrowId(want.id, end ? (-want.by as -1 | 1) : want.by))?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sections.data]);

  const addStarters = useMutation({
    meta: { success: "Example sections added. Change them to fit your business." },
    mutationFn: async () => unwrap(await supabase().from("contract_sections").insert(starterRows(company.trade_preset, company.id, nextSort(sections.data ?? [])))),
    onSuccess: refresh,
  });

  const move = useMutation({
    mutationFn: async ({ changes, next }: Move & { changes: Array<{ id: string; sort: number }>; next: ContractSectionRow[] }) => {
      await Promise.all(changes.map(async (c) => unwrap(await supabase().from("contract_sections").update({ sort: c.sort }).eq("id", c.id))));
      // The templates and packages print their sections in this order too. They're read fresh, so a
      // change someone just made to one isn't written over.
      try {
        const templates = await queryClient.fetchQuery({ ...templatesQuery(company.id), staleTime: 0 });
        await Promise.all(templatesInOrder(templates, next).map(async (t) => unwrap(await supabase().from("document_templates").update({ settings: t.settings as never }).eq("id", t.id))));
        const packages = unwrap(await supabase().from("roof_packages").select("id, section_ids").eq("company_id", company.id));
        await Promise.all(packagesInOrder(packages, next).map(async (p) => unwrap(await supabase().from("roof_packages").update({ section_ids: p.section_ids }).eq("id", p.id))));
      } catch (error) {
        throw new TemplatesBehind("The section moved, but your estimate templates or packages still print the old order. Moving any section again puts them in order.", error instanceof ApiError ? error.status : 500);
      }
    },
    // The list moves straight away, and back if its new order can't be saved.
    onMutate: async ({ next }) => {
      await queryClient.cancelQueries({ queryKey: key });
      const before = queryClient.getQueryData<ContractSectionRow[]>(key);
      queryClient.setQueryData(key, next);
      return { before };
    },
    onError: (error, { id, by }, context) => {
      if (error instanceof TemplatesBehind || !context?.before) return;
      refocus.current = { id, by };
      queryClient.setQueryData(key, context.before);
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: key });
      queryClient.invalidateQueries({ queryKey: templatesKey(company.id) });
      queryClient.invalidateQueries({ queryKey: packagesKey(company.id) });
    },
  });

  const remove = useMutation({
    meta: { success: "Section deleted" },
    mutationFn: async (id: string) => unwrap(await supabase().from("contract_sections").delete().eq("id", id)),
    onSuccess: refresh,
  });

  if (sections.isPending) {
    return (
      <Loading label="Loading your contract terms">
        <div className="stack">
          <CardSkeleton lines={2} />
          <CardSkeleton lines={6} />
        </div>
      </Loading>
    );
  }
  if (sections.error) return <div className="card"><ErrorState error={sections.error} onRetry={() => sections.refetch()} /></div>;
  const rows = sections.data;
  const examples = exampleIds(rows, company.trade_preset);

  const moveRow = (id: string, by: -1 | 1) => {
    const changes = moveSection(rows, id, by);
    if (move.isPending || !changes.length) return;
    refocus.current = { id, by };
    move.mutate({ id, by, changes, next: applySorts(rows, changes) });
  };
  const askRemove = async (row: ContractSectionRow) => {
    if (await confirm({ title: `Delete “${row.title}”?`, body: "Signed estimates keep the words they were signed with. Estimates that aren't signed yet stop printing it.", confirmLabel: "Delete section", danger: true })) remove.mutate(row.id);
  };

  return (
    <div className="stack">
      <div className={`card card-pad ${styles.intro}`}>
        <div className={styles.introText}>
          <h2>Contract terms</h2>
          <p>Your contract's wording, a section at a time: payment, changes to the work, your warranty, the right to cancel. Each one prints above the signatures or on the terms pages after the estimate.</p>
          <p>
            {canEdit ? (
              <>Pick the ones every estimate and invoice prints in <Link to="/settings?tab=templates">Settings → Estimate template</Link>, which prints them in this order. </>
            ) : (
              "Your estimate template picks the ones every estimate and invoice prints, and prints them in this order. "
            )}
            A package can bring its own and a quote can add more for one job; those come after the template's.
          </p>
        </div>
        {canEdit && rows.length > 0 && <Button variant="primary" icon="plus" onClick={() => setEditing("new")}>Add a section</Button>}
      </div>

      {!canEdit && (
        <div className="callout">
          <Icon name="lock" size={18} />
          <span className="grow">Only people in the office who manage Settings can change these.</span>
        </div>
      )}

      {canEdit && examples.size > 0 && (
        <div className="callout">
          <Icon name="info" size={18} />
          <span className="grow">{STARTER_NOTE}</span>
        </div>
      )}

      {rows.length ? (
        <ol className={`card ${styles.list}`} ref={listRef} aria-label="Contract sections, in order">
          {rows.map((row, i) => (
            <SectionRow
              key={row.id}
              row={row}
              number={i + 1}
              example={examples.has(row.id)}
              canEdit={canEdit}
              first={i === 0}
              last={i === rows.length - 1}
              moving={move.isPending}
              arrowIds={[arrowId(row.id, -1), arrowId(row.id, 1)]}
              onEdit={() => setEditing(row)}
              onMove={(by) => moveRow(row.id, by)}
              onRemove={() => void askRemove(row)}
            />
          ))}
        </ol>
      ) : canEdit ? (
        <div className="card">
          <EmptyState
            icon="file"
            title="No contract sections yet"
            action={
              <>
                <Button variant="primary" icon="sparkle" loading={addStarters.isPending} onClick={() => addStarters.mutate()}>Add example sections</Button>
                <Button icon="plus" onClick={() => setEditing("new")}>Write your own</Button>
              </>
            }
          >
            Start from example sections for your kind of work and change them to fit, or write your own.
          </EmptyState>
          <p className={styles.starterNote}>
            <Icon name="info" size={15} />
            {STARTER_NOTE}
          </p>
        </div>
      ) : (
        <div className="card"><EmptyState icon="file" title="No contract sections yet">Someone in the office who manages Settings can add them here.</EmptyState></div>
      )}

      {editing && <SectionDialog section={editing === "new" ? null : editing} sort={nextSort(rows)} onClose={() => setEditing(null)} />}
    </div>
  );
}

/**
 * One section in the list: its place in the order, where it prints and how it starts, and what can
 * be done with it. While a move saves, the arrows ignore presses but keep focus (aria-disabled).
 */
function SectionRow({ row, number, example, canEdit, first, last, moving, arrowIds, onEdit, onMove, onRemove }: {
  row: ContractSectionRow;
  number: number;
  example: boolean;
  canEdit: boolean;
  first: boolean;
  last: boolean;
  moving: boolean;
  /** The up and down arrows' ids, for focus after a move. */
  arrowIds: [string, string];
  onEdit: () => void;
  onMove: (by: -1 | 1) => void;
  onRemove: () => void;
}) {
  const metaId = useId();
  const snippet = sectionSnippet(row.body);
  const words = (
    <>
      <strong className={styles.title}>{row.title}</strong>
      <span id={metaId} className={styles.meta}>
        {placeLabel(row.place)}
        {row.initials && (
          <span className={styles.initials}>
            <Icon name="pen" size={13} />
            The customer initials it
          </span>
        )}
        {example && <span className="chip chip-amber">Example</span>}
      </span>
      <span className={styles.snippet}>{snippet || "No words yet."}</span>
    </>
  );
  return (
    <li className={styles.row}>
      <span className={styles.number} aria-hidden="true">{number}</span>
      {canEdit ? (
        <button type="button" className={styles.open} aria-label={`Edit “${row.title}”`} aria-describedby={metaId} onClick={onEdit}>
          {words}
        </button>
      ) : (
        <div className={styles.open}>{words}</div>
      )}
      {canEdit && (
        <div className={styles.actions}>
          <Button size="sm" variant="ghost" icon="chevronUp" id={arrowIds[0]} aria-label={`Move “${row.title}” up`} disabled={first} aria-disabled={moving || undefined} onClick={() => onMove(-1)} />
          <Button size="sm" variant="ghost" icon="chevronDown" id={arrowIds[1]} aria-label={`Move “${row.title}” down`} disabled={last} aria-disabled={moving || undefined} onClick={() => onMove(1)} />
          <Menu
            label={`More for “${row.title}”`}
            triggerClassName="btn btn-sm btn-ghost btn-icon"
            items={[
              { label: "Edit", icon: "edit", onSelect: onEdit },
              { separator: true },
              { label: "Delete section", icon: "trash", danger: true, onSelect: onRemove },
            ]}
          />
        </div>
      )}
    </li>
  );
}

/** Writing a new section, or changing one: its title, its words, where it prints and whether it's initialed. */
function SectionDialog({ section, sort, onClose }: { section: ContractSectionRow | null; sort: number; onClose: () => void }) {
  const { company } = useSession();
  const queryClient = useQueryClient();
  const placeId = useId();
  const [title, setTitle] = useState(section?.title ?? "");
  const [body, setBody] = useState(section?.body ?? "");
  const [place, setPlace] = useState<ContractPlace>(section?.place === "signatures" ? "signatures" : "terms");
  const [initials, setInitials] = useState(section?.initials ?? false);
  const [titleTouched, setTitleTouched] = useState(false);
  const clean = title.trim();
  const tooLong = body.length > CONTRACT_LIMITS.body;
  const dirty =
    title !== (section?.title ?? "") || body !== (section?.body ?? "") || place !== (section?.place === "signatures" ? "signatures" : "terms") || initials !== (section?.initials ?? false);

  const save = useMutation({
    meta: { inline: true, success: section ? "Section saved" : "Section added" },
    mutationFn: async () => {
      const fields = { title: clean, body, place, initials };
      if (section) unwrap(await supabase().from("contract_sections").update(fields).eq("id", section.id));
      else unwrap(await supabase().from("contract_sections").insert({ ...fields, company_id: company.id, sort }));
    },
    onSuccess: () => {
      onClose();
      return queryClient.invalidateQueries({ queryKey: contractSectionsKey(company.id) });
    },
  });

  /** Closing with changes that aren't saved asks first. */
  const close = async () => {
    if (!dirty || (await confirm({ title: "Discard your changes?", body: "The changes you made to this section aren't saved.", confirmLabel: "Discard changes", danger: true }))) onClose();
  };

  return (
    <Dialog open onClose={() => void close()} title={section ? "Edit section" : "New section"} description="Fill-ins like {Customer name} are filled in for each estimate." size="lg">
      <form
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          setTitleTouched(true);
          if (clean && !tooLong) save.mutate();
        }}
      >
        <Field label="Title" error={titleTouched && !clean ? "Give the section a title." : null} hint="Printed above its words, like “Payment” or “Your right to cancel”.">
          <input className="input" value={title} maxLength={CONTRACT_LIMITS.title} onChange={(e) => setTitle(e.target.value)} onBlur={() => setTitleTouched(true)} />
        </Field>
        <Field
          label="Words"
          error={tooLong ? "That's more than one section can hold. Split it into two sections." : null}
          hint="{Option} and {Warranty} come from the option the customer picks, or the package the estimate was priced from. Without either, they're blank."
        >
          <div className={styles.editor}>
            <Suspense
              fallback={
                <Loading label="Loading the editor">
                  <Skeleton height={226} radius={10} />
                </Loading>
              }
            >
              <RichTextEditor
                mode="contract"
                fillIns={FILL_INS}
                initialHtml={section?.body ?? ""}
                label="The section's words"
                placeholder="Write it the way you'd say it to the customer…"
                minHeight={180}
                // Words, a table or a divider; an empty editor saves nothing.
                onChange={(html, text) => setBody(text || /<(table|hr)\b/i.test(html) ? html : "")}
              />
            </Suspense>
          </div>
        </Field>
        <div className={styles.group}>
          <span className={styles.label} id={placeId}>Where it prints</span>
          <div className="segmented" role="group" aria-labelledby={placeId} style={{ justifySelf: "start" }}>
            {PLACES.map((p) => (
              <button key={p.id} type="button" aria-pressed={place === p.id} onClick={() => setPlace(p.id)}>{p.label}</button>
            ))}
          </div>
          <span className="hint">
            {place === "signatures"
              ? "Right above where the customer signs, for what they must read first."
              : "On the pages after the estimate, under “Terms and conditions”."}{" "}
            Invoices print every section after their totals.
          </span>
        </div>
        <label className="switch-row" style={{ fontWeight: 500 }}>
          <input type="checkbox" className="switch" checked={initials} onChange={(e) => setInitials(e.target.checked)} />
          The customer initials this section
        </label>
        <FormError error={save.error} />
        <div className="form-actions">
          <Button onClick={() => void close()}>Cancel</Button>
          <Button type="submit" variant="primary" icon="check" loading={save.isPending} disabled={tooLong}>{section ? "Save section" : "Add section"}</Button>
        </div>
      </form>
    </Dialog>
  );
}
