/** Notes, emails and texts for a client, newest first, with a note composer (Ctrl/⌘+Enter saves). */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { Icon, type IconName } from "@/components/ui/Icon";
import { Skeleton } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState } from "@/components/ui/States";
import { supabase, unwrap } from "@/lib/api";
import { formatDateTime, timeAgo } from "@/lib/format";
import { hasRole, useSession } from "@/lib/session";

const ICON: Record<string, IconName> = { note: "note", email: "mail", sms: "messages", call: "phone" };

function label(m: { channel: string; direction: string; subject: string | null }) {
  if (m.channel === "note") return m.direction === "in" ? "From client" : "Note";
  const what = m.channel === "email" ? "Email" : m.channel === "sms" ? "Text" : "Call";
  return m.direction === "in" ? `${what} from client` : `${what} sent`;
}

export function Timeline({ clientId }: { clientId: string }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const [note, setNote] = useState("");
  const [limit, setLimit] = useState(25);
  const key = ["client", clientId, "messages", limit];
  const messages = useQuery({
    queryKey: key,
    queryFn: async () =>
      unwrap(
        await supabase()
          .from("messages")
          .select("id, channel, direction, subject, body, status, created_at, sent_by")
          .eq("client_id", clientId)
          .order("created_at", { ascending: false })
          .limit(limit + 1),
      ),
  });
  const add = useMutation({
    meta: { success: "Note added" },
    mutationFn: async () => unwrap(await supabase().from("messages").insert({ company_id: session.company.id, client_id: clientId, channel: "note", direction: "internal", body: note.trim() }).select("id").single()),
    onSuccess: () => {
      setNote("");
      queryClient.invalidateQueries({ queryKey: ["client", clientId, "messages"] });
    },
  });
  const remove = useMutation({
    meta: { success: "Note deleted" },
    mutationFn: async (id: string) => unwrap(await supabase().from("messages").delete().eq("id", id)),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["client", clientId, "messages"] }),
  });
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (note.trim() && !add.isPending) add.mutate();
  };
  const rows = messages.data?.slice(0, limit) ?? [];
  const canDelete = hasRole(session, "admin", "office");

  return (
    <section className="stack" aria-labelledby="timeline-title">
      <h2 id="timeline-title" className="section-title">Notes and messages</h2>
      <form className="card card-pad stack-sm" onSubmit={submit}>
        <label className="sr-only" htmlFor="note">Add a note</label>
        <textarea
          id="note"
          className="textarea"
          placeholder="Add an internal note: gate quirks, preferences, history…"
          value={note}
          maxLength={4000}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
          }}
        />
        <div className="row-between">
          <span />
          <Button size="sm" type="submit" variant="primary" loading={add.isPending} disabled={!note.trim()}>Add note</Button>
        </div>
      </form>
      <div className="card">
        {messages.isPending &&
          [0, 1, 2].map((i) => (
            <div key={i} className="timeline-item">
              <Skeleton width={32} height={32} radius={10} />
              <span className="stack-sm"><Skeleton width={140} height={10} /><Skeleton width="80%" height={12} /></span>
            </div>
          ))}
        {messages.error && <ErrorState compact error={messages.error} onRetry={() => messages.refetch()} />}
        {messages.data?.length === 0 && <EmptyState compact icon="messages" title="No notes or messages yet" />}
        <div className="timeline">
          {rows.map((m) => (
            <div key={m.id} className="timeline-item" data-kind={m.channel}>
              <span className="t-icon"><Icon name={ICON[m.channel] ?? "note"} size={15} /></span>
              <div style={{ minWidth: 0 }}>
                <div className="row-between">
                  <span className="t-meta">
                    <strong style={{ color: "var(--ink)" }}>{label(m)}</strong>
                    {m.subject ? ` · ${m.subject}` : ""} · <span title={formatDateTime(m.created_at)}>{timeAgo(m.created_at)}</span>
                    {m.status === "failed" && <span className="chip chip-red" style={{ marginLeft: 6 }}>Failed</span>}
                  </span>
                  {m.channel === "note" && m.direction === "internal" && (canDelete || m.sent_by === session.userId) && (
                    <button
                      type="button"
                      className="icon-btn"
                      style={{ width: 28, height: 28 }}
                      aria-label="Delete note"
                      onClick={async () => {
                        if (await confirm({ title: "Delete this note?", confirmLabel: "Delete", danger: true })) remove.mutate(m.id);
                      }}
                    >
                      <Icon name="trash" size={14} />
                    </button>
                  )}
                </div>
                <div className="pre-wrap" style={{ marginTop: 2 }}>{m.body}</div>
              </div>
            </div>
          ))}
        </div>
        {(messages.data?.length ?? 0) > limit && (
          <div className="list-foot"><span /><Button size="sm" onClick={() => setLimit((l) => l + 25)}>Show older</Button></div>
        )}
      </div>
    </section>
  );
}
