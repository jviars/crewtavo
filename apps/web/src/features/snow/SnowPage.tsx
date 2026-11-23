/**
 * Snow (Apps → Crewtavo - Snow), in three tabs by what you came to do. Storm: the snow coming from
 * 6pm today through tomorrow (an overnight storm counts whole), a storm that's here today, and
 * what's left to do about each (StormBoard.tsx). Customers: the snow customers themselves, each a
 * job with the snow that sends the plow or the salt out, how it's served, who works it and what a
 * storm bills. A customer's row, on either, opens it in a popup: its address, notes, photos and files
 * (SnowSiteDetails.tsx), with Edit for how it's served. Season: every storm, what fell, its visits and what it bills (StormLog.tsx).
 *
 * The day before, the snow task tells each customer's people what's coming, and on the day about a
 * storm they weren't told of (snowWatch in apps/api/src/tasks.ts); sending them out is the office's
 * call, from the Storm tab (POST /api/snow/schedule puts them on tomorrow's visits, or today's),
 * unless it turned on the switch there that schedules each storm as its people are told. Someone told whose forecast has since dropped
 * says so there, and nobody is sent an all-clear: calling it off is the office's call too.
 *
 * Laid out as App-Snow.dc.html: underline tabs on a desktop, a segmented control on a phone, where the
 * page is the phone kit's grouped one (Mobile-Apps.dc.html): a grey ground with its lists in cards.
 */
import { useQuery } from "@tanstack/react-query";
import { useDeferredValue, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Button, cx } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { InboxGroup, InboxList, InboxRow, ListFoot } from "@/components/ui/InboxList";
import { PageHeader } from "@/components/ui/PageHeader";
import { InboxSkeleton, Loading, Skeleton } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState } from "@/components/ui/States";
import { SearchField } from "@/components/ui/Toolbar";
import { api } from "@/lib/api";
import { addressLine } from "@/lib/format";
import { useSession } from "@/lib/session";
import { bandsKey, customer, loadBands, loadSites, located, nameOf, rulesOf, sitesKey, tiersOf, type Member, type Site } from "./snowData";
import { StandardPricesDialog } from "./SnowPrices";
import { SnowSiteDetails } from "./SnowSiteDetails";
import { SnowSiteDialog } from "./SnowSiteDialog";
import { SHOP, WeatherDialog, hasShop } from "./SnowWeather";
import { ClearBy, StormBoard } from "./StormBoard";
import { StormLog } from "./StormLog";
import { triggersText } from "./storm";
import styles from "./snow.module.css";

const TABS = [{ id: "storm", label: "Storm" }, { id: "customers", label: "Customers" }, { id: "log", label: "Season" }] as const;
type Tab = (typeof TABS)[number]["id"];

