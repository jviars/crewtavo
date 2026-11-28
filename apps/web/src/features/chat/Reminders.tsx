/**
 * Remind me, from a message's menu: in an hour, tomorrow at 9:00 AM where the business is, or a
 * time picked. At that time the person hears of it on the bell, and by push (or email or text) as
 * their Team chat choices say: "Reminder: Dana Hale's message in #general", with its words and the
 * way back to it (apps/api/src/services/chatLater.ts). Their reminders still to come are listed from
 * the alarm by the channel list, to open or delete. There's no to-do list in Crewtavo: a reminder
 * is how a message gets followed up.
 */
import { chatPlainText } from "@crewtavo/core/chat";
import { remindChoices } from "@crewtavo/core/chatField";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Icon } from "@/components/ui/Icon";
import type { MenuSub } from "@/components/ui/Menu";
import { api } from "@/lib/api";
import { t } from "@/lib/i18n";
import { useSession } from "@/lib/session";
import { toast } from "@/lib/toast";
import { chatOn, type ChatChannel, type ChatMessage } from "./data";
import { laterLabel, PickTimeDialog } from "./Schedule";
import { channelLabel } from "./ui";
import f from "./field.module.css";

interface Reminder {
  id: string;
  message_id: string;
  channel_id: string;
  remind_at: string;
  message: ChatMessage;
}

export const remindersKey = (company: string) => ["chat", company, "reminders"] as const;

export function useReminders() {
  const session = useSession();
  return useQuery({
    queryKey: remindersKey(session.company.id),
    enabled: chatOn(session),
    queryFn: () => api.get<{ reminders: Reminder[] }>("/chat/reminders").then((r) => r.reminders),
    staleTime: 60_000,
    meta: { silent: true },
  });
}

/** The message menu's Remind me, and the dialog its Pick a time opens. */
export function useRemindMe(message: ChatMessage): { entry: MenuSub; dialog: ReactNode } {
  const { company } = useSession();
  const queryClient = useQueryClient();
  const [picking, setPicking] = useState(false);
  const set = useMutation({
    mutationFn: (at: Date) => api.put(`/chat/messages/${message.id}/reminder`, { remind_at: at.toISOString() }),
    onSuccess: (_r, at) => {
      toast.success(t("Reminder set for {when}", { when: laterLabel(at.toISOString(), company.timezone) }));
      void queryClient.invalidateQueries({ queryKey: remindersKey(company.id) });
      setPicking(false);
    },
  });
  const choices = remindChoices(new Date(), company.timezone);
  return {
    entry: {
      label: t("Remind me"),
      icon: "alarm",
      items: [
        ...choices.map((c) => ({ label: t(c.label), icon: "clock" as const, onSelect: () => set.mutate(c.at) })),
        { label: t("Pick a time"), icon: "calendar" as const, onSelect: () => setPicking(true) },
      ],
    },
    dialog: <PickTimeDialog open={picking} title={t("Remind me")} confirmLabel={t("Set the reminder")} busy={set.isPending} onClose={() => setPicking(false)} onPick={(at) => set.mutate(at)} />,
  };
}

/** By the channel list: my reminders still to come, when I have any. */
export function RemindersButton({ channels, className }: { channels: ChatChannel[]; className?: string }) {
  const reminders = useReminders();
  const [open, setOpen] = useState(false);
  const count = reminders.data?.length ?? 0;
  if (!count) return null;
  return (
    <>
      <button type="button" className={`${className ?? ""} ${f.remindersBtn}`} aria-label={t.plural(count, { one: "{count} reminder", other: "{count} reminders" })} title={t("Your reminders")} onClick={() => setOpen(true)}>
        <Icon name="alarm" size={16} />
        <span className={f.reminderCount} aria-hidden="true">{count}</span>
      </button>
      <RemindersDialog open={open} onClose={() => setOpen(false)} reminders={reminders.data ?? []} channels={channels} />
    </>
  );
}

function RemindersDialog({ open, onClose, reminders, channels }: { open: boolean; onClose: () => void; reminders: Reminder[]; channels: ChatChannel[] }) {
  const { company } = useSession();
  const queryClient = useQueryClient();
  const remove = useMutation({
    meta: { inline: true },
    mutationFn: (id: string) => api.delete(`/chat/reminders/${id}`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: remindersKey(company.id) }),
  });
  return (
    <Dialog open={open} onClose={onClose} title={t("Your reminders")} description={t("You hear of each at its time, on the bell and by your Team chat notifications.")}>
      <div className="dialog-body">
        <ul className={f.laterList}>
          {reminders.map((r) => {
            const channel = channels.find((c) => c.id === r.channel_id);
            const words = chatPlainText(r.message.body, (p) => (p.kind === "everyone" ? "everyone" : p.kind === "user" ? "someone" : "role")) || t("Photos or files");
            return (
              <li key={r.id} className={f.laterRow}>
                <span className={f.laterWhen}><Icon name="alarm" size={12} />{laterLabel(r.remind_at, company.timezone)}</span>
                <span className={f.laterText}>
                  <strong>{r.message.author?.name ?? "Crewtavo"}</strong>
                  {channel && <> · {channelLabel(channel)}</>}
                  {" — "}
                  {words}
                </span>
                <span className={f.laterActions}>
                  <Link className="btn btn-sm" to={`/chat/${r.channel_id}?message=${r.message_id}`} onClick={onClose}>{t("Open")}</Link>
                  <Button size="sm" variant="ghost" icon="trash" loading={remove.isPending && remove.variables === r.id} onClick={() => remove.mutate(r.id)}>{t("Delete")}</Button>
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    </Dialog>
  );
}
