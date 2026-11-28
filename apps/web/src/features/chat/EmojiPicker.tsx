/**
 * Picking an emoji: to react to a message (with the three quick reactions over the emoji, those
 * you've added shown as on) or to put one in what you're writing. A search by the emoji's words,
 * the groups as tabs, and the ones you used lately first (kept in this browser). A popover beside
 * its button on a computer, a bottom sheet on a phone, as menus are (components/ui/Menu.tsx). Its
 * few hundred buttons are only drawn while it's open: every message has one.
 *
 * The emoji and their words come from core (chatEmoji.ts). The words are only for searching, never
 * shown, so they aren't translated.
 */
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { CHAT_REACTIONS } from "@crewtavo/core/chat";
import { CHAT_EMOJI, CHAT_EMOJI_GROUPS, findEmoji, reactionKind, rememberEmoji, type ChatEmoji } from "@crewtavo/core/chatEmoji";
import { Icon, type IconName } from "@/components/ui/Icon";
import { drag } from "@/components/ui/Menu";
import { SHEET_QUERY } from "@/components/ui/menuModel";
import { t } from "@/lib/i18n";
import x from "./emoji.module.css";

const RECENT = "crewtavo.chat.emoji";
const COLUMNS = 8;
/** The quick reactions' icons. */
export const QUICK_ICONS: Record<string, IconName> = { thumbs_up: "thumbsUp", on_it: "onIt", seen: "eye" };

function readRecent(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT) ?? "[]") as unknown;
    return Array.isArray(raw) ? raw.filter((e): e is string => typeof e === "string" && CHAT_EMOJI.some((x) => x.emoji === e)).slice(0, 24) : [];
  } catch {
    return [];
  }
}
function keepRecent(emoji: string) {
  try {
    localStorage.setItem(RECENT, JSON.stringify(rememberEmoji(readRecent(), emoji)));
  } catch {
    // Private mode: it just won't be remembered.
  }
}

const isPhone = () => window.matchMedia(SHEET_QUERY).matches;

export function EmojiPicker({
  label,
  trigger,
  triggerClassName,
  onPick,
  quick = false,
  mine = [],
  align = "end",
  disabled,
}: {
  label: string;
  trigger: ReactNode;
  triggerClassName: string;
  /** What was picked: an emoji, or, with `quick`, a reaction's kind (a quick one's key, 👍 being thumbs_up). */
  onPick: (kind: string) => void;
  /** The three quick reactions over the emoji. */
  quick?: boolean;
  /** Reactions that are already yours, shown as on. */
  mine?: string[];
  align?: "start" | "end";
  disabled?: boolean;
}) {
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);

  // Under its button (above it when there's more room there), lined up with its start or end; on a phone, the bottom sheet.
  useEffect(() => {
    const el = panel.current;
    if (!el) return;
    const beforeToggle = (e: Event) => {
      if ((e as Event & { newState: string }).newState !== "open") return;
      if (isPhone()) {
        el.dataset.sheet = "";
        el.style.left = el.style.top = el.style.bottom = el.style.maxHeight = "";
      } else delete el.dataset.sheet;
    };
    const onToggle = (e: Event) => {
      const now = (e as Event & { newState: string }).newState === "open";
      setOpen(now);
      if (!now || el.hasAttribute("data-sheet")) return;
      const b = button.current!.getBoundingClientRect();
      const width = el.offsetWidth;
      const left = align === "end" ? Math.max(8, b.right - width) : Math.min(Math.max(8, b.left), window.innerWidth - width - 8);
      // Its emoji draw once it's open, so it's placed by the height it will have (emoji.module.css), not the height it has yet.
      const height = Math.min(440, window.innerHeight * 0.7);
      const below = window.innerHeight - b.bottom - 14;
      const above = b.top - 14;
      const down = height <= below || below >= above;
      el.style.left = `${left}px`;
      el.style.top = down ? `${b.bottom + 6}px` : "auto";
      el.style.bottom = down ? "auto" : `${window.innerHeight - b.top + 6}px`;
      el.style.maxHeight = `${Math.max(200, Math.min(height, down ? below : above))}px`;
    };
    el.addEventListener("beforetoggle", beforeToggle);
    el.addEventListener("toggle", onToggle);
    return () => {
      el.removeEventListener("beforetoggle", beforeToggle);
      el.removeEventListener("toggle", onToggle);
    };
  }, [align]);

  const pick = (kind: string) => {
    panel.current?.hidePopover();
    button.current?.focus();
    onPick(kind);
  };

  return (
    <>
      <button
        ref={button}
        type="button"
        className={triggerClassName}
        aria-label={label}
        title={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={id}
        popovertarget={id}
        disabled={disabled}
      >
        {trigger}
      </button>
      {/* A tap in the picker isn't a tap on the message it's opened from. */}
      <div ref={panel} id={id} className={`menu ${x.picker}`} role="dialog" aria-label={label} popover="auto" onClick={(e) => e.stopPropagation()}>
        {open && <PickerBody label={label} quick={quick} mine={mine} onPick={pick} onClose={() => { panel.current?.hidePopover(); button.current?.focus(); }} sheet={() => panel.current} />}
      </div>
    </>
  );
}

