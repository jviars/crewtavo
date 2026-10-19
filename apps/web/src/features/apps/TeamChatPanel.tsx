/**
 * Team chat on its Apps page: turn it on (it sets up starter channels the first time), open it, or
 * turn it off. Off hides chat for everyone and keeps every message.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { Icon } from "@/components/ui/Icon";
import { api } from "@/lib/api";
import { useSession } from "@/lib/session";
import type { AppRow } from "./catalog";

export function useTeamChatSwitch() {
  const session = useSession();
  const queryClient = useQueryClient();
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => api.post<{ enabled: boolean }>("/chat/enabled", { enabled }),
    onSuccess: async (res) => {
      await session.refresh();
      await queryClient.invalidateQueries({ queryKey: ["apps"] });
      queryClient.invalidateQueries({ queryKey: ["chat"] });
      return res;
    },
    meta: { success: undefined },
  });
  const turnOff = async () => {
    const ok = await confirm({
      title: "Turn off team chat?",
      body: "Chat disappears for everyone on your team. Every channel and message is kept, and comes back if you turn it on again.",
      confirmLabel: "Turn off",
      danger: true,
    });
    if (ok) toggle.mutate(false);
  };
  return { toggle, turnOn: () => toggle.mutate(true), turnOff };
}

export function TeamChatPanel({ app }: { app: AppRow }) {
  const { toggle, turnOn, turnOff } = useTeamChatSwitch();
  const on = app.status === "connected";
  return (
    <section id="app-setup" className="card card-pad stack-sm" aria-labelledby="team-chat-setup" style={{ gap: 12 }}>
      <h2 id="team-chat-setup" className="section-title" style={{ fontSize: 17 }}>{on ? "Team chat is on" : "Turn on team chat"}</h2>
      {on ? (
        <>
          <span className="muted">Everyone on your team has <strong>Team chat</strong> in the menu. Owners and admins set up its channels and who sees each one in Chat settings.</span>
          <div className="row wrap" style={{ gap: 8 }}>
            <Link className="btn btn-primary" to="/chat"><Icon name="chat" size={16} />Open team chat</Link>
            <Link className="btn" to="/chat/settings"><Icon name="settings" size={16} />Chat settings</Link>
            <Button variant="ghost" loading={toggle.isPending} onClick={turnOff}>Turn off</Button>
          </div>
        </>
      ) : (
        <>
          <ol className="app-steps">
            <li>Turn it on. Crewtavo starts you with <strong>Announcements</strong>, <strong>#general</strong>, a channel for each crew and one for the office.</li>
            <li>Check who sees what in <strong>Chat settings</strong>. Field crew start with only their own crew's channel.</li>
            <li>Your team finds <strong>Team chat</strong> in the menu, and gets a push when someone @mentions them.</li>
          </ol>
          <Button variant="primary" style={{ justifySelf: "start" }} loading={toggle.isPending} onClick={turnOn}>Turn on team chat</Button>
        </>
      )}
      {toggle.error && <span className="field-error">{(toggle.error as Error).message}</span>}
    </section>
  );
}
