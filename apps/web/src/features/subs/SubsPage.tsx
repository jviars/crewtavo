/**
 * The businesses the company hires for jobs, whether their W-9 and insurance are on file and current,
 * and what they're owed. Year-end totals and the workers' comp audit are a click away.
 */
import { subSettings, usesIrsForms } from "@crewtavo/core/subs";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useDeferredValue, useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Button, cx } from "@/components/ui/Button";
import { FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { InboxGroup, InboxList, InboxRow, ListFoot } from "@/components/ui/InboxList";
import { Menu } from "@/components/ui/Menu";
import { PageHeader } from "@/components/ui/PageHeader";
import { Section } from "@/components/ui/Section";
import { InboxPageSkeleton } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState, NoAccess } from "@/components/ui/States";
import { FilterTabs, SearchField, Toolbar } from "@/components/ui/Toolbar";
import { searchTerm, supabase, unwrap } from "@/lib/api";
import { companyCountry } from "@/lib/format";
import { useSession } from "@/lib/session";
import { toast } from "@/lib/toast";
import { OwedCard } from "./OwedCard";
import { inOrder, needsAttention, paperworkBySub, paperworkChip, type PaperworkRow } from "./paperwork";
import { countryLabel, readCallingCode, withCountry } from "./signInCountries";
import { SendLinkDialog, SubDialog } from "./SubDialogs";
import styles from "./Subs.module.css";
import { loadSubs, managesSubs, useSubPaperwork, type Sub } from "./subsData";

const FILTERS = [
  { key: "all", label: "Active" },
  { key: "attention", label: "Needs attention" },
] as const;
type FilterKey = (typeof FILTERS)[number]["key"] | "off";

/** The list in what-needs-doing order: subs whose paperwork needs attention, then the rest. Empty groups are left out. */
export function groupSubs<T>(rows: readonly T[], needs: (row: T) => boolean) {
  return [
    { key: "attention", label: "Needs attention", tone: "danger" as const, icon: "alert" as const, rows: rows.filter(needs) },
    { key: "ok", label: "Paperwork OK", rows: rows.filter((r) => !needs(r)) },
  ].filter((g) => g.rows.length > 0);
}

export function SubsPage() {
  const session = useSession();
  if (!managesSubs(session)) return <NoAccess title="Subcontractors" />;
  return <SubsList />;
}

