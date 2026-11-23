/**
 * A job showcase (/s/:token): a business's before and after photos of a finished job and its
 * write-up, in the business's logo and colour, with Get a quote to its booking form when it has one.
 * Never the client's name or address; the town only when the business chose to show it. An
 * unpublished one says it isn't available. No account needed.
 */
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { useParams } from "react-router-dom";
import { cx } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { PrivacyFooter } from "@/components/ui/PrivacyLink";
import { publicFetch } from "@/lib/publicApi";
import { Broken, ClientBody, ClientHeader, ClientPage, ClientSkeleton, kit as k } from "./ClientKit";
import s from "./showcase.module.css";

interface ShowcaseView {
  company: { name: string; phone: string | null; website: string | null; logo: string | null; color: string | null; privacy_url?: string | null };
  title: string;
  description: string;
  town: string | null;
  published_at: string;
  photos: Array<{ role: "before" | "after" | "photo"; src: string }>;
  book_url: string | null;
}

export function ShowcasePage() {
  const { token = "" } = useParams();
  const view = useQuery({ queryKey: ["showcase", token], retry: false, queryFn: () => publicFetch<ShowcaseView>(`/public/showcases/${token}`) });
  const d = view.data;
  useEffect(() => {
    document.title = d ? `${d.title} · ${d.company.name}` : "Showcase";
  }, [d]);
  const group = (role: ShowcaseView["photos"][number]["role"]) => d?.photos.filter((p) => p.role === role) ?? [];
  const before = group("before");
  const after = group("after");
  const sections = d ? ([["Before", before], ["After", after], [before.length || after.length ? "More photos" : null, group("photo")]] as const) : [];
  const photoSection = ([label, photos]: (typeof sections)[number]) =>
    photos.length ? (
      <section key={label ?? "photos"} className={s.photos} aria-label={label ?? "Photos"}>
        {label && <h2 className={k.h2}>{label}</h2>}
        <div className={s.grid}>
          {photos.map((p) => <img key={p.src} src={p.src} alt={label ? `${label} photo` : "Photo of the work"} loading="lazy" />)}
        </div>
      </section>
    ) : null;

  return (
    <ClientPage color={d?.company.color}>
      {d && <ClientHeader name={d.company.name} logo={d.company.logo} phone={d.company.phone} />}
      <ClientBody width="wide">
        {view.isPending && <ClientSkeleton lines={1} />}
        {view.error && (
          <Broken icon="image" title="This showcase isn't available">
            {(view.error as { status?: number }).status === 404 ? "It may have been taken down by the business." : (view.error as Error).message}
          </Broken>
        )}
        {d && (
          <>
            <section className={cx(k.card, s.intro)} aria-labelledby="showcase-title">
              <div className={s.introText}>
                <h1 id="showcase-title" className={cx(k.title, k.long)}>{d.title}</h1>
                {d.town && <span className={k.place}><Icon name="pin" size={14} />{d.town}</span>}
                {d.description && <p className={cx(k.msg, "pre-wrap")}>{d.description}</p>}
              </div>
              {d.book_url && <a className={cx(k.cta, k.auto)} href={d.book_url}><Icon name="quote" size={18} />Get a quote</a>}
            </section>
            {/* Before and after side by side on a computer, when there are both. */}
            {before.length > 0 && after.length > 0 ? <div className={s.pair}>{sections.slice(0, 2).map(photoSection)}</div> : sections.slice(0, 2).map(photoSection)}
            {photoSection(sections[2]!)}
            {/* Asked again under the photos; with none, the one in the write-up is right above. */}
            {d.book_url && d.photos.length > 0 && (
              <section className={cx(k.card, s.ask)} aria-label="Get a quote">
                <p className={s.askText}>Want work like this at your place?</p>
                <a className={cx(k.cta, k.auto)} href={d.book_url}>Get a quote</a>
              </section>
            )}
            <div className={k.foot}><PrivacyFooter url={d.company.privacy_url} /></div>
          </>
        )}
      </ClientBody>
    </ClientPage>
  );
}
