/**
 * Materials used on a job: tons of asphalt, gallons of sealer, loads of stone, logged from the
 * field with the plant ticket number and a photo of the ticket. Crews see quantities, never prices.
 * For the office with job costs, each one is set against what the job's line items estimated for it
 * (a price list item on the job, or a material of a paving calculator line), and counts in job
 * costing as logged in place of the estimate (packages/core/src/reports.ts materialUse).
 */
import type { MaterialUse } from "@crewtavo/core/reports";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { featureOn } from "@/components/shell/nav";
import { Button, cx } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Field, FormChecks, FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { ListFoot } from "@/components/ui/InboxList";
import { Menu } from "@/components/ui/Menu";
import { RelatedList, RelatedRow, Section } from "@/components/ui/Section";
import { Skeleton } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/ui/States";
import { supabase, unwrap } from "@/lib/api";
import { signedUrls, uploadFile } from "@/lib/files";
import { formatDate, formatMoneyCents } from "@/lib/format";
import { useListAnimation } from "@/lib/motion";
import { hasRole, useSession } from "@/lib/session";
import { undoable } from "@/lib/undo";
import { LOGGED_MATERIALS_RULE } from "./jobCosts";
import styles from "./jobMoney.module.css";
import { intlLocale, t } from "@/lib/i18n";
import { Select } from "@/components/ui/Select";

const UNITS = ["ton", "yd³", "gal", "load", "bag", "ea", "lf", "sq yd"];
const qty = (n: number) => new Intl.NumberFormat(intlLocale(), { maximumFractionDigits: 3 }).format(n);

const materialsKey = (jobId: string) => ["job", jobId, "materials"];

export function useJobMaterials(jobId: string) {
  return useQuery({
    queryKey: materialsKey(jobId),
    queryFn: async () => {
      const rows = unwrap(await supabase().from("job_materials").select("id, visit_id, service_id, name, quantity, unit, ticket, supplier, photo_path, logged_by, logged_at").eq("job_id", jobId).order("logged_at", { ascending: false }));
      const urls = await signedUrls(rows.flatMap((r) => (r.photo_path ? [r.photo_path] : []))).catch(() => ({}) as Record<string, string>);
      return rows.map((r) => ({ ...r, photo_url: r.photo_path ? urls[r.photo_path] ?? null : null }));
    },
  });
}
type Material = NonNullable<ReturnType<typeof useJobMaterials>["data"]>[number];

/**
 * On the job page (all of it) or a visit (just that day's), with a "Log material" button. The job
 * page shows it once something's logged, or opens it with the dialog up (startAdding) from its add
 * buttons; onAddClosed tells it that dialog has closed, so an empty card can go again. `use`: each
 * logged material against the job's estimate (jobCosts), for the office with job costs.
 *
 * A section on a hairline (Section), each ticket a row, which a grouped phone page shows as an inset
 * card. `compact`: on a crew member's visit, which shows that day's tickets and no costs.
 */
