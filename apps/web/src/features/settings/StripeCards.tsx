/**
 * Settings → Payments: clients whose card came in from Stripe ("Bring in your Stripe history") and
 * who haven't agreed to autopay here yet. A card brought in is never charged until they do. Two
 * ways to move them over: ask them (a Confirm autopay link: they see the card's last four and the
 * terms, and tap once), or, for an owner, record that they agreed some other way, which is kept as
 * their agreement in the owner's name (autopay_vouch). Each client's page then says the day they
 * moved over, so they stop being charged by hand in Stripe from then.
 */
import { isPlaceholderEmail } from "@crewtavo/core/email";
import { methodExpiry, methodLabel } from "@crewtavo/core/autopay";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { Section } from "@/components/ui/Section";
import { Loading, SectionSkeleton } from "@/components/ui/Skeleton";
import { ErrorState } from "@/components/ui/States";
import { api, supabase, unwrap } from "@/lib/api";
import { useSession } from "@/lib/session";
import { toast } from "@/lib/toast";
import p from "./Prefs.module.css";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** The most rows shown before "Show all". */
const SHOWN = 25;
/** What POST /clients/autopay/invite and /vouch take at once. */
const INVITE_CHUNK = 200;
const VOUCH_CHUNK = 500;

interface MethodRow {
  id: string;
  client_id: string;
  type: string;
  brand: string | null;
  last4: string | null;
  bank_name: string | null;
  wallet: string | null;
  exp_month: number | null;
  exp_year: number | null;
  is_default: boolean;
  client: { id: string; display_name: string; email: string | null; phone: string | null } | null;
}

interface AgreementRow {
  client_id: string;
  revoked_at: string | null;
  revoked_via: string | null;
}

/** One client with a card from Stripe, as the list shows them. */
export interface StripeCardRow {
  client_id: string;
  name: string;
  email: string | null;
  phone: string | null;
  card: string;
  expires: string | null;
  /** They turned autopay off themselves once: a Confirm link can't switch it back on, and an owner can't vouch for them. */
  turned_off: boolean;
}

/**
 * The clients to list: each with an active card brought in from Stripe (their default one first)
 * and no agreement in force, by name.
 */
