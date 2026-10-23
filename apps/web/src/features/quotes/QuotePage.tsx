import type { TablesUpdate } from "@crewtavo/core/database";
import { inRangeMode } from "@crewtavo/core/estimates";
import { taxPercent, taxRateFromPercent } from "@crewtavo/core/money";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { Dialog } from "@/components/ui/Dialog";
import { Field, FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { Menu } from "@/components/ui/Menu";
import { MoneyInput } from "@/components/ui/MoneyInput";
import { BackLink, useDocumentTitle } from "@/components/ui/PageHeader";
import { DetailSkeleton } from "@/components/ui/Skeleton";
import { PageError } from "@/components/ui/States";
import { EntityStatus } from "@/components/ui/StatusPill";
import { api, supabase, unwrap, unwrapOne } from "@/lib/api";
import { addressLine, dateIn, formatDate, formatMoney, formatMoneyCents, formatTaxRate, timeAgo, todayIn } from "@/lib/format";
import { useRememberRecent } from "@/lib/recent";
import { can, hasRole, useSession } from "@/lib/session";
import { documentCompany, mySignatureKey, quoteDocument, quoteTemplate, readApproval, signedTemplate, templatesQuery, useLetterhead, useMySignature, useQuoteTemplate, useTemplates, type QuoteApproval } from "../documents/data";
import { SignaturePad } from "../field/SignaturePad";
import { DrawingsCard } from "../measure/drawings";
import { PlansCard } from "../plans/PlansCard";
import { dayText, documentFacts } from "../roofing/flow/model";
import { QuotePrint, useQuotePrint } from "../roofing/flow/QuotePrint";
import { SendEstimateDialog } from "../roofing/flow/SendEstimateDialog";
import { LineItems } from "./LineItems";
import { DiscountRows } from "./PromoRow";
import { SendDialog } from "./SendDialog";

export { SendDialog } from "./SendDialog";

const EDITABLE = ["draft", "sent", "changes_requested"];
/** Before the quote has loaded: the business's default template. */
const NO_QUOTE = { template_id: null, approval: null };
const LOST_REASONS = ["Price was too high", "Went with another company", "Timing didn't work", "No response", "Scope changed", "Other"];

export function QuotePage() {
  const { id = "" } = useParams();
  const session = useSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<null | "send" | "exact" | "lost">(null);
  const canSell = hasRole(session, "admin", "office", "estimator") && can(session, "sales");

  const quote = useQuery({
    queryKey: ["quote", id],
    queryFn: async () =>
      unwrapOne(
        await supabase()
          .from("quotes")
          .select("id, number, title, status, message, subtotal, discount_amount, tax_rate, tax_amount, total, deposit_amount, valid_until, sent_at, approved_at, approval, lost_reason, request_id, created_at, template_id, promo:promo_codes(code, kind, value, description), request:requests(promo_code), client:clients(id, display_name, email, phone), property:properties(id, line1, city, region, postal_code, lat, lng), lines:quote_line_items(id, name, description, quantity, unit, unit_price, unit_cost, taxable, optional, selected, formula, sort, service_id), jobs!jobs_company_id_quote_id_fkey(id, number), change_order_for, change_job:jobs!quotes_change_order_fkey(id, number, title), package:roof_packages!quotes_roof_package_fkey(name), range_low, range_high, range_accepted_at, priced_on_site_at, exact_sent_at")
          .eq("id", id)
          .order("sort", { referencedTable: "quote_line_items" })
          .maybeSingle(),
        "This quote",
      ),
  });
  const q = quote.data;
  const templates = useTemplates();
  // The look it prints with: the template it was signed on once it's signed, else the one it's set to.
  const { template } = useQuoteTemplate(q ?? NO_QUOTE);
  useDocumentTitle(q ? `Quote #${q.number}` : "Quote");
  useRememberRecent(session.company.id, q ? { kind: "quote", id: q.id, title: q.title, subtitle: `Quote #${q.number} · ${q.client?.display_name ?? ""}`, path: `/quotes/${q.id}` } : null);

  const history = useQuery({
    queryKey: ["quote", id, "history"],
    enabled: canSell,
    meta: { silent: true },
    queryFn: async () => {
      const [activity, messages] = await Promise.all([
        supabase().from("activity").select("id, verb, summary, created_at").eq("subject_type", "quote").eq("subject_id", id).order("created_at", { ascending: false }).limit(20),
        supabase().from("messages").select("id, channel, direction, subject, body, created_at").eq("related_type", "quote").eq("related_id", id).order("created_at", { ascending: false }).limit(20),
      ]);
      return { activity: unwrap(activity), messages: unwrap(messages) };
    },
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["quote", id] });
    queryClient.invalidateQueries({ queryKey: ["quotes", session.company.id] });
  };
  const update = useMutation({
    meta: { success: (_: unknown, patch: TablesUpdate<"quotes">) => (patch.status === "approved" ? "Marked approved" : patch.status === "lost" ? "Marked lost" : patch.status === "archived" ? "Quote archived" : patch.status === "draft" ? "Moved back to draft" : null) },
    mutationFn: async (patch: TablesUpdate<"quotes">) => unwrap(await supabase().from("quotes").update(patch).eq("id", id)),
    onSuccess: refresh,
  });
  // Marked approved by the office: like a signed estimate, it keeps the template it was approved on.
  const approve = useMutation({
    meta: { success: "Marked approved" },
    mutationFn: async () => {
      const rows = await queryClient.ensureQueryData(templatesQuery(session.company.id));
      const approval = { name: session.profile.full_name || "Office", method: "manual", template: { ...quoteTemplate(rows, q!) } };
      return unwrap(await supabase().from("quotes").update({ status: "approved", approved_at: new Date().toISOString(), approval }).eq("id", id));
    },
    onSuccess: refresh,
  });
  const convert = useMutation({
    meta: { success: () => (quote.data?.change_order_for ? "Added to the job" : "Converted to a job. Schedule the work next.") },
    mutationFn: () => api.post<{ job_id: string }>(`/quotes/${id}/convert`),
    onSuccess: (res) => {
      refresh();
      navigate(`/jobs/${res.job_id}`);
    },
  });
  const duplicate = useMutation({
    meta: { success: "Quote copied as a new draft" },
    mutationFn: async () => {
      const copy = unwrap(
        await supabase()
          .from("quotes")
          .insert({
            company_id: session.company.id, client_id: q!.client!.id, property_id: q!.property?.id ?? null, title: `${q!.title} (copy)`, message: q!.message,
            discount_amount: q!.discount_amount, tax_rate: q!.tax_rate, deposit_amount: q!.deposit_amount,
            valid_until: q!.valid_until && q!.valid_until > todayIn(session.company.timezone) ? q!.valid_until : null,
          })
          .select("id")
          .single(),
      );
      if (q!.lines.length) {
        unwrap(
          await supabase().from("quote_line_items").insert(
            q!.lines.map(({ id: _id, ...line }) => ({ ...line, selected: line.optional ? false : true, company_id: session.company.id, quote_id: copy.id })),
          ),
        );
      }
      return copy.id;
    },
    onSuccess: (newId) => navigate(`/quotes/${newId}`),
  });
  const remove = useMutation({
    meta: { success: "Quote deleted" },
    mutationFn: async () => unwrap(await supabase().from("quotes").delete().eq("id", id)),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["quotes", session.company.id] });
      navigate("/quotes", { replace: true });
    },
  });
  const openClientView = useMutation({
    mutationFn: () => api.get<{ link: string }>(`/quotes/${id}/link`),
    onSuccess: ({ link }) => window.open(link, "_blank", "noopener"),
  });
  // Printing is the template document from the quote itself: the exact price, even while the
  // client's link shows a range. The roof it shows comes from the drawing the client sees.
  const letterhead = useLetterhead();
  const printer = useQuotePrint();
  const [roof, setRoof] = useState<{ roofing_squares: number | null; roof_pitch: string | null } | null>(null);
  const print = useMutation({
    mutationFn: async () => {
      // With the templates loaded, so it never prints on the built-in look by mistake.
      const [m] = await Promise.all([
        supabase().from("measurements").select("roofing_squares, roof_pitch").eq("quote_id", id).eq("show_on_quote", true).order("updated_at", { ascending: false }).limit(1).maybeSingle(),
        queryClient.ensureQueryData(templatesQuery(session.company.id)),
      ]);
      return unwrap(m);
    },
    onSuccess: (m) => {
      setRoof(m ?? null);
      printer.print();
    },
  });

  if (quote.isPending) return <DetailSkeleton />;
  if (quote.error || !q) return <PageError error={quote.error} onRetry={() => quote.refetch()} back={<BackLink to="/quotes">Quotes</BackLink>} />;

  const editable = canSell && EDITABLE.includes(q.status);
  // A roof estimate out as a price range: the client hasn't seen this exact price yet.
  const ranged = inRangeMode(q);
  // And they said yes to it. Sending the range again would ask them all over, so it isn't offered:
  // the visit sets the exact price, or the office sends it instead.
  const rangeAccepted = ranged && Boolean(q.range_accepted_at);
  const approval = readApproval(q.approval);
  // The picker beside the totals. A signed quote keeps the template it was signed on.
  const templateRows = templates.data ?? [];
  const frozen = signedTemplate(q) !== null;
  const templateId = q.template_id && templateRows.some((t) => t.id === q.template_id) ? q.template_id : templateRows.find((t) => t.is_default)?.id ?? templateRows[0]?.id ?? "";
  // Signing for the business is offered on approved quotes, and on jobs whose client signed online.
  const signatures = (
    <ApprovalSignatures quoteId={q.id} approval={approval} approvedAt={q.approved_at} companySigns={template.company_signs} canSign={canSell && (q.status === "approved" || Boolean(approval?.signature))} onSigned={refresh} />
  );
  const changeRequest = history.data?.messages.find((m) => m.direction === "in" && m.subject === "Changes requested");
  const expired = q.valid_until && q.valid_until < todayIn(session.company.timezone) && ["sent", "draft"].includes(q.status);
  const cost = q.lines.filter((l) => !(l.optional && !l.selected)).reduce((s, l) => s + Number(l.quantity) * Number(l.unit_cost ?? 0), 0);
  const priceForMargin = Number(q.subtotal) - Number(q.discount_amount);
  // A change order adds to an existing job instead of becoming a new one.
  const changeJob = q.change_job as { id: string; number: number; title: string } | null;
  const convertLabel = changeJob ? `Add to job #${changeJob.number}` : "Convert to job";

  return (
    <>
      <BackLink to="/quotes">Quotes</BackLink>
      <div className="page-header">
        <h1 className="page-title">{editable ? <TitleInput value={q.title} onSave={(title) => update.mutate({ title })} /> : q.title}</h1>
        {canSell && (
          <div className="page-actions">
            {EDITABLE.includes(q.status) &&
              (rangeAccepted ? (
                <Button icon="send" variant="secondary" onClick={() => setDialog("exact")} disabled={!q.lines.length}>Send the exact price</Button>
              ) : (
                <Button icon="send" variant={q.status === "draft" ? "primary" : "secondary"} onClick={() => setDialog("send")} disabled={!q.lines.length} title={!q.lines.length ? "Add a line item first" : undefined}>{q.status === "draft" ? "Send quote" : "Resend"}</Button>
              ))}
            {q.status !== "draft" && ["approved", "sent", "changes_requested"].includes(q.status) && (
              <Button variant={q.status === "approved" ? "primary" : "secondary"} icon="job" loading={convert.isPending} disabled={!q.lines.length} onClick={() => convert.mutate()}>{convertLabel}</Button>
            )}
            <Menu
              items={[
                { label: "Preview as client", icon: "eye", onSelect: () => openClientView.mutate() },
                { label: "Print or save PDF", icon: "printer", onSelect: () => print.mutate() },
                { label: "Duplicate quote", icon: "copy", onSelect: () => duplicate.mutate() },
                { separator: true },
                { label: "Mark approved", icon: "check", hidden: !["sent", "changes_requested", "draft"].includes(q.status), disabled: approve.isPending, onSelect: () => approve.mutate() },
                { label: convertLabel, icon: "job", hidden: q.status !== "draft", onSelect: () => convert.mutate() },
                { label: "Mark as lost", icon: "x", hidden: !EDITABLE.includes(q.status), onSelect: () => setDialog("lost") },
                { label: "Reopen as draft", icon: "undo", hidden: !["lost", "archived"].includes(q.status), onSelect: () => update.mutate({ status: "draft", lost_reason: null }) },
                { label: "Archive", icon: "archive", hidden: ["archived", "converted"].includes(q.status), onSelect: () => update.mutate({ status: "archived" }) },
                {
                  label: "Delete quote",
                  icon: "trash",
                  danger: true,
                  hidden: !["draft", "lost", "archived"].includes(q.status) || q.jobs.length > 0,
                  onSelect: async () => {
                    if (await confirm({ title: `Delete quote #${q.number}?`, body: "Its line items are deleted too. This can't be undone.", confirmLabel: "Delete quote", danger: true })) remove.mutate();
                  },
                },
              ]}
            />
          </div>
        )}
      </div>
      <div className="page-meta">
        <span className="muted">Quote #{q.number}</span>
        <EntityStatus kind="quote" status={q.status} />
        {q.client && <Link to={`/clients/${q.client.id}`} className="strong">{q.client.display_name}</Link>}
        {q.property && <span className="muted">{addressLine(q.property)}</span>}
      </div>

      {q.status === "approved" && (
        <div className="callout callout-good">
          <Icon name="check" size={18} />
          <div className="grow">
            <div>{approval?.method === "in_person" ? "Signed on site" : "Approved"} {q.approved_at ? formatDate(q.approved_at) : ""}{approval?.name ? ` by ${approval.name}` : ""}</div>
            {signatures}
          </div>
          {canSell && <Button size="sm" variant="primary" loading={convert.isPending} onClick={() => convert.mutate()}>{convertLabel}</Button>}
        </div>
      )}
      {changeJob && (
        <div className="callout callout-info">
          <Icon name="job" size={18} />
          <div className="grow">
            <div>Change order for <Link to={`/jobs/${changeJob.id}`} className="strong">job #{changeJob.number}</Link>: {changeJob.title}</div>
            <div className="small" style={{ fontWeight: 400 }}>{q.status === "converted" ? "It's been added to the job." : "Once the client approves it, its items are added to the job and its total goes up."}</div>
          </div>
        </div>
      )}
      {!changeJob && q.status === "converted" && q.jobs.length > 0 && (
        <div className="callout callout-info">
          <Icon name="job" size={18} />
          <div className="grow">
            <div>Converted to <Link to={`/jobs/${q.jobs[0].id}`} className="strong">job #{q.jobs[0].number}</Link>.</div>
            {approval && signatures}
          </div>
        </div>
      )}
      {q.status === "changes_requested" && (
        <div className="callout callout-warning">
          <Icon name="messages" size={18} />
          <div className="grow">
            <div>{q.client?.display_name ?? "The client"} asked for changes</div>
            {changeRequest && <div className="pre-wrap small" style={{ fontWeight: 400, marginTop: 4 }}>“{changeRequest.body}”</div>}
            <div className="small" style={{ fontWeight: 400, marginTop: 4 }}>Update the quote, then resend it.</div>
          </div>
        </div>
      )}
      {q.status === "lost" && <div className="callout callout-danger"><Icon name="x" size={18} /><div className="grow">Marked lost{q.lost_reason ? `: ${q.lost_reason}` : ""}.</div></div>}
      {q.status === "sent" && q.sent_at && (
        <div className="callout">
          <Icon name="clock" size={18} />
          <div className="grow">
            {rangeAccepted
              ? `${q.client?.display_name ?? "The client"} said yes to the range, ${formatMoney(q.range_low)} to ${formatMoney(q.range_high)}, on ${dayText(q.range_accepted_at!, session.company.timezone)}. Book the site visit: the exact price is set there.`
              : ranged
              ? `Sent ${timeAgo(q.sent_at)} as a price range, ${formatMoney(q.range_low)} to ${formatMoney(q.range_high)}. ${q.client?.display_name ?? "The client"} sees the range, not this exact price, until it's priced on site.`
              : `Sent ${timeAgo(q.sent_at)}. Waiting for ${q.client?.display_name ?? "the client"} to respond.`}
            {expired ? " This quote has expired; update the date before resending." : ""}
          </div>
        </div>
      )}

      <div className="two-col">
        <div className="wide stack-lg">
          <LineItems table="quote_line_items" parent="quote_id" parentId={q.id} lines={q.lines} editable={editable} onChanged={refresh} withOptions />
          <MessageCard value={q.message} editable={editable} onSave={(message) => update.mutate({ message })} />
          {canSell && <PlansCard scope={{ kind: "quote", id: q.id, propertyId: q.property?.id ?? null }} />}
        </div>
        <aside className="narrow stack">
          <div className="card card-pad totals">
            <div className="line"><span>Subtotal</span><span>{formatMoneyCents(q.subtotal)}</span></div>
            <DiscountRows
              kind="quote"
              id={q.id}
              promo={q.promo}
              discount={Number(q.discount_amount)}
              subtotal={Number(q.subtotal)}
              canEditDiscount={editable}
              canChangePromo={editable}
              suggestedCode={q.request?.promo_code}
              onSaveDiscount={(v) => update.mutate({ discount_amount: v })}
              onChanged={refresh}
            />
            <div className="line">
              <span>Tax {editable ? "" : `(${formatTaxRate(q.tax_rate)})`}</span>
              {editable ? <MoneyInput percent label="Tax rate" value={taxPercent(q.tax_rate)} max={99.99} onSave={(v) => update.mutate({ tax_rate: taxRateFromPercent(v) })} /> : <span>{formatMoneyCents(q.tax_amount)}</span>}
            </div>
            {editable && <div className="line"><span>Tax amount</span><span>{formatMoneyCents(q.tax_amount)}</span></div>}
            <div className="line grand"><span>Total</span><span>{formatMoneyCents(q.total)}</span></div>
            <div className="line">
              <span>Deposit required</span>
              {editable ? <MoneyInput label="Deposit" value={Number(q.deposit_amount)} max={Number(q.total)} onSave={(v) => update.mutate({ deposit_amount: v })} /> : <span>{formatMoneyCents(q.deposit_amount)}</span>}
            </div>
            <div className="line">
              <span>Valid until</span>
              {editable ? (
                <input className="input input-sm" type="date" style={{ width: 150 }} value={q.valid_until ?? ""} onChange={(e) => update.mutate({ valid_until: e.target.value || null })} aria-label="Valid until" />
              ) : (
                <span>{formatDate(q.valid_until)}</span>
              )}
            </div>
          </div>
          {canSell && templateRows.length > 1 && (
            <div className="card card-pad stack-sm">
              <label htmlFor="quote-template"><strong>Template</strong></label>
              <select
                id="quote-template"
                className="select"
                value={templateId}
                disabled={!editable || update.isPending}
                onChange={(e) => {
                  const chosen = templateRows.find((t) => t.id === e.target.value);
                  // The default one isn't pinned: the quote follows whichever template is the default.
                  if (chosen) update.mutate({ template_id: chosen.is_default ? null : chosen.id });
                }}
              >
                {templateRows.map((t) => <option key={t.id} value={t.id}>{t.name}{t.is_default ? " (default)" : ""}</option>)}
              </select>
              <span className="muted small">{frozen ? "It keeps the look it was signed with." : "How it looks printed, as a PDF and on the client's link."}</span>
            </div>
          )}
          {canSell && cost > 0 && (
            <div className="card card-pad stack-sm">
              <strong>Profit estimate</strong>
              <div className="totals">
                <div className="line"><span>Price before tax</span><span>{formatMoneyCents(priceForMargin)}</span></div>
                <div className="line"><span>Estimated cost</span><span>{formatMoneyCents(cost)}</span></div>
                <div className="line grand" style={{ fontSize: 15 }}><span>Profit</span><span style={{ color: priceForMargin - cost < 0 ? "var(--danger)" : "var(--green-dark)" }}>{formatMoneyCents(priceForMargin - cost)} {priceForMargin > 0 && `(${Math.round(((priceForMargin - cost) / priceForMargin) * 100)}%)`}</span></div>
              </div>
            </div>
          )}
          {canSell && <MeasurementsCard quoteId={q.id} propertyId={q.property?.id ?? null} lat={q.property?.lat ?? null} lng={q.property?.lng ?? null} editable={editable} onApplied={refresh} />}
          {canSell && !!history.data?.activity.length && (
            <div className="card">
              <div className="card-head"><strong>History</strong></div>
              <div className="timeline">
                {history.data.activity.map((a) => (
                  <div key={a.id} className="timeline-item" style={{ padding: "10px 20px" }}>
                    <span className="t-icon" style={{ width: 28, height: 28 }}><Icon name={a.verb.endsWith("approved") || a.verb.endsWith("accepted") ? "check" : a.verb.endsWith("sent") ? "send" : "history"} size={14} /></span>
                    <div><div className="text-sm">{a.summary}</div><div className="t-meta">{timeAgo(a.created_at)}</div></div>
                  </div>
                ))}
                <div className="timeline-item" style={{ padding: "10px 20px" }}>
                  <span className="t-icon" style={{ width: 28, height: 28 }}><Icon name="plus" size={14} /></span>
                  <div><div className="text-sm">Quote created</div><div className="t-meta">{timeAgo(q.created_at)}</div></div>
                </div>
              </div>
            </div>
          )}
        </aside>
      </div>

      {printer.request > 0 && (
        <QuotePrint
          request={printer.request}
          template={template}
          company={letterhead.data ?? documentCompany(session.company)}
          data={quoteDocument(q, q.lines, {
            date: q.sent_at ? dateIn(q.sent_at, session.company.timezone) : todayIn(session.company.timezone),
            facts: documentFacts((q.package as { name: string } | null)?.name, roof),
          })}
        />
      )}
      {dialog === "send" &&
        (ranged ? (
          // Out as a range: resending sends the range again, never an email with the exact total.
          <SendEstimateDialog quote={q} mode="range" onClose={() => setDialog(null)} onSent={refresh} />
        ) : (
          <SendDialog kind="quote" id={q.id} number={q.number} email={q.client?.email ?? null} phone={q.client?.phone ?? null} onClose={() => setDialog(null)} onSent={refresh} />
        ))}
      {/* They said yes to the range: the exact price goes out instead, the way the roofing project offers it. */}
      {dialog === "exact" && <SendEstimateDialog quote={q} mode="exact" onClose={() => setDialog(null)} onSent={refresh} />}
      {dialog === "lost" && <LostDialog onClose={() => setDialog(null)} onSave={(reason) => update.mutateAsync({ status: "lost", lost_reason: reason }).then(() => setDialog(null))} />}
    </>
  );
}