export function MaterialsCard({ jobId, visitId, showCosts, use, compact = false, startAdding = false, onAddClosed }: { jobId: string; visitId?: string; showCosts?: boolean; use?: readonly MaterialUse[]; compact?: boolean; startAdding?: boolean; onAddClosed?: () => void }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const [logging, setLogging] = useState(startAdding);
  const listRef = useListAnimation<HTMLUListElement>();
  const materials = useJobMaterials(jobId);
  const costs = useQuery({
    queryKey: ["job", jobId, "material-costs"],
    enabled: Boolean(showCosts),
    queryFn: async () => unwrap(await supabase().rpc("job_material_costs", { p_job: jobId })),
  });
  const remove = useMutation({
    meta: { inline: true },
    mutationFn: async (id: string) => unwrap(await supabase().from("job_materials").delete().eq("id", id)),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["job", jobId] }),
  });
  // Gone at once with Undo on the toast; deleted for real once the toast leaves.
  const removeEntry = (m: Material) => {
    const key = materialsKey(jobId);
    undoable({
      title: t("Material removed"),
      tone: "job",
      hide: () => {
        void queryClient.cancelQueries({ queryKey: key });
        queryClient.setQueryData<Material[]>(key, (all) => all?.filter((x) => x.id !== m.id));
      },
      restore: () => queryClient.setQueryData<Material[]>(key, (all) => (all && !all.some((x) => x.id === m.id) ? [...all, m].sort((a, b) => b.logged_at.localeCompare(a.logged_at)) : all)),
      commit: () => remove.mutateAsync(m.id),
    });
  };
  const closeLog = () => {
    setLogging(false);
    onAddClosed?.();
  };
  const rows = (materials.data ?? []).filter((m) => !visitId || m.visit_id === visitId);
  const canFix = (m: { logged_by: string | null; logged_at: string }) => hasRole(session, "admin", "office", "crew_lead") || (m.logged_by === session.userId && Date.now() - Date.parse(m.logged_at) < 86_400_000);
  // Totals by material, for the whole job.
  const totals = Object.values(
    (materials.data ?? []).reduce<Record<string, { name: string; unit: string; quantity: number }>>((acc, m) => {
      const k = `${m.name}|${m.unit}`;
      acc[k] = { name: m.name, unit: m.unit, quantity: (acc[k]?.quantity ?? 0) + Number(m.quantity) };
      return acc;
    }, {}),
  );
  const logButton = <Button size="sm" icon="plus" onClick={() => setLogging(true)}>{t("Log material")}</Button>;
  // A list of plain tickets has no lead: the same truck on every row says nothing. A ticket photo brings the leads back, so the rows still line up.
  const tiles = rows.some((m) => m.photo_url);

  const body = (
    <>
      {materials.isPending && <RowsSkeleton rows={2} />}
      {materials.data && rows.length === 0 && (
        <EmptyState inline title={visitId ? t("Nothing logged yet") : t("No materials logged yet")}>
          {visitId ? t("Log tons, gallons or loads as they come in, with the ticket number.") : null}
        </EmptyState>
      )}
      {rows.length > 0 && (
        <ul className="rel" role="list" aria-label={t("Materials used")} ref={listRef}>
          {rows.map((m) => (
            <RelatedRow
              key={m.id}
              lead={!tiles ? undefined : m.photo_url ? (
                <a href={m.photo_url} target="_blank" rel="noreferrer" className={cx("rel-icon", styles.thumb)} aria-label={t("Open ticket photo")}><img src={m.photo_url} alt="" /></a>
              ) : (
                <span className={cx("rel-icon", styles.square)} aria-hidden="true"><Icon name="truck" size={16} /></span>
              )}
              title={m.name}
              sub={[m.ticket && t("Ticket {ticket}", { ticket: m.ticket }), m.supplier, !visitId && formatDate(m.logged_at)]}
              end={<b>{qty(Number(m.quantity))} {m.unit}</b>}
              actions={canFix(m) && (
                <Menu
                  label={t("Actions for {name}", { name: m.name })}
                  title={m.name}
                  items={[
                    { label: t("Open ticket photo"), icon: "image", hidden: !m.photo_url, onSelect: () => window.open(m.photo_url!, "_blank", "noreferrer") },
                    { separator: true },
                    { label: t("Remove"), icon: "trash", danger: true, onSelect: () => removeEntry(m) },
                  ]}
                />
              )}
            />
          ))}
        </ul>
      )}
      {!visitId && totals.length > 1 && <ListFoot>{t("Totals: {list}", { list: totals.map((x) => `${qty(x.quantity)} ${x.unit} ${x.name}`).join(" · ") })}</ListFoot>}
    </>
  );
  const dialog = logging && <MaterialDialog jobId={jobId} visitId={visitId ?? null} onClose={closeLog} onSaved={() => queryClient.invalidateQueries({ queryKey: ["job", jobId] })} />;

  return (
    <>
      <Section className="rel-figures" title={t("Materials used")} count={rows.length || undefined} action={logButton}>
        <div className={styles.parts}>{body}</div>
        {dialog}
      </Section>
      {!compact && showCosts && !!use?.length && <EstimatedAndUsed use={use} priceList={costs.data ?? []} />}
    </>
  );
}

