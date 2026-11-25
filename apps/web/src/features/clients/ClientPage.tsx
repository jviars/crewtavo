import { autopaySettings } from "@crewtavo/core/autopay";
import { shownCustomFields } from "@crewtavo/core/customFields";
import { creditMoney, marketingOn, reachOf, referralsReady, RESUBSCRIBE_HINT, textConsentLine, textsOff, type AskChannel } from "@crewtavo/core/marketing";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { initials } from "@/components/ui/Avatar";
import { ActionBar, DetailColumns, DetailHeader } from "@/components/ui/DetailPage";
import { Icon } from "@/components/ui/Icon";
import { MetaLine } from "@/components/ui/InboxList";
import { MapsLink } from "@/components/ui/MapsLink";
import { Menu, type MenuEntry } from "@/components/ui/Menu";
import { BackLink } from "@/components/ui/PageHeader";
import { Fact, Facts, RelatedList, RelatedRow, Section } from "@/components/ui/Section";
import { DetailSkeleton, Skeleton } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState, PageError } from "@/components/ui/States";
import { EntityStatus, statusText } from "@/components/ui/StatusPill";
import { api, supabase, unwrap, unwrapOne } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { addressLine, companyCountry, formatDate, formatMoney } from "@/lib/format";
import { useRememberRecent } from "@/lib/recent";
import { can, hasRole, useSession } from "@/lib/session";
import { ClientShowcaseChip, ClientShowcaseNote } from "../marketing/ClientShowcases";
import { toast } from "@/lib/toast";
import { undoable } from "@/lib/undo";
import { PlansCard } from "../plans/PlansCard";
import { NewQuoteDialog } from "../quotes/NewQuoteDialog";
import { listPrice, withOptionLines } from "../quotes/options";
import { NewRequestDialog } from "../requests/NewRequestDialog";
import { AutopayCard, useAutopayInvite } from "./AutopayCard";
import { EditClientDialog } from "./ClientForm";
import styles from "./clients.module.css";
import { AddContact, ContactsCard, useClientContacts } from "./ContactsCard";
import { PropertyDialog, type AccessRow, type PropertyRow } from "./PropertyDialog";
import { PropertyEquipment } from "./PropertyEquipment";
import { RESET_LINKS_BODY, RESET_LINKS_LABEL, RESET_LINKS_NOTE, resetLinksPath } from "./resetLinks";
import { askedNot, sendWay } from "./sendWays";
import { MergeClientsDialog } from "./MergeClientsDialog";
import { TextsSwitch, useTextStops } from "./TextsSwitch";
import { Timeline } from "./Timeline";
import { lastWhen, nextWhen, useClientVisits, visitLink } from "@/lib/clientVisits";
import { PhotosCard } from "../files/PhotosCard";
import { socialKey } from "../marketing/socialData";
import { askToastKind, type AskResult } from "../marketing/askForm";
import { CustomFieldFacts, useCustomFields } from "../customFields/CustomFields";

type WorkTab = "requests" | "quotes" | "jobs" | "invoices";
const WORK_LABELS: Record<WorkTab, string> = { requests: "Requests", quotes: "Quotes", jobs: "Jobs", invoices: "Invoices" };
type ClientPatch = { status?: "lead" | "active" | "archived"; marketing_opt_out?: boolean; review_opt_out?: boolean; social_photos_opt_out?: boolean };
/** The client's switches, which move the moment they're flipped. */
const SWITCHES = ["marketing_opt_out", "review_opt_out", "social_photos_opt_out"] as const;

