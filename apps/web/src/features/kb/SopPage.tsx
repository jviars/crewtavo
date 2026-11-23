/**
 * One SOP (KB-Guide, KB-Phone.dc.html): read it, confirm you've read it (answering its quiz first, if
 * it has one), say whether it helped or suggest a change, and for the office: see who's read it and
 * what people said, edit, copy, compare and restore versions, mark it reviewed or delete it. A job
 * description also shows how far each person with the job is through its training (the guides it
 * links to). The words sit in one reading column; who has read it, the contents and the feedback sit
 * in a rail beside it, which goes under the guide on a narrow screen. On a phone the contents and
 * "I've read this" are in a bar at the thumb.
 */
import { TRASH_DAYS } from "@crewtavo/core/drive";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { ActionBar } from "@/components/ui/DetailPage";
import { Button, cx } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { Dialog } from "@/components/ui/Dialog";
import { Icon } from "@/components/ui/Icon";
import { MetaLine, personHue } from "@/components/ui/InboxList";
import { Menu, type MenuEntry } from "@/components/ui/Menu";
import { BackLink, Crumb, useDocumentTitle } from "@/components/ui/PageHeader";
import { RelatedList, RelatedRow, Section } from "@/components/ui/Section";
import { DetailSkeleton, Skeleton } from "@/components/ui/Skeleton";
import { ErrorState, PageError } from "@/components/ui/States";
import { StatusPill } from "@/components/ui/StatusPill";
import { Face } from "@/components/ui/Avatar";
import { ApiError, api, supabase, unwrap } from "@/lib/api";
import { formatDate, formatDateTime, timeAgo } from "@/lib/format";
import { hasContent, htmlToText, isAppPath, sanitizeHtml, withSections } from "@/lib/html";
import { can, hasRole, useSession } from "@/lib/session";
import { toast } from "@/lib/toast";
import { useCompanyRoles } from "../settings/roles";
import { GuideContents, goToSection, useCurrentSection } from "./GuideContents";
import { categoryLook, GuideCover, GuideTile } from "./GuideCover";
import { GuideFeedback, OfficeFeedback } from "./GuideFeedback";
import { useGuidePictures } from "./pictures";
import { PictureViewer } from "./PictureViewer";
import { QuizDialog, type QuizQuestion } from "./QuizDialog";
import { ShareGuideDialog } from "./ShareGuideDialog";
import { VersionCompare } from "./VersionCompare";
import { guideLinks, guideQuery, mustRead, reviewDueAt, ROLE_LABELS, useCategories, useIsEditor, useSopIndex, useTraining } from "./kbData";
import { msg, t } from "@/lib/i18n";
import s from "./kb.module.css";
import { Select } from "@/components/ui/Select";

interface TeamMember { user_id: string; role: string; role_id: string | null; active: boolean; profile: { full_name: string; color: string | null; avatar_url?: string | null } | null }

/** About how long a guide takes to read, at 200 words a minute. */
const minutesToRead = (html: string) => Math.max(1, Math.round(htmlToText(html).split(/\s+/).filter(Boolean).length / 200));

