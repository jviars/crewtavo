/** Write or edit an SOP (office and up). Every save is a new revision; nothing is lost. */
import { STAFF } from "@crewtavo/core/roles";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useBlocker, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { Field, FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { BackLink, useDocumentTitle } from "@/components/ui/PageHeader";
import { RichTextEditor } from "@/components/ui/RichTextEditor";
import { DetailSkeleton } from "@/components/ui/Skeleton";
import { EmptyState, PageError } from "@/components/ui/States";
import { TagInput } from "@/components/ui/TagInput";
import { ApiError, supabase, unwrap } from "@/lib/api";
import { coverPicture, uploadFile } from "@/lib/files";
import { hasContent, htmlToText } from "@/lib/html";
import { useSession } from "@/lib/session";
import { GuideCover } from "./GuideCover";
import { ROLE_LABELS, useCategories, useIsEditor } from "./kbData";

interface Draft { title: string; category_id: string; status: "draft" | "published"; required: boolean; audience: string[]; tags: string[]; html: string; cover_path: string | null }

// Required reading is for the team below admin; a sub never reads guides.
const ROLES = STAFF.filter((r) => r !== "owner" && r !== "admin");

export function SopEditorPage() {
  const { pageId } = useParams();
  const [params] = useSearchParams();
  const { company } = useSession();
  const editor = useIsEditor();
  const categories = useCategories();
  const existing = useQuery({
    queryKey: ["kb", company.id, "edit", pageId],
    enabled: Boolean(pageId),
    gcTime: 0,
    queryFn: async () => unwrap(await supabase().from("sop_pages").select("id, title, category_id, status, required, audience, tags, body_html, cover_path, updated_at, revision").eq("id", pageId!).maybeSingle()),
  });
  useDocumentTitle(pageId ? "Edit guide" : "New guide");

  if (!editor) return <><BackLink to="/kb">Knowledge base</BackLink><div className="card"><EmptyState icon="lock" title="You don't have permission to edit this" /></div></>;
  if (pageId && existing.isPending) return <DetailSkeleton />;
  if (pageId && (existing.error || !existing.data)) return <PageError error={existing.error ?? new ApiError("This guide doesn't exist, or it was deleted.", 404)} onRetry={existing.error ? () => existing.refetch() : undefined} back={<BackLink to="/kb">Knowledge base</BackLink>} />;
  const e = existing.data;
  const initial: Draft = e
    ? { title: e.title, category_id: e.category_id ?? "", status: e.status as Draft["status"], required: e.required, audience: (e.audience as string[] | null) ?? [], tags: e.tags, html: e.body_html, cover_path: e.cover_path }
    : { title: "", category_id: params.get("category") ?? "", status: "published", required: false, audience: [], tags: [], html: "", cover_path: null };
  return <Editor key={pageId ?? "new"} pageId={pageId ?? null} initial={initial} loadedAt={e?.updated_at ?? null} categories={categories.data ?? []} />;
}

function Editor({ pageId, initial, loadedAt, categories }: { pageId: string | null; initial: Draft; loadedAt: string | null; categories: Array<{ id: string; name: string }> }) {
  const { company } = useSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(initial);
  const [saved, setSaved] = useState(JSON.stringify(initial));
  const [touched, setTouched] = useState(false);
  const text = useRef(htmlToText(initial.html));
  const titleRef = useRef<HTMLInputElement>(null);
  // A cover photo picked here is only uploaded when the guide is saved.
  const [cover, setCover] = useState<{ file: File; url: string } | null>(null);
  useEffect(() => () => { if (cover) URL.revokeObjectURL(cover.url); }, [cover]);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));

  const save = useMutation({
    meta: { inline: true, success: () => (pageId ? "Guide saved" : draft.status === "draft" ? "Draft saved" : "Guide published") },
    mutationFn: async () => {
      const title = draft.title.trim();
      if (!title) {
        titleRef.current?.focus();
        throw new Error("Give the guide a title.");
      }
      if (draft.required && draft.status === "published" && !hasContent(draft.html)) throw new Error("Add some content before making this required reading.");
      const uploaded = cover ? await uploadFile(company.id, "kb", cover.file) : null;
      const cover_path = uploaded ?? draft.cover_path;
      const row = {
        title,
        category_id: draft.category_id || null,
        status: draft.status,
        required: draft.required,
        audience: draft.required && draft.audience.length ? (draft.audience as never) : null,
        tags: draft.tags,
        body: { type: "html", html: draft.html },
        body_html: draft.html,
        body_text: text.current,
        cover_path,
      };
      try {
        if (pageId) {
          // Don't overwrite someone else's save made while this was open.
          const rows = unwrap(await supabase().from("sop_pages").update(row).eq("id", pageId).eq("updated_at", loadedAt!).select("id, updated_at"));
          if (!rows.length) throw new Error("Someone else saved this guide while you were editing. Copy your changes, reload the page, and apply them again.");
        }
        const id = pageId ?? unwrap(await supabase().from("sop_pages").insert({ ...row, company_id: company.id }).select("id").single()).id;
        // The cover it had isn't kept in its revisions, so it can go.
        if (initial.cover_path && initial.cover_path !== cover_path) void supabase().storage.from("files").remove([initial.cover_path]);
        return { id };
      } catch (error) {
        if (uploaded) void supabase().storage.from("files").remove([uploaded]);
        throw error;
      }
    },
    onSuccess: (r) => {
      setSaved(JSON.stringify(draft));
      queryClient.invalidateQueries({ queryKey: ["kb", company.id] });
      // Navigate after the "saved" state renders so the unsaved-changes guard doesn't fire.
      setTimeout(() => navigate(`/kb/${r.id}`, { replace: !pageId }), 0);
    },
  });

  const dirty = JSON.stringify(draft) !== saved || (cover !== null && !save.isSuccess);
  const blocker = useBlocker(({ currentLocation, nextLocation }) => dirty && !save.isSuccess && currentLocation.pathname !== nextLocation.pathname);
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
            placeholder="Guide title, e.g. Sealcoat application"
            maxLength={200}
            aria-label="Title"
            aria-invalid={touched && !draft.title.trim()}
            autoFocus={!pageId}
          />
        </h1>
        <div className="page-actions">
          {dirty && <span className="muted small">Unsaved changes</span>}
          <Button variant="ghost" onClick={() => navigate(pageId ? `/kb/${pageId}` : "/kb")}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!dirty && Boolean(pageId)}>{pageId ? "Save" : draft.status === "draft" ? "Save draft" : "Publish"}</Button>
        </div>
      </div>
      <FormError error={save.error} />
      <div className="two-col">
        <div className="wide">
          <RichTextEditor
            initialHtml={initial.html}
            label="Guide content"
            placeholder="Write the steps. Tip: type “# ” for a heading, “1. ” for numbered steps, “- ” for a list, “[] ” for a checklist."
            minHeight={420}
            onChange={(html, plain) => {
              text.current = plain;
              set("html", html);
            }}
          />
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
              <div className="row wrap" style={{ gap: 6 }}>
                {ROLES.map((r) => {
                  const on = draft.audience.includes(r);
                  return <button key={r} type="button" className="tab" aria-pressed={on} onClick={() => set("audience", on ? draft.audience.filter((x) => x !== r) : [...draft.audience, r])}>{ROLE_LABELS[r]}</button>;
                })}
              </div>
              {!draft.audience.length && <span className="hint">None selected means everyone.</span>}
            </fieldset>
          )}
          <Field label="Tags">
            <TagInput value={draft.tags} onChange={(tags) => set("tags", tags)} placeholder="e.g. safety, asphalt" />
          </Field>
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
