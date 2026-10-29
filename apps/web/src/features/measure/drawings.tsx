/**
 * Map drawings on quotes and invoices. A saved measurement can be attached to a quote, an invoice,
 * or both, and shown to the client on each (show_on_quote, show_on_invoice): the Client Hub and its
 * PDF then show the picture saved with it and the sizes. Moving it to another quote or invoice hides
 * it there until someone shows it (a database trigger). Plain edits, so they go straight to Supabase.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { Menu } from "@/components/ui/Menu";
import { EmptyState } from "@/components/ui/States";
import { supabase, unwrap } from "@/lib/api";
import { signedUrls } from "@/lib/files";
import { formatDate, formatNumber } from "@/lib/format";
import { toast } from "@/lib/toast";

export interface DrawingRow {
  id: string;
  title: string;
  quote_id: string | null;
  invoice_id: string | null;
  property_id: string | null;
  show_on_quote: boolean;
  show_on_invoice: boolean;
  snapshot_path: string | null;
  total_area_sqft: number;
  total_length_ft: number;
  roofing_squares: number | null;
  created_at: string;
}
export const DRAWING_FIELDS = "id, title, quote_id, invoice_id, property_id, show_on_quote, show_on_invoice, snapshot_path, total_area_sqft, total_length_ft, roofing_squares, created_at";
type Patch = Partial<Pick<DrawingRow, "quote_id" | "invoice_id" | "show_on_quote" | "show_on_invoice">>;
const shownOn = (patch: Patch) => patch.show_on_quote ?? patch.show_on_invoice;
/** What the client will see changed somewhere else (the Client Hub, the PDF), so it gets a toast in the record's color. */
function toastFor(patch: Patch) {
  const shown = shownOn(patch);
  const where = patch.show_on_quote !== undefined ? "quote" : "invoice";
  if (shown !== undefined) toast.success(shown ? `Drawing shown on the ${where}` : `Drawing hidden from the client`, { tone: where });
  else if (patch.quote_id || patch.invoice_id) {
    const on = patch.quote_id ? "quote" : "invoice";
    toast.success(`Drawing added to the ${on}`, { description: `Turn on "Client sees it" to show it there.`, tone: on });
  }
}

/** Short-lived links to the saved pictures, for thumbnails. */
export function usePictures(paths: Array<string | null | undefined>) {
  const list = [...new Set(paths.filter(Boolean) as string[])].sort();
  return useQuery({
    queryKey: ["drawing-pictures", list],
    queryFn: () => signedUrls(list, 3600),
    enabled: list.length > 0,
    staleTime: 50 * 60_000,
    meta: { silent: true },
  });
}

export function sizes(m: Pick<DrawingRow, "total_area_sqft" | "total_length_ft" | "roofing_squares">) {
  return [
    Number(m.total_area_sqft) > 0 && `${formatNumber(Number(m.total_area_sqft))} sq ft`,
    Number(m.total_length_ft) > 0 && `${formatNumber(Number(m.total_length_ft))} ft`,
    m.roofing_squares ? `${m.roofing_squares} squares` : null,
  ].filter(Boolean).join(" · ") || "No sizes yet";
}

export function DrawingThumb({ url, title, size = 64 }: { url?: string; title: string; size?: number }) {
  return url ? (
    <img className="drawing-thumb" src={url} alt={`Map drawing: ${title}`} width={size} height={size} loading="lazy" />
  ) : (
    <span className="drawing-thumb drawing-thumb-empty" style={{ width: size, height: size }} aria-hidden="true"><Icon name="area" size={20} /></span>
  );
}

async function patchDrawing(id: string, patch: Patch) {
  unwrap(await supabase().from("measurements").update(patch).eq("id", id).select("id").single());
}

// ---------------------------------------------------------------------------------------------
// After saving on the Measure page: put it on a quote or invoice
// ---------------------------------------------------------------------------------------------

