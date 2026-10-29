/**
 * Crewtavo - Website Analytics on its Apps page. Install turns it on and shows the line to paste
 * into the website, with where it goes on the usual site builders, and Check looks for it there.
 * Uninstall stops counting and keeps every number. The numbers are in Marketing → Website.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { Field } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { Skeleton } from "@/components/ui/Skeleton";
import { ErrorState } from "@/components/ui/States";
import { StatusPill } from "@/components/ui/StatusPill";
import { api } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { timeAgo } from "@/lib/format";
import { useSession } from "@/lib/session";
import styles from "./AnalyticsPanel.module.css";

/** What Check found on the website (routes/analytics.ts). */
export interface WebsiteCheck {
  at: string;
  found: boolean;
  url: string;
  problem?: string;
}

export interface AnalyticsSetup {
  enabled: boolean;
  /** The line to paste. */
  snippet: string;
  /** The website's address: last checked, or the business's own. */
  site: string | null;
  /** Once Check found the line: the website whose pages count. */
  counting: string | null;
  check: WebsiteCheck | null;
  /** The latest page view in the last two days, or the latest day with any before that. */
  last_visit_at: string | null;
  last_visit_day: string | null;
}

export function useAnalyticsSwitch() {
  const session = useSession();
  const queryClient = useQueryClient();
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => api.post<{ enabled: boolean }>("/analytics/enabled", { enabled }),
    onSuccess: async (res) => {
      // Marketing's Website tab comes and goes with it (the company's settings).
      await session.refresh();
      await queryClient.invalidateQueries({ queryKey: ["apps"] });
      queryClient.invalidateQueries({ queryKey: ["analytics-setup"] });
      return res;
    },
    meta: { success: (res: { enabled: boolean }) => (res.enabled ? null : "Website Analytics uninstalled") },
  });
  const turnOff = async () => {
    const ok = await confirm({
      title: "Uninstall Website Analytics?",
      body: "Crewtavo stops counting visits to your website right away. Everything counted so far is kept, and shows in Marketing again if you install it again. The line on your website does nothing until then.",
      confirmLabel: "Uninstall",
      danger: true,
    });
    if (ok) toggle.mutate(false);
  };
  return { toggle, turnOff };
}

/** A website builder and where the line goes in it. A site built by a developer gets DeveloperSteps. */
interface Builder { id: string; label: string; steps?: ReactNode[]; note?: ReactNode }

/** The line for GoDaddy: it names its page, since GoDaddy runs it in a frame of its own (services/analytics.ts). */
export const pageLine = (line: string, path = "/") => line.replace(" src=", ` data-page="${path}" src=`);

