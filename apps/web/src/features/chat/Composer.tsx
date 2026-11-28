/**
 * Writing a message: text with @mentions picked from a list as you type, up to six photos and
 * documents (PDF, Word, Excel, PowerPoint, text, CSV: taken, chosen, pasted or dropped on the box;
 * photos shrunk before they upload), a job to link, and a reply. The
 * text can be formatted with Markdown (**bold**, _italics_, lists…; Ctrl+B and Ctrl+I mark a word).
 * Enter sends on a computer; on a phone the send button does. A half-written message waits for you
 * when you come back to the channel.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent, type ClipboardEvent, type DragEvent, type KeyboardEvent } from "react";
import { fromEditable, matchMentions, type Mentionable } from "@crewtavo/core/chat";
import { CHAT_DOCUMENT_ACCEPT, CHAT_MAX_FILES, chatDocumentType, chatFileKind } from "@crewtavo/core/chatContent";
import { Dialog } from "@/components/ui/Dialog";
import { Icon } from "@/components/ui/Icon";
import { Menu } from "@/components/ui/Menu";
import { SearchField } from "@/components/ui/Toolbar";
import { RefusedForSpace, useStorageFull } from "@/features/settings/storage";
import { api, supabase } from "@/lib/api";
import { storedType, uploadFile } from "@/lib/files";
import { useSession } from "@/lib/session";
import { toast } from "@/lib/toast";
import { DOCUMENT_ICONS } from "./ChatFiles";
import { addMessage, useTyping, type ChatChannel, type ChatMessage } from "./data";
import { EmojiPicker } from "./EmojiPicker";
import { Avatar, roleColor } from "./ui";
import s from "./chat.module.css";
import f from "./chatFiles.module.css";
import { t, T } from "@/lib/i18n";

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
  /** A photo's picture while it uploads; a document has its icon instead. */
  preview: string | null;
  status: "uploading" | "done" | "error";
  path?: string;
  type?: string;
  size?: number;
}

interface Draft {
  text: string;
  picked: MentionOption[];
}

/** Drafts by channel, for as long as the tab is open. */
const drafts = new Map<string, Draft>();
const MAX_FILES = CHAT_MAX_FILES;
const coarse = () => window.matchMedia("(pointer: coarse)").matches;
const isPhoto = (f: File) => f.type.startsWith("image/") || /\.(heic|heif)$/i.test(f.name);
/** A document a message can carry, by its name's ending (core chatFileKind, as the database allows). */
const isDocument = (f: File) => !isPhoto(f) && chatFileKind({ name: f.name }) === "document";

