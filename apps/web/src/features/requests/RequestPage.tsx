import { ROLE_LABELS, SALES, type Role } from "@crewtavo/core/roles";
import { bookingSpan } from "@crewtavo/core/slots";
import { fieldLabel, fieldRole } from "@crewtavo/core/websiteForms";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ClientPreview } from "@/components/ui/ClientPreview";
import { Button } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { ActionBar, DetailColumns, DetailHeader } from "@/components/ui/DetailPage";
import { Dialog } from "@/components/ui/Dialog";
import { Field, FormChecks, FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { RowPerson } from "@/components/ui/InboxList";
import { MapsLink } from "@/components/ui/MapsLink";
import { Menu, type MenuEntry } from "@/components/ui/Menu";
import { BackLink } from "@/components/ui/PageHeader";
import { Fact, Facts, RelatedList, RelatedRow, Section } from "@/components/ui/Section";
import { DetailSkeleton } from "@/components/ui/Skeleton";
import { EmptyState, PageError } from "@/components/ui/States";
import { EntityStatus, statusLabel } from "@/components/ui/StatusPill";
import { api, supabase, unwrap, unwrapOne } from "@/lib/api";
import { addressLine, formatDateTime, formatDate, formatMoney } from "@/lib/format";
import { useRememberRecent } from "@/lib/recent";
import { can, hasRole, useSession } from "@/lib/session";
import { PropertySelect } from "../clients/ClientForm";
import type { WebVisit } from "../marketing/website";
import { WebVisitFacts } from "../marketing/WebVisitRows";
import { PlansCard } from "../plans/PlansCard";
import { readyDraft } from "../quotes/DraftedCallout";
import { VisitDialog, type VisitInput } from "../schedule/VisitDialog";
import { askedFor, BookAskedTime } from "./AskedTime";
import { memberName, requestSource, SOURCE_ICONS, useTeam } from "./RequestsPage";
import styles from "./RequestPage.module.css";

const DAY = 86_400_000;

/**
 * A request's page (Page-Client / Page-Quote boards): the crumb, the title with the next step as the
 * one green button, a quiet line with its number, status, client and where it came from, then what
 * they asked for, its quotes and assessments on hairlines, and its facts beside them. On a phone the
 * next step is pinned above the tab bar.
 */
export function RequestPage() {
  const { id = "" } = useParams();
  const session = useSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [visit, setVisit] = useState<VisitInput | null>(null);
  const [editing, setEditing] = useState(false);
  const canSell = hasRole(session, "admin", "office", "estimator") && can(session, "sales");
  const timeZone = session.company.timezone;

  const request = useQuery({
    queryKey: ["request", id],
    queryFn: async () =>
      unwrapOne(
        await supabase()
          .from("requests")
          .select("id, number, title, details, status, source, website_form_id, assigned_to, answers, promo_code, rejected_promo_code, promo_problem, web_visit, created_at, asked_starts_at, asked_ends_at, client:clients(id, display_name, email, phone), property:properties(id, line1, city, region, postal_code, lat, lng), form:intake_forms(name, questions), visits(id, title, kind, status, scheduled_on, starts_at, ends_at, crew_id, notes, assignees:visit_assignees(user_id)), quotes(id, number, title, status, total, drafted)")
          .eq("id", id)
          .maybeSingle(),
        "This request",
      ),
  });
  const r = request.data;
  const team = useTeam(session.company.id);
  useRememberRecent(session.company.id, r ? { kind: "request", id: r.id, title: r.title, subtitle: `Request #${r.number} · ${r.client?.display_name ?? ""}`, path: `/requests/${r.id}` } : null);

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["request", id] });
    queryClient.invalidateQueries({ queryKey: ["requests", session.company.id] });
  };
  const toQuote = useMutation({
    meta: { success: "Quote started from this request", tone: "quote" },
    mutationFn: () => api.post<{ id: string }>(`/requests/${id}/quote`),
    onSuccess: (q) => {
      refresh();
      navigate(`/quotes/${q.id}`);
    },
  });
  // A draft filled in from the request (services/quoteDrafts.ts): Claude's when it's on, else from the price list.
  const toDraft = useMutation({
    meta: { success: (d: { by: string; lines?: number }) => (d.lines === 0 ? "Quote started. Nothing on your price list matched, so add the lines yourself." : d.by === "claude" ? "AI drafted the quote. Check it before you send it." : "Quote drafted from your price list"), tone: "quote" },
    mutationFn: () => api.post<{ id: string; by: "claude" | "price_list" }>(`/requests/${id}/draft-quote`),
    onSuccess: (q) => {
      refresh();
      navigate(`/quotes/${q.id}`);
    },
  });
  const toJob = useMutation({
    meta: { success: "Job created", tone: "job" },
    mutationFn: async () => {
      const job = unwrap(
        await supabase().from("jobs").insert({ company_id: session.company.id, client_id: r!.client!.id, property_id: r!.property?.id ?? null, title: r!.title, instructions: r!.details }).select("id").single(),
      );
      unwrap(await supabase().from("requests").update({ status: "converted" }).eq("id", id));
      // The request's plans and files go on the job too (a quote made from it gets them by itself).
      unwrap(await supabase().from("plan_files").update({ job_id: job.id }).eq("request_id", id).is("job_id", null));
      return job.id;
    },
    onSuccess: (jobId) => {
      refresh();
      navigate(`/jobs/${jobId}`);
    },
  });
  const setStatus = useMutation({
    meta: { success: (_: unknown, s: string) => (s === "archived" ? "Request archived" : s === "assessment_complete" ? "Assessment marked done" : "Request reopened"), tone: "request" },
    mutationFn: async (status: "new" | "assessment_complete" | "archived") => unwrap(await supabase().from("requests").update({ status }).eq("id", id)),
    onSuccess: refresh,
  });
  // Who has the lead: set by itself from Settings → Sales areas when it came in, and changed here. They're told.
  const assign = useMutation({
    meta: { success: (_: unknown, userId: string | null) => (userId ? `Assigned to ${memberName(team.data?.find((m) => m.user_id === userId))}` : "Unassigned"), tone: "request" },
    mutationFn: async (userId: string | null) => unwrap(await supabase().from("requests").update({ assigned_to: userId }).eq("id", id)),
    onSuccess: refresh,
  });
  const remove = useMutation({
    meta: { success: "Request deleted", tone: "request" },
    mutationFn: async () => unwrap(await supabase().from("requests").delete().eq("id", id)),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["requests", session.company.id] });
      navigate("/requests", { replace: true });
    },
  });

  if (request.isPending) return <DetailSkeleton />;
  if (request.error || !r) return <PageError error={request.error} onRetry={() => request.refetch()} back={<BackLink to="/requests">Requests</BackLink>} />;

  const now = Date.now();
  // A website form's promo code shows as the Promo code row, so it isn't listed twice (it stays in the answers).
  const promoShown = Boolean(r.website_form_id && (r.promo_code || r.rejected_promo_code));
  const answers = Object.entries((r.answers ?? {}) as Record<string, unknown>).filter(
    ([key, v]) => v !== "" && v != null && !(Array.isArray(v) && !v.length) && !(promoShown && fieldRole(key) === "promo"),
  );
  const questions = ((r.form?.questions ?? []) as Array<{ key: string; label: string }>).reduce<Record<string, string>>((m, q) => ({ ...m, [q.key]: q.label }), {});
  const open = !["converted", "archived"].includes(r.status);
  const archived = r.status === "archived";
  // A quote drafted by itself as this came in (Settings → Company): the request is still as it arrived, so this says it's there.
  const drafted = readyDraft(r.quotes);
  const quotes = [...r.quotes].sort((a, b) => Number(b.number) - Number(a.number));
  // A time picked on a booking form that needs the office's OK: held for them until it's answered.
  const asked = askedFor(r, timeZone);
  const askPending = Boolean(asked) && !r.visits.some((v) => v.kind === "assessment" && v.status !== "cancelled");
  // Booking that time is the next step while it can still be booked; then the quote, once there is one; else starting one.
  const bookFirst = askPending && canSell && Date.parse(r.asked_starts_at!) > now;
  const openQuote = quotes.length > 0 && !bookFirst ? quotes[0] : null;
  const waitingDays = r.status === "new" && now - Date.parse(r.created_at) > 2 * DAY ? Math.floor((now - Date.parse(r.created_at)) / DAY) : 0;
  const salesperson = memberName(team.data?.find((m) => m.user_id === r.assigned_to));
  // The request's salesperson goes out, unless someone picks another.
  const assessment = (): VisitInput => ({ request_id: r.id, property_id: r.property?.id ?? null, title: `Assessment: ${r.title}`, kind: "assessment", assignee_ids: r.assigned_to ? [r.assigned_to] : [], context: { label: `Request #${r.number} · ${r.client?.display_name ?? ""}`, to: `/requests/${r.id}` } });
  const visitWhen = (v: (typeof r.visits)[number]) => (v.starts_at ? bookingSpan(v.starts_at, v.ends_at, timeZone) : v.scheduled_on ? `${formatDate(v.scheduled_on)} · anytime` : "Not scheduled");
  const visitPeople = (v: (typeof r.visits)[number]) => v.assignees.map((a) => memberName(team.data?.find((m) => m.user_id === a.user_id))).filter(Boolean).join(", ");

  // Whoever can sell, and whoever has it now (even off the team since), with a face and their role.
  const assignItems: MenuEntry[] = [
    { label: "Nobody yet", lead: <span aria-hidden="true"><RowPerson name={null} /></span>, checked: !r.assigned_to, onSelect: () => r.assigned_to && assign.mutate(null) },
    { separator: true },
    ...(team.data ?? [])
      .filter((m) => (m.active && SALES.includes(m.role as Role)) || m.user_id === r.assigned_to)
      .map((m) => ({
        label: memberName(m)!,
        lead: <span aria-hidden="true"><RowPerson name={memberName(m)} /></span>,
        end: m.user_id === session.userId ? "You" : !m.active ? "Left the team" : (ROLE_LABELS[m.role as Role] ?? undefined),
        checked: m.user_id === r.assigned_to,
        onSelect: () => m.user_id !== r.assigned_to && assign.mutate(m.user_id),
      })),
  ];

  const more: MenuEntry[] = [
    { label: "Edit request", icon: "edit", kbd: "E", onSelect: () => setEditing(true) },
    { label: "Assign to", icon: "user", kbd: "A", items: assignItems, disabled: team.isPending },
    { label: "Measure on the map", icon: "area", kbd: "M", hidden: !r.property, onSelect: () => navigate(`/measure?request=${r.id}&property=${r.property!.id}${r.property!.lat != null ? `&lat=${r.property!.lat}&lng=${r.property!.lng}` : ""}`) },
    // Once it has a quote, opening that is the green button, and another quote is only an option.
    { label: "Create another quote", icon: "quote", hidden: !open || !openQuote, onSelect: () => toQuote.mutate() },
    { label: "Convert straight to a job", icon: "job", hidden: !open, onSelect: () => toJob.mutate() },
    { separator: true },
    { label: archived ? "Reopen request" : "Archive request", icon: archived ? "undo" : "archive", onSelect: () => setStatus.mutate(archived ? "new" : "archived") },
    {
      label: "Delete request",
      icon: "trash",
      danger: true,
      hidden: r.quotes.length > 0,
      onSelect: async () => {
        if (await confirm({ title: "Delete this request?", body: "Its assessments are deleted too. This can't be undone.", confirmLabel: "Delete", danger: true })) remove.mutate();
      },
    },
  ];

  // The quote action, in the header on a desktop and pinned above the tab bar on a phone.
  const quoteButton = (hide?: string) =>
    openQuote ? (
      <Link className={`btn btn-primary ${hide ?? ""}`} to={`/quotes/${openQuote.id}`}><Icon name="quote" size={16} />Open quote #{openQuote.number}</Link>
    ) : (
      <Button className={hide} variant={bookFirst ? "secondary" : "primary"} icon="quote" loading={toQuote.isPending} disabled={toDraft.isPending} onClick={() => toQuote.mutate()}>Create quote</Button>
    );

  const salesPicker = canSell ? (
    <Menu
      items={assignItems}
      label={`Salesperson: ${salesperson ?? "Nobody yet"}. Change`}
      title="Salesperson"
      align="start"
      triggerClassName={styles.picker}
      trigger={
        <>
          <RowPerson name={salesperson} empty="Nobody yet" />
          <span className={salesperson ? undefined : styles.nobody}>{salesperson ?? "Nobody yet"}</span>
          <Icon name="chevronDown" size={14} />
        </>
      }
    />
  ) : (
    <span className={styles.person}><RowPerson name={salesperson} empty="Nobody yet" />{salesperson ?? "Nobody yet"}</span>
  );

  return (
    <>
      <DetailHeader
        crumb={{ to: "/requests", label: "Requests" }}
        title={r.title}
        meta={[
          `Request #${r.number}`,
          // A new one is on its way, nobody's late yet: an amber dot and plain words. Waiting too long is the amber words.
          <EntityStatus kind="request" status={r.status} />,
          waitingDays > 0 && <span className={styles.waiting}><Icon name="clock" size={13} />Waiting {waitingDays} days</span>,
          r.client && <ClientPreview id={r.client.id}><Link to={`/clients/${r.client.id}`} className={styles.client}>{r.client.display_name}</Link></ClientPreview>,
          <span className={styles.source}><Icon name={(r.website_form_id ? "globe" : SOURCE_ICONS[r.source]) ?? "globe"} size={13} />{requestSource(r)}</span>,
        ]}
        actions={
          canSell && open && (
            <>
              <Button icon="sparkle" loading={toDraft.isPending} disabled={toQuote.isPending} onClick={() => toDraft.mutate()}>Draft a quote</Button>
              <Button className="hide-mobile" icon="calendar" onClick={() => setVisit(assessment())}>Schedule assessment</Button>
              {quoteButton("hide-mobile")}
            </>
          )
        }
        more={canSell ? more : undefined}
        moreTitle={r.title}
      />

      <DetailColumns
        grouped
        side={
          <Section title="Details">
            <Facts className={styles.facts}>
              <Fact label="Email">{r.client?.email && <a href={`mailto:${r.client.email}`}>{r.client.email}</a>}</Fact>
              <Fact label="Phone">{r.client?.phone && <a href={`tel:${r.client.phone}`}>{r.client.phone}</a>}</Fact>
              <Fact label="Property">{r.property && <MapsLink place={r.property} className={styles.address}>{addressLine(r.property)}</MapsLink>}</Fact>
              <Fact label="Salesperson">{salesPicker}</Fact>
              <Fact label="Received">{formatDateTime(r.created_at)}{r.form ? ` via ${r.form.name}` : ""}</Fact>
              <Fact label="Promo code">
                {r.promo_code ? (
                  <span className={styles.code}>{r.promo_code}</span>
                ) : (
                  r.rejected_promo_code && (
                    <>
                      <span className={`${styles.code} ${styles.rejected}`}>{r.rejected_promo_code}</span>
                      <span className={styles.why}>Not applied: {r.promo_problem ?? "That code isn't valid."}</span>
                    </>
                  )
                )}
              </Fact>
              {r.web_visit && <WebVisitFacts visit={r.web_visit as unknown as WebVisit} />}
            </Facts>
          </Section>
        }
      >
        {askPending && (
          <div className="callout callout-info">
            <Icon name="calendar" size={16} />
            <div className="grow">
              <div>Asked for {asked}</div>
              {r.client?.display_name ?? "The client"} picked this time online and was told it isn't confirmed yet. Book it, or schedule the assessment for another time.
            </div>
            {/* On a phone it's the pinned bar's green button instead. */}
            {canSell && <BookAskedTime request={r} size="sm" className={bookFirst ? "hide-mobile" : undefined} onBooked={refresh} />}
          </div>
        )}

        {drafted && (
          <div className="callout callout-info">
            <Icon name="sparkle" size={16} />
            <div className="grow">
              <div>A draft quote is ready</div>
              Quote #{drafted.quote.number} was drafted {drafted.by === "claude" ? "by AI" : "from your price list"} when this request came in.{drafted.by === "claude" ? " It can be wrong: check it before you send it." : ""} Nothing has been sent, and the request is as it arrived until you send the quote.
            </div>
            {/* Unless it's what the page's green button opens already. */}
            {!(canSell && open && openQuote?.id === drafted.quote.id) && <Link to={`/quotes/${drafted.quote.id}`} className="btn">Open the draft</Link>}
          </div>
        )}

        {archived && (
          <div className={`callout ${styles.oneLine}`}>
            <Icon name="archive" size={16} />
            <div className="grow">This request is archived.</div>
            {canSell && <Button size="sm" icon="undo" loading={setStatus.isPending} onClick={() => setStatus.mutate("new")}>Reopen request</Button>}
          </div>
        )}

        <Section title="What they asked for" action={canSell && (r.details || answers.length > 0) && <button type="button" onClick={() => setEditing(true)}>Edit</button>}>
          {!r.details && !answers.length ? (
            <EmptyState inline title="No details given" action={canSell && <Button size="sm" icon="edit" onClick={() => setEditing(true)}>Add details</Button>} />
          ) : (
            <>
              {r.details && <p className={styles.details}>{r.details}</p>}
              {answers.length > 0 && (
                <Facts label="Their answers">
                  {answers.map(([key, value]) => (
                    // A website form's answers are under its own field names (Apps → Website Forms).
                    <Fact key={key} label={questions[key] ?? (r.website_form_id ? fieldLabel(key) : statusLabel(key))}>
                      {Array.isArray(value) ? value.join(", ") : typeof value === "boolean" ? (value ? "Yes" : "No") : String(value)}
                    </Fact>
                  ))}
                </Facts>
              )}
            </>
          )}
        </Section>

        {quotes.length > 0 && (
          <Section title="Quotes" count={quotes.length}>
            <RelatedList label="Quotes">
              {quotes.map((q) => (
                <RelatedRow key={q.id} to={`/quotes/${q.id}`} lead={`#${q.number}`} title={q.title} sub={<EntityStatus kind="quote" status={q.status} />} end={<b>{formatMoney(q.total)}</b>} />
              ))}
            </RelatedList>
          </Section>
        )}

        {/* A closed request with none has nothing to say here. */}
        {(open || r.visits.length > 0) && (
          <Section
            title="Assessments"
            count={r.visits.length || undefined}
            action={
              canSell &&
              (r.status === "assessment_scheduled" ? (
                <button type="button" disabled={setStatus.isPending} onClick={() => setStatus.mutate("assessment_complete")}><Icon name="check" size={14} />Mark assessment done</button>
              ) : (
                open && r.visits.length > 0 && <button type="button" onClick={() => setVisit(assessment())}><Icon name="plus" size={14} />Schedule</button>
              ))
            }
          >
            {r.visits.length === 0 ? (
              <EmptyState inline title="No assessments yet" action={canSell && open && <Button size="sm" icon="calendar" onClick={() => setVisit(assessment())}>Schedule assessment</Button>} />
            ) : (
              <RelatedList label="Assessments">
                {r.visits.map((v) => (
                  <RelatedRow
                    key={v.id}
                    lead={<span className="rel-icon"><Icon name="calendar" size={15} /></span>}
                    title={visitWhen(v)}
                    sub={[<EntityStatus kind="visit" status={v.status} />, visitPeople(v), v.notes]}
                    onClick={canSell ? () => setVisit({ ...v, request_id: r.id, property_id: r.property?.id ?? null, assignee_ids: v.assignees.map((a) => a.user_id) }) : undefined}
                  />
                ))}
              </RelatedList>
            )}
          </Section>
        )}

        <PlansCard scope={{ kind: "request", id: r.id, propertyId: r.property?.id ?? null }} />
      </DetailColumns>

      {canSell && open && (
        <ActionBar>
          {bookFirst ? (
            // Booking the time they asked for comes first; another time is under Assessments.
            <>
              {quoteButton()}
              <BookAskedTime request={r} onBooked={refresh} />
            </>
          ) : (
            <>
              {/* Room for one short word beside the green button; its name stays the whole action. */}
              <Button icon="calendar" aria-label="Schedule assessment" onClick={() => setVisit(assessment())}>Assessment</Button>
              {quoteButton()}
            </>
          )}
        </ActionBar>
      )}

      {visit && <VisitDialog visit={visit} onClose={() => setVisit(null)} onSaved={refresh} />}
      {editing && <EditRequestDialog request={{ id: r.id, title: r.title, details: r.details, client_id: r.client?.id ?? null, property_id: r.property?.id ?? null }} onClose={() => setEditing(false)} onSaved={refresh} />}
    </>
  );
}