export function ClientPage() {
  const { id = "" } = useParams();
  const session = useSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  // Null until someone picks a tab: until then it opens on the first kind of work the client has.
  const [picked, setPicked] = useState<WorkTab | null>(null);
  const workRef = useRef<HTMLDivElement>(null);
  const [dialog, setDialog] = useState<null | "edit" | "request" | "quote" | "merge">(null);
  const [property, setProperty] = useState<{ row?: PropertyRow; access?: AccessRow | null } | null>(null);
  // The property whose Add equipment was picked from its menu.
  const [equipmentFor, setEquipmentFor] = useState<string | null>(null);
  const isOffice = hasRole(session, "admin", "office");
  const canSell = hasRole(session, "admin", "office", "estimator") && can(session, "sales");
  // Autopay is for the people who look after money, and only once the company has it on.
  const seesMoney = isOffice && can(session, "invoices");
  const autopayOn = autopaySettings(session.company.settings, session.company.trade_preset).enabled;
  const contacts = useClientContacts(id);
  const visits = useClientVisits(id);
  const clientFields = useCustomFields("client");
  const propertyFields = useCustomFields("property");
  const autopayInvite = useAutopayInvite(id);

  const client = useQuery({
    queryKey: ["client", id],
    queryFn: async () =>
      unwrapOne(
        await supabase()
          .from("clients")
          .select("id, display_name, company_name, email, phone, status, tags, lead_source, notes, created_at, billing_address, marketing_opt_out, review_opt_out, social_photos_opt_out, sms_opt_out_at, reviewed_at, sms_consent_at, sms_consent_source, referred_by, custom_fields, tax_exempt, tax_exempt_note, payment_terms_days, properties(id, label, line1, line2, city, region, postal_code, lat, lng, notes, tags, lot_size_sqft, custom_fields)")
          .eq("id", id)
          .maybeSingle(),
        "This client",
      ),
  });
  const c = client.data;
  // Whether their number is on the stop list, and why, for the office's Texts switch.
  const stopFor = useTextStops([c?.phone], isOffice);
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
        // Priced as the quotes list prices them (listPrice): one offering options starts from its cheapest.
        db.from("quotes").select("id, number, title, status, total, tax_rate, discount_amount, promo:promo_codes(kind, value), updated_at, options:quote_options!quote_options_quote_fkey(id)").eq("client_id", id).order("created_at", { ascending: false }),
        db.from("jobs").select("id, number, title, status, kind, financials:job_financials(contract_total)").eq("client_id", id).order("created_at", { ascending: false }),
        isOffice ? db.from("invoices").select("id, number, status, total, balance_due, due_on").eq("client_id", id).order("created_at", { ascending: false }) : Promise.resolve({ data: [], error: null }),
      ]);
      return { requests: unwrap(requests), quotes: await withOptionLines(unwrap(quotes)), jobs: unwrap(jobs), invoices: unwrap(invoices) as Array<{ id: string; number: number | null; status: string; total: number; balance_due: number; due_on: string | null }> };
    },
  });

  const update = useMutation({
    // The switches show their own change, so only archiving and restoring say so.
    meta: { success: (_: unknown, patch: ClientPatch) => (patch.status === "archived" ? "Client archived" : patch.status ? "Client restored" : null) },
    mutationFn: async (patch: ClientPatch) => unwrap(await supabase().from("clients").update(patch).eq("id", id)),
    // A switch moves the moment it's flipped, and back if the save fails.
    onMutate: async (patch) => {
      const key = SWITCHES.find((k) => patch[k] !== undefined);
      if (!key) return;
      await queryClient.cancelQueries({ queryKey: ["client", id], exact: true });
      queryClient.setQueryData<typeof client.data>(["client", id], (old) => old && { ...old, [key]: Boolean(patch[key]) });
    },
    onError: (_error, patch) => {
      const key = SWITCHES.find((k) => patch[k] !== undefined);
      if (key) queryClient.setQueryData<typeof client.data>(["client", id], (old) => old && { ...old, [key]: !patch[key] });
    },
    onSettled: (_data, _error, patch) => {
      queryClient.invalidateQueries({ queryKey: ["client", id] });
      queryClient.invalidateQueries({ queryKey: ["clients", session.company.id] });
      // The Photos card below and the composer offer this client's photos, or don't.
      if (patch.social_photos_opt_out !== undefined) {
        queryClient.invalidateQueries({ queryKey: ["record-photos", session.company.id] });
        queryClient.invalidateQueries({ queryKey: socialKey(session.company.id) });
        // Their showcases come down when photos are turned off (the database does it), so read them again.
        queryClient.invalidateQueries({ queryKey: ["client-showcases", id] });
        queryClient.invalidateQueries({ queryKey: ["showcases", session.company.id] });
      }
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
    // Undo's toast says how it went (removeLater below).
    meta: { inline: true },
    mutationFn: async (propertyId: string) => unwrap(await supabase().from("properties").delete().eq("id", propertyId)),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["client", id] }),
  });
  const hubLink = useMutation({
    mutationFn: () => api.get<{ link: string }>(`/clients/${id}/hub-link`),
    onSuccess: (r) => copyText(r.link, "Client Hub link copied"),
  });
  const resetLinks = useMutation({
    meta: { success: "Links reset" },
    mutationFn: () => api.post<{ reset_at: string }>(resetLinksPath(id)),
    // The reset is noted on their timeline.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["client", id, "messages"] }),
  });
  const referralLink = useMutation({
    mutationFn: () => api.get<{ link: string }>(`/referrals/link/${id}`),
    onSuccess: (r) => copyText(r.link, "Referral link copied"),
  });
  const referralAsk = useMutation({
    mutationFn: () => api.post<{ sent: boolean; detail: string }>("/referrals/request", { client_id: id }),
    onSuccess: (r) => toast.success(r.detail),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["referral-asks", session.company.id] });
      queryClient.invalidateQueries({ queryKey: ["referral-ask", id] });
    },
  });
  // Credits they've earned and that aren't on an invoice yet: shown whether Marketing is installed
  // or not, since they still go on their invoices.
  const credits = useQuery({
    queryKey: ["referral-credits-for", id],
    enabled: isOffice && can(session, "invoices"),
    meta: { silent: true },
    queryFn: async () => unwrap(await supabase().rpc("referral_credits_for", { p_company: session.company.id, p_client: id })),
  });
  const review = useMutation({
    mutationFn: (channel: AskChannel) => api.post<AskResult>("/reviews/request", { client_id: id, channel }),
    onSuccess: (r) => toast[askToastKind(r)](r.detail),
    // Marketing → Reviews lists the ask, failed or not, and "Ask a client now" says when they were last asked.
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["review-requests", session.company.id] });
      queryClient.invalidateQueries({ queryKey: ["review-ask", id] });
    },
  });
  // Review asks and referrals are Marketing's: while it's uninstalled they aren't offered here.
  const marketing = marketingOn(session.company.settings);
  // Where asking them stands, for the menu's Ask for a review and Referrals: when they were last asked, and how many friends they've referred.
  const lastAsk = useQuery({
    queryKey: ["review-ask", id, "last"],
    enabled: marketing && canSell,
    meta: { silent: true },
    queryFn: async () => unwrap(await supabase().rpc("last_review_ask", { p_company: session.company.id, p_client: id })) ?? null,
  });
  const referred = useQuery({
    queryKey: ["referrals", session.company.id, "from", id],
    enabled: marketing && canSell,
    meta: { silent: true },
    queryFn: async () => (await supabase().from("referrals").select("id", { count: "exact", head: true }).eq("company_id", session.company.id).eq("referrer_client_id", id)).count ?? 0,
  });

  if (client.isPending) return <DetailSkeleton />;
  if (client.error || !c) return <PageError error={client.error} onRetry={() => client.refetch()} back={<BackLink to="/clients">Clients</BackLink>} />;

  const unpaid = work.data?.invoices.filter((i) => ["sent", "partially_paid", "overdue"].includes(i.status)) ?? [];
  const stopped = textsOff(c) || Boolean(stopFor(c.phone));
  // The review asks offered are the ones that can go: not to a client who opted out or is archived,
  // nor by a way this Crewtavo can't send or the client can't get.
  const ready = { email: session.config.features.email, sms: session.config.features.sms };
  // Texts are off when they asked, and when their number texted STOP.
  const reach = { ...reachOf(c, ready), textsOff: stopped };
  const reviewWay = (way: AskChannel) => sendWay(c, reach, way, askedNot(c));
  const owed = unpaid.reduce((sum, i) => sum + Number(i.balance_due), 0);
  const pastDue = unpaid.reduce((sum, i) => sum + (i.status === "overdue" ? Number(i.balance_due) : 0), 0);
  // Never paid, and taken as a loss: worth knowing before taking on more work for them.
  const writtenOff = work.data?.invoices.reduce((sum, i) => sum + (i.status === "written_off" ? Number(i.balance_due) : 0), 0) ?? 0;
  const counts = { requests: work.data?.requests.length ?? 0, quotes: work.data?.quotes.length ?? 0, jobs: work.data?.jobs.length ?? 0, invoices: work.data?.invoices.length ?? 0 };
  const hasWork = counts.quotes + counts.jobs + counts.invoices > 0;
  const tabs: WorkTab[] = ["requests", "quotes", "jobs", ...(isOffice ? (["invoices"] as const) : [])];
  // In the order work happens. While it loads none is chosen, so the underline doesn't slide over on arrival.
  const tab = picked ?? (work.data ? tabs.find((t) => counts[t] > 0) : undefined);
  const noWork = Boolean(work.data) && tabs.every((t) => counts[t] === 0);
  const accessFor = (pid: string) => access.data?.find((a) => a.property_id === pid) ?? null;
  const billing = c.billing_address as { line1?: string; city?: string; region?: string; postal_code?: string } | null;
  const firstPlace = c.properties.find((p) => p.line1.trim());

  const deleteClient = async () => {
    if (hasWork) {
      if (await confirm({ title: `Archive ${c.display_name} instead?`, body: "This client has quotes, jobs or invoices, so deleting would erase that history. Archiving hides them from lists and keeps the records.", confirmLabel: "Archive client" })) update.mutate({ status: "archived" });
      return;
    }
    if (await confirm({ title: `Delete ${c.display_name}?`, body: "Their properties, requests, notes and contacts are deleted too. This can't be undone.", confirmLabel: "Delete client", danger: true })) remove.mutate();
  };

  /** For a link that went to someone it shouldn't have: the links already out stop, and new ones work. */
  const resetClientLinks = async () => {
    if (await confirm({ title: `Reset ${c.display_name}'s links?`, body: RESET_LINKS_BODY, confirmLabel: "Reset links", danger: true })) resetLinks.mutate();
  };

  /** Takes the property off the page at once; it's deleted when the Undo toast leaves. */
  const removeLater = (p: (typeof c.properties)[number]) => {
    const key = ["client", id];
    let at = -1;
    undoable({
      title: "Property removed",
      description: "Its requests, quotes and jobs keep their history.",
      hide: () => {
        void queryClient.cancelQueries({ queryKey: key, exact: true });
        queryClient.setQueryData<typeof client.data>(key, (old) => {
          if (!old) return old;
          at = old.properties.findIndex((x) => x.id === p.id);
          return { ...old, properties: old.properties.filter((x) => x.id !== p.id) };
        });
      },
      restore: () =>
        queryClient.setQueryData<typeof client.data>(key, (old) => {
          if (!old || old.properties.some((x) => x.id === p.id)) return old;
          const properties = [...old.properties];
          properties.splice(at < 0 ? properties.length : Math.min(at, properties.length), 0, p);
          return { ...old, properties };
        }),
      commit: () => removeProperty.mutateAsync(p.id),
    });
  };

  // The balance opens this client's invoices just below: the invoices list has no filter for one client.
  const showInvoices = () => {
    setPicked("invoices");
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    workRef.current?.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
    document.getElementById("work-tab-invoices")?.focus({ preventScroll: true });
  };

  // Everything else they can do, grouped (ClientMenu.dc.html): the record, then asking them for things, then
  // the ones that can't be taken back lightly (archiving, merging, resetting their links, deleting). Each way
  // to send says where it goes, or why it can't, and the sub menus say where asking stands.
  const more: MenuEntry[] = [
    { label: "Edit client", icon: "edit", kbd: "E", onSelect: () => setDialog("edit") },
    { label: "Copy Client Hub link", icon: "link", onSelect: () => hubLink.mutate() },
    { separator: true },
    // A client who already left a Google review isn't asked again: the one line says so.
    { label: "Already left a Google review", icon: "star", onSelect: () => undefined, disabled: true, hidden: !marketing || !c.reviewed_at },
    {
      label: "Ask for a review", icon: "star", hidden: !marketing || Boolean(c.reviewed_at),
      end: lastAsk.data === undefined ? undefined : lastAsk.data ? `Asked ${formatDate(lastAsk.data)}` : "Not asked yet",
      items: [
        { label: "By email", icon: "mail", onSelect: () => review.mutate("email"), ...reviewWay("email") },
        { label: "By text", icon: "messages", onSelect: () => review.mutate("sms"), ...reviewWay("sms") },
        { label: "By text and email", icon: "send", onSelect: () => review.mutate("both"), ...reviewWay("both") },
      ],
    },
    {
      label: "Referrals", icon: "gift", hidden: !marketing,
      end: referred.data ? `${referred.data} referred` : undefined,
      items: [
        {
          label: "Ask for referrals by email", icon: "mail", onSelect: () => referralAsk.mutate(),
          ...sendWay(c, reach, "email", referralsReady(session.company.settings) ? askedNot({ marketing_opt_out: c.marketing_opt_out, status: c.status }) : "Add a credit or an offer first"),
        },
        { label: "Copy referral link", icon: "link", onSelect: () => referralLink.mutate() },
      ],
    },
    {
      label: "Send autopay invite", icon: "card", hidden: !seesMoney || !autopayOn,
      items: [
        { label: "By email", icon: "mail", onSelect: () => autopayInvite.mutate("email"), ...sendWay(c, reach, "email"), hidden: !session.config.features.email },
        { label: "By text", icon: "messages", onSelect: () => autopayInvite.mutate("sms"), ...sendWay(c, reach, "sms"), hidden: !session.config.features.sms },
      ],
    },
    { separator: true, hidden: !isOffice },
    { label: c.status === "archived" ? "Restore client" : "Archive client", icon: c.status === "archived" ? "undo" : "archive", onSelect: () => update.mutate({ status: c.status === "archived" ? "active" : "archived" }), hidden: !isOffice },
    { label: "Merge into another client", icon: "users", onSelect: () => setDialog("merge"), hidden: !seesMoney },
    { label: RESET_LINKS_LABEL, description: RESET_LINKS_NOTE, icon: "refresh", onSelect: resetClientLinks, hidden: !isOffice },
    { label: "Delete client", icon: "trash", danger: true, onSelect: deleteClient, hidden: !isOffice },
  ];

  // Quick ways to reach them on a phone, under the title (Mobile-Work.dc.html).
  const quick = [
    c.phone && <a key="call" href={`tel:${c.phone}`}><Icon name="phone" size={21} />Call</a>,
    c.phone && !stopped && <a key="text" href={`sms:${c.phone}`}><Icon name="messages" size={21} />Text</a>,
    c.email && <a key="email" href={`mailto:${c.email}`}><Icon name="mail" size={21} />Email</a>,
    firstPlace && <MapsLink key="map" className="" place={firstPlace}><Icon name="navigation" size={21} />Directions</MapsLink>,
  ].filter(Boolean);

  const details = (
    <Section title="Details" action={canSell && <button type="button" onClick={() => setDialog("edit")}>Edit</button>}>
      <Facts className={styles.details}>
        <Fact label="Email">{c.email && <a href={`mailto:${c.email}`}>{c.email}</a>}</Fact>
        <Fact label="Phone">{c.phone && <a href={`tel:${c.phone}`}>{c.phone}</a>}</Fact>
        {isOffice && c.phone ? (
          <Fact label="Texts">
            <TextsSwitch clientId={c.id} name={c.display_name} phone={c.phone} stop={stopFor(c.phone)} since={c.sms_opt_out_at} />
            {/* Where their number came from: the record of their say-so to be texted. */}
            {!stopped && <span className={styles.hint}>{textConsentLine(c.sms_consent_source, c.sms_consent_at ? formatDate(c.sms_consent_at) : null)}</span>}
          </Fact>
        ) : c.sms_opt_out_at ? (
          <Fact label="Texts">Off since {formatDate(c.sms_opt_out_at)}. They asked not to be texted.</Fact>
        ) : null}
        {/* For "when are you coming?" on the phone: the day as a link to its job, what it is under it. */}
        <Fact label="Next visit">{visits.data?.next && <><Link to={visitLink(visits.data.next)}>{nextWhen(visits.data.next, session.company.timezone)}</Link><span className={styles.hint}>{visits.data.next.title}</span></>}</Fact>
        <Fact label="Last visit">{visits.data?.last && <><Link to={visitLink(visits.data.last)}>{lastWhen(visits.data.last, session.company.timezone)}</Link><span className={styles.hint}>{visits.data.last.title}</span></>}</Fact>
        <Fact label="Balance">
          {owed > 0 && (
            <>
              <button type="button" className={`link-btn ${styles.balance} ${styles.tap}`} onClick={showInvoices}>{formatMoney(owed)}</button>
              {pastDue > 0 && <span className={styles.pastDue}>{pastDue < owed ? ` · ${formatMoney(pastDue)} ${statusText("invoice", "overdue").toLowerCase()}` : ` · ${statusText("invoice", "overdue")}`}</span>}
            </>
          )}
        </Fact>
        <Fact label="Written off">{writtenOff > 0 && <span className="tabular">{formatMoney(writtenOff)}</span>}</Fact>
        <Fact label="Lead source">{c.lead_source}</Fact>
        <CustomFieldFacts fields={clientFields} values={c.custom_fields} />
        <Fact label="Referred by">{referrer && <Link to={`/clients/${referrer.id}`}>{referrer.display_name}</Link>}</Fact>
        <Fact label="Referral credit">
          {credits.data?.some((r) => Number(r.credit_left) > 0) && credits.data.filter((r) => Number(r.credit_left) > 0).map((r) => (
            <span key={r.referral_id} className={styles.line}>
              {creditMoney(Number(r.credit_left), session.company.currency)} for referring {r.friend_name}. {r.auto_apply ? "Goes on their next invoice." : "Kept off invoices."}
            </span>
          ))}
        </Fact>
        <Fact label="Client since">{formatDate(c.created_at)}</Fact>
        <Fact label="Billing">{billing?.line1 && addressLine(billing)}</Fact>
        <Fact label="Payment terms">{c.payment_terms_days != null && (c.payment_terms_days === 0 ? "Due on receipt" : `Due in ${c.payment_terms_days} days`)}</Fact>
        <Fact label="Tax">{c.tax_exempt && `Tax exempt${c.tax_exempt_note ? ` · ${c.tax_exempt_note}` : ""}`}</Fact>
        {isOffice && (
          <>
            <Fact label="Marketing">
              <label className={`switch-row ${styles.switchRow}`}>
                <input type="checkbox" className="switch" checked={!c.marketing_opt_out} onChange={(e) => update.mutate({ marketing_opt_out: !e.target.checked })} />
                Gets campaigns, review and referral asks
              </label>
              {c.marketing_opt_out && <span className={styles.hint}>{RESUBSCRIBE_HINT}</span>}
            </Fact>
            <Fact label="Reviews">
              <label className={`switch-row ${styles.switchRow}`}>
                <input type="checkbox" className="switch" checked={!c.review_opt_out && !c.marketing_opt_out && !c.reviewed_at} disabled={c.marketing_opt_out || Boolean(c.reviewed_at)} onChange={(e) => update.mutate({ review_opt_out: !e.target.checked })} />
                Gets review asks
              </label>
              {c.marketing_opt_out ? (
                <span className={styles.hint}>Off while they're unsubscribed from marketing</span>
              ) : c.reviewed_at ? (
                <span className={styles.hint}>Left a Google review, so not asked</span>
              ) : null}
            </Fact>
            <Fact label="Photos">
              <label className={`switch-row ${styles.switchRow}`}>
                <input type="checkbox" className="switch" checked={!c.social_photos_opt_out} onChange={(e) => update.mutate({ social_photos_opt_out: !e.target.checked })} />
                Can be posted on social pages
              </label>
              {c.social_photos_opt_out && <span className={styles.hint}>Photos of their property aren't offered for posts</span>}
              <ClientShowcaseNote clientId={c.id} optedOut={c.social_photos_opt_out} />
            </Fact>
          </>
        )}
        <Fact label="Notes" wide>{c.notes && <span className="pre-wrap">{c.notes}</span>}</Fact>
      </Facts>
      {canSell && contacts.data?.length === 0 && <div className={styles.addContact}><AddContact clientId={c.id} /></div>}
    </Section>
  );

  return (
    <>
      <DetailHeader
        crumb={{ to: "/clients", label: "Clients" }}
        title={c.display_name}
        status={<EntityStatus kind="client" status={c.status} />}
        meta={[
          c.company_name && c.company_name !== c.display_name && <span>{c.company_name}</span>,
          ...c.tags.map((t) => <span key={t} className="tag">{t}</span>),
          c.reviewed_at && <ReviewedChip clientId={c.id} />,
          <ClientShowcaseChip clientId={c.id} />,
          c.marketing_opt_out && <span className={styles.flag}><Icon name="megaphone" size={13} />Unsubscribed from marketing</span>,
          c.review_opt_out && !c.marketing_opt_out && <span className={styles.flag}><Icon name="star" size={13} />No review asks</span>,
          c.social_photos_opt_out && <span className={styles.flag}><Icon name="image" size={13} />No social photos</span>,
          stopped && <span className={styles.flag}><Icon name="messages" size={13} />Texts off</span>,
        ]}
        actions={
          canSell && (
            <>
              <Button icon="requests" className="hide-mobile" onClick={() => setDialog("request")}>New request</Button>
              <Button variant="primary" icon="plus" className="hide-mobile" onClick={() => setDialog("quote")}>New quote</Button>
            </>
          )
        }
        more={canSell ? more : undefined}
        moreTitle={c.display_name}
      >
        {/* A phone's hero (Mobile-Work.dc.html, Client): their initials over the name, centered. */}
        <span className={styles.hero} aria-hidden="true">{initials(c.display_name)}</span>
        {quick.length > 0 && <div className={styles.quick}>{quick}</div>}
        {/* A phone's money first, under the ways to reach them; a desktop has it in Details. */}
        {owed > 0 && (
          <button type="button" className={styles.owes} onClick={showInvoices}>
            <span>Balance</span>
            <span className={styles.owesFigure}>
              <b>{formatMoney(owed)}</b>
              {pastDue > 0 && <span className={styles.pastDue}>{pastDue < owed ? `${formatMoney(pastDue)} ${statusText("invoice", "overdue").toLowerCase()}` : statusText("invoice", "overdue")}</span>}
            </span>
            <Icon name="chevronRight" size={16} />
          </button>
        )}
        {c.status === "archived" && (
          <div className="callout callout-warning">
            <Icon name="archive" size={16} />
            <div className="grow">This client is archived.</div>
            {isOffice && <Button size="sm" onClick={() => update.mutate({ status: "active" })} loading={update.isPending && update.variables?.status === "active"}>Restore client</Button>}
          </div>
        )}
      </DetailHeader>

      <DetailColumns
        grouped
        side={
          <>
            {details}
            {seesMoney && autopayOn && <AutopayCard client={c} />}
            <ContactsCard clientId={c.id} canEdit={canSell} canSetTexts={isOffice} />
          </>
        }
      >
        <Section
          title="Properties"
          count={c.properties.length || undefined}
          action={canSell && c.properties.length > 0 && <button type="button" onClick={() => setProperty({})}>Add property</button>}
        >
          {c.properties.length === 0 ? (
            <EmptyState inline title="No service address yet" action={canSell && <Button icon="plus" onClick={() => setProperty({})}>Add property</Button>} />
          ) : (
            <ul className="rel" role="list" aria-label="Properties">
              {c.properties.map((p) => {
                const codes = accessFor(p.id);
                // A label that only repeats the street isn't a name: the address is the heading then.
                const label = p.label?.trim() && p.label.trim().toLowerCase() !== p.line1.trim().toLowerCase() ? p.label.trim() : null;
                const custom = shownCustomFields(propertyFields, p.custom_fields, "record", companyCountry());
                return (
                  <li key={p.id} className={styles.prop}>
                    <div className={styles.propMain}>
                      <span className={styles.propHead}>
                        <span className={styles.propName}>{label ?? addressLine(p)}</span>
                        {label && <><span className={styles.propSep}> · </span><span className={styles.propAddress}>{addressLine(p)}</span></>}
                      </span>
                      <MetaLine
                        className={styles.propLine}
                        parts={[
                          codes?.gate_code && <span>Gate <b>{codes.gate_code}</b></span>,
                          codes?.lockbox_code && <span>Lockbox <b>{codes.lockbox_code}</b></span>,
                          p.lot_size_sqft != null && `Lot ${Number(p.lot_size_sqft).toLocaleString("en-US")} sq ft`,
                          ...custom.map((f) => `${f.label}: ${f.text}`),
                          p.tags.length > 0 && <span className={styles.propTags}>{p.tags.map((t) => <span key={t} className="tag">{t}</span>)}</span>,
                          p.lat == null && <span className={styles.offMap} title="Routing and weather checks need a map location">Not on the map yet</span>,
                        ]}
                      />
                      {codes?.instructions && <span className={styles.propNote}>{codes.instructions}</span>}
                      {p.notes && <span className={styles.propNote}>{p.notes}</span>}
                      <PropertyEquipment propertyId={p.id} inRow adding={equipmentFor === p.id} onAddingDone={() => setEquipmentFor(null)} />
                    </div>
                    <div className={styles.propActions}>
                      <MapsLink className="btn btn-sm" place={p}><Icon name="navigation" size={18} className={styles.dirIcon} /><span className={styles.dirText}>Directions</span></MapsLink>
                      {canSell && (
                        <Menu
                          triggerClassName="btn btn-sm btn-ghost btn-icon"
                          label={`More for ${label ?? p.line1}`}
                          title={label ?? addressLine(p)}
                          items={[
                            { label: "Edit property", icon: "edit", onSelect: () => setProperty({ row: p, access: codes }) },
                            { label: "Add equipment", icon: "wrench", onSelect: () => setEquipmentFor(p.id) },
                            { label: "Measure on the map", icon: "area", onSelect: () => navigate(`/measure?property=${p.id}${p.lat != null ? `&lat=${p.lat}&lng=${p.lng}` : ""}`) },
                            { separator: true, hidden: !isOffice },
                            { label: "Remove property", icon: "trash", danger: true, hidden: !isOffice, onSelect: () => removeLater(p) },
                          ]}
                        />
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Section>

        {/* Clear of the sticky top bar when the balance scrolls here. */}
        <div ref={workRef} className={styles.workAnchor}>
          {noWork ? (
            <Section title="Work">
              <EmptyState inline title={isOffice ? "No requests, quotes, jobs or invoices yet" : "No requests, quotes or jobs yet"} action={canSell && <Button icon="plus" onClick={() => setDialog("quote")}>New quote</Button>} />
            </Section>
          ) : (
            <Section title="Work" className={styles.work}>
              <div className="underline-tabs" role="tablist" aria-label="Work for this client">
                {tabs.map((t) => (
                  <button key={t} id={`work-tab-${t}`} type="button" role="tab" aria-selected={tab === t} aria-controls="work-panel" onClick={() => setPicked(t)}>
                    {WORK_LABELS[t]} <span className="badge">{work.isPending ? "·" : counts[t]}</span>
                  </button>
                ))}
              </div>
              <div id="work-panel" role="tabpanel" aria-labelledby={tab ? `work-tab-${tab}` : undefined}>
                {work.isPending && <div className="rel">{[0, 1, 2].map((i) => <div key={i} className="rel-row"><Skeleton width={36} /><Skeleton width="45%" /><span className="grow" /><Skeleton width={84} /></div>)}</div>}
                {work.error && <ErrorState compact error={work.error} onRetry={() => work.refetch()} />}
                {work.data && tab === "requests" && (
                  <WorkList empty="No requests yet" rows={work.data.requests.map((r) => ({ to: `/requests/${r.id}`, number: r.number, title: r.title, end: <><EntityStatus kind="request" status={r.status} /><span className={styles.date}>{formatDate(r.created_at)}</span></> }))} />
                )}
                {work.data && tab === "quotes" && (
                  <WorkList
                    empty="No quotes yet"
                    rows={work.data.quotes.map((q) => {
                      const price = listPrice(q);
                      return { to: `/quotes/${q.id}`, number: q.number, title: q.title, end: <><EntityStatus kind="quote" status={q.status} /><b>{price.from ? `From ${formatMoney(price.amount)}` : formatMoney(price.amount)}</b></> };
                    })}
                  />
                )}
                {work.data && tab === "jobs" && (
                  <WorkList
                    empty="No jobs yet"
                    rows={work.data.jobs.map((j) => ({ to: `/jobs/${j.id}`, number: j.number, title: j.title, end: <><EntityStatus kind="job" status={j.status} />{j.kind === "recurring" ? <span className={styles.date}>Recurring</span> : canSell ? <b>{formatMoney(j.financials?.contract_total ?? 0)}</b> : null}</> }))}
                  />
                )}
                {work.data && tab === "invoices" && (
                  <WorkList
                    empty="No invoices yet"
                    rows={work.data.invoices.map((i) => ({ to: `/invoices/${i.id}`, number: i.number, title: i.due_on ? `Due ${formatDate(i.due_on)}` : "Invoice", end: <><EntityStatus kind="invoice" status={i.status} /><b>{formatMoney(i.balance_due > 0 ? i.balance_due : i.total)}</b></> }))}
                  />
                )}
              </div>
            </Section>
          )}
        </div>

        <PhotosCard clientId={c.id} />

        {c.properties.length > 0 && <PlansCard scope={{ kind: "client", properties: c.properties.map((p) => ({ id: p.id, label: p.label || p.line1 })) }} />}

        <Timeline clientId={c.id} />
      </DetailColumns>

      {canSell && (
        <ActionBar>
          <Button icon="requests" onClick={() => setDialog("request")}>New request</Button>
          <Button variant="primary" icon="plus" onClick={() => setDialog("quote")}>New quote</Button>
        </ActionBar>
      )}

      {dialog === "edit" && <EditClientDialog open onClose={() => setDialog(null)} client={c} />}
      {dialog === "merge" && <MergeClientsDialog client={c} onClose={() => setDialog(null)} />}
      {property && <PropertyDialog clientId={c.id} property={property.row} access={property.access} onClose={() => setProperty(null)} />}
      {dialog === "request" && <NewRequestDialog open onClose={() => setDialog(null)} initialClient={{ id: c.id, display_name: c.display_name }} onCreated={(rid) => navigate(`/requests/${rid}`)} />}
      {dialog === "quote" && <NewQuoteDialog open onClose={() => setDialog(null)} initialClient={{ id: c.id, display_name: c.display_name }} onCreated={(qid) => navigate(`/quotes/${qid}`)} />}
    </>
  );
}

/** One kind of their work as small rows: its number, its title, and its status with money or a date on the right. */
function WorkList({ rows, empty }: { rows: Array<{ to: string; number: number | null; title: string; end: ReactNode }>; empty: string }) {
  if (!rows.length) return <EmptyState inline title={empty} />;
  return (
    <RelatedList>
      {rows.map((r) => <RelatedRow key={r.to} to={r.to} lead={r.number != null ? `#${r.number}` : undefined} title={r.title} end={r.end} />)}
    </RelatedList>
  );
}

/**
 * A client matched to a Google review: they aren't asked for reviews again. Its stars, and a link to
 * their review in Marketing → Reviews (where a wrong match is undone), for those who can open it.
 */
function ReviewedChip({ clientId }: { clientId: string }) {
  const session = useSession();
  const sees = hasRole(session, "admin", "office") && can(session, "marketing") && marketingOn(session.company.settings);
  const review = useQuery({
    queryKey: ["client-review", clientId],
    enabled: sees,
    queryFn: async () => unwrap(await supabase().from("reviews").select("rating").eq("client_id", clientId).is("deleted_at", null).order("posted_at").limit(1)),
  });
  const rating = review.data?.[0]?.rating;
  const words = rating ? `Left a ${rating}-star Google review` : "Left a Google review";
  const star = <Icon name="star" size={13} />;
  return sees ? <Link className={styles.star} to={`/marketing?tab=reviews&client=${clientId}`}>{star}{words}</Link> : <span className={styles.star}>{star}{words}</span>;
}