// From each builder's help pages (October 2026). Keep in step with the website-analytics page in the website docs.
const BUILDERS: Builder[] = [
  {
    id: "wix",
    label: "Wix",
    steps: [
      <>In your site's dashboard, go to <strong>Settings</strong>, then <strong>Custom Code</strong> (under Development &amp; integrations).</>,
      <>Click <strong>+ Add Custom Code</strong> at the top right and paste the line. Name it Crewtavo.</>,
      <>Under <strong>Add Code to Pages</strong>, choose <strong>All pages</strong> and <strong>Load code once</strong>. Under <strong>Place Code in</strong>, choose <strong>Head</strong>.</>,
      <>Click <strong>Apply</strong>.</>,
    ],
    note: <>Wix only allows this on a paid plan with your own domain connected.</>,
  },
  {
    id: "squarespace",
    label: "Squarespace",
    steps: [
      <>Open <strong>Code Injection</strong>: in the <strong>Pages</strong> panel, scroll down to <strong>Website Tools</strong> and click <strong>Code Injection</strong>. (On some accounts it's under <strong>Settings</strong>, then <strong>Developer Tools</strong>.)</>,
      <>Paste the line into <strong>Header</strong>, after anything already there.</>,
      <>Click <strong>Save</strong>.</>,
    ],
    note: <>Needs the Core, Plus or Advanced plan (or Business or Commerce on older plans).</>,
  },
  {
    id: "wordpress",
    label: "WordPress",
    steps: [
      <>In WordPress, go to <strong>Plugins</strong>, then <strong>Add New</strong>. Search for <strong>WPCode</strong> and install and activate <strong>WPCode – Insert Headers and Footers</strong>.</>,
      <>Go to <strong>Code Snippets</strong>, then <strong>Header &amp; Footer</strong>.</>,
      <>Paste the line into <strong>Header</strong> and click <strong>Save Changes</strong>.</>,
    ],
    note: <>On WordPress.com, plugins need a Business (Creator) plan or higher. WordPress sites hosted anywhere else work as they are.</>,
  },
  {
    id: "godaddy",
    label: "GoDaddy",
    steps: [
      <>GoDaddy's website builder has no place for code on every page, so add it to each page you want counted, starting with your home page.</>,
      <>In the editor, add a section near the bottom of the page, search for <strong>HTML</strong> and add it. Set its height to 1 so it doesn't show.</>,
      <>Paste the line for GoDaddy below into <strong>Custom Code</strong>. On each other page, change <code className={styles.inline}>data-page="/"</code> to that page's address, like <code className={styles.inline}>"/services"</code>.</>,
      <>Publish.</>,
    ],
    note: <>GoDaddy runs custom code in a box of its own, so Crewtavo can't see where these visitors came from. Pages and visitors still count.</>,
  },
  { id: "developer", label: "Built by a developer" },
  {
    id: "google-sites",
    label: "Google Sites",
    note: <>Google Sites doesn't let a website add its own code to its pages, so Crewtavo can't count its visits. The booking form still works on it.</>,
  },
  {
    id: "other",
    label: "Something else",
    steps: [
      <>Look in your website's settings for <strong>Code injection</strong>, <strong>Custom code</strong>, <strong>Tracking code</strong> or <strong>Head HTML</strong>: a place for code on every page.</>,
      <>Paste the line there (in the <strong>head</strong>, if it asks) and publish.</>,
    ],
    note: <>A box for code on one page usually shows it in a frame of its own, and the line doesn't count visits from there. Ask whoever made your website to put it in the head of every page.</>,
  },
];

type Framework = "astro" | "next" | "other";

/** For a site in code: the line in the layout every page uses. */
function DeveloperSteps({ line }: { line: string }) {
  const [framework, setFramework] = useState<Framework>("astro");
  const src = /src="([^"]+)"/.exec(line)?.[1] ?? "";
  const site = /data-site="([^"]+)"/.exec(line)?.[1];
  const component = `import Script from "next/script";\n\n// In app/layout.tsx (or pages/_app.tsx), inside <body>:\n<Script src="${src}"${site ? ` data-site="${site}"` : ""} strategy="afterInteractive" />`;
  const pick = (value: Framework, label: string) => <button type="button" aria-pressed={framework === value} onClick={() => setFramework(value)}>{label}</button>;
  return (
    <div className="stack-sm">
      <div className="segmented" role="group" aria-label="Built with" style={{ justifySelf: "start" }}>
        {pick("astro", "Astro")}
        {pick("next", "Next.js")}
        {pick("other", "Other")}
      </div>
      {framework === "astro" ? (
        <ol className="app-steps" aria-label="Steps for Astro">
          <li>Paste the line into the <code className={styles.inline}>{"<head>"}</code> of the layout every page uses, like <code className={styles.inline}>src/layouts/Layout.astro</code>. Astro leaves it as it is.</li>
          <li>With view transitions (<code className={styles.inline}>{"<ClientRouter />"}</code>), each page people move to still counts.</li>
        </ol>
      ) : framework === "next" ? (
        <ol className="app-steps" aria-label="Steps for Next.js">
          <li>
            <div className="stack-sm">
              <span>Add it with Next.js's Script component in the root layout, so it loads once and counts every page people move to:</span>
              <pre className={styles.code}>{component}</pre>
              <Button size="sm" icon="copy" style={{ justifySelf: "start" }} onClick={() => copyText(component, "Copied")}>Copy</Button>
            </div>
          </li>
        </ol>
      ) : (
        <ol className="app-steps" aria-label="Steps for other sites">
          <li>Paste the line into the <code className={styles.inline}>{"<head>"}</code> of the template every page uses (Hugo, Eleventy, Jekyll, plain HTML), or of the app's <code className={styles.inline}>index.html</code> (React, Vue, Svelte).</li>
          <li>Apps that change pages without reloading count each page too.</li>
        </ol>
      )}
    </div>
  );
}

