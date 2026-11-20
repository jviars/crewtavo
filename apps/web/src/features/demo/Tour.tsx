/**
 * The demo's guided tour: a card in the corner that walks a visitor through their sample business,
 * a page at a time, and rings what it's talking about (a link in the sidebar, or a button in the
 * demo bar). It opens by itself the first time the owner arrives, picks up where it was after a
 * reload or a trip to the crew's phone, and the bar's Tour button starts it again. It's the same
 * for every trade: what's a trade's own (Snow, Paving, Roofing) it points to in Apps.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { supabase } from "@/lib/api";
import { t } from "@/lib/i18n";
import { useSession } from "@/lib/session";
import styles from "./demo.module.css";

export const GET_CREWTAVO = "https://crewtavo.com/start/";

interface Step {
  /** The page it's about: an address, or one found for this business (a quote's own page). */
  to?: string | ((companyId: string) => Promise<string>);
  /** What it rings, if it's on the screen: the first of these that's visible. */
  target?: string;
  title: string;
  body: string;
}

/** A quote of this business's in that state, opened on its own page (or the list, if there's none any more). */
const quote = (status: "sent") => async (companyId: string) => {
  const { data } = await supabase().from("quotes").select("id").eq("company_id", companyId).eq("status", status).order("created_at").limit(1).maybeSingle();
  return data ? `/quotes/${data.id}` : "/quotes";
};

const link = (to: string) => `a[href="${to}"]`;

/**
 * The schedule, as a list on a phone: a day's crews side by side are wider than a phone, and a page
 * wider than the phone zooms out, taking the tour's card out of sight.
 */
const schedule = async () => (window.matchMedia?.("(max-width: 760px)").matches ? "/schedule?view=list" : "/schedule");

/** The tour, the same for every trade: what any field service business does, and Apps for what's its own. */
export function tourSteps(business: string): Step[] {
  return [
    {
      title: t("Welcome to {business}", { business }),
      body: t("This is your own sample business, with clients, this week's work, quotes and invoices. Take a one-minute tour, or click around on your own. Nothing you do here reaches anyone."),
    },
    {
      to: "/",
      target: link("/"),
      title: t("Your day at a glance"),
      body: t("Home shows today's visits, and every request, quote, job and invoice in one row, with what needs you first."),
    },
    {
      to: "/requests",
      target: link("/requests"),
      title: t("Work coming in"),
      body: t("Requests arrive from your website's booking form, a phone call or a client's portal, and turn into an estimate visit or a quote."),
    },
    {
      to: schedule,
      target: link("/schedule"),
      title: t("The week's work"),
      body: t("Every visit by crew, with recurring work filled in by itself. Drag a visit to move it, and Map lays out the day's route."),
    },
    {
      to: quote("sent"),
      target: link("/quotes"),
      title: t("A quote waiting on Jordan"),
      body: t("Jordan approves it from a link, picks any optional lines, and it becomes a job with its visits. Measure a yard, roof or lot on the aerial and a quote fills itself in."),
    },
    {
      to: "/invoices",
      target: link("/invoices"),
      title: t("Getting paid"),
      body: t("Overdue invoices stand out, and Crewtavo can remind clients by itself. Payments come by card, bank or check."),
    },
    {
      to: "/apps",
      target: link("/apps"),
      title: t("Apps for your trade"),
      body: t("What your trade needs turns on here: snow removal, paving takeoffs, roofing, a website, team chat and more, along with payments, texting, accounting and calendars. In the demo, the ones that connect outside accounts are off."),
    },
    {
      target: '[data-tour="crew"]',
      title: t("Your crew's phone"),
      body: t("Press Crew's phone to see today as Marcus, the crew lead: clock in, the day's stops with directions, checklists and photos. Owner's view brings you back here."),
    },
    {
      target: '[data-tour="client"]',
      title: t("What your clients see"),
      body: t("Client's view opens a client's portal: a quote to approve, the next visit, invoices to pay by card or bank, and a button to ask for more work."),
    },
    {
      target: '[data-tour="get"]',
      title: t("That's the tour"),
      body: t("Now change anything: add a client, send a quote, move a visit, take a payment. It's yours for 24 hours. When you're ready, Crewtavo is free for your own business."),
    },
  ];
}

type Saved = { step: number } | { done: true };
const KEY = (company: string) => `crewtavo-demo-tour:${company}`;
function load(company: string): Saved | null {
  try {
    return JSON.parse(localStorage.getItem(KEY(company)) ?? "null") as Saved | null;
  } catch {
    return null;
  }
}
function save(company: string, saved: Saved) {
  try {
    localStorage.setItem(KEY(company), JSON.stringify(saved));
  } catch {
    // Private browsing: the tour just doesn't remember.
  }
}

