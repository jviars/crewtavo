/**
 * Searching team chat (/chat?view=search, or /chat/:channel?view=search&in=: "Search this
 * channel"). On a computer the field sits at the top of the channel list (ChatSearchField) and the
 * results take the conversation's place; on a phone a button in the list's head opens the search as
 * a screen of its own, with its field at the top. What's asked lives in the address (q, in, from,
 * has, after, before, order), so Back from a message comes back to the same results.
 *
 * The server searches as the person (GET /api/chat/search, public.chat_search), so the results are
 * only messages they can read. Tapping one opens it in its channel (?message=).
 */
import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Field } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { Menu, type MenuEntry } from "@/components/ui/Menu";
import { Loading, Skeleton } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState } from "@/components/ui/States";
import { api } from "@/lib/api";
import { msg, t } from "@/lib/i18n";
import { useSession } from "@/lib/session";
import type { ChatMessage, ChatState } from "./data";
import { MessageRow, PanelHead, useChatPeople, useNames, usePanelExit } from "./panels";
import { Avatar, channelLabel } from "./ui";
import s from "./chat.module.css";
import p from "./panels.module.css";

/** The field's id, so "Search this channel" can put the cursor in it. */
export const SEARCH_FIELD_ID = "chat-search-field";
const HAS = [
  { key: "photo", label: msg("A photo"), icon: "image" },
  { key: "file", label: msg("A file"), icon: "file" },
  { key: "job", label: msg("A linked job"), icon: "job" },
  { key: "link", label: msg("A link"), icon: "link" },
] as const;

interface Search {
  q: string;
  in: string | null;
  from: string | null;
  has: string[];
  /** Days, as yyyy-mm-dd: on or after, and before. */
  after: string | null;
  before: string | null;
  order: "newest" | "best";
}

const readSearch = (params: URLSearchParams): Search => ({
  q: params.get("q") ?? "",
  in: params.get("in"),
  from: params.get("from"),
  has: (params.get("has") ?? "").split(",").filter((h) => HAS.some((x) => x.key === h)),
  after: params.get("after"),
  before: params.get("before"),
  order: params.get("order") === "best" ? "best" : "newest",
});

/** What a search asks the server, once there's something to look for. */
const asking = (search: Search) => search.q.trim().length >= 2 || Boolean(search.from || search.has.length || search.after || search.before);

/** A day in the browser's own time, as yyyy-mm-dd. */
const isoDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const daysAgo = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return isoDay(d);
};
const startOf = (day: string) => new Date(`${day}T00:00:00`).toISOString();
const dayText = (day: string) => new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric", year: new Date(`${day}T12:00:00`).getFullYear() === new Date().getFullYear() ? undefined : "numeric" });

/** Changing what's asked: typing replaces the address (so Back isn't a letter at a time), everything else adds to it. */
function useSetSearch() {
  const [params, setParams] = useSearchParams();
  return (patch: Partial<Record<keyof Search, string | null>>, options: { replace?: boolean } = {}) => {
    const next = new URLSearchParams(params);
    next.set("view", "search");
    next.delete("message");
    for (const [key, value] of Object.entries(patch)) {
      if (value === null || value === "") next.delete(key);
      else next.set(key, value);
    }
    setParams(next, { replace: options.replace ?? params.get("view") === "search" });
  };
}

