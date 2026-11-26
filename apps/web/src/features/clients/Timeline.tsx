/**
 * Notes, emails, texts and calls for a client, newest first, with a note composer (Ctrl/⌘+Enter
 * saves). A call on the business's Quo number says how it went and who with, then what Quo added
 * (callWords.ts); a text someone sent from the Quo app says so, and what was brought in from Quo's
 * history is marked quietly.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Button, useJustDone } from "@/components/ui/Button";
import { Icon, type IconName } from "@/components/ui/Icon";
import { Section } from "@/components/ui/Section";
import { Skeleton } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState } from "@/components/ui/States";
import { StatusPill } from "@/components/ui/StatusPill";
import { supabase, unwrap } from "@/lib/api";
import { formatDateTime, timeAgo } from "@/lib/format";
import { t } from "@/lib/i18n";
import { useListAnimation } from "@/lib/motion";
import { hasRole, useSession } from "@/lib/session";
import { undoable } from "@/lib/undo";
import { CallNotes } from "./CallNotes";
import { callIcon, callIsLong, callView, foldedCall, type CallView } from "./callWords";
import styles from "./clients.module.css";
import { MessageBody } from "./MessageBody";
import { messageFrom, messagePeople } from "./messagePeople";

const ICON: Record<string, IconName> = { note: "note", email: "mail", sms: "messages", call: "phone" };

const SELECT = "id, channel, direction, subject, body, status, created_at, sent_by, recipients, from_name, origin, call";

function label(m: { channel: string; direction: string; subject: string | null; recipients?: unknown; from_name?: string | null; origin?: string | null }) {
  if (m.channel === "note") return m.direction === "in" ? "From client" : "Note";
  const what = m.channel === "email" ? "Email" : m.channel === "sms" ? "Text" : "Call";
  // A text from a contact's phone says whose; a send says who it went to, when that was recorded.
  if (m.direction === "in") return `${what} from ${messageFrom(m) ?? "client"}`;
  const { to } = messagePeople(m);
  // Typed in the Quo app rather than sent from Crewtavo.
  if (m.channel === "sms" && m.origin === "quo") return to ? t("Text sent from Quo to {name}", { name: to }) : t("Text sent from Quo");
  return to ? `${what} sent to ${to}` : `${what} sent`;
}

/** Who a call was with: the contact whose phone it was, whoever it went to, else the client. */
const callWith = (m: { direction: string; recipients?: unknown; from_name?: string | null }, clientName: string | undefined) =>
  (m.direction === "in" ? messageFrom(m) : messagePeople(m).to) ?? clientName ?? null;

/** What Quo added to a call; a long one shows its first lines until Show all. */
function CallBody({ view }: { view: CallView }) {
  const [open, setOpen] = useState(false);
  const long = callIsLong(view);
  return (
    <div className={styles.body}>
      <CallNotes view={long && !open ? foldedCall(view) : view} clamp={long && !open} />
      {long && <button type="button" className={`link-btn ${styles.showAll} ${styles.tap}`} aria-expanded={open} onClick={() => setOpen(!open)}>{open ? "Show less" : "Show all"}</button>}
    </div>
  );
}

/** A message's words, cut to three quiet lines when it's long (an email with its links), its blank lines closed up until Show all. */
function EntryBody({ m }: { m: { body: string | null } }) {
  const [open, setOpen] = useState(false);
  const text = m.body ?? "";
  const long = text.length > 320 || text.split("\n").length > 5;
  return (
    <div className={styles.body}>
      <div className={long && !open ? styles.clamped : undefined}><MessageBody body={m.body} /></div>
      {long && <button type="button" className={`link-btn ${styles.showAll} ${styles.tap}`} aria-expanded={open} onClick={() => setOpen(!open)}>{open ? "Show less" : "Show all"}</button>}
    </div>
  );
}

const newestFirst = (a: { created_at: string }, b: { created_at: string }) => b.created_at.localeCompare(a.created_at);

