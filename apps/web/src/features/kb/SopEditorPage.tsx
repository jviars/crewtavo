/**
 * Write or edit an SOP (office and up): from blank, a template (templates.ts) or a copy of another
 * guide, with its quiz. Every save of its title or words is a new revision; nothing is lost.
 *
 * KB-Edit.dc.html: a bar (back, whether it's saved, what saving does, Save), the page laid out as
 * it reads (cover, title, words) under its formatting tools, and the guide's settings beside it, on
 * hairlines: hidden with the bar's switch, and a dialog (a sheet on a phone) under 1100px.
 */
import { ACCESS_LABELS } from "@crewtavo/core/guideShares";
import { STAFF } from "@crewtavo/core/roles";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type DragEvent, type FormEvent, type ReactNode } from "react";
import { Link, useBlocker, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { photoQuery } from "@/components/ui/Avatar";
import { Button, cx, Spinner } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { Dialog } from "@/components/ui/Dialog";
import { FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { RowPerson } from "@/components/ui/InboxList";
import { Menu } from "@/components/ui/Menu";
import { BackLink, useDocumentTitle } from "@/components/ui/PageHeader";
import { RichTextEditor, type LinkTarget, type Pictures } from "@/components/ui/RichTextEditor";
import { Loading, Skeleton, SkeletonText } from "@/components/ui/Skeleton";
import { StatusPill } from "@/components/ui/StatusPill";
import { EmptyState, PageError } from "@/components/ui/States";
import { TagInput } from "@/components/ui/TagInput";
import { ApiError, api, supabase, unwrap } from "@/lib/api";
import { coverPicture, uploadFile } from "@/lib/files";
import { formatDate } from "@/lib/format";
import { hasContent, htmlToText } from "@/lib/html";
import { can, hasRole, useSession } from "@/lib/session";
import { useCompanyRoles } from "../settings/roles";
import { guideFinder } from "./finder";
import { categoryLook, GuideCover } from "./GuideCover";
import k from "./kb.module.css";
import { mustRead, reviewDueAt, ROLE_LABELS, useCategories, useIsEditor, useSopIndex, useTraining } from "./kbData";
import s from "./kbWrite.module.css";
import { guidePicture, PICTURE_ACCEPT } from "./pictures";
import { cleanQuiz, type QuizDraft, type SavedQuestion } from "./quiz";
import { QuizEditor } from "./QuizEditor";
import { ShareGuideDialog } from "./ShareGuideDialog";
import { templateFor } from "./templates";

interface Draft { title: string; category_id: string; status: "draft" | "published"; required: boolean; audience: string[]; audience_roles: string[]; tags: string[]; html: string; cover_path: string | null; review_months: string; owner_id: string; quiz: QuizDraft[] }
/** The guide as it was loaded: which revision, when its words were last saved and by whom, and when it was last reviewed. */
interface Loaded { updated_at: string; revision: number; revised_at: string; updated_by: string | null; reviewed_at: string | null }
interface TeamMember { user_id: string; role: string; role_id: string | null; active: boolean; profile: { full_name: string } | null }

const GUIDE_FIELDS = "id, title, category_id, status, required, audience, audience_roles, tags, body_html, cover_path, updated_at, updated_by, revision, revised_at, review_months, reviewed_at, owner_id";
/** A guide and its quiz, to edit (or copy). The quiz with its answers: only the office reads it. */
async function loadGuide(id: string) {
  const [page, quiz] = await Promise.all([
    supabase().from("sop_pages").select(GUIDE_FIELDS).eq("id", id).maybeSingle(),
    supabase().from("sop_quizzes").select("questions").eq("page_id", id).maybeSingle(),
  ]);
  const guide = unwrap(page);
  return guide && { ...guide, quiz: ((unwrap(quiz)?.questions ?? []) as unknown as SavedQuestion[]).map((q): QuizDraft => ({ question: q.question, options: q.options, answer: q.answer })) };
}

// How often a guide is looked over (sop_pages.review_months), with "" for not on a schedule.
const REVIEW_EVERY: Array<[string, string]> = [["", "Not on a schedule"], ["3", "Every 3 months"], ["6", "Every 6 months"], ["12", "Every year"], ["24", "Every 2 years"]];

// Required reading is for the team below admin; a sub never reads guides.
const ROLES = STAFF.filter((r) => r !== "owner" && r !== "admin");

/** Wide enough for the settings beside the page; narrower, they open as a dialog. */
const WIDE = "(min-width: 1101px)";
function useWide() {
  return useSyncExternalStore(
    (changed) => {
      const query = window.matchMedia(WIDE);
      query.addEventListener("change", changed);
      return () => query.removeEventListener("change", changed);
    },
    () => window.matchMedia(WIDE).matches,
    () => true,
  );
}
/** Whether this person hid the settings beside the page (kept on this device only). */
const PANEL_KEY = "crewtavo.guide-settings";
const panelHidden = () => {
  try {
    return localStorage.getItem(PANEL_KEY) === "hidden";
  } catch {
    return false;
  }
};
const keepPanel = (shown: boolean) => {
  try {
    if (shown) localStorage.removeItem(PANEL_KEY);
    else localStorage.setItem(PANEL_KEY, "hidden");
  } catch {
    // Private browsing: it's only remembered until the page goes.
  }
};
const SAVE_KEY = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? "⌘S" : "Ctrl S";

/** A quiz question with something typed in it (one that's all blank is dropped). */
const written = (q: QuizDraft) => Boolean(q.question.trim() || q.options.some((o) => o.trim()));
const FINISHED: QuizDraft = { question: "-", options: ["-", "-"], answer: 0 };

/** "Jordan Price", "Jordan Price and Marco Ruiz", "Jordan Price, Marco Ruiz and 2 more". */
const someNames = (names: string[]) => (names.length <= 2 ? names.join(" and ") : `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`);

export function SopEditorPage() {
  const { pageId } = useParams();
  const [params] = useSearchParams();
  const { company } = useSession();
  const editor = useIsEditor();
  const categories = useCategories();
  // A new guide can start as a copy of another (…/kb/new?copy=id) or from a template (?template=job).
  const copyOf = pageId ? null : params.get("copy");
  const template = pageId || copyOf ? null : templateFor(params.get("template"));
  const source = pageId ?? copyOf;
  const existing = useQuery({
    queryKey: ["kb", company.id, "edit", source],
    enabled: Boolean(source),
    gcTime: 0,
    queryFn: () => loadGuide(source!),
  });
  useDocumentTitle(pageId ? "Edit guide" : "New guide");

  if (!editor) return <><BackLink to="/kb">Knowledge base</BackLink><EmptyState icon="lock" title="You don't have permission to edit this">Writing guides takes “Write and edit guides” in Settings › Roles.</EmptyState></>;
  if (source && existing.isPending) return <EditorSkeleton />;
  if (source && (existing.error || !existing.data)) return <PageError error={existing.error ?? new ApiError("This guide doesn't exist, or it was deleted.", 404)} onRetry={existing.error ? () => existing.refetch() : undefined} back={<BackLink to="/kb">Knowledge base</BackLink>} />;
  const e = existing.data;
  const blank: Draft = { title: params.get("title") ?? "", category_id: params.get("category") ?? "", status: "published", required: false, audience: [], audience_roles: [], tags: [], html: template?.html ?? "", cover_path: null, review_months: "", owner_id: "", quiz: [] };
  const initial: Draft = e
    ? {
        title: copyOf ? `${e.title} (copy)` : e.title,
        category_id: e.category_id ?? "",
        // A copy starts as a draft, without the cover photo (each guide's is its own file).
        status: copyOf ? "draft" : (e.status as Draft["status"]),
        required: e.required,
        audience: (e.audience as string[] | null) ?? [],
        audience_roles: e.audience_roles ?? [],
        tags: e.tags,
        html: e.body_html,
        cover_path: copyOf ? null : e.cover_path,
        review_months: e.review_months ? String(e.review_months) : "",
        owner_id: e.owner_id ?? "",
        quiz: e.quiz,
      }
    : blank;
  const loaded: Loaded | null = pageId && e ? { updated_at: e.updated_at, revision: e.revision, revised_at: e.revised_at, updated_by: e.updated_by, reviewed_at: e.reviewed_at } : null;
  return <Editor key={pageId ?? `new:${copyOf ?? template?.key ?? ""}`} pageId={pageId ?? null} initial={initial} loaded={loaded} categories={categories.data ?? []} titleHint={template?.titleHint} />;
}

/** While the guide loads: the editor's bar and tools on their hairlines, and the page's first lines. */
function EditorSkeleton() {
  return (
    <div className={s.editor}>
      <div className={s.bar}><Skeleton width={120} height={14} /><span className={s.grow} /><Skeleton width={64} height={32} radius={8} /></div>
      <Loading label="Loading the guide" className={s.main}>
        <div className="rte" data-layout="page">
          <div className="rte-top"><div className="rte-toolbar"><Skeleton width={320} height={14} /></div></div>
          <div className="rte-paper">
            <Skeleton width="62%" height={34} radius={8} style={{ marginBottom: 28 }} />
            <SkeletonText lines={5} />
          </div>
        </div>
      </Loading>
    </div>
  );
}

function Editor({ pageId, initial, loaded, categories, titleHint }: { pageId: string | null; initial: Draft; loaded: Loaded | null; categories: Array<{ id: string; name: string }>; titleHint?: string }) {
  const session = useSession();
  const { company } = session;
  // Owners and admins who edit guides decide who a guide is shared with outside the team.
  const sharer = hasRole(session, "admin") && can(session, "kb_edit");
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(initial);
  const [saved, setSaved] = useState(JSON.stringify(initial));
  const [touched, setTouched] = useState(false);
  // A new guide saved before its quiz failed: trying again saves that guide, not another.
  const created = useRef<{ id: string; updated_at: string } | null>(null);
  // Set once saved, as it goes to the guide: the unsaved-changes guard lets that through.
  const leaving = useRef(false);
  // Pictures in the guide: stored in the company's kb/ folder as they're added (pictures.ts).
  const [uploading, setUploading] = useState(false);
  const pictures = useMemo<Pictures>(() => ({
    accept: PICTURE_ACCEPT,
    add: async (file) => {
      const picture = await guidePicture(file);
      if (!picture) throw new Error("Crewtavo can't open that picture here. Try a JPEG or PNG.");
      return { path: await uploadFile(company.id, "kb", picture.file), width: picture.width, height: picture.height };
    },
    link: (path) => queryClient.fetchQuery(photoQuery(path)),
  }), [company.id, queryClient]);
  const text = useRef(htmlToText(initial.html));
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const page = useRef<HTMLDivElement>(null);
  // A cover photo picked here is only uploaded when the guide is saved.
  const [cover, setCover] = useState<{ file: File; url: string } | null>(null);
  useEffect(() => () => { if (cover) URL.revokeObjectURL(cover.url); }, [cover]);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const toggle = (key: "audience" | "audience_roles", value: string) => set(key, draft[key].includes(value) ? draft[key].filter((x) => x !== value) : [...draft[key], value]);
  // Team roles (Settings → Roles) as well as levels; a role deleted since isn't kept.
  const roles = useCompanyRoles();
  // Who can review it: the people who edit guides. Who has to read it, and who has.
  const team = useQuery({ queryKey: ["team", company.id], staleTime: 5 * 60_000, queryFn: () => api.get<TeamMember[]>("/team") });
  const reviewers = (team.data ?? []).filter((m) => m.active && ["owner", "admin", "office"].includes(m.role));
  const nameOf = (id: string | null) => team.data?.find((m) => m.user_id === id)?.profile?.full_name ?? null;
  const audienceRoles = draft.audience_roles.filter((id) => !roles.data || roles.data.some((r) => r.id === id));
  // The link box finds the other guides by title, tag or category; the tags box offers the tags guides already have.
  const index = useSopIndex();
  const findLinks = useMemo(() => {
    const pages = (index.data?.pages ?? []).filter((p) => p.id !== pageId);
    const byId = new Map(pages.map((p) => [p.id, p]));
    const names = new Map(categories.map((c) => [c.id, c.name]));
    const find = guideFinder(pages, categories);
    return (term: string): LinkTarget[] => find(term).map((id) => {
      const p = byId.get(id)!;
      return { title: p.title, href: `/kb/${p.id}`, detail: p.status === "draft" ? "Draft" : names.get(p.category_id ?? "") };
    });
  }, [index.data, categories, pageId]);
  const knownTags = useMemo(() => [...new Set((index.data?.pages ?? []).flatMap((p) => p.tags))].sort((a, b) => a.localeCompare(b)), [index.data]);

  // Who reads it: required reading's people, and everyone whose job's training includes it (Settings → Roles).
  const training = useTraining();
  const jobOf = (roles.data ?? []).filter((r) => pageId && r.guide_id === pageId);
  const trainedBy = (roles.data ?? []).filter((r) => pageId && training?.get(r.id)?.includes(pageId));
  const readersOf = (g: Pick<Draft, "status" | "required" | "audience" | "audience_roles">) =>
    g.status !== "published" ? [] : (team.data ?? []).filter((m) => m.active && ((g.required && mustRead(g, m)) || (m.role_id != null && trainedBy.some((r) => r.id === m.role_id))));
  const reads = useQuery({
    queryKey: ["kb", company.id, "reads", pageId, loaded?.revision],
    enabled: Boolean(pageId && loaded),
    queryFn: async () => unwrap(await supabase().from("sop_acknowledgements").select("user_id, acknowledged_at").eq("page_id", pageId!).eq("revision", loaded!.revision).order("acknowledged_at")),
  });
  // Whether people outside the team can read it by its link (the guide's page asks the same).
  const shared = useQuery({
    queryKey: ["kb", company.id, "shared", pageId],
    enabled: Boolean(pageId && sharer),
    queryFn: async () => {
      const [share, people] = await Promise.all([
        supabase().from("sop_shares").select("access").eq("page_id", pageId!).maybeSingle(),
        supabase().from("sop_share_people").select("id", { count: "exact", head: true }).eq("page_id", pageId!),
      ]);
      return { anyone: unwrap(share)?.access === "anyone", people: people.count ?? 0 };
    },
  });

  const save = useMutation({
    meta: { inline: true, success: () => (pageId ? "Guide saved" : draft.status === "draft" ? "Draft saved" : "Guide published") },
    mutationFn: async () => {
      const title = draft.title.trim();
      if (!title) {
        titleRef.current?.focus();
        throw new Error("Give the guide a title.");
      }
      if (uploading) throw new Error("Wait for the pictures to finish adding, then save.");
      if (draft.required && draft.status === "published" && !hasContent(draft.html)) throw new Error("Add some content before making this required reading.");
      const quiz = cleanQuiz(draft.quiz);
      if ("problem" in quiz) throw new Error(`Quiz: ${quiz.problem}`);
      // Saved apart from the guide (only the office reads the answers); none: no quiz.
      const saveQuiz = async (id: string) =>
        unwrap(quiz.questions.length
          ? await supabase().from("sop_quizzes").upsert({ page_id: id, company_id: company.id, questions: quiz.questions as never })
          : await supabase().from("sop_quizzes").delete().eq("page_id", id));
      const uploaded = cover ? await uploadFile(company.id, "kb", cover.file) : null;
      const cover_path = uploaded ?? draft.cover_path;
      const row = {
        title,
        category_id: draft.category_id || null,
        status: draft.status,
        required: draft.required,
        audience: draft.required && draft.audience.length ? (draft.audience as never) : null,
        audience_roles: draft.required && audienceRoles.length ? audienceRoles : null,
        // Saving counts as a review (the database's sop_review_clock).
        review_months: draft.review_months ? Number(draft.review_months) : null,
        owner_id: draft.review_months && draft.owner_id ? draft.owner_id : null,
        tags: draft.tags,
        body: { type: "html", html: draft.html },
        body_html: draft.html,
        body_text: text.current,
        cover_path,
      };
      // A cover it no longer has (it isn't kept in its revisions) goes to the Trash by itself. A new
      // one uploaded for a save that fails is left behind: only the server deletes stored files.
      const known = pageId ? { id: pageId, updated_at: loaded!.updated_at } : created.current;
      if (known) {
        // The quiz first: it doesn't change the guide, so the guide's save below can still be tried again.
        if (pageId) await saveQuiz(pageId);
        // Don't overwrite someone else's save made while this was open.
        const rows = unwrap(await supabase().from("sop_pages").update(row).eq("id", known.id).eq("updated_at", known.updated_at).select("id, updated_at"));
        if (!rows.length) throw new Error("Someone else saved this guide while you were editing. Copy your changes, reload the page, and apply them again.");
        if (!pageId) {
          created.current = rows[0];
          await saveQuiz(known.id);
        }
        return { id: known.id };
      }
      created.current = unwrap(await supabase().from("sop_pages").insert({ ...row, company_id: company.id }).select("id, updated_at").single());
      await saveQuiz(created.current.id);
      return { id: created.current.id };
    },
    onSuccess: (r) => {
      setSaved(JSON.stringify(draft));
      queryClient.invalidateQueries({ queryKey: ["kb", company.id] });
      // Read by the unsaved-changes guard when it runs, which can be before it sees this render's state.
      leaving.current = true;
      navigate(`/kb/${r.id}`, { replace: !pageId });
    },
  });

  const dirty = JSON.stringify(draft) !== saved || (cover !== null && !save.isSuccess);
  const blocker = useBlocker(({ currentLocation, nextLocation }) => !leaving.current && dirty && !save.isSuccess && currentLocation.pathname !== nextLocation.pathname);
  useEffect(() => {
    if (blocker.state !== "blocked") return;
    confirm({ title: "Leave without saving?", body: "Your changes to this guide will be lost.", confirmLabel: "Leave", danger: true }).then((ok) => (ok ? blocker.proceed() : blocker.reset()));
  }, [blocker]);
  useEffect(() => {
    const onUnload = (ev: BeforeUnloadEvent) => {
      if (dirty) ev.preventDefault();
    };
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, [dirty]);
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "s") {
        ev.preventDefault();
        setTouched(true);
        if (!save.isPending) save.mutate();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save]);
  // The title wraps onto as many lines as it needs, like the guide's heading.
  useLayoutEffect(() => {
    const field = titleRef.current;
    if (!field) return;
    const fit = () => {
      field.style.height = "auto";
      field.style.height = `${field.scrollHeight}px`;
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [draft.title]);

  // The settings: beside the page when there's room (hidden with the bar's switch), otherwise a dialog.
  const wide = useWide();
  const [panelShown, setPanelShown] = useState(() => !panelHidden());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [quizOpen, setQuizOpen] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [categorySearch, setCategorySearch] = useState("");
  const settingsInline = wide && panelShown;
  const flipSettings = () => {
    if (!wide) return setSettingsOpen(true);
    keepPanel(!panelShown);
    setPanelShown(!panelShown);
  };

  const submit = (ev: FormEvent) => {
    ev.preventDefault();
    setTouched(true);
    save.mutate();
  };

  // What saving does: a change to the title or words is a new revision, which the people it's for read again.
  const contentChanged = draft.title.trim() !== initial.title.trim() || draft.html !== initial.html;
  const savedReaders = readersOf(initial);
  const nextReaders = readersOf({ ...draft, audience_roles: audienceRoles });
  // A question left completely blank goes when the quiz closes, so it isn't a problem to point out
  // (it stands in as a finished one, so the others keep their numbers).
  const quizCheck = cleanQuiz(draft.quiz.map((q) => (written(q) ? q : FINISHED)));
  const quizProblem = "problem" in quizCheck ? quizCheck.problem : null;
  const quizCount = draft.quiz.length;
  const note = pageId && loaded && dirty
    ? contentChanged
      ? {
          lines: [`Saves as revision ${loaded.revision + 1}`, nextReaders.length ? `${nextReaders.length} ${nextReaders.length === 1 ? "person reads" : "people read"} it again` : null],
          title: `Saving makes revision ${loaded.revision + 1}.${nextReaders.length ? ` The ${nextReaders.length === 1 ? "person" : `${nextReaders.length} people`} it's for will have to read it${quizCount ? " and pass the quiz" : ""} again.` : ""}`,
        }
      : { lines: ["Settings only", "No new revision"], title: "Category, tags, visibility, required reading, review and quiz save with the guide and don't start a new revision." }
    : null;
  const by = loaded ? nameOf(loaded.updated_by) : null;
  const lastSaved = loaded ? `Revision ${loaded.revision}, saved ${formatDate(loaded.revised_at)}${by ? ` by ${by}` : ""}` : null;
  const backTo = pageId ? `/kb/${pageId}` : "/kb";
  const backLabel = pageId ? "Back to guide" : "Knowledge base";

  // What it was reviewed and when it's next due; a change to its words counts as a review.
  const reviewMonths = Number(draft.review_months) || 0;
  const reviewedAt = initial.review_months && loaded?.reviewed_at ? loaded.reviewed_at : null;
  const lastDue = reviewedAt ? reviewDueAt({ review_months: Number(initial.review_months), reviewed_at: reviewedAt }) : null;
  const restarts = !reviewedAt || contentChanged;
  const nextDue = reviewMonths ? reviewDueAt({ review_months: reviewMonths, reviewed_at: restarts ? new Date().toISOString() : reviewedAt }) : null;
  const categoryName = categories.find((c) => c.id === draft.category_id)?.name ?? "Uncategorized";
  const reviewerName = draft.owner_id ? (reviewers.find((m) => m.user_id === draft.owner_id)?.profile?.full_name ?? (team.data ? "Someone no longer on the team" : "…")) : "Anyone who edits guides";
  const readIds = new Set((reads.data ?? []).map((r) => r.user_id));
  const stillToRead = savedReaders.filter((m) => !readIds.has(m.user_id));
  const visId = useId();

  const settings: ReactNode = (
    <>
      <section className={s.psec} aria-labelledby={`${visId}-status`}>
        <div className={s.psh}><h2 id={`${visId}-status`}>Status</h2></div>
        <div className={s.prow}>
          <span className={s.k} id={`${visId}-vis`}>Visibility</span>
          <div className={cx("segmented", s.segSm)} role="group" aria-labelledby={`${visId}-vis`}>
            <button type="button" aria-pressed={draft.status === "published"} onClick={() => set("status", "published")}>Published</button>
            <button type="button" aria-pressed={draft.status === "draft"} onClick={() => set("status", "draft")}>Draft</button>
          </div>
        </div>
      </section>

      <section className={s.psec} aria-labelledby={`${visId}-organize`}>
        <div className={s.psh}><h2 id={`${visId}-organize`}>Organize</h2></div>
        <div className={s.prow}>
          <span className={s.k}>Category</span>
          <Menu
            label={`Category: ${categoryName}`}
            title="Category"
            align="start"
            triggerClassName={s.pv}
            trigger={<><Icon name="folder" size={15} /><span className={s.pvText}>{categoryName}</span><span className={s.chev}><Icon name="chevronDown" size={14} /></span></>}
            search={categories.length > 8 ? { value: categorySearch, onChange: setCategorySearch, placeholder: "Find a category" } : undefined}
            // Each with the color its card has in the knowledge base, as a guide's row menu shows them (Move to category); Uncategorized last.
            items={[
              ...categories
                .map((c, i) => ({ c, look: categoryLook(c.name, i) }))
                .filter(({ c }) => c.name.toLowerCase().includes(categorySearch.trim().toLowerCase()))
                .map(({ c, look }) => ({ label: c.name, lead: <span className={k.swatch} style={{ background: look?.color }} />, checked: draft.category_id === c.id, onSelect: () => set("category_id", c.id) })),
              { separator: true, hidden: Boolean(categorySearch.trim()) },
              { label: "Uncategorized", lead: <span className={cx(k.swatch, k.swatchNone)} />, checked: !draft.category_id, hidden: Boolean(categorySearch.trim()), onSelect: () => set("category_id", "") },
            ]}
          />
        </div>
        <div className={cx(s.prow, s.prowTop)}>
          <span className={s.k}>Tags</span>
          <div className={cx(s.v, s.tags)}><TagInput value={draft.tags} onChange={(tags) => set("tags", tags)} suggestions={knownTags} /></div>
        </div>
      </section>

      <section className={s.psec} aria-labelledby={`${visId}-reading`}>
        <div className={s.psh}><h2 id={`${visId}-reading`}>Reading</h2></div>
        <label className={s.swrow}>
          <span>Required reading</span>
          <input type="checkbox" className="switch" checked={draft.required} onChange={(ev) => set("required", ev.target.checked)} />
        </label>
        {draft.required && (
          <fieldset style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
            <legend className="sr-only">Who has to read it</legend>
            {(roles.data?.length ?? 0) > 0 && (
              <>
                <div className={s.sub} aria-hidden="true">Team roles</div>
                <div className={s.chips} role="group" aria-label="Team roles">
                  {roles.data!.map((r) => (
                    <button key={r.id} type="button" className={s.chip} aria-pressed={audienceRoles.includes(r.id)} onClick={() => toggle("audience_roles", r.id)}>
                      {audienceRoles.includes(r.id) && <Icon name="check" size={12} bold />}
                      {r.name}
                    </button>
                  ))}
                </div>
              </>
            )}
            <div className={s.sub} aria-hidden="true">Access levels</div>
            <div className={s.chips} role="group" aria-label="Access levels">
              {ROLES.map((r) => (
                <button key={r} type="button" className={s.chip} aria-pressed={draft.audience.includes(r)} onClick={() => toggle("audience", r)}>
                  {draft.audience.includes(r) && <Icon name="check" size={12} bold />}
                  {ROLE_LABELS[r]}
                </button>
              ))}
            </div>
            <p className={s.hint}>{draft.audience.length || audienceRoles.length ? "Anyone with one of these has to read it." : "None selected means everyone."}</p>
          </fieldset>
        )}
      </section>

      {pageId && loaded && savedReaders.length > 0 && reads.data && (
        <section className={s.psec} aria-labelledby={`${visId}-receipts`}>
          <div className={s.psh}><h2 id={`${visId}-receipts`}>Read receipts</h2></div>
          <div className={s.readst}><b>{savedReaders.length - stillToRead.length} of {savedReaders.length}</b> {savedReaders.length === 1 ? "has" : "have"} read revision {loaded.revision}</div>
          <div className={s.meter} aria-hidden="true"><span style={{ width: `${Math.round(((savedReaders.length - stillToRead.length) / savedReaders.length) * 100)}%` }} /></div>
          <div className={s.still}>
            {stillToRead.length ? (
              <>
                <span className="il-people" aria-hidden="true">{stillToRead.slice(0, 3).map((m) => <RowPerson key={m.user_id} name={m.profile?.full_name ?? "Team member"} />)}</span>
                <span>{someNames(stillToRead.map((m) => m.profile?.full_name ?? "Team member"))} still to read</span>
              </>
            ) : (
              <><Icon name="check" size={14} /><span>Everyone has read it</span></>
            )}
          </div>
        </section>
      )}

      {(jobOf.length > 0 || trainedBy.length > jobOf.length) && (
        <section className={s.psec} aria-labelledby={`${visId}-training`}>
          <div className={s.psh}><h2 id={`${visId}-training`}>Training</h2></div>
          {jobOf.length > 0 && <div className={s.prow}><span className={s.k}>Job description of</span><span className={s.v}>{jobOf.map((r) => r.name).join(", ")}</span></div>}
          {trainedBy.length > jobOf.length && <div className={s.prow}><span className={s.k}>Training for</span><span className={s.v}>{trainedBy.filter((r) => !jobOf.includes(r)).map((r) => r.name).join(", ")}</span></div>}
          <p className={s.hint}><Link to="/settings?tab=roles">Set in Settings › Roles</Link></p>
        </section>
      )}

      <section className={s.psec} aria-labelledby={`${visId}-review`}>
        <div className={s.psh}><h2 id={`${visId}-review`}>Review</h2></div>
        {reviewedAt && lastDue && (
          <div className={s.prow}>
            <span className={s.k}>Status</span>
            <span className={s.v}>{lastDue <= new Date() ? <StatusPill tone="warning" label={`Review due ${formatDate(lastDue)}`} /> : <StatusPill tone="good" label={`Reviewed ${formatDate(reviewedAt)}`} />}</span>
          </div>
        )}
        <div className={s.prow}>
          <span className={s.k}>Schedule</span>
          <Menu
            label={`Review schedule: ${REVIEW_EVERY.find(([v]) => v === draft.review_months)?.[1] ?? "Not on a schedule"}`}
            title="Review schedule"
            align="start"
            triggerClassName={s.pv}
            trigger={<><Icon name="refresh" size={15} /><span className={s.pvText}>{draft.review_months ? REVIEW_EVERY.find(([v]) => v === draft.review_months)?.[1] : "None"}</span><span className={s.chev}><Icon name="chevronDown" size={14} /></span></>}
            items={REVIEW_EVERY.map(([v, l]) => ({ label: l, checked: draft.review_months === v, onSelect: () => set("review_months", v) }))}
          />
        </div>
        {reviewMonths > 0 && (
          <div className={s.prow}>
            <span className={s.k}>Reviewed by</span>
            <Menu
              label={`Reviewed by: ${reviewerName}`}
              title="Reviewed by"
              align="start"
              triggerClassName={s.pv}
              trigger={<>{draft.owner_id ? <RowPerson name={reviewerName} /> : <Icon name="users" size={15} />}<span className={s.pvText}>{draft.owner_id ? reviewerName : "Any editor"}</span><span className={s.chev}><Icon name="chevronDown" size={14} /></span></>}
              items={[
                { label: "Anyone who edits guides", icon: "users", checked: !draft.owner_id, onSelect: () => set("owner_id", "") },
                ...reviewers.map((m) => ({ label: m.profile?.full_name ?? "Team member", lead: <RowPerson name={m.profile?.full_name ?? "Team member"} />, checked: draft.owner_id === m.user_id, onSelect: () => set("owner_id", m.user_id) })),
              ]}
            />
          </div>
        )}
        <p className={s.hint}>
          {nextDue
            ? restarts
              ? `Saving counts as a review. The next one is due ${formatDate(nextDue)}.`
              : `The next one is due ${formatDate(nextDue)}. Saving a change to its words counts as a review.`
            : "Put it on a schedule to get a reminder to check it's still right."}
        </p>
      </section>

      <section className={s.psec} aria-labelledby={`${visId}-quiz`}>
        <div className={s.psh}>
          <h2 id={`${visId}-quiz`}>Quiz</h2>
          <button type="button" className={s.pact} onClick={() => { if (!quizCount) set("quiz", [{ question: "", options: ["", ""], answer: null }]); setQuizOpen(true); }}>{quizCount ? "Edit quiz" : "Add a quiz"}</button>
        </div>
        {quizCount > 0 ? (
          <>
            <div className={s.qline}><Icon name="help" size={15} />{quizCount} {quizCount === 1 ? "question" : "questions"}</div>
            {quizProblem && <p className={cx(s.hint, s.warn)}>{quizProblem}</p>}
          </>
        ) : (
          <p className={s.hint} style={{ marginTop: 0 }}>Questions people answer before they can confirm they've read it.</p>
        )}
      </section>

      {pageId && sharer && shared.data && (
        <section className={s.psec} aria-labelledby={`${visId}-sharing`}>
          <div className={s.psh}><h2 id={`${visId}-sharing`}>Sharing</h2></div>
          <div className={s.qline}>
            <Icon name={shared.data.anyone ? "globe" : "lock"} size={15} />
            {shared.data.anyone ? ACCESS_LABELS.anyone : shared.data.people ? ACCESS_LABELS.restricted : "Only your team"}
          </div>
          <p className={s.hint} style={{ marginTop: 0 }}>
            {shared.data.people ? `Shared with ${shared.data.people} ${shared.data.people === 1 ? "person" : "people"} outside the team` : shared.data.anyone ? "Nobody added by email yet" : "Not shared outside the team"}
          </p>
          <Button size="sm" icon="link" className={s.shareBtn} onClick={() => setSharing(true)}>Share with a link</Button>
          <p className={s.hint}>Sharing changes apply right away.</p>
        </section>
      )}

      {pageId && (
        <p className={s.pfoot}><Icon name="info" size={15} /><span>Category, tags, visibility, required reading, review and quiz save with the guide and don't start a new revision.</span></p>
      )}
    </>
  );

  const closeQuiz = () => {
    // Questions left completely blank go: they'd only stop the guide saving.
    set("quiz", draft.quiz.filter(written));
    setQuizOpen(false);
  };

  return (
    <>
      <form className={s.editor} onSubmit={submit}>
        <h1 className="sr-only">{pageId ? `Edit guide: ${initial.title}` : "New guide"}</h1>
        <div className={s.bar}>
          <Link to={backTo} className={cx("btn btn-sm btn-ghost", s.back)} aria-label={backLabel}>
            <Icon name="arrowLeft" size={16} />
            <span>{backLabel}</span>
          </Link>
          <span className={s.vr} aria-hidden="true" />
          <span className={s.state} role="status">
            {uploading ? (
              <><Spinner size={12} /><span className={s.stateText}>Adding pictures…</span></>
            ) : dirty ? (
              <>
                <span className={s.dot} aria-hidden="true" />
                <span className={s.stateText}>{pageId ? "Unsaved changes" : "Not saved yet"}{lastSaved && <span className={s.dim}> · {lastSaved}</span>}</span>
              </>
            ) : (
              <span className={s.stateText}>
                <span className={s.long}>{lastSaved ?? "New guide"}</span>
                <span className={s.short} aria-hidden="true">{loaded ? `Revision ${loaded.revision}` : "New guide"}</span>
              </span>
            )}
          </span>
          <span className={s.grow} />
          {note && (
            <span className={s.note} title={note.title}>
              {note.lines.map((line, i) => line && <span key={i} className={i ? s.dim : undefined}>{line}</span>)}
            </span>
          )}
          <Button size="sm" variant="ghost" className={s.cancel} onClick={() => navigate(backTo)}>Cancel</Button>
          <Button type="submit" size="sm" variant="primary" className={s.save} loading={save.isPending} disabled={!dirty && Boolean(pageId)} aria-keyshortcuts="Meta+S Control+S">
            {pageId ? "Save" : draft.status === "draft" ? "Save draft" : "Publish"}
            <kbd className={cx("kbd", s.saveKbd)} aria-hidden="true">{SAVE_KEY}</kbd>
          </Button>
          <span className={s.vr} aria-hidden="true" />
          <button
            type="button"
            className={s.panelBtn}
            aria-label="Guide settings"
            aria-pressed={wide ? panelShown : undefined}
            aria-haspopup={wide ? undefined : "dialog"}
            title={wide ? (panelShown ? "Hide guide settings" : "Show guide settings") : "Guide settings"}
            onClick={flipSettings}
          >
            <Icon name="settings" size={16} />
          </button>
        </div>
        <div className={s.work} data-panel={settingsInline || undefined}>
          <div className={s.main} ref={page}>
            <RichTextEditor
              layout="page"
              lead={
                <>
                  {save.error ? <div className={s.error}><FormError error={save.error} /></div> : null}
                  <CoverField
                    path={draft.cover_path}
                    preview={cover?.url ?? null}
                    onChange={(picked) => {
                      setCover(picked);
                      if (!picked) set("cover_path", null);
                    }}
                  />
                  <textarea
                    ref={titleRef}
                    className={s.title}
                    rows={1}
                    value={draft.title}
                    onChange={(ev) => { set("title", ev.target.value.replace(/\s*\n\s*/g, " ")); save.reset(); }}
                    // Enter goes on to the words, as in a document: the title is one line.
                    onKeyDown={(ev) => {
                      if (ev.key !== "Enter") return;
                      ev.preventDefault();
                      page.current?.querySelector<HTMLElement>(".ProseMirror")?.focus();
                    }}
                    placeholder={`Guide title, ${titleHint ?? "e.g. Sealcoat application"}`}
                    maxLength={200}
                    aria-label="Title"
                    aria-invalid={touched && !draft.title.trim()}
                    autoFocus={!pageId}
                  />
                </>
              }
              initialHtml={initial.html}
              label="Guide content"
              placeholder="Write the steps. Type “/” to add a heading, steps, a checklist, a callout or a picture, or paste or drop a picture in."
              minHeight={360}
              findLinks={findLinks}
              pictures={pictures}
              onBusy={setUploading}
              onChange={(html, plain) => {
                text.current = plain;
                set("html", html);
              }}
            />
          </div>
          {settingsInline && (
            <aside className={s.panel} aria-label="Guide settings">
              <div className={s.panelIn}>
                <div className={s.phead}>Guide settings</div>
                {settings}
              </div>
            </aside>
          )}
        </div>
      </form>
      {!wide && (
        <Dialog open={settingsOpen} onClose={() => setSettingsOpen(false)} title="Guide settings" focusField={false}>
          <div className={cx("dialog-body", s.sheet)}>{settings}</div>
          <div className="form-actions"><span className="spacer" /><Button variant="primary" onClick={() => setSettingsOpen(false)}>Done</Button></div>
        </Dialog>
      )}
      <Dialog open={quizOpen} onClose={closeQuiz} title="Quiz" description="Questions people answer before they can confirm they've read it. Good for safety guides that are required reading." focusField={false}>
        <div className="dialog-body"><QuizEditor value={draft.quiz} onChange={(quiz) => { set("quiz", quiz); save.reset(); }} /></div>
        <div className="form-actions">
          <span className={s.footNote} data-tone={quizProblem ? "warning" : undefined} role="status">{quizProblem ?? "Saves with the guide."}</span>
          <Button variant="primary" onClick={closeQuiz}>Done</Button>
        </div>
      </Dialog>
      {sharing && pageId && <ShareGuideDialog pageId={pageId} title={initial.title} onClose={() => setSharing(false)} />}
    </>
  );
}

/** The cover photo, shown on the guide's card in the knowledge base and across the top of the guide: picked (or dropped) here, saved with the guide. */
function CoverField({ path, preview, onChange }: { path: string | null; preview: string | null; onChange: (picked: { file: File; url: string } | null) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [opening, setOpening] = useState(false);
  const [over, setOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pick = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    setOpening(true);
    const jpeg = await coverPicture(file);
    setOpening(false);
    if (!jpeg) return setError("Crewtavo can't open that picture here. Try a JPEG or PNG.");
    onChange({ file: new File([jpeg], "cover.jpg", { type: "image/jpeg" }), url: URL.createObjectURL(jpeg) });
  };
  const drop = {
    onDragOver: (e: DragEvent) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); setOver(true); } },
    onDragLeave: () => setOver(false),
    onDrop: (e: DragEvent) => { if (!e.dataTransfer.files.length) return; e.preventDefault(); setOver(false); void pick(e.dataTransfer.files[0]); },
  };
  return (
    <>
      {preview || path ? (
        <div className={s.cover} {...drop}>
          <GuideCover path={path} src={preview} />
          <div className={s.coverActs}>
            <button type="button" className={s.coverBtn} disabled={opening} onClick={() => input.current?.click()}>
              {opening ? <Spinner size={12} /> : <Icon name="image" size={14} />}
              {opening ? "Opening the photo…" : "Change photo"}
            </button>
            <button type="button" className={s.coverBtn} aria-label="Remove the cover photo" disabled={opening} onClick={() => { setError(null); onChange(null); }}>Remove</button>
          </div>
        </div>
      ) : (
        <button type="button" className={s.addCover} data-over={over || undefined} disabled={opening} title="Shows on the guide's card in the knowledge base and across the top of the guide." onClick={() => input.current?.click()} {...drop}>
          {opening ? <Spinner size={14} /> : <Icon name="image" size={16} />}
          {opening ? "Opening the photo…" : "Add a cover photo"}
        </button>
      )}
      {error && <p className={s.coverError} role="alert">{error}</p>}
      <input ref={input} type="file" accept="image/*,.heic,.heif" hidden onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ""; void pick(file); }} />
    </>
  );
}