/** Installed: the line, where it goes, and Check. */
export function AnalyticsPanel() {
  const session = useSession();
  const queryClient = useQueryClient();
  const setup = useQuery({
    queryKey: ["analytics-setup", session.company.id],
    queryFn: () => api.get<AnalyticsSetup>("/analytics/setup"),
    // Until the first visit arrives, look again every few seconds, so pasting the line shows here.
    refetchInterval: (q) => (q.state.data && !q.state.data.last_visit_at && !q.state.data.last_visit_day ? 10_000 : false),
  });
  const [builderId, setBuilderId] = useState(BUILDERS[0]!.id);
  // What's typed, once someone types; until then the website Crewtavo already knows.
  const [typed, setSite] = useState<string | null>(null);
  const site = typed ?? setup.data?.site ?? "";
  const check = useMutation({
    meta: { inline: true },
    mutationFn: () => api.post<{ site: string; check: WebsiteCheck; counting: string | null }>("/analytics/check", site.trim() ? { site: site.trim() } : {}),
    onSuccess: (res) => {
      setSite(res.site);
      queryClient.invalidateQueries({ queryKey: ["analytics-setup"] });
    },
  });

  if (setup.error) return <div className="card"><ErrorState error={setup.error} onRetry={() => setup.refetch()} /></div>;
  if (!setup.data) {
    return (
      <section className="card card-pad stack-sm" aria-busy="true" aria-label="Loading">
        <Skeleton width={260} height={20} /><Skeleton height={38} /><Skeleton width="70%" height={14} />
      </section>
    );
  }
  const data = setup.data;
  const builder = BUILDERS.find((b) => b.id === builderId) ?? BUILDERS[0]!;
  const line = builder.id === "godaddy" ? pageLine(data.snippet) : data.snippet;
  const visited = data.last_visit_at ? timeAgo(data.last_visit_at) : data.last_visit_day ? `on ${new Date(`${data.last_visit_day}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}` : null;
  const result = check.data?.check ?? data.check;
  const working = Boolean(result?.found || visited);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    check.mutate();
  };

  return (
    <>
      <section className="card card-pad stack-sm" aria-labelledby="analytics-status" style={{ gap: 10 }}>
        <div className="row-between wrap" style={{ gap: 8 }}>
          <h2 id="analytics-status" className="section-title" style={{ fontSize: 16 }}>{working ? "Counting your website's visits" : "Waiting for your website"}</h2>
          <StatusPill label={working ? "Installed" : "Not on your website yet"} tone={working ? "good" : "muted"} />
        </div>
        <span className="muted" role="status">
          {visited
            ? <>Last visit {visited}{data.counting ? <> to <strong>{data.counting}</strong></> : null}. Each visit shows in Marketing within a minute.</>
            : <>Once the line below is on your website, visits show up in Marketing within a minute of someone opening it.</>}
        </span>
        {working && (
          <div className="row wrap" style={{ gap: 8 }}>
            <Link className="btn" to="/marketing?tab=website"><Icon name="marketing" size={16} />See visits in Marketing</Link>
          </div>
        )}
      </section>

      <section id="app-setup" className="card card-pad stack" aria-labelledby="analytics-line" style={{ gap: 14 }}>
        <div className="stack-sm" style={{ gap: 4 }}>
          <h2 id="analytics-line" className="section-title" style={{ fontSize: 16 }}>Put this line on your website</h2>
          <span className="muted small">It goes on every page, in the part of the page called the head. It loads from your own Crewtavo, uses no cookies and keeps nothing that tells who a visitor is.</span>
        </div>
        <div className="row wrap" style={{ gap: 8 }}>
          <code className="code-pill grow" aria-label={builder.id === "godaddy" ? "The line for GoDaddy" : "The line to paste"}>{line}</code>
          <Button icon="copy" onClick={() => copyText(line, "Line copied")}>Copy</Button>
        </div>
        <Field label="Your website is on">
          <select className="select" value={builder.id} onChange={(e) => setBuilderId(e.target.value)}>
            {BUILDERS.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}
          </select>
        </Field>
        {builder.id === "developer" ? (
          <DeveloperSteps line={data.snippet} />
        ) : builder.steps ? (
          <ol className="app-steps" aria-label={`Steps for ${builder.label}`}>{builder.steps.map((step, i) => <li key={`${builder.id}-${i}`}>{step}</li>)}</ol>
        ) : null}
        {builder.note && <p className="muted small" style={{ margin: 0 }}>{builder.note}</p>}
      </section>

      <section className="card card-pad stack-sm" aria-labelledby="analytics-check" style={{ gap: 10 }}>
        <h2 id="analytics-check" className="section-title" style={{ fontSize: 16 }}>Check your website</h2>
        <span className="muted small">After you publish, Crewtavo opens your home page and looks for the line. Once it finds it, only that website's pages count, so a copy of your site somewhere else doesn't add to your numbers.</span>
        <form className="row wrap" style={{ gap: 8 }} onSubmit={submit}>
          <input className="input grow" style={{ minWidth: 0, flexBasis: 220 }} type="text" inputMode="url" autoComplete="url" spellCheck={false} placeholder="greenlawn.com" aria-label="Your website's address" value={site} onChange={(e) => { setSite(e.target.value); check.reset(); }} />
          <Button type="submit" variant={working ? "secondary" : "primary"} icon="refresh" loading={check.isPending}>Check</Button>
        </form>
        {check.error && <span className="field-error">{(check.error as Error).message}</span>}
        {result && !check.isPending && <CheckResult check={result} />}
      </section>
    </>
  );
}

function CheckResult({ check }: { check: WebsiteCheck }) {
  const host = new URL(check.url).hostname.replace(/^www\./, "");
  if (check.found) {
    return (
      <div className="callout callout-good" role="status">
        <Icon name="check" size={18} />
        <div className="grow">Installed on {host}<span className="muted small" style={{ display: "block", fontWeight: 400 }}>Checked {timeAgo(check.at)}</span></div>
      </div>
    );
  }
  return (
    <div className="callout callout-warning" role="status">
      <Icon name="alert" size={18} />
      <div className="grow">
        {check.problem ?? <>The line isn't on {host} yet. Paste it, publish your website, and check again.</>}
        <span className="muted small" style={{ display: "block", fontWeight: 400 }}>Checked {timeAgo(check.at)}</span>
      </div>
    </div>
  );
}
