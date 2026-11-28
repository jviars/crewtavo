/**
 * Direct messages on or off for the whole business, on Team chat's page in Apps and in Chat settings.
 * Owners and admins change it; everyone else sees how it's set. Off, every direct conversation is
 * hidden from everyone, its people included, and kept: turning it back on brings them back. It's on
 * until someone turns it off (routes/chatDirect.ts).
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId } from "react";
import { api } from "@/lib/api";
import { hasRole, useSession } from "@/lib/session";
import { chatKeys, chatOn, useChatState } from "./data";
import { t } from "@/lib/i18n";

export function DirectMessagesSwitch() {
  const session = useSession();
  const queryClient = useQueryClient();
  const state = useChatState();
  const id = useId();
  const allowed = hasRole(session, "admin");
  const toggle = useMutation({
    meta: { success: (res: { on: boolean }) => (res.on ? t("Direct messages are on") : t("Direct messages are off")) },
    mutationFn: (on: boolean) => api.post<{ on: boolean }>("/chat/direct-messages", { on }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: chatKeys.all(session.company.id) }),
  });
  if (!chatOn(session) || !state.data) return null;
  const on = toggle.isPending ? Boolean(toggle.variables) : state.data.direct_messages;
  return (
    <label className="switch-row" htmlFor={id} style={{ alignItems: "flex-start", gap: 16 }}>
      <span className="grow">
        <span style={{ display: "block", fontWeight: 600 }}>{t("Direct messages")}</span>
        <span className="muted small" style={{ display: "block" }}>
          {t("Let people message each other privately, one to one or in small groups. Owners and admins can't read them.")}
        </span>
        {!allowed && <span className="muted small" style={{ display: "block", marginTop: 4 }}>{t("Only owners and admins can change this.")}</span>}
      </span>
      <input id={id} type="checkbox" className="switch" checked={on} disabled={!allowed || toggle.isPending} onChange={(e) => toggle.mutate(e.target.checked)} />
    </label>
  );
}
