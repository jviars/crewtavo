/**
 * Saved for later (/chat?view=saved): the messages you saved from their menu, newest saved first,
 * with where and when they were said. Tap one to open it in its channel; take one out with its
 * button. On a phone it's a screen of its own. A saved message carries a small bookmark where it's
 * shown (MessageItem). Each person's own, from GET /api/chat/saved.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Icon } from "@/components/ui/Icon";
import { Loading, Skeleton } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState } from "@/components/ui/States";
import { api } from "@/lib/api";
import { t } from "@/lib/i18n";
import { useSession } from "@/lib/session";
import type { ChatMessage, ChatState } from "./data";
import { MessageRow, PanelHead, useChatPeople, useNames, usePanelExit } from "./panels";
import s from "./chat.module.css";
import p from "./panels.module.css";

interface Saved {
  ids: string[];
  items: Array<{ saved_at: string; message: ChatMessage }>;
}

export const savedKey = (company: string) => ["chat", company, "saved"] as const;

/** Your saved messages, and the ids of all of them for the marks. */
export function useSaved(enabled = true) {
  const { company } = useSession();
  return useQuery({
    queryKey: savedKey(company.id),
    queryFn: () => api.get<Saved>("/chat/saved"),
    enabled,
    staleTime: 5 * 60_000,
    meta: { silent: true },
  });
}

/** Whether a message is saved, and a way to save it or take it out (shown at once, put back if it fails). */
export function useSavedMessage(message: ChatMessage) {
  const { company } = useSession();
  const queryClient = useQueryClient();
  const saved = useSaved();
  const on = saved.data?.ids.includes(message.id) ?? false;
  const toggle = useMutation({
    meta: { success: on ? t("Removed from saved") : t("Saved for later") },
    mutationFn: (next: boolean) => api.put<{ saved: boolean }>(`/chat/messages/${message.id}/saved`, { saved: next }),
    onMutate: (next) => {
      const before = queryClient.getQueryData<Saved>(savedKey(company.id));
      queryClient.setQueryData<Saved>(savedKey(company.id), (data) =>
        data
          ? {
              ids: next ? [message.id, ...data.ids.filter((id) => id !== message.id)] : data.ids.filter((id) => id !== message.id),
              items: next ? [{ saved_at: new Date().toISOString(), message }, ...data.items.filter((x) => x.message.id !== message.id)] : data.items.filter((x) => x.message.id !== message.id),
            }
          : data,
      );
      return { before };
    },
    onError: (_error, _next, context) => {
      if (context?.before) queryClient.setQueryData(savedKey(company.id), context.before);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: savedKey(company.id) }),
  });
  return { saved: on, toggle: () => toggle.mutate(!on) };
}

export function SavedPanel({ state }: { state: ChatState | undefined }) {
  const navigate = useNavigate();
  const exit = usePanelExit();
  const saved = useSaved();
  const people = useChatPeople();
  const names = useNames(state, people.data);
  const items = saved.data?.items ?? [];
  return (
    <section className={s.conversation} aria-label={t("Saved for later")}>
      <PanelHead title={t("Saved for later")} icon="bookmark" onClose={exit} />
      <div className={p.body}>
        {saved.error && !saved.data ? (
          <div className={p.state}><ErrorState compact error={saved.error} onRetry={() => saved.refetch()} /></div>
        ) : saved.isPending ? (
          <Loading label={t("Loading saved messages")}>
            {[0, 1, 2].map((i) => <div key={i} className={p.skeleton}><Skeleton width={180} height={11} /><Skeleton width="80%" height={13} /></div>)}
          </Loading>
        ) : !items.length ? (
          <div className={p.state}>
            <EmptyState compact icon="bookmark" title={t("Nothing saved yet")}>
              {t("Save a message from its menu (···) to come back to it here: a gate code, an address, a change of plan.")}
            </EmptyState>
          </div>
        ) : (
          <ol className={p.list} aria-label={t("Saved messages")}>
            {items.map(({ message }) => <SavedRow key={message.id} message={message} state={state} names={names} onOpen={() => navigate(`/chat/${message.channel_id}?message=${message.id}`)} />)}
          </ol>
        )}
      </div>
    </section>
  );
}

function SavedRow({ message, state, names, onOpen }: { message: ChatMessage; state: ChatState | undefined; names: ReturnType<typeof useNames>; onOpen: () => void }) {
  const { toggle } = useSavedMessage(message);
  return (
    <MessageRow
      message={message}
      state={state}
      names={names}
      onOpen={onOpen}
      tool={
        <button type="button" className={p.rowTool} aria-label={t("Remove from saved")} title={t("Remove from saved")} onClick={toggle}>
          <Icon name="x" size={16} />
        </button>
      }
    />
  );
}
