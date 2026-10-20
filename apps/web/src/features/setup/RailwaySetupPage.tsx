/**
 * What the owner of a Crewtavo on Railway sees at sign-in until it's done (lib/session.tsx):
 *
 *   1. Connect Railway (`needed`, from GET /me): required, since the warnings before Railway's trial,
 *      credit or card runs out need it (Settings → Hosting). Owners have just deployed from Railway
 *      and are still signed in there, so it's one press of Allow. A sign-in from before Crewtavo
 *      asked to read billing is asked again. Only "Ask me tomorrow" gets past it without connecting,
 *      for when Railway is down or someone else looks after it.
 *   2. Right after setting up the business (companies.settings.railway_setup is "pending"): the same
 *      four steps as Settings → Web address, with step 1 already done. That one can be skipped.
 *
 * The pieces come from features/settings. `onSignOut` is the session's, which leaves nothing of
 * theirs on the phone.
 */
import type { AddressOverview } from "@crewtavo/core/address";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { FormError } from "@/components/ui/Field";
import { CardSkeleton } from "@/components/ui/Skeleton";
import { ErrorState } from "@/components/ui/States";
import { AuthLayout } from "@/features/auth/LoginPage";
import authStyles from "@/features/auth/auth.module.css";
import { RailwayConnect } from "@/features/settings/RailwayConnect";
import { AddressScreen, useRailwayReturn, WEB_ADDRESS_KEY } from "@/features/settings/WebAddressSettings";
import { api } from "@/lib/api";

export function RailwaySetupPage({ companyName, needed, onDone, onSignOut }: { companyName: string; needed: boolean; onDone: () => void; onSignOut: () => void }) {
  const [choosing, setChoosing] = useState(false);
  const overview = useQuery({
    queryKey: WEB_ADDRESS_KEY,
    queryFn: () => api.get<AddressOverview>("/address"),
    // While an address is set up, look again every few seconds so the steps tick off by themselves.
    refetchInterval: (query) => (["waiting", "switching"].includes(query.state.data?.change?.status ?? "") ? 10_000 : false),
    meta: { silent: true },
  });
  const finish = useMutation({
    meta: { inline: true },
    mutationFn: (status: "done" | "skipped") => api.post("/railway/setup", { status }),
    onSuccess: onDone,
  });
  const later = useMutation({ meta: { inline: true }, mutationFn: () => api.post("/railway/later"), onSuccess: onDone });
  useRailwayReturn();
  // Connected with a pasted token (no trip to Railway): GET /me no longer asks, so move on, once.
  const current = Boolean(overview.data?.railway?.current);
  const movedOn = useRef(false);
  useEffect(() => {
    if (!needed || !current || movedOn.current) return;
    movedOn.current = true;
    onDone();
  }, [needed, current, onDone]);

  if (needed) {
    const railway = overview.data?.railway;
    return (
      <AuthLayout>
        <div className={`stack ${authStyles.wide}`}>
          <div className="stack-sm" style={{ gap: 6 }}>
            <h1 className={authStyles.title}>{railway?.connected ? "Log in with Railway again" : "Connect Railway"}</h1>
            <p className="muted" style={{ margin: 0 }}>{companyName}'s Crewtavo runs on Railway. This takes a minute, and you only do it once.</p>
          </div>
          {overview.isPending ? (
            <CardSkeleton lines={4} />
          ) : railway ? (
            <div className="card card-pad"><RailwayConnect railway={railway} returnTo="setup" /></div>
          ) : (
            <div className="card"><ErrorState error={overview.error} onRetry={() => overview.refetch()} /></div>
          )}
          <FormError error={later.error} />
          <div className="row" style={{ justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
            <Button variant="ghost" icon="logout" onClick={() => onSignOut()}>Sign out</Button>
            <Button variant="ghost" loading={later.isPending} onClick={() => later.mutate()}>Ask me tomorrow</Button>
          </div>
          <span className="muted small" style={{ textAlign: "center" }}>
            Can't right now, or someone else looks after Railway? Ask me tomorrow lets you in for today. Until Railway is connected, Crewtavo can't warn you before it stops.
          </span>
        </div>
      </AuthLayout>
    );
  }

  let body: ReactNode;
  const data = overview.data;
  if (overview.isPending) body = <CardSkeleton lines={4} />;
  else if (!data) body = <div className="card"><ErrorState error={overview.error} onRetry={() => overview.refetch()} /></div>;
  else body = <AddressScreen overview={data} returnTo="setup" choosing={choosing} onChoosing={setChoosing} checking={overview.isFetching} onCheck={() => overview.refetch()} />;

  const connected = Boolean(data?.railway?.connected);
  const started = Boolean(data?.change);
  return (
    <AuthLayout>
      <div className={`stack ${authStyles.wide}`}>
        <div className="stack-sm" style={{ gap: 6 }}>
          <h1 className={authStyles.title}>Your web address</h1>
          <p className="muted" style={{ margin: 0 }}>
            {companyName} can have its own web address in four steps. You can skip this and do it any time in Settings → Web address.
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
