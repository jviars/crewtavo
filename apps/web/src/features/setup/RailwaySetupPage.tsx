/**
 * The setup step after "Set up your business", for a business set up on Railway (lib/session.tsx
 * shows it while companies.settings.railway_setup is "pending"): connect Crewtavo to its Railway
 * project, then pick a web address. Owners have just deployed from Railway and are still signed in
 * there, so connecting is one press of Allow. Both parts can be skipped; Settings → Web address does
 * everything later too. The pieces come from features/settings/WebAddressSettings.tsx. `onSignOut`
 * is the session's, which leaves nothing of theirs on the phone.
 */
import type { AddressOverview } from "@crewtavo/core/address";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { CardSkeleton } from "@/components/ui/Skeleton";
import { ErrorState } from "@/components/ui/States";
import { AuthLayout } from "@/features/auth/LoginPage";
import authStyles from "@/features/auth/auth.module.css";
import {
  ChooseAddress,
  ConnectRailway,
  Done,
  Failed,
  RailwayDomains,
  RailwayTokenForm,
  Switching,
  useRailwayReturn,
  Waiting,
  WEB_ADDRESS_KEY,
} from "@/features/settings/WebAddressSettings";
import { api } from "@/lib/api";

export function RailwaySetupPage({ companyName, onDone, onSignOut }: { companyName: string; onDone: () => void; onSignOut: () => void }) {
  const [buying, setBuying] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const overview = useQuery({
    queryKey: WEB_ADDRESS_KEY,
    queryFn: () => api.get<AddressOverview>("/address"),
    // While a domain is being bought on Railway, or an address set up, look again every few seconds.
    refetchInterval: (query) => (buying || ["waiting", "switching"].includes(query.state.data?.change?.status ?? "") ? 10_000 : false),
    meta: { silent: true },
  });
  const finish = useMutation({
    meta: { inline: true },
    mutationFn: (status: "done" | "skipped") => api.post("/railway/setup", { status }),
    onSuccess: onDone,
  });
  useRailwayReturn();

  let body: ReactNode;
  const data = overview.data;
  if (overview.isPending) body = <CardSkeleton lines={4} />;
  else if (!data) body = <div className="card"><ErrorState error={overview.error} onRetry={() => overview.refetch()} /></div>;
  else if (!data.railway?.connected) body = <Connect overview={data} />;
  else if (data.change && data.change.status !== "done") {
    const { change } = data;
    body = change.status === "switching" ? <Switching change={change} />
      : change.status === "failed" ? <Failed overview={data} change={change} />
      : <Waiting overview={data} change={change} checking={overview.isFetching} onCheck={() => overview.refetch()} />;
  } else if (choosing) body = <ChooseAddress overview={data} onDone={() => setChoosing(false)} />;
  else if (data.change?.status === "done" && data.current === `https://${data.change.domain}`) body = <Done overview={data} change={data.change} onChange={() => setChoosing(true)} />;
  else body = <Pick overview={data} buying={buying} onBuy={() => setBuying(true)} onChoose={() => setChoosing(true)} />;

  const connected = Boolean(data?.railway?.connected);
  const started = Boolean(data?.change);
  return (
    <AuthLayout>
      <div className={`stack ${authStyles.wide}`}>
        <div className="stack-sm" style={{ gap: 6 }}>
          <h1 className={authStyles.title}>{connected ? "Your web address" : "Connect Crewtavo to Railway"}</h1>
          <p className="muted" style={{ margin: 0 }}>
            {connected
              ? `The address ${companyName}'s team and clients will use. You can change it any time in Settings → Web address.`
              : `${companyName} runs on Railway. Connecting lets Crewtavo set up your web address and look after itself there.`}
          </p>
        </div>
        {body}
        <FormError error={finish.error} />
        <div className="row" style={{ justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
          <Button variant="ghost" icon="logout" onClick={() => onSignOut()}>Sign out</Button>
          {connected ? (
            <Button variant={started ? "primary" : "ghost"} loading={finish.isPending} onClick={() => finish.mutate("done")}>
              {started ? "Continue to Crewtavo" : "Not now"}
            </Button>
          ) : (
            <Button variant="ghost" loading={finish.isPending} onClick={() => finish.mutate("skipped")}>Skip for now</Button>
          )}
        </div>
        {connected && started && data?.change?.status !== "done" && (
          <span className="muted small" style={{ textAlign: "center" }}>Crewtavo finishes setting up the address by itself and lets you know when it's done.</span>
        )}
      </div>
    </AuthLayout>
  );
}

/** Step 1: Login with Railway (or a project token, when Railway won't let this instance sign in). */
function Connect({ overview }: { overview: AddressOverview }) {
  const railway = overview.railway;
  return (
    <section className="card card-pad stack">
      <ul className={authStyles.scopes}>
        <li><Icon name="globe" size={18} />Adds your own web address in Railway and switches over by itself</li>
        <li><Icon name="check" size={18} />Uses a domain you buy on Railway with nothing to set up</li>
        <li><Icon name="lock" size={18} />Only this project. You can remove the access any time in Settings.</li>
      </ul>
      {railway?.error && (
        <div className="callout callout-danger" role="alert">
          <Icon name="alert" size={18} />
          <span className="grow" style={{ fontWeight: 400 }}>{railway.error}</span>
        </div>
      )}
      {railway?.oauth ? (
        <ConnectRailway returnTo="setup" projectName={railway.projectName} label="Connect Railway" />
      ) : (
        <RailwayTokenForm tokensUrl={railway?.tokensUrl ?? null} />
      )}
    </section>
  );
}

/** Step 2: a new domain from Railway, one they already have, or neither for now. */
function Pick({ overview, buying, onBuy, onChoose }: { overview: AddressOverview; buying: boolean; onBuy: () => void; onChoose: () => void }) {
  const settingsUrl = overview.railway?.settingsUrl;
  return (
    <>
      {(buying || (overview.railway?.domains.length ?? 0) > 0) && <RailwayDomains overview={overview} buying={buying} />}
      {!buying && (
        <div className={authStyles.presets} role="list">
          <Option
            title="Get a new domain"
            text="Buy one on Railway, billed to your Railway account. Railway sets it up, so there's nothing to add."
            onClick={() => {
              if (settingsUrl) window.open(settingsUrl, "_blank", "noopener");
              onBuy();
            }}
          />
          <Option title="Use a domain I already have" text="Like app.yourbusiness.com. Crewtavo shows the two records to add where your domain is managed, and checks them." onClick={onChoose} />
        </div>
      )}
      {buying && settingsUrl && (
        <span className="muted small">
          On the crewtavo service's Settings, under Networking, press <strong>Buy a Domain</strong>.{" "}
          <a href={settingsUrl} target="_blank" rel="noreferrer">Open Railway again</a>
        </span>
      )}
    </>
  );
}

function Option({ title, text, onClick }: { title: string; text: string; onClick: () => void }) {
  return (
    <button type="button" role="listitem" className={authStyles.preset} style={{ textAlign: "left", font: "inherit", color: "inherit" }} onClick={onClick}>
      <strong>{title}</strong>
      <span>{text}</span>
    </button>
  );
}
