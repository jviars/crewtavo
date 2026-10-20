/**
 * Writing a message: text with @mentions picked from a list as you type, up to six photos (taken or
 * chosen; shrunk before they upload), a job to link, and a reply. Enter sends on a computer; on a
 * phone the send button does. A half-written message waits for you when you come back to the channel.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent } from "react";
import { fromEditable, matchMentions, type Mentionable } from "@crewtavo/core/chat";
import { Dialog } from "@/components/ui/Dialog";
import { Icon } from "@/components/ui/Icon";
import { api, supabase } from "@/lib/api";
import { uploadFile } from "@/lib/files";
import { useSession } from "@/lib/session";
import { addMessage, useTyping, type ChatChannel, type ChatMessage } from "./data";
import { Avatar, roleColor } from "./ui";
import s from "./chat.module.css";

export interface MentionOption extends Mentionable {
  kind: "user" | "role" | "everyone";
  color?: string | null;
  avatar?: string | null;
  photo?: string | null;
  hint?: string;
}

interface Upload {
  id: string;
  name: string;
  preview: string;
  status: "uploading" | "done" | "error";
  path?: string;
}

interface Draft {
  text: string;
  picked: MentionOption[];
}

/** Drafts by channel, for as long as the tab is open. */
const drafts = new Map<string, Draft>();
const MAX_PHOTOS = 6;
const coarse = () => window.matchMedia("(pointer: coarse)").matches;

