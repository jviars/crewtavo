/**
 * Apps: every app Crewtavo works with, as icons with their names beneath, grouped like a phone's
 * app store. Opening one shows its own page (AppDetailPage) to connect and manage it.
 */
import { Navigate, useSearchParams } from "react-router-dom";
import { PageHeader } from "@/components/ui/PageHeader";
import { Loading, Skeleton } from "@/components/ui/Skeleton";
import { ErrorState, NoAccess } from "@/components/ui/States";
import { AppTile } from "./AppIcon";
import { CATEGORY_LABELS, useApps, type AppRow } from "./catalog";

export function AppsPage() {
  const apps = useApps();
  const [params] = useSearchParams();

  // Sign-in links from before app pages existed came back to /apps?app=...
  const legacy = params.get("app");
  if (legacy) return <Navigate to={`/apps/${encodeURIComponent(legacy)}?${new URLSearchParams([...params].filter(([k]) => k !== "app"))}`} replace />;
  if (!apps.allowed) return <NoAccess title="Apps" />;

  const groups = new Map<AppRow["category"], AppRow[]>();
  for (const app of apps.data?.apps ?? []) groups.set(app.category, [...(groups.get(app.category) ?? []), app]);

  return (
    <>
      <PageHeader title="Apps">
        <p className="muted" style={{ margin: 0, flexBasis: "100%" }}>Turn on what's built into Crewtavo, and bring in the calendars, books and tools you already use. Open an app to set it up.</p>
      </PageHeader>

      {apps.error && <div className="card"><ErrorState error={apps.error} onRetry={() => apps.refetch()} /></div>}
      {apps.isPending && (
        <Loading label="Loading apps" className="stack">
          {[0, 1].map((s) => (
            <section key={s} className="stack-sm" style={{ gap: 14 }}>
              <Skeleton width={140} height={20} />
              <div className="app-grid">
                {[0, 1, 2, 3, 4].map((i) => (
                  <div key={i} className="app-tile" aria-hidden="true">
                    <Skeleton width={60} height={60} radius={15} />
                    <Skeleton width={56} height={11} />
                  </div>
                ))}
              </div>
            </section>
          ))}
        </Loading>
      )}

      {[...groups].map(([category, rows]) => (
        <section key={category} aria-labelledby={`apps-${category}`} className="stack-sm" style={{ gap: 12 }}>
          <h2 id={`apps-${category}`} className="section-title">{CATEGORY_LABELS[category] ?? category}</h2>
          <div className="app-grid">
            {rows.map((app) => <AppTile key={app.id} app={app} />)}
          </div>
        </section>
      ))}
    </>
  );
}
