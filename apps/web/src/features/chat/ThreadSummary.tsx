/** Under a message that has a thread: who replied, "3 replies", and when the last one came. Opens the thread. */
import type { ChatMessage } from "./data";
import { Avatar, listTime } from "./ui";
import th from "./threads.module.css";
import { t } from "@/lib/i18n";

export function ThreadSummary({ thread, onOpen }: { thread: NonNullable<ChatMessage["thread"]>; onOpen: () => void }) {
  const replies = t.plural(thread.replies, { one: "{count} reply", other: "{count} replies" });
  const last = listTime(thread.last_reply_at);
  return (
    <button type="button" className={th.summary} onClick={onOpen} aria-label={t("{replies}, the last {when}. Open the thread", { replies, when: last })}>
      <span className={th.summaryFaces} aria-hidden="true">
        {thread.people.slice(0, 3).map((p) => <Avatar key={p.id} name={p.name} color={p.avatar_color} photo={p.avatar_url} size={20} className={th.summaryFace} />)}
      </span>
      <strong>{replies}</strong>
      <span className={th.summaryWhen}>{t("Last reply {when}", { when: last })}</span>
    </button>
  );
}
