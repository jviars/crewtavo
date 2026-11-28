/**
 * Writing a message: text with @mentions picked from a list as you type, up to six photos (taken,
 * chosen, pasted or dropped on the box; shrunk before they upload), a job to link, and a reply. The
 * text can be formatted with Markdown (**bold**, _italics_, lists…; Ctrl+B and Ctrl+I mark a word).
 * Enter sends on a computer; on a phone the send button does. A half-written message waits for you
 * when you come back to the channel. In a thread (Threads.tsx) it replies there, and can also send
 * the reply to the channel.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent, type ClipboardEvent, type DragEvent, type KeyboardEvent } from "react";
import { fromEditable, matchMentions, type Mentionable } from "@crewtavo/core/chat";
import { Icon } from "@/components/ui/Icon";
import { RefusedForSpace, useStorageFull } from "@/features/settings/storage";
import { api } from "@/lib/api";
import { uploadOnce } from "@/lib/files";
import { useSession } from "@/lib/session";
import { toast } from "@/lib/toast";
import { addMessage, useTyping, type ChatChannel, type ChatMessage } from "./data";
import { JobPicker, type JobPick } from "./JobPicker";
import { StatusChip, type ChatStatus } from "./Status";
import { laterLabel, scheduledKey, ScheduledBar, SendLaterMenu, SendLaterSheet, useLongPress } from "./Schedule";
import { noSignal, prepareChatFile, sendChatMessage, type WaitingFile } from "./outbox";
import { Avatar, channelLabel, roleColor } from "./ui";
import { usePhone, useVoiceRecorder } from "./voice";
import { MicButton, VoiceRecorder, type VoicePreview } from "./VoiceRecorder";
import s from "./chat.module.css";
import th from "./threads.module.css";
import { t, T } from "@/lib/i18n";

export interface MentionOption extends Mentionable {
  kind: "user" | "role" | "everyone";
  color?: string | null;
  avatar?: string | null;
  photo?: string | null;
  hint?: string;
  /** A person's status, beside their name (Status.tsx). */
  status?: ChatStatus;
}

interface Upload {
  id: string;
  name: string;
  preview: string;
  /** waiting: no signal to store it; it goes with the message, which waits on the phone (outbox.ts). */
  status: "uploading" | "done" | "error" | "waiting";
  path?: string;
  body?: Blob;
  type?: string;
  size?: number;
}

interface Draft {
  text: string;
  picked: MentionOption[];
}

