/**
 * The frame around the site visit's screens on the iPad: no sidebar or top bar, just a slim header
 * (back, the business and what this is, the step it's at, who's signed in), and the states the three
 * screens share: loading, not found, no access, an estimate with nothing on it yet, and one that
 * can't be signed any more. The homeowner looks at these screens, so they wear the business's own
 * color, as its Client Hub does (Client-Phone and Client-Desktop boards): the estimate's paper
 * color (documentColor: the template's, else the business's brand color), as --brand.
 */
import { documentColor } from "@crewtavo/core/documents";
import { useEffect, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode, type RefObject } from "react";
import { Link } from "react-router-dom";
import { Face, initials } from "@/components/ui/Avatar";
import { contrastRatio, inkOn } from "@/features/documents/words";
import { logoUrl } from "@/lib/files";
import { Icon } from "@/components/ui/Icon";
import { Loading, Skeleton } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState } from "@/components/ui/States";
import { SignaturePad } from "@/features/field/SignaturePad";
import { useSession } from "@/lib/session";
import { EstimateListSkeleton } from "../estimate/EstimateList";
import { firstName } from "../estimate/rows";
import type { EstimateQuote } from "../estimate/types";
import styles from "./visit.module.css";

export interface BackLinkProps {
  to: string;
  label: string;
  /** Called first; preventDefault() keeps them here (a signature not finished, say). */
  onClick?: (e: MouseEvent<HTMLAnchorElement>) => void;
}

/** The visit's steps, as the header shows them. */
const STEPS = ["Check it", "Sign", "Done"] as const;

/** `hex` mixed toward black by `amount` (0 to 1). */
function shade(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16);
  const channel = (shift: number) => Math.round(((n >> shift) & 255) * (1 - amount)).toString(16).padStart(2, "0");
  return `#${channel(16)}${channel(8)}${channel(0)}`;
}

/** The light theme's grey ground (--m-group): words on it read on the white cards too. */
const GROUND = "#f2f1ed";

/**
 * The business's color as CSS variables: the fill, the words on it, and the color for words in it on
 * the light page: the color itself, darkened until it reads on the grey ground (4.5:1), else ink, as
 * the Client kit does. The dark theme lightens it instead (visit.module.css).
 */
export function brandStyle(color: string): CSSProperties {
  const hex = /^#[0-9a-f]{6}$/i.test(color);
  const words = hex ? ([0, 0.15, 0.3, 0.45].map((a) => shade(color, a)).find((c) => contrastRatio(c, GROUND) >= 4.5) ?? "var(--ink)") : "var(--ink)";
  return {
    ["--brand" as string]: color,
    ["--on-brand" as string]: inkOn(color),
    ["--brand-words" as string]: words,
  };
}

export function VisitFrame({ title, subtitle, back, me = true, pageTitle, brand, step, children }: {
  title: ReactNode;
  subtitle?: ReactNode;
  back?: BackLinkProps | null;
  /** Show who's signed in on the right. */
  me?: boolean;
  /** The browser tab's title. */
  pageTitle?: string;
  /** The color the screen wears: the estimate's paper color. Without one, the business's brand color (else navy). */
  brand?: string | null;
  /** Where the visit is: checking the estimate (1), signing (2), signed (3). */
  step?: 1 | 2 | 3;
  children: ReactNode;
}) {
  const { company } = useSession();
  const color = brand ?? documentColor({ color: null }, company.settings);
  // The way back as a round button; its words beside it unless they'd repeat the title.
  const backWords = back && back.label !== title ? back.label : null;
  // Each screen starts at the top (the app shell does this for its own screens).
  useEffect(() => {
    window.scrollTo(0, 0);
  }, []);
  useEffect(() => {
    if (!pageTitle) return;
    const before = document.title;
    document.title = pageTitle;
    return () => {
      document.title = before;
    };
  }, [pageTitle]);

  return (
    <div className={styles.page} style={brandStyle(color)}>
      <header className={styles.header}>
        <div className={styles.side}>
          {back && (
            <Link to={back.to} className={styles.back} onClick={back.onClick} aria-label={back.label}>
              <span className={styles.backIcon}><Icon name="chevronLeft" size={20} /></span>
              {backWords && <span className={styles.backText} aria-hidden="true">{backWords}</span>}
            </Link>
          )}
        </div>
        <div className={styles.title}>
          <CompanyTile name={company.name} settings={company.settings} />
          <span className={styles.titleText}>
            <strong>{title}</strong>
            {subtitle && <span>{subtitle}</span>}
          </span>
        </div>
        <div className={`${styles.side} ${styles.sideEnd}`}>
          {step && (
            <ol className={styles.steps} aria-label={`Step ${step} of ${STEPS.length}`}>
              {STEPS.map((label, i) => (
                <li key={label} className={styles.stepItem} data-state={i + 1 < step ? "done" : i + 1 === step ? "on" : undefined} aria-current={i + 1 === step ? "step" : undefined}>
                  <span className={styles.stepNumber} aria-hidden="true">{i + 1 < step ? <Icon name="check" size={13} bold /> : i + 1}</span>
                  {label}
                </li>
              ))}
            </ol>
          )}
          {me && <Me />}
        </div>
      </header>
      {children}
    </div>
  );
}

