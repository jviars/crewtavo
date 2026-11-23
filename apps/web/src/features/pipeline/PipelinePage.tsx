/**
 * Sales pipeline: open requests and quotes as a board with value and age. Drag a request to
 * "Drafting quote" to start a quote, a draft to "Awaiting response" to send it, a sent quote to
 * "Approved" to mark it approved (keeping its template and contract, as "Mark approved" on the quote
 * does), or anything to "Lost". Each card's menu makes the same moves without a mouse. A quote that
 * offers options (quote_options) is approved from its own page, where the office says which option
 * they chose; until it's signed, its value here is its cheapest option's (quotes/options.ts
 * listPrice), as on the quotes list.
 *
 * Desktop: the stages as quiet lanes on the page, each card a client, #number, what it's for, its
 * money and how long since it last changed. Phone (max-width 900px): the stages as chips over an
 * inbox list of that stage, not a board that scrolls sideways.
 *
 * Once a move is saved and the board reads again, the card glides from its old lane to its new one
 * and the cards around it close up or make room (Motion's layout animations), unless the person
 * prefers less motion.
 */
import type { Json } from "@crewtavo/core/database";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LazyMotion, MotionConfig, domMax, m } from "motion/react";
import { useEffect, useId, useRef, useState, type DragEvent, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { confirm } from "@/components/ui/Confirm";
import { Icon, type IconName } from "@/components/ui/Icon";
import { InboxGroup, InboxList, InboxRow, ListFoot, MetaLine, RowAge, shortAge, type GroupTone } from "@/components/ui/InboxList";
import { Menu, type MenuEntry } from "@/components/ui/Menu";
import { BackLink, PageHeader } from "@/components/ui/PageHeader";
import { InboxSkeleton, Loading, Skeleton, StatsSkeleton } from "@/components/ui/Skeleton";
import { Stat, StatStrip } from "@/components/ui/StatStrip";
import { EmptyState, ErrorState } from "@/components/ui/States";
import { EntityStatus, statusText } from "@/components/ui/StatusPill";
import { FilterTabs, Toolbar } from "@/components/ui/Toolbar";
import { api, supabase, unwrap } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { formatDateTime, formatMoney } from "@/lib/format";
import { useSession } from "@/lib/session";
import { toast, type ToastTone } from "@/lib/toast";
import { ALREADY_ANSWERED, listPrice, withOptionLines } from "../quotes/options";
import { optionsNote } from "../quotes/QuotesPage";
import { SendDialog } from "../quotes/SendDialog";

interface Card {
  kind: "request" | "quote";
  id: string;
  status: string;
  number: number | null;
  title: string;
  client: string;
  email: string | null;
  phone: string | null;
  value: number | null;
  /** The value is its cheapest option's: it offers options and isn't signed yet. */
  from: boolean;
  updated: string;
  /** How many options a quote offers. */
  options: number;
  /** The option shown first; once it's signed, the one chosen, which its value is for. */
  option: { name: string; tier: string | null } | null;
}
type ColumnKey = "new" | "assess" | "draft" | "sent" | "won";

const PICK_ON_QUOTE = "Open the quote to pick the option they chose.";

/**
 * Why a card dropped on a column can't move there from the board, or null when it can: a quote that
 * offers options is approved on its own page, which asks which option they chose. (Options added
 * since the board was read are caught as it's approved.)
 */
export function moveRefusal(card: Pick<Card, "kind" | "options">, to: ColumnKey | "lost"): string | null {
  return card.kind === "quote" && to === "won" && card.options > 0 ? PICK_ON_QUOTE : null;
}

/**
 * The stages, in order. `groups` is a stage that holds more than one status, as the phone groups it:
 * what someone must act on first. `empty` is what the phone says when the stage has nothing in it.
 */
const COLUMNS: Array<{ key: ColumnKey; label: string; statuses: string[]; kind: Card["kind"]; empty: string; groups?: Array<{ status: string; label: string; tone?: GroupTone; icon?: IconName }> }> = [
  { key: "new", label: "New requests", statuses: ["new"], kind: "request", empty: "No new requests" },
  {
    key: "assess",
    label: "Assessments",
    statuses: ["assessment_scheduled", "assessment_complete"],
    kind: "request",
    empty: "No assessments booked",
    groups: [
      { status: "assessment_complete", label: "Assessed: ready to quote", tone: "good", icon: "check" },
      { status: "assessment_scheduled", label: statusText("request", "assessment_scheduled") },
    ],
  },
  { key: "draft", label: "Drafting quote", statuses: ["draft"], kind: "quote", empty: "No quotes being drafted" },
  {
    key: "sent",
    label: "Awaiting response",
    statuses: ["sent", "changes_requested"],
    kind: "quote",
    empty: "No quotes waiting on a client",
    groups: [
      { status: "changes_requested", label: statusText("quote", "changes_requested"), tone: "warning", icon: "alert" },
      { status: "sent", label: "Sent" },
    ],
  },
  { key: "won", label: "Approved", statuses: ["approved"], kind: "quote", empty: "No approved quotes" },
];

const DAY = 86_400_000;
const daysOld = (iso: string) => Math.floor((Date.now() - Date.parse(iso)) / DAY);
/** A card nobody has moved in a week is amber, in two weeks red. */
const ageTone = (iso: string) => {
  const age = daysOld(iso);
  return age >= 14 ? ("danger" as const) : age >= 7 ? ("warning" as const) : undefined;
};
const cardLink = (c: Card) => `/${c.kind === "quote" ? "quotes" : "requests"}/${c.id}`;
/** Who it's for, or the record's own title when it has no client. */
const cardName = (c: Card) => c.client || c.title;
const money = (c: Card) => (c.value == null ? null : c.from ? `From ${formatMoney(c.value)}` : formatMoney(c.value));
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const waiting = (status: string) => status === "sent" || status === "changes_requested";

/** The same card in whichever column it's in, so Motion can carry it from one to the other. */
const cardKey = (c: Pick<Card, "kind" | "id">) => `${c.kind}-${c.id}`;
/** Settles quickly with a small overshoot, like the app's other springs (lib/spring.ts). */
const GLIDE = { type: "spring", bounce: 0.18, visualDuration: 0.38 } as const;

export function PipelinePage() {
  const { company, profile } = useSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [dragging, setDragging] = useState<Card | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [sending, setSending] = useState<Card | null>(null);
  const key = ["pipeline", company.id];

  const data = useQuery({
    queryKey: key,
    queryFn: async () => {
      const since = new Date(Date.now() - 30 * DAY).toISOString();
      const [requests, quotes, closed] = await Promise.all([
        supabase().from("requests").select("id, number, title, status, updated_at, client:clients(display_name, email, phone)").eq("company_id", company.id).in("status", ["new", "assessment_scheduled", "assessment_complete"]),
        supabase().from("quotes").select("id, number, title, status, total, tax_rate, discount_amount, promo:promo_codes(kind, value), updated_at, client:clients(display_name, email, phone), options:quote_options!quote_options_quote_fkey(id), option:quote_options!quotes_option_fkey(name, tier)").eq("company_id", company.id).in("status", ["draft", "sent", "changes_requested", "approved"]).eq("is_template", false),
        supabase().from("quotes").select("id, status, total, tax_rate, discount_amount, promo:promo_codes(kind, value), options:quote_options!quote_options_quote_fkey(id)").eq("company_id", company.id).in("status", ["converted", "lost"]).gte("updated_at", since),
      ]);
      // Quotes that offer options are worth their cheapest option until they're signed.
      const [open, c] = await Promise.all([withOptionLines(unwrap(quotes)), withOptionLines(unwrap(closed))]);
      const cards: Card[] = [
        ...unwrap(requests).map((x) => ({ kind: "request" as const, id: x.id, status: x.status, number: x.number, title: x.title, client: x.client?.display_name ?? "", email: x.client?.email ?? null, phone: x.client?.phone ?? null, value: null, from: false, updated: x.updated_at, options: 0, option: null })),
        ...open.map((x) => {
          const price = listPrice(x);
          return { kind: "quote" as const, id: x.id, status: x.status, number: x.number, title: x.title, client: x.client?.display_name ?? "", email: x.client?.email ?? null, phone: x.client?.phone ?? null, value: price.amount, from: price.from, updated: x.updated_at, options: x.options.length, option: x.option };
        }),
      ];
      const won = c.filter((q) => q.status === "converted");
      const lost = c.filter((q) => q.status === "lost");
      return { cards, won: { count: won.length, value: won.reduce((s, q) => s + listPrice(q).amount, 0) }, lost: { count: lost.length, value: lost.reduce((s, q) => s + listPrice(q).amount, 0) } };
    },
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: key });
    queryClient.invalidateQueries({ queryKey: ["quotes", company.id] });
    queryClient.invalidateQueries({ queryKey: ["requests", company.id] });
  };
  const move = useMutation({
    mutationFn: async ({ card, to }: { card: Card; to: ColumnKey | "lost" }): Promise<{ message: string; open?: string; refused?: boolean; tone?: ToastTone }> => {
      if (to === "lost") {
        if (card.kind === "quote") unwrap(await supabase().from("quotes").update({ status: "lost", lost_reason: "Marked lost from the pipeline" }).eq("id", card.id));
        else unwrap(await supabase().from("requests").update({ status: "archived" }).eq("id", card.id));
        return { message: card.kind === "quote" ? `Quote #${card.number} marked lost` : "Request archived", tone: card.kind };
      }
      if (card.kind === "request" && to === "draft") {
        const quote = await api.post<{ id: string }>(`/requests/${card.id}/quote`);
        return { message: "Quote started", open: `/quotes/${quote.id}`, tone: "quote" };
      }
      if (card.kind === "quote" && to === "won") {
        // The quote page's own approval, loaded only once a quote is dropped here.
        const { boardApproval } = await import("../quotes/QuotePage");
        const approval = await boardApproval(queryClient, card.id, { companyId: company.id, name: profile.full_name || "Office", trade: company.trade_preset });
        if (!approval) return { message: PICK_ON_QUOTE, refused: true, open: `/quotes/${card.id}` };
        // Only while it's still waiting: a client who signed meanwhile keeps their own approval.
        const saved = unwrap(
          await supabase().from("quotes").update({ status: "approved", approved_at: new Date().toISOString(), approval: approval as unknown as Json }).eq("id", card.id).in("status", ["sent", "changes_requested"]).select("id"),
        );
        if (!saved.length) return { message: ALREADY_ANSWERED, refused: true, open: `/quotes/${card.id}` };
        return { message: `Quote #${card.number} marked approved`, tone: "quote" };
      }
      throw new Error("That move isn't possible.");
    },
    onSuccess: (r) => {
      const action = r.open ? { action: { label: "Open", onClick: () => navigate(r.open!) } } : undefined;
      if (r.refused) toast.error(r.message, action);
      else toast.success(r.message, { ...action, tone: r.tone });
      refresh();
    },
  });

  const allowed = (card: Card, to: ColumnKey | "lost") =>
    to === "lost" ? true
    : card.kind === "request" ? to === "draft"
    : card.status === "draft" ? to === "sent"
    : waiting(card.status) ? to === "won"
    : false;
  /** Moves a card, dropped or picked from its menu: the same checks and questions either way. */
  const moveTo = async (card: Card, to: ColumnKey | "lost") => {
    if (!allowed(card, to)) return;
    const refusal = moveRefusal(card, to);
    if (refusal) return void toast.error(refusal, { action: { label: "Open", onClick: () => navigate(`/quotes/${card.id}`) } });
    if (card.kind === "quote" && card.status === "draft" && to === "sent") return setSending(card);
    if (to === "lost" && !(await confirm({ title: card.kind === "quote" ? `Mark quote #${card.number} lost?` : "Archive this request?", body: card.kind === "quote" ? "You can reopen it later from the quote." : "It leaves the pipeline. You can reopen it from the request.", confirmLabel: card.kind === "quote" ? "Mark lost" : "Archive", danger: true }))) return;
    move.mutate({ card, to });
  };
  const drop = (to: ColumnKey | "lost") => {
    const card = dragging;
    setDragging(null);
    setOver(null);
    if (card) void moveTo(card, to);
  };
  const zone = (to: ColumnKey | "lost"): Zone => ({
    onDragOver: (e: DragEvent) => {
      if (dragging && allowed(dragging, to)) {
        e.preventDefault();
        if (over !== to) setOver(to);
      }
    },
    onDragLeave: (e: DragEvent) => !(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node) && setOver(null),
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      drop(to);
    },
    "data-drop": over === to || undefined,
    // While a card is held, the stages it can go to show where to drop it.
    "data-target": (dragging && allowed(dragging, to)) || undefined,
  });

  /** A card's menu, as the Menus board's row menu: open it, the moves dragging makes, its link, then lost or archived last. */
  const actions = (c: Card): MenuEntry[] => {
    const quote = c.kind === "quote";
    return [
      { label: quote ? "Open quote" : "Open request", icon: "arrowUpRight", kbd: "↵", onSelect: () => navigate(cardLink(c)) },
      { label: "Start a quote", icon: "quote", kbd: "Q", hidden: quote, onSelect: () => void moveTo(c, "draft") },
      { label: "Send quote", icon: "send", kbd: "S", hidden: !(quote && c.status === "draft"), onSelect: () => void moveTo(c, "sent") },
      c.options > 0
        ? { label: "Mark approved", icon: "check", kbd: "A", description: "Pick their option on the quote", hidden: !(quote && waiting(c.status)), onSelect: () => navigate(`/quotes/${c.id}`) }
        : { label: "Mark approved", icon: "check", kbd: "A", hidden: !(quote && waiting(c.status)), onSelect: () => void moveTo(c, "won") },
      { separator: true },
      { label: "Copy link", icon: "link", onSelect: () => void copyText(new URL(cardLink(c), window.location.origin).href, "Link copied") },
      { separator: true },
      { label: quote ? "Mark lost" : "Archive request", icon: quote ? "x" : "archive", danger: true, onSelect: () => void moveTo(c, "lost") },
    ];
  };

  const cards = data.data?.cards ?? [];
  const lanes = COLUMNS.map((col) => {
    const items = cards.filter((c) => c.kind === col.kind && col.statuses.includes(c.status)).sort((a, b) => a.updated.localeCompare(b.updated));
    return { ...col, items, total: items.reduce((s, c) => s + (c.value ?? 0), 0) };
  });
  // The cards on the board when it last drew: one new to it (a quote just started) fades in, while one
  // that only changed column glides there. Nothing fades in the first time the board draws.
  const drawn = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (data.data) drawn.current = new Set(data.data.cards.map(cardKey));
  }, [data.data]);
  const openValue = cards.reduce((s, c) => s + (c.value ?? 0), 0);
  const quoteCount = cards.filter((c) => c.kind === "quote").length;
  const winRate = data.data && data.data.won.count + data.data.lost.count ? Math.round((data.data.won.count / (data.data.won.count + data.data.lost.count)) * 100) : null;

  // The phone shows one stage at a time: the one in the link, or the first with something in it.
  const asked = COLUMNS.find((c) => c.key === params.get("stage"))?.key;
  const stage = asked ?? lanes.find((l) => l.items.length)?.key ?? "new";
  const pickStage = (next: ColumnKey) => {
    const p = new URLSearchParams(params);
    p.set("stage", next);
    setParams(p, { replace: true });
  };
  const shown = lanes.find((l) => l.key === stage)!;

  return (
    <BoardMotion>
      <BackLink to="/quotes">Quotes</BackLink>
      {/* The hint shows while the board loads too, so the page doesn't shift when it arrives; not over an empty pipeline. */}
      <PageHeader title="Sales board" lede={data.isPending || cards.length > 0 ? <span className="pipe-hint">Drag a card to its next stage, or use its menu.</span> : undefined} />
      {data.error ? (
        <ErrorState error={data.error} onRetry={() => data.refetch()} />
      ) : data.isPending ? (
        <Loading className="pipe-loading">
          <StatsSkeleton count={4} />
          <div className="board" aria-hidden="true">
            {COLUMNS.map((c, i) => (
              <div key={c.key} className="board-lane">
                <div className="board-lane-head"><Skeleton width={96} height={12} /></div>
                <div className="board-cards">{Array.from({ length: 3 - (i % 2) }, (_, n) => <Skeleton key={n} height={84} radius={10} />)}</div>
              </div>
            ))}
          </div>
          <div className="pipe-phone"><InboxSkeleton rows={4} /></div>
        </Loading>
      ) : (
        <>
          {/* Not a row of $0s over an empty pipeline with nothing won or lost lately. */}
          {(cards.length > 0 || winRate !== null) && (
            <StatStrip label="Sales totals" className="pipe-stats">
              <Stat label="Open quotes" value={formatMoney(openValue)} note={[quoteCount > 0 && plural(quoteCount, "quote", "quotes"), cards.length > quoteCount && plural(cards.length - quoteCount, "request", "requests")].filter(Boolean).join(" · ") || undefined} />
              <Stat label="Won" value={formatMoney(data.data.won.value)} note={`${plural(data.data.won.count, "job", "jobs")} · last 30 days`} />
              <Stat label="Lost" value={formatMoney(data.data.lost.value)} note={`${plural(data.data.lost.count, "quote", "quotes")} · last 30 days`} />
              {winRate !== null && <Stat label="Win rate" value={`${winRate}%`} note="Last 30 days" />}
            </StatStrip>
          )}

          {cards.length === 0 ? (
            <EmptyState icon="pipeline" title="Nothing in the pipeline yet">New requests and open quotes show up here as they come in.</EmptyState>
          ) : (
            <>
              {/* The board scrolls sideways, so Motion measures its scroll too. */}
              <m.div className="board" role="group" aria-label="Sales board" layoutScroll>
                {lanes.map((lane) => (
                  <Lane key={lane.key} label={lane.label} count={lane.items.length} total={lane.total} zone={zone(lane.key)}>
                    {lane.items.map((c) => {
                      const card = cardKey(c);
                      return (
                        // A wrapper carries the motion: Motion would take the card's own (HTML) drag events as its gestures.
                        <m.div key={card} layout="position" layoutId={card} transition={GLIDE} initial={drawn.current && !drawn.current.has(card) ? { opacity: 0, scale: 0.96 } : false} animate={{ opacity: 1, scale: 1 }}>
                          <DealCard
                            card={c}
                            showStatus={c.status !== lane.statuses[0]}
                            dragging={dragging?.id === c.id}
                            actions={actions(c)}
                            onDragStart={() => setDragging(c)}
                            onDragEnd={() => {
                              setDragging(null);
                              setOver(null);
                            }}
                          />
                        </m.div>
                      );
                    })}
                  </Lane>
                ))}
              </m.div>

              <div className="pipe-phone">
                <Toolbar filters={<FilterTabs label="Stage" value={stage} onChange={pickStage} options={lanes.map((l) => ({ value: l.key, label: l.label, count: l.items.length || undefined }))} />} />
              </div>
              {shown.items.length === 0 ? (
                <div className="pipe-phone"><EmptyState inline title={shown.empty} /></div>
              ) : (
                <InboxList
                  className="pipe-phone"
                  label={shown.label}
                  foot={<ListFoot end={shown.total > 0 ? <><b>{formatMoney(shown.total)}</b> total</> : undefined}>{shown.kind === "quote" ? plural(shown.items.length, "quote", "quotes") : plural(shown.items.length, "request", "requests")}</ListFoot>}
                >
                  {shown.groups ? (
                    shown.groups.map((g) => {
                      const rows = shown.items.filter((c) => c.status === g.status);
                      if (!rows.length) return null;
                      // A quote group's quiet sum on the right, as the quotes list has it.
                      const sum = rows.reduce((s, c) => s + (c.value ?? 0), 0);
                      return (
                        <InboxGroup key={g.status} label={g.label} count={rows.length} tone={g.tone} icon={g.icon} end={sum > 0 ? formatMoney(sum) : undefined}>
                          {rows.map((c) => <PhoneRow key={c.id} card={c} />)}
                        </InboxGroup>
                      );
                    })
                  ) : (
                    <InboxGroup>{shown.items.map((c) => <PhoneRow key={c.id} card={c} />)}</InboxGroup>
                  )}
                </InboxList>
              )}
            </>
          )}
        </>
      )}
      {dragging && (
        <div className="board-lost" {...zone("lost")}>
          <Icon name={dragging.kind === "quote" ? "x" : "archive"} size={16} />
          Drop here to mark {dragging.kind === "quote" ? "lost" : "archived"}
        </div>
      )}
      {sending && <SendDialog kind="quote" id={sending.id} number={sending.number} email={sending.email} phone={sending.phone} onClose={() => setSending(null)} onSent={refresh} />}
    </BoardMotion>
  );
}

