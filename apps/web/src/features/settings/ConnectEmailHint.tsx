/** "Connect your email" for notices where email is off: a link for people who can (`then` says what it's for), a pointer for everyone else. */
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { T, t } from "@/lib/i18n";
import { can, hasRole, useSession } from "@/lib/session";

export function ConnectEmailHint({ then = "to turn it on" }: { then?: string }) {
  const session = useSession();
  const canConnect = hasRole(session, "admin") && (can(session, "apps") || can(session, "settings"));
  return canConnect ? (
    <> <Link to="/settings?tab=email" className="strong">Connect your email</Link> {then}.</>
  ) : (
    <> An owner can turn it on in Settings → Email.</>
  );
}

/** The same for texting: the business connects its Quo number or its own Twilio account on the Apps page. */
export function ConnectTextingHint({ then = "to turn it on" }: { then?: string }) {
  const session = useSession();
  const canConnect = hasRole(session, "admin") && can(session, "apps");
  const app = (to: string) => (s: ReactNode) => <Link to={to} className="strong">{s}</Link>;
  return canConnect ? (
    <> <T text="Connect <quo>Quo</quo> or <twilio>Twilio</twilio> {then}." quo={app("/apps/quo")} twilio={app("/apps/twilio")} then={then} /></>
  ) : (
    <> {t("An owner can turn it on in Apps → Quo or Apps → Twilio.")}</>
  );
}
