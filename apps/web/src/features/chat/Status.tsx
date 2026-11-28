/**
 * Status in Team chat: what someone is doing, as a small icon with words, in the member list, on
 * their card and in the mention suggestions. Each person sets their own from their own card (tap
 * your face or name in chat): one of six, or their own words, and when it clears. While someone's
 * clock runs, the clock's says Driving, On a break or On a job, unless they set one by hand
 * (public.chat_statuses). Changes arrive live (the "status" event); the clock's are read again each
 * minute.
 */
import { CUSTOM_STATUS, STATUS_CLEARS, STATUS_KINDS, STATUS_TEXT_MAX, statusUntil, type StatusClear } from "@crewtavo/core/chatField";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Field, FormError } from "@/components/ui/Field";
import { Icon, type IconName } from "@/components/ui/Icon";
import { Select } from "@/components/ui/Select";
import { api } from "@/lib/api";
import { dateLocale } from "@/lib/format";
import { browserOrSpanish, t } from "@/lib/i18n";
import { useSession } from "@/lib/session";
import { chatOn } from "./data";
import { timeLabel } from "./ui";
import f from "./field.module.css";

export interface ChatStatus {
  user_id: string;
  kind: string;
  words: string | null;
  until: string | null;
  by_clock: boolean;
}

export const STATUS_ICONS: Record<string, IconName> = { on_job: "job", driving: "truck", break: "coffee", off: "moon", office: "office", busy: "busy", custom: "react" };

export const statusesKey = (company: string) => ["chat", company, "statuses"] as const;

