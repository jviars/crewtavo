/**
 * A conversation that waits on the office: the client spoke last, since anyone marked it done. A reply
 * ends the wait by itself; Done is for a last message that needs none ("Thanks!"). One mark for the
 * whole office (conversations_done, 20261125100210), so whoever handles it handles it for everyone.
 * The Messages button's dot counts them (waiting_conversations).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase, unwrap } from "@/lib/api";
import { hasRole, isSub, useSession } from "@/lib/session";
import { toast } from "@/lib/toast";

const marksKey = (companyId: string) => ["conversations-done", companyId] as const;
const waitingKey = (companyId: string) => ["conversations-waiting", companyId] as const;

/** Whether this person answers clients' messages, and so sees and marks what's waiting. */
export const answersMessages = (session: ReturnType<typeof useSession>) => !isSub(session) && hasRole(session, "admin", "office", "estimator");

/** When each client's conversation was last marked done. */
export function useDoneMarks() {
  const session = useSession();
  return useQuery({
    queryKey: marksKey(session.company.id),
    enabled: answersMessages(session),
    refetchInterval: 30_000,
    meta: { silent: true },
    queryFn: async () => new Map(unwrap(await supabase().from("conversations_done").select("client_id, done_at").eq("company_id", session.company.id)).map((r) => [r.client_id, r.done_at])),
  });
}

/** The latest message is the client's, and came after the conversation was last marked done. */
export const isWaiting = (latest: { direction: string; created_at: string }, doneAt: string | undefined) =>
  latest.direction === "in" && (!doneAt || Date.parse(doneAt) < Date.parse(latest.created_at));

/** How many conversations wait on the office, for the dot on the Messages button. */
export function useWaitingCount() {
  const session = useSession();
  return useQuery({
    queryKey: waitingKey(session.company.id),
    enabled: answersMessages(session),
    refetchInterval: 60_000,
    meta: { silent: true },
    queryFn: async () => unwrap(await supabase().rpc("waiting_conversations", { p_company: session.company.id })) as number,
  });
}

/** Done, with Undo on its toast: the mark comes off and the conversation waits again. */
export function useMarkDone() {
  const session = useSession();
  const queryClient = useQueryClient();
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: marksKey(session.company.id) });
    void queryClient.invalidateQueries({ queryKey: waitingKey(session.company.id) });
  };
  const undo = useMutation({
    meta: { inline: true },
    mutationFn: async (clientId: string) => unwrap(await supabase().from("conversations_done").delete().eq("client_id", clientId)),
    onSettled: refresh,
  });
  return useMutation({
    meta: { inline: true },
    mutationFn: async ({ clientId }: { clientId: string; name: string }) =>
      unwrap(await supabase().from("conversations_done").upsert({ company_id: session.company.id, client_id: clientId }, { onConflict: "client_id" })),
    onMutate: ({ clientId }) => {
      // The dot goes the moment it's pressed, and comes back if the save fails.
      queryClient.setQueryData<Map<string, string>>(marksKey(session.company.id), (marks) => new Map(marks).set(clientId, new Date().toISOString()));
    },
    onSuccess: (_, { clientId, name }) => toast.success(`${name}'s conversation is done`, { action: { label: "Undo", onClick: () => undo.mutate(clientId) } }),
    onError: () => toast.error("Couldn't mark it done. Try again."),
    onSettled: refresh,
  });
}
