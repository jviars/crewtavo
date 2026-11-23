/**
 * Team chat on its Apps page: Install turns it on (it sets up starter channels the first time), and
 * Uninstall turns it off, which hides chat for everyone and keeps every message.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { confirm } from "@/components/ui/Confirm";
import { Icon } from "@/components/ui/Icon";
import { Section } from "@/components/ui/Section";
import { api } from "@/lib/api";
import { useSession } from "@/lib/session";
import { kit } from "./PanelKit";

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
    // Installing shows on the page itself (its ring, then Uninstall).
    meta: { success: (res: { enabled: boolean }) => (res.enabled ? null : "Team chat uninstalled") },
  });
  const turnOff = async () => {
    const ok = await confirm({
      title: "Uninstall team chat?",
      body: "Chat disappears for everyone on your team. Every channel and message is kept, and comes back if you install it again.",
      confirmLabel: "Uninstall",
      danger: true,
    });
    if (ok) toggle.mutate(false);
  };
  return { toggle, turnOff };
}

/** Once it's installed: where its channels are set up. */
export function TeamChatPanel() {
  return (
    <Section className={kit.panel} id="app-setup" title="Team chat is on" action={<Link to="/chat/settings"><Icon name="settings" size={14} />Chat settings</Link>}>
      <p className={kit.text}>
        Everyone on your team has <strong>Team chat</strong> in the menu. Crewtavo started you with <strong>Announcements</strong>, <strong>#general</strong>, a channel for each
        crew and one for the office. Set up channels and who sees each one in Chat settings: field crew start with only their own crew's.
      </p>
    </Section>
  );
}