/**
 * The tour's state for the demo bar: whether it's showing, and how to start it again. It opens by
 * itself for the owner the first time, and goes on from where it was.
 */
export function useDemoTour() {
  const session = useSession();
  const company = session.company.id;
  const owner = session.role === "owner";
  const [step, setStep] = useState<number | null>(() => {
    if (!owner) return null;
    const saved = load(company);
    return saved && "done" in saved ? null : (saved?.step ?? 0);
  });
  const go = useCallback((next: number | null) => {
    setStep(next);
    save(company, next === null ? { done: true } : { step: next });
  }, [company]);
  return { step, go, start: () => go(0), owner };
}

/** The card and the ring. `step` is null when the tour isn't showing. */
export function DemoTour({ step, go }: { step: number | null; go: (step: number | null) => void }) {
  const session = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const all = useMemo(() => tourSteps(session.company.name), [session.company.name]);
  const current = step === null ? null : all[Math.min(step, all.length - 1)]!;
  const [ring, setRing] = useState<DOMRect | null>(null);
  const primary = useRef<HTMLButtonElement>(null);

  // Off to the step's page, then focus on its next button, so the keyboard carries on.
  useEffect(() => {
    if (!current?.to) return;
    let live = true;
    void (async () => {
      const to = typeof current.to === "function" ? await current.to(session.company.id).catch(() => null) : current.to;
      if (live && to && to !== location.pathname + location.search) navigate(to);
    })();
    return () => {
      live = false;
    };
    // Only when the step changes: a visitor clicking away mid-step is left where they went.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);
  useEffect(() => {
    if (current) primary.current?.focus({ preventScroll: true });
  }, [step, current]);

  // Where the thing it's about is, kept up as the page loads, scrolls and resizes.
  useEffect(() => {
    if (!current?.target) return setRing(null);
    const find = () => {
      const el = [...document.querySelectorAll<HTMLElement>(current.target!)].find((e) => {
        const r = e.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== "hidden";
      });
      const rect = el?.getBoundingClientRect() ?? null;
      // Only when it moved: the card doesn't redraw every few hundred milliseconds for nothing.
      setRing((was) => (was && rect && was.top === rect.top && was.left === rect.left && was.width === rect.width && was.height === rect.height) || was === rect ? was : rect);
    };
    find();
    const timer = setInterval(find, 400);
    window.addEventListener("resize", find);
    return () => {
      clearInterval(timer);
      window.removeEventListener("resize", find);
    };
  }, [current]);

  useEffect(() => {
    if (step === null) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && go(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step, go]);

  if (step === null || !current) return null;
  const first = step === 0;
  const last = step >= all.length - 1;
  const ringStyle: CSSProperties | undefined = ring ? { top: ring.top - 4, left: ring.left - 4, width: ring.width + 8, height: ring.height + 8 } : undefined;

  return (
    <>
      {ringStyle && <div className={styles.ring} style={ringStyle} aria-hidden="true" />}
      <section className={styles.tour} role="dialog" aria-modal="false" aria-labelledby="demo-tour-title" aria-describedby="demo-tour-body">
        <div className={styles.tourHead}>
          <span className={styles.tourCount}>{first ? t("Guided tour") : t("{step} of {steps}", { step, steps: all.length - 1 })}</span>
          <button type="button" className={styles.tourClose} onClick={() => go(null)} aria-label={t("End the tour")} title={t("End the tour")}>
            <Icon name="x" size={16} />
          </button>
        </div>
        <h2 id="demo-tour-title" className={styles.tourTitle}>{current.title}</h2>
        <p id="demo-tour-body" className={styles.tourBody}>{current.body}</p>
        <div className={styles.tourActions}>
          {first ? (
            <>
              <Button size="sm" variant="ghost" onClick={() => go(null)}>{t("I'll look around myself")}</Button>
              <Button ref={primary} size="sm" variant="primary" icon="play" onClick={() => go(1)}>{t("Show me around")}</Button>
            </>
          ) : last ? (
            <>
              <Button size="sm" variant="ghost" onClick={() => go(null)}>{t("Keep exploring")}</Button>
              <a className="btn btn-sm btn-primary" href={GET_CREWTAVO} onClick={() => go(null)}>{t("Get Crewtavo free")}</a>
            </>
          ) : (
            <>
              <Button size="sm" variant="ghost" icon="arrowLeft" onClick={() => go(step - 1)}>{t("Back")}</Button>
              <Button ref={primary} size="sm" variant="primary" onClick={() => go(step + 1)}>{t("Next")}<Icon name="arrowRight" size={14} /></Button>
            </>
          )}
        </div>
      </section>
    </>
  );
}