/**
 * Who signed an approved quote: the customer, and the business. When the template has a line for
 * the business and nobody has signed it yet, a salesperson signs for it here: their saved signature
 * in one tap, or drawn in a small dialog (and saved for next time).
 */
function ApprovalSignatures({ quoteId, approval, approvedAt, companySigns, canSign, onSigned }: {
  quoteId: string;
  approval: QuoteApproval | null;
  approvedAt: string | null;
  companySigns: boolean;
  canSign: boolean;
  onSigned: () => void;
}) {
  const { company, userId } = useSession();
  const queryClient = useQueryClient();
  const [drawing, setDrawing] = useState(false);
  const needsCompany = companySigns && canSign && !approval?.company;
  const mine = useMySignature({ enabled: needsCompany });
  const countersign = useMutation({
    meta: { inline: drawing, success: `Signed for ${company.name}` },
    mutationFn: (body: { signature?: string; save_signature?: boolean }) => api.post<{ ok: true }>(`/quotes/${quoteId}/countersign`, body),
    onSuccess: (_, body) => {
      if (body.save_signature && body.signature) queryClient.setQueryData(mySignatureKey(company.id, userId), body.signature);
      setDrawing(false);
      onSigned();
    },
  });
  const customer = approval && approval.method !== "manual" && approval.signature ? approval : null;
  if (!customer && !approval?.company && !needsCompany) return null;
  return (
    <div className="row wrap" style={{ gap: 16, marginTop: 10, alignItems: "flex-start" }}>
      {customer && <SignatureTile image={customer.signature!} name={customer.name || "The client"} caption={`Signed ${formatDate(customer.signed_at ?? approvedAt)}`} />}
      {approval?.company ? (
        <SignatureTile image={approval.company.signature} name={approval.company.name || company.name} caption={`For ${company.name}`} />
      ) : (
        needsCompany && (
          <div className="stack-sm" style={{ gap: 6, alignSelf: "center" }}>
            <Button size="sm" icon="signature" loading={countersign.isPending || mine.isPending} onClick={() => (mine.data ? countersign.mutate({}) : setDrawing(true))}>
              Sign for {company.name}
            </Button>
            <span className="small" style={{ fontWeight: 400 }}>{mine.data ? "With your saved signature." : "The business's line is still blank."}</span>
          </div>
        )
      )}
      {drawing && (
        <CountersignDialog companyName={company.name} pending={countersign.isPending} error={countersign.error} onClose={() => setDrawing(false)} onSign={(body) => countersign.mutate(body)} />
      )}
    </div>
  );
}

