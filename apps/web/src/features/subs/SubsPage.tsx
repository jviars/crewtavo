/**
 * The businesses the company hires for jobs, whether their W-9 and insurance are on file and current,
 * and what they're owed. Year-end totals and the workers' comp audit are a click away.
 */
import { subSettings } from "@crewtavo/core/subs";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useDeferredValue, useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { PageHeader } from "@/components/ui/PageHeader";
import { ListPageSkeleton } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState, NoAccess } from "@/components/ui/States";
import { StatusPill } from "@/components/ui/StatusPill";
import { searchTerm, supabase, unwrap } from "@/lib/api";
import { useSession } from "@/lib/session";
import { toast } from "@/lib/toast";
import { OwedCard } from "./OwedCard";
import { inOrder, needsAttention, paperworkBySub, paperworkChip, type PaperworkRow } from "./paperwork";
import { countryLabel, readCallingCode, withCountry } from "./signInCountries";
import { SubDialog } from "./SubDialogs";
import { managesSubs, SUB_FIELDS, useSubPaperwork, type Sub } from "./subsData";

const FILTERS = [
  { key: "all", label: "Active" },
  { key: "attention", label: "Needs attention" },
] as const;
type FilterKey = (typeof FILTERS)[number]["key"] | "off";

export function SubsPage() {
  const session = useSession();
  if (!managesSubs(session)) return <NoAccess title="Subcontractors" />;
  return <SubsList />;
}

