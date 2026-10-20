/**
 * Connecting Railway, for the step the owner is asked at sign-in until it's done
 * (features/setup/RailwaySetupPage.tsx) and for Settings → Hosting: why Crewtavo needs it, Login
 * with Railway beside a sketch of Railway's screen, and a project token for when Railway won't do
 * that. A sign-in from before Crewtavo asked to read billing is asked again, in its own words.
 */
import type { AddressOverview } from "@crewtavo/core/address";
import { Icon } from "@/components/ui/Icon";
import { ConnectRailway, RailwaySketch, RailwayTokenForm, type RailwayReturn } from "./WebAddressSettings";
import styles from "./WebAddressSettings.module.css";

type Railway = NonNullable<AddressOverview["railway"]>;

const TOKEN_INTRO = "A project token lets Crewtavo show what it costs and set up your web address, but it can't see your Railway billing, so there are no warnings about the trial, credit or card.";

export function RailwayConnect({ railway, returnTo }: { railway: Railway; returnTo: RailwayReturn }) {
  const again = railway.connected && !railway.current;
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
              {again
                ? "Crewtavo can now warn you before your Railway trial, credit or card runs out, and show what it costs. It needs to read your Railway billing for that, so Railway asks you once more."
                : "Railway runs Crewtavo and bills you for it. Once you log in, Crewtavo shows what it costs and warns you before your trial, credit or card runs out, so it never stops by surprise. It can set up your own web address too."}
            </span>
            <ConnectRailway returnTo={returnTo} projectName={railway.projectName} label={again ? "Log in with Railway again" : "Log in with Railway"} />
          </div>
          <RailwaySketch projectName={railway.projectName} />
        </div>
      ) : (
        <RailwayTokenForm tokensUrl={railway.tokensUrl} intro={TOKEN_INTRO} />
      )}
      <span className="row muted small" style={{ gap: 6, flexWrap: "nowrap", alignItems: "flex-start" }}>
        <span style={{ flex: "none", marginTop: 1 }}><Icon name="lock" size={14} /></span>
        <span>
          Crewtavo only makes changes in {railway.projectName ? <strong>{railway.projectName}</strong> : "this project"}, and only reads your Railway billing, apart from a usage limit you choose
          to change. You can take the access back any time in Settings → Hosting.
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