export function SopPage() {
  const { pageId = "" } = useParams();
  const session = useSession();
  const { company, userId, roleId } = session;
  const editor = useIsEditor();
  // Owners and admins who edit guides decide who a guide is shared with outside the team.
  const sharer = editor && hasRole(session, "admin") && can(session, "kb_edit");
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  // Revision history opens straight away when a category's row menu sent us here for it.
  const [history, setHistory] = useState(() => editor && (location.state as { history?: boolean } | null)?.history === true);
  const [quizzing, setQuizzing] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [picture, setPicture] = useState<{ src: string; alt: string } | null>(null);
  const inlineContents = useRef<HTMLDetailsElement>(null);

  const page = useQuery(guideQuery(company.id, pageId));
  const team = useQuery({ queryKey: ["team", company.id], staleTime: 5 * 60_000, queryFn: () => api.get<TeamMember[]>("/team") });
  const roles = useCompanyRoles();
  const training = useTraining();
  const index = useSopIndex();
  const categories = useCategories();
  // A job description (Settings → Roles): how far each person with the job is through its training.
  const jobRoles = (roles.data ?? []).filter((r) => r.guide_id === pageId);
  const trainingIds = [...new Set(jobRoles.flatMap((r) => training?.get(r.id) ?? []))];
  const trainingReads = useQuery({
    queryKey: ["kb", company.id, "training-reads", pageId, trainingIds],
    enabled: editor && trainingIds.length > 0,
    queryFn: async () => unwrap(await supabase().from("sop_acknowledgements").select("user_id, page_id, revision").eq("company_id", company.id).in("page_id", trainingIds)),
  });
  // The guides that link here, like a job's description linking each duty to how it's done.
  const linkedFrom = useQuery({
    queryKey: ["kb", company.id, "linked-from", pageId],
    enabled: Boolean(page.data),
    queryFn: async () => unwrap(await supabase().from("sop_pages").select("id, title").eq("company_id", company.id).neq("id", pageId).like("body_html", `%/kb/${pageId}%`).order("title").limit(50)),
  });
  // Every read of every revision, oldest first: who has read this one, and when the others last read an earlier one.
  const reads = useQuery({
    queryKey: ["kb", company.id, "reads", pageId],
    enabled: Boolean(page.data),
    queryFn: async () => unwrap(await supabase().from("sop_acknowledgements").select("user_id, revision, acknowledged_at").eq("page_id", pageId).order("acknowledged_at")),
  });
  // Whether people outside the team can read it by its link, for the people who edit it: what they write shows there.
  const shared = useQuery({
    queryKey: ["kb", company.id, "shared", pageId],
    enabled: editor && Boolean(page.data),
    queryFn: async () => {
      const [share, people] = await Promise.all([
        supabase().from("sop_shares").select("access").eq("page_id", pageId).maybeSingle(),
        supabase().from("sop_share_people").select("id", { count: "exact", head: true }).eq("page_id", pageId),
      ]);
      return { anyone: unwrap(share)?.access === "anyone", people: people.count ?? 0 };
    },
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["kb", company.id] });
  // Its quiz, as readers get it (questions and options, no answers): null when it has none.
  const quiz = useQuery({
    queryKey: ["kb", company.id, "quiz", pageId],
    enabled: Boolean(page.data),
    queryFn: async () => (unwrap(await supabase().rpc("guide_quiz", { p_page: pageId })) as unknown as QuizQuestion[] | null) ?? null,
  });
  const acknowledge = useMutation({
    meta: { success: t("Marked as read") },
    mutationFn: async () => unwrap(await supabase().rpc("acknowledge_guide", { p_page: pageId })),
    onSettled: refresh,
  });
  const remove = useMutation({
    mutationFn: async () => unwrap(await supabase().from("sop_pages").delete().eq("id", pageId)),
    onSuccess: () => {
      // Its cover photo goes to the Trash by itself (the database moves it).
      toast.success(t("Guide deleted"), page.data?.cover_path ? { description: t("Its cover photo is in the Trash for {days} days.", { days: TRASH_DAYS }) } : undefined);
      refresh();
      navigate("/kb", { replace: true });
    },
  });
  const review = useMutation({
    meta: { success: t("Marked as reviewed") },
    mutationFn: async () => unwrap(await supabase().from("sop_pages").update({ reviewed_at: new Date().toISOString() }).eq("id", pageId)),
    onSettled: refresh,
  });
  const pin = useMutation({
    meta: { success: (_: unknown, on: boolean) => (on ? t("Pinned to the top of the knowledge base") : t("Unpinned")) },
    mutationFn: async (on: boolean) => unwrap(await supabase().from("sop_pages").update({ pinned_at: on ? new Date().toISOString() : null }).eq("id", pageId)),
    onSettled: refresh,
  });
  const publish = useMutation({
    meta: { success: t("Guide published") },
    mutationFn: async () => unwrap(await supabase().from("sop_pages").update({ status: "published" }).eq("id", pageId)),
    onSettled: refresh,
  });
  const body = useMemo(() => {
    const html = sanitizeHtml(page.data?.body_html ?? "");
    return { empty: !hasContent(html), minutes: minutesToRead(html), ...withSections(html) };
  }, [page.data?.body_html]);
  const sections = body.sections.length > 1 ? body.sections : [];
  const bodyHtml = useGuidePictures(body.html, true);
  const current = useCurrentSection(sections);
  // A link to a section (…/kb/id#mixing-ratio): go there once the guide is showing. A frame later, so the new screen's scroll to the top goes first.
  const { hash } = location;
  // Once open, Back or a reload doesn't open it again.
  useEffect(() => {
    if ((location.state as { history?: boolean } | null)?.history) navigate(`${location.pathname}${location.hash}`, { replace: true, state: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (hash.length < 2 || body.empty) return;
    const frame = requestAnimationFrame(() => document.getElementById(decodeURIComponent(hash.slice(1)))?.scrollIntoView());
    return () => cancelAnimationFrame(frame);
  }, [hash, body]);
  useDocumentTitle(page.data?.title);

  if (page.isPending) return <DetailSkeleton />;
  if (page.error || !page.data) return <PageError error={page.error ?? new ApiError(msg("This guide doesn't exist, or it was deleted."), 404)} onRetry={page.error ? () => page.refetch() : undefined} back={<BackLink to="/kb">{t("Knowledge base")}</BackLink>} />;
  const sop = page.data;
  const member = (id: string | null) => team.data?.find((m) => m.user_id === id);
  const name = (id: string | null) => member(id)?.profile?.full_name ?? t("Team member");
  const allReads = reads.data ?? [];
  const readers = allReads.filter((r) => r.revision === sop.revision);
  const acknowledged = readers.some((r) => r.user_id === userId);
  // Who has to read it: required reading's audience, and everyone whose job's training includes it.
  const trainedBy = (roles.data ?? []).filter((r) => training?.get(r.id)?.includes(sop.id));
  const forThem = (m: TeamMember) => (sop.required && mustRead(sop, m)) || (m.role_id != null && trainedBy.some((r) => r.id === m.role_id));
  const audience = (team.data ?? []).filter((m) => m.active && forThem(m));
  const published = sop.status === "published";
  const askToRead = published && (sop.required || trainedBy.some((r) => r.id === roleId));
  // Who it's for, by team role (Settings → Roles) and by level; a deleted role isn't named.
  const forWhom = [...(roles.data ?? []).filter((r) => sop.audience_roles?.includes(r.id)).map((r) => r.name), ...(sop.audience ?? []).map((r) => ROLE_LABELS[r] ?? r)];
  const jobOf = jobRoles.map((r) => r.name);
  const trainingFor = jobOf.length ? [] : trainedBy.map((r) => r.name);
  const outstanding = audience.filter((m) => !readers.some((r) => r.user_id === m.user_id));
  // The last earlier revision someone read, for "Still to read".
  const earlier = (user: string) => allReads.filter((r) => r.user_id === user && r.revision < sop.revision).at(-1);
  const showReads = published && (sop.required || trainedBy.length > 0);
  const revisionOf = new Map((index.data?.pages ?? []).map((p) => [p.id, p.revision]));
  const trainees = (team.data ?? []).filter((m) => m.active && jobRoles.some((r) => r.id === m.role_id));
  const trainingDone = (user: string) => trainingIds.filter((id) => trainingReads.data?.some((a) => a.user_id === user && a.page_id === id && a.revision === revisionOf.get(id))).length;
  const showTraining = editor && trainingIds.length > 0;
  // On a review schedule: when it's next due, for the office.
  const due = reviewDueAt(sop);
  const reviewDue = due !== null && due <= new Date();
  const toReadNext = (index.data?.toRead ?? []).filter((p) => p.id !== sop.id);
  // The guides around this one: those that link here, and those it links to.
  const pages = index.data?.pages ?? [];
  const lookOf = (categoryId: string | null) => {
    const i = (categories.data ?? []).findIndex((c) => c.id === categoryId);
    return categoryLook(categories.data?.[i]?.name, i);
  };
  const categoryName = (categoryId: string | null) => categories.data?.find((c) => c.id === categoryId)?.name ?? null;
  const linksTo = guideLinks(sop.body_html ?? "").filter((id) => id !== sop.id && !linkedFrom.data?.some((g) => g.id === id)).flatMap((id) => pages.filter((p) => p.id === id));
  const related = [
    ...(linkedFrom.data ?? []).map((g) => ({ id: g.id, title: g.title, page: pages.find((p) => p.id === g.id), why: t("Links to this guide") })),
    ...linksTo.map((p) => ({ id: p.id, title: p.title, page: p, why: t("Linked in this guide") })),
  ];
  // "#" beside a heading copies a link to it; the contents links just go there. A link to another
  // guide (or any screen in Crewtavo) opens here without reloading the app; ⌘-click still opens a tab.
  // A picture opens full screen, to zoom into on a phone.
  const openPicture = (target: EventTarget) => {
    const img = target instanceof HTMLImageElement ? target : null;
    if (!img?.currentSrc && !img?.getAttribute("src")) return false;
    setPicture({ src: img.currentSrc || img.src, alt: img.alt });
    return true;
  };
  const onArticleKeyDown = (e: KeyboardEvent) => {
    if ((e.key === "Enter" || e.key === " ") && openPicture(e.target)) e.preventDefault();
  };
  // Asked at the top of a guide, again at its end where a phone finishes reading, and in a phone's bar.
  const confirmRead = () => (quiz.data?.length ? setQuizzing(true) : acknowledge.mutate());
  const confirming = acknowledge.isPending;
  const notReady = reads.isPending || quiz.isPending;
  const onArticleClick = (e: MouseEvent) => {
    if (openPicture(e.target)) return;
    const link = (e.target as Element).closest("a");
    const href = link?.getAttribute("href");
    if (!link || !href) return;
    if (href.startsWith("#")) {
      e.preventDefault();
      goToSection(decodeURIComponent(href.slice(1)), link.classList.contains("heading-anchor"));
    } else if (isAppPath(href) && !(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)) {
      e.preventDefault();
      navigate(href);
    }
  };
  const sharedWith = shared.data?.anyone ? t("Anyone") : shared.data?.people ? t.plural(shared.data.people, { one: "{count} person", other: "{count} people" }) : undefined;
  const more: MenuEntry[] = [
    { label: t("Print"), icon: "printer", kbd: "P", onSelect: () => window.print() },
    { label: t("Share with a link"), icon: "share", end: sharedWith, onSelect: () => setSharing(true), hidden: !sharer },
    { separator: true, hidden: !editor },
    { label: t("Revision history"), icon: "history", end: sop.revision > 1 ? String(sop.revision) : undefined, kbd: "H", onSelect: () => setHistory(true), hidden: !editor },
    { label: sop.pinned_at ? t("Unpin") : t("Pin to the top"), icon: sop.pinned_at ? "unpin" : "pushpin", onSelect: () => pin.mutate(!sop.pinned_at), hidden: !editor },
    { label: t("Make a copy"), icon: "copy", onSelect: () => navigate(`/kb/new?copy=${sop.id}`), hidden: !editor },
    { separator: true, hidden: !editor || (sop.status !== "draft" && (!due || reviewDue)) },
    { label: t("Publish"), icon: "send", onSelect: () => publish.mutate(), hidden: !editor || sop.status !== "draft" },
    { label: t("Mark reviewed"), icon: "calendarCheck", end: due ? t("Due {date}", { date: formatDate(due.toISOString()) }) : undefined, onSelect: () => review.mutate(), hidden: !editor || !due || reviewDue },
    { separator: true, hidden: !editor },
    {
      label: t("Delete guide"), icon: "trash", danger: true, hidden: !editor,
      onSelect: async () => { if (await confirm({ title: t("Delete this guide?"), body: t("It's removed for everyone, along with its revision history and read receipts."), confirmLabel: t("Delete"), danger: true })) remove.mutate(); },
    },
  ];
  const readButton = askToRead && !acknowledged;
  const section = sections.findIndex((x) => x.id === current);
  const status: ReactNode[] = [
    sop.status === "draft" && <StatusPill tone="muted" label={t("Draft · only the office can see this")} />,
    sop.required && <StatusPill tone={askToRead && !acknowledged ? "warning" : "muted"} label={forWhom.length ? t("Required reading for {roles}", { roles: forWhom.join(", ") }) : t("Required reading")} />,
    jobOf.length > 0 && <StatusPill tone="info" label={t("Job description for {roles}", { roles: jobOf.join(", ") })} />,
    trainingFor.length > 0 && <StatusPill tone="info" label={t("Training for {roles}", { roles: trainingFor.join(", ") })} />,
    editor && reviewDue && <StatusPill tone="warning" label={sop.owner_id ? `${t("Review due")} · ${name(sop.owner_id)}` : t("Review due")} />,
    editor && sop.pinned_at && <span className="pill"><Icon name="pushpin" size={12} />{t("Pinned")}</span>,
    editor && shared.data?.anyone && <span className="pill"><Icon name="globe" size={12} />{t("Anyone with the link can read this")}</span>,
    editor && shared.data && !shared.data.anyone && shared.data.people > 0 && (
      <span className="pill"><Icon name="link" size={12} />{t.plural(shared.data.people, { one: "Shared with {count} person outside the team", other: "Shared with {count} people outside the team" })}</span>
    ),
  ];
  const crumbTo = sop.category ? `/kb?category=${sop.category.id}` : "/kb";
  const railShown = sections.length > 0 || showReads || showTraining || (editor && published && !body.empty);

  return (
    <>
      <div className={s.reader}>
      <div className={cx(s.read, !railShown && s.readSolo)}>
        <div className={s.readMain}>
          <div className={cx("page-header detail-head", s.guideHead)}>
            <nav className="detail-crumb" aria-label={t("Breadcrumb")}>
              {sop.category && <span className={cx("hide-mobile", s.crumbRoot)}><Link to="/kb">{t("Knowledge base")}</Link><Icon name="chevronRight" size={14} /></span>}
              <Crumb to={crumbTo}>{sop.category?.name ?? t("Knowledge base")}</Crumb>
            </nav>
            <h1 className={cx("page-title", s.guideTitle)}>{sop.title}</h1>
            <div className="page-actions no-print">
              {editor && reviewDue && <Button icon="calendarCheck" loading={review.isPending} onClick={() => review.mutate()}>{t("Mark reviewed")}</Button>}
              {editor && <Link className="btn" to={`/kb/${sop.id}/edit`}><Icon name="edit" size={16} />{t("Edit")}</Link>}
              {askToRead && (acknowledged ? (
                <span className={s.readOk}><Icon name="check" size={16} bold />{t("You've read this")}</span>
              ) : (
                <Button icon="check" className={cx("hide-mobile", s.readBtn)} loading={confirming} disabled={notReady} onClick={confirmRead}>{t("I've read this")}</Button>
              ))}
              {editor || sharer ? (
                <Menu items={more} label={t("More actions")} title={sop.title} />
              ) : (
                <Button icon="printer" aria-label={t("Print")} title={t("Print")} className="hide-mobile" onClick={() => window.print()} />
              )}
            </div>
            <MetaLine className={cx("detail-meta", s.guideStatus)} parts={status} />
            <div className={s.guideMeta}>
              <MetaLine
                parts={[
                  t("Revision {number}", { number: sop.revision }),
                  sop.updated_by && team.data ? t("Updated {when} by {name}", { when: timeAgo(sop.revised_at), name: name(sop.updated_by) }) : t("Updated {when}", { when: timeAgo(sop.revised_at) }),
                  editor && due && !reviewDue && (sop.owner_id ? t("Next review {date} by {name}", { date: formatDate(due.toISOString()), name: name(sop.owner_id) }) : t("Next review {date}", { date: formatDate(due.toISOString()) })),
                  quiz.data?.length ? t.plural(quiz.data.length, { one: "Quiz: {count} question", other: "Quiz: {count} questions" }) : null,
                  !body.empty && t("{count} min read", { count: body.minutes }),
                ]}
              />
            </div>
          </div>

          {sop.cover_path && <GuideCover path={sop.cover_path} className={cx("sop-cover no-print", s.cover)} />}
          {sections.length > 0 && (
            <details ref={inlineContents} className={cx("sop-toc-inline no-print", s.tocInline)}>
              <summary>{t("On this page")}<span className={s.tocCount}> · {t.plural(sections.length, { one: "{count} section", other: "{count} sections" })}</span></summary>
              <GuideContents sections={sections} current={current} onPick={() => inlineContents.current?.removeAttribute("open")} />
            </details>
          )}
          <article className={cx("prose sop-body", s.article)} aria-label={sop.title} onClick={onArticleClick} onKeyDown={onArticleKeyDown}>
            {body.empty ? <p className="muted">{t("This guide is empty.")}{editor && <> <Link to={`/kb/${sop.id}/edit`}>{t("Add content")}</Link></>}</p> : <div dangerouslySetInnerHTML={{ __html: bodyHtml }} />}
          </article>

          {(related.length > 0 || sop.tags.length > 0) && (
            <div className={cx(s.related, "no-print")}>
              {related.length > 0 && (
                <Section title={t("Related guides")}>
                  <RelatedList>
                    {related.map((g) => (
                      <RelatedRow
                        key={g.id}
                        to={`/kb/${g.id}`}
                        lead={<GuideTile path={g.page?.cover_path ?? null} look={lookOf(g.page?.category_id ?? null)} className={s.relTile} />}
                        title={g.title}
                        sub={[categoryName(g.page?.category_id ?? null), g.why]}
                        end={<Icon name="chevronRight" size={16} />}
                      />
                    ))}
                  </RelatedList>
                </Section>
              )}
              {sop.tags.length > 0 && (
                <div className={s.tags}>
                  <span>{t("Tags")}</span>
                  {sop.tags.map((tag) => <Link key={tag} to={`/kb?q=${encodeURIComponent(tag)}`} title={t("Guides tagged with this")}>{tag}</Link>)}
                </div>
              )}
            </div>
          )}

          {askToRead && !body.empty && (
            <section className={cx(s.done, "no-print")} aria-labelledby="guide-done-title">
              {acknowledged ? (
                <>
                  <span className={s.doneIcon} data-ok=""><Icon name="check" size={18} bold /></span>
                  <div>
                    <h2 id="guide-done-title" className={s.doneTitle}>{t("You've read this revision")}</h2>
                    <p className={s.doneSub}>{t("The office can see you confirmed revision {number}.", { number: sop.revision })}</p>
                  </div>
                </>
              ) : (
                <>
                  <span className={s.doneIcon}><Icon name="checklist" size={18} /></span>
                  <div>
                    <h2 id="guide-done-title" className={s.doneTitle}>{t("Done reading?")}</h2>
                    <p className={s.doneSub}>{quiz.data?.length ? t.plural(quiz.data.length, { one: "Answer a question to confirm you've read it.", other: "Answer {count} questions to confirm you've read it." }) : t("Confirm you've read it, so the office knows.")}</p>
                  </div>
                  <Button variant="primary" icon="check" className="hide-mobile" loading={confirming} disabled={notReady} onClick={confirmRead}>{t("I've read this")}</Button>
                </>
              )}
            </section>
          )}
          {published && !body.empty && <GuideFeedback page={sop} />}
        </div>

        {railShown && (
          <aside className={cx(s.rail, "no-print")} aria-label={t("About this guide")}>
            {sections.length > 0 && (
              <nav className={cx(s.railSec, s.railToc)} aria-label={t("On this page")}>
                <h2 className={s.railHead}>{t("On this page")}</h2>
                <GuideContents sections={sections} current={current} />
              </nav>
            )}
            {showTraining && (
              <section className={s.railSec} aria-labelledby="rail-training">
                <div className={s.railRow}><h2 id="rail-training" className={s.railHead}>{t("Training progress")}</h2><span className={s.railCount}>{t.plural(trainingIds.length, { one: "{count} guide", other: "{count} guides" })}</span></div>
                {!team.data || trainingReads.isPending ? <Skeleton height={28} /> : trainees.length === 0 ? <p className={s.railNote}>{jobOf.length === 1 ? t("No one has this role yet.") : t("No one has these roles yet.")}</p> : (
                  <ul className={s.people}>
                    {trainees.map((m) => {
                      const done = trainingDone(m.user_id);
                      return (
                        <li key={m.user_id} className={s.person}>
                          <span className={cx("avatar", s.face)} style={{ background: personHue(name(m.user_id)) }}><Face name={name(m.user_id)} photo={m.profile?.avatar_url} /></span>
                          <span className={s.personName}>{name(m.user_id)}</span>
                          <span className={s.personEnd}>{t("{done} of {count}", { done, count: trainingIds.length })}</span>
                          <span className={s.personBar}><b style={{ width: `${(done / trainingIds.length) * 100}%` }} /></span>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            )}
            {showReads && (
              <section className={s.railSec} aria-labelledby="rail-reads">
                <div className={s.railRow}><h2 id="rail-reads" className={s.railHead}>{t("Read this revision")}</h2><span className={s.railCount}>{team.data ? t("{done} of {count}", { done: readers.length, count: audience.length }) : readers.length}</span></div>
                {team.data && audience.length > 0 && <span className={s.bar}><b style={{ width: `${Math.min(100, (readers.length / audience.length) * 100)}%` }} /></span>}
                {reads.isPending ? <Skeleton height={28} /> : readers.length === 0 ? <p className={s.railNote}>{t("No one has confirmed this revision yet.")}</p> : (
                  <ul className={s.people}>
                    {readers.map((r) => (
                      <li key={r.user_id} className={s.person}>
                        <span className={cx("avatar", s.face)} style={{ background: personHue(name(r.user_id)) }}><Face name={name(r.user_id)} photo={member(r.user_id)?.profile?.avatar_url} /></span>
                        <span className={s.personName}>{name(r.user_id)}</span>
                        <span className={s.personEnd} title={formatDateTime(r.acknowledged_at)}>{formatDate(r.acknowledged_at)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )}
            {showReads && editor && outstanding.length > 0 && (
              <section className={s.railSec} aria-labelledby="rail-still">
                <div className={s.railRow}><h2 id="rail-still" className={s.railHead}>{t("Still to read")}</h2><span className={s.railCount}>{outstanding.length}</span></div>
                <ul className={s.people}>
                  {outstanding.map((m) => {
                    const before = earlier(m.user_id);
                    return (
                      <li key={m.user_id} className={s.person}>
                        <span className={cx("avatar", s.face)} style={{ background: personHue(m.profile?.full_name ?? "") }}><Face name={m.profile?.full_name ?? t("Team member")} photo={m.profile?.avatar_url} /></span>
                        <span className={s.personName}>{m.profile?.full_name ?? t("Team member")}{m.user_id === userId && <span className={s.you}> ({t("you")})</span>}</span>
                        <span className={s.personSub}>{before ? t("Read revision {number} on {date}", { number: before.revision, date: formatDate(before.acknowledged_at) }) : t("Not read yet")}</span>
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}
            {editor && published && !body.empty && <OfficeFeedback page={sop} person={(id) => ({ name: name(id), photo: member(id)?.profile?.avatar_url })} />}
          </aside>
        )}
      </div>
      </div>

      {(sections.length > 0 || readButton) && !body.empty && (
        <ActionBar label={t("Guide")}>
          {sections.length > 0 && (
            <Menu
              items={sections.map((x) => ({ label: x.title, lead: x.level > 2 ? <span className={s.tocIndent} /> : undefined, checked: current === x.id, onSelect: () => goToSection(x.id) }))}
              label={t("On this page")}
              title={t("On this page")}
              align="start"
              triggerClassName={cx("btn", s.tocButton)}
              trigger={
                <>
                  <Icon name="list" size={20} />
                  <span className={s.tocNow}>{section >= 0 ? sections[section]!.title : t("On this page")}</span>
                  {section >= 0 && <span className={s.tocOf}>{t("{done} of {count}", { done: section + 1, count: sections.length })}</span>}
                </>
              }
            />
          )}
          {readButton && <Button variant="primary" icon="check" loading={confirming} disabled={notReady} onClick={confirmRead}>{t("I've read this")}</Button>}
        </ActionBar>
      )}
      {history && <HistoryDialog pageId={sop.id} current={sop.revision} names={name} onClose={() => setHistory(false)} />}
      {picture && <PictureViewer src={picture.src} alt={picture.alt} onClose={() => setPicture(null)} />}
      {sharing && <ShareGuideDialog pageId={sop.id} title={sop.title} onClose={() => setSharing(false)} />}
      {quizzing && quiz.data?.length && (
        <QuizDialog pageId={sop.id} title={sop.title} revision={sop.revision} questions={quiz.data} next={toReadNext[0] ? { id: toReadNext[0].id, title: toReadNext[0].title, more: toReadNext.length } : null} onClose={() => setQuizzing(false)} />
      )}
    </>
  );
}

/**
 * Every saved version, newest first, beside the one open: what changed from the version before it,
 * side by side (or from any other version, picked), or the words as they were; an old one can be
 * restored. On a phone the list comes first and a revision opens over it.
 */
function HistoryDialog({ pageId, current, names, onClose }: { pageId: string; current: number; names: (id: string | null) => string; onClose: () => void }) {
  const { company } = useSession();
  const queryClient = useQueryClient();
  const [viewing, setViewing] = useState<number | null>(null);
  const [mode, setMode] = useState<"changes" | "read">("changes");
  const [against, setAgainst] = useState<number | null>(null);
  // A phone shows the list until a revision is picked; a desktop opens the newest straight away.
  const [picked, setPicked] = useState(false);
  const revisions = useQuery({
    queryKey: ["kb", company.id, "revisions", pageId],
    queryFn: async () => unwrap(await supabase().from("sop_revisions").select("revision, title, body_html, edited_by, created_at").eq("page_id", pageId).order("revision", { ascending: false }).limit(100)),
  });
  const restore = useMutation({
    meta: { success: (_: unknown, r: number) => t("Revision {number} restored as a new revision", { number: r }) },
    mutationFn: async (revision: number) => {
      const r = revisions.data!.find((x) => x.revision === revision)!;
      unwrap(await supabase().from("sop_pages").update({ title: r.title, body: { type: "html", html: r.body_html }, body_html: r.body_html, body_text: htmlToText(r.body_html) }).eq("id", pageId));
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["kb", company.id] });
      onClose();
    },
  });
  const all = revisions.data ?? [];
  const open = (revision: number) => {
    const before = all.find((r) => r.revision < revision);
    setViewing(revision);
    setPicked(true);
    setAgainst(before?.revision ?? all.find((r) => r.revision !== revision)?.revision ?? null);
    setMode(before ? "changes" : "read");
  };
  // Open the newest once the list is here.
  useEffect(() => {
    if (viewing === null && all.length) {
      const newest = all[0]!.revision;
      const before = all.find((r) => r.revision < newest);
      setViewing(newest);
      setAgainst(before?.revision ?? null);
      setMode(before ? "changes" : "read");
    }
  }, [all, viewing]);
  const shown = all.find((r) => r.revision === viewing);
  const base = all.find((r) => r.revision === against);
  const readHtml = useGuidePictures(useMemo(() => sanitizeHtml(shown?.body_html ?? ""), [shown?.body_html]));
  // Older on the left, newer on the right, whichever was picked first.
  const [older, newer] = shown && base ? (base.revision < shown.revision ? [base, shown] : [shown, base]) : [null, null];
  const label = (r: { revision: number; created_at: string }) => `${r.revision === current ? t("Revision {number} (current)", { number: r.revision }) : t("Revision {number}", { number: r.revision })} · ${formatDate(r.created_at)}`;
  const comparing = Boolean(shown && mode === "changes" && older && newer);

  return (
    <Dialog open onClose={onClose} title={t("Revision history")} description={t("Every saved change is kept. Open one to see what changed, or to restore it.")} size="xl">
      <div className={s.history} data-picked={picked || undefined}>
        <div className={s.historyMain}>
          {revisions.isPending && <div className="stack-sm"><Skeleton width="40%" height={16} /><Skeleton width="70%" /><Skeleton height={160} radius={8} /></div>}
          {revisions.error && <ErrorState compact error={revisions.error} onRetry={() => revisions.refetch()} />}
          {shown && (
            <>
              <div className={s.historyHead}>
                <button type="button" className={cx("btn btn-sm btn-ghost", s.historyBack)} onClick={() => setPicked(false)}><Icon name="arrowLeft" size={14} />{t("All revisions")}</button>
                <div className={s.historyWho}>
                  <h3>{t("Revision {number}", { number: shown.revision })}</h3>
                  <p>{shown.title} · {t("{when} by {name}", { when: formatDateTime(shown.created_at), name: names(shown.edited_by) })}</p>
                </div>
                <div className="segmented" role="group" aria-label={t("Show")}>
                  <button type="button" aria-pressed={mode === "changes"} disabled={all.length < 2} onClick={() => setMode("changes")}>{t("Changes")}</button>
                  <button type="button" aria-pressed={mode === "read"} onClick={() => setMode("read")}>{t("Read it")}</button>
                </div>
              </div>
              {mode === "changes" && all.length > 1 && (
                <label className={s.compare}>
                  <span>{t("Compared with")}</span>
                  <Select className="select input-sm" value={against ?? ""} onChange={(e) => setAgainst(Number(e.target.value))}>
                    {all.filter((r) => r.revision !== shown.revision).map((r) => <option key={r.revision} value={r.revision}>{label(r)}</option>)}
                  </Select>
                </label>
              )}
              {comparing ? (
                <div className="diff-scroll">
                  <VersionCompare before={{ label: label(older!), title: older!.title, html: older!.body_html }} after={{ label: label(newer!), title: newer!.title, html: newer!.body_html }} />
                </div>
              ) : (
                <div className={cx("prose", s.historyRead)} dangerouslySetInnerHTML={{ __html: readHtml || "<p><em>Empty</em></p>" }} />
              )}
            </>
          )}
        </div>
        <div className={s.historyList}>
          <h3 className={s.historyListHead}>{t("Revisions")}{all.length > 0 && <span className="sec-count">{all.length}</span>}</h3>
          <ul>
            {all.map((r) => (
              <li key={r.revision}>
                <button type="button" className={s.rev} aria-pressed={r.revision === viewing} onClick={() => open(r.revision)}>
                  <span className={s.revNumber}>{r.revision}</span>
                  <span className={s.revText}>
                    <span className={s.revTitle}>{r.title}{r.revision === current && <span className="tag">{t("Current")}</span>}</span>
                    <span className={s.revSub}>{formatDateTime(r.created_at)} · {names(r.edited_by)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
      {shown && shown.revision !== current && (
        <div className="form-actions">
          <span className={s.historyNote}>{t("Restoring saves it as revision {number}. Anyone who has to read this guide confirms it again.", { number: current + 1 })}</span>
          <Button variant="primary" icon="undo" loading={restore.isPending} onClick={() => restore.mutate(shown.revision)}>{t("Restore revision {number}", { number: shown.revision })}</Button>
        </div>
      )}
    </Dialog>
  );
}
