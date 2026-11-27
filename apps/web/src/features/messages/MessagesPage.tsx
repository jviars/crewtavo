/**
 * Message center: conversations by client (emails, texts, notes, and calls on a business's Quo
 * number), with replies by email or text, and texts and calls from unknown numbers to attach to a
 * client. Calls only get their own filter once there are some.
 */
import { textsOff, textsOffReason } from "@crewtavo/core/marketing";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, useDeferredValue, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { FormError } from "@/components/ui/Field";
import { Icon, type IconName } from "@/components/ui/Icon";
import { PageHeader } from "@/components/ui/PageHeader";
import { FilterTabs, SearchField } from "@/components/ui/Toolbar";
import { InboxGroup, InboxList } from "@/components/ui/InboxList";
import { InboxSkeleton, Loading, Skeleton } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState } from "@/components/ui/States";
import { ApiError, api, searchTerm, supabase, unwrap } from "@/lib/api";
import { dateLocale, formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import { useListAnimation } from "@/lib/motion";
import { hasRole, useSession } from "@/lib/session";
import { CallNotes } from "../clients/CallNotes";
import { callIcon, callPreview, callView } from "../clients/callWords";
import { ClientPicker, type PickedClient } from "../clients/ClientForm";
import { MessageBody } from "../clients/MessageBody";
import { messageFrom, messagePeople } from "../clients/messagePeople";
import { ConnectEmailHint } from "../settings/ConnectEmailHint";
import { ConversationRow } from "./ConversationRow";
import { conversationsFrom } from "./conversations";
import { answersMessages, isWaiting, useDoneMarks, useMarkDone } from "./done";
import { UnknownRows, UnknownThread, useUnknownNumbers } from "./UnknownNumbers";
import { numbersFor } from "./unknownTexts";

const FILTERS = [
  { key: "all", label: "All", channels: ["sms", "email", "note", "call"] },
  { key: "in", label: "From clients", channels: ["sms", "email", "note", "call"] },
  { key: "email", label: "Email", channels: ["email"] },
  { key: "sms", label: "Texts", channels: ["sms"] },
  { key: "calls", label: "Calls", channels: ["call"] },
] as const;
const ICON: Record<string, IconName> = { email: "mail", sms: "messages", note: "note", call: "phone" };

interface Msg { id: string; channel: string; direction: string; subject: string | null; body: string; status: string; created_at: string; call: unknown; client: { id: string; display_name: string } | null }
const LISTED = "id, channel, direction, subject, body, status, created_at, call, client:clients(id, display_name)";
/** How many messages the list reads, newest first. */
const READ = 500;

/** Whether the business has any calls here (from its Quo number), so Calls is offered as a filter. */
function useHasCalls() {
  const session = useSession();
  return useQuery({
    queryKey: ["messages", session.company.id, "has-calls"],
    staleTime: 5 * 60_000,
    meta: { silent: true },
    queryFn: async () => unwrap(await supabase().from("messages").select("id").eq("company_id", session.company.id).eq("channel", "call").limit(1)).length > 0,
  });
}

export function MessagesPage() {
  const session = useSession();
  const [params, setParams] = useSearchParams();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["key"]>("all");
  const [search, setSearch] = useState("");
  const [composing, setComposing] = useState(false);
  const term = useDeferredValue(searchTerm(search));
  const selected = params.get("client");
  // A number that isn't a client's or a contact's, by its last 10 digits (UnknownNumbers.tsx).
  const unknown = params.get("unknown");
  const strangers = useUnknownNumbers();
  const marks = useDoneMarks().data;
  const markDone = useMarkDone();
  const hasCalls = useHasCalls().data;
  const f = FILTERS.find((x) => x.key === filter)!;

  const messages = useQuery({
    queryKey: ["messages", session.company.id, filter],
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
    queryFn: async () => {
      let q = supabase()
        .from("messages")
        .select(LISTED)
        .eq("company_id", session.company.id)
        .in("channel", [...f.channels])
        .not("client_id", "is", null)
        .order("created_at", { ascending: false })
        .limit(READ);
      if (filter === "in") q = q.eq("direction", "in");
      // With them, each waiting conversation's latest message, for those who answer: one that waits
      // has a row to mark done even when its latest message is older than the ones read. Newest
      // first and as many, so a waiting conversation among the messages read is always among these.
      const [rows, waiting] = await Promise.all([
        q,
        answersMessages(session) ? supabase().rpc("waiting_conversation_messages", { p_company: session.company.id }).select(LISTED).order("created_at", { ascending: false }).limit(READ) : null,
      ]);
      return { rows: unwrap(rows) as unknown as Msg[], waiting: waiting && (unwrap(waiting) as unknown as Msg[]) };
    },
  });
  // One row per client: their latest message.
  const conversations = useMemo(
    () => conversationsFrom(messages.data?.rows ?? [], messages.data?.waiting, f.channels).filter((c) => !term || c.client!.display_name.toLowerCase().includes(term.toLowerCase()) || c.body.toLowerCase().includes(term.toLowerCase())),
    [messages.data, f, term],
  );
  const open = (clientId: string | null) => setParams(clientId ? { client: clientId } : {}, { replace: true });
  // Texts and calls from unknown numbers are from outside: none under Email, and only theirs under Texts or Calls.
  const unknownNumbers = numbersFor(strangers.data ?? [], filter, term);
  // Calls is a filter once there are some, from a client or an unknown number (and stays while it's the one picked).
  const filters = FILTERS.filter((x) => x.key !== "calls" || hasCalls || filter === "calls" || strangers.data?.some((n) => n.calls > 0));
  // Conversations move to the top as messages come in.
  const list = useListAnimation<HTMLDivElement>();

  return (
    <div className="messages-page stack" data-open={selected || unknown ? "" : undefined} style={{ gap: "inherit" }}>
      <PageHeader title="Messages" actions={hasRole(session, "admin", "office", "estimator") && <Button icon="plus" onClick={() => setComposing(true)}>New message</Button>} />
      {!session.config.features.email && !session.config.features.sms && (
        <div className="callout callout-info"><Icon name="info" size={16} /><div className="grow">Email and texting aren't turned on yet. You can still add notes.<ConnectEmailHint /></div></div>
      )}
      <div className="inbox" data-open={selected || unknown ? "" : undefined}>
        <section className="inbox-list" aria-label="Conversations">
          <SearchField value={search} onChange={setSearch} placeholder="Search conversations" label="Search conversations" />
          <FilterTabs label="Filter messages" value={filter} onChange={setFilter} options={filters.map((x) => ({ value: x.key, label: x.key === "calls" ? t("Calls") : x.label }))} />
          <div className="inbox-scroll" ref={list}>
            {messages.isPending && <InboxSkeleton rows={6} />}
            {messages.error && <ErrorState compact error={messages.error} onRetry={() => messages.refetch()} />}
            {messages.data && conversations.length === 0 && unknownNumbers.length === 0 && <EmptyState compact icon="messages" title={term ? "No conversations match" : "No messages yet"} />}
            {(unknownNumbers.length > 0 || conversations.length > 0) && (
              <InboxList label="Conversations" stale={messages.isPlaceholderData}>
                <UnknownRows numbers={unknownNumbers} selected={unknown} onOpen={(key) => setParams({ unknown: key }, { replace: true })} />
                {conversations.length > 0 && (
                  <InboxGroup label={unknownNumbers.length ? "Clients" : undefined} count={unknownNumbers.length ? conversations.length : undefined}>
                    {conversations.map((c) => {
                      const waiting = isWaiting(c, marks?.get(c.client!.id));
                      return (
                      <ConversationRow
                        key={c.client!.id}
                        name={c.client!.display_name}
                        current={selected === c.client!.id}
                        unread={waiting ? "Waiting on a reply: the latest message is the client's" : undefined}
                        at={c.created_at}
                        onOpen={() => open(c.client!.id)}
                        actions={waiting && marks && (
                          <button type="button" className="icon-btn" aria-label={`Mark ${c.client!.display_name}'s conversation done`} title="Done: no reply needed" onClick={() => markDone.mutate({ clientId: c.client!.id, name: c.client!.display_name })}>
                            <Icon name="check" size={16} />
                          </button>
                        )}
                      >
                        {c.channel === "call" ? (
                          <>
                            <Icon name={callIcon(callView(c)?.outcome)} size={13} />
                            <span>{callPreview(c)}</span>
                          </>
                        ) : (
                          <>
                            <Icon name={ICON[c.channel] ?? "messages"} size={13} />
                            <span>{c.direction === "in" ? "" : c.direction === "internal" ? "Note: " : "You: "}{c.subject ? `${c.subject} · ` : ""}<MessageBody body={c.body} /></span>
                          </>
                        )}
                      </ConversationRow>
                      );
                    })}
                  </InboxGroup>
                )}
              </InboxList>
            )}
          </div>
        </section>
        <section className="inbox-thread" aria-label="Conversation">
          {unknown ? <UnknownThread key={unknown} phoneKey={unknown} onBack={() => open(null)} onAttached={(clientId) => open(clientId)} /> : selected ? <Thread key={selected} clientId={selected} onBack={() => open(null)} /> : (
            <div className="thread-empty">
              <EmptyState icon="messages" title="Pick a conversation" />
            </div>
          )}
        </section>
      </div>
      {composing && <NewMessage onClose={() => setComposing(false)} onSent={(id) => { setComposing(false); open(id); }} />}
    </div>
  );
}

const dayLabel = (iso: string) => {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString(dateLocale(), { weekday: "short", month: "short", day: "numeric", year: d.getFullYear() === today.getFullYear() ? undefined : "numeric" });
};

function Thread({ clientId, onBack }: { clientId: string; onBack: () => void }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const marks = useDoneMarks().data;
  const markDone = useMarkDone();
  const body = useRef<HTMLDivElement>(null);
  const thread = useQuery({
    queryKey: ["client", clientId, "thread"],
    refetchInterval: 15_000,
    queryFn: async () => {
      const [client, rows] = await Promise.all([
        supabase().from("clients").select("id, display_name, email, phone, sms_opt_out_at").eq("id", clientId).maybeSingle(),
        supabase().from("messages").select("id, channel, direction, subject, body, status, created_at, recipients, from_name, origin, call").eq("client_id", clientId).order("created_at", { ascending: false }).limit(300),
      ]);
      return { client: unwrap(client), rows: unwrap(rows).reverse() };
    },
  });
  const count = thread.data?.rows.length ?? 0;
  useEffect(() => {
    // Keep the newest message in view (scroll the thread, never the page).
    const el = body.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: count && !matchMedia("(prefers-reduced-motion: reduce)").matches ? "smooth" : "auto" });
  }, [count]);
  if (thread.isPending)
    return (
      <Loading label="Loading conversation" className="thread">
        <div className="thread-head"><Skeleton width={160} height={16} /></div>
        <div className="thread-body">{[0, 1, 2, 3].map((i) => <Skeleton key={i} height={i === 1 ? 70 : 48} width={i % 2 ? "55%" : "65%"} radius={12} style={{ alignSelf: i % 2 ? "flex-end" : "flex-start" }} />)}</div>
      </Loading>
    );
  if (thread.error || !thread.data.client) return <div className="thread-empty"><ErrorState error={thread.error ?? new ApiError("This client no longer exists. They may have been deleted.", 404)} onRetry={thread.error ? () => thread.refetch() : undefined} /></div>;
  const { client, rows } = thread.data;
  const latest = rows[rows.length - 1];
  const waiting = Boolean(marks && latest && isWaiting(latest, marks.get(client.id)));
  let lastDay = "";
  return (
    <div className="thread">
      <div className="thread-head">
        <button type="button" className="thread-back mobile-only" aria-label="Back to conversations" onClick={onBack}><Icon name="chevronLeft" size={20} /></button>
        <span className="who">
          <Link to={`/clients/${client.id}`} className="who-name">{client.display_name}</Link>
          <span className="who-sub">{[client.phone, client.email].filter(Boolean).join(" · ") || "No phone or email on file"}</span>
        </span>
        {waiting && <Button size="sm" icon="check" className="thread-done" title="The client's last message needs no reply" onClick={() => markDone.mutate({ clientId: client.id, name: client.display_name })}>Done</Button>}
        {client.phone && <a className="btn btn-sm btn-ghost btn-icon thread-call" href={`tel:${client.phone}`} aria-label={`Call ${client.display_name}`} title={`Call ${client.display_name}`}><Icon name="phone" size={16} /></a>}
      </div>
      <div className="thread-body" ref={body}>
        {rows.length === 0 && <EmptyState compact icon="messages" title="No messages yet" />}
        {rows.map((m) => {
          const mine = m.direction !== "in";
          const note = m.direction === "internal";
          const day = dayLabel(m.created_at);
          const showDay = day !== lastDay;
          lastDay = day;
          // One message however many people it went to: who they were, and anyone it didn't reach.
          const sent = messagePeople(m);
          const from = messageFrom(m);
          // A call says how it went and who with in its bubble, with what Quo added under it.
          const call = m.channel === "call" ? callView(m, (m.direction === "in" ? from : sent.to) ?? client.display_name) : null;
          const time = <span title={formatDateTime(m.created_at)}>{new Date(m.created_at).toLocaleTimeString(dateLocale(), { hour: "numeric", minute: "2-digit" })}</span>;
          return (
            <Fragment key={m.id}>
              {showDay && <span className="thread-day">{day}</span>}
              <div className="msg" data-mine={mine || undefined} data-note={note || undefined} data-failed={m.status === "failed" || undefined}>
                {call ? (
                  <div className="msg-bubble"><span className="msg-subject">{call.title}</span><CallNotes view={call} /></div>
                ) : (
                  <div className="msg-bubble">{m.subject && <span className="msg-subject">{m.subject}</span>}<MessageBody body={m.body} /></div>
                )}
                {call ? (
                  <span className="msg-meta">
                    <Icon name={callIcon(call.outcome)} size={12} />
                    {t("Call", { context: "noun" })} · {time}
                    {m.origin === "quo_import" && <span title={t("Brought in from Quo's history")}>· {t("From Quo")}</span>}
                  </span>
                ) : (
                  <span className="msg-meta">
                    <Icon name={ICON[m.channel] ?? "messages"} size={12} />
                    {note ? "Internal note" : m.channel === "email" ? "Email" : m.channel === "sms" ? (m.origin === "quo" && mine ? t("Text sent from Quo") : "Text") : "Call"}
                    {from && <> from {from}</>}
                    {sent.to && <span title={sent.toFull ?? undefined}> to {sent.to}</span>} · {time}
                    {m.origin === "quo_import" && <span title={t("Brought in from Quo's history")}>· {t("From Quo")}</span>}
                    {m.status === "failed" && <span className="text-danger strong">· Not delivered</span>}
                    {sent.missed && <span className="text-danger">· Didn't reach {sent.missed}</span>}
                  </span>
                )}
              </div>
            </Fragment>
          );
        })}
      </div>
      <Composer key={client.id} client={client} onSent={() => { queryClient.invalidateQueries({ queryKey: ["client", clientId] }); queryClient.invalidateQueries({ queryKey: ["messages", session.company.id] }); queryClient.invalidateQueries({ queryKey: ["conversations-waiting", session.company.id] }); }} />
    </div>
  );
}

