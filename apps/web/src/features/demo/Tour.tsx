/**
 * The demo's guided tour: a card in the corner that walks a visitor through their sample business,
 * a page at a time, and rings what it's talking about (a link in the sidebar, or a button in the
 * demo bar). It opens by itself the first time the owner arrives, picks up where it was after a
 * reload or a trip to the crew's phone, and the bar's Tour button starts it again. The steps are
 * written for each trade the start screen asks about, with a general set for the rest.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { supabase } from "@/lib/api";
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
const quote = (status: "sent" | "draft") => async (companyId: string) => {
  const { data } = await supabase().from("quotes").select("id").eq("company_id", companyId).eq("status", status).order("created_at").limit(1).maybeSingle();
  return data ? `/quotes/${data.id}` : "/quotes";
};

const link = (to: string) => `a[href="${to}"]`;

/**
 * The schedule, as a list on a phone: a day's crews side by side are wider than a phone, and a page
 * wider than the phone zooms out, taking the tour's card out of sight.
 */
const schedule = async () => (window.matchMedia?.("(max-width: 760px)").matches ? "/schedule?view=list" : "/schedule");

export function tourSteps(trade: string, business: string): Step[] {
  const welcome: Step = {
    title: `Welcome to ${business}`,
    body: "This is your own sample business, with clients, this week's work, quotes and invoices. Take a one-minute tour, or click around on your own. Nothing you do here reaches anyone.",
  };
  const home: Step = {
    to: "/",
    target: link("/"),
    title: "Your day at a glance",
    body: "Home shows today's visits, and every request, quote, job and invoice in one row, with what needs you first.",
  };
  const requests: Step = {
    to: "/requests",
    target: link("/requests"),
    title: "Work coming in",
    body: "Requests arrive from your website's booking form, a phone call or a client's portal. Priya asked for a price; her estimate visit is on today's schedule.",
  };
  const crew: Step = {
    target: '[data-tour="crew"]',
    title: "Your crew's phone",
    body: "Press Crew's phone to see today as Marcus, the crew lead: clock in, the day's stops with directions, checklists and photos. Owner's view brings you back here.",
  };
  const client: Step = {
    target: '[data-tour="client"]',
    title: "What your clients see",
    body: "Client's view opens a client's portal: a quote to approve, the next visit, invoices to pay by card or bank, and a button to ask for more work.",
  };
  const done: Step = {
    target: '[data-tour="get"]',
    title: "That's the tour",
    body: "Now change anything: add a client, send a quote, move a visit, take a payment. It's yours for 24 hours. When you're ready, Crewtavo is free for your own business.",
  };
  const invoices = (body: string): Step => ({ to: "/invoices", target: link("/invoices"), title: "Getting paid", body });
  const middle: Record<string, Step[]> = {
    lawn_exterior: [
      { to: schedule, target: link("/schedule"), title: "The week's route", body: "Weekly and every-other-week mows fill in by themselves from each client's recurring job, with cleanups in between. Drag a visit to move it; Map lays out the route." },
      { to: quote("sent"), target: link("/quotes"), title: "A quote waiting on Jordan", body: "Jordan's fertilizer program: five rounds, with aeration and overseeding as options he can tick. He approves it from a link, and it becomes a job." },
      { to: "/snow", target: link("/snow"), title: "Snow removal, built in", body: "Four snow customers with their triggers, salting and storm prices. When the forecast reaches a trigger, the crew hears the night before, and the office schedules the whole storm at once. Season has the last storm: what fell, the pushes and what it billed." },
      invoices("Meadowbrook HOA's fall cleanup is past due, and Crewtavo can remind them by itself. Payments come by card, bank or check."),
    ],
    roofing_exteriors: [
      { to: schedule, target: link("/schedule"), title: "This week's installs", body: "Lot 14's tear-off is under way today and the shingles go on tomorrow, with inspections in between. Each crew has its color, and weather rules warn you before a wet day." },
      { to: quote("sent"), target: link("/quotes"), title: "A storm claim, measured on the aerial", body: "Jordan's roof was drawn on the satellite view: squares at 6/12 with eaves, rakes and ridge measured, and the quote filled in from it. Gutters are an option he can add." },
      invoices("Summit Ridge's deposit on Lot 14 is past due, and Crewtavo can remind them by itself. Payments come by card, bank or check."),
    ],
    paving: [
      { to: schedule, target: link("/schedule"), title: "Paving days and sealcoat days", body: "The Phase 2 roads are on the schedule with weather rules: if it's too cold or rain is coming, Crewtavo warns you before the crew goes out." },
      { to: quote("draft"), target: link("/quotes"), title: "A takeoff on the aerial", body: "The clubhouse lot was outlined on the satellite view: square feet of sealcoat, cracks, stalls and ADA spaces, and the quote filled in from them." },
      invoices("Summit Ridge is billed as the work goes, with 10% held back. The progress bill is past due, and Crewtavo can remind them by itself."),
    ],
  };
  const general: Step[] = [
    { to: schedule, target: link("/schedule"), title: "This week's work", body: "Today's jobs, estimates and a regular customer's visits, by crew. Drag a visit to move it; Map lays out the day's route." },
    { to: quote("sent"), target: link("/quotes"), title: "A quote waiting on Jordan", body: "Jordan can approve it from a link, tick the optional line, and it becomes a job with its visits." },
    invoices("One invoice is past due, and Crewtavo can remind the client by itself. Payments come by card, bank or check."),
  ];
  return [welcome, home, requests, ...(middle[trade] ?? general), crew, client, done];
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
  const all = useMemo(() => tourSteps(session.company.trade_preset ?? "", session.company.name), [session.company.trade_preset, session.company.name]);
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
          <span className={styles.tourCount}>{first ? "Guided tour" : `${step} of ${all.length - 1}`}</span>
          <button type="button" className={styles.tourClose} onClick={() => go(null)} aria-label="End the tour" title="End the tour">
            <Icon name="x" size={16} />
          </button>
        </div>
        <h2 id="demo-tour-title" className={styles.tourTitle}>{current.title}</h2>
        <p id="demo-tour-body" className={styles.tourBody}>{current.body}</p>
        <div className={styles.tourActions}>
          {first ? (
            <>
              <Button size="sm" variant="ghost" onClick={() => go(null)}>I'll look around myself</Button>
              <Button ref={primary} size="sm" variant="primary" icon="play" onClick={() => go(1)}>Show me around</Button>
            </>
          ) : last ? (
            <>
              <Button size="sm" variant="ghost" onClick={() => go(null)}>Keep exploring</Button>
              <a className="btn btn-sm btn-primary" href={GET_CREWTAVO} onClick={() => go(null)}>Get Crewtavo free</a>
            </>
          ) : (
            <>
              <Button size="sm" variant="ghost" icon="arrowLeft" onClick={() => go(step - 1)}>Back</Button>
              <Button ref={primary} size="sm" variant="primary" onClick={() => go(step + 1)}>Next<Icon name="arrowRight" size={14} /></Button>
            </>
          )}
        </div>
      </section>
    </>
  );
}
