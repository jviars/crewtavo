/**
 * What subs were paid, for the people who check it: each sub's total for a calendar year with who
 * needs a 1099-NEC (the bookkeeper's list), and the workers' comp audit for a policy period (the
 * auditor's). Both are worked out by the database and the API (services/jobPay.ts), and download
 * as CSV. No tax ID numbers anywhere: they stay on the W-9.
 */
import { certificateText, coverageLabel, jobPayStatusLabel, wcPartNote, type WcCertificate } from "@crewtavo/core/jobPay";
import { taxClassificationLabel } from "@crewtavo/core/subs";
import { useMutation } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { BackLink, PageHeader, useDocumentTitle } from "@/components/ui/PageHeader";
import { CardSkeleton, Loading } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState, NoAccess } from "@/components/ui/States";
import { StatusPill } from "@/components/ui/StatusPill";
import { api } from "@/lib/api";
import { downloadCsv } from "@/lib/csv";
import { formatMoneyCents, todayIn } from "@/lib/format";
import { useSession } from "@/lib/session";
import { Kpi, KpiStrip } from "../finance/Charts";
import { auditPresets, coverageTone, defaultYear, thresholdText, workDays, yearChoices } from "./pay";
import { handlesSubPay, useWcAudit, useYearTotals } from "./payData";

const download = (path: string) => api.get<{ filename: string; csv: string }>(path).then((r) => downloadCsv(r.filename, r.csv));

// ---------------------------------------------------------------------------------------------
// Year-end totals
// ---------------------------------------------------------------------------------------------

export function YearEndPage() {
  const session = useSession();
  if (!handlesSubPay(session)) return <NoAccess title="Year-end totals" />;
  return <YearEnd />;
}

