/**
 * Connecting Railway, for the step the owner is asked at sign-in until it's done
 * (features/setup/RailwaySetupPage.tsx) and for Settings → Hosting: why Crewtavo needs it, Login
 * with Railway beside a sketch of Railway's screen, and a project token for when Railway won't do
 * that.
 */
import type { AddressOverview } from "@crewtavo/core/address";
import { Icon } from "@/components/ui/Icon";
import { ConnectRailway, RailwaySketch, RailwayTokenForm, type RailwayReturn } from "./WebAddressSettings";
import styles from "./WebAddressSettings.module.css";

type Railway = NonNullable<AddressOverview["railway"]>;

const TOKEN_INTRO = "With a project token, Crewtavo shows what it costs, warns you before the trial runs out, and sets up your web address, the same as logging in.";

export function RailwayConnect({ railway, returnTo }: { railway: Railway; returnTo: RailwayReturn }) {
  return (
    <div className="stack">
      {railway.error && !railway.connected && (
        <div className="callout callout-danger" role="alert">
          <Icon name="alert" size={18} />
          <div className="grow">
            <div>Railway isn't connected</div>
            <div style={{ fontWeight: 400 }}>{railway.error}</div>
          </div>
        </div>
      )}
      {railway.oauth ? (
        <div className={styles.split}>
          <div className="stack-sm">
            <span>
              Railway runs Crewtavo and bills you for it. Once you log in, Crewtavo shows what it costs and warns you before your trial runs out or the bill goes over your plan, so it
              never stops by surprise. It can set up your own web address too.
            </span>
            <ConnectRailway returnTo={returnTo} projectName={railway.projectName} />
          </div>
          <RailwaySketch projectName={railway.projectName} />
        </div>
      ) : (
        <RailwayTokenForm tokensUrl={railway.tokensUrl} intro={TOKEN_INTRO} />
      )}
      <span className="row muted small" style={{ gap: 6, flexWrap: "nowrap", alignItems: "flex-start" }}>
        <span style={{ flex: "none", marginTop: 1 }}><Icon name="lock" size={14} /></span>
        <span>
          Crewtavo only uses {railway.projectName ? <strong>{railway.projectName}</strong> : "its own project"}, and never sees your card or billing. You can take the access back any time in
          Settings → Hosting.
        </span>
      </span>
      {railway.oauth && (
        <details className={styles.details}>
          <summary>Can't log in with Railway?</summary>
          <RailwayTokenForm tokensUrl={railway.tokensUrl} intro={TOKEN_INTRO} />
        </details>
      )}
    </div>
  );
}