/** Placeholder rows while a list loads: two lines and a figure, after a face when the rows have one (`lead`). */
export function RowsSkeleton({ rows, lead = false }: { rows: number; lead?: boolean }) {
  return (
    <ul className="rel" aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <li key={i} className="rel-row">
          {lead && <Skeleton width={20} height={20} radius={999} />}
          <span className="rel-body stack-sm" style={{ gap: 6 }}><Skeleton width={i ? "32%" : "44%"} height={11} /><Skeleton width="26%" height={9} /></span>
          <Skeleton width={56} height={11} />
        </li>
      ))}
    </ul>
  );
}

/**
 * Each logged material against what the job's line items estimated for it. One that's on the lines
 * counts in job costing as logged, at the line's cost; one that isn't is listed with what the price
 * list says it costs, and isn't counted, since a line's cost may already cover it. The rule is said
 * here, where the numbers are.
 */
function EstimatedAndUsed({ use, priceList }: { use: readonly MaterialUse[]; priceList: ReadonlyArray<{ name: string; unit: string; unit_cost: number | null; cost: number | null }> }) {
  const compared = use.filter((r) => r.estimated !== null);
  const others = use.filter((r) => r.estimated === null);
  const listCost = (r: MaterialUse) => priceList.find((c) => c.name === r.name && c.unit === r.unit && c.unit_cost != null)?.cost ?? null;
  return (
    <Section title={t("Estimated and used")}>
      <div className={styles.parts}>
        <RelatedList label={t("Estimated and used")}>
          {compared.map((r) => {
            const over = Math.round((r.used - r.estimated!) * 1000) / 1000;
            return (
              <RelatedRow
                key={`${r.name}|${r.unit}`}
                title={r.name}
                sub={t("Estimated {quantity} {unit} · {cost}", { quantity: qty(r.estimated!), unit: r.unit, cost: formatMoneyCents(r.estimated_cost!) })}
                end={(
                  <span className={styles.endStack}>
                    <b>{qty(r.used)} {r.unit} · {formatMoneyCents(r.actual_cost!)}</b>
                    <span>{over === 0 ? t("As estimated") : over > 0 ? t("{quantity} {unit} over", { quantity: qty(Math.abs(over)), unit: r.unit }) : t("{quantity} {unit} under", { quantity: qty(Math.abs(over)), unit: r.unit })}</span>
                  </span>
                )}
              />
            );
          })}
          {others.map((r) => {
            const cost = listCost(r);
            return (
              <RelatedRow
                key={`${r.name}|${r.unit}`}
                title={r.name}
                sub={t("Not on this job's line items")}
                end={(
                  <span className={styles.endStack}>
                    <span className="tabular">{qty(r.used)} {r.unit}</span>
                    {cost != null && <span>{t("{cost} at price list cost", { cost: formatMoneyCents(Number(cost)) })}</span>}
                  </span>
                )}
              />
            );
          })}
        </RelatedList>
        <p className={styles.rule}>
          {LOGGED_MATERIALS_RULE}
          {others.length > 0 && t(" A material that isn't on the line items is listed, not counted: a line's cost may already cover it.")}
        </p>
      </div>
    </Section>
  );
}