export function SnowPage() {
  const { company } = useSession();
  const [params, setParams] = useSearchParams();
  const tab: Tab = TABS.find((t) => t.id === params.get("tab"))?.id ?? "storm";
  const at = (to: Tab): Record<string, string> => (to === "storm" ? {} : { tab: to });
  /** The address bar says which tab, and which popup is open over it. */
  const show = (open: Record<string, string> = {}) => setParams({ ...at(tab), ...open }, { replace: true });
  const editing = params.get("edit") ?? (params.get("new") === "1" ? "new" : null);
  const weatherAt = params.get("weather");
  const opened = params.get("open");
  const sites = useQuery({ queryKey: sitesKey(company.id), queryFn: () => loadSites(company.id) });
  const team = useQuery({ queryKey: ["team", company.id, "with-subs"], staleTime: 5 * 60_000, queryFn: () => api.get<Member[]>("/team?with_subs=1") });
  const bands = useQuery({ queryKey: bandsKey(company.id), queryFn: () => loadBands(company.id) });

  if (sites.isPending) return <SnowSkeleton />;
  const all = sites.data ?? [];
  const site = editing && editing !== "new" ? all.find((s) => s.job_id === editing) : null;
  const openSite = opened ? all.find((s) => s.job_id === opened) : null;
  return (
    <>
      <PageHeader
        title="Snow"
        actions={
          <>
            {/* The shop's weather, with a customer's a pick away; with no shop on the map, a customer's. */}
            {(hasShop(company) || all.some(located)) && <Button icon="cloudSnow" onClick={() => show({ weather: hasShop(company) ? SHOP : all.find(located)!.job_id })}>Weather</Button>}
            {tab === "customers" && <Button icon="dollar" disabled={!bands.data} onClick={() => show({ prices: "1" })}>Standard storm prices</Button>}
            {/* The page's one green button, except on Storm with a storm to schedule: there that's the thing to do. */}
            <Button variant={tab === "storm" && all.length > 0 ? "secondary" : "primary"} icon="plus" onClick={() => show({ new: "1" })}>Add snow customer</Button>
          </>
        }
      />
      <div className={cx("underline-tabs", styles.tabs)} role="tablist" aria-label="Snow">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} onClick={() => setParams(at(t.id), { replace: true })}>
            {t.label}
            {t.id === "customers" && all.length > 0 && <span className="badge">{all.length}</span>}
          </button>
        ))}
      </div>
      <div className={cx("m-grouped", styles.body)}>
        {sites.error && !sites.data ? (
          <ErrorState error={sites.error} onRetry={() => sites.refetch()} />
        ) : tab === "log" ? (
          <StormLog />
        ) : tab === "customers" ? (
          <Customers sites={all} team={team.data ?? []} />
        ) : (
          <StormBoard sites={all} team={team.data ?? []} onWeather={(place) => show({ weather: place })} />
        )}
      </div>
      {/* Edit, from a customer's popup, goes back to it. */}
      {openSite && !editing && !weatherAt && (
        <SnowSiteDetails key={openSite.job_id} site={openSite} team={team.data ?? []} onEdit={() => show({ open: openSite.job_id, edit: openSite.job_id })} onWeather={() => show({ weather: openSite.job_id })} onClose={() => show()} />
      )}
      {editing && (editing === "new" || site) && (
        <SnowSiteDialog key={editing} site={site ?? null} team={(team.data ?? []).filter((m) => m.active || site?.people.some((p) => p.user_id === m.user_id))} onClose={() => show(openSite ? { open: openSite.job_id } : {})} />
      )}
      {params.get("prices") === "1" && bands.data && <StandardPricesDialog saved={bands.data} onClose={() => show()} />}
      {weatherAt && <WeatherDialog sites={all} place={weatherAt} onPick={(place) => show({ weather: place })} onClose={() => show()} />}
    </>
  );
}

/** The page's shape while its customers load: the title, the tabs, the sky and a few rows. */
function SnowSkeleton() {
  return (
    <Loading>
      <div className="stack-lg">
        <div className="row-between"><Skeleton width={110} height={28} /><Skeleton width={150} height={36} radius={8} className="hide-mobile" /></div>
        <Skeleton width={220} height={30} radius={8} />
        <Skeleton height={168} radius={12} />
        <InboxSkeleton rows={4} groups={2} />
      </div>
    </Loading>
  );
}

/** Piles on the Customers tab: what needs a look before the next storm, those set for one, and those paused. */
type Pile = "check" | "ready" | "paused";
const PILES: Array<{ id: Pile; label: string }> = [{ id: "check", label: "Needs a look" }, { id: "ready", label: "Ready for snow" }, { id: "paused", label: "Paused" }];

