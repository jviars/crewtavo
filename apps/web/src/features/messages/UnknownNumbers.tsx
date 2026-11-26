/**
 * Texts from numbers that aren't a client's or a contact's (public.unknown_texts): listed in
 * Messages under "Unknown numbers", so none is lost. Calls on a business's Quo number from such a
 * number, answered, missed or a voicemail, wait there with them. Opening one shows its texts and
 * calls and offers to attach the number to a client, as their phone or as a new contact, which
 * moves the conversation onto that client's timeline (public.attach_unknown_texts); or to delete it.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { Dialog } from "@/components/ui/Dialog";
import { Field, FormChecks, FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { Loading, Skeleton } from "@/components/ui/Skeleton";
import { InboxGroup } from "@/components/ui/InboxList";
import { EmptyState, ErrorState } from "@/components/ui/States";
import { supabase, unwrap } from "@/lib/api";
import { dateLocale, formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import { hasRole, useSession } from "@/lib/session";
import { CallNotes } from "../clients/CallNotes";
import { callIcon, callPreview, callView } from "../clients/callWords";
import { ClientPicker, type PickedClient } from "../clients/ClientForm";
import { ConversationRow } from "./ConversationRow";
import { byNumber, kindsOf, movesWords, numberWords, type UnknownNumber } from "./unknownTexts";

const COLUMNS = "id, from_phone, phone_key, body, created_at, channel, call";

/** Who sees unknown numbers: whoever starts conversations with clients (the database holds to the same). */
export const seesUnknownNumbers = (session: Parameters<typeof hasRole>[0]) => hasRole(session, "admin", "office", "estimator");

const unknownKey = (companyId: string) => ["messages", companyId, "unknown"];

/** The unknown numbers that have texted, newest first. */
export function useUnknownNumbers() {
  const session = useSession();
  return useQuery({
    queryKey: unknownKey(session.company.id),
    enabled: seesUnknownNumbers(session),
    refetchInterval: 30_000,
    meta: { silent: true },
    queryFn: async () => byNumber(unwrap(await supabase().from("unknown_texts").select(COLUMNS).eq("company_id", session.company.id).order("created_at", { ascending: false }).limit(500))),
  });
}

/** The rows in the conversation list, above the clients'. */
export function UnknownRows({ numbers, selected, onOpen }: { numbers: readonly UnknownNumber[]; selected: string | null; onOpen: (phoneKey: string) => void }) {
  if (!numbers.length) return null;
  return (
    <InboxGroup label="Unknown numbers" count={numbers.length} tone="warning" icon="phone">
      {numbers.map((n) => (
        <ConversationRow
          key={n.phone_key}
          name={numberWords(n.from_phone)}
          face="?"
          current={selected === n.phone_key}
          unread="Not attached to a client yet"
          at={n.created_at}
          onOpen={() => onOpen(n.phone_key)}
        >
          {/* An unknown number's call is always one that came in. */}
          <Icon name={n.channel === "call" ? callIcon(callView({ direction: "in", call: n.call })?.outcome) : "messages"} size={13} />
          <span>{n.channel === "call" ? callPreview({ direction: "in", call: n.call, body: n.body }) : n.body}</span>
        </ConversationRow>
      ))}
    </InboxGroup>
  );
}