export function Composer({
  channel,
  options,
  replyTo,
  onCancelReply,
  focusKey,
  insert,
}: {
  channel: ChatChannel;
  options: MentionOption[];
  replyTo: ChatMessage | null;
  onCancelReply: () => void;
  /** Changes when something asks for the box (Reply, Mention): focus it then. */
  focusKey: string;
  /** A mention to add at the end of what's typed (Mention, from someone's profile). */
  insert?: { option: MentionOption; nonce: number } | null;
}) {
  const session = useSession();
  const queryClient = useQueryClient();
  const saved = drafts.get(channel.id);
  const [text, setText] = useState(saved?.text ?? "");
  const [picked, setPicked] = useState<MentionOption[]>(saved?.picked ?? []);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [job, setJob] = useState<JobPick | null>(null);
  const [pickingJob, setPickingJob] = useState(false);
  const [suggest, setSuggest] = useState<{ query: string; start: number; index: number } | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const files = useRef<HTMLInputElement>(null);
  const lastTyping = useRef(0);

  // Another channel: keep this one's draft, bring back that one's.
  useEffect(() => {
    const draft = drafts.get(channel.id);
    setText(draft?.text ?? "");
    setPicked(draft?.picked ?? []);
    setUploads([]);
    setJob(null);
    setSuggest(null);
  }, [channel.id]);
  useEffect(() => {
    if (text || picked.length) drafts.set(channel.id, { text, picked });
    else drafts.delete(channel.id);
  }, [channel.id, text, picked]);
  useEffect(() => {
    if (focusKey && input.current) {
      input.current.focus();
      const end = input.current.value.length;
      input.current.setSelectionRange(end, end);
    }
  }, [focusKey]);
  useEffect(() => {
    if (!insert) return;
    const { option } = insert;
    setText((t) => `${t}${t && !/\s$/.test(t) ? " " : ""}@${option.label} `);
    setPicked((list) => [...list.filter((p) => p.token !== option.token), option]);
  }, [insert]);
  // Grow with what's typed, up to a few lines.
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
    el.style.overflowY = el.scrollHeight > 200 ? "auto" : "hidden";
  }, [text]);

  const matches = useMemo(() => (suggest ? matchMentions(options, suggest.query) : []), [options, suggest]);

  const send = useMutation({
    mutationFn: (payload: { body: string; attachments: Array<{ path: string; name: string }>; job_id: string | null; reply_to: string | null }) =>
      api.post<{ message: ChatMessage }>(`/chat/channels/${channel.id}/messages`, payload),
    onSuccess: ({ message }) => addMessage(queryClient, session.company.id, message),
  });

  const ready = uploads.every((u) => u.status !== "uploading");
  const photos = uploads.filter((u) => u.status === "done" && u.path);
  const canSend = ready && !send.isPending && (text.trim().length > 0 || photos.length > 0 || Boolean(job));

  const submit = () => {
    if (!canSend) return;
    const body = fromEditable(text.trim(), picked);
    const payload = { body, attachments: photos.map((u) => ({ path: u.path!, name: u.name })), job_id: job?.id ?? null, reply_to: replyTo?.id ?? null };
    send.mutate(payload, {
      onSuccess: () => {
        setText("");
        setPicked([]);
        uploads.forEach((u) => URL.revokeObjectURL(u.preview));
        setUploads([]);
        setJob(null);
        onCancelReply();
        drafts.delete(channel.id);
      },
    });
  };

  /** Is the caret just after "@something"? Then offer people and roles that match it. */
  const lookForMention = (value: string, caret: number) => {
    const before = value.slice(0, caret);
    const m = /(^|\s)@([^\s@]{0,30}(?: [^\s@]{0,30})?)$/.exec(before);
    if (!m) return setSuggest(null);
    const query = m[2];
    if (query.includes(" ") && !matchMentions(options, query).length) return setSuggest(null);
    setSuggest((current) => ({ query, start: caret - query.length - 1, index: current?.query === query ? current.index : 0 }));
  };

  const choose = (option: MentionOption) => {
    if (!suggest || !input.current) return;
    const caret = input.current.selectionStart ?? text.length;
    const added = option.kind === "everyone" ? "@everyone " : `@${option.label} `;
    const next = text.slice(0, suggest.start) + added + text.slice(caret);
    setText(next);
    if (option.kind !== "everyone") setPicked((list) => [...list.filter((p) => p.token !== option.token), option]);
    setSuggest(null);
    requestAnimationFrame(() => {
      const at = suggest.start + added.length;
      input.current?.focus();
      input.current?.setSelectionRange(at, at);
    });
  };

  const onChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    setText(e.target.value);
    lookForMention(e.target.value, e.target.selectionStart ?? e.target.value.length);
    send.reset();
    const now = Date.now();
    if (e.target.value.trim() && now - lastTyping.current > 3_000) {
      lastTyping.current = now;
      api.post(`/chat/channels/${channel.id}/typing`).catch(() => undefined);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (suggest && matches.length) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const step = e.key === "ArrowDown" ? 1 : -1;
        setSuggest({ ...suggest, index: (suggest.index + step + matches.length) % matches.length });
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        choose(matches[suggest.index] ?? matches[0]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setSuggest(null);
        return;
      }
    }
    if (e.key === "Escape" && replyTo) {
      onCancelReply();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && !coarse()) {
      e.preventDefault();
      submit();
    }
  };

  const addPhotos = (list: FileList | null) => {
    const chosen = [...(list ?? [])].filter((f) => f.type.startsWith("image/") || /\.(heic|heif)$/i.test(f.name)).slice(0, MAX_PHOTOS - uploads.length);
    if (files.current) files.current.value = "";
    for (const file of chosen) {
      const id = crypto.randomUUID();
      setUploads((u) => [...u, { id, name: file.name, preview: URL.createObjectURL(file), status: "uploading" }]);
      uploadFile(session.company.id, `chat/${channel.id}`, file).then(
        (path) => setUploads((u) => u.map((x) => (x.id === id ? { ...x, status: "done", path } : x))),
        () => setUploads((u) => u.map((x) => (x.id === id ? { ...x, status: "error" } : x))),
      );
    }
  };

  if (!channel.can_post) {
    return (
      <div className={s.foot}>
        <div className={s.readOnly} role="note">
          <Icon name={channel.archived ? "archive" : "lock"} size={16} />
          {channel.archived
            ? "This channel is archived. You can read it, but nobody can post in it."
            : channel.kind === "announcement"
              ? "Owners, admins and the office post here. You can read and react."
              : "Your role can read this channel but not post in it."}
        </div>
      </div>
    );
  }

  const placeholder = channel.kind === "announcement" ? `Message ${channel.name}` : `Message #${channel.name}`;
  return (
    <div className={s.foot}>
      <TypingLine channelId={channel.id} />
      <div className={s.composer}>
        {suggest && matches.length > 0 && (
          <div className={s.suggest} role="listbox" aria-label="People and roles to mention">
            <div className={s.suggestHead}>Mention</div>
            {matches.map((o, i) => (
              <button
                key={o.token}
                type="button"
                role="option"
                aria-selected={i === suggest.index}
                className={s.suggestItem}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(o)}
              >
                {o.kind === "user" ? <Avatar name={o.label} color={o.avatar} photo={o.photo} size={28} /> : <Icon name={o.kind === "everyone" ? "users" : "mention"} size={18} />}
                <span style={{ fontWeight: 700, color: o.kind === "role" ? roleColor(o.color) : undefined }}>{o.kind === "everyone" ? "@everyone" : o.label}</span>
                {o.hint && <small>{o.hint}</small>}
              </button>
            ))}
          </div>
        )}
        {replyTo && (
          <div className={s.bar}>
            <Icon name="reply" size={15} />
            <span className="grow">Replying to <strong>{replyTo.author?.name ?? "Crewtavo"}</strong></span>
            <button type="button" className="icon-btn" aria-label="Cancel reply" onClick={onCancelReply}><Icon name="x" size={15} /></button>
          </div>
        )}
        {(uploads.length > 0 || job) && (
          <div className={s.chips}>
            {uploads.map((u) => (
              <span key={u.id} className={s.chip} title={u.status === "error" ? "Couldn't upload this photo" : u.name}>
                <img src={u.preview} alt="" />
                <span>{u.status === "uploading" ? "Uploading…" : u.status === "error" ? "Didn't upload" : u.name}</span>
                <button type="button" className="icon-btn" aria-label={`Remove ${u.name}`} onClick={() => setUploads((list) => list.filter((x) => x.id !== u.id))}><Icon name="x" size={13} /></button>
              </span>
            ))}
            {job && (
              <span className={s.chip}>
                <span className={s.jobIcon}><Icon name="job" size={16} /></span>
                <span>{job.number ? `Job #${job.number} · ` : ""}{job.title}</span>
                <button type="button" className="icon-btn" aria-label="Remove the job" onClick={() => setJob(null)}><Icon name="x" size={13} /></button>
              </span>
            )}
          </div>
        )}
        <div className={s.composerRow}>
          <button type="button" className={`icon-btn ${s.composerBtn}`} aria-label="Add photos" title="Add photos" disabled={uploads.length >= MAX_PHOTOS} onClick={() => files.current?.click()}>
            <Icon name="camera" size={20} />
          </button>
          <input ref={files} type="file" accept="image/*,.heic,.heif" multiple hidden onChange={(e) => addPhotos(e.target.files)} />
          <textarea
            ref={input}
            className={s.composerInput}
            rows={1}
            value={text}
            placeholder={placeholder}
            aria-label={placeholder}
            onChange={onChange}
            onKeyDown={onKeyDown}
            onClick={(e) => lookForMention(e.currentTarget.value, e.currentTarget.selectionStart ?? 0)}
            onBlur={() => setTimeout(() => setSuggest(null), 150)}
            maxLength={4000}
          />
          <button type="button" className={`icon-btn ${s.composerBtn}`} aria-label="Link a job" title="Link a job" onClick={() => setPickingJob(true)}>
            <Icon name="job" size={19} />
          </button>
          <button type="button" className={s.sendBtn} aria-label="Send" title="Send" disabled={!canSend} onClick={submit}>
            <Icon name="send" size={18} />
          </button>
        </div>
      </div>
      {send.error && <div className="field-error" style={{ marginTop: 6 }}>{(send.error as Error).message}</div>}
      <JobPicker open={pickingJob} onClose={() => setPickingJob(false)} onPick={(j) => { setJob(j); setPickingJob(false); input.current?.focus(); }} />
    </div>
  );
}

