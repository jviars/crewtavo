/**
 * Sending a message later. On a computer, the small chevron beside Send; on a phone, a long press on
 * Send. The choices are tomorrow at 6:30 AM, Monday at 7:00 AM, or a date and time picked, all where
 * the business is (core sendLaterChoices), whatever the phone's own clock says. A conversation with
 * messages waiting to go says how many above the box, and lists them to send now, edit or delete.
 * The server sends them at their time, as their author (apps/api/src/services/chatLater.ts).
 */
import { chatPlainText, fromEditable, toEditable, type Mentionable, type MessagePart } from "@crewtavo/core/chat";
import { pickedTime, pickerStart, sendLaterChoices } from "@crewtavo/core/chatField";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type PointerEvent } from "react";
import { Button } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { Dialog } from "@/components/ui/Dialog";
import { Field, FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { Menu } from "@/components/ui/Menu";
import { api } from "@/lib/api";
import { browserOrSpanish, t } from "@/lib/i18n";
import { dateLocale } from "@/lib/format";
import { useSession } from "@/lib/session";
import { addMessage, type ChatAttachment, type ChatMessage } from "./data";
import f from "./field.module.css";

export interface ScheduledMessage {
  id: string;
  channel_id: string;
  body: string;
  attachments: ChatAttachment[];
  job_id: string | null;
  reply_to: string | null;
  send_at: string;
  created_at: string;
}

export const scheduledKey = (company: string) => ["chat", company, "scheduled"] as const;

/** My messages waiting to be sent, in every conversation. */
export function useScheduled(enabled = true) {
  const { company } = useSession();
  return useQuery({
    queryKey: scheduledKey(company.id),
    enabled,
    queryFn: () => api.get<{ scheduled: ScheduledMessage[] }>("/chat/scheduled").then((r) => r.scheduled),
    staleTime: 60_000,
    meta: { silent: true },
  });
}

/** "Tue, Dec 1, 7:00 AM", where the business is. */
export function laterLabel(iso: string, timeZone: string) {
  return new Date(iso).toLocaleString(browserOrSpanish() ?? dateLocale(), { timeZone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** A long press (half a second) on a button, as a phone's apps take one: `consume` says whether the click after it was that press. */
export function useLongPress(onLong: () => void, ms = 500) {
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const fired = useRef(false);
  const cancel = () => clearTimeout(timer.current);
  useEffect(() => cancel, []);
  return {
    handlers: {
      onPointerDown: (e: PointerEvent) => {
        if (e.pointerType === "mouse") return;
        fired.current = false;
        cancel();
        timer.current = setTimeout(() => {
          fired.current = true;
          onLong();
        }, ms);
      },
      onPointerUp: cancel,
      onPointerLeave: cancel,
      onPointerCancel: cancel,
      onContextMenu: (e: { preventDefault: () => void }) => e.preventDefault(),
    },
    consume: () => {
      const was = fired.current;
      fired.current = false;
      return was;
    },
  };
}

/** Pick a date and a time, read where the business is. */
export function PickTimeDialog({ open, title, confirmLabel, onClose, onPick, busy }: { open: boolean; title: string; confirmLabel: string; onClose: () => void; onPick: (at: Date) => void; busy?: boolean }) {
  const { company } = useSession();
  const tz = company.timezone;
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  useEffect(() => {
    if (!open) return;
    const start = pickerStart(new Date(), tz);
    setDate(start.date);
    setTime(start.time);
  }, [open, tz]);
  const at = pickedTime(date, time, new Date(), tz);
  const elsewhere = Intl.DateTimeFormat().resolvedOptions().timeZone !== tz;
  return (
    <Dialog open={open} onClose={onClose} title={title} size="sm">
      <form className="dialog-body stack-sm" onSubmit={(e) => { e.preventDefault(); if (at) onPick(at); }}>
        <div className={f.pickRow}>
          <Field label={t("Date")}>
            <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
          </Field>
          <Field label={t("Time")}>
            <input className="input" type="time" value={time} onChange={(e) => setTime(e.target.value)} required step={300} />
          </Field>
        </div>
        {elsewhere && <p className="muted small" style={{ margin: 0 }}>{t("Times are where the business is ({zone}).", { zone: tz.replace(/_/g, " ") })}</p>}
        {date && time && !at && <p className="field-error" style={{ margin: 0 }}>{t("Pick a time that hasn't passed.")}</p>}
        <div className="form-actions">
          <Button variant="ghost" onClick={onClose}>{t("Cancel")}</Button>
          <Button type="submit" variant="primary" disabled={!at} loading={busy}>{confirmLabel}</Button>
        </div>
      </form>
    </Dialog>
  );
}

/** On a computer: the chevron beside Send, with the times to send later. */
export function SendLaterMenu({ disabled, onPick }: { disabled: boolean; onPick: (at: Date) => void }) {
  const { company } = useSession();
  const [picking, setPicking] = useState(false);
  const choices = sendLaterChoices(new Date(), company.timezone);
  return (
    <>
      {disabled ? (
        <button type="button" className={f.laterBtn} disabled aria-label={t("Send later")} title={t("Send later")}><Icon name="chevronDown" size={14} /></button>
      ) : (
        <Menu
          label={t("Send later")}
          title={t("Send later")}
          align="end"
          triggerClassName={f.laterBtn}
          trigger={<Icon name="chevronDown" size={14} />}
          items={[
            { heading: t("Send later") },
            ...choices.map((c) => ({ label: t(c.label), icon: "clock" as const, onSelect: () => onPick(c.at) })),
            { label: t("Pick a date and time"), icon: "calendar", onSelect: () => setPicking(true) },
          ]}
        />
      )}
      <PickTimeDialog open={picking} title={t("Send later")} confirmLabel={t("Schedule")} onClose={() => setPicking(false)} onPick={(at) => { setPicking(false); onPick(at); }} />
    </>
  );
}

/** On a phone, after a long press on Send: the same times, as a sheet. */
export function SendLaterSheet({ open, onClose, onPick }: { open: boolean; onClose: () => void; onPick: (at: Date) => void }) {
  const { company } = useSession();
  const [picking, setPicking] = useState(false);
  const choices = sendLaterChoices(new Date(), company.timezone);
  return (
    <>
      <Dialog open={open && !picking} onClose={onClose} title={t("Send later")} size="sm">
        <div className="dialog-body">
          <div className={f.choices}>
            {choices.map((c) => (
              <button key={c.key} type="button" className={f.choice} onClick={() => { onClose(); onPick(c.at); }}>
                <Icon name="clock" size={20} />
                <span><strong>{t(c.label)}</strong><small>{laterLabel(c.at.toISOString(), company.timezone)}</small></span>
              </button>
            ))}
            <button type="button" className={f.choice} onClick={() => setPicking(true)}>
              <Icon name="calendar" size={20} />
              <span><strong>{t("Pick a date and time")}</strong></span>
            </button>
          </div>
        </div>
      </Dialog>
      <PickTimeDialog open={open && picking} title={t("Send later")} confirmLabel={t("Schedule")} onClose={() => { setPicking(false); onClose(); }} onPick={(at) => { setPicking(false); onClose(); onPick(at); }} />
    </>
  );
}

/** Names for <@id> and <@&role> in a waiting message, from what the composer can mention. */
const namer = (options: readonly Mentionable[]) => (p: Exclude<MessagePart, { kind: "text" }>) =>
  p.kind === "everyone" ? t("everyone") : options.find((o) => o.token === (p.kind === "user" ? `<@${p.id}>` : `<@&${p.key}>`))?.label ?? (p.kind === "user" ? t("someone") : t("role"));

/** Above the box: "2 scheduled messages", opening the list of them. */
export function ScheduledBar({ channelId, options }: { channelId: string; options: readonly Mentionable[] }) {
  const scheduled = useScheduled();
  const [open, setOpen] = useState(false);
  const mine = (scheduled.data ?? []).filter((m) => m.channel_id === channelId);
  useEffect(() => {
    if (!mine.length) setOpen(false);
  }, [mine.length]);
  if (!mine.length) return null;
  return (
    <>
      <button type="button" className={f.scheduledBar} onClick={() => setOpen(true)}>
        <Icon name="clock" size={14} />
        <span>{t.plural(mine.length, { one: "{count} scheduled message", other: "{count} scheduled messages" })}</span>
        <Icon name="chevronRight" size={12} />
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} title={t("Scheduled messages")} description={t("They're sent at their time as you, if you can still post here.")}>
        <div className="dialog-body">
          <ul className={f.laterList}>
            {mine.map((m) => <ScheduledRow key={m.id} message={m} options={options} />)}
          </ul>
        </div>
      </Dialog>
    </>
  );
}

function ScheduledRow({ message, options }: { message: ScheduledMessage; options: readonly Mentionable[] }) {
  const { company } = useSession();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const refresh = () => queryClient.invalidateQueries({ queryKey: scheduledKey(company.id) });
  const sendNow = useMutation({
    meta: { inline: true },
    mutationFn: () => api.post<{ message: ChatMessage }>(`/chat/scheduled/${message.id}/send`),
    onSuccess: (r) => {
      addMessage(queryClient, company.id, r.message);
      void refresh();
    },
  });
  const remove = useMutation({
    meta: { inline: true },
    mutationFn: () => api.delete(`/chat/scheduled/${message.id}`),
    onSuccess: () => void refresh(),
  });
  const words = chatPlainText(message.body, namer(options)) || (message.attachments.length ? t("Photos or files") : t("A linked job"));
  return (
    <li className={f.laterRow}>
      <span className={f.laterWhen}><Icon name="clock" size={12} />{laterLabel(message.send_at, company.timezone)}</span>
      <span className={f.laterText}>{words}</span>
      <span className={f.laterActions}>
        <Button size="sm" icon="send" loading={sendNow.isPending} onClick={() => sendNow.mutate()}>{t("Send now")}</Button>
        <Button size="sm" variant="ghost" icon="edit" onClick={() => setEditing(true)}>{t("Edit")}</Button>
        <Button
          size="sm"
          variant="ghost"
          icon="trash"
          loading={remove.isPending}
          onClick={async () => {
            if (await confirm({ title: t("Delete this scheduled message?"), body: t("It won't be sent."), confirmLabel: t("Delete"), danger: true })) remove.mutate();
          }}
        >
          {t("Delete")}
        </Button>
      </span>
      <FormError error={sendNow.error ?? remove.error} />
      {editing && <EditScheduled message={message} options={options} onClose={() => setEditing(false)} />}
    </li>
  );
}

function EditScheduled({ message, options, onClose }: { message: ScheduledMessage; options: readonly Mentionable[]; onClose: () => void }) {
  const { company } = useSession();
  const queryClient = useQueryClient();
  const tz = company.timezone;
  const [text, setText] = useState(() => toEditable(message.body, namer(options)));
  const sendsAt = new Date(message.send_at);
  const [date, setDate] = useState(() => new Date(message.send_at).toLocaleDateString("en-CA", { timeZone: tz }));
  const [time, setTime] = useState(() => sendsAt.toLocaleTimeString("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit" }));
  const at = pickedTime(date, time, new Date(), tz);
  const save = useMutation({
    meta: { inline: true },
    mutationFn: () => api.patch(`/chat/scheduled/${message.id}`, { body: fromEditable(text.trim(), options), ...(at && at.getTime() !== sendsAt.getTime() && { send_at: at.toISOString() }) }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: scheduledKey(company.id) });
      onClose();
    },
  });
  const empty = !text.trim() && !message.attachments.length && !message.job_id;
  return (
    <Dialog open onClose={onClose} title={t("Edit the scheduled message")} size="sm">
      <form className="dialog-body stack-sm" onSubmit={(e) => { e.preventDefault(); if (at && !empty) save.mutate(); }}>
        <Field label={t("Message")}>
          <textarea className="textarea" rows={4} maxLength={4000} value={text} onChange={(e) => setText(e.target.value)} />
        </Field>
        <div className={f.pickRow}>
          <Field label={t("Date")}><input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} required /></Field>
          <Field label={t("Time")}><input className="input" type="time" value={time} onChange={(e) => setTime(e.target.value)} required step={300} /></Field>
        </div>
        {date && time && !at && <p className="field-error" style={{ margin: 0 }}>{t("Pick a time that hasn't passed.")}</p>}
        <FormError error={save.error} />
        <div className="form-actions">
          <Button variant="ghost" onClick={onClose}>{t("Cancel")}</Button>
          <Button type="submit" variant="primary" disabled={!at || empty} loading={save.isPending}>{t("Save")}</Button>
        </div>
      </form>
    </Dialog>
  );
}