/** Motion for the board: its layout animations (domMax, since the smaller domAnimation set has none), still when the person prefers less motion. */
function BoardMotion({ children }: { children: ReactNode }) {
  return (
    <MotionConfig reducedMotion="user">
      <LazyMotion features={domMax}>{children}</LazyMotion>
    </MotionConfig>
  );
}

/** What makes a lane, or the Lost strip, take a dropped card. */
interface Zone {
  onDragOver: (e: DragEvent) => void;
  onDragLeave: (e: DragEvent) => void;
  onDrop: (e: DragEvent) => void;
  "data-drop"?: true;
  "data-target"?: true;
}

/** One stage: its name, a quiet count and total on a hairline, then its cards. The whole lane takes a drop. */
function Lane({ label, count, total, zone, children }: { label: string; count: number; total: number; zone: Zone; children: ReactNode }) {
  const id = useId();
  return (
    <section className="board-lane" aria-labelledby={id} {...zone}>
      <div className="board-lane-head">
        <h2 className="board-lane-title" id={id}>{label}</h2>
        <span className="board-lane-count">{count}</span>
        {total > 0 && <span className="board-lane-sum">{formatMoney(total)}</span>}
      </div>
      <div className="board-cards">
        {children}
        {count === 0 && <p className="board-empty">Nothing here</p>}
      </div>
    </section>
  );
}