function SignatureTile({ image, name, caption }: { image: string; name: string; caption: string }) {
  return (
    <div className="stack-sm" style={{ gap: 2 }}>
      <img src={image} alt={`Signature of ${name}`} style={{ height: 56, width: 180, objectFit: "contain", background: "#fff", borderRadius: 8, padding: 4, border: "1px solid var(--border)" }} />
      <span className="small" style={{ fontWeight: 700 }}>{name}</span>
      <span className="small" style={{ fontWeight: 400 }}>{caption}</span>
    </div>
  );
}

function CountersignDialog({ companyName, pending, error, onClose, onSign }: { companyName: string; pending: boolean; error: unknown; onClose: () => void; onSign: (body: { signature: string; save_signature: boolean }) => void }) {
  const [signature, setSignature] = useState<string | null>(null);
  const [keep, setKeep] = useState(true);
  return (
    <Dialog open onClose={onClose} title={`Sign for ${companyName}`} description="Your signature goes on the business's line of this estimate." size="sm">
      <form
        className="stack"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          if (signature) onSign({ signature, save_signature: keep });
        }}
      >
        <SignaturePad value={signature} onChange={setSignature} label="Sign with your finger or mouse" />
        <label className="checkbox">
          <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} />
          Save my signature for next time
        </label>
        <FormError error={error} />
        <div className="form-actions">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" icon="signature" loading={pending} disabled={!signature}>Sign for {companyName}</Button>
        </div>
      </form>
    </Dialog>
  );
}