/** A pasted picture has no name of its own ("image.png"): call it what it is. */
function pastedName(file: File, n: number): File {
  if (file.name && !/^image\.\w+$/i.test(file.name)) return file;
  const ext = file.type.split("/")[1]?.replace("jpeg", "jpg") || "png";
  return new File([file], `${t("Pasted image")}${n ? ` ${n + 1}` : ""}.${ext}`, { type: file.type, lastModified: file.lastModified });
}

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
  const storageFull = useStorageFull();
  const saved = drafts.get(channel.id);
  const [text, setText] = useState(saved?.text ?? "");
  const [picked, setPicked] = useState<MentionOption[]>(saved?.picked ?? []);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [job, setJob] = useState<JobPick | null>(null);
  const [pickingJob, setPickingJob] = useState(false);
  const [suggest, setSuggest] = useState<{ query: string; start: number; index: number } | null>(null);
  const [dropping, setDropping] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const files = useRef<HTMLInputElement>(null);
  const camera = useRef<HTMLInputElement>(null);
  const documents = useRef<HTMLInputElement>(null);
  const lastTyping = useRef(0);
  /** Where the caret goes once the text just set is in the box (Ctrl+B, Ctrl+I), before the next key lands. */
  const caret = useRef<[number, number] | null>(null);
  useLayoutEffect(() => {
    if (!caret.current || !input.current) return;
    input.current.setSelectionRange(...caret.current);
    caret.current = null;
  }, [text]);

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
    mutationFn: (payload: { body: string; attachments: Array<{ path: string; name: string; type?: string; size?: number }>; job_id: string | null; reply_to: string | null }) =>
      api.post<{ message: ChatMessage }>(`/chat/channels/${channel.id}/messages`, payload),
    onSuccess: ({ message }) => addMessage(queryClient, session.company.id, message),
  });

  const ready = uploads.every((u) => u.status !== "uploading");
  const done = uploads.filter((u) => u.status === "done" && u.path);
  const canSend = ready && !send.isPending && (text.trim().length > 0 || done.length > 0 || Boolean(job));

  const submit = () => {
    if (!canSend) return;
    const body = fromEditable(text.trim(), picked);
    const attachments = done.map((u) => ({ path: u.path!, name: u.name, ...(u.type ? { type: u.type } : {}), ...(u.size !== undefined ? { size: u.size } : {}) }));
    const payload = { body, attachments, job_id: job?.id ?? null, reply_to: replyTo?.id ?? null };
    send.mutate(payload, {
      onSuccess: () => {
        setText("");
        setPicked([]);
        uploads.forEach((u) => u.preview && URL.revokeObjectURL(u.preview));
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
    const mod = (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey;
    if (mod && (e.key === "b" || e.key === "i")) {
      e.preventDefault();
      wrap(e.key === "b" ? "**" : "_");
      return;
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

  /** Ctrl+B, Ctrl+I: the selected words between Markdown's marks, or the marks with the caret between them. */
  const wrap = (mark: string) => {
    const el = input.current;
    if (!el) return;
    const start = el.selectionStart ?? text.length;
    const end = el.selectionEnd ?? start;
    const words = text.slice(start, end);
    const marked = words.startsWith(mark) && words.endsWith(mark) && words.length >= mark.length * 2;
    const middle = marked ? words.slice(mark.length, words.length - mark.length) : `${mark}${words}${mark}`;
    caret.current = words ? [start, start + middle.length] : [start + mark.length, start + mark.length];
    setText(text.slice(0, start) + middle + text.slice(end));
  };

  /** An emoji from the picker, where the cursor is (in place of what's selected). */
  const insertEmoji = (emoji: string) => {
    const el = input.current;
    const start = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? start;
    caret.current = [start + emoji.length, start + emoji.length];
    setText(text.slice(0, start) + emoji + text.slice(end));
    el?.focus();
  };

  /** Photos and documents, from the pickers, a paste or a drop. Anything else is said no to, by name. */
  const addFiles = (list: FileList | File[] | null) => {
    const given = [...(list ?? [])];
    const all = given.filter((file) => isPhoto(file) || isDocument(file));
    const chosen = all.slice(0, Math.max(0, MAX_FILES - uploads.length));
    for (const picker of [files, camera, documents]) if (picker.current) picker.current.value = "";
    const other = given.find((file) => !all.includes(file));
    if (other) toast.warning(t("{name} can't go in a message. Send photos, or PDF, Word, Excel, PowerPoint, text or CSV files.", { name: other.name }));
    if (all.length > chosen.length) toast.warning(t("A message takes up to {count} photos and files.", { count: MAX_FILES }));
    // Files turned away for space are told about once, together, with why and who can make room.
    const refused = new RefusedForSpace();
    const sent = chosen.map((file) => {
      const id = crypto.randomUUID();
      const photo = isPhoto(file);
      setUploads((u) => [...u, { id, name: file.name, preview: photo ? URL.createObjectURL(file) : null, status: "uploading", size: photo ? undefined : file.size }]);
      return uploadFile(session.company.id, `chat/${channel.id}`, file).then(
        (path) => setUploads((u) => u.map((x) => (x.id === id ? { ...x, status: "done", path, type: photo ? storedType(path, file) : file.type || undefined } : x))),
        (error: unknown) => {
          setUploads((u) => u.map((x) => (x.id === id ? { ...x, status: "error" } : x)));
          refused.add(error, file.name, file.size);
        },
      );
    });
    void Promise.all(sent).then(() => {
      if (refused.first) storageFull(refused.first, refused.title());
    });
  };

  // A screenshot or a copied photo pastes in as a photo. Copied text that brings a picture of itself
  // along (Word, a spreadsheet) still pastes as text. A copied document (a PDF from the computer's
  // files, which brings its name as text) pastes in as the document.
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const data = e.clipboardData;
    const pasted = [...data.items].filter((i) => i.kind === "file").map((i) => i.getAsFile()).filter((f): f is File => Boolean(f));
    const docs = pasted.filter(isDocument);
    const pictures = data.getData("text/plain").trim() ? [] : pasted.filter(isPhoto);
    if (!docs.length && !pictures.length) return;
    e.preventDefault();
    addFiles([...pictures.map(pastedName), ...docs]);
  };
  const hasFiles = (e: DragEvent) => [...e.dataTransfer.types].includes("Files");
  const onDragOver = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    setDropping(true);
  };
  const onDrop = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    setDropping(false);
    addFiles([...e.dataTransfer.files]);
  };

  if (!channel.can_post) {
    return (
      <div className={s.foot}>
        <div className={s.readOnly} role="note">
          <Icon name={channel.archived ? "archive" : "lock"} size={16} />
          {channel.archived
            ? t("This channel is archived. You can read it, but nobody can post in it.")
            : channel.kind === "announcement"
              ? t("Owners, admins and the office post here. You can read and react.")
              : t("Your role can read this channel but not post in it.")}
        </div>
      </div>
    );
  }

  const placeholder = t("Message {channel}", { channel: channel.kind === "announcement" ? channel.name : `#${channel.name}` });
  return (
    <div className={s.foot}>
      <div
        className={s.composer}
        data-dropping={dropping || undefined}
        onDragOver={onDragOver}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false); }}
        onDrop={onDrop}
      >
        <TypingLine channelId={channel.id} />
        {suggest && matches.length > 0 && (
          <div className={s.suggest} role="listbox" aria-label={t("People and roles to mention")}>
            <div className={s.suggestHead}>{t("Mention")}</div>
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
                {o.kind === "user" ? <Avatar name={o.label} color={o.avatar} photo={o.photo} size={22} /> : <Icon name={o.kind === "everyone" ? "users" : "mention"} size={16} />}
                <span style={{ fontWeight: 600, color: o.kind === "role" ? roleColor(o.color) : undefined }}>{o.kind === "everyone" ? t("@everyone") : o.label}</span>
                {o.hint && <small>{o.hint}</small>}
              </button>
            ))}
          </div>
        )}
        {replyTo && (
          <div className={s.bar}>
            <Icon name="reply" size={14} />
            <span className="grow"><T text="Replying to <b>{name}</b>" b={(s) => <strong>{s}</strong>} name={replyTo.author?.name ?? "Crewtavo"} /></span>
            <button type="button" className="icon-btn" aria-label={t("Cancel reply")} onClick={onCancelReply}><Icon name="x" size={14} /></button>
          </div>
        )}
        {(uploads.length > 0 || job) && (
          <div className={s.chips}>
            {uploads.map((u) => (
              <span key={u.id} className={s.chip} title={u.status === "error" ? t("Couldn't upload this file") : u.name}>
                {u.preview ? <img src={u.preview} alt="" /> : <span className={f.chipIcon}><Icon name={DOCUMENT_ICONS[chatDocumentType({ name: u.name })]} size={18} /></span>}
                <span>{u.status === "uploading" ? t("Uploading…") : u.status === "error" ? t("Didn't upload") : u.name}</span>
                <button type="button" className="icon-btn" aria-label={t("Remove {tag}", { tag: u.name })} onClick={() => setUploads((list) => list.filter((x) => x.id !== u.id))}><Icon name="x" size={14} /></button>
              </span>
            ))}
            {job && (
              <span className={s.chip}>
                <span className={s.jobIcon}><Icon name="job" size={15} /></span>
                <span>{job.number ? `${t("Job #{number}", { number: job.number })} · ` : ""}{job.title}</span>
                <button type="button" className="icon-btn" aria-label={t("Remove the job")} onClick={() => setJob(null)}><Icon name="x" size={14} /></button>
              </span>
            )}
          </div>
        )}
        <div className={s.composerRow}>
          <Menu
            label={t("Add photos or files")}
            title={t("Add photos or files")}
            align="start"
            triggerClassName={s.composerBtn}
            trigger={<Icon name="plus" size={17} />}
            items={[
              // On a computer the camera button would open the same file chooser as photos.
              { label: t("Take a photo"), icon: "camera", onSelect: () => camera.current?.click(), hidden: !coarse(), disabled: uploads.length >= MAX_FILES },
              { label: t("Choose photos"), icon: "image", onSelect: () => files.current?.click(), disabled: uploads.length >= MAX_FILES },
              { label: t("Choose a file"), icon: "paperclip", description: t("PDF, Word, Excel, PowerPoint, text or CSV, up to 15 MB"), onSelect: () => documents.current?.click(), disabled: uploads.length >= MAX_FILES },
            ]}
          />
          <input ref={files} type="file" accept="image/*,.heic,.heif" multiple hidden onChange={(e) => addFiles(e.target.files)} />
          <input ref={camera} type="file" accept="image/*" capture="environment" hidden onChange={(e) => addFiles(e.target.files)} />
          <input ref={documents} type="file" accept={CHAT_DOCUMENT_ACCEPT} multiple hidden onChange={(e) => addFiles(e.target.files)} />
          <textarea
            ref={input}
            className={s.composerInput}
            rows={1}
            value={text}
            placeholder={placeholder}
            aria-label={placeholder}
            onChange={onChange}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            onClick={(e) => lookForMention(e.currentTarget.value, e.currentTarget.selectionStart ?? 0)}
            onBlur={() => setTimeout(() => setSuggest(null), 150)}
            maxLength={4000}
          />
          {/* On a phone, the keyboard has its own emoji. */}
          <EmojiPicker label={t("Add an emoji")} triggerClassName={`${s.composerBtn} hide-mobile`} trigger={<Icon name="react" size={17} />} onPick={insertEmoji} />
          <button type="button" className={`btn btn-sm ${s.jobBtn}`} aria-label={t("Link a job")} title={t("Link a job")} onClick={() => setPickingJob(true)}>
            <Icon name="job" size={15} /><span className={s.jobText}>{t("Link a job")}</span>
          </button>
          <button type="button" className={`btn btn-sm btn-primary ${s.sendBtn}`} aria-label={t("Send")} disabled={!canSend} onClick={submit}>
            <span className={s.sendIcon} aria-hidden="true"><Icon name="arrowUp" size={19} /></span>
            <span className={s.sendText}>{t("Send")}</span>
          </button>
        </div>
      </div>
      {send.error && <div className="field-error" style={{ margin: "6px 4px 0" }}>{(send.error as Error).message}</div>}
      <JobPicker open={pickingJob} onClose={() => setPickingJob(false)} onPick={(j) => { setJob(j); setPickingJob(false); input.current?.focus(); }} />
    </div>
  );
}

