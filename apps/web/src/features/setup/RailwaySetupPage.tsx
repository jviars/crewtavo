/**
 * The setup step after "Set up your business", for a business set up on Railway (lib/session.tsx
 * shows it while companies.settings.railway_setup is "pending"): the same four steps as Settings →
 * Web address (log in with Railway, choose a domain, connect it, switch over). Owners have just
 * deployed from Railway and are still signed in there, so logging in is one press of Allow. It can
 * be skipped; Settings → Web address does everything later too. The pieces come from
 * features/settings/WebAddressSettings.tsx. `onSignOut` is the session's, which leaves nothing of
 * theirs on the phone.
 */
import type { AddressOverview } from "@crewtavo/core/address";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { FormError } from "@/components/ui/Field";
import { CardSkeleton } from "@/components/ui/Skeleton";
import { ErrorState } from "@/components/ui/States";
import { AuthLayout } from "@/features/auth/LoginPage";
import authStyles from "@/features/auth/auth.module.css";
import { AddressScreen, useRailwayReturn, WEB_ADDRESS_KEY } from "@/features/settings/WebAddressSettings";
import { api } from "@/lib/api";

export function RailwaySetupPage({ companyName, onDone, onSignOut }: { companyName: string; onDone: () => void; onSignOut: () => void }) {
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
  useRailwayReturn();

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