/** The snow customers as they're set up: what sends the plow and the salt, how each is served, who works it and what a storm bills. */
function Customers({ sites: all, team }: { sites: Site[]; team: Member[] }) {
  const [search, setSearch] = useState("");
  const term = useDeferredValue(search.trim().toLowerCase());
  const members = new Map(team.map((m) => [m.user_id, m]));
  const unlocated = all.filter((s) => !s.job.paused_at && !located(s));
  const rows = all
    .filter((s) => !term || [customer(s), s.job.title, addressLine(s.job.property), s.job.crew?.name].some((v) => v?.toLowerCase().includes(term)))
    .sort((a, b) => customer(a).localeCompare(customer(b)));
  if (all.length === 0) {
    return (
      // Add snow customer is the page header's green button, so it isn't repeated here.
      <EmptyState icon="snow" title="No snow customers yet">
        Add a job as a snow customer with the inches of snow that call for it. The day before, its crew and anyone else on it are told when the forecast from 6pm through the next day reaches it.
      </EmptyState>
    );
  }
  const nobody = (s: Site) => !s.job.crew && !s.people.length;
  const pileOf = (s: Site): Pile => (s.job.paused_at ? "paused" : !located(s) || nobody(s) ? "check" : "ready");
  return (
    <>
      {unlocated.length > 0 && (
        <div className="callout callout-danger">
          <Icon name="alert" size={16} />
          <div className="grow">
            {unlocated.length === 1 ? `${customer(unlocated[0]!)} has no map location, so its forecast is never checked.` : `${unlocated.length} snow customers have no map location, so their forecasts are never checked.`} Fix the address on the property.
          </div>
        </div>
      )}
      <div className={styles.listHead}>
        <div className={styles.listTitle}>
          <h2>Snow customers</h2>
          <span>What sends the plow and the salt, who works each one, and what a storm bills</span>
        </div>
        <SearchField value={search} onChange={setSearch} placeholder="Customer, address or crew" label="Search snow customers" />
      </div>
      {rows.length === 0 ? (
        <EmptyState icon="search" title="Nothing matches" action={<Button onClick={() => setSearch("")}>Clear search</Button>} />
      ) : (
        <InboxList label="Snow customers" inset className={styles.rows} foot={<ListFoot>{rows.length} snow {rows.length === 1 ? "customer" : "customers"}</ListFoot>}>
          {PILES.map((pile) => {
            const mine = rows.filter((s) => pileOf(s) === pile.id);
            if (!mine.length) return null;
            return (
              <InboxGroup key={pile.id} label={pile.label} count={mine.length} tone={pile.id === "check" ? "warning" : undefined} icon={pile.id === "check" ? "alert" : undefined}>
                {mine.map((s) => {
                  const people = s.people.map((p) => nameOf(members.get(p.user_id)));
                  const prices = tiersOf(s).length;
                  const crew = [s.job.crew?.name, people.join(", ")].filter(Boolean).join(" · ");
                  return (
                    <InboxRow
                      key={s.job_id}
                      // Its popup on this page takes the page's place in the history, as the tabs do: Back leaves Snow, not a popup.
                      to={`/snow?tab=customers&open=${s.job_id}`}
                      replace
                      title={customer(s)}
                      square
                      badge={!located(s) && !s.job.paused_at ? <span className="il-note" data-tone="danger"><Icon name="pin" size={13} />No map location</span> : undefined}
                      subject={addressLine(s.job.property) || s.job.title}
                      meta={[
                        triggersText(rulesOf(s), true),
                        // On a phone the triggers have the line; the popup says the rest.
                        <span className={styles.wideOnly}>{prices ? `By depth, ${prices} ${prices === 1 ? "price" : "prices"}` : "The job's price, each push"}</span>,
                        s.tell_client && <span className={styles.wideOnly}>Customer is told</span>,
                      ]}
                      aside={
                        <>
                          <ClearBy site={s} />
                          {crew ? <span className={cx("il-sub", styles.crew)} title={crew}>{crew}</span> : <span className="il-sub" data-tone="danger">No one assigned</span>}
                        </>
                      }
                    />
                  );
                })}
              </InboxGroup>
            );
          })}
        </InboxList>
      )}
    </>
  );
}
