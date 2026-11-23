/**
 * A guide shared by link (/g/:token; apps/api/src/routes/guideShares.ts), for people outside the
 * team: under the business's logo and colour (never Crewtavo's green), with no account, in the look
 * clients get (Client-Desktop, Client-Phone.dc.html; the client kit's header and colors): the
 * business at the top, the guide on a rounded sheet, and its contents beside it (folded above it on a
 * phone). A link for anyone opens straight
 * away. A link for certain people asks for an email address and sends a code there; the right code
 * lets this browser in for 30 days, to every guide shared with that address. A guide that was
 * unpublished or deleted, or whose link was swapped for a new one, says it isn't available.
 */
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { useLocation, useParams } from "react-router-dom";
import { Button, cx } from "@/components/ui/Button";
import { CodeField } from "@/components/ui/CodeField";
import { FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { PrivacyFooter } from "@/components/ui/PrivacyLink";
import { Skeleton } from "@/components/ui/Skeleton";
import { GuideContents, useCurrentSection } from "@/features/kb/GuideContents";
import { brandStyle, ClientHeader } from "@/features/public/ClientKit";
import { formatDate } from "@/lib/format";
import { hasContent, isAppPath, sanitizeHtml, withSections } from "@/lib/html";
import { publicFetch } from "@/lib/publicApi";
import s from "@/features/kb/kb.module.css";

interface Brand { name: string; phone: string | null; website: string | null; logo: string | null; color: string | null; privacy_url?: string | null }
interface Locked { locked: true; company: Brand }
interface Open {
  locked: false;
  company: Brand;
  title: string;
  category: string | null;
  revised_at: string | null;
  html: string;
  cover: string | null;
  /** Where each of the guide's stored pictures loads from, by the path its HTML names. */
  pictures: Record<string, string>;
  /** The address this browser proved, when the guide is for certain people. */
  email: string | null;
}
type Shared = Locked | Open;

/** What a right code leaves in this browser: the key the server gave it, and the address it's for. */
interface Reader { key: string; email: string }
const KEPT = "crewtavo.guide-reader";
function keptReader(): Reader | null {
  try {
    const kept = JSON.parse(localStorage.getItem(KEPT) ?? "null") as Reader | null;
    return kept && typeof kept.key === "string" && typeof kept.email === "string" ? kept : null;
  } catch {
    return null;
  }
}
function keepReader(reader: Reader | null) {
  try {
    if (reader) localStorage.setItem(KEPT, JSON.stringify(reader));
    else localStorage.removeItem(KEPT);
  } catch {
    // Private browsing: it lasts until the tab closes.
  }
}

/**
 * The guide's HTML as an outside reader gets it: cleaned, its sections named, its stored pictures
 * pointed at where this page loads them from (one the page wasn't given is left out), and links to
 * screens in Crewtavo (another guide, a job) turned into plain words, since they'd only lead to a
 * sign-in page.
 */
export function sharedGuideHtml(html: string, pictures: Record<string, string>) {
  const body = withSections(sanitizeHtml(html));
  const doc = new DOMParser().parseFromString(`<div>${body.html}</div>`, "text/html");
  const root = doc.body.firstElementChild!;
  for (const img of Array.from(root.querySelectorAll("img"))) {
    const path = img.getAttribute("data-path");
    if (path) {
      const src = pictures[path];
      if (!src) {
        img.remove();
        continue;
      }
      img.setAttribute("src", src);
      img.removeAttribute("data-path");
    }
    img.setAttribute("loading", "lazy");
    img.setAttribute("decoding", "async");
  }
  // The "#" beside a heading copies a link to it in Crewtavo; here the contents list does the going.
  for (const anchor of Array.from(root.querySelectorAll("a.heading-anchor"))) anchor.remove();
  for (const link of Array.from(root.querySelectorAll("a[href]"))) {
    if (!isAppPath(link.getAttribute("href") ?? "")) continue;
    const words = doc.createElement("span");
    words.append(...Array.from(link.childNodes));
    link.replaceWith(words);
  }
  return { html: root.innerHTML, sections: body.sections, empty: !hasContent(body.html) };
}

export function SharedGuidePage() {
  const { token = "" } = useParams();
  const [reader, setReader] = useState<Reader | null>(keptReader);
  // A link cut short or mangled on its way here isn't asked about.
  const real = /^[0-9a-f]{32}$/.test(token);
  const view = useQuery({
    queryKey: ["shared-guide", token, reader?.key ?? null],
    enabled: real,
    retry: false,
    // Someone reading isn't interrupted: the guide is asked for when the page opens, not each time they come back to it.
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    queryFn: () => publicFetch<Shared>(`/public/guides/${token}`, { key: reader?.key ?? null }),
  });
  // Once it can't be had (taken down, a new link), what was read before isn't left on the screen.
  const d = view.error ? undefined : view.data;
  const gone = !real || (view.error as { status?: number } | null)?.status === 404;
  const guide = d && !d.locked ? d : null;
  useEffect(() => {
    document.title = guide ? `${guide.title} · ${guide.company.name}` : d ? d.company.name : "Guide";
  }, [d, guide]);
  // For whoever was sent it, never for search engines (the server says so too: server.ts).
  useEffect(() => {
    const robots = document.createElement("meta");
    robots.name = "robots";
    robots.content = "noindex";
    document.head.append(robots);
    return () => robots.remove();
  }, []);
  const let_in = (next: Reader | null) => {
    keepReader(next);
    setReader(next);
  };

  return (
    <div className={cx("shared-guide", s.shared)} style={brandStyle(d?.company.color)}>
      {d && <ClientHeader name={d.company.name} logo={d.company.logo} phone={d.company.phone} />}
      <div className={cx(s.sharedBody, guide ? s.sharedWide : s.sharedNarrow)}>
        {real && view.isPending && (
          <div className={s.sharedSheet} aria-busy="true">
            <div className="stack-sm"><Skeleton width="30%" height={12} /><Skeleton width="70%" height={30} /><Skeleton width="85%" /><Skeleton width="80%" /><Skeleton height={180} radius={12} /></div>
          </div>
        )}
        {(!real || view.error) && (
          <div className={cx(s.sharedSheet, s.sharedGone)}>
            <span className={s.doneIcon}><Icon name="book" size={20} /></span>
            <h1>This guide isn't available</h1>
            <p>{gone ? "The link may have changed, or the guide was taken down. Ask whoever sent it for a new link." : (view.error as Error).message}</p>
            {!gone && <Button loading={view.isFetching} onClick={() => view.refetch()}>Try again</Button>}
          </div>
        )}
        {d?.locked && <CodeGate token={token} company={d.company} was={reader} onReader={let_in} />}
        {guide && <Guide guide={guide} onNotMe={() => let_in(null)} />}
        {d && <PrivacyFooter url={d.company.privacy_url} />}
      </div>
    </div>
  );
}

function Guide({ guide, onNotMe }: { guide: Open; onNotMe: () => void }) {
  const body = useMemo(() => sharedGuideHtml(guide.html, guide.pictures), [guide.html, guide.pictures]);
  const sections = body.sections.length > 1 ? body.sections : [];
  const current = useCurrentSection(sections);
  const contents = useRef<HTMLDetailsElement>(null);
  const [coverBroken, setCoverBroken] = useState(false);
  // A link to a section (…/g/token#watering): go there once the guide is showing.
  const { hash } = useLocation();
  useEffect(() => {
    if (hash.length < 2 || body.empty) return;
    const frame = requestAnimationFrame(() => document.getElementById(decodeURIComponent(hash.slice(1)))?.scrollIntoView());
    return () => cancelAnimationFrame(frame);
  }, [hash, body]);

  return (
    <div className={cx(s.sharedRead, sections.length === 0 && s.sharedSolo)}>
      <main className={s.sharedSheet}>
        {guide.category && <span className={s.sharedKicker}>{guide.category}</span>}
        <h1 className={s.sharedTitle}>{guide.title}</h1>
        {guide.revised_at && <p className={s.guideMeta}>Updated {formatDate(guide.revised_at)}</p>}
        {guide.cover && !coverBroken && <span className={cx("guide-cover sop-cover", s.cover)}><img src={guide.cover} alt="" decoding="async" onError={() => setCoverBroken(true)} /></span>}
        {sections.length > 0 && (
          <details ref={contents} className={cx("sop-toc-inline no-print", s.sharedTocInline)}>
            <summary>On this page<span className={s.tocCount}> · {sections.length} sections</span></summary>
            <GuideContents sections={sections} current={current} onPick={() => contents.current?.removeAttribute("open")} />
          </details>
        )}
        <article className={cx("prose sop-body", s.article)} aria-label={guide.title}>
          {body.empty ? <p className="muted">This guide is empty.</p> : <div dangerouslySetInnerHTML={{ __html: body.html }} />}
        </article>
        {guide.email && (
          <p className={cx(s.sharedWho, "no-print")}>
            Shared with {guide.email}. <button type="button" className="link-btn" onClick={onNotMe}>Not you?</button>
          </p>
        )}
      </main>
      {sections.length > 0 && (
        <nav className={cx(s.sharedRail, "no-print")} aria-label="On this page">
          <h2 className={s.railHead}>On this page</h2>
          <GuideContents sections={sections} current={current} />
        </nav>
      )}
    </div>
  );
}

/** The door of a guide for certain people: an email address, then the code sent to it. */
function CodeGate({ token, company, was, onReader }: { token: string; company: Brand; was: Reader | null; onReader: (reader: Reader | null) => void }) {
  // The address this browser proved before, to type it once: its 30 days ran out, or this guide was sent to another.
  const [email, setEmail] = useState(was?.email ?? "");
  const [code, setCode] = useState("");
  const codeId = useId();
  const [asked, setAsked] = useState<{ email: string; challenge: string } | null>(null);
  const ask = useMutation({
    // What went wrong is said under the field it's about.
    meta: { inline: true },
    mutationFn: async (address: string) => ({ email: address.trim(), ...(await publicFetch<{ challenge: string }>(`/public/guides/${token}/code`, { email: address })) }),
    onSuccess: (sent) => {
      setAsked({ email: sent.email, challenge: sent.challenge });
      setCode("");
      check.reset();
    },
  });
  const check = useMutation({
    meta: { inline: true },
    mutationFn: () => publicFetch<Reader>(`/public/guides/${token}/code/check`, { challenge: asked!.challenge, code }),
    onSuccess: (reader) => onReader({ key: reader.key, email: reader.email }),
  });
  const submitEmail = (e: FormEvent) => {
    e.preventDefault();
    if (email.trim()) ask.mutate(email);
  };
  const submitCode = (e: FormEvent) => {
    e.preventDefault();
    if (code.replace(/\D/g, "").length >= 6) check.mutate();
  };

  return (
    <section className={cx(s.sharedSheet, s.gate)} aria-labelledby="guide-gate">
      <span className={s.gateIcon} aria-hidden="true"><Icon name={asked ? "mail" : "lock"} size={20} /></span>
      <div className={s.gateWords}>
        <h1 id="guide-gate">{asked ? "Check your email" : `${company.name} shared a guide with you`}</h1>
        <p role="status">
          {asked
            ? <>If <strong>{asked.email}</strong> is an address this guide was shared with, a 6-digit code is on its way there. It can take a minute, and may land in spam.</>
            : "It's for certain people. Enter the email address it was sent to, and we'll send a code there to check it's you."}
        </p>
      </div>
      {asked ? (
        <form className={s.gateForm} onSubmit={submitCode}>
          <div className={s.gateField}>
            <label htmlFor={codeId}>The 6-digit code from the email</label>
            <CodeField id={codeId} length={6} value={code} onChange={(next) => { setCode(next); check.reset(); }} autoFocus />
          </div>
          <FormError error={check.error ?? ask.error} />
          <Button type="submit" variant="primary" size="lg" className={s.brandButton} loading={check.isPending} disabled={code.replace(/\D/g, "").length < 6}>Open the guide</Button>
          <div className={s.gateLinks}>
            <button type="button" className="link-btn" disabled={ask.isPending} onClick={() => ask.mutate(asked.email)}>{ask.isPending ? "Sending…" : "Send another code"}</button>
            <button type="button" className="link-btn" onClick={() => { setAsked(null); ask.reset(); check.reset(); }}>Use a different address</button>
          </div>
        </form>
      ) : (
        <form className={s.gateForm} onSubmit={submitEmail}>
          <label className={s.gateField}>
            <span>Your email address</span>
            <input className="input" type="email" inputMode="email" autoComplete="email" spellCheck={false} required placeholder="you@example.com" value={email} onChange={(e) => { setEmail(e.target.value); ask.reset(); }} />
          </label>
          <FormError error={ask.error} />
          <Button type="submit" variant="primary" size="lg" icon="mail" className={s.brandButton} loading={ask.isPending} disabled={!email.trim()}>Send me a code</Button>
        </form>
      )}
    </section>
  );
}
