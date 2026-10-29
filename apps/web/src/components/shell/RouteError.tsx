import { useEffect, useState, type ReactNode } from "react";
import { isRouteErrorResponse, Link, useLocation, useRouteError } from "react-router-dom";
import { copyText } from "@/lib/clipboard";
import { looksTechnical } from "@/lib/errors";
import { reportError } from "@/lib/monitoring";
import { Button } from "../ui/Button";
import { Icon } from "../ui/Icon";

const RELOAD_KEY = "crewtavo.chunk-reload";

/**
 * A screen failed to load or crashed. After a deploy, old screen files disappear: reload once.
 * A message meant for people says what happened; one meant for developers is tucked away under
 * "Details for support", ready to copy with the screen and the time.
 */
export function RouteError({ fullPage }: { fullPage?: boolean }) {
  const error = useRouteError();
  const { pathname } = useLocation();
  const [at] = useState(() => new Date());
  const message = error instanceof Error ? error.message : isRouteErrorResponse(error) ? error.statusText : String(error);
  const staleBuild = /dynamically imported module|Importing a module script failed|error loading dynamically|Failed to fetch dynamically/i.test(message);
  const notFound = isRouteErrorResponse(error) && error.status === 404;

  useEffect(() => {
    if (!staleBuild && !notFound) reportError(error, { screen: "route" });
  }, [error, staleBuild, notFound]);

  if (staleBuild) {
    try {
      if (!sessionStorage.getItem(RELOAD_KEY)) {
        sessionStorage.setItem(RELOAD_KEY, "1");
        window.location.reload();
        return null;
      }
    } catch {
      // Storage blocked: fall through to the message.
    }
  }
  if (notFound) {
    return <Wrap fullPage={fullPage} icon="search" title="Page not found" body="That page doesn't exist or was moved." />;
  }
  if (staleBuild) {
    return <Wrap fullPage={fullPage} icon="alert" title="Crewtavo was updated" body="Reload to get the latest version." />;
  }
  // Something the app threw for people to read ("Still loading. Try again in a moment.") can just say so.
  const readable = error instanceof Error && Boolean(message) && !looksTechnical(message);
  const raw = isRouteErrorResponse(error) ? `${error.status} ${error.statusText}`.trim() : message;
  const details = [`Screen: ${pathname}`, `Time: ${at.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "long" })}`, raw].filter(Boolean).join("\n");
  return (
    <Wrap
      fullPage={fullPage}
      icon="alert"
      title="Something went wrong"
      body={readable ? message : "This screen hit an unexpected problem. Reloading usually fixes it. If it keeps happening, let us know what you were doing."}
    >
      {!readable && raw && (
        <details className="crash-details">
          <summary>Details for support</summary>
          <pre>{details}</pre>
          <Button size="sm" icon="copy" onClick={() => void copyText(details, "Copied")}>Copy details</Button>
        </details>
      )}
    </Wrap>
  );
}

function Wrap({ fullPage, icon, title, body, children }: { fullPage?: boolean; icon: "alert" | "search"; title: string; body: string; children?: ReactNode }) {
  const content = (
    <div className="card">
      <div className="empty-state error-state" role="alert">
        <span className="empty-icon"><Icon name={icon} size={24} /></span>
        <h3>{title}</h3>
        <p>{body}</p>
        <div className="actions">
          <Button variant="primary" icon="refresh" onClick={() => window.location.reload()}>Reload</Button>
          <Link className="btn" to="/">Go home</Link>
        </div>
        {children}
      </div>
    </div>
  );
  if (!fullPage) return content;
  return <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 16, background: "var(--ground)" }}><div style={{ width: "min(560px, 100%)" }}>{content}</div></div>;
}
