/**
 * The team's notes and photos on an estimate: what the office tells the salesperson before the
 * visit ("Dog in the back yard, use the side gate"), and what the salesperson finds on the roof,
 * with photos. Only the team sees them, never the homeowner. On site (composer "site") the note box
 * comes first and everything is sized for a finger; in the office the thread comes first.
 */
import { useId, useState, type ChangeEvent, type FormEvent } from "react";
import { Button, useJustDone } from "@/components/ui/Button";
import { Face } from "@/components/ui/Avatar";
import { Icon } from "@/components/ui/Icon";
import { Skeleton } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState } from "@/components/ui/States";
import { useListAnimation } from "@/lib/motion";
import { hasRole, useSession } from "@/lib/session";
import { useNoteActions, useQuoteNotes, type NoteAuthor, type QuotePhoto } from "./data";
import { whenText } from "./rows";
import styles from "./estimate.module.css";

const draftKey = (quoteId: string) => `crewtavo.estimate-note.${quoteId}`;

/** A note being written, kept for this tab so leaving the screen (to sign, say) doesn't lose it. */
function readDraft(quoteId: string): string {
  try {
    return sessionStorage.getItem(draftKey(quoteId)) ?? "";
  } catch {
    return "";
  }
}
function keepDraft(quoteId: string, text: string) {
  try {
    if (text) sessionStorage.setItem(draftKey(quoteId), text);
    else sessionStorage.removeItem(draftKey(quoteId));
  } catch {
    // Private browsing: the note just isn't kept.
  }
}