function SubsList() {
  const session = useSession();
  const { company } = session;
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const show = params.get("show");
  const filter: FilterKey = show === "attention" || show === "off" ? show : "all";
  const setFilter = (key: FilterKey) => setParams(key === "all" ? {} : { show: key }, { replace: true });
  const [search, setSearch] = useState("");
  const term = useDeferredValue(searchTerm(search).toLowerCase());

  const list = useQuery({
    queryKey: ["subs", company.id, "list"],
    queryFn: async () => unwrap(await supabase().from("subcontractors").select(SUB_FIELDS).eq("company_id", company.id).order("name").limit(2000)) as unknown as Sub[],
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

  if (list.isPending) return <ListPageSkeleton columns={5} tabs={2} />;

  const addButton = <Button variant="primary" icon="plus" onClick={() => setParams({ new: "1" }, { replace: true })}>Add a sub</Button>;
  const offButton = filter !== "off" && off.length > 0 ? <Button size="sm" variant="ghost" onClick={() => setFilter("off")}>{off.length} turned off</Button> : null;

  return (
    <>
      <PageHeader
        title="Subcontractors"
        actions={
          <>
            {all.length > 0 && <Link className="btn" to="/subs/1099"><Icon name="file" size={16} />Year-end totals</Link>}
            {all.length > 0 && <Link className="btn" to="/subs/workers-comp"><Icon name="clipboard" size={16} />Workers' comp audit</Link>}
            {addButton}
          </>
        }
      />
      {all.length > 0 && <OwedCard />}
      {all.length > 0 && (
        <div className="toolbar">
          <div className="input-group">
            <span className="addon"><Icon name="search" size={16} /></span>
            <input className="input" type="search" placeholder="Search by business, contact, trade or phone" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search subs" />
          </div>
          {filter === "off" ? (
            <Button icon="arrowLeft" onClick={() => setFilter("all")}>Back to active subs</Button>
          ) : (
            <div className="tabs" role="group" aria-label="Filter subs">
              {FILTERS.map((f) => (
                <button key={f.key} type="button" className="tab" aria-pressed={filter === f.key} onClick={() => setFilter(f.key)}>
                  {f.label}
                  <span className="badge">{counts[f.key]}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {paperwork.error && !paperwork.data && active.length > 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <ErrorState compact title="Couldn't load their paperwork" error={paperwork.error} onRetry={() => paperwork.refetch()} />
        </div>
      )}
      {list.error && !list.data ? (
        <div className="card"><ErrorState error={list.error} onRetry={() => list.refetch()} /></div>
      ) : all.length === 0 ? (
        <div className="card">
          <EmptyState icon="users" title="Keep your subs' paperwork in one place" action={addButton}>
            Add the crews you hire for jobs and keep their W-9 and insurance certificates current. Up-to-date certificates can save you real money at your workers' comp audit.
          </EmptyState>
        </div>
      ) : rows.length === 0 ? (
        <div className="card">
          {term ? (
            <EmptyState icon="search" title="Nothing matches" action={<Button onClick={() => setSearch("")}>Clear search</Button>} />
          ) : filter === "attention" ? (
            <EmptyState icon="check" title="Everyone's paperwork is up to date" />
          ) : (
            <EmptyState icon="users" title={filter === "off" ? "No subs are turned off" : "No active subs"} action={offButton} />
          )}
        </div>
      ) : (
        <div className="card">
          <table className="table table-stack">
            <thead><tr><th>Sub</th><th>Trade</th><th>Phone</th><th>W-9</th><th>Liability</th><th>Workers' comp</th></tr></thead>
            <tbody>
              {rows.map((s) => {
                const statuses = statusOf(s);
                return (
                  <tr key={s.id} className="row-link" onClick={() => navigate(`/subs/${s.id}`)}>
                    <td style={{ minWidth: 180 }}>
                      <Link className="cell-link" to={`/subs/${s.id}`} onClick={(ev) => ev.stopPropagation()}>{s.name}</Link>
                      {s.contact_name && <div className="muted small">{s.contact_name}</div>}
                    </td>
                    {/* Stacked on a phone, an empty cell is just left out. */}
                    <td className={s.trade ? undefined : "hide-mobile"}>{s.trade ?? <span className="muted">—</span>}</td>
                    <td className={s.phone ? undefined : "hide-mobile"} style={{ whiteSpace: "nowrap" }}>{s.phone ? <a href={`tel:${s.phone}`} onClick={(ev) => ev.stopPropagation()}>{s.phone}</a> : <span className="muted">—</span>}</td>
                    {statuses.map((p) => (
                      <td key={p.requirement}>
                        {!s.active || (!chipsReady && !paperwork.isPending) ? <span className="muted">—</span> : chipsReady ? <PaperworkChip row={p} requirement={p.requirement!} /> : null}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="list-foot">
            <span>{rows.length} {rows.length === 1 ? "sub" : "subs"}</span>
            {offButton}
          </div>
        </div>
      )}
      {all.length > 0 && <SettingsCard />}
      {params.get("new") === "1" && <SubDialog sub={null} onClose={() => setParams({}, { replace: true })} onSaved={(id) => navigate(`/subs/${id}`)} />}
    </>
  );
}

const SHORT: Record<string, string> = { w9: "W-9", liability: "Liability", workers_comp: "Workers' comp" };

/** One requirement's chip. On a phone, where the table stacks, it says which requirement it is. */
export function PaperworkChip({ row, requirement }: { row: PaperworkRow; requirement: string }) {
  const chip = paperworkChip(row);
  return (
    <span className="row" style={{ gap: 6 }}>
      <span className="muted small mobile-only">{SHORT[requirement]}</span>
      <StatusPill label={chip.label} tone={chip.tone} />
    </span>
  );
}

/** The subs' settings: reminders, and which countries' numbers get sign-in codes by text. */
function SettingsCard() {
  return (
    <div className="card card-pad stack-sm" style={{ marginTop: 20 }}>
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
    <>
      <strong>Reminders</strong>
      <label className="switch-row" style={{ fontWeight: 500 }}>
        <input type="checkbox" className="switch" checked={checked} disabled={save.isPending} onChange={(e) => save.mutate(e.target.checked)} />
        Remind subs when their insurance is about to expire
      </label>
      <span className="muted small">
        30 days and 7 days before, and on the day it ends, we email or text them a link to send the new one. You get a notification either way.
      </span>
      <FormError error={save.error} />
    </>
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
    <form className="stack-sm" style={{ borderTop: "1px solid var(--divider)", paddingTop: 12, marginTop: 4 }} onSubmit={add}>
      <strong>Sign-in codes by text</strong>
      <span className="muted small">
        A sub on a new phone can sign in with a code we text them. Texts cost money, so codes only go to the countries here, which stops strangers running up your bill.
        For a sub outside the US and Canada, save their number starting with + and the country code, like +52 55 1234 5678.
      </span>
      <div className="row wrap" style={{ gap: 6 }}>
        <span className="chip">+1 US and Canada</span>
        {countries.map((code) => (
          <span key={code} className="chip">
            {countryLabel(code)}
            <button type="button" aria-label={`Stop texting codes to ${countryLabel(code)}`} disabled={save.isPending} onClick={() => save.mutate(countries.filter((c) => c !== code))}><Icon name="x" size={10} strokeWidth={3} /></button>
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
        <span className="muted small">
          {session.config.features.email
            ? "Texting isn't set up on this Crewtavo yet, so codes go out by email instead, to subs with an email on file."
            : "Texting isn't set up on this Crewtavo yet, so no codes go out for now."}
        </span>
      )}
      <FormError error={save.error} />
    </form>
  );
}
