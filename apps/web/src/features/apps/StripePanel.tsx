/**
 * Stripe's page, once it's installed: the account, a warning when Stripe can't reach this server,
 * the prompts to swap a full secret key for a restricted one and to update a key made before
 * autopay, bringing in Stripe history (and the cards saved there), and links to the deposits it
 * fills in, as flat sections with the account as facts. Uninstall is in the page's More menu.
 */
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { Fact, Facts, Section } from "@/components/ui/Section";
import { api } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import { importRunning, STRIPE_NEW_KEY, type AppRow } from "./catalog";
import { kit } from "./PanelKit";
import { Select } from "@/components/ui/Select";

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
      <Section className={kit.panel} title="Stripe account" action={<Link to="/payouts"><Icon name="dollar" size={14} />Deposits</Link>}>
        {details.own && !details.webhook && (
          <div className="callout callout-danger" role="alert">
            <Icon name="alert" size={16} />
            <div className="grow">
              <div>Stripe can't reach this address, so payments won't show up on their own.</div>
              Once Crewtavo has a public https address, connect the key again.
            </div>
          </div>
        )}
        {/* A full secret key can make payouts too: a restricted one from the same form can't. */}
        {details.own && details.full_key && (
          <div className="callout callout-warning">
            <Icon name="alert" size={16} />
            <div className="grow">
              This is your full Stripe secret key, which can do anything in your Stripe account, including payouts. Get a restricted key from Stripe, paste it below, then delete the full key in Stripe.
              <div className="row wrap app-callout-row" style={{ gap: 8 }}>
                <a className="btn btn-sm" href={STRIPE_NEW_KEY} target="_blank" rel="noreferrer"><Icon name="external" size={14} />Get a key from Stripe</a>
                <a className="btn btn-sm btn-ghost" href="#app-setup">Paste it below</a>
              </div>
            </div>
          </div>
        )}
        {/* A key made before autopay can't save cards, charge them or refund: the same form, with more permissions. */}
        {details.own && !details.autopay && (
          <div className="callout callout-info">
            <Icon name="card" size={16} />
            <div className="grow">
              Update your key to turn on autopay. Saving cards, charging them and refunds need a new key with more permissions.
              <div className="row wrap app-callout-row" style={{ gap: 8 }}>
                <a className="btn btn-sm" href={STRIPE_NEW_KEY} target="_blank" rel="noreferrer"><Icon name="external" size={14} />Get a new key</a>
                <a className="btn btn-sm btn-ghost" href="#app-setup">Paste it below</a>
              </div>
            </div>
          </div>
        )}
        <Facts>
          <Fact label="Account">{details.own ? (app.account_label ?? "Connected") : "Using the Stripe account set up for this server"}</Fact>
          <Fact label="Mode" tone="warning">{!details.livemode && "Test mode"}</Fact>
          <Fact label="Last heard">{app.last_sync_at && timeAgo(app.last_sync_at)}</Fact>
        </Facts>
        {/* Stripe's own Billing emails would double up on Crewtavo's receipts and failed-payment notices. */}
        {details.own && details.autopay && <p className={kit.note}>In Stripe, turn off emails about failed payments and receipts, so clients don't get two.</p>}
      </Section>

      <Section className={kit.panel} title="Bring in your Stripe history">
        <p className={kit.note}>Invoices you made in Stripe, with their clients and payments, and your bank deposits. Nobody is emailed or texted, and running it again only updates what's already here.</p>
        {running ? (
          <span className="app-status" role="status"><span className="spinner" style={{ width: 14, height: 14 }} aria-hidden="true" />Importing… {counts ? plural(counts.invoices, "invoice") : ""} so far</span>
        ) : (
          <div className="row wrap" style={{ gap: 8 }}>
            <Select className="select grow" style={{ maxWidth: 320 }} value={since} onChange={(e) => setSince(e.target.value)} aria-label="Import from">
              <option value={`${year}-01-01`}>This year</option>
              <option value={`${year - 1}-01-01`}>Since January {year - 1}</option>
              <option value={`${year - 2}-01-01`}>Since January {year - 2}</option>
              <option value="">Everything</option>
            </Select>
            <Button icon="download" loading={start.isPending} onClick={() => start.mutate()}>{state ? "Import again" : "Import"}</Button>
          </div>
        )}
        {state?.status === "done" && counts && (
          <p className={kit.note}>
            Imported {state.finished_at ? timeAgo(state.finished_at) : ""}: {plural(counts.invoices, "invoice")}, {plural(counts.payments, "payment")}, {plural(counts.clients, "new client")} and {plural(counts.payouts, "deposit")}.
          </p>
        )}
        {/* The cards that came in wait for each client to confirm autopay (or the owner to vouch): Settings → Payments. */}
        {state?.status === "done" && Boolean(counts?.cards) && (
          <span className="app-status">
            <Icon name="card" size={14} /> <Link to="/settings?tab=payments">{plural(counts!.cards!, "client has", "clients have")} a card saved in Stripe.</Link>
            {counts!.cards_unmatched ? <span className="muted"> {plural(counts!.cards_unmatched, "more", "more")} couldn't be matched to one client by email.</span> : null}
          </span>
        )}
        {state?.status === "done" && state.cards_error && (
          <span className="field-error">The cards saved in Stripe didn't come in: {state.cards_error.replace(/\.$/, "")}. Import again to try once more.</span>
        )}
        {state?.status === "failed" && <span className="field-error">The import stopped: {state.error}. Run it again; anything already imported is kept.</span>}
        {start.error && <span className="field-error">{(start.error as Error).message}</span>}
      </Section>
    </>
  );
}