function TypingLine({ channelId }: { channelId: string }) {
  const session = useSession();
  const names = useTypingNames(channelId, session.userId);
  const text = names.length === 0 ? "" : names.length === 1 ? t("{name} is typing…", { name: names[0] }) : names.length === 2 ? t("{first} and {second} are typing…", { first: names[0], second: names[1] }) : t("Several people are typing…");
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
    <Dialog open={open} onClose={onClose} title={t("Link a job")} size="sm">
      <div className={`dialog-body stack-sm ${s.jobPicker}`}>
        <SearchField value={q} onChange={setQ} placeholder={t("Search jobs by title or number")} label={t("Search jobs")} shortcut={false} autoFocus />
        {jobs.isPending && <span className="muted small">{t("Loading jobs…")}</span>}
        {jobs.data?.length === 0 && <span className="muted small">{t("No jobs match.")}</span>}
        {Boolean(jobs.data?.length) && (
          <ul className={s.jobList}>
            {jobs.data?.map((j) => (
              <li key={j.id}>
                <button type="button" className={s.jobRow} onClick={() => onPick(j)}>
                  <strong>{j.number ? `#${j.number} · ` : ""}{j.title}</strong>
                  {j.client?.display_name && <span>{j.client.display_name}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Dialog>
  );
}