export function stripeCardRows(methods: MethodRow[], agreements: AgreementRow[]): StripeCardRow[] {
  const agreed = new Set(agreements.filter((a) => !a.revoked_at).map((a) => a.client_id));
  const turnedOff = new Set(agreements.filter((a) => a.revoked_via === "client").map((a) => a.client_id));
  const byClient = new Map<string, MethodRow>();
  for (const m of methods) {
    if (!m.client || agreed.has(m.client_id)) continue;
    const kept = byClient.get(m.client_id);
    if (!kept || (m.is_default && !kept.is_default)) byClient.set(m.client_id, m);
  }
  return [...byClient.values()]
    .map((m) => ({ client_id: m.client_id, name: m.client!.display_name, email: m.client!.email, phone: m.client!.phone, card: methodLabel(m), expires: methodExpiry(m), turned_off: turnedOff.has(m.client_id) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Split into chunks the API takes at once. */
const chunks = <T,>(list: T[], size: number) => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size));

export function StripeCards({ enabled, termsVersion }: { enabled: boolean; termsVersion: string }) {
  const session = useSession();
  const { company } = session;
  const features = session.config.features;
  const owner = session.role === "owner";
  const queryClient = useQueryClient();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [all, setAll] = useState(false);

  const cards = useQuery({
    queryKey: ["company", company.id, "payments", "stripe-cards"],
    queryFn: async () => {
      const db = supabase();
      const [methods, agreements] = await Promise.all([
        db
          .from("client_payment_methods")
          .select("id, client_id, type, brand, last4, bank_name, wallet, exp_month, exp_year, is_default, client:clients!client_payment_methods_client_fkey(id, display_name, email, phone)")
          .eq("company_id", company.id)
          .eq("source", "stripe_import")
          .eq("status", "active"),
        // Only what decides the list: agreements in force, and ones the client turned off.
        db.from("autopay_authorizations").select("client_id, revoked_at, revoked_via").eq("company_id", company.id).or("revoked_at.is.null,revoked_via.eq.client"),
      ]);
      return stripeCardRows(unwrap(methods) as MethodRow[], unwrap(agreements));
    },
  });
  const rows = cards.data ?? [];
  // A text goes to those with no email to send to, when texting is set up.
  const byEmail = (r: StripeCardRow) => features.email && Boolean(r.email) && !isPlaceholderEmail(r.email);
  const byText = (r: StripeCardRow) => !byEmail(r) && features.sms && Boolean(r.phone);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["company", company.id, "payments"] });

  const send = useMutation({
    meta: { inline: true },
    mutationFn: async (list: StripeCardRow[]) => {
      const reachable = list.filter((r) => !r.turned_off && (byEmail(r) || byText(r)));
      let sent = 0;
      let skipped = list.length - reachable.length;
      for (const [channel, ids] of [["email", reachable.filter(byEmail)], ["sms", reachable.filter(byText)]] as const) {
        for (const chunk of chunks(ids.map((r) => r.client_id), INVITE_CHUNK)) {
          const r = await api.post<{ sent: number; skipped: number }>("/clients/autopay/invite", { client_ids: chunk, channel });
          sent += r.sent;
          skipped += r.skipped;
        }
      }
      return { sent, skipped };
    },
    onSuccess: (r) => toast.success(`Sent ${r.sent}. Skipped ${r.skipped}.`),
  });
  const vouch = useMutation({
    meta: { inline: true },
    mutationFn: async (ids: string[]) => {
      let recorded = 0;
      for (const chunk of chunks(ids, VOUCH_CHUNK)) recorded += (await api.post<{ recorded: number }>("/clients/autopay/vouch", { client_ids: chunk, terms_version: termsVersion })).recorded;
      return { recorded, asked: ids.length };
    },
    onSuccess: (r) => {
      setPicked(new Set());
      toast.success(`Recorded ${plural(r.recorded, "agreement")}`, r.recorded < r.asked ? { description: `${plural(r.asked - r.recorded, "client was", "clients were")} left out: their card on file isn't the one from Stripe, or they turned autopay off.` } : undefined);
      refresh();
      // Their client pages' Autopay cards (["client", id, "autopay"]) now show the agreement.
      queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] === "client" && q.queryKey[2] === "autopay" });
      // The Clients list's Card not set up tab and its count.
      queryClient.invalidateQueries({ queryKey: ["clients", company.id] });
    },
  });

  if (cards.isPending) return <Loading label="Loading the cards saved in Stripe"><SectionSkeleton rows={3} /></Loading>;
  if (cards.error) return <ErrorState compact title="The cards saved in Stripe couldn't load" error={cards.error} onRetry={() => cards.refetch()} />;
  if (!rows.length) return null;

  const shown = all ? rows : rows.slice(0, SHOWN);
  const choosable = rows.filter((r) => !r.turned_off);
  const chosen = rows.filter((r) => picked.has(r.client_id));
  const toggle = (id: string, on: boolean) => {
    const next = new Set(picked);
    if (on) next.add(id);
    else next.delete(id);
    setPicked(next);
  };
  const sendTo = chosen.length ? chosen : rows;
  const askSend = async () => {
    if (await confirm({ title: `Send Confirm autopay links to ${plural(sendTo.length, "client")}?`, body: "By email, or by text for those without an email address. They see the card's last four and your terms, and tap once. Anyone sent one in the last 7 days is skipped.", confirmLabel: "Send links" })) send.mutate(sendTo);
  };
  const askVouch = async () => {
    if (await confirm({ title: `Record that ${plural(chosen.length, "client")} agreed to be charged automatically?`, body: "This is kept as their agreement, in your name, with today's terms.", confirmLabel: "Record agreement" })) vouch.mutate(chosen.map((r) => r.client_id));
  };
  const reach = (r: StripeCardRow) => (r.turned_off ? "Turned autopay off" : byEmail(r) ? null : byText(r) ? "By text" : "No email or phone to send to");

  return (
    <Section level={3} title="Cards saved in Stripe" count={rows.length}>
      <p className="set-note">
        {plural(rows.length, "client has", "clients have")} a card saved in Stripe. They aren't charged from Crewtavo until they agree. Ask them with a Confirm autopay link: they see their card and your terms, and tap once. Stop charging each one by hand in Stripe from the day they move over; their client page says when.
      </p>
      {!enabled && (
        <div className={`callout callout-warning ${p.gapTop}`}>
          <Icon name="alert" size={16} />
          <div className="grow">Turn on autopay above and save first.</div>
        </div>
      )}
      <ul className={`${p.choices} ${p.after}`} role="list" aria-label="Clients with a card saved in Stripe">
        {owner && choosable.length > 1 && (
          <li>
            <label className={p.choice}>
              <input type="checkbox" checked={chosen.length === choosable.length} onChange={(e) => setPicked(new Set(e.target.checked ? choosable.map((r) => r.client_id) : []))} />
              <span className={`${p.rowText} ${p.quiet}`}>Select all</span>
            </label>
          </li>
        )}
        {shown.map((r) => {
          const note = reach(r);
          const body = (
            <span className={p.rowText}>
              <Link to={`/clients/${r.client_id}`} className={`ellipsis ${p.name}`}>{r.name}</Link>
              <span className={p.hint}>{r.card}{r.expires ? ` · expires ${r.expires}` : ""}{note ? ` · ${note}` : ""}</span>
            </span>
          );
          return (
            <li key={r.client_id}>
              {owner ? (
                <label className={p.choice}>
                  <input type="checkbox" checked={picked.has(r.client_id)} disabled={r.turned_off} onChange={(e) => toggle(r.client_id, e.target.checked)} aria-label={`Choose ${r.name}`} />
                  {body}
                </label>
              ) : (
                <div className={p.choice}>{body}</div>
              )}
            </li>
          );
        })}
      </ul>
      {rows.length > SHOWN && (
        <div className={p.more}>
          <span>{all ? `All ${rows.length}` : `${SHOWN} of ${rows.length}`}</span>
          <button type="button" className="link-btn small" onClick={() => setAll(!all)}>{all ? "Show fewer" : `Show all ${rows.length}`}</button>
        </div>
      )}
      <div className={p.after}>
        <FormError error={send.error ?? vouch.error} />
        <div className={p.groupSave} style={{ marginTop: 0 }}>
          <Button icon="send" loading={send.isPending} disabled={!enabled || (!features.email && !features.sms)} onClick={askSend}>
            {chosen.length ? `Send Confirm autopay links to ${chosen.length}` : "Send Confirm autopay links"}
          </Button>
          {owner && (
            <Button icon="check" variant="ghost" wrap loading={vouch.isPending} disabled={!enabled || !chosen.length} onClick={askVouch}>These clients agreed to be charged automatically</Button>
          )}
        </div>
        {!features.email && !features.sms && <p className="set-note">Connect email in Settings → Email, or set up texting, to send links.</p>}
        {owner && <p className="set-note">For clients who already agreed with you some other way. Tick them, then record it. Owners only.</p>}
      </div>
    </Section>
  );
}