function Composer({ client, onSent }: { client: { id: string; display_name: string; email: string | null; phone: string | null; sms_opt_out_at: string | null }; onSent: () => void }) {
  const session = useSession();
  const { features } = session.config;
  const [channel, setChannel] = useState<"email" | "sms" | "note">(client.phone && features.sms && !textsOff(client) ? "sms" : client.email && features.email ? "email" : "note");
  const [subject, setSubject] = useState(`A note from ${session.company.name}`);
  const [body, setBody] = useState("");
  const send = useMutation({
    // A note shows up in the thread right away; a sent email or text goes out to the client, so it's said.
    meta: { inline: true, success: () => (channel === "note" ? null : channel === "email" ? "Email sent" : "Text sent") },
    mutationFn: async () => {
      if (channel === "note") return unwrap(await supabase().from("messages").insert({ company_id: session.company.id, client_id: client.id, channel: "note", direction: "internal", body: body.trim() }));
      return api.post("/messages/send", { client_id: client.id, channel, subject: channel === "email" ? subject.trim() : undefined, body: body.trim() });
    },
    onSuccess: () => {
      setBody("");
      onSent();
    },
    // A failed email or text is still recorded (as "not delivered"), so refresh the thread either way.
    onError: onSent,
  });
  const problem =
    channel === "email" ? (!client.email ? "No email address on file for this client." : !features.email ? "Email isn't turned on yet." : null)
    : channel === "sms" ? (!client.phone ? "No phone number on file for this client." : textsOff(client) ? textsOffReason(client.display_name) : !features.sms ? "Texting isn't turned on yet." : null)
    : null;
  const canSend = body.trim().length > 0 && !problem && (channel !== "email" || subject.trim().length > 0);
  return (
    <form className="composer" onSubmit={(e: FormEvent) => { e.preventDefault(); if (canSend && !send.isPending) send.mutate(); }}>
      <div className="row wrap" style={{ gap: 10 }}>
        <div className="segmented segmented-sm" role="group" aria-label="Send as">
          <button type="button" aria-pressed={channel === "sms"} onClick={() => { setChannel("sms"); send.reset(); }}><Icon name="messages" size={14} />Text</button>
          <button type="button" aria-pressed={channel === "email"} onClick={() => { setChannel("email"); send.reset(); }}><Icon name="mail" size={14} />Email</button>
          <button type="button" aria-pressed={channel === "note"} onClick={() => { setChannel("note"); send.reset(); }}><Icon name="note" size={14} />Note</button>
        </div>
        {problem && <span className="composer-problem">{problem}</span>}
      </div>
      {channel === "email" && <input className="input" value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200} placeholder="Subject" aria-label="Subject" />}
      <div className="composer-row">
        <textarea
          className="textarea grow"
          rows={1}
          value={body}
          maxLength={channel === "sms" ? 1600 : 10000}
          onChange={(e) => { setBody(e.target.value); if (send.isError) send.reset(); }}
          placeholder={channel === "note" ? "Internal note (the client won't see it)" : `Message ${client.display_name}…`}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); e.currentTarget.form?.requestSubmit(); } }}
          aria-label="Message"
          disabled={Boolean(problem)}
        />
        <Button type="submit" variant="primary" icon="send" loading={send.isPending} disabled={!canSend} aria-label={channel === "note" ? "Add note" : "Send"} title="Send (⌘/Ctrl + Enter)" />
      </div>
      {channel === "sms" && body.length > 160 && <span className="muted small">{body.length.toLocaleString()} characters · sends as {Math.ceil(body.length / 153)} texts</span>}
      <FormError error={send.error} />
    </form>
  );
}

function NewMessage({ onClose, onSent }: { onClose: () => void; onSent: (clientId: string) => void }) {
  const [client, setClient] = useState<PickedClient>(null);
  return (
    <Dialog open onClose={onClose} title="New message" size="sm">
      <div className="stack-sm">
        <ClientPicker value={client} onChange={(c) => { setClient(c); if (c) onSent(c.id); }} allowCreate={false} />
      </div>
    </Dialog>
  );
}
