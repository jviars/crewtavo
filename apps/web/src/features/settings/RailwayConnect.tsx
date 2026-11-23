/**
 * Connecting Railway, for the step the owner is asked at sign-in until it's done
 * (features/setup/RailwaySetupPage.tsx) and for Settings → Hosting: why Crewtavo needs it, Login
 * with Railway beside a sketch of Railway's screen, and a project token for when Railway won't do
 * that. It says plainly that Crewtavo never sees billing, so Railway's own spending limit is set in
 * Railway (Settings → Hosting shows where, once connected).
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
          <Icon name="alert" size={16} />
          <div className="grow">
            <div>Railway isn't connected</div>
            <div>{railway.error}</div>
          </div>
        </div>
      )}
      {railway.oauth ? (
        <div className={styles.split}>
          <div className="stack-sm">
            <span className={styles.lead}>
              Railway runs Crewtavo and bills you for it. Once you log in, Crewtavo shows what it costs under Settings → Hosting and warns you before your trial runs out or the bill
              goes over your plan, so it never stops by surprise. It can set up your own web address too.
            </span>
            <ConnectRailway returnTo={returnTo} projectName={railway.projectName} />
          </div>
          <RailwaySketch projectName={railway.projectName} />
        </div>
      ) : (
        <RailwayTokenForm tokensUrl={railway.tokensUrl} intro={TOKEN_INTRO} />
      )}
      <span className={styles.lockNote}>
        <Icon name="lock" size={13} />
        <span>
          Crewtavo only uses {railway.projectName ? <strong>{railway.projectName}</strong> : "its own project"}, and never sees your card or billing, so it can't set a spending limit for you:
          once you're in, Settings → Hosting shows where to set one in Railway. You can take the access back any time there too.
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
