import { useEffect } from "react";
import { isRouteErrorResponse, Link, useRouteError } from "react-router-dom";
import { reportError } from "@/lib/monitoring";
import { Button } from "../ui/Button";
import { Icon } from "../ui/Icon";

const RELOAD_KEY = "crewtavo.chunk-reload";

/** A screen failed to load or crashed. After a deploy, old screen files disappear: reload once. */
export function RouteError({ fullPage }: { fullPage?: boolean }) {
  const error = useRouteError();
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
  return (
    <Wrap
      fullPage={fullPage}
      icon="alert"
      title={staleBuild ? "Crewtavo was updated" : "Something went wrong"}
      body={staleBuild ? "Reload to get the latest version." : "This screen hit an unexpected problem. Reloading usually fixes it. If it keeps happening, let us know what you were doing."}
      detail={staleBuild ? undefined : message}
    />
  );
}

function Wrap({ fullPage, icon, title, body, detail }: { fullPage?: boolean; icon: "alert" | "search"; title: string; body: string; detail?: string }) {
  const content = (
    <div className="card">
      <div className="empty-state error-state" role="alert">
        <span className="empty-icon"><Icon name={icon} size={24} /></span>
        <h3>{title}</h3>
        <p>{body}</p>
        {detail && <code className="muted small" style={{ maxWidth: 520, overflowWrap: "anywhere" }}>{detail}</code>}
        <div className="actions">
          <Button variant="primary" icon="refresh" onClick={() => window.location.reload()}>Reload</Button>
          <Link className="btn" to="/">Go home</Link>
        </div>
      </div>
    </div>
  );
  if (!fullPage) return content;
  return <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 16, background: "var(--ground)" }}><div style={{ width: "min(560px, 100%)" }}>{content}</div></div>;
}