function EditRequestDialog({ request, onClose, onSaved }: { request: { id: string; title: string; details: string | null; client_id: string | null; property_id: string | null }; onClose: () => void; onSaved: () => void }) {
  const [title, setTitle] = useState(request.title);
  const [details, setDetails] = useState(request.details ?? "");
  const [propertyId, setPropertyId] = useState<string | null>(request.property_id);
  const save = useMutation({
    meta: { inline: true, success: "Request saved", tone: "request" },
    mutationFn: async () => unwrap(await supabase().from("requests").update({ title: title.trim(), details: details.trim() || null, property_id: propertyId }).eq("id", request.id)),
    onSuccess: () => {
      onSaved();
      onClose();
    },
  });
  return (
    <Dialog open onClose={onClose} title="Edit request">
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); if (title.trim()) save.mutate(); }}>
        <Field label="Title" requiredMessage="Say what they need, like a driveway estimate."><input className="input" value={title} onChange={(e) => setTitle(e.target.value.trimStart())} required maxLength={200} /></Field>
        {request.client_id && <Field label="Property"><PropertySelect clientId={request.client_id} value={propertyId} onChange={setPropertyId} /></Field>}
        <Field label="Details" optional><textarea className="textarea" value={details} onChange={(e) => setDetails(e.target.value)} maxLength={4000} /></Field>
        <FormError error={save.error} />
        <div className="form-actions">
          <FormChecks />
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending}>Save</Button>
        </div>
      </form>
    </Dialog>
  );
}