export function NotesThread({ quoteId, composer, title = "Notes", hint = "Only your team sees notes", placeholder, bare }: {
  quoteId: string;
  /** "site" on the iPad (bigger, the note box first, the camera opens), "office" at a desk. */
  composer: "office" | "site";
  /** "Notes for Mike", "Your notes". */
  title?: string;
  hint?: string;
  placeholder?: string;
  /** Leave off the card around it, to sit inside another one. */
  bare?: boolean;
}) {
  const session = useSession();
  const id = useId();
  const notes = useQuoteNotes(quoteId);
  const data = notes.data;
  const { addNote, addPhotos, deleteNote, deletePhoto, uploading } = useNoteActions(quoteId);
  const added = useJustDone(addNote);
  const threadRef = useListAnimation<HTMLUListElement>();
  const [text, setText] = useState(() => readDraft(quoteId));
  const site = composer === "site";
  const isOffice = hasRole(session, "admin", "office");
  const canDelete = (author: string | null) => isOffice || (author !== null && author === session.userId);

  const write = (value: string) => {
    setText(value);
    keepDraft(quoteId, value);
  };
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (!text.trim() || addNote.isPending) return;
    addNote.mutate(text, { onSuccess: () => write("") });
  };
  const onPhotos = (e: ChangeEvent<HTMLInputElement>) => {
    const files = [...(e.target.files ?? [])];
    e.target.value = "";
    if (files.length) addPhotos.mutate(files);
  };

  const box = (
    <form className={styles.composer} onSubmit={submit}>
      <label className="sr-only" htmlFor={`${id}-note`}>{title}</label>
      <textarea
        id={`${id}-note`}
        className="textarea"
        rows={site ? 4 : 3}
        maxLength={4000}
        placeholder={placeholder ?? (site ? "What you found: soft decking, a second layer, where the dumpster goes…" : "Anything they should know: the gate code, the dog, what the homeowner mentioned…")}
        value={text}
        onChange={(e) => write(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
        }}
      />
      <div className={styles.composerActions}>
        <label className="btn" aria-busy={uploading > 0 || undefined}>
          {uploading > 0 ? <span className="spinner" style={{ width: 16, height: 16 }} aria-hidden="true" /> : <Icon name="camera" size={site ? 20 : 16} />}
          {uploading > 0 ? "Uploading…" : site ? "Take a photo" : "Add photos"}
          <input type="file" className="sr-only" accept="image/*" capture={site ? "environment" : undefined} multiple onChange={onPhotos} />
        </label>
        <Button type="submit" loading={addNote.isPending} done={added} doneLabel="Added" disabled={!text.trim()}>Add note</Button>
      </div>
    </form>
  );

  const list = (
    <>
      {notes.isPending && (
        <ul className={styles.thread} aria-hidden="true">
          {[0, 1].map((i) => (
            <li key={i} className={styles.item}>
              <Skeleton circle width={34} height={34} />
              <span className={styles.itemBody}><Skeleton width={150} height={10} /><Skeleton width="85%" height={13} /></span>
            </li>
          ))}
        </ul>
      )}
      {notes.error && <ErrorState compact error={notes.error} onRetry={() => notes.refetch()} />}
      {data && !data.thread.length && !uploading && <EmptyState inline title="No notes yet" />}
      {data && (data.thread.length > 0 || uploading > 0) && (
        <ul ref={threadRef} className={styles.thread} aria-label={title}>
          {uploading > 0 && (
            <li className={styles.item}>
              <span className={`avatar ${styles.face}`} style={{ background: session.profile.color || "var(--text-3)" }}><Face name={session.profile.full_name || session.profile.email} photo={session.profile.avatar_url} /></span>
              <span className={styles.itemBody}>
                <span className={styles.itemMeta}><strong>You</strong> · uploading {uploading === 1 ? "a photo" : `${uploading} photos`}</span>
                <span className={styles.photos}>{Array.from({ length: uploading }, (_, i) => <span key={i} className={`${styles.photo} ${styles.uploading}`}><span className="spinner" style={{ width: 18, height: 18 }} aria-hidden="true" /></span>)}</span>
              </span>
            </li>
          )}
          {data.thread.map((item) => {
            const author = item.author_id ? data.authors[item.author_id] : undefined;
            return (
              <li key={item.key} className={styles.item}>
                <Avatar author={author} />
                <span className={styles.itemBody}>
                  <span className={styles.itemMeta}>
                    <strong>{item.author_id === session.userId ? "You" : author?.name ?? (item.author_id ? "Someone on your team" : "Crewtavo")}</strong>
                    <span>· {capitalize(whenText(item.at, session.company.timezone))}</span>
                    {item.note && canDelete(item.note.author_id) && (
                      <button
                        type="button"
                        className={styles.itemDelete}
                        aria-label="Delete this note"
                        onClick={() => deleteNote(item.note!)}
                      >
                        <Icon name="trash" size={site ? 16 : 14} />
                      </button>
                    )}
                  </span>
                  {item.note && <p className={styles.itemText}>{item.note.body}</p>}
                  {item.photos.length > 0 && (
                    <span className={styles.photos}>
                      {item.photos.map((p, i) => (
                        <Photo key={p.id} photo={p} n={i + 1} canDelete={canDelete(p.author_id)} onDelete={() => deletePhoto(p)} />
                      ))}
                    </span>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );

  return (
    <section className={`${bare ? "" : "card card-pad "}${styles.notes}`} data-size={composer} aria-labelledby={`${id}-title`}>
      <div className={styles.notesHead}>
        <h2 id={`${id}-title`} className={styles.notesTitle}>{title}</h2>
        <span className={styles.private}><Icon name="lock" size={14} />{hint}</span>
      </div>
      {site ? <>{box}{list}</> : <>{list}{box}</>}
    </section>
  );
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function Avatar({ author }: { author: NoteAuthor | undefined }) {
  return (
    <span className={`avatar ${styles.face}`} style={{ background: author?.color || "var(--text-3)" }} aria-hidden="true">
      <Face name={author?.name ?? "Crewtavo"} photo={author?.photo} />
    </span>
  );
}

function Photo({ photo, n, canDelete, onDelete }: { photo: QuotePhoto; n: number; canDelete: boolean; onDelete: () => void }) {
  const label = photo.caption || `Photo ${n}`;
  return (
    <span className={styles.photo}>
      {photo.url ? (
        <a href={photo.url} target="_blank" rel="noreferrer" aria-label={`Open ${label}`}>
          <img src={photo.url} alt={label} loading="lazy" />
        </a>
      ) : (
        <span className={styles.photoMissing} title="This photo couldn't be loaded"><Icon name="image" size={20} label="Photo unavailable" /></span>
      )}
      {canDelete && (
        <button
          type="button"
          className={styles.photoX}
          aria-label={`Remove ${label}`}
          onClick={onDelete}
        >
          <Icon name="x" size={12} strokeWidth={2} />
        </button>
      )}
    </span>
  );
}
