import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

// data.ts talks to the backend; these tests only use what it does with what comes back.
vi.mock("@/lib/api", () => ({ activeCompany: () => null, api: {}, refreshSignIn: async () => "ok", supabase: () => ({}) }));
vi.mock("@/lib/session", () => ({ useSession: () => ({}) }));

const { addMessage, chatKeys, replaceMessage, setReactions } = await import("../src/features/chat/data");
type Message = Parameters<typeof addMessage>[2];

const message = (id: string, extra: Partial<Message> = {}): Message => ({
  id, channel_id: "general", author_id: "tyler", body: id, attachments: [], job_id: null, reply_to: null, mention_users: [], mention_roles: [], mention_all: false,
  pinned_at: null, pinned_by: null, edited_at: null, deleted_at: null, created_at: "2026-11-28T10:00:00Z", author: null, reply: null, reactions: [],
  thread_root: null, also_in_channel: false, thread: null, ...extra,
});

function cache() {
  const queryClient = new QueryClient();
  queryClient.setQueryData([...chatKeys.messages("co", "general"), null], { pages: [{ messages: [message("root")], has_more: false }], pageParams: [""] });
  queryClient.setQueryData(chatKeys.thread("co", "root"), { pages: [{ root: message("root"), replies: [], has_more: false, following: true }], pageParams: [""] });
  const channel = () => (queryClient.getQueryData([...chatKeys.messages("co", "general"), null]) as { pages: Array<{ messages: Message[] }> }).pages[0].messages;
  const thread = () => (queryClient.getQueryData(chatKeys.thread("co", "root")) as { pages: Array<{ root: Message; replies: Message[] }> }).pages[0];
  return { queryClient, channel, thread };
}

describe("thread replies in the cache", () => {
  it("go to their thread, not the channel's list", () => {
    const { queryClient, channel, thread } = cache();
    addMessage(queryClient, "co", message("r1", { thread_root: "root" }));
    addMessage(queryClient, "co", message("r1", { thread_root: "root" })); // the live event brings it again
    expect(channel().map((m) => m.id)).toEqual(["root"]);
    expect(thread().replies.map((m) => m.id)).toEqual(["r1"]);
  });

  it("go to both when also sent to the channel", () => {
    const { queryClient, channel, thread } = cache();
    addMessage(queryClient, "co", message("r2", { thread_root: "root", also_in_channel: true }));
    expect(channel().map((m) => m.id)).toEqual(["root", "r2"]);
    expect(thread().replies.map((m) => m.id)).toEqual(["r2"]);
  });

  it("update the root's count wherever it shows, and reactions in the thread", () => {
    const { queryClient, channel, thread } = cache();
    const counted = message("root", { thread: { replies: 3, last_reply_at: "2026-11-28T11:00:00Z", people: [] } });
    replaceMessage(queryClient, "co", counted);
    expect(channel()[0].thread?.replies).toBe(3);
    expect(thread().root.thread?.replies).toBe(3);
    addMessage(queryClient, "co", message("r3", { thread_root: "root" }));
    setReactions(queryClient, "co", "general", "r3", [{ kind: "thumbs_up", users: ["dana"] }]);
    expect(thread().replies[0].reactions).toEqual([{ kind: "thumbs_up", users: ["dana"] }]);
  });
});
