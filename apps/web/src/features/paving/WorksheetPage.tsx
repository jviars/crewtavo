/**
 * A paving worksheet to print (Paving → a quote's Worksheet → Print): the calculator's working on
 * one sheet, laid out the way a paver's own sheet is, for the estimator to keep with the quote. The
 * area and how it was measured, each item's amount, price and total, the totals and profit, and the
 * notes. It's the office's copy and says so; nothing here goes to the client.
 */
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { BackLink, useDocumentTitle } from "@/components/ui/PageHeader";
import { DetailSkeleton } from "@/components/ui/Skeleton";
import { ErrorState } from "@/components/ui/States";
import { supabase, unwrap } from "@/lib/api";
import { addressLine, formatDate, formatMoney, formatMoneyCents, formatNumber } from "@/lib/format";
import { useSession } from "@/lib/session";
import { BASES, calculate, parseWorksheet, sectionsOf, type CalcLine } from "./calculator";

interface Row {
  id: string;
  name: string;
  notes: string | null;
  data: unknown;
  updated_at: string;
  quote: {
    id: string;
    number: number | null;
    title: string;
    client: { display_name: string } | null;
    property: { line1: string | null; city: string | null; region: string | null; postal_code: string | null } | null;
  } | null;
}

const amountText = (n: number) => formatNumber(n, Number.isInteger(n) ? 0 : 2);
const UNITS: Record<string, string> = { ton: "tons", gal: "gal", "sq yd": "sq yd", "sq ft": "sq ft", ft: "ft", day: "days", ea: "" };

/** What a line's amount came from: "2\" deep", "0.4 gal per sq yd", "Tack coat", "Whole area". */
function figuredFrom(line: CalcLine): string {
  const { item, value } = line;
  if (value <= 0) return "";
  const choice = item.choices?.find((c) => c.value === value);
  if (item.basis === "area_sqyd" || item.basis === "area_sqft") return choice ? choice.label : "Whole area";
  if (item.basis === "haul") return "Every ton on the job";
  const per = BASES[item.basis].per;
  if (!per) return "";
  return `${choice ? `${choice.label} · ` : ""}${amountText(value)}${item.basis === "depth" ? '"' : ""} ${item.basis === "depth" ? "deep" : per}`;
}