export function ShareDrawing({
  drawing, clientId, hasPicture, onChange,
}: {
  drawing: Pick<DrawingRow, "id" | "quote_id" | "invoice_id" | "show_on_quote" | "show_on_invoice">;
  clientId: string | null;
  hasPicture: boolean;
  onChange: (patch: Patch) => void;
}) {
  const queryClient = useQueryClient();
  const options = useQuery({
    queryKey: ["drawing-targets", clientId],
    queryFn: async () => {
      const db = supabase();
      let quotes = db.from("quotes").select("id, number, title, status, client:clients(display_name)").not("status", "in", "(lost,archived)").order("created_at", { ascending: false }).limit(40);
      let invoices = db.from("invoices").select("id, number, subject, status, client:clients(display_name)").neq("status", "void").order("created_at", { ascending: false }).limit(40);
      if (clientId) {
        quotes = quotes.eq("client_id", clientId);
        invoices = invoices.eq("client_id", clientId);
      }
      const [q, i] = await Promise.all([quotes, invoices]);
      return { quotes: unwrap(q), invoices: unwrap(i) };
    },
  });
  const update = useMutation({
    meta: { inline: true },
    mutationFn: async (patch: Patch) => {
      await patchDrawing(drawing.id, patch);
      return patch;
    },
    onSuccess: (patch) => {
      // Moving it to another quote or invoice hides it there (the database does the same).
      onChange({ ...patch, ...("quote_id" in patch ? { show_on_quote: false } : {}), ...("invoice_id" in patch ? { show_on_invoice: false } : {}) });
      queryClient.invalidateQueries({ queryKey: ["measurements"] });
      toastFor(patch);
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Couldn't change that"),
  });
  const attached = Boolean(drawing.quote_id || drawing.invoice_id);
  const name = (row: { client: unknown }) => (row.client as { display_name: string } | null)?.display_name;

  return (
    <div className="card card-pad stack-sm">
      <strong>Put it on a quote or invoice</strong>
      <span className="muted small">The picture and sizes go with it. You choose whether the client sees them.</span>
      {options.isPending ? (
        <span className="muted small">Loading quotes and invoices…</span>
      ) : options.error ? (
        <span className="field-error">Couldn't load quotes and invoices. <button type="button" className="link-btn" onClick={() => options.refetch()}>Try again</button></span>
      ) : (
        <>
          <label className="field">
            <span>Quote</span>
            <select className="select" value={drawing.quote_id ?? ""} disabled={update.isPending} onChange={(e) => update.mutate({ quote_id: e.target.value || null })}>
              <option value="">Not on a quote</option>
              {options.data.quotes.map((q) => <option key={q.id} value={q.id}>#{q.number} {q.title}{clientId ? "" : ` · ${name(q) ?? ""}`}</option>)}
            </select>
          </label>
          {drawing.quote_id && <ClientSees checked={drawing.show_on_quote} disabled={update.isPending} where="quote" onChange={(on) => update.mutate({ show_on_quote: on })} />}
          <label className="field">
            <span>Invoice</span>
            <select className="select" value={drawing.invoice_id ?? ""} disabled={update.isPending} onChange={(e) => update.mutate({ invoice_id: e.target.value || null })}>
              <option value="">Not on an invoice</option>
              {options.data.invoices.map((i) => <option key={i.id} value={i.id}>#{i.number}{i.subject ? ` ${i.subject}` : ""}{clientId ? "" : ` · ${name(i) ?? ""}`}</option>)}
            </select>
          </label>
          {drawing.invoice_id && <ClientSees checked={drawing.show_on_invoice} disabled={update.isPending} where="invoice" onChange={(on) => update.mutate({ show_on_invoice: on })} />}
          {!options.data.quotes.length && !options.data.invoices.length && (
            <span className="muted small">{clientId ? "This client has no open quotes or invoices yet." : "There are no open quotes or invoices yet."} Start one, then attach the drawing from its Drawings card.</span>
          )}
          <span className="muted small">
            {attached ? "Clients see a shown drawing on that quote or invoice, in the Client Hub and in its PDF. Hidden ones are for your team only." : "Pick a quote or invoice to put it on."}
          </span>
        </>
      )}
      {!hasPicture && (drawing.show_on_quote || drawing.show_on_invoice) && <span className="small" style={{ color: "var(--warning)" }}>No map picture was saved with this drawing, so the client would see the sizes only. Save again to add one.</span>}
      <div className="row wrap" style={{ gap: 8 }}>
        {drawing.quote_id && <Link className="btn btn-sm" to={`/quotes/${drawing.quote_id}`}><Icon name="quote" size={14} />Open the quote</Link>}
        {drawing.invoice_id && <Link className="btn btn-sm" to={`/invoices/${drawing.invoice_id}`}><Icon name="invoice" size={14} />Open the invoice</Link>}
      </div>
    </div>
  );
}

function ClientSees({ checked, disabled, where, onChange }: { checked: boolean; disabled: boolean; where: "quote" | "invoice"; onChange: (on: boolean) => void }) {
  return (
    <label className="switch-row" style={{ fontWeight: 400, marginTop: -4 }}>
      <input type="checkbox" className="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      Client sees it on this {where}
    </label>
  );
}

// ---------------------------------------------------------------------------------------------
// On a quote or invoice: the drawings on it, and others for the same property or client
// ---------------------------------------------------------------------------------------------

export function DrawingsCard({
  kind, parentId, candidates, measureUrl, editable, rowExtra, children,
}: {
  kind: "quote" | "invoice";
  parentId: string;
  /** PostgREST `or` filter for drawings that could go on this one (same property, client's properties). */
  candidates: string | null;
  measureUrl: string;
  editable: boolean;
  rowExtra?: (m: DrawingRow) => ReactNode;
  children?: ReactNode;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const column = kind === "quote" ? "quote_id" : "invoice_id";
  const shownKey = kind === "quote" ? "show_on_quote" : "show_on_invoice";
  const drawings = useQuery({
    queryKey: ["measurements", kind, parentId, candidates],
    queryFn: async () => {
      const filter = [`${column}.eq.${parentId}`, candidates].filter(Boolean).join(",");
      return unwrap(await supabase().from("measurements").select(DRAWING_FIELDS).or(filter).order("created_at", { ascending: false }).limit(12)) as DrawingRow[];
    },
  });
  const pictures = usePictures((drawings.data ?? []).map((m) => m.snapshot_path));
  const update = useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: Patch }) => patchDrawing(id, patch),
    onSuccess: (_, { patch }) => {
      queryClient.invalidateQueries({ queryKey: ["measurements"] });
      toastFor(patch);
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Couldn't change that"),
  });
  const rows = drawings.data ?? [];
  const on = rows.filter((m) => m[column] === parentId);
  const others = rows.filter((m) => m[column] !== parentId);
  const noun = kind === "quote" ? "quote" : "invoice";

  const row = (m: DrawingRow, attached: boolean) => {
    const open = `/measure?measurement=${m.id}&${kind}=${parentId}`;
    return (
      <div key={m.id} className="drawing-row">
        <Link to={open} className="drawing-row-thumb" aria-label={`Open ${m.title}`}><DrawingThumb url={m.snapshot_path ? pictures.data?.[m.snapshot_path] : undefined} title={m.title} /></Link>
        <div className="grow drawing-row-body">
          <Link to={open} className="strong text-sm drawing-row-title">{m.title}</Link>
          <span className="muted small">{sizes(m)} · {formatDate(m.created_at)}</span>
          {attached && editable && (
            <label className="switch-row small" style={{ fontWeight: 400 }}>
              <input type="checkbox" className="switch" checked={m[shownKey]} disabled={update.isPending} onChange={(e) => update.mutate({ id: m.id, patch: { [shownKey]: e.target.checked } })} />
              Client sees it
            </label>
          )}
          {attached && !editable && m[shownKey] && <span className="chip chip-green" style={{ justifySelf: "start" }}>Client sees it</span>}
          {attached && m[shownKey] && !m.snapshot_path && <span className="small" style={{ color: "var(--warning)" }}>No picture saved; the client sees the sizes only.</span>}
          {rowExtra?.(m)}
        </div>
        {editable && (attached ? (
          <Menu
            triggerClassName="btn btn-sm btn-ghost btn-icon"
            label="Drawing actions"
            items={[
              { label: "Open the drawing", icon: "area", onSelect: () => navigate(open) },
              { label: `Take off this ${noun}`, icon: "x", onSelect: () => update.mutate({ id: m.id, patch: { [column]: null } }) },
            ]}
          />
        ) : (
          <Button size="sm" onClick={() => update.mutate({ id: m.id, patch: { [column]: parentId } })} loading={update.isPending && update.variables?.id === m.id}>Add to {noun}</Button>
        ))}
      </div>
    );
  };

  return (
    <div className="card card-pad stack-sm">
      <div className="row-between">
        <strong>Drawings</strong>
        <Link className="btn btn-sm" to={measureUrl}><Icon name="area" size={14} />Measure</Link>
      </div>
      {drawings.isPending && <span className="muted small">Loading…</span>}
      {drawings.error && <span className="field-error">Couldn't load drawings. <button type="button" className="link-btn" onClick={() => drawings.refetch()}>Try again</button></span>}
      {/* One quiet line: "Measure" above is the way to make one. */}
      {drawings.data && !rows.length && <EmptyState inline title="No drawings yet" />}
      {on.map((m) => row(m, true))}
      {editable && others.length > 0 && (
        <>
          <span className="muted small" style={{ marginTop: 4 }}>{on.length ? "More for this client" : `Drawings for this client you can add to the ${noun}`}</span>
          {others.map((m) => row(m, false))}
        </>
      )}
      {/* What works with a drawing (the quote's depth for its formulas) waits until there is one. */}
      {rows.length > 0 && children}
    </div>
  );
}

/** The Drawings card on an invoice: drawings on it, and any for the client's properties or the job's quote. */
export function InvoiceDrawings({ invoiceId, clientId, jobId, editable }: { invoiceId: string; clientId: string; jobId: string | null; editable: boolean }) {
  const scope = useQuery({
    queryKey: ["drawing-scope", clientId, jobId],
    queryFn: async () => {
      const db = supabase();
      const [properties, job] = await Promise.all([
        db.from("properties").select("id").eq("client_id", clientId).limit(50),
        jobId ? db.from("jobs").select("quote_id, property_id").eq("id", jobId).maybeSingle() : null,
      ]);
      return { properties: unwrap(properties).map((p) => p.id), job: job ? unwrap(job) : null };
    },
  });
  if (!scope.data) return null;
  const { properties, job } = scope.data;
  const candidates = [properties.length ? `property_id.in.(${properties.join(",")})` : null, job?.quote_id ? `quote_id.eq.${job.quote_id}` : null].filter(Boolean).join(",") || null;
  const property = job?.property_id ?? (properties.length === 1 ? properties[0] : null);
  return <DrawingsCard kind="invoice" parentId={invoiceId} candidates={candidates} measureUrl={`/measure?invoice=${invoiceId}${property ? `&property=${property}` : ""}`} editable={editable} />;
}
