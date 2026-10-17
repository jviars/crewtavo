/** "Connect your email" for notices where email is off: a link for people who can, a pointer for everyone else. */
import { Link } from "react-router-dom";
import { can, hasRole, useSession } from "@/lib/session";

export function ConnectEmailHint() {
  const session = useSession();
  const canConnect = hasRole(session, "admin") && (can(session, "apps") || can(session, "settings"));
  return canConnect ? (
    <> <Link to="/settings?tab=email" className="strong">Connect your email</Link> to turn it on.</>
  ) : (
    <> An owner can turn it on in Settings → Email.</>
  );
}