export function Timeline({ clientId, clientName }: { clientId: string; /** For a call from or to the client's own phone: "Missed call from Ana". */ clientName?: string }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const [note, setNote] = useState("");
  const [limit, setLimit] = useState(25);
  const listRef = useListAnimation<HTMLDivElement>();
  // Every page size loaded so far is under this key, so adding and deleting reach them all.
  const key = ["client", clientId, "messages"];
  const messages = useQuery({
    queryKey: [...key, limit],
    queryFn: async () =>
      unwrap(
        await supabase()
          .from("messages")
          .select(SELECT)
          .eq("client_id", clientId)
          .order("created_at", { ascending: false })
          .limit(limit + 1),
      ),
  });
  type Message = NonNullable<typeof messages.data>[number];

  // The note shows at the top of the list and the button says it's added, so there's no toast.
  const add = useMutation({
    mutationFn: async () =>
      unwrap(
        await supabase()
          .from("messages")
          .insert({ company_id: session.company.id, client_id: clientId, channel: "note", direction: "internal", body: note.trim() })
          .select(SELECT)
          .single(),
      ),
    onSuccess: (row) => {
      setNote("");
      queryClient.setQueriesData<Message[]>({ queryKey: key }, (rows) => (rows && !rows.some((r) => r.id === row.id) ? [row, ...rows] : rows));
      queryClient.invalidateQueries({ queryKey: key });
    },
  });
  const added = useJustDone(add);
  const remove = useMutation({
    // Undo's toast says how it went (removeLater below).
    meta: { inline: true },
    mutationFn: async (id: string) => unwrap(await supabase().from("messages").delete().eq("id", id)),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: key }),
  });

  /** Takes the note off the list at once; it's deleted when the Undo toast leaves. */
  const removeLater = (m: Message) =>
    undoable({
      title: "Note deleted",
      hide: () => {
        void queryClient.cancelQueries({ queryKey: key });
        queryClient.setQueriesData<Message[]>({ queryKey: key }, (rows) => rows?.filter((r) => r.id !== m.id));
      },
      restore: () => queryClient.setQueriesData<Message[]>({ queryKey: key }, (rows) => (rows && !rows.some((r) => r.id === m.id) ? [...rows, m].sort(newestFirst) : rows)),
      commit: () => remove.mutateAsync(m.id),
    });

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (note.trim() && !add.isPending) add.mutate();
  };
  const rows = messages.data?.slice(0, limit) ?? [];
  const canDelete = hasRole(session, "admin", "office");

  return (
    <Section title="Notes and messages">
      <form className={styles.compose} onSubmit={submit}>
        <label className="sr-only" htmlFor="note">Add a note</label>
        <textarea
          id="note"
          className="textarea"
          rows={1}
          placeholder="Add an internal note: gate quirks, preferences, history…"
          value={note}
          maxLength={4000}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
          }}
        />
        {/* Like a message's send button: nothing to add until there's text. */}
        <Button type="submit" loading={add.isPending} done={added} doneLabel="Added" disabled={!note.trim()}>Add note</Button>
      </form>
      {messages.isPending && (
        <div className="timeline" aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <div key={i} className="timeline-item">
              <Skeleton width={28} height={28} radius={999} />
              <span className="stack-sm"><Skeleton width={140} height={10} /><Skeleton width="80%" height={12} /></span>
            </div>
          ))}
        </div>
      )}
      {messages.error && <ErrorState compact error={messages.error} onRetry={() => messages.refetch()} />}
      {messages.data?.length === 0 && <EmptyState inline title="No notes or messages yet" />}
      <div ref={listRef} className="timeline">
        {rows.map((m) => {
          const people = messagePeople(m);
          // A call with its details says how it went; an older one without them reads as its words.
          const call = m.channel === "call" ? callView(m, callWith(m, clientName)) : null;
          return (
            <div key={m.id} className={`timeline-item ${styles.entry}`} data-kind={m.channel} data-outcome={call?.outcome}>
              <span className="t-icon"><Icon name={call ? callIcon(call.outcome) : (ICON[m.channel] ?? "note")} size={14} /></span>
              <div className={styles.entryText}>
                <div>
                  <span className={styles.who} title={people.toFull ?? undefined}>{call ? call.title : label(m)}</span>
                  {m.origin === "quo_import" && <span className={styles.origin} title={t("Brought in from Quo's history")}> · {t("From Quo")}</span>}
                  {m.status === "failed" && <span className={styles.failed}><StatusPill label="Failed" tone="danger" /></span>}
                  {people.missed && <span className={styles.missed}> · Didn't reach {people.missed}</span>}
                </div>
                {/* An email's subject on its own line under who it went to (Page-Client.dc.html). */}
                {m.subject && <div className={styles.subjectLine}>{m.subject}</div>}
                {call ? <CallBody view={call} /> : <EntryBody m={m} />}
              </div>
              <span className={styles.when}>
                <time dateTime={m.created_at} title={formatDateTime(m.created_at)}>{timeAgo(m.created_at)}</time>
                {m.channel === "note" && m.direction === "internal" && (canDelete || m.sent_by === session.userId) && (
                  <Button size="sm" variant="ghost" icon="trash" aria-label="Delete note" title="Delete note" onClick={() => removeLater(m)} />
                )}
              </span>
            </div>
          );
        })}
      </div>
      {(messages.data?.length ?? 0) > limit && (
        <div className={styles.older}><Button size="sm" variant="ghost" onClick={() => setLimit((l) => l + 25)}>Show older</Button></div>
      )}
    </Section>
  );
}