/** The business's logo on white, or its initials on its color, beside the title. */
function CompanyTile({ name, settings }: { name: string; settings: Record<string, unknown> }) {
  const logo = logoUrl(settings);
  const [broken, setBroken] = useState<string | null>(null);
  if (logo && broken !== logo) {
    return <span className={`${styles.tile} ${styles.tileLogo}`} aria-hidden="true"><img src={logo} alt="" draggable={false} onError={() => setBroken(logo)} /></span>;
  }
  return <span className={styles.tile} aria-hidden="true">{initials(name)}</span>;
}

/** The salesperson holding the iPad: their face and first name. */
function Me() {
  const { profile } = useSession();
  const name = profile.full_name?.trim() || profile.email || "";
  return (
    <span className={styles.me}>
      <span className={`avatar ${styles.meFace}`} style={{ background: profile.color || "var(--avatar)" }} aria-hidden="true">
        <Face name={name} photo={profile.avatar_url} />
      </span>
      <span className={styles.meName}><span className="sr-only">Signed in as </span>{firstName(name) || name}</span>
    </span>
  );
}

/** "Dana Whitfield · 1482 Ridgeview Dr" under the title. */
export const whoAndWhere = (quote: Pick<EstimateQuote, "client" | "property">) => [quote.client?.display_name, quote.property?.line1].filter(Boolean).join(" · ");

// ---------------------------------------------------------------------------------------------
// The states every screen shares
// ---------------------------------------------------------------------------------------------

function Centered({ children }: { children: ReactNode }) {
  return (
    <main className={styles.centered}>
      <div className={styles.centeredCard}>{children}</div>
    </main>
  );
}

/** The app's usual no-access state, for people who don't sell. */
export function VisitNoAccess() {
  return (
    <VisitFrame title="Site visit" back={{ to: "/", label: "Home" }} pageTitle="Site visit">
      <Centered>
        <EmptyState icon="lock" title="You don't have access to this">Ask an admin if you need it.</EmptyState>
      </Centered>
    </VisitFrame>
  );
}

/** The estimate couldn't load (or doesn't exist). */
export function VisitError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return (
    <VisitFrame title="Site visit" back={{ to: "/roofing", label: "Roofing" }} pageTitle="Site visit">
      <Centered>
        <ErrorState error={error} onRetry={onRetry} />
        <div className={styles.centeredActions}>
          <Link className={`btn ${styles.touch} ${styles.ghostButton}`} to="/roofing">Back to Roofing</Link>
        </div>
      </Centered>
    </VisitFrame>
  );
}

/** An estimate that was marked lost or archived: it can't be signed until it's opened again. */
export function VisitClosed({ quote }: { quote: Pick<EstimateQuote, "id" | "title" | "status" | "client" | "property"> }) {
  const word = quote.status === "lost" ? "marked lost" : quote.status === "archived" ? "archived" : "closed";
  return (
    <VisitFrame title={quote.title} subtitle={whoAndWhere(quote)} back={{ to: `/roofing/${quote.id}`, label: quote.title }} pageTitle={`Site visit · ${quote.title}`}>
      <Centered>
        <EmptyState icon="lock" title={`This estimate was ${word}`} action={<Link className={`btn btn-primary ${styles.touch}`} to={`/roofing/${quote.id}`}>Open the project</Link>}>
          Open it again from the project first, then check it and sign here.
        </EmptyState>
      </Centered>
    </VisitFrame>
  );
}

