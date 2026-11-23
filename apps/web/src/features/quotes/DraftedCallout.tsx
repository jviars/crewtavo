/**
 * On a draft quote that "Draft a quote" filled in (quotes.drafted, services/quoteDrafts.ts): who
 * drafted it, the lines whose quantity to check, and what the client answered on the request, for
 * the office to go by. Never on the client's copy. Drafted from the price list, it says that turning
 * on Claude drafts better.
 *
 * On a draft made by itself, the description Claude wrote for the client waits here: it was written
 * from what someone typed into a form, so the office reads it and presses "Use as the message"
 * before it's anywhere a client will see. And a price list longer than a draft looks at is said.
 */
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { supabase, unwrap } from "@/lib/api";

export interface Drafted {
  by: "claude" | "price_list";
  request_number?: number | null;
  check?: string[];
  /** How many lines the draft came with: none means the price list had nothing for the request. */
  lines?: number | null;
  notes?: string | null;
  note?: string | null;
  /** Made by itself as the request came in: the request stays as it was until this quote is sent. */
  auto?: boolean;
  /** Claude's description for the client, on a draft made by itself: not the quote's message until someone uses it. */
  description?: string | null;
  /** The price list was longer than a draft looks at: how many items it went by, of how many. */
  price_list?: { shown: number; of: number } | null;
}

/** quotes.drafted as stored, or null for a quote nobody drafted. */
export function readDrafted(value: unknown): Drafted | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const d = value as Record<string, unknown>;
  if (d.by !== "claude" && d.by !== "price_list") return null;
  return {
    by: d.by,
    request_number: typeof d.request_number === "number" ? d.request_number : null,
    check: Array.isArray(d.check) ? d.check.filter((x): x is string => typeof x === "string") : [],
    lines: typeof d.lines === "number" ? d.lines : null,
    notes: typeof d.notes === "string" ? d.notes : null,
    note: typeof d.note === "string" ? d.note : null,
    ...(d.auto === true ? { auto: true } : {}),
    ...(typeof d.description === "string" && d.description.trim() ? { description: d.description.trim() } : {}),
    ...(cutList(d.price_list) ? { price_list: cutList(d.price_list) } : {}),
  };
}

function cutList(value: unknown): { shown: number; of: number } | null {
  const p = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return typeof p.shown === "number" && typeof p.of === "number" && p.of > p.shown ? { shown: p.shown, of: p.of } : null;
}

/** Said when the price list was too long to go by whole, so a missing line isn't taken for the draft's judgement. */
export const cutListWords = (d: Drafted): string | null =>
  d.price_list
    ? `Your price list has ${d.price_list.of.toLocaleString("en-US")} items, and ${d.by === "claude" ? "the AI was shown" : "this draft went by"} the first ${d.price_list.shown.toLocaleString("en-US")}. Check that nothing further down is missing.`
    : null;

/** Whether Claude's description is still to be used: there is one, and the quote's message isn't it already. */
export const descriptionWaiting = (d: Drafted, message: string | null | undefined) => Boolean(d.description) && (message ?? "").trim() !== d.description;

/**
 * The draft quote a request's page points to: one made by itself as the request came in that's
 * still a draft (the request wasn't marked Quoted for it, so nothing else on the page says it's
 * there). Null once it's sent, and for quotes people made.
 */
export function readyDraft<T extends { status: string; drafted?: unknown }>(quotes: readonly T[]): { quote: T; by: Drafted["by"] } | null {
  for (const quote of quotes) {
    const d = quote.status === "draft" ? readDrafted(quote.drafted) : null;
    if (d?.auto) return { quote, by: d.by };
  }
  return null;
}

/** What the callout says first: who drafted it, and from what. */
export function draftedWords(d: Drafted, checkNames: readonly string[]): string[] {
  const from = d.request_number ? `request #${d.request_number}` : "the request";
  // A draft that came with no lines isn't said to be drafted: its note says why, and to add them.
  const out = [d.lines === 0 ? `Started from ${from}.` : d.by === "claude" ? `Written by AI: this was drafted from ${from} and your price list. It can be wrong, so check every line, quantity and price before you send it.` : `Drafted from ${from} and your price list. Look it over before you send it.`];
  if (checkNames.length) out.push(`Check the quantity on ${checkNames.join(", ")}: the request didn't say, so it's 1.`);
  if (d.note) out.push(d.note);
  const cut = cutListWords(d);
  if (cut) out.push(cut);
  return out;
}

export function DraftedCallout({ quoteId, message, drafted, lines, requestId, admin, canEdit, onChanged }: {
  quoteId: string;
  /** The quote's message as it stands: what the client will read. */
  message: string | null;
  drafted: unknown;
  lines: ReadonlyArray<{ id: string; name: string }>;
  requestId: string | null;
  admin: boolean;
  canEdit: boolean;
  onChanged: () => void;
}) {
  const [showNotes, setShowNotes] = useState(false);
  const d = readDrafted(drafted);
  const useDescription = useMutation({
    meta: { success: "Message set. Read it over before you send the quote." },
    mutationFn: async () => unwrap(await supabase().from("quotes").update({ message: d!.description! }).eq("id", quoteId)),
    onSuccess: onChanged,
  });
  if (!d) return null;
  // Only lines still on the quote: one taken off needs no checking.
  const checkNames = (d.check ?? []).map((id) => lines.find((l) => l.id === id)?.name).filter((n): n is string => Boolean(n));
  const [first, ...rest] = draftedWords(d, checkNames);
  return (
    <div className="callout callout-info">
      <Icon name="sparkle" size={16} />
      <div className="grow stack-sm" style={{ gap: 4 }}>
        <span>{first}</span>
        {rest.map((line, i) => <span key={i} style={{ fontWeight: 400 }}>{line}</span>)}
        {d.by === "price_list" && (!d.note || d.lines === 0) && (
          <span className="small" style={{ fontWeight: 400 }}>
            {admin ? <>Turn on <Link to="/settings?tab=company">Draft quotes with AI</Link> in Settings → Company to draft them better.</> : "An owner or admin can turn on Draft quotes with AI in Settings → Company, which drafts them better."}
          </span>
        )}
        {descriptionWaiting(d, message) && (
          <div className="stack-sm" style={{ gap: 4, fontWeight: 400 }}>
            <span className="small">AI suggested this message for the client. It was written from what they typed, so it isn't on the quote unless you use it:</span>
            <p className="pre-wrap small" style={{ margin: 0 }}>“{d.description}”</p>
            {canEdit && (
              <Button size="sm" style={{ justifySelf: "start" }} loading={useDescription.isPending} onClick={() => useDescription.mutate()}>
                {(message ?? "").trim() ? "Use as the message instead" : "Use as the message"}
              </Button>
            )}
          </div>
        )}
        {d.notes && (
          <>
            <button type="button" className="link-btn small" style={{ justifySelf: "start" }} aria-expanded={showNotes} onClick={() => setShowNotes(!showNotes)}>
              {showNotes ? "Hide what they answered" : "What they answered"}
            </button>
            {showNotes && <p className="pre-wrap small" style={{ margin: 0, fontWeight: 400 }}>{d.notes}</p>}
          </>
        )}
        {requestId && <Link className="small" style={{ fontWeight: 400 }} to={`/requests/${requestId}`}>Open the request</Link>}
      </div>
    </div>
  );
}
