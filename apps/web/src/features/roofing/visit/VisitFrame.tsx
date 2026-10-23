/**
 * The frame around the site visit's screens on the iPad: no sidebar or top bar, just a slim header
 * (back, what this is, who's signed in), and the states the three screens share: loading, not
 * found, no access, an estimate with nothing on it yet, and one that can't be signed any more.
 */
import { useEffect, useRef, useState, type MouseEvent, type ReactNode, type RefObject } from "react";
import { Link } from "react-router-dom";
import { Face } from "@/components/ui/Avatar";
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

export function VisitFrame({ title, subtitle, back, me = true, pageTitle, children }: {
  title: ReactNode;
  subtitle?: ReactNode;
  back?: BackLinkProps | null;
  /** Show who's signed in on the right. */
  me?: boolean;
  /** The browser tab's title. */
  pageTitle?: string;
  children: ReactNode;
}) {
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
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.side}>
          {back && (
            <Link to={back.to} className={styles.back} onClick={back.onClick} aria-label={back.label}>
              <Icon name="chevronLeft" size={20} strokeWidth={2.2} />
              <span className={styles.backText} aria-hidden="true">{back.label}</span>
            </Link>
          )}
        </div>
        <div className={styles.title}>
          <strong>{title}</strong>
          {subtitle && <span>{subtitle}</span>}
        </div>
        <div className={`${styles.side} ${styles.sideEnd}`}>{me && <Me />}</div>
      </header>
      {children}
    </div>
  );
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
      <div className={`card ${styles.centeredCard}`}>{children}</div>
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
          <Link className={`btn ${styles.touch}`} to="/roofing">Back to Roofing</Link>
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
      <Skeleton width={150} height={15} />
      <Skeleton width={210} height={11} />
    </span>
  );
  return (
    <VisitFrame title={head} back={null} me={false}>
      <Loading label="Loading the estimate" className={styles.loading}>
        {kind === "visit" && (
          <div className={styles.visit}>
            <div className={styles.top}>
              <Skeleton height={48} radius={12} />
              <div className={`card ${styles.estimate}`}>
                <Skeleton width={160} height={20} />
                <EstimateListSkeleton rows={7} size="large" />
              </div>
            </div>
            <div className={styles.aside}>
              <div className={styles.asideScroll}>
                <Skeleton width={60} height={12} />
                <Skeleton width={200} height={40} />
                <Skeleton height={14} radius={999} />
                <Skeleton height={52} radius={10} />
                <Skeleton height={44} radius={10} />
              </div>
            </div>
          </div>
        )}
        {kind === "sign" && (
          <div className={styles.sign}>
            <div className={styles.docArea}><div className={styles.docSkeleton} /></div>
            <div className={styles.signPanel}>
              <div className={styles.signScroll}>
                <Skeleton width={280} height={22} />
                <Skeleton height={48} radius={10} />
                <Skeleton height={170} radius={14} />
              </div>
            </div>
          </div>
        )}
        {kind === "signed" && (
          <div className={styles.done}>
            <Skeleton circle width={76} height={76} />
            <Skeleton width={320} height={30} />
            <Skeleton width={420} height={16} />
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