export function WorksheetPage() {
  const { id = "" } = useParams();
  const { company } = useSession();
  const worksheet = useQuery({
    queryKey: ["paving-worksheet-print", id],
    queryFn: async () => {
      const row = unwrap(
        await supabase()
          .from("paving_worksheets")
          .select("id, name, notes, data, updated_at, quote:quotes(id, number, title, client:clients(display_name), property:properties(line1, city, region, postal_code))")
          .eq("id", id)
          .maybeSingle(),
      ) as Row | null;
      if (!row) throw new Error("That worksheet wasn't found. Its quote may have been deleted.");
      return row;
    },
  });
  useDocumentTitle(worksheet.data ? `Worksheet · ${worksheet.data.quote?.title ?? worksheet.data.name}` : "Worksheet");

  if (worksheet.isPending) return <DetailSkeleton />;
  if (worksheet.error || !worksheet.data) return <><BackLink to="/paving">Paving</BackLink><ErrorState error={worksheet.error} onRetry={() => worksheet.refetch()} /></>;
  const row = worksheet.data;
  const saved = parseWorksheet(row.data);
  if (!saved) return <><BackLink to="/paving">Paving</BackLink><ErrorState error={new Error("This worksheet can't be read.")} /></>;
  const { setup, input } = saved;
  const calc = calculate(setup, input, saved.overrides);
  const q = row.quote;
  const profitHow = input.profit.by === "day" ? `${amountText(calc.profitDays)} days × ${formatMoney(input.profit.amount)}` : input.profit.by === "percent" ? `${amountText(input.profit.amount)}% of cost` : "In the prices";

  return (
    <>
      <div className="no-print">
        <BackLink to={q ? `/quotes/${q.id}` : "/paving"}>{q?.title ?? "Paving"}</BackLink>
        <div className="row wrap" style={{ gap: 10, margin: "0 0 16px" }}>
          <Button variant="primary" icon="printer" onClick={() => window.print()}>Print</Button>
          <Link className="btn" to={`/paving/calculator?worksheet=${row.id}`}><Icon name="calculator" size={16} />Open in calculator</Link>
          <span className="muted small row" style={{ gap: 6 }}><Icon name="lock" size={14} />Your office's copy. It never goes to the client.</span>
        </div>
      </div>

      <article className="worksheet">
        <header className="worksheet-head">
          <div>
            <div className="worksheet-company">{company.name}</div>
            <h1>Paving worksheet</h1>
            <div className="worksheet-flag">Office copy · not for the client</div>
          </div>
          <dl className="worksheet-meta">
            {q && <div><dt>Quote</dt><dd>{q.number ? `#${q.number} · ` : ""}{q.title}</dd></div>}
            {q?.client && <div><dt>Client</dt><dd>{q.client.display_name}</dd></div>}
            {q?.property && <div><dt>Address</dt><dd>{addressLine(q.property)}</dd></div>}
            <div><dt>Job</dt><dd>{row.name}</dd></div>
            <div><dt>Updated</dt><dd>{formatDate(row.updated_at)}</dd></div>
          </dl>
        </header>

        {row.notes && <p className="worksheet-notes">{row.notes}</p>}

        <h2>Area</h2>
        <table className="worksheet-table">
          <tbody>
            {input.sides?.map((s, i) => (
              <tr key={i}>
                <td>{amountText(s.length)} ft × {amountText(s.width)} ft</td>
                <td className="num">{amountText(s.length * s.width)} sq ft</td>
              </tr>
            ))}
            <tr className="worksheet-sum"><td>Total square feet</td><td className="num">{amountText(calc.sqft)}</td></tr>
            <tr className="worksheet-sum"><td>Total square yards</td><td className="num">{amountText(calc.sqyd)}</td></tr>
          </tbody>
        </table>

        {sectionsOf(setup).map((section) => {
          const lines = calc.lines.filter((l) => l.item.section === section && (l.quantity > 0 || l.total > 0));
          if (!lines.length) return null;
          return (
            <section key={section}>
              <h2>{section}</h2>
              <table className="worksheet-table">
                <thead><tr><th>Item</th><th>Figured from</th><th className="num">Amount</th><th className="num">Price</th><th className="num">Total</th></tr></thead>
                <tbody>
                  {lines.map((l) => (
                    <tr key={l.item.id}>
                      <td>{l.item.name}</td>
                      <td>{figuredFrom(l)}{l.quantity !== l.worked && <span className="worksheet-aside"> (worked out {amountText(l.worked)})</span>}</td>
                      <td className="num">{amountText(l.quantity)} {UNITS[l.unit] ?? l.unit}</td>
                      <td className="num">{formatMoneyCents(l.price)}</td>
                      <td className="num">{formatMoneyCents(l.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          );
        })}

        <table className="worksheet-table worksheet-totals">
          <tbody>
            <tr><td>Total materials</td><td className="num">{formatMoneyCents(calc.materials)}</td></tr>
            <tr><td>Labor, milling and trucks</td><td className="num">{formatMoneyCents(calc.work)}</td></tr>
            <tr><td>Cost before profit</td><td className="num">{formatMoneyCents(calc.cost)}</td></tr>
            <tr>
              <td>Profit <span className="worksheet-aside">{profitHow}{calc.total > 0 ? ` · ${Math.round((calc.profit / calc.total) * 100)}% of the price` : ""}</span></td>
              <td className="num">{formatMoneyCents(calc.profit)}</td>
            </tr>
            {calc.toMinimum > 0 && (
              <tr><td>Up to the minimum charge <span className="worksheet-aside">{formatMoney(input.minimum)}</span></td><td className="num">{formatMoneyCents(calc.toMinimum)}</td></tr>
            )}
            <tr className="worksheet-grand"><td>Total estimate</td><td className="num">{formatMoneyCents(calc.total)}</td></tr>
            {calc.sqft > 0 && <tr><td className="worksheet-aside">Per sq ft · per sq yd</td><td className="num worksheet-aside">{formatMoneyCents(calc.perSqft)} · {formatMoneyCents(calc.total / calc.sqyd)}</td></tr>}
          </tbody>
        </table>
        {setup.waste > 0 && <p className="worksheet-aside">Tons and gallons include {amountText(setup.waste)}% extra for waste.</p>}
      </article>
    </>
  );
}