function YearEnd() {
  const session = useSession();
  const today = todayIn(session.company.timezone);
  const [params, setParams] = useSearchParams();
  const choices = yearChoices(today);
  const asked = Number(params.get("year"));
  const year = Number.isInteger(asked) && asked >= 2000 && asked <= Number(today.slice(0, 4)) ? asked : defaultYear(today);
  const totals = useYearTotals(year);
  const csv = useMutation({ meta: { inline: true }, mutationFn: () => download(`/subs/1099/csv?year=${year}`) });
  useDocumentTitle("Year-end totals");
  const d = totals.data;
  const card = d ? d.subs.reduce((s, r) => s + r.card_or_app_total, 0) : 0;
  const payroll = d ? d.subs.some((r) => (r.payroll_total ?? 0) > 0) : false;

  return (
    <>
      <BackLink to="/subs">Subcontractors</BackLink>
      <PageHeader
        title="Year-end totals"
        actions={
          <>
            <label className="select-pill">
              <Icon name="calendar" size={15} />
              <select value={year} onChange={(e) => setParams({ year: e.target.value }, { replace: true })} aria-label="Year">
                {(choices.includes(year) ? choices : [year, ...choices]).map((y) => <option key={y} value={y}>{y}</option>)}
              </select>
              <Icon name="chevronDown" size={14} />
            </label>
            <Button icon="download" loading={csv.isPending} disabled={!d?.subs.length} onClick={() => csv.mutate()}>Download CSV</Button>
          </>
        }
      />
      <p className="page-subtitle">What you paid each sub in {year}, by the day you paid them, for their 1099-NEC.</p>
      <FormError error={csv.error} />

      {totals.isPending && <Loading><CardSkeleton lines={5} /></Loading>}
      {totals.error && <div className="card"><ErrorState error={totals.error} onRetry={() => totals.refetch()} /></div>}
      {d && (
        <div className="stack">
          <div className="callout callout-info">
            <Icon name="info" size={18} />
            <div className="grow stack-sm" style={{ fontWeight: 400 }}>
              <span>{thresholdText(year, d.threshold)}{d.threshold_note ? ` ${d.threshold_note}` : ""}</span>
              <span>Card and payment-app payments are left out: the card company or app reports those on a 1099-K.</span>
              {payroll && <span>Payments through your payroll service are counted. If the service paid a sub, it may file their 1099 itself: check before you send one.</span>}
              <span>Tax ID numbers aren't kept here. Your bookkeeper takes them from each sub's W-9 on file.</span>
            </div>
          </div>
          {d.subs.length === 0 ? (
            <div className="card"><EmptyState icon="dollar" title={`No subs were marked paid in ${year}`}>Mark subs' pay paid from a job, from their page, or from what's owed under Subcontractors.</EmptyState></div>
          ) : (
            <>
              <KpiStrip label={`Totals for ${year}`}>
                <Kpi label="Paid to subs" value={formatMoneyCents(d.total)} hint={card > 0 ? `Plus ${formatMoneyCents(card)} by card or app` : undefined} />
                <Kpi label="Subs paid" value={String(d.subs.length)} />
                <Kpi label="Need a 1099" value={String(d.needing_1099)} />
              </KpiStrip>
              <div className="card">
                <table className="table table-stack">
                  <thead><tr><th>Sub</th><th>Tax classification</th><th className="num">Total</th><th className="num">Payments</th><th>1099-NEC</th><th>Note</th></tr></thead>
                  <tbody>
                    {d.subs.map((s) => (
                      <tr key={s.subcontractor_id}>
                        <td style={{ minWidth: 160 }}>
                          <Link className="cell-link" to={`/subs/${s.subcontractor_id}`}>{s.name}</Link>
                          {s.contact_name && <div className="muted small">{s.contact_name}</div>}
                        </td>
                        <td>
                          {taxClassificationLabel(s.tax_classification) ?? <span className="muted">No W-9</span>}
                          {s.corporation && <div><span className="chip">Corporation: usually no 1099</span></div>}
                        </td>
                        <td className="num tabular strong">{formatMoneyCents(s.total)}</td>
                        <td className="num tabular">{s.payments}<span className="mobile-inline"> {s.payments === 1 ? "payment" : "payments"}</span></td>
                        <td>
                          <span className="mobile-inline small">1099-NEC: </span>
                          {s.needs_1099 ? <StatusPill label="Needed" tone="warning" /> : <StatusPill label="Not needed" tone="muted" />}
                        </td>
                        <td className="small muted" style={{ minWidth: 200 }}>{s.note || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// The workers' comp audit
// ---------------------------------------------------------------------------------------------

export function WorkersCompPage() {
  const session = useSession();
  if (!handlesSubPay(session)) return <NoAccess title="Workers' comp audit" />;
  return <WorkersComp />;
}

function WorkersComp() {
  const session = useSession();
  const today = todayIn(session.company.timezone);
  const presets = auditPresets(today);
  const [params, setParams] = useSearchParams();
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  const from = iso.test(params.get("from") ?? "") ? params.get("from")! : presets[0].from;
  const to = iso.test(params.get("to") ?? "") ? params.get("to")! : presets[0].to;
  const valid = from <= to;
  const audit = useWcAudit(from, to, valid);
  const csv = useMutation({ meta: { inline: true }, mutationFn: () => download(`/subs/workers-comp/csv?from=${from}&to=${to}`) });
  const setRange = (f: string, t: string) => setParams({ from: f, to: t }, { replace: true });
  useDocumentTitle("Workers' comp audit");
  const d = audit.data;

  return (
    <>
      <BackLink to="/subs">Subcontractors</BackLink>
      <PageHeader title="Workers' comp audit" actions={<Button icon="download" loading={csv.isPending} disabled={!d?.rows.length} onClick={() => csv.mutate()}>Download CSV</Button>} />
      <p className="page-subtitle" style={{ maxWidth: 760 }}>
        At your workers' comp audit, the auditor asks what you paid subs during the policy period and whether each one had their own workers' comp. Work by a sub who wasn't covered can be charged to your policy as if they were your employee, so keep a current certificate (or exemption) on file for every sub.
      </p>
      <FormError error={csv.error} />

      <div className="toolbar" style={{ flexWrap: "wrap", marginBottom: 16 }}>
        <div className="btn-group">
          {presets.map((p) => <Button key={p.key} size="sm" variant={from === p.from && to === p.to ? "primary" : undefined} onClick={() => setRange(p.from, p.to)}>{p.label}</Button>)}
        </div>
        {/* Wraps on a phone: the label above, the two dates sharing the width. */}
        <div className="row" style={{ gap: 6, flexWrap: "wrap", minWidth: 0, flex: "1 1 300px" }}>
          <span className="muted small" style={{ flexBasis: "100%" }}>Policy period</span>
          <input className="input" type="date" value={from} max={to} onChange={(e) => e.target.value && setRange(e.target.value, to)} aria-label="Policy starts" style={{ flex: "1 1 120px", maxWidth: 170, minWidth: 0 }} />
          <span className="muted">to</span>
          <input className="input" type="date" value={to} min={from} onChange={(e) => e.target.value && setRange(from, e.target.value)} aria-label="Policy ends" style={{ flex: "1 1 120px", maxWidth: 170, minWidth: 0 }} />
        </div>
      </div>

      {!valid && <div className="callout callout-warning"><Icon name="alert" size={18} /><div className="grow">The period has to end on or after it starts.</div></div>}
      {valid && audit.isPending && <Loading><CardSkeleton lines={5} /></Loading>}
      {audit.error && <div className="card"><ErrorState error={audit.error} onRetry={() => audit.refetch()} /></div>}
      {d && (
        d.rows.length === 0 ? (
          <div className="card"><EmptyState icon="clipboard" title="No sub work in this period">Pay on jobs that's agreed, done or paid shows here, by the days the work was done.</EmptyState></div>
        ) : (
          <div className="stack">
            <KpiStrip label="Totals for the period">
              <Kpi
                label="Sub work in the period"
                value={formatMoneyCents(d.totals.amount)}
                hint={d.totals.not_paid_yet > 0 ? `${formatMoneyCents(d.totals.paid)} paid, ${formatMoneyCents(d.totals.not_paid_yet)} not paid yet` : `${d.totals.subs} ${d.totals.subs === 1 ? "sub" : "subs"}, all paid`}
              />
              <Kpi label="Covered" value={formatMoneyCents(d.totals.covered)} />
              <Kpi label="Not covered" value={formatMoneyCents(d.totals.not_covered)} tone={d.totals.not_covered > 0 ? "bad" : undefined} hint={d.totals.not_covered_subs ? `${d.totals.not_covered_subs} ${d.totals.not_covered_subs === 1 ? "sub" : "subs"}` : undefined} />
            </KpiStrip>
            <div className="card">
              <table className="table table-stack">
                <thead><tr><th>Sub</th><th>Job</th><th>Days worked</th><th className="num">Amount</th><th>Workers' comp</th><th>Certificate on file</th></tr></thead>
                <tbody>
                  {d.rows.map((r) => {
                    const docs = Array.isArray(r.documents) ? (r.documents as WcCertificate[]) : [];
                    return (
                      <tr key={r.job_pay_id}>
                        <td style={{ minWidth: 140 }}><Link className="cell-link" to={`/subs/${r.subcontractor_id}`}>{r.sub_name}</Link></td>
                        <td><Link to={`/jobs/${r.job_id}`}>{r.job_number ? `#${r.job_number} ` : ""}{r.job_title}</Link></td>
                        <td className="small"><span className="mobile-inline">Worked </span>{workDays(r.work_dates) || "—"}</td>
                        <td className="num tabular">
                          <strong>{formatMoneyCents(Number(r.amount))}</strong>
                          <div className="muted small">{r.status === "paid" ? "Paid" : `${jobPayStatusLabel(r.status)}, not paid yet`}</div>
                          {wcPartNote(r) && <div className="muted small">{wcPartNote(r)}</div>}
                        </td>
                        <td>
                          <StatusPill label={coverageLabel(r.coverage)} tone={coverageTone(r.coverage)} />
                          {r.coverage === "partly" && <div className="muted small tabular">{formatMoneyCents(Number(r.uncovered_amount))} not covered</div>}
                        </td>
                        <td className="small" style={{ minWidth: 200 }}>{docs.length ? docs.map((c) => <div key={c.id}>{certificateText(c)}</div>) : <span className="muted">None for these days</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="muted small" style={{ margin: 0 }}>
              Amounts are what you paid, or agreed to pay where it isn't paid yet. Only certificates you've verified count, and one without a start date is taken as a one-year policy: add the date to be sure. Partly covered work, and work running past these dates, is split by days.
            </p>
          </div>
        )
      )}
    </>
  );
}