/** The search field: at the top of the channel list on a computer, at the top of the search screen on a phone. */
export function ChatSearchField({ state, className, autoFocus, id }: { state: ChatState | undefined; className?: string; autoFocus?: boolean; id?: string }) {
  const [params, setParams] = useSearchParams();
  const setSearch = useSetSearch();
  const open = params.get("view") === "search";
  const value = open ? params.get("q") ?? "" : "";
  const inChannel = open ? state?.channels.find((c) => c.id === params.get("in")) : undefined;
  const label = inChannel ? t("Search {channel}", { channel: channelLabel(inChannel) }) : t("Search chat");
  const close = () => {
    const next = new URLSearchParams(params);
    for (const key of ["view", "q", "in", "from", "has", "after", "before", "order"]) next.delete(key);
    setParams(next);
  };
  return (
    <form className={className} role="search" onSubmit={(e: FormEvent) => e.preventDefault()}>
      <label className="search-field">
        <Icon name="search" size={15} />
        <input
          id={id}
          type="search"
          value={value}
          placeholder={label}
          aria-label={label}
          enterKeyHint="search"
          autoComplete="off"
          autoFocus={autoFocus}
          maxLength={200}
          onChange={(e) => setSearch({ q: e.target.value }, { replace: open })}
          onKeyDown={(e) => {
            if (e.key === "Escape" && open) {
              e.preventDefault();
              if (value) setSearch({ q: null });
              else close();
            }
          }}
        />
      </label>
    </form>
  );
}

/** Wait until typing pauses before searching. */
function useSettled<T>(value: T, ms = 250): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

interface ResultsPage {
  messages: ChatMessage[];
  has_more: boolean;
  next: number;
}

