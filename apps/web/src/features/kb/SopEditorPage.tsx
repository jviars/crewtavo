/**
 * Write or edit an SOP (office and up): from blank, a template (templates.ts) or a copy of another
 * guide, with its quiz. Every save is a new revision; nothing is lost.
 */
import { STAFF } from "@crewtavo/core/roles";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useBlocker, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { Field, FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { BackLink, useDocumentTitle } from "@/components/ui/PageHeader";
import { photoQuery } from "@/components/ui/Avatar";
import { RichTextEditor, type LinkTarget, type Pictures } from "@/components/ui/RichTextEditor";
import { DetailSkeleton } from "@/components/ui/Skeleton";
import { EmptyState, PageError } from "@/components/ui/States";
import { TagInput } from "@/components/ui/TagInput";
import { ApiError, api, supabase, unwrap } from "@/lib/api";
import { coverPicture, uploadFile } from "@/lib/files";
import { hasContent, htmlToText } from "@/lib/html";
import { useSession } from "@/lib/session";
import { useCompanyRoles } from "../settings/roles";
import { guideFinder } from "./finder";
import { GuideCover } from "./GuideCover";
import { ROLE_LABELS, useCategories, useIsEditor, useSopIndex } from "./kbData";
import { guidePicture, PICTURE_ACCEPT } from "./pictures";
import { cleanQuiz, type QuizDraft, type SavedQuestion } from "./quiz";
import { QuizEditor } from "./QuizEditor";
import { templateFor } from "./templates";

interface Draft { title: string; category_id: string; status: "draft" | "published"; required: boolean; audience: string[]; audience_roles: string[]; tags: string[]; html: string; cover_path: string | null; review_months: string; owner_id: string; quiz: QuizDraft[] }

const GUIDE_FIELDS = "id, title, category_id, status, required, audience, audience_roles, tags, body_html, cover_path, updated_at, revision, review_months, owner_id";
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

  if (!editor) return <><BackLink to="/kb">Knowledge base</BackLink><div className="card"><EmptyState icon="lock" title="You don't have permission to edit this" /></div></>;
  if (source && existing.isPending) return <DetailSkeleton />;
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
  return <Editor key={pageId ?? `new:${copyOf ?? template?.key ?? ""}`} pageId={pageId ?? null} initial={initial} loadedAt={pageId ? (e?.updated_at ?? null) : null} categories={categories.data ?? []} titleHint={template?.titleHint} />;
}