function PickerBody({ label, quick, mine, onPick, onClose, sheet }: { label: string; quick: boolean; mine: string[]; onPick: (kind: string) => void; onClose: () => void; sheet: () => HTMLElement | null }) {
  const ids = useId();
  const [query, setQuery] = useState("");
  const [recent] = useState(readRecent);
  const scroller = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  // On a desktop typing starts in the search; on a phone that would pull the keyboard up over the sheet.
  useEffect(() => {
    if (!isPhone()) field.current?.focus();
  }, []);

  const found = useMemo(() => (query.trim() ? findEmoji(query) : null), [query]);
  const recentEmoji = useMemo(() => recent.map((e) => CHAT_EMOJI.find((x) => x.emoji === e)).filter((e): e is ChatEmoji => Boolean(e)), [recent]);
  // A reaction: 👍 is the quick thumbs up. Into the text: the emoji itself.
  const choose = (emoji: string) => {
    keepRecent(emoji);
    onPick(quick ? reactionKind(emoji) : emoji);
  };
  const own = new Set(mine);

  // Arrow keys move through the emoji, a row being eight.
  const keys = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : e.key === "ArrowDown" ? COLUMNS : e.key === "ArrowUp" ? -COLUMNS : 0;
    if (!step) return;
    const all = [...(scroller.current?.querySelectorAll<HTMLButtonElement>(`.${x.emoji}`) ?? [])];
    const at = all.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    e.preventDefault();
    all[Math.min(all.length - 1, Math.max(0, at + step))]?.focus();
  };
  const jump = (group: string) => {
    const head = scroller.current?.querySelector<HTMLElement>(`[data-group="${group}"]`);
    if (head && scroller.current) scroller.current.scrollTop = head.offsetTop - scroller.current.offsetTop;
  };

  const grid = (list: readonly ChatEmoji[], key: string) => (
    <div className={x.grid} role="group" aria-labelledby={key}>
      {list.map((e) => (
        <button key={e.emoji} type="button" className={x.emoji} aria-pressed={own.has(reactionKind(e.emoji)) || undefined} onClick={() => choose(e.emoji)}>
          {e.emoji}
        </button>
      ))}
    </div>
  );

  return (
    <>
      <div className="menu-top">
        <span className="menu-grab" aria-hidden="true" onPointerDown={(e) => drag(e, sheet())} />
        <div className="menu-sheet-head">
          <span className="menu-sheet-titles" aria-hidden="true"><span className="menu-sheet-title">{label}</span></span>
          <button type="button" className="menu-back" aria-label={t("Close")} onClick={onClose}><Icon name="x" size={20} /></button>
        </div>
      </div>
      <div className={x.search}>
        <Icon name="search" size={15} />
        <input ref={field} type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("Find an emoji")} aria-label={t("Find an emoji")} autoComplete="off" enterKeyHint="search"
          onKeyDown={(e) => {
            if (e.key === "Enter" && found?.[0]) {
              e.preventDefault();
              choose(found[0].emoji);
            }
          }}
        />
      </div>
      {quick && !found && (
        <div className={x.quick} role="group" aria-label={t("Quick reactions")}>
          {CHAT_REACTIONS.map((r) => (
            <button key={r.key} type="button" className={x.quickItem} aria-pressed={own.has(r.key)} onClick={() => onPick(r.key)}>
              <Icon name={QUICK_ICONS[r.key] ?? "react"} size={16} />
              <span>{t(r.label)}</span>
            </button>
          ))}
        </div>
      )}
      {!found && (
        <div className={x.tabs} role="group" aria-label={t("Emoji groups")}>
          {recentEmoji.length > 0 && <button type="button" className={x.tab} aria-label={t("Used lately")} title={t("Used lately")} onClick={() => jump("recent")}><Icon name="history" size={16} /></button>}
          {CHAT_EMOJI_GROUPS.map((g) => (
            <button key={g.key} type="button" className={x.tab} aria-label={t(g.label)} title={t(g.label)} onClick={() => jump(g.key)}><span aria-hidden="true">{g.icon}</span></button>
          ))}
        </div>
      )}
      <div ref={scroller} className={x.scroll} onKeyDown={keys}>
        {found ? (
          found.length ? (
            <>
              <div className={x.heading} id={`${ids}-found`}>{t("Found")}</div>
              {grid(found, `${ids}-found`)}
            </>
          ) : (
            <p className={x.none}>{t("No emoji for “{query}”", { query: query.trim() })}</p>
          )
        ) : (
          <>
            {recentEmoji.length > 0 && (
              <>
                <div className={x.heading} data-group="recent" id={`${ids}-recent`}>{t("Used lately")}</div>
                {grid(recentEmoji, `${ids}-recent`)}
              </>
            )}
            {CHAT_EMOJI_GROUPS.map((g) => (
              <div key={g.key}>
                <div className={x.heading} data-group={g.key} id={`${ids}-${g.key}`}>{t(g.label)}</div>
                {grid(CHAT_EMOJI.filter((e) => e.group === g.key), `${ids}-${g.key}`)}
              </div>
            ))}
          </>
        )}
      </div>
    </>
  );
}