export function SearchPanel({ state }: { state: ChatState | undefined }) {
  const { company } = useSession();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const exit = usePanelExit();
  const setSearch = useSetSearch();
  const search = readSearch(params);
  const settled = useSettled(search);
  const people = useChatPeople();
  const names = useNames(state, people.data);
  const [picking, setPicking] = useState(false);
  const listTop = useRef<HTMLDivElement>(null);

  const key = JSON.stringify({ ...settled, q: settled.q.trim() });
  const results = useInfiniteQuery({
    queryKey: ["chat", company.id, "search", key],
    enabled: asking(settled),
    initialPageParam: 0,
    placeholderData: keepPreviousData,
    queryFn: ({ pageParam }) => {
      const query = new URLSearchParams({ q: settled.q.trim(), order: settled.order, offset: String(pageParam) });
      if (settled.in) query.set("channel", settled.in);
      if (settled.from) query.set("from", settled.from);
      if (settled.has.length) query.set("has", settled.has.join(","));
      if (settled.after) query.set("after", startOf(settled.after));
      if (settled.before) query.set("before", startOf(settled.before));
      return api.get<ResultsPage>(`/chat/search?${query}`);
    },
    getNextPageParam: (last) => (last.has_more ? last.next : undefined),
    staleTime: 30_000,
  });
  const messages = useMemo(() => results.data?.pages.flatMap((page) => page.messages) ?? [], [results.data]);
  useEffect(() => listTop.current?.scrollIntoView({ block: "nearest" }), [key]);

  const channel = state?.channels.find((c) => c.id === search.in);
  const person = people.data?.find((x) => x.id === search.from);
  const filtered = Boolean(search.in || search.from || search.has.length || search.after || search.before);
  const [channelQuery, setChannelQuery] = useState("");
  const [personQuery, setPersonQuery] = useState("");

  const channelItems: MenuEntry[] = [
    { label: t("Any channel"), icon: "chat", checked: !search.in, onSelect: () => setSearch({ in: null }, { replace: false }) },
    { separator: true },
    ...(state?.channels ?? [])
      .filter((c) => !channelQuery.trim() || c.name.toLowerCase().includes(channelQuery.trim().toLowerCase()))
      .map((c): MenuEntry => ({ label: channelLabel(c), icon: c.kind === "announcement" ? "megaphone" : "hash", checked: search.in === c.id, onSelect: () => setSearch({ in: c.id }, { replace: false }) })),
  ];
  const personItems: MenuEntry[] = [
    { label: t("Anyone"), icon: "users", checked: !search.from, onSelect: () => setSearch({ from: null }, { replace: false }) },
    { separator: true },
    ...(people.data ?? [])
      .filter((x) => !personQuery.trim() || x.name.toLowerCase().includes(personQuery.trim().toLowerCase()))
      .map((x): MenuEntry => ({
        label: x.name,
        lead: <Avatar name={x.name} color={x.avatar_color} photo={x.avatar_url} size={20} />,
        end: x.role_label,
        checked: search.from === x.id,
        onSelect: () => setSearch({ from: x.id }, { replace: false }),
      })),
  ];
  const hasItems: MenuEntry[] = HAS.map((h) => {
    const on = search.has.includes(h.key);
    return { label: t(h.label), icon: h.icon, checkbox: true, checked: on, onSelect: () => setSearch({ has: (on ? search.has.filter((x) => x !== h.key) : [...search.has, h.key]).join(",") }, { replace: false }) };
  });
  const presets = [
    { label: t("Today"), after: daysAgo(0) },
    { label: t("Last 7 days"), after: daysAgo(6) },
    { label: t("Last 30 days"), after: daysAgo(29) },
  ];
  const dateItems: MenuEntry[] = [
    { label: t("Any time"), checked: !search.after && !search.before, onSelect: () => setSearch({ after: null, before: null }, { replace: false }) },
    ...presets.map((d): MenuEntry => ({ label: d.label, checked: search.after === d.after && !search.before, onSelect: () => setSearch({ after: d.after, before: null }, { replace: false }) })),
    { separator: true },
    { label: t("Choose dates…"), icon: "calendar", onSelect: () => setPicking(true) },
  ];
  const dateLabel =
    search.after && search.before ? t("{from} to {to}", { from: dayText(search.after), to: dayText(search.before) })
    : search.after ? presets.find((d) => d.after === search.after)?.label ?? t("Since {day}", { day: dayText(search.after) })
    : search.before ? t("Before {day}", { day: dayText(search.before) })
    : t("Any time");
  const hasLabel = search.has.length === 0 ? t("Has") : search.has.length === 1 ? t(HAS.find((h) => h.key === search.has[0])!.label) : t("Has {count}", { count: search.has.length });

  const open = (m: ChatMessage) => navigate(`/chat/${m.channel_id}?message=${m.id}`);
  // A filter that's set shows as on.
  const chip = (on: boolean) => (on ? `${p.chip} ${p.chipOn}` : p.chip);
  const query = settled.q.trim();
  const waiting = asking(search) && (results.isPending || (results.isPlaceholderData && results.isFetching));

  return (
    <section className={s.conversation} aria-label={t("Search team chat")}>
      <PanelHead title={channel ? t("Search {channel}", { channel: channelLabel(channel) }) : t("Search team chat")} icon="search" onClose={exit} />
      <div className={p.body}>
        <ChatSearchField state={state} className={`${p.field} mobile-only`} autoFocus={window.matchMedia("(max-width: 900px)").matches} />
        <div className={p.tools} role="group" aria-label={t("Filters")}>
          <Menu
            items={channelItems}
            label={channel ? t("In {channel}", { channel: channelLabel(channel) }) : t("In any channel")}
            title={t("In a channel")}
            align="start"
            triggerClassName={chip(Boolean(channel))}
            search={{ value: channelQuery, onChange: setChannelQuery, placeholder: t("Find a channel") }}
            trigger={<><Icon name="hash" size={13} /><span>{channel ? channelLabel(channel) : t("Any channel")}</span><Icon name="chevronDown" size={12} /></>}
          />
          <Menu
            items={personItems}
            label={person ? t("From {name}", { name: person.name }) : t("From anyone")}
            title={t("From")}
            align="start"
            triggerClassName={chip(Boolean(person))}
            search={{ value: personQuery, onChange: setPersonQuery, placeholder: t("Find a person") }}
            trigger={<><Icon name="user" size={13} /><span>{person ? person.name : t("Anyone")}</span><Icon name="chevronDown" size={12} /></>}
          />
          <Menu items={hasItems} label={t("What it has")} title={t("What it has")} align="start" triggerClassName={chip(search.has.length > 0)} trigger={<><Icon name="paperclip" size={13} /><span>{hasLabel}</span><Icon name="chevronDown" size={12} /></>} />
          <Menu items={dateItems} label={t("When: {when}", { when: dateLabel })} title={t("When")} align="start" triggerClassName={chip(Boolean(search.after || search.before))} trigger={<><Icon name="calendar" size={13} /><span>{dateLabel}</span><Icon name="chevronDown" size={12} /></>} />
          <Menu
            items={[
              { label: t("Newest first"), checked: search.order === "newest", onSelect: () => setSearch({ order: null }, { replace: false }) },
              { label: t("Best match first"), checked: search.order === "best", onSelect: () => setSearch({ order: "best" }, { replace: false }) },
            ]}
            label={t("Order")}
            title={t("Order")}
            align="start"
            triggerClassName={p.chip}
            trigger={<><Icon name="sort" size={13} /><span>{search.order === "best" ? t("Best match") : t("Newest")}</span><Icon name="chevronDown" size={12} /></>}
          />
          {filtered && <button type="button" className={p.clear} onClick={() => setSearch({ in: null, from: null, has: null, after: null, before: null }, { replace: false })}>{t("Clear filters")}</button>}
        </div>
        <div ref={listTop} />
        {!asking(search) ? (
          <div className={p.state}>
            <EmptyState compact icon="search" title={t("Search team chat")}>
              {t("Find messages, files and voice notes by what they say. Narrow it down by channel, person, date or what a message has.")}
            </EmptyState>
          </div>
        ) : results.error && !messages.length ? (
          <div className={p.state}><ErrorState compact error={results.error} onRetry={() => results.refetch()} /></div>
        ) : waiting && !messages.length ? (
          <Loading label={t("Searching")}>
            {[0, 1, 2, 3].map((i) => <div key={i} className={p.skeleton}><Skeleton width={180} height={11} /><Skeleton width="80%" height={13} /></div>)}
          </Loading>
        ) : !messages.length ? (
          <div className={p.state}>
            <EmptyState compact icon="search" title={t("No messages found")} action={filtered ? <Button size="sm" onClick={() => setSearch({ in: null, from: null, has: null, after: null, before: null }, { replace: false })}>{t("Clear filters")}</Button> : undefined}>
              {filtered ? t("Try other words, or fewer filters.") : t("Try other words, or fewer of them.")}
            </EmptyState>
          </div>
        ) : (
          <>
            <ol className={p.list} aria-label={t("Results")} aria-busy={waiting || undefined}>
              {messages.map((m) => <MessageRow key={m.id} message={m} state={state} names={names} query={query} onOpen={() => open(m)} />)}
            </ol>
            {results.hasNextPage && (
              <div className={p.more}>
                <Button size="sm" loading={results.isFetchingNextPage} onClick={() => void results.fetchNextPage()}>{t("Show more")}</Button>
              </div>
            )}
          </>
        )}
      </div>
      <DatesDialog
        open={picking}
        after={search.after}
        before={search.before}
        onClose={() => setPicking(false)}
        onSave={(after, before) => {
          setSearch({ after, before }, { replace: false });
          setPicking(false);
        }}
      />
    </section>
  );
}

/** Messages on or after one day, before another, or both. */
function DatesDialog({ open, after, before, onClose, onSave }: { open: boolean; after: string | null; before: string | null; onClose: () => void; onSave: (after: string | null, before: string | null) => void }) {
  const [from, setFrom] = useState(after ?? "");
  const [to, setTo] = useState(before ?? "");
  useEffect(() => {
    if (!open) return;
    setFrom(after ?? "");
    setTo(before ?? "");
  }, [open, after, before]);
  const wrong = Boolean(from && to && to <= from);
  return (
    <Dialog open={open} onClose={onClose} title={t("Choose dates")} size="sm">
      <form className="dialog-body stack-sm" onSubmit={(e) => { e.preventDefault(); if (!wrong) onSave(from || null, to || null); }}>
        <div className={p.dates}>
          <Field label={t("On or after")}><input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
          <Field label={t("Before")} error={wrong ? t("Pick a day after the first.") : null}><input className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
        </div>
        <div className="form-actions">
          <Button variant="ghost" onClick={onClose}>{t("Cancel")}</Button>
          <Button type="submit" variant="primary" disabled={wrong}>{t("Show messages")}</Button>
        </div>
      </form>
    </Dialog>
  );
}
