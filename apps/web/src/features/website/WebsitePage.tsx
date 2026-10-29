/**
 * Website: the business's own website editor (Sveltia CMS, installed from Apps) inside Crewtavo.
 * It's the site's own /admin page in a frame, so it works as it does on its own: people sign in to
 * it with GitHub (its sign-in window reports back to the frame) or a token, and it saves to the
 * site's repository. Crewtavo never sees that sign-in. It's light or dark with the device, as in a
 * tab of its own (browsers don't pass a frame's color-scheme on). A site that won't be shown inside
 * another one opens in a tab instead.
 */
import { CMS_NAMES, siteName, websiteOf, type WebsiteSite } from "@crewtavo/core/website";
import { useState } from "react";
import { Link } from "react-router-dom";
import { Spinner } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { PageHeader, useDocumentTitle } from "@/components/ui/PageHeader";
import { EmptyState, NoAccess } from "@/components/ui/States";
import { can, hasRole, useSession } from "@/lib/session";
import s from "./website.module.css";

export function WebsitePage() {
  const session = useSession();
  const site = websiteOf(session.company.settings);
  useDocumentTitle(site ? siteName(site) : "Website");
  const canInstall = hasRole(session, "admin") && can(session, "apps");

  if (!(hasRole(session, "admin", "office") && can(session, "marketing"))) return <div className="content"><NoAccess title="Website" /></div>;
  if (!site) {
    return (
      <div className="content">
        <PageHeader title="Website" />
        <div className="card">
          <EmptyState icon="globe" title="Edit your website here" action={canInstall ? <Link className="btn btn-primary" to="/apps/sveltia">Install Sveltia CMS</Link> : undefined}>
            {canInstall
              ? "If your website has Sveltia CMS, install it from Apps and add your website's address. Its editor then opens right here."
              : "Ask an owner or admin to install Sveltia CMS from Apps. Your website's editor then opens right here."}
          </EmptyState>
        </div>
      </div>
    );
  }
  if (site.framing === "blocked") return <OpensInTab site={site} canInstall={canInstall} />;
  return <Editor site={site} />;
}

/** The editor, filling the space under the top bar, with a slim bar of its own above it. */
function Editor({ site }: { site: WebsiteSite }) {
  const [reloads, setReloads] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const name = siteName(site);
  return (
    <div className={s.page}>
      <div className={s.bar}>
        <Icon name="globe" size={16} />
        <strong className={s.name}>{name}</strong>
        <span className={s.cms}>{site.cms ? CMS_NAMES[site.cms] : "Website editor"}</span>
        <span className="grow" />
        <button
          type="button"
          className="icon-btn"
          aria-label="Reload the editor"
          title="Reload the editor"
          onClick={() => {
            setLoaded(false);
            setReloads((n) => n + 1);
          }}
        >
          <Icon name="refresh" size={16} />
        </button>
        <a className="btn btn-sm" href={site.admin_url} target="_blank" rel="noreferrer" aria-label="Open in a new tab" title="Open in a new tab">
          <span className="hide-mobile">Open in a new tab</span>
          <Icon name="external" size={14} />
        </a>
      </div>
      <div className={s.frameArea}>
        {!loaded && <div className={s.loading}><Spinner size={22} label={`Loading ${name}`} /></div>}
        <iframe
          key={reloads}
          className={s.frame}
          src={site.admin_url}
          title={`${name} editor`}
          // Copying and pasting in the editor, and its own full-screen buttons.
          allow="clipboard-read; clipboard-write; fullscreen"
          // Everything the editor does in a tab of its own (its sign-in window, which isn't
          // sandboxed itself, its storage, dialogs and downloads), except taking over Crewtavo's tab.
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads allow-storage-access-by-user-activation"
          onLoad={() => setLoaded(true)}
        />
      </div>
    </div>
  );
}

/** The website keeps other sites from showing it: a button to open the editor in its own tab. */
function OpensInTab({ site, canInstall }: { site: WebsiteSite; canInstall: boolean }) {
  const name = siteName(site);
  return (
    <div className="content">
      <PageHeader title="Website" />
      <div className="card">
        <EmptyState
          icon="globe"
          title={`${name} opens in its own tab`}
          action={<a className="btn btn-primary" href={site.admin_url} target="_blank" rel="noreferrer">Open {site.cms ? CMS_NAMES[site.cms] : "the editor"} <Icon name="external" size={14} /></a>}
        >
          Your website doesn't let other sites show it, so its editor can't open inside Crewtavo.
          {canInstall && <> <Link to="/apps/sveltia">See how to change that</Link>.</>}
        </EmptyState>
      </div>
    </div>
  );
}