function LostDialog({ onClose, onSave }: { onClose: () => void; onSave: (reason: string) => Promise<unknown> }) {
  const [reason, setReason] = useState(LOST_REASONS[0]);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  return (
    <Dialog open onClose={onClose} title="Mark quote as lost" size="sm">
      <form
        onSubmit={async (e: FormEvent) => {
          e.preventDefault();
          setSaving(true);
          await onSave([reason, note.trim()].filter(Boolean).join(": ")).finally(() => setSaving(false));
        }}
      >
        <Field label="Reason">
          <select className="select" value={reason} onChange={(e) => setReason(e.target.value)}>
            {LOST_REASONS.map((r) => <option key={r}>{r}</option>)}
          </select>
        </Field>
        <Field label="Note" optional><input className="input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} /></Field>
        <div className="form-actions">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="danger-solid" loading={saving}>Mark lost</Button>
        </div>
      </form>
    </Dialog>
  );
}

function TitleInput({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <input
      className="title-input"
      aria-label="Quote title"
      value={draft}
      maxLength={200}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => (draft.trim() ? draft.trim() !== value && onSave(draft.trim()) : setDraft(value))}
      onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
    />
  );
}

function MessageCard({ value, editable, onSave }: { value: string | null; editable: boolean; onSave: (v: string) => void }) {
  const { config } = useSession();
  const [draft, setDraft] = useState(value ?? "");
  useEffect(() => setDraft(value ?? ""), [value]);
  const polish = useMutation({
    meta: { success: "Polished. Review it before sending." },
    mutationFn: () => api.post<{ text: string }>("/ai/rewrite", { text: draft }),
    onSuccess: (res) => {
      setDraft(res.text);
      onSave(res.text);
    },
  });
  if (!editable) {
    return value ? <div className="card card-pad"><strong>Message to client</strong><p className="pre-wrap" style={{ margin: "8px 0 0" }}>{value}</p></div> : null;
  }
  return (
    <div className="card card-pad stack-sm">
      <label htmlFor="quote-message"><strong>Message to client</strong> <span className="muted small">(shown above the line items)</span></label>
      <textarea id="quote-message" className="textarea" value={draft} maxLength={4000} onChange={(e) => setDraft(e.target.value)} onBlur={() => draft !== (value ?? "") && onSave(draft)} placeholder="Thanks for having us out. Here's what we recommend…" />
      {config.features.ai && (
        <div className="row">
          <Button size="sm" icon="sparkle" loading={polish.isPending} disabled={draft.trim().length < 3} onClick={() => polish.mutate()}>Polish with AI</Button>
        </div>
      )}
    </div>
  );
}