function TypingLine({ channelId }: { channelId: string }) {
  const session = useSession();
  const names = useTypingNames(channelId, session.userId);
  const text = names.length === 0 ? "" : names.length === 1 ? `${names[0]} is typing…` : names.length === 2 ? `${names[0]} and ${names[1]} are typing…` : "Several people are typing…";
  return (
    <div className={s.typing} aria-live="polite">
      {text && (
        <>
          <span className={s.dots} aria-hidden="true"><i /><i /><i /></span>
          <span>{text}</span>
        </>
      )}
    </div>
  );
}

function useTypingNames(channelId: string, me: string) {
  const names = useTyping(channelId, me);
  // Re-check every few seconds so a name goes once they stop.
  const [, tick] = useState(0);
  useEffect(() => {
    if (!names.length) return;
    const timer = setInterval(() => tick((n) => n + 1), 2_000);
    return () => clearInterval(timer);
  }, [names.length]);
  return names;
}

interface JobPick {
  id: string;
  number: number | null;
  title: string;
}

/** Pick a job to link: recent ones first, or search by title or number. */
function JobPicker({ open, onClose, onPick }: { open: boolean; onClose: () => void; onPick: (job: JobPick) => void }) {
  const { company } = useSession();
  const [q, setQ] = useState("");
  const jobs = useQuery({
    queryKey: ["chat-job-search", company.id, q.trim()],
    enabled: open,
    queryFn: async () => {
      let query = supabase().from("jobs").select("id, number, title, status, client:clients(display_name)").eq("company_id", company.id).neq("status", "archived").order("updated_at", { ascending: false }).limit(12);
      const term = q.trim();
      if (/^#?\d+$/.test(term)) query = query.eq("number", Number(term.replace("#", "")));
      else if (term) query = query.ilike("title", `%${term.replace(/[%_]/g, "")}%`);
      const { data, error } = await query;
      if (error) throw new Error(error.message);
      return data as unknown as Array<JobPick & { status: string; client: { display_name: string } | null }>;
    },
  });
  return (
    <Dialog open={open} onClose={onClose} title="Link a job" size="sm">
      <div className="dialog-body stack-sm">
        <input className="input" type="search" placeholder="Search jobs by title or number" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search jobs" />
        {jobs.isPending && <span className="muted small">Loading jobs…</span>}
        {jobs.data?.length === 0 && <span className="muted small">No jobs match.</span>}
        <div className="stack-sm" style={{ gap: 4 }}>
          {jobs.data?.map((j) => (
            <button key={j.id} type="button" className="card-row" style={{ border: "1px solid var(--border)", borderRadius: 10, background: "var(--surface)", textAlign: "left", cursor: "pointer" }} onClick={() => onPick(j)}>
              <span className={s.jobIcon}><Icon name="job" size={16} /></span>
              <span className="grow">
                <strong style={{ display: "block" }}>{j.number ? `#${j.number} · ` : ""}{j.title}</strong>
                <span className="muted small">{j.client?.display_name ?? ""}</span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </Dialog>
  );
}