/** One unknown number's texts, with Add to a client and Delete. */
export function UnknownThread({ phoneKey, onBack, onAttached }: { phoneKey: string; onBack: () => void; onAttached: (clientId: string) => void }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const [attaching, setAttaching] = useState(false);
  const texts = useQuery({
    queryKey: [...unknownKey(session.company.id), phoneKey],
    refetchInterval: 15_000,
    queryFn: async () =>
      unwrap(await supabase().from("unknown_texts").select(COLUMNS).eq("company_id", session.company.id).eq("phone_key", phoneKey).order("created_at", { ascending: false }).limit(300)).reverse(),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["messages", session.company.id] });
  const kinds = kindsOf(texts.data ?? []);
  const remove = useMutation({
    meta: { success: () => (!kinds.calls ? "Texts deleted" : kinds.texts ? t("Texts and calls deleted") : t("Calls deleted")) },
    mutationFn: async () => unwrap(await supabase().from("unknown_texts").delete().eq("company_id", session.company.id).eq("phone_key", phoneKey)),
    onSuccess: () => {
      void refresh();
      onBack();
    },
  });
  if (texts.isPending) {
    return (
      <Loading label="Loading texts" className="thread">
        <div className="thread-head"><Skeleton width={160} height={16} /></div>
        <div className="thread-body">{[0, 1].map((i) => <Skeleton key={i} height={48} width="60%" radius={12} />)}</div>
      </Loading>
    );
  }
  if (texts.error) return <div className="thread-empty"><ErrorState error={texts.error} onRetry={() => texts.refetch()} /></div>;
  const rows = texts.data;
  if (!rows.length) {
    return <div className="thread-empty"><EmptyState icon="messages" title="No texts from this number">They may have been added to a client or deleted.</EmptyState></div>;
  }
  const from = rows[rows.length - 1]!.from_phone;
  const deleteLabel = !kinds.calls ? "Delete these texts" : kinds.texts ? t("Delete these texts and calls") : t("Delete these calls");
  const askDelete = async () => {
    const question = kinds.calls
      ? { title: kinds.texts ? t("Delete the texts and calls from {number}?", { number: numberWords(from) }) : t("Delete the calls from {number}?", { number: numberWords(from) }), body: t("They're removed for good. If the number texts or calls again, it shows up here again.") }
      : { title: `Delete the texts from ${numberWords(from)}?`, body: "They're removed for good. If the number texts again, it shows up here again." };
    if (await confirm({ ...question, confirmLabel: "Delete", danger: true })) remove.mutate();
  };
  let lastDay = "";
  return (
    <div className="thread">
      <div className="thread-head">
        <button type="button" className="thread-back mobile-only" aria-label="Back to conversations" onClick={onBack}><Icon name="chevronLeft" size={20} /></button>
        <span className="who">
          <span className="who-name">{numberWords(from)}</span>
          <span className="who-sub">Not one of your clients' numbers</span>
        </span>
        <Button size="sm" variant="primary" icon="plus" className="thread-head-add" onClick={() => setAttaching(true)}>Add to a client</Button>
        {hasRole(session, "admin", "office") && <Button size="sm" variant="ghost" icon="trash" aria-label={deleteLabel} title={deleteLabel} loading={remove.isPending} onClick={askDelete} />}
      </div>
      <div className="thread-body">
        {rows.map((m) => {
          const day = new Date(m.created_at).toLocaleDateString(dateLocale(), { weekday: "short", month: "short", day: "numeric" });
          const showDay = day !== lastDay;
          lastDay = day;
          // A call says how it went (the number is in the header), with what Quo added under it.
          const call = m.channel === "call" ? callView({ direction: "in", call: m.call }) : null;
          const time = <span title={formatDateTime(m.created_at)}>{new Date(m.created_at).toLocaleTimeString(dateLocale(), { hour: "numeric", minute: "2-digit" })}</span>;
          return (
            <Fragment key={m.id}>
              {showDay && <span className="thread-day">{day}</span>}
              <div className="msg">
                {call ? <div className="msg-bubble"><span className="msg-subject">{call.title}</span><CallNotes view={call} /></div> : <div className="msg-bubble">{m.body}</div>}
                {call || m.channel === "call" ? (
                  <span className="msg-meta"><Icon name={callIcon(call?.outcome)} size={12} />{t("Call", { context: "noun" })} · {time}</span>
                ) : (
                  <span className="msg-meta"><Icon name="messages" size={12} />Text · {time}</span>
                )}
              </div>
            </Fragment>
          );
        })}
      </div>
      <div className="composer">
        <span className="composer-note">Add this number to a client to reply and keep the conversation with their other messages.</span>
        {/* On a phone the header has no room for it: it's the bar at the bottom instead. */}
        <Button variant="primary" icon="plus" className="thread-add" onClick={() => setAttaching(true)}>Add to a client</Button>
      </div>
      {attaching && (
        <AttachDialog
          from={from}
          count={rows.length}
          calls={kinds.calls}
          onClose={() => setAttaching(false)}
          onAttached={(clientId) => {
            setAttaching(false);
            void refresh();
            queryClient.invalidateQueries({ queryKey: ["client", clientId] });
            onAttached(clientId);
          }}
        />
      )}
    </div>
  );
}

function AttachDialog({ from, count, calls, onClose, onAttached }: { from: string; count: number; calls: number; onClose: () => void; onAttached: (clientId: string) => void }) {
  const session = useSession();
  const [client, setClient] = useState<PickedClient>(null);
  const [choice, setChoice] = useState<"phone" | "contact" | null>(null);
  const [name, setName] = useState("");
  // The phone the client has now: with one on file, the number is a contact's unless they say to replace it.
  const onFile = useQuery({
    queryKey: ["client", client?.id, "phone"],
    enabled: Boolean(client),
    queryFn: async () => unwrap(await supabase().from("clients").select("phone").eq("id", client!.id).maybeSingle())?.phone ?? null,
  });
  const as = choice ?? (onFile.data ? "contact" : "phone");
  const attach = useMutation({
    meta: { inline: true, success: () => `Added to ${client!.display_name}` },
    mutationFn: async () =>
      unwrap(await supabase().rpc("attach_unknown_texts", { p_company: session.company.id, p_phone: from, p_client: client!.id, p_as: as, ...(as === "contact" ? { p_name: name.trim() } : {}) })),
    onSuccess: () => onAttached(client!.id),
  });
  return (
    <Dialog open onClose={onClose} title={`Add ${numberWords(from)} to a client`} description={calls ? movesWords(count - calls, calls) : `${count === 1 ? "Its text moves" : `Its ${count} texts move`} onto the client's timeline, and new ones go there from now on.`} size="sm">
      <form
        className="stack-sm"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          if (client && !onFile.isPending) attach.mutate();
        }}
      >
        <ClientPicker value={client} onChange={(c) => { setClient(c); setChoice(null); attach.reset(); }} />
        {client && !onFile.isPending && (
          <>
            <label className="checkbox">
              <input type="radio" name="attach-as" checked={as === "phone"} onChange={() => setChoice("phone")} />
              <span>
                It's {client.display_name}'s own phone
                {onFile.data && <span className="muted small" style={{ display: "block" }}>Replaces the number on file, {onFile.data}.</span>}
              </span>
            </label>
            <label className="checkbox">
              <input type="radio" name="attach-as" checked={as === "contact"} onChange={() => setChoice("contact")} />
              <span>It's someone else on their account<span className="muted small" style={{ display: "block" }}>Added as a contact. Tick them for reminders on the client's page if they should get them.</span></span>
            </label>
            {as === "contact" && (
              <Field label="Contact's name" requiredMessage="Add the contact's name.">
                <input className="input" value={name} onChange={(e) => setName(e.target.value.trimStart())} maxLength={120} required placeholder="Spouse, property manager…" />
              </Field>
            )}
          </>
        )}
        <FormError error={attach.error} />
        <div className="form-actions">
          <FormChecks />
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={attach.isPending} disabled={!client || onFile.isPending}>Add to client</Button>
        </div>
      </form>
    </Dialog>
  );
}