/** Everyone's status now, by person. */
export function useStatuses(): Map<string, ChatStatus> {
  const session = useSession();
  const query = useQuery({
    queryKey: statusesKey(session.company.id),
    enabled: chatOn(session),
    queryFn: () => api.get<{ statuses: ChatStatus[] }>("/chat/statuses").then((r) => r.statuses),
    // Set by hand, a status arrives live; the clock's changes as people clock in and out.
    refetchInterval: 60_000,
    staleTime: 30_000,
    meta: { silent: true },
  });
  const [ticks, tick] = useState(0);
  // One that clears by itself goes at its time, without waiting for the next read.
  useEffect(() => {
    const next = Math.min(...(query.data ?? []).map((s) => (s.until ? Date.parse(s.until) : Infinity)));
    if (!Number.isFinite(next)) return;
    const timer = setTimeout(() => tick((n) => n + 1), Math.max(1_000, Math.min(next - Date.now() + 500, 2 ** 31 - 1)));
    return () => clearTimeout(timer);
  }, [query.data]);
  return useMemo(() => {
    const now = Date.now();
    return new Map((query.data ?? []).filter((s) => !s.until || Date.parse(s.until) > now).map((s) => [s.user_id, s]));
    // ticks: read again as one clears.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query.data, ticks]);
}

/** The words of a status: theirs, or its kind's. */
export function statusWords(status: Pick<ChatStatus, "kind" | "words">): string {
  if (status.kind === CUSTOM_STATUS) return status.words ?? "";
  const kind = STATUS_KINDS.find((k) => k.key === status.kind);
  return kind ? t(kind.label) : "";
}

/** A status as a small icon with its words (`iconOnly`: the icon, with the words for a screen reader and on hover). */
export function StatusChip({ status, iconOnly, className }: { status: ChatStatus | undefined; iconOnly?: boolean; className?: string }) {
  if (!status) return null;
  const words = statusWords(status);
  return (
    <span className={`${f.status} ${className ?? ""}`} title={status.by_clock ? t("{status}, from the clock", { status: words }) : words}>
      <Icon name={STATUS_ICONS[status.kind] ?? "react"} size={12} />
      {iconOnly ? <span className="sr-only">{words}</span> : <span className={f.statusWords}>{words}</span>}
    </span>
  );
}

/** Set a status: one of six or my own words, and when it clears. Clear status takes it off. */
export function SetStatusDialog({ open, onClose, current }: { open: boolean; onClose: () => void; current: ChatStatus | undefined }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const mine = current && !current.by_clock ? current : undefined;
  const [kind, setKind] = useState<string>(mine?.kind ?? "on_job");
  const [words, setWords] = useState(mine?.words ?? "");
  const [clears, setClears] = useState<StatusClear>(mine ? (mine.until ? "today" : "never") : "4h");
  useEffect(() => {
    if (!open) return;
    setKind(mine?.kind ?? "on_job");
    setWords(mine?.words ?? "");
    setClears(mine ? (mine.until ? "today" : "never") : "4h");
  }, [open, mine]);
  const refresh = () => queryClient.invalidateQueries({ queryKey: statusesKey(session.company.id) });
  const save = useMutation({
    meta: { inline: true },
    mutationFn: () => {
      const until = statusUntil(clears, new Date(), session.company.timezone);
      return api.put<{ status: ChatStatus }>("/chat/status", { kind, words: kind === CUSTOM_STATUS ? words.trim() : null, until: until?.toISOString() ?? null });
    },
    onSuccess: () => {
      void refresh();
      onClose();
    },
  });
  const clear = useMutation({
    meta: { inline: true },
    mutationFn: () => api.delete("/chat/status"),
    onSuccess: () => {
      void refresh();
      onClose();
    },
  });
  const ready = kind !== CUSTOM_STATUS || words.trim().length > 0;
  return (
    <Dialog open={open} onClose={onClose} title={t("Set a status")} description={t("Your team sees it beside your name in Team chat.")} size="sm">
      <form className="dialog-body stack-sm" onSubmit={(e) => { e.preventDefault(); if (ready) save.mutate(); }}>
        <div className={f.statusChoices} role="radiogroup" aria-label={t("Status")}>
          {STATUS_KINDS.map((k) => (
            <button key={k.key} type="button" role="radio" aria-checked={kind === k.key} className={f.statusChoice} onClick={() => setKind(k.key)}>
              <Icon name={STATUS_ICONS[k.key]!} size={18} />
              <span>{t(k.label)}</span>
            </button>
          ))}
          <button type="button" role="radio" aria-checked={kind === CUSTOM_STATUS} className={f.statusChoice} onClick={() => setKind(CUSTOM_STATUS)}>
            <Icon name="react" size={18} />
            <span>{t("In my own words")}</span>
          </button>
        </div>
        {kind === CUSTOM_STATUS && (
          <Field label={t("Your status")} hint={t("{count} of {max} characters", { count: words.length, max: STATUS_TEXT_MAX })}>
            <input className="input" value={words} maxLength={STATUS_TEXT_MAX} autoFocus onChange={(e) => setWords(e.target.value)} placeholder={t("At the supply yard")} />
          </Field>
        )}
        <Field label={t("Clear it")}>
          <Select className="select" value={clears} onChange={(e) => setClears(e.target.value as StatusClear)}>
            {STATUS_CLEARS.map((c) => <option key={c.key} value={c.key}>{t(c.label)}</option>)}
          </Select>
        </Field>
        <FormError error={save.error ?? clear.error} />
        <div className="form-actions">
          {mine && <Button variant="ghost" loading={clear.isPending} onClick={() => clear.mutate()}>{t("Clear status")}</Button>}
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!ready}>{t("Save")}</Button>
        </div>
      </form>
    </Dialog>
  );
}

/** On a person's card: their status, when it clears, and for my own, Set a status. */
export function StatusOnCard({ personId, status }: { personId: string; status: ChatStatus | undefined }) {
  const { userId } = useSession();
  const [setting, setSetting] = useState(false);
  const mine = personId === userId;
  if (!status && !mine) return null;
  return (
    <div className={f.cardStatus}>
      {status ? (
        <span className={f.cardStatusLine}>
          <Icon name={STATUS_ICONS[status.kind] ?? "react"} size={16} />
          <span>{statusWords(status)}</span>
          {status.until && <small>{t("until {time}", { time: untilLabel(status.until) })}</small>}
          {status.by_clock && <small>{t("from the clock")}</small>}
        </span>
      ) : null}
      {mine && (
        <Button size="sm" icon="react" onClick={() => setSetting(true)}>{status && !status.by_clock ? t("Change your status") : t("Set a status")}</Button>
      )}
      {mine && <SetStatusDialog open={setting} onClose={() => setSetting(false)} current={status} />}
    </div>
  );
}

/** "4:30 PM", or "Fri 4:30 PM" when it isn't today. */
function untilLabel(iso: string) {
  const d = new Date(iso);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay ? timeLabel(iso) : `${d.toLocaleDateString(browserOrSpanish() ?? dateLocale(), { weekday: "short" })} ${timeLabel(iso)}`;
}
