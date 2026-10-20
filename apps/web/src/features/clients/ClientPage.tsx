import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { Icon } from "@/components/ui/Icon";
import { MapsLink } from "@/components/ui/MapsLink";
import { Menu } from "@/components/ui/Menu";
import { BackLink, PageHeader } from "@/components/ui/PageHeader";
import { DetailSkeleton, Skeleton } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState, PageError } from "@/components/ui/States";
import { EntityStatus } from "@/components/ui/StatusPill";
import { api, supabase, unwrap, unwrapOne } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { addressLine, formatDate, formatMoney } from "@/lib/format";
import { useRememberRecent } from "@/lib/recent";
import { can, hasRole, useSession } from "@/lib/session";
import { toast } from "@/lib/toast";
import { PlansCard } from "../plans/PlansCard";
import { NewQuoteDialog } from "../quotes/NewQuoteDialog";
import { NewRequestDialog } from "../requests/NewRequestDialog";
import { EditClientDialog } from "./ClientForm";
import { ContactLine, ContactsCard } from "./ContactsCard";
import { PropertyDialog, type AccessRow, type PropertyRow } from "./PropertyDialog";
import { Timeline } from "./Timeline";

type WorkTab = "requests" | "quotes" | "jobs" | "invoices";

export function ClientPage() {
  const { id = "" } = useParams();
  const session = useSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<WorkTab>("quotes");
  const [dialog, setDialog] = useState<null | "edit" | "request" | "quote">(null);
  const [property, setProperty] = useState<{ row?: PropertyRow; access?: AccessRow | null } | null>(null);
  const isOffice = hasRole(session, "admin", "office");
  const canSell = hasRole(session, "admin", "office", "estimator") && can(session, "sales");

  const client = useQuery({
    queryKey: ["client", id],
    queryFn: async () =>
      unwrapOne(
        await supabase()
          .from("clients")
          .select("id, display_name, company_name, email, phone, status, tags, lead_source, notes, created_at, billing_address, marketing_opt_out, referred_by, properties(id, label, line1, line2, city, region, postal_code, lat, lng, notes)")
          .eq("id", id)
          .maybeSingle(),
        "This client",
      ),
  });
  const c = client.data;
  useRememberRecent(session.company.id, c ? { kind: "client", id: c.id, title: c.display_name, subtitle: c.properties[0] ? addressLine(c.properties[0]) : c.email ?? undefined, path: `/clients/${c.id}` } : null);

  const referrer = useQuery({
    queryKey: ["client", c?.referred_by, "name"],
    enabled: Boolean(c?.referred_by),
    meta: { silent: true },
    queryFn: async () => unwrap(await supabase().from("clients").select("id, display_name").eq("id", c!.referred_by!).maybeSingle()),
  }).data;
  const access = useQuery({
    queryKey: ["client", id, "access", c?.properties.map((p) => p.id).join(",")],
    enabled: isOffice && Boolean(c?.properties.length),
    queryFn: async () => unwrap(await supabase().from("property_access").select("property_id, gate_code, lockbox_code, instructions").in("property_id", c!.properties.map((p) => p.id))),
  });
  const work = useQuery({
    queryKey: ["client", id, "work"],
    queryFn: async () => {
      const db = supabase();
      const [requests, quotes, jobs, invoices] = await Promise.all([
        db.from("requests").select("id, number, title, status, created_at").eq("client_id", id).order("created_at", { ascending: false }),
        db.from("quotes").select("id, number, title, status, total, updated_at").eq("client_id", id).order("created_at", { ascending: false }),
        db.from("jobs").select("id, number, title, status, kind, financials:job_financials(contract_total)").eq("client_id", id).order("created_at", { ascending: false }),
        isOffice ? db.from("invoices").select("id, number, status, total, balance_due, due_on").eq("client_id", id).order("created_at", { ascending: false }) : Promise.resolve({ data: [], error: null }),
      ]);
      return { requests: unwrap(requests), quotes: unwrap(quotes), jobs: unwrap(jobs), invoices: unwrap(invoices) as Array<{ id: string; number: number | null; status: string; total: number; balance_due: number; due_on: string | null }> };
    },
  });

  const update = useMutation({
    meta: { success: (_: unknown, patch: { status?: string; marketing_opt_out?: boolean }) => (patch.status === "archived" ? "Client archived" : patch.status ? "Client restored" : "Saved") },
    mutationFn: async (patch: { status?: "lead" | "active" | "archived"; marketing_opt_out?: boolean }) => unwrap(await supabase().from("clients").update(patch).eq("id", id)),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["client", id] });
      queryClient.invalidateQueries({ queryKey: ["clients", session.company.id] });
    },
  });
  const remove = useMutation({
    meta: { success: "Client deleted" },
    mutationFn: async () => unwrap(await supabase().from("clients").delete().eq("id", id)),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["clients", session.company.id] });
      navigate("/clients", { replace: true });
    },
  });
  const removeProperty = useMutation({
    meta: { success: "Property removed" },
    mutationFn: async (propertyId: string) => unwrap(await supabase().from("properties").delete().eq("id", propertyId)),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["client", id] }),
  });
  const hubLink = useMutation({
    mutationFn: () => api.get<{ link: string }>(`/clients/${id}/hub-link`),
    onSuccess: (r) => copyText(r.link, "Client Hub link copied. Send it to your client."),
  });
  const referralLink = useMutation({
    mutationFn: () => api.get<{ link: string }>(`/referrals/link/${id}`),
    onSuccess: (r) => copyText(r.link, "Referral link copied"),
  });
  const review = useMutation({
    mutationFn: (channel: "email" | "sms") => api.post<{ sent: boolean; detail: string }>("/reviews/request", { client_id: id, channel }),
    onSuccess: (r) => toast.success(r.detail),
  });

  if (client.isPending) return <DetailSkeleton />;
  if (client.error || !c) return <PageError error={client.error} onRetry={() => client.refetch()} back={<BackLink to="/clients">Clients</BackLink>} />;

  const owed = work.data?.invoices.reduce((sum, i) => sum + (["sent", "partially_paid", "overdue"].includes(i.status) ? Number(i.balance_due) : 0), 0) ?? 0;
  // Never paid, and taken as a loss: worth knowing before taking on more work for them.
  const writtenOff = work.data?.invoices.reduce((sum, i) => sum + (i.status === "written_off" ? Number(i.balance_due) : 0), 0) ?? 0;
  const counts = { requests: work.data?.requests.length ?? 0, quotes: work.data?.quotes.length ?? 0, jobs: work.data?.jobs.length ?? 0, invoices: work.data?.invoices.length ?? 0 };
  const hasWork = counts.quotes + counts.jobs + counts.invoices > 0;
  const accessFor = (pid: string) => access.data?.find((a) => a.property_id === pid) ?? null;
  const billing = c.billing_address as { line1?: string; city?: string; region?: string; postal_code?: string } | null;

  const deleteClient = async () => {
    if (hasWork) {
      if (await confirm({ title: `Archive ${c.display_name} instead?`, body: "This client has quotes, jobs or invoices, so deleting would erase that history. Archiving hides them from lists and keeps the records.", confirmLabel: "Archive client" })) update.mutate({ status: "archived" });
      return;
    }
    if (await confirm({ title: `Delete ${c.display_name}?`, body: "Their properties, requests, notes and contacts are deleted too. This can't be undone.", confirmLabel: "Delete client", danger: true })) remove.mutate();
  };

  return (
    <>
      <BackLink to="/clients">Clients</BackLink>
      <PageHeader
        title={c.display_name}
        actions={
          <>
            {canSell && <Button icon="requests" onClick={() => setDialog("request")}>New request</Button>}
            {canSell && <Button variant="primary" icon="plus" onClick={() => setDialog("quote")}>New quote</Button>}
            {canSell && (
              <Menu
                items={[
                  { label: "Edit client", icon: "edit", onSelect: () => setDialog("edit") },
                  { label: "Copy Client Hub link", icon: "link", onSelect: () => hubLink.mutate() },
                  { separator: true },
                  { label: "Ask for a review by email", icon: "star", onSelect: () => review.mutate("email"), disabled: !c.email },
                  { label: "Ask for a review by text", icon: "star", onSelect: () => review.mutate("sms"), disabled: !c.phone },
                  { label: "Copy referral link", icon: "gift", onSelect: () => referralLink.mutate() },
                  { separator: true, hidden: !isOffice },
                  { label: c.status === "archived" ? "Restore client" : "Archive client", icon: c.status === "archived" ? "undo" : "archive", onSelect: () => update.mutate({ status: c.status === "archived" ? "active" : "archived" }), hidden: !isOffice },
                  { label: "Delete client", icon: "trash", danger: true, onSelect: deleteClient, hidden: !isOffice },
                ]}
              />
            )}
          </>
        }
      />
      <div className="page-meta">
        <EntityStatus kind="client" status={c.status} />
        {c.company_name && c.company_name !== c.display_name && <span className="muted">{c.company_name}</span>}
        {c.tags.map((t) => <span key={t} className="chip">{t}</span>)}
        {c.marketing_opt_out && <span className="chip chip-amber">Unsubscribed from marketing</span>}
      </div>
      {c.status === "archived" && (
        <div className="callout callout-warning">
          <Icon name="archive" size={18} />
          <div className="grow">This client is archived.</div>
          {isOffice && <Button size="sm" onClick={() => update.mutate({ status: "active" })} loading={update.isPending}>Restore</Button>}
        </div>
      )}

      <div className="two-col">
        <div className="wide stack-lg">
          <section className="stack" aria-labelledby="props-title">
            <div className="section-head">
              <h2 id="props-title" className="section-title">Properties</h2>
              {canSell && <Button size="sm" icon="plus" onClick={() => setProperty({})}>Add property</Button>}
            </div>
            {c.properties.length === 0 ? (
              <div className="card">
                <EmptyState compact icon="pin" title="No service address yet" action={canSell && <Button size="sm" icon="plus" onClick={() => setProperty({})}>Add property</Button>} />
              </div>
            ) : (
              <div className="grid-cards">
                {c.properties.map((p) => {
                  const codes = accessFor(p.id);
                  return (
                    <div key={p.id} className="card card-pad stack-sm">
                      <div className="row-between" style={{ alignItems: "flex-start" }}>
                        <div style={{ minWidth: 0 }}>
                          <strong>{p.label || p.line1}</strong>
                          <MapsLink className="address-link muted text-sm" place={p}>{addressLine(p)}</MapsLink>
                        </div>
                        {canSell && (
                          <Menu
                            triggerClassName="btn btn-sm btn-ghost btn-icon"
                            label="Property actions"
                            items={[
                              { label: "Edit property", icon: "edit", onSelect: () => setProperty({ row: p, access: codes }) },
                              { label: "Measure on the map", icon: "area", onSelect: () => navigate(`/measure?property=${p.id}${p.lat != null ? `&lat=${p.lat}&lng=${p.lng}` : ""}`) },
                              { label: "Remove property", icon: "trash", danger: true, hidden: !isOffice, onSelect: async () => {
                                if (await confirm({ title: "Remove this property?", body: "Requests, quotes and jobs keep their history but lose the address.", confirmLabel: "Remove", danger: true })) removeProperty.mutate(p.id);
                              } },
                            ]}
                          />
                        )}
                      </div>
                      {(codes?.gate_code || codes?.lockbox_code) && (
                        <div className="row wrap text-sm" style={{ gap: 12 }}>
                          {codes.gate_code && <span><Icon name="lock" size={13} /> Gate <strong>{codes.gate_code}</strong></span>}
                          {codes.lockbox_code && <span><Icon name="lock" size={13} /> Lockbox <strong>{codes.lockbox_code}</strong></span>}
                        </div>
                      )}
                      {codes?.instructions && <span className="muted small pre-wrap">{codes.instructions}</span>}
                      {p.notes && <span className="muted small pre-wrap">{p.notes}</span>}
                      <div className="row wrap" style={{ marginTop: 4 }}>
                        <MapsLink className="btn btn-sm" place={p}><Icon name="navigation" size={14} />Directions</MapsLink>
                        {p.lat == null && <span className="muted small" title="Routing and weather checks need a map location">Not on the map yet</span>}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          <section className="stack" aria-label="Work">
            <div className="underline-tabs" role="tablist" aria-label="Work for this client">
              {(["requests", "quotes", "jobs", ...(isOffice ? (["invoices"] as const) : [])] as WorkTab[]).map((t) => (
                <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
                  {t[0].toUpperCase() + t.slice(1)} <span className="badge">{work.isPending ? "·" : counts[t]}</span>
                </button>
              ))}
            </div>
            <div className="card">
              {work.isPending && [0, 1, 2].map((i) => <div key={i} className="card-row"><Skeleton width={40} /><Skeleton width="45%" /><span className="grow" /><Skeleton width={84} height={22} radius={999} /></div>)}
              {work.error && <ErrorState compact error={work.error} onRetry={() => work.refetch()} />}
              {work.data && tab === "requests" && (
                <WorkList empty="No requests yet." rows={work.data.requests.map((r) => ({ to: `/requests/${r.id}`, number: r.number, title: r.title, right: formatDate(r.created_at), status: <EntityStatus kind="request" status={r.status} /> }))} />
              )}
              {work.data && tab === "quotes" && (
                <WorkList empty="No quotes yet." rows={work.data.quotes.map((q) => ({ to: `/quotes/${q.id}`, number: q.number, title: q.title, right: formatMoney(q.total), status: <EntityStatus kind="quote" status={q.status} /> }))} />
              )}
              {work.data && tab === "jobs" && (
                <WorkList empty="No jobs yet." rows={work.data.jobs.map((j) => ({ to: `/jobs/${j.id}`, number: j.number, title: j.title, right: j.kind === "recurring" ? "Recurring" : canSell ? formatMoney(j.financials?.contract_total ?? 0) : "", status: <EntityStatus kind="job" status={j.status} /> }))} />
              )}
              {work.data && tab === "invoices" && (
                <WorkList empty="No invoices yet." rows={work.data.invoices.map((i) => ({ to: `/invoices/${i.id}`, number: i.number, title: i.due_on ? `Due ${formatDate(i.due_on)}` : "Invoice", right: formatMoney(i.balance_due > 0 ? i.balance_due : i.total), status: <EntityStatus kind="invoice" status={i.status} /> }))} />
              )}
            </div>
          </section>

          {c.properties.length > 0 && <PlansCard scope={{ kind: "client", properties: c.properties.map((p) => ({ id: p.id, label: p.label || p.line1 })) }} />}

          <Timeline clientId={c.id} />
        </div>

        <aside className="narrow stack">
          <div className="card card-pad stack-sm">
            <strong>Contact</strong>
            {c.email ? <ContactLine icon="mail" href={`mailto:${c.email}`}>{c.email}</ContactLine> : <span className="muted text-sm">No email</span>}
            {c.phone ? <ContactLine icon="phone" href={`tel:${c.phone}`}>{c.phone}</ContactLine> : <span className="muted text-sm">No phone</span>}
            <dl className="kv" style={{ marginTop: 8 }}>
              <dt>Lead source</dt><dd>{c.lead_source ?? "—"}</dd>
              {referrer && <><dt>Referred by</dt><dd><Link to={`/clients/${referrer.id}`}>{referrer.display_name}</Link></dd></>}
              <dt>Client since</dt><dd>{formatDate(c.created_at)}</dd>
              {billing?.line1 && <><dt>Billing</dt><dd>{addressLine(billing)}</dd></>}
            </dl>
            {c.notes && <p className="muted small pre-wrap" style={{ margin: "6px 0 0" }}>{c.notes}</p>}
          </div>
          {isOffice && (
            <Link to="/invoices" className="card card-pad stat card-link" style={{ display: "block" }}>
              <div className="label">Balance owing</div>
              <div className="value" style={{ color: owed > 0 ? "var(--danger)" : undefined }}>{work.isPending ? <Skeleton width={90} height={24} /> : formatMoney(owed)}</div>
              {writtenOff > 0 && <div className="muted small">{formatMoney(writtenOff)} written off</div>}
            </Link>
          )}
          <ContactsCard clientId={c.id} canEdit={canSell} />
          {isOffice && (
            <div className="card card-pad stack-sm">
              <strong>Marketing</strong>
              <label className="switch-row" style={{ fontWeight: 500 }}>
                <input type="checkbox" className="switch" checked={!c.marketing_opt_out} disabled={update.isPending} onChange={(e) => update.mutate({ marketing_opt_out: !e.target.checked })} />
                Gets marketing emails
              </label>
            </div>
          )}
        </aside>
      </div>

      {dialog === "edit" && <EditClientDialog open onClose={() => setDialog(null)} client={c} />}
      {property && <PropertyDialog clientId={c.id} property={property.row} access={property.access} onClose={() => setProperty(null)} />}
      {dialog === "request" && <NewRequestDialog open onClose={() => setDialog(null)} initialClient={{ id: c.id, display_name: c.display_name }} onCreated={(rid) => navigate(`/requests/${rid}`)} />}
      {dialog === "quote" && <NewQuoteDialog open onClose={() => setDialog(null)} initialClient={{ id: c.id, display_name: c.display_name }} onCreated={(qid) => navigate(`/quotes/${qid}`)} />}
    </>
  );
}

function WorkList({ rows, empty }: { rows: Array<{ to: string; number: number | null; title: string; right: string; status: React.ReactNode }>; empty: string }) {
  if (!rows.length) return <EmptyState compact icon="inbox" title={empty} />;
  return (
    <>
      {rows.map((r) => (
        <Link key={r.to} to={r.to} className="card-row">
          <span className="muted tabular" style={{ width: 48 }}>#{r.number}</span>
          <span className="grow strong ellipsis">{r.title}</span>
          <span className="tabular hide-mobile">{r.right}</span>
          <span style={{ width: 150, display: "flex", justifyContent: "flex-end" }}>{r.status}</span>
        </Link>
      ))}
    </>
  );
}