/** Drafts by channel, for as long as the tab is open. */
const drafts = new Map<string, Draft>();
const MAX_PHOTOS = 6;
const coarse = () => window.matchMedia("(pointer: coarse)").matches;
const isPhoto = (f: File) => f.type.startsWith("image/") || /\.(heic|heif)$/i.test(f.name);

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
  thread,
}: {
  channel: ChatChannel;
  options: MentionOption[];
  replyTo: ChatMessage | null;
  onCancelReply: () => void;
  /** Changes when something asks for the box (Reply, Mention): focus it then. */
  focusKey: string;
  /** A mention to add at the end of what's typed (Mention, from someone's profile). */
  insert?: { option: MentionOption; nonce: number } | null;
  /** Replying in this message's thread, rather than to the channel. */
  thread?: { root: string } | null;
}) {
  const session = useSession();
  const queryClient = useQueryClient();
  const storageFull = useStorageFull();
  // A thread's half-written reply is kept apart from the channel's.
  const draftKey = thread ? `thread:${thread.root}` : channel.id;
  const saved = drafts.get(draftKey);
  const [text, setText] = useState(saved?.text ?? "");
  const [picked, setPicked] = useState<MentionOption[]>(saved?.picked ?? []);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [job, setJob] = useState<JobPick | null>(null);
  const [pickingJob, setPickingJob] = useState(false);
  const [suggest, setSuggest] = useState<{ query: string; start: number; index: number } | null>(null);
  const [dropping, setDropping] = useState(false);
  const [alsoSend, setAlsoSend] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const files = useRef<HTMLInputElement>(null);
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
    const draft = drafts.get(draftKey);
    setText(draft?.text ?? "");
    setPicked(draft?.picked ?? []);
    setUploads([]);
    setJob(null);
    setSuggest(null);
    setAlsoSend(false);
  }, [draftKey]);
  useEffect(() => {
    if (text || picked.length) drafts.set(draftKey, { text, picked });
    else drafts.delete(draftKey);
  }, [draftKey, text, picked]);
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

  // Sent now, or kept on the phone until there's signal (outbox.ts); what the server refuses is said here.
  const send = useMutation({
    mutationFn: (payload: { body: string; attachments: WaitingFile[]; job_id: string | null; reply_to: string | null; thread_root: string | null; also_in_channel: boolean }) =>
      sendChatMessage({ ...payload, userId: session.userId, companyId: session.company.id, channelId: channel.id }),
    onSuccess: (message) => message && addMessage(queryClient, session.company.id, message),
  });
  // A voice note: recorded here (voice.ts), then sent on its own, stored in the channel's folder as it goes.
  const voice = useVoiceRecorder();
  const phone = usePhone();
  const sendVoice = useMutation({
    mutationFn: (note: VoicePreview) => {
      const path = `${session.company.id}/chat/${channel.id}/${crypto.randomUUID()}.${note.ext}`;
      // The stored file's name, the same for everyone; a message shows it in their own words.
      const file: WaitingFile = { path, name: "Voice note", type: note.type, size: note.blob.size, duration: note.seconds, body: note.blob, ...(note.words && { words: note.words.slice(0, 5000) }) }; // i18n-ignore: stored
      return send.mutateAsync({ body: "", attachments: [file], job_id: null, reply_to: replyTo?.id ?? null, thread_root: thread?.root ?? null, also_in_channel: Boolean(thread) && alsoSend });
    },
    onSuccess: () => {
      voice.done();
      onCancelReply();
    },
  });

  const ready = uploads.every((u) => u.status !== "uploading");
  const photos = uploads.filter((u) => (u.status === "done" || u.status === "waiting") && u.path);
  const canSend = ready && !send.isPending && (text.trim().length > 0 || photos.length > 0 || Boolean(job));

  const submit = () => {
    if (!canSend) return;
    const body = fromEditable(text.trim(), picked);
    const attachments: WaitingFile[] = photos.map((u) => ({ path: u.path!, name: u.name, ...(u.type && { type: u.type }), ...(u.size && { size: u.size }), ...(u.status === "waiting" && { body: u.body }) }));
    const payload = { body, attachments, job_id: job?.id ?? null, reply_to: replyTo?.id ?? null, thread_root: thread?.root ?? null, also_in_channel: Boolean(thread) && alsoSend };
    send.mutate(payload, { onSuccess: cleared });
  };
  /** Sent, waiting for signal, or scheduled: the box is empty again. */
  const cleared = () => {
    setText("");
    setPicked([]);
    uploads.forEach((u) => URL.revokeObjectURL(u.preview));
    setUploads([]);
    setJob(null);
    onCancelReply();
    setAlsoSend(false);
    drafts.delete(draftKey);
  };

  // Send later (Schedule.tsx): the chevron beside Send on a computer, a long press on Send on a phone.
  const later = useMutation({
    meta: { inline: true },
    mutationFn: (at: Date) => {
      if (uploads.some((u) => u.status === "waiting")) throw new Error(t("A photo hasn't gone up yet. Schedule the message once there's signal."));
      return api.post(`/chat/channels/${channel.id}/scheduled`, {
        body: fromEditable(text.trim(), picked),
        attachments: photos.map((u) => ({ path: u.path!, name: u.name, ...(u.type && { type: u.type }), ...(u.size && { size: u.size }) })),
        job_id: job?.id ?? null,
        reply_to: replyTo?.id ?? null,
        send_at: at.toISOString(),
      });
    },
    onSuccess: (_r, at) => {
      cleared();
      toast.success(t("Scheduled for {when}", { when: laterLabel(at.toISOString(), session.company.timezone) }));
      void queryClient.invalidateQueries({ queryKey: scheduledKey(session.company.id) });
    },
  });
  const [laterSheet, setLaterSheet] = useState(false);
  const press = useLongPress(() => canSend && setLaterSheet(true));

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
    // Typing in a thread isn't shown in the channel.
    if (!thread && e.target.value.trim() && now - lastTyping.current > 3_000) {
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

  const addPhotos = (list: FileList | File[] | null) => {
    const all = [...(list ?? [])].filter(isPhoto);
    const chosen = all.slice(0, MAX_PHOTOS - uploads.length);
    if (files.current) files.current.value = "";
    if (all.length > chosen.length) toast.warning(t("A message takes up to {count} photos.", { count: MAX_PHOTOS }));
    // Photos turned away for space are told about once, together, with why and who can make room.
    const refused = new RefusedForSpace();
    const sent = chosen.map(async (file) => {
      const id = crypto.randomUUID();
      setUploads((u) => [...u, { id, name: file.name, preview: URL.createObjectURL(file), status: "uploading", size: file.size }]);
      // To a path chosen first, so a photo with no signal now goes up once, with its message, later.
      let ready: Awaited<ReturnType<typeof prepareChatFile>>;
      try {
        ready = await prepareChatFile(session.company.id, channel.id, file);
      } catch (error) {
        setUploads((u) => u.map((x) => (x.id === id ? { ...x, status: "error" } : x)));
        toast.error((error as Error).message);
        return;
      }
      setUploads((u) => u.map((x) => (x.id === id ? { ...x, path: ready.path, type: ready.type } : x)));
      return uploadOnce(ready.path, ready.body).then(
        () => setUploads((u) => u.map((x) => (x.id === id ? { ...x, status: "done" } : x))),
        (error: unknown) => {
          setUploads((u) => u.map((x) => (x.id === id ? (noSignal(error) ? { ...x, status: "waiting", body: ready.body } : { ...x, status: "error" }) : x)));
          refused.add(error, file.name, file.size);
        },
      );
    });
    void Promise.all(sent).then(() => {
      if (refused.first) storageFull(refused.first, refused.title());
    });
  };

  // A screenshot or a copied photo pastes in as a photo. Copied text that brings a picture of itself
  // along (Word, a spreadsheet) still pastes as text.
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const data = e.clipboardData;
    const pasted = [...data.items].filter((i) => i.kind === "file").map((i) => i.getAsFile()).filter((f): f is File => Boolean(f && isPhoto(f)));
    if (!pasted.length || data.getData("text/plain").trim()) return;
    e.preventDefault();
    addPhotos(pasted.map(pastedName));
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
    addPhotos([...e.dataTransfer.files]);
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
              : channel.kind === "direct"
                ? t("Nobody else in this conversation is on the team any more, so it can't take new messages.")
                : t("Your role can read this channel but not post in it.")}
        </div>
      </div>
    );
  }

  const placeholder = thread ? t("Reply…") : t("Message {channel}", { channel: channelLabel(channel) });
  return (
    <div className={s.foot}>
      {!thread && <ScheduledBar channelId={channel.id} options={options} />}
      <div
        className={s.composer}
        data-dropping={dropping || undefined}
        onDragOver={onDragOver}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false); }}
        onDrop={onDrop}
      >
        {!thread && <TypingLine channelId={channel.id} />}
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
                <StatusChip status={o.status} />
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
              <span key={u.id} className={s.chip} title={u.status === "error" ? t("Couldn't upload this photo") : u.name}>
                <img src={u.preview} alt="" />
                <span>{u.status === "uploading" ? t("Uploading…") : u.status === "error" ? t("Didn't upload") : u.status === "waiting" ? t("Goes when there's signal") : u.name}</span>
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
        {voice.recording.phase !== "idle" ? (
          <VoiceRecorder recorder={voice} onSend={(note) => sendVoice.mutate(note)} sending={sendVoice.isPending} />
        ) : (
        <div className={s.composerRow}>
          <button type="button" className={s.composerBtn} aria-label={t("Add photos")} title={t("Add photos")} disabled={uploads.length >= MAX_PHOTOS} onClick={() => files.current?.click()}>
            <Icon name="camera" size={17} />
          </button>
          {!phone && <MicButton onClick={() => void voice.start()} />}
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
            onPaste={onPaste}
            onClick={(e) => lookForMention(e.currentTarget.value, e.currentTarget.selectionStart ?? 0)}
            onBlur={() => setTimeout(() => setSuggest(null), 150)}
            maxLength={4000}
          />
          <button type="button" className={`btn btn-sm ${s.jobBtn}`} aria-label={t("Link a job")} title={t("Link a job")} onClick={() => setPickingJob(true)}>
            <Icon name="job" size={15} /><span className={s.jobText}>{t("Link a job")}</span>
          </button>
          {phone && !text.trim() && !uploads.length && !job ? (
            <MicButton round onClick={() => void voice.start()} />
          ) : (
          <>
          <button
            type="button"
            className={`btn btn-sm btn-primary ${s.sendBtn}`}
            aria-label={t("Send")}
            aria-description={phone ? t("Hold to send later") : undefined}
            disabled={!canSend}
            {...(phone && !thread ? press.handlers : {})}
            onClick={() => (press.consume() ? undefined : submit())}
          >
            <span className={s.sendIcon} aria-hidden="true"><Icon name="arrowUp" size={19} /></span>
            <span className={s.sendText}>{t("Send")}</span>
          </button>
          {!phone && !thread && <SendLaterMenu disabled={!canSend || later.isPending} onPick={(at) => later.mutate(at)} />}
          </>
          )}
        </div>
        )}
      </div>
      {thread && (
        <label className={th.alsoSend}>
          <input type="checkbox" checked={alsoSend} onChange={(e) => setAlsoSend(e.target.checked)} />
          <span>{channel.kind === "direct" ? t("Also send to the conversation") : t("Also send to {channel}", { channel: channelLabel(channel) })}</span>
        </label>
      )}
      {(send.error || sendVoice.error || later.error) && <div className="field-error" style={{ margin: "6px 4px 0" }}>{((later.error ?? sendVoice.error ?? send.error) as Error).message}</div>}
      <SendLaterSheet open={laterSheet} onClose={() => setLaterSheet(false)} onPick={(at) => later.mutate(at)} />
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