/** onSaved may return a promise (a refetch): the dialog stays until it's done, so the new row is there as it closes. */
export function MaterialDialog({ jobId, visitId, onClose, onSaved }: { jobId: string; visitId: string | null; onClose: () => void; onSaved: () => unknown }) {
  const session = useSession();
  const choices = useQuery({
    queryKey: ["material-choices", session.company.id],
    staleTime: 5 * 60_000,
    queryFn: async () => unwrap(await supabase().rpc("material_choices", { p_company: session.company.id })),
  });
  // What the job's own lines have on them, by name and unit (no prices): logged as one of these, a
  // material is set against the job's estimate. Not on the phone with no signal; the rest still is.
  const onJob = useQuery({
    queryKey: ["job", jobId, "estimated-materials"],
    staleTime: 5 * 60_000,
    meta: { silent: true },
    queryFn: async () => unwrap(await supabase().rpc("job_estimated_materials", { p_job: jobId })),
  });
  // The list's value: a price list item's id, or one of the job's own ("job:" and its place in onJob).
  const [choice, setChoice] = useState("");
  const [serviceId, setServiceId] = useState("");
  const [name, setName] = useState("");
  const [quantity, setQuantity] = useState("");
  // Tons are paving's; everyone else counts each.
  const [unit, setUnit] = useState(() => (featureOn(session.company.settings, "paving_app") ? "ton" : "ea"));
  const [ticket, setTicket] = useState("");
  const [supplier, setSupplier] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const amount = Number(quantity);
  const pick = (id: string) => {
    setChoice(id);
    const mine = id.startsWith("job:") ? onJob.data?.[Number(id.slice(4))] : undefined;
    setServiceId(mine ? mine.service_id ?? "" : id);
    const c = mine ?? choices.data?.find((x) => x.id === id);
    if (c) {
      setName(c.name);
      setUnit(c.unit);
    }
  };
  const save = useMutation({
    meta: { inline: true, success: t("Material logged") },
    mutationFn: async () => {
      if (!(amount > 0)) throw new Error(t("Enter how much was used."));
      if (!name.trim()) throw new Error(t("Say what material it was."));
      const photo_path = file ? await uploadFile(session.company.id, `tickets/${jobId}`, file) : null;
      unwrap(
        await supabase().from("job_materials").insert({
          company_id: session.company.id, job_id: jobId, visit_id: visitId, service_id: serviceId || null,
          name: name.trim(), quantity: amount, unit, ticket: ticket.trim() || null, supplier: supplier.trim() || null, photo_path,
          logged_by: session.userId,
        }),
      );
    },
    onSuccess: async () => {
      await onSaved();
      onClose();
    },
  });
  return (
    <Dialog open onClose={onClose} title={t("Log material")}>
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(); }}>
        <Field label={t("Material")}>
          {choices.isPending ? <Skeleton height="var(--control)" radius={8} /> : (
            <Select className="select" value={choice} onChange={(e) => pick(e.target.value)}>
              <option value="">{t("Something else (type it below)")}</option>
              {!!onJob.data?.length && (
                <optgroup label={t("On this job")}>
                  {onJob.data.map((c, i) => <option key={`job:${i}`} value={`job:${i}`}>{c.name} ({c.unit})</option>)}
                </optgroup>
              )}
              {onJob.data?.length ? (
                <optgroup label={t("Price list")}>
                  {choices.data?.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.unit})</option>)}
                </optgroup>
              ) : choices.data?.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.unit})</option>)}
            </Select>
          )}
        </Field>
        {!choice && <Field label={t("What was it")} requiredMessage={t("Say what material it was.")}><input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={200} placeholder={t("Surface mix, #57 stone, sealer…")} required /></Field>}
        <div className="form-grid">
          <Field label={t("How much")} requiredMessage={t("Enter how much was used.")}><input className="input" inputMode="decimal" value={quantity} onChange={(e) => setQuantity(e.target.value.replace(/[^0-9.]/g, ""))} required autoFocus /></Field>
          <Field label={t("Unit")}>
            <Select className="select" value={unit} onChange={(e) => setUnit(e.target.value)}>
              {[...new Set([unit, ...UNITS])].map((u) => <option key={u}>{u}</option>)}
            </Select>
          </Field>
          <Field label={t("Ticket number")} optional><input className="input" value={ticket} onChange={(e) => setTicket(e.target.value)} maxLength={60} /></Field>
          <Field label={t("Supplier or plant")} optional><input className="input" value={supplier} onChange={(e) => setSupplier(e.target.value)} maxLength={120} /></Field>
        </div>
        <label className={cx("dropzone", styles.drop)}>
          <Icon name={file ? "image" : "camera"} size={20} />
          <span className={styles.dropText}>{file ? file.name : t("Add a photo of the ticket")}</span>
          <input type="file" accept="image/*" capture="environment" className="sr-only" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </label>
        <FormError error={save.error} />
        <div className="form-actions">
          <FormChecks />
          <Button onClick={onClose}>{t("Cancel")}</Button>
          {/* With a ticket photo it uploads, which is slow anyway. */}
          <Button type="submit" variant="primary" loading={save.isPending} slowHint={file ? false : undefined}>{t("Log it")}</Button>
        </div>
      </form>
    </Dialog>
  );
}