/** Nothing on the estimate yet: it gets priced in the office first. */
export function VisitEmpty({ quote }: { quote: Pick<EstimateQuote, "id" | "title" | "client" | "property"> }) {
  return (
    <VisitFrame title={quote.title} subtitle={whoAndWhere(quote)} back={{ to: `/roofing/${quote.id}`, label: quote.title }} pageTitle={`Site visit · ${quote.title}`}>
      <Centered>
        <EmptyState icon="roofing" title="Nothing on this estimate yet" action={<Link className={`btn btn-primary ${styles.touch}`} to={`/roofing/${quote.id}`}>Open the project</Link>}>
          Measure the roof and price it on the project first. Then check it here with the homeowner.
        </EmptyState>
      </Centered>
    </VisitFrame>
  );
}

/** Each screen's shape while the estimate loads. */
export function VisitLoading({ kind }: { kind: "visit" | "sign" | "signed" }) {
  const head = (
    <span className={styles.loadingTitle}>
      <Skeleton width={150} height={14} />
      <Skeleton width={210} height={10} />
    </span>
  );
  return (
    <VisitFrame title={head} back={null} me={false}>
      <Loading label="Loading the estimate" className={styles.loading}>
        {kind === "visit" && (
          // As the screen lays out: what to change on the left (a sheet in portrait), the paper on the right.
          <div className={styles.visit}>
            <div className={styles.panel}>
              <div className={styles.panelBody}>
                <Skeleton height={50} radius={12} />
                <div className={styles.estimate}>
                  <Skeleton width={160} height={18} />
                  <EstimateListSkeleton rows={7} size="large" />
                </div>
              </div>
            </div>
            <div className={styles.paperSide}><div className={styles.docSkeleton} /></div>
          </div>
        )}
        {kind === "sign" && (
          <div className={styles.sign}>
            <div className={styles.docArea}><div className={styles.docSkeleton} /></div>
            <div className={styles.signPanel}>
              <div className={styles.signScroll}>
                <Skeleton width={280} height={24} />
                <Skeleton height={52} radius={12} />
                <Skeleton height={170} radius={14} />
              </div>
            </div>
          </div>
        )}
        {kind === "signed" && (
          <div className={styles.done}>
            <div className={styles.doneHead}>
              <Skeleton circle width={72} height={72} />
              <Skeleton width={300} height={28} />
              <Skeleton width={380} height={14} />
            </div>
            <Skeleton height={210} radius={18} style={{ width: "100%" }} />
          </div>
        )}
      </Loading>
    </VisitFrame>
  );
}

// ---------------------------------------------------------------------------------------------
// Signing with a finger
// ---------------------------------------------------------------------------------------------

/**
 * A key that changes when an element's width does (the iPad turned), once things settle. A drawing
 * surface sized for the old width would put the ink beside the finger.
 */
function useWidthKey(ref: RefObject<HTMLElement>): number {
  const [key, setKey] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let width = el.clientWidth;
    let timer = 0;
    const observer = new ResizeObserver(() => {
      const now = el.clientWidth;
      if (Math.abs(now - width) < 2) return;
      width = now;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setKey((k) => k + 1), 150);
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
      window.clearTimeout(timer);
    };
  }, [ref]);
  return key;
}

/**
 * The signature pad, full width and sized for a finger. When the iPad turns it starts over at the new
 * size; a signature already drawn is kept (it shows as signed, with Sign again).
 */
export function Pad({ value, onChange, label, height }: { value: string | null; onChange: (dataUrl: string | null) => void; label: string; height: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const key = useWidthKey(ref);
  return (
    <div ref={ref} className={styles.pad}>
      <SignaturePad key={key} value={value} onChange={onChange} label={label} height={height} maxWidth="100%" />
    </div>
  );
}