function SubsList() {
  const session = useSession();
  // The year-end totals are for 1099s, and the W-9 is asked for: a US business's (core usesIrsForms).
  const irs = usesIrsForms(companyCountry());
  const { company } = session;
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const show = params.get("show");
  const filter: FilterKey = show === "attention" || show === "off" ? show : "all";
  const setFilter = (key: FilterKey) => setParams(key === "all" ? {} : { show: key }, { replace: true });
  const [search, setSearch] = useState("");
  const [asking, setAsking] = useState<Sub | null>(null);
  const term = useDeferredValue(searchTerm(search).toLowerCase());

  const list = useQuery({
    queryKey: ["subs", company.id, "list"],
    queryFn: () => loadSubs(company.id),
  });
  const paperwork = useSubPaperwork(company.id);
  const bySub = useMemo(() => paperworkBySub(paperwork.data ?? []), [paperwork.data]);
  const statusOf = (s: Sub): PaperworkRow[] => bySub.get(s.id) ?? inOrder([]);
  // Chips only from statuses that loaded: a failed load isn't "missing".
  const chipsReady = Boolean(paperwork.data);

  const all = list.data ?? [];
  const active = all.filter((s) => s.active);
  const attention = paperwork.data ? active.filter((s) => needsAttention(statusOf(s))) : [];
  const off = all.filter((s) => !s.active);
  const counts = { all: active.length, attention: attention.length };
  const rows = (filter === "off" ? off : filter === "attention" ? attention : active).filter(
    (s) => !term || [s.name, s.contact_name, s.trade, s.phone, s.email].some((v) => v?.toLowerCase().includes(term)),
  );

  if (list.isPending) return <InboxPageSkeleton tabs={2} groups={2} />;

  const addButton = <Button variant="primary" icon="plus" onClick={() => setParams({ new: "1" }, { replace: true })}>Add a sub</Button>;
  const offButton = filter !== "off" && off.length > 0 ? <button type="button" className="link-btn" onClick={() => setFilter("off")}>{off.length} turned off</button> : null;
  const row = (s: Sub) => {
    const statuses = statusOf(s);
    const needs = s.active && chipsReady && needsAttention(statuses);
    return (
      <InboxRow
        key={s.id}
        to={`/subs/${s.id}`}
        title={s.name}
        square
        badge={s.trade ? <span className="tag">{s.trade}</span> : undefined}
        subject={[s.contact_name, s.phone].filter(Boolean).join(" · ") || s.email || undefined}
        meta={s.active && chipsReady ? <Papers statuses={statuses} /> : !s.active ? "Turned off" : undefined}
        aside={needs ? <Button size="sm" className={styles.ask} onClick={() => setAsking(s)}>Ask for it</Button> : undefined}
      />
    );
  };
  const groups = filter === "off" || !chipsReady ? [{ key: "all", rows }] : groupSubs(rows, (s) => needsAttention(statusOf(s)));

  return (
    <>
      <PageHeader
        title="Subcontractors"
        actions={
          <>
            {all.length > 0 && irs && <Link className="btn hide-mobile" to="/subs/1099"><Icon name="file" size={16} />Year-end totals</Link>}
            {all.length > 0 && <Link className="btn hide-mobile" to="/subs/workers-comp"><Icon name="clipboard" size={16} />Workers' comp audit</Link>}
            {/* On a phone the two reports are one More sheet, not two round icons that look alike. */}
            {all.length > 0 && (
              <Menu
                title="Subcontractors"
                triggerClassName={cx("btn btn-icon", styles.phoneOnly)}
                items={[
                  ...(irs ? [{ label: "Year-end totals", icon: "file" as const, onSelect: () => navigate("/subs/1099") }] : []),
                  { label: "Workers' comp audit", icon: "clipboard", onSelect: () => navigate("/subs/workers-comp") },
                ]}
              />
            )}
            {addButton}
          </>
        }
      />
      {/* On a phone the page is grouped (Mobile-Team, Subcontractors): what's owed, each group of subs and the settings as inset cards. */}
      <div className={cx("m-grouped", styles.body)}>
        {all.length > 0 && <OwedCard />}
        {all.length > 0 && (
          <Toolbar
            filters={
              filter === "off" ? (
                <Button size="sm" variant="ghost" icon="arrowLeft" onClick={() => setFilter("all")}>Back to active subs</Button>
              ) : (
                <FilterTabs label="Filter subs" value={filter} onChange={setFilter} options={FILTERS.map((f) => ({ value: f.key, label: f.label, count: f.key === "attention" && !paperwork.data ? undefined : counts[f.key] }))} />
              )
            }
            search={<SearchField value={search} onChange={setSearch} placeholder="Name, contact, trade or phone" label="Search subs" />}
          />
        )}
        {paperwork.error && !paperwork.data && active.length > 0 && (
          <ErrorState compact title="Couldn't load their paperwork" error={paperwork.error} onRetry={() => paperwork.refetch()} />
        )}
        {list.error && !list.data ? (
          <ErrorState error={list.error} onRetry={() => list.refetch()} />
        ) : all.length === 0 ? (
          // Add a sub is the page header's green button, so it isn't repeated here.
          <EmptyState icon="users" title="Keep your subs' paperwork in one place">
            Add the crews you hire for jobs and keep their {irs ? "W-9 and insurance certificates" : "insurance certificates"} current. Up-to-date certificates can save you real money at your workers' comp audit.
          </EmptyState>
        ) : rows.length === 0 ? (
          term ? (
            <EmptyState icon="search" title="Nothing matches" action={<Button onClick={() => setSearch("")}>Clear search</Button>} />
          ) : filter === "attention" ? (
            <EmptyState icon="check" title="Everyone's paperwork is up to date" />
          ) : (
            <EmptyState icon="users" title={filter === "off" ? "No subs are turned off" : "No active subs"} action={offButton} />
          )
        ) : (
          <InboxList label="Subcontractors" inset foot={<ListFoot end={offButton}>{rows.length} {rows.length === 1 ? "sub" : "subs"}</ListFoot>}>
            {groups.map((g) => (
              <InboxGroup key={g.key} label={"label" in g ? g.label : undefined} count={"label" in g ? g.rows.length : undefined} tone={"tone" in g ? g.tone : undefined} icon={"icon" in g ? g.icon : undefined}>
                {g.rows.map(row)}
              </InboxGroup>
            ))}
          </InboxList>
        )}
        {all.length > 0 && <Settings />}
      </div>
      {params.get("new") === "1" && <SubDialog sub={null} onClose={() => setParams({}, { replace: true })} onSaved={(id) => navigate(`/subs/${id}`)} />}
      {asking && <SendLinkDialog sub={asking} paperwork={statusOf(asking)} onClose={() => setAsking(null)} />}
    </>
  );
}

const SHORT: Record<string, string> = { w9: "W-9", liability: "Liability", workers_comp: "Workers' comp" };

/** A sub's three papers on one quiet line: each one's name with a dot, and its state in words (colored when it's a problem). */
export function Papers({ statuses }: { statuses: readonly PaperworkRow[] }) {
  return (
    <span className={styles.papers}>
      {statuses.map((p) => {
        const chip = paperworkChip(p);
        return (
          <span key={p.requirement} className="pill" data-tone={chip.tone}>
            <span className="pill-dot" />
            <span className={styles.paperName}>{SHORT[p.requirement!]}</span> {chip.label}
          </span>
        );
      })}
    </span>
  );
}

/** The subs' settings: reminders, and which countries' numbers get sign-in codes by text. */
function Settings() {
  return (
    <div className={styles.settings}>
      <Reminders />
      <SignInCountries />
    </div>
  );
}

/** Whether subs hear about their own certificates running out (companies.settings.subs.remind_subs). The office always does. */
function Reminders() {
  const session = useSession();
  const on = subSettings(session.company.settings).remind_subs;
  const save = useMutation({
    meta: { inline: true },
    mutationFn: async (value: boolean) => unwrap(await supabase().rpc("set_sub_reminders", { p_company: session.company.id, p_remind_subs: value })),
    onSuccess: async (_r, value) => {
      await session.refresh();
      toast.success(value ? "Subs will get reminders" : "Subs won't get reminders");
    },
  });
  const checked = save.isPending ? Boolean(save.variables) : on;
  return (
    <Section title="Reminders">
      <label className="switch-row">
        <input type="checkbox" className="switch" checked={checked} disabled={save.isPending} onChange={(e) => save.mutate(e.target.checked)} />
        Remind subs when their insurance is about to expire
      </label>
      <span className={styles.hint}>
        30 days and 7 days before, and on the day it ends, we email or text them a link to send the new one. You get a notification either way.
      </span>
      <FormError error={save.error} />
    </Section>
  );
}

/**
 * Which countries' numbers get a sign-in code by text when a sub signs in on a new phone
 * (companies.settings.subs.sign_in_countries, set_sub_sign_in_countries). US and Canada always do.
 */
function SignInCountries() {
  const session = useSession();
  const saved = subSettings(session.company.settings).sign_in_countries;
  const [draft, setDraft] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const save = useMutation({
    meta: { inline: true },
    mutationFn: async (countries: string[]) => unwrap(await supabase().rpc("set_sub_sign_in_countries", { p_company: session.company.id, p_countries: countries })),
    onSuccess: async () => {
      setDraft("");
      await session.refresh();
    },
  });
  const countries = save.isPending && save.variables ? save.variables : saved;
  function add(e: FormEvent) {
    e.preventDefault();
    const read = readCallingCode(draft, countries);
    if ("error" in read) return setProblem(read.error);
    setProblem(null);
    save.mutate(withCountry(countries, read.code));
  }
  return (
    <Section title="Sign-in codes by text">
      <form className={styles.countries} onSubmit={add}>
        <span className={styles.hint}>
          A sub on a new phone can sign in with a code we text them. Texts cost money, so codes only go to the countries here, which stops strangers running up your bill.
          For a sub outside the US and Canada, save their number starting with + and the country code, like +52 55 1234 5678.
        </span>
        <div className="row wrap" style={{ gap: 6 }}>
          <span className="chip">+1 US and Canada</span>
          {countries.map((code) => (
            <span key={code} className="chip">
              {countryLabel(code)}
              <button type="button" aria-label={`Stop texting codes to ${countryLabel(code)}`} disabled={save.isPending} onClick={() => save.mutate(countries.filter((c) => c !== code))}><Icon name="x" size={12} bold /></button>
            </span>
          ))}
        </div>
        <div className="row" style={{ gap: 8 }}>
          <div className="input-group" style={{ maxWidth: 200 }}>
            <span className="addon">+</span>
            <input className="input" inputMode="numeric" value={draft} onChange={(e) => { setDraft(e.target.value); setProblem(null); }} placeholder="44" maxLength={8} aria-label="Country calling code" />
          </div>
          <Button type="submit" loading={save.isPending} disabled={!draft.trim()}>Add a country</Button>
        </div>
        {problem && <p role="alert" className="field-error" style={{ margin: 0 }}>{problem}</p>}
        {!session.config.features.sms && (
          <span className={styles.hint}>
            {session.config.features.email
              ? "Texting isn't set up on this Crewtavo yet, so codes go out by email instead, to subs with an email on file."
              : "Texting isn't set up on this Crewtavo yet, so no codes go out for now."}
          </span>
        )}
        <FormError error={save.error} />
      </form>
    </Section>
  );
}