function Editor({ pageId, initial, loadedAt, categories, titleHint }: { pageId: string | null; initial: Draft; loadedAt: string | null; categories: Array<{ id: string; name: string }>; titleHint?: string }) {
  const { company } = useSession();
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
  const titleRef = useRef<HTMLInputElement>(null);
  // A cover photo picked here is only uploaded when the guide is saved.
  const [cover, setCover] = useState<{ file: File; url: string } | null>(null);
  useEffect(() => () => { if (cover) URL.revokeObjectURL(cover.url); }, [cover]);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const toggle = (key: "audience" | "audience_roles", value: string) => set(key, draft[key].includes(value) ? draft[key].filter((x) => x !== value) : [...draft[key], value]);
  // Team roles (Settings → Roles) as well as levels; a role deleted since isn't kept.
  const roles = useCompanyRoles();
  // Who can review it: the people who edit guides.
  const team = useQuery({ queryKey: ["team", company.id], staleTime: 5 * 60_000, queryFn: () => api.get<Array<{ user_id: string; role: string; active: boolean; profile: { full_name: string } | null }>>("/team") });
  const reviewers = (team.data ?? []).filter((m) => m.active && ["owner", "admin", "office"].includes(m.role));
  const audienceRoles = draft.audience_roles.filter((id) => !roles.data || roles.data.some((r) => r.id === id));
  // The link box finds the other guides by title, tag or category.
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
      const known = pageId ? { id: pageId, updated_at: loadedAt! } : created.current;
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

  const submit = (ev: FormEvent) => {
    ev.preventDefault();
    setTouched(true);
    save.mutate();
  };

  return (
    <form className="stack" style={{ gap: 20 }} onSubmit={submit}>
      <BackLink to={pageId ? `/kb/${pageId}` : "/kb"}>{pageId ? "Back to guide" : "Knowledge base"}</BackLink>
      <div className="page-header">
        <h1 className="page-title">
          <input
            ref={titleRef}
            className="title-input"
            value={draft.title}
            onChange={(ev) => { set("title", ev.target.value); save.reset(); }}
            placeholder={`Guide title, ${titleHint ?? "e.g. Sealcoat application"}`}
            maxLength={200}
            aria-label="Title"
            aria-invalid={touched && !draft.title.trim()}
            autoFocus={!pageId}
          />
        </h1>
        <div className="page-actions">
          {uploading ? <span className="muted small">Adding pictures…</span> : dirty && <span className="muted small">Unsaved changes</span>}
          <Button variant="ghost" onClick={() => navigate(pageId ? `/kb/${pageId}` : "/kb")}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!dirty && Boolean(pageId)}>{pageId ? "Save" : draft.status === "draft" ? "Save draft" : "Publish"}</Button>
        </div>
      </div>
      <FormError error={save.error} />
      <div className="two-col">
        <div className="wide stack">
          <RichTextEditor
            initialHtml={initial.html}
            label="Guide content"
            placeholder="Write the steps. Tip: type “# ” for a heading, “1. ” for numbered steps, “- ” for a list, “[] ” for a checklist. Paste or drop in a picture to add it."
            minHeight={420}
            findLinks={findLinks}
            pictures={pictures}
            onBusy={setUploading}
            onChange={(html, plain) => {
              text.current = plain;
              set("html", html);
            }}
          />
          <QuizEditor value={draft.quiz} onChange={(quiz) => { set("quiz", quiz); save.reset(); }} />
        </div>
        <aside className="narrow card card-pad stack" style={{ gap: 16 }}>
          <CoverField
            path={draft.cover_path}
            preview={cover?.url ?? null}
            onChange={(picked) => {
              setCover(picked);
              if (!picked) set("cover_path", null);
            }}
          />
          <Field label="Category">
            <select className="select" value={draft.category_id} onChange={(ev) => set("category_id", ev.target.value)}>
              <option value="">Uncategorized</option>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
          <Field label="Visibility">
            <div className="segmented" role="group" aria-label="Visibility" style={{ width: "100%" }}>
              <button type="button" style={{ flex: 1 }} aria-pressed={draft.status === "published"} onClick={() => set("status", "published")}>Published</button>
              <button type="button" style={{ flex: 1 }} aria-pressed={draft.status === "draft"} onClick={() => set("status", "draft")}>Draft</button>
            </div>
          </Field>
          <label className="switch-row" style={{ alignItems: "flex-start" }}>
            <input type="checkbox" className="switch" checked={draft.required} onChange={(ev) => set("required", ev.target.checked)} />
            <strong>Required reading</strong>
          </label>
          {draft.required && (
            <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
              <legend style={{ marginBottom: 6 }}>Who has to read it</legend>
              {(roles.data?.length ?? 0) > 0 && (
                <>
                  <span className="muted small audience-label">Team roles</span>
                  <div className="row wrap" role="group" aria-label="Team roles" style={{ gap: 6, marginBottom: 10 }}>
                    {roles.data!.map((r) => <button key={r.id} type="button" className="tab" aria-pressed={audienceRoles.includes(r.id)} onClick={() => toggle("audience_roles", r.id)}>{r.name}</button>)}
                  </div>
                  <span className="muted small audience-label">Access levels</span>
                </>
              )}
              <div className="row wrap" role="group" aria-label="Access levels" style={{ gap: 6 }}>
                {ROLES.map((r) => <button key={r} type="button" className="tab" aria-pressed={draft.audience.includes(r)} onClick={() => toggle("audience", r)}>{ROLE_LABELS[r]}</button>)}
              </div>
              <span className="hint">{draft.audience.length || audienceRoles.length ? "Anyone with one of these has to read it." : "None selected means everyone."}</span>
            </fieldset>
          )}
          <Field label="Tags">
            <TagInput value={draft.tags} onChange={(tags) => set("tags", tags)} placeholder="e.g. safety, asphalt" />
          </Field>
          <Field label="Review schedule" hint={draft.review_months ? "Due that long after it's last saved or marked reviewed. The reviewer gets a reminder." : "Put it on a schedule to get a reminder to check it's still right."}>
            <select className="select" value={draft.review_months} onChange={(ev) => set("review_months", ev.target.value)}>
              {REVIEW_EVERY.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </Field>
          {draft.review_months && (
            <Field label="Reviewed by">
              <select className="select" value={draft.owner_id} onChange={(ev) => set("owner_id", ev.target.value)}>
                <option value="">Anyone who edits guides</option>
                {reviewers.map((m) => <option key={m.user_id} value={m.user_id}>{m.profile?.full_name ?? "Team member"}</option>)}
                {draft.owner_id && !reviewers.some((m) => m.user_id === draft.owner_id) && team.data && <option value={draft.owner_id}>Someone no longer on the team</option>}
              </select>
            </Field>
          )}
        </aside>
      </div>
    </form>
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
  return (
    <Field label="Cover photo" optional error={error} hint="Shows on the guide's card in the knowledge base and across the top of the guide.">
      {preview || path ? (
        <>
          <GuideCover path={path} src={preview} className="cover-preview" />
          <div className="row wrap" style={{ gap: 8 }}>
            <Button size="sm" icon="image" loading={opening} onClick={() => input.current?.click()}>Change photo</Button>
            <Button size="sm" variant="ghost" disabled={opening} onClick={() => { setError(null); onChange(null); }}>Remove</Button>
          </div>
        </>
      ) : (
        <button
          type="button"
          className="dropzone"
          data-over={over || undefined}
          disabled={opening}
          onClick={() => input.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setOver(true); }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => { e.preventDefault(); setOver(false); void pick(e.dataTransfer.files[0]); }}
        >
          <Icon name="image" size={20} />
          <span className="small strong">{opening ? "Opening the photo…" : "Add a cover photo"}</span>
        </button>
      )}
      <input ref={input} type="file" accept="image/*,.heic,.heif" hidden onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ""; void pick(file); }} />
    </Field>
  );
}
