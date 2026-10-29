/**
 * Stripe's page, once it's installed: the account, a warning when Stripe can't reach this server,
 * bringing in Stripe history, and links to the deposits it fills in. Uninstall is at the top.
 */
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { api } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import { importRunning, type AppRow } from "./catalog";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function StripePanel({ app, onChanged }: { app: AppRow; onChanged: () => void }) {
  const details = app.stripe!;
  const year = new Date().getFullYear();
  const [since, setSince] = useState(`${year}-01-01`);
  const start = useMutation({
    meta: { inline: true },
    mutationFn: () => api.post("/apps/stripe/import", { since: since || null }),
    onSuccess: onChanged,
  });
  const state = details.import;
  const running = importRunning(state);
  const counts = state?.counts;
  return (
    <>
      <section className="card card-pad stack-sm" aria-label="Stripe account" style={{ gap: 8 }}>
        <div className="row wrap" style={{ gap: 10 }}>
          <Icon name="check" size={16} />
          <span className="grow">
            {details.own ? <>Connected{app.account_label ? <> to <strong>{app.account_label}</strong></> : null}</> : <>Using the Stripe account set up for this server</>}
          </span>
          {!details.livemode && <span className="chip">Test mode</span>}
        </div>
        {details.own && !details.webhook && (
          <span className="small" style={{ color: "var(--danger)", fontWeight: 600 }}>
            <Icon name="alert" size={14} /> Stripe can't reach this address, so payments won't show up on their own. Once Crewtavo has a public https address, connect the key again.
          </span>
        )}
        {app.last_sync_at && <span className="muted small">Last heard from Stripe {timeAgo(app.last_sync_at)}</span>}
        <div className="row wrap" style={{ gap: 8 }}>
          <Link className="btn btn-sm" to="/payouts"><Icon name="dollar" size={14} /> Deposits</Link>
        </div>
      </section>

      <section className="card card-pad stack-sm" aria-labelledby="stripe-history" style={{ gap: 8 }}>
        <h2 id="stripe-history" className="section-title" style={{ fontSize: 16 }}>Bring in your Stripe history</h2>
        <span className="muted small">Invoices you made in Stripe, with their clients and payments, and your bank deposits. Nobody is emailed or texted, and running it again only updates what's already here.</span>
        {running ? (
          <span className="small" role="status"><Icon name="refresh" size={14} /> Importing… {counts ? plural(counts.invoices, "invoice") : ""} so far</span>
        ) : (
          <div className="row wrap" style={{ gap: 8 }}>
            <select className="select grow" value={since} onChange={(e) => setSince(e.target.value)} aria-label="Import from">
              <option value={`${year}-01-01`}>This year</option>
              <option value={`${year - 1}-01-01`}>Since January {year - 1}</option>
              <option value={`${year - 2}-01-01`}>Since January {year - 2}</option>
              <option value="">Everything</option>
            </select>
            <Button icon="download" loading={start.isPending} onClick={() => start.mutate()}>{state ? "Import again" : "Import"}</Button>
          </div>
        )}
        {state?.status === "done" && counts && (
          <span className="muted small">
            Imported {state.finished_at ? timeAgo(state.finished_at) : ""}: {plural(counts.invoices, "invoice")}, {plural(counts.payments, "payment")}, {plural(counts.clients, "new client")} and {plural(counts.payouts, "deposit")}.
          </span>
        )}
        {state?.status === "failed" && <span className="field-error">The import stopped: {state.error}. Run it again; anything already imported is kept.</span>}
        {start.error && <span className="field-error">{(start.error as Error).message}</span>}
      </section>
    </>
  );
}
