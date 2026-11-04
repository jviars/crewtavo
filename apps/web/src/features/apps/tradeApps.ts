/**
 * Crewtavo - Paving and Crewtavo - Roofing on their Apps pages: Install turns the section on, and
 * Uninstall takes it out of the sidebar and keeps everything (POST /api/paving/enabled and
 * /api/roofing/enabled, public.trade_app_set_enabled). Any business can have either or both: the
 * trade only picks starter prices and terms.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { confirm } from "@/components/ui/Confirm";
import { api } from "@/lib/api";
import { useSession } from "@/lib/session";

const WORDS = {
  paving: { name: "Paving", keeps: "Every takeoff and estimate stays" },
  roofing: { name: "Roofing", keeps: "Every roof estimate, package and price range stays" },
};

export function useTradeAppSwitch(app: keyof typeof WORDS) {
  const session = useSession();
  const queryClient = useQueryClient();
  const { name, keeps } = WORDS[app];
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => api.post<{ enabled: boolean }>(`/${app}/enabled`, { enabled }),
    onSuccess: async (res) => {
      // The sidebar comes from the company's settings, and Settings → Company saves from its own copy.
      await session.refresh();
      await queryClient.invalidateQueries({ queryKey: ["apps"] });
      queryClient.invalidateQueries({ queryKey: ["company", session.company.id] });
      return res;
    },
    // Installing shows on the page itself (its ring, then Uninstall).
    meta: { success: (res: { enabled: boolean }) => (res.enabled ? null : `${name} uninstalled`) },
  });
  const turnOff = async () => {
    const ok = await confirm({
      title: `Uninstall ${name}?`,
      body: `${name} leaves the sidebar for everyone. ${keeps}, and comes back if you install it again.`,
      confirmLabel: "Uninstall",
      danger: true,
    });
    if (ok) toggle.mutate(false);
  };
  return { toggle, turnOff };
}
