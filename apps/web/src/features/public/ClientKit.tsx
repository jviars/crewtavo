/**
 * The client kit's parts (client.module.css): the pages a business's clients and subs open from a
 * link, in the business's color (or the navy its paper prints in) and logo, never Crewtavo's green. A page is ClientPage > ClientHeader + ClientBody, with
 * white cards on the grey ground; Done says something finished, Broken that a link doesn't work.
 */
import { documentColor } from "@crewtavo/core/documents";
import type { CSSProperties, ReactNode, Ref } from "react";
import { cx } from "@/components/ui/Button";
import { Icon, type IconName } from "@/components/ui/Icon";
import { Skeleton } from "@/components/ui/Skeleton";
import { contrastRatio, initials, inkOn } from "@/features/documents/words";
import { t } from "@/lib/i18n";
import k from "./client.module.css";

export { k as kit };

const HEX = /^#[0-9a-f]{6}$/i;

/** `hex` mixed toward black by `amount` (0 to 1). */
function shade(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16);
  const channel = (shift: number) => Math.round(((n >> shift) & 255) * (1 - amount)).toString(16).padStart(2, "0");
  return `#${channel(16)}${channel(8)}${channel(0)}`;
}

/**
 * The color a page wears for a business with no brand color of its own: the navy its quotes and
 * invoices print in (documentColor), as its Client Hub falls back to. Never Crewtavo's green.
 */
export const FALLBACK_COLOR = documentColor({ color: null }, null);

/**
 * The business's brand color (else FALLBACK_COLOR) as the page's --brand and the colors drawn from
 * it: the words on it (white or ink, whichever reads at 4.5:1), a tint for picked choices, and the
 * color for words and links in it, darkened until it reads on white and on its tint (5:1), else ink.
 * A sub's paperwork follows the device: in dark, client.module.css lightens those words instead.
 */
export function brandStyle(color: string | null | undefined): CSSProperties {
  const brand = color && HEX.test(color) ? color : FALLBACK_COLOR;
  const words = [0, 0.15, 0.3, 0.45].map((a) => shade(brand, a)).find((c) => contrastRatio(c, "#ffffff") >= 5) ?? "var(--ink)";
  return {
    ["--brand" as string]: brand,
    ["--brand-hover" as string]: shade(brand, 0.12),
    ["--on-brand" as string]: inkOn(brand),
    ["--brand-tint" as string]: `color-mix(in srgb, ${brand} 11%, var(--m-card))`,
    ["--brand-words" as string]: words,
  };
}

/** The whole page: the grey ground, in the business's color. `embedded`: in a frame on its own website. */
export function ClientPage({ color, embedded, children, pageRef }: { color?: string | null; embedded?: boolean; children: ReactNode; pageRef?: Ref<HTMLDivElement> }) {
  return (
    <div ref={pageRef} className={cx(k.page, embedded && k.embedded)} style={brandStyle(color)}>
      {children}
    </div>
  );
}

/** The column the page's cards stack in. */
export function ClientBody({ children, width }: { children: ReactNode; width?: "wide" | "narrow" }) {
  return <main className={cx(k.body, width && k[width])}>{children}</main>;
}

/** The business's logo, or its initials on its color. */
export function BrandMark({ name, logo }: { name: string; logo?: string | null }) {
  return logo ? <img className={k.markImg} src={logo} alt="" /> : <span className={k.mark} aria-hidden="true">{initials(name)}</span>;
}

/**
 * The business at the top: its logo, its name with a quiet line under it (what this page is), and
 * a way to call. On a computer the number shows on the button; on a phone it's a round button, the
 * number still its name.
 */
export function ClientHeader({ name, logo, sub, phone }: { name: string; logo?: string | null; sub?: ReactNode; phone?: string | null }) {
  return (
    <header className={k.head}>
      <BrandMark name={name} logo={logo} />
      <span className={k.biz}>
        <span>{name}</span>
        {sub && <span className={k.bizSub}>{sub}</span>}
      </span>
      {phone && (
        <a className={k.headBtn} href={`tel:${phone}`}>
          <Icon name="phone" size={18} />
          <span className={k.headText}><span className="sr-only">{t("Call {name} at", { name })} </span>{phone}</span>
        </a>
      )}
    </header>
  );
}

/** Something finished: a check in the business's color, what happened, then what's next. */
export function Done({ title, children, icon = "check", tone = "draw", className, headingLevel = 1, role }: { title: ReactNode; children?: ReactNode; icon?: IconName; tone?: "draw" | "brand" | "quiet"; className?: string; headingLevel?: 1 | 2; role?: "status" }) {
  const Heading = headingLevel === 1 ? "h1" : "h2";
  return (
    <section className={cx(k.card, k.done, className)} role={role}>
      <span className={k.doneMark} data-tone={tone}><Icon name={icon} size={34} bold /></span>
      <Heading className={k.doneTitle}>{title}</Heading>
      {children}
    </section>
  );
}

/** A link or a form that doesn't work: a quiet mark, what's wrong, and what the server said. */
export function Broken({ title, children, icon = "link" }: { title: string; children?: ReactNode; icon?: IconName }) {
  return (
    <section className={cx(k.card, k.done, k.alone)} role="alert">
      <span className={k.doneMark} data-tone="quiet"><Icon name={icon} size={28} /></span>
      <h1 className={k.doneTitle}>{title}</h1>
      {children && <p className={k.doneText}>{children}</p>}
    </section>
  );
}

/** The page's shape while it loads: the header, then a card with a title and a few fields. */
export function ClientSkeleton({ header = true, lines = 3 }: { header?: boolean; lines?: number }) {
  return (
    <div className={k.skeleton} aria-busy="true" role="status">
      <span className="sr-only">{t("Loading")}</span>
      {header && (
        <div className={k.skeletonHead}>
          <Skeleton width={40} height={40} radius={10} />
          <Skeleton width={160} height={14} />
        </div>
      )}
      <div className={cx(k.card, k.skeleton)}>
        <Skeleton width="30%" height={10} />
        <Skeleton width="70%" height={28} radius={8} />
        {Array.from({ length: lines }, (_, i) => <Skeleton key={i} height={48} radius={12} />)}
      </div>
    </div>
  );
}
