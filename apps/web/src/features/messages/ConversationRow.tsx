/**
 * One conversation in Messages' list, as an inbox row (B-Inbox.dc.html): a face with their initials,
 * who it's with, the latest message under it, and how long ago on the right. The row opens the
 * conversation beside the list (InboxRow's onClick: one button, stretched over the row, so one Tab
 * stop); a green dot says the latest message is theirs.
 */
import type { ReactNode } from "react";
import { InboxRow, RowAge } from "@/components/ui/InboxList";

export function ConversationRow({ name, face, current, unread, at, onOpen, children }: {
  name: string;
  /** In place of the initials (an unknown number's "?"). */
  face?: ReactNode;
  current: boolean;
  /** What the green dot means here, for its tooltip and a screen reader; none, no dot. */
  unread?: string;
  at: string;
  onOpen: () => void;
  /** The latest message, on the second line. */
  children: ReactNode;
}) {
  return (
    <InboxRow
      onClick={onOpen}
      current={current}
      className="msg-row"
      title={name}
      // A face of its own as it is (a string too); otherwise the name's initials.
      avatar={face !== undefined && face !== null ? <>{face}</> : name}
      unread={unread}
      subject={<span className="msg-row-latest">{children}</span>}
      aside={<RowAge at={at} />}
    />
  );
}
