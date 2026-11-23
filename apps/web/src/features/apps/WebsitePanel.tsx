/**
 * Sveltia CMS on its Apps page: the website's editor, by its address. Installing asks for it and the
 * API checks the editor is there (apps/api/src/integrations/website.ts). Once it's in, Website is in
 * the menu, and this shows what was found, with Change address and Check again.
 */
import { CMS_NAMES, repoUrl, siteName, type WebsiteSite } from "@crewtavo/core/website";
import { useMutation } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { Fact, Facts, Section } from "@/components/ui/Section";
import { api } from "@/lib/api";
import { ApiError } from "@/lib/errors";
import { timeAgo } from "@/lib/format";
import type { AppRow } from "./catalog";
import { CodeBlock, kit } from "./PanelKit";

/** Where an editor saves, as its sign-in screen names it. */
const BACKENDS: Record<string, string> = { github: "GitHub", gitlab: "GitLab", gitea: "Gitea or Forgejo", "test-repo": "A test repository (nothing is saved)" };

/** An editor's page as people read it: greenlawn.com/admin/ */
const bare = (url: string) => url.replace(/^https:\/\//, "").replace(/^www\./, "");

/** What lets this site show the editor inside Crewtavo, for whoever looks after the website. */
const frameHeader = () => `Content-Security-Policy: frame-ancestors 'self' ${window.location.origin}`;

export function WebsitePanel({ app, onSaved }: { app: AppRow; onSaved: () => void }) {
  const site = app.website ?? null;
  const [editing, setEditing] = useState(false);
  if (!site) return <AddressCard onSaved={onSaved} />;
  return (
    <Section className={kit.panel} title={siteName(site)} action={!editing && <button type="button" onClick={() => setEditing(true)}><Icon name="edit" size={14} />Change address</button>}>
      <p className={kit.text}>
        <strong>Website</strong> is in the menu for owners, admins and anyone whose role has Marketing. It opens {site.cms ? CMS_NAMES[site.cms] : "your editor"} right there, and
        everyone signs in to it the way they do on your site.
      </p>
      {editing && <AddressForm initial={bare(site.admin_url)} onSaved={() => { setEditing(false); onSaved(); }} onCancel={() => setEditing(false)} />}
      <Facts label="Your website">
        <Fact label="Editor"><a href={site.admin_url} target="_blank" rel="noreferrer">{bare(site.admin_url)} <Icon name="external" size={12} /></a></Fact>
        <Fact label="Saves to">{site.repo && <><RepoLink site={site} />{site.branch ? <span className="muted"> · {site.branch}</span> : null}</>}</Fact>
        <Fact label="Signs in with">{site.backend && (BACKENDS[site.backend] ?? site.backend)}</Fact>
        <Fact label="Checked"><span className="app-fact-line">{timeAgo(site.checked_at)}<CheckAgain site={site} onSaved={onSaved} /></span></Fact>
      </Facts>
      {site.framing === "blocked" && <FramingBlocked site={site} />}
    </Section>
  );
}

function RepoLink({ site }: { site: WebsiteSite }) {
  const url = repoUrl(site);
  return url ? <a href={url} target="_blank" rel="noreferrer">{site.repo} <Icon name="external" size={12} /></a> : <>{site.repo}</>;
}

/** The site keeps other sites from showing it: Website opens it in a tab, and this says how to change that. */
function FramingBlocked({ site }: { site: WebsiteSite }) {
  return (
    <div className="callout callout-warning" role="note">
      <Icon name="info" size={16} />
      <div className="grow">
        <div>{siteName(site)} doesn't let other sites show it, so Website opens your editor in its own tab.</div>
        To see it inside Crewtavo, whoever looks after your website adds this header to the editor's page, then press <strong>Check again</strong>:
        <div className="app-callout-row"><CodeBlock code={frameHeader()} what="Header" done="Header copied" /></div>
      </div>
    </div>
  );
}

function CheckAgain({ site, onSaved }: { site: WebsiteSite; onSaved: () => void }) {
  const check = useMutation({
    meta: { success: "Checked: everything's in place" },
    mutationFn: () => api.put<{ website: WebsiteSite }>("/apps/sveltia/site", { address: site.admin_url, anyway: true }),
    onSuccess: onSaved,
  });
  return (
    <button type="button" className="link-btn" disabled={check.isPending} aria-busy={check.isPending || undefined} onClick={() => check.mutate()}>
      {check.isPending && <span className="spinner" style={{ width: 12, height: 12 }} aria-hidden="true" />}
      Check again
    </button>
  );
}

/** Installing: the address, then the API's check. */
function AddressCard({ onSaved }: { onSaved: () => void }) {
  return (
    <Section className={kit.panel} id="app-setup" title="Your website's address">
      <p className={kit.note}>
        Where you sign in to Sveltia: usually your website with <strong>/admin</strong> at the end. Crewtavo checks the editor is there, then puts <strong>Website</strong> in the menu.
      </p>
      <AddressForm onSaved={onSaved} />
    </Section>
  );
}

function AddressForm({ initial = "", onSaved, onCancel }: { initial?: string; onSaved: () => void; onCancel?: () => void }) {
  const [address, setAddress] = useState(initial);
  const save = useMutation({
    meta: { inline: true, success: onCancel ? "Address changed" : undefined },
    mutationFn: (anyway: boolean) => api.put<{ website: WebsiteSite }>("/apps/sveltia/site", { address: address.trim(), anyway }),
    onSuccess: onSaved,
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (address.trim().length >= 3) save.mutate(false);
  };
  // The page opened but doesn't say Sveltia: an editor bundled into the site's own code can still be kept.
  const noEditor = save.error instanceof ApiError && save.error.status === 422;
  return (
    <div className="stack-sm" style={{ gap: 8 }}>
      <form className="row wrap" style={{ gap: 8 }} onSubmit={submit}>
        <input
          className="input grow"
          style={{ minWidth: 220 }}
          type="text"
          inputMode="url"
          autoComplete="url"
          autoCapitalize="none"
          spellCheck={false}
          placeholder="greenlawn.com/admin"
          aria-label="Your website's address"
          value={address}
          onChange={(e) => {
            setAddress(e.target.value);
            save.reset();
          }}
        />
        <Button type="submit" variant={initial ? undefined : "primary"} loading={save.isPending && !save.variables} disabled={address.trim().length < 3}>{initial ? "Save" : "Add"}</Button>
        {onCancel && <Button variant="ghost" onClick={onCancel}>Cancel</Button>}
      </form>
      {save.error && (
        <span className="field-error">
          {(save.error as Error).message}
          {noEditor && (
            <>
              {" "}
              <button type="button" className="link-btn" disabled={save.isPending} onClick={() => save.mutate(true)}>Use this address anyway</button>
            </>
          )}
        </span>
      )}
    </div>
  );
}