function MeasurementsCard({ quoteId, propertyId, lat, lng, editable, onApplied }: { quoteId: string; propertyId: string | null; lat: number | null; lng: number | null; editable: boolean; onApplied: () => void }) {
  const [depth, setDepth] = useState("");
  const apply = useMutation({
    meta: { success: (r: { lines: unknown[] }) => (r.lines.length ? "Quantities filled from the measurement" : null) },
    mutationFn: (measurementId: string) =>
      api.post<{ lines: Array<{ name: string; field?: string; value?: number; error?: string }> }>(`/quotes/${quoteId}/apply-measurement`, {
        measurement_id: measurementId,
        depth_in: depth ? Number(depth) : undefined,
      }),
    onSuccess: onApplied,
  });
  const measureUrl = `/measure?quote=${quoteId}${propertyId ? `&property=${propertyId}` : ""}${lat != null ? `&lat=${lat}&lng=${lng}` : ""}`;
  return (
    <DrawingsCard
      kind="quote"
      parentId={quoteId}
      candidates={propertyId ? `property_id.eq.${propertyId}` : null}
      measureUrl={measureUrl}
      editable
      rowExtra={(m) =>
        editable && (
          <Button size="sm" style={{ justifySelf: "start" }} loading={apply.isPending && apply.variables === m.id} onClick={() => apply.mutate(m.id)}>Fill quantities from this</Button>
        )
      }
    >
      {editable && (
        <Field label="Depth (inches)" hint="Used by formulas that need a depth, like mulch or asphalt.">
          <input className="input" inputMode="decimal" value={depth} onChange={(e) => setDepth(e.target.value.replace(/[^0-9.]/g, ""))} placeholder="2" />
        </Field>
      )}
      {apply.data && (
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12 }}>
          {apply.data.lines.map((l) => <li key={l.name}>{l.name}: {l.error ? <span className="error-text">{l.error}</span> : `${l.field === "unit_price" ? "price" : "qty"} ${l.value}`}</li>)}
          {apply.data.lines.length === 0 && <li className="muted">No lines on this quote use a formula.</li>}
        </ul>
      )}
    </DrawingsCard>
  );
}
