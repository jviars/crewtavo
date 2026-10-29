/**
 * A figure that rolls to its new value when it changes (NumberFlow), for stat tiles and dashboards.
 * It renders the first value as is; only later changes animate. Follows prefers-reduced-motion.
 */
import NumberFlow, { type Format } from "@number-flow/react";

export const MONEY: Format = { style: "currency", currency: "USD", maximumFractionDigits: 0 };
/** Dollars and cents, for totals on quotes, invoices and job costs. */
export const MONEY_CENTS: Format = { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 };
export const MONEY_COMPACT: Format = { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 };
/** Compact above $1,000 ("$9.9K"), whole dollars below ("$711", not "$710.8"). */
export const moneyCompact = (value: number): Format => (Math.abs(value) < 1000 ? MONEY : MONEY_COMPACT);
export const COUNT: Format = { maximumFractionDigits: 0 };

const MOVE = { duration: 250, easing: "cubic-bezier(0.16, 1, 0.3, 1)" }; // --ease-out
const FADE = { duration: 150, easing: "ease-out" };

export function AnimatedNumber({ value, format = COUNT, className }: { value: number; format?: Format; className?: string }) {
  return (
    <span className={className}>
      {/* The digits live in a shadow root that assistive tech and find-in-page don't reliably read. */}
      <NumberFlow aria-hidden="true" value={value} format={format} locales="en-US" transformTiming={MOVE} spinTiming={MOVE} opacityTiming={FADE} />
      <span className="sr-only">{new Intl.NumberFormat("en-US", format).format(value)}</span>
    </span>
  );
}
