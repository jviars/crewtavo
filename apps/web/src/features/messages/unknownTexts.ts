/**
 * Texts from unknown numbers (public.unknown_texts), as Messages lists them: one row for each number.
 * A missed call or voicemail on a business's Quo number from a number nobody knows waits there too
 * (channel "call", its details in `call`), as a new customer's first call often does.
 */
import { phoneDisplay, phoneE164 } from "@crewtavo/core/phone";
import { t } from "@/lib/i18n";

export interface UnknownText {
  id: string;
  from_phone: string;
  phone_key: string;
  body: string;
  created_at: string;
  /** "sms", or "call" for a call on the Quo number (older rows and tests leave it out: a text). */
  channel?: string;
  /** A call's details (core/calls.ts CallDetails). */
  call?: unknown;
}

/** One unknown number: its newest text or call, and how many of each. */
export interface UnknownNumber extends UnknownText {
  count: number;
  texts: number;
  calls: number;
}

/** The number as people read it: "(540) 555-0163" for a US or Canadian one. */
export const numberWords = (phone: string) => {
  const e164 = phoneE164(phone);
  return e164 ? phoneDisplay(e164) : phone;
};

const isCall = (t: Pick<UnknownText, "channel">) => t.channel === "call";

/** From texts and calls newest first: one row for each number, with its newest, and how many of each it sent. */
export function byNumber(texts: readonly UnknownText[]): UnknownNumber[] {
  const seen = new Map<string, UnknownNumber>();
  for (const t of texts) {
    const existing = seen.get(t.phone_key) ?? { ...t, count: 0, texts: 0, calls: 0 };
    existing.count++;
    if (isCall(t)) existing.calls++;
    else existing.texts++;
    seen.set(t.phone_key, existing);
  }
  return [...seen.values()];
}

/** The numbers a search finds: by the number, however it's typed, or by what a text (or a call's words) said. */
export function matchingNumbers(numbers: readonly UnknownNumber[], term: string): UnknownNumber[] {
  const words = term.trim().toLowerCase();
  if (!words) return [...numbers];
  const digits = words.replace(/\D/g, "");
  return numbers.filter((n) => n.body.toLowerCase().includes(words) || (digits.length >= 3 && n.from_phone.replace(/\D/g, "").includes(digits)));
}

/** The numbers Messages lists under a filter: none under Email, the ones that texted under Texts, the ones that called under Calls. */
export function numbersFor(numbers: readonly UnknownNumber[], filter: string, term: string): UnknownNumber[] {
  if (filter === "email") return [];
  const shown = filter === "sms" ? numbers.filter((n) => n.texts > 0) : filter === "calls" ? numbers.filter((n) => n.calls > 0) : numbers;
  return matchingNumbers(shown, term);
}

/** How many of a number's rows are texts and how many calls: what attaching it moves, or Delete removes. */
export function kindsOf(rows: readonly Pick<UnknownText, "channel">[]): { texts: number; calls: number } {
  const calls = rows.filter(isCall).length;
  return { texts: rows.length - calls, calls };
}

/** What attaching a number that called moves onto the client's timeline: "Its call moves…", "Its 2 texts and 1 call move…". */
export function movesWords(texts: number, calls: number): string {
  if (!texts) return t.plural(calls, { one: "Its call moves onto the client's timeline, and new texts and calls go there from now on.", other: "Its {count} calls move onto the client's timeline, and new texts and calls go there from now on." });
  return t("Its {texts} and {calls} move onto the client's timeline, and new ones go there from now on.", {
    texts: t.plural(texts, { one: "{count} text", other: "{count} texts" }),
    calls: t.plural(calls, { one: "{count} call", other: "{count} calls" }),
  });
}
