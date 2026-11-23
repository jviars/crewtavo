/**
 * What the owner of a Crewtavo on Railway sees at sign-in until it's done (lib/session.tsx):
 *
 *   1. Connect Railway (`needed`, from GET /me): required, since the warnings before Railway's trial
 *      runs out need it (Settings → Hosting). Owners have just deployed from Railway and are still
 *      signed in there, so it's one press of Authorize. Only "Ask me tomorrow" gets past it without
 *      connecting, for when Railway is down or someone else looks after it.
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
import { SectionSkeleton } from "@/components/ui/Skeleton";
import { ErrorState } from "@/components/ui/States";
import { AuthLayout } from "@/features/auth/LoginPage";
import authStyles from "@/features/auth/auth.module.css";
import { RailwayConnect } from "@/features/settings/RailwayConnect";
import { AddressScreen, useRailwayReturn, WEB_ADDRESS_KEY } from "@/features/settings/WebAddressSettings";
import { api } from "@/lib/api";
import { SetupProgress } from "./SetupProgress";

/** `inSetup`: right after the business was made (railway_setup "pending"), so these are setup's last two steps. */
export function RailwaySetupPage({ companyName, needed, inSetup, onDone, onSignOut }: { companyName: string; needed: boolean; inSetup?: boolean; onDone: () => void; onSignOut: () => void }) {
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
  const linked = Boolean(overview.data?.railway?.connected);
  const movedOn = useRef(false);
  useEffect(() => {
    if (!needed || !linked || movedOn.current) return;
    movedOn.current = true;
    onDone();
  }, [needed, linked, onDone]);

  if (needed) {
    const railway = overview.data?.railway;
    return (
      <AuthLayout onSignOut={onSignOut} width="read" step={1} top={inSetup ? <SetupProgress at="railway" /> : undefined}>
        <div className={authStyles.flow}>
          <h1 className={authStyles.title}>{railway?.error ? "Connect Railway again" : "Connect Railway"}</h1>
          <p className={authStyles.sub}>{companyName}'s Crewtavo runs on Railway. This takes a minute, and you only do it once.</p>
          <div style={{ marginTop: 24 }}>
            {overview.isPending ? <SectionSkeleton /> : railway ? <RailwayConnect railway={railway} returnTo="setup" /> : <ErrorState error={overview.error} onRetry={() => overview.refetch()} />}
          </div>
          <div style={{ marginTop: 16 }}><FormError error={later.error} /></div>
          <div className={authStyles.acts} data-stack="">
            <Button loading={later.isPending} onClick={() => later.mutate()}>Ask me tomorrow</Button>
          </div>
          <p className={authStyles.note} style={{ marginTop: 12 }}>
            Can't right now, or someone else looks after Railway? Ask me tomorrow lets you in for today. Until Railway is connected, Crewtavo can't warn you before it stops.
          </p>
        </div>
      </AuthLayout>
    );
  }

  let body: ReactNode;
  const data = overview.data;
  if (overview.isPending) body = <SectionSkeleton />;
  else if (!data) body = <ErrorState error={overview.error} onRetry={() => overview.refetch()} />;
  else body = <AddressScreen overview={data} returnTo="setup" choosing={choosing} onChoosing={setChoosing} checking={overview.isFetching} onCheck={() => overview.refetch()} />;

  const connected = Boolean(data?.railway?.connected);
  const started = Boolean(data?.change);
  return (
    <AuthLayout onSignOut={onSignOut} width="read" step={2} top={inSetup ? <SetupProgress at="address" /> : undefined}>
      <div className={authStyles.flow}>
        <h1 className={authStyles.title}>Your web address</h1>
        <p className={authStyles.sub}>
          {companyName} can have its own web address in four steps. You can skip this and do it any time in Settings → Web address.
        </p>
        <div style={{ marginTop: 24 }}>{body}</div>
        <div style={{ marginTop: 16 }}><FormError error={finish.error} /></div>
        <div className={authStyles.acts} data-stack="">
          {connected ? (
            <Button variant={started ? "primary" : "secondary"} loading={finish.isPending} onClick={() => finish.mutate("done")}>
              {started ? "Continue to Crewtavo" : "Not now"}
            </Button>
          ) : (
            <Button loading={finish.isPending} onClick={() => finish.mutate("skipped")}>Skip for now</Button>
          )}
        </div>
        {connected && started && data?.change?.status !== "done" && (
          <p className={authStyles.note} style={{ marginTop: 12 }}>Crewtavo finishes setting up the address by itself and lets you know when it's done.</p>
        )}
      </div>
    </AuthLayout>
  );
}