/**
 * A card on the board: who it's for and its #number, then what it's for, its status when it isn't the
 * stage's usual one (Changes requested, Assessment done), then its options and age, with its money on
 * the right. The card is dragged; its link (stretched over it) opens the record, and its menu makes
 * the same moves from the keyboard.
 */
function DealCard({ card: c, showStatus, dragging, actions, onDragStart, onDragEnd }: { card: Card; showStatus: boolean; dragging: boolean; actions: MenuEntry[]; onDragStart: () => void; onDragEnd: () => void }) {
  const tone = ageTone(c.updated);
  const value = money(c);
  return (
    <article
      className="deal"
      draggable
      data-dragging={dragging || undefined}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", c.id);
        onDragStart();
      }}
      onDragEnd={onDragEnd}
    >
      <Link className="deal-link" to={cardLink(c)} draggable={false}>
        <span className="deal-l1">
          <span className="deal-name">{cardName(c)}</span>
          {c.number != null && <span className="deal-num">#{c.number}</span>}
        </span>
        {c.client && <span className="deal-title">{c.title}</span>}
      </Link>
      {showStatus && <span className="deal-status"><EntityStatus kind={c.kind} status={c.status} /></span>}
      <div className="deal-foot">
        <MetaLine
          className="deal-meta"
          parts={[
            c.options > 0 && optionsNote(c.status, c.options, c.option),
            <time className="deal-age" dateTime={c.updated} data-tone={tone} title={`Last change ${formatDateTime(c.updated)}`}>{shortAge(c.updated)}</time>,
          ]}
        />
        {value && <span className="deal-money">{value}</span>}
      </div>
      <Menu items={actions} label={`Actions for ${cardName(c)}${c.number != null ? ` #${c.number}` : ""}`} title={cardName(c)} triggerClassName="deal-more" />
    </article>
  );
}

/** A card as a phone's inbox row: money and age on the right, its status when the stage holds more than one. */
function PhoneRow({ card: c }: { card: Card }) {
  const value = money(c);
  return (
    <InboxRow
      to={cardLink(c)}
      title={cardName(c)}
      number={c.number}
      subject={c.client ? c.title : undefined}
      meta={c.options > 0 ? optionsNote(c.status, c.options, c.option) : undefined}
      aside={<>{value && <span className="il-money">{value}</span>}<RowAge at={c.updated} tone={ageTone(c.updated)} /></>}
    />
  );
}
