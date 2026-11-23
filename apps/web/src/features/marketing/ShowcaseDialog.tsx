/**
 * Make a showcase (a finished job's or visit's page of before and after photos and a write-up, with
 * a link anyone can open: routes/showcases.ts), or change one. Pick the job's photos (their
 * drawn-on copies, where there are any, unless the original is picked), mark each before or after,
 * write a title and a few lines (with Claude, when the company's AI is set up) and choose whether
 * the town is shown. The client's name and address never are. Publishing asks first about photos
 * nobody marked OK to share, and can't go ahead for a client who asked that photos of their
 * property not be posted. A published showcase is unpublished to change it.
 */
import { CLIENT_OPT_OUT } from "@crewtavo/core/social";
import { MAX_SHOWCASE_PHOTOS, ROLE_LABELS, SHOWCASE_ROLES, showcaseCaption, showcaseProblem, unsharedQuestion, type ShowcaseRole } from "@crewtavo/core/showcases";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button, cx } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { Dialog } from "@/components/ui/Dialog";
import { Field, FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { Skeleton } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState } from "@/components/ui/States";
import { api, supabase, unwrap } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { formatDate } from "@/lib/format";
import { photoLinks } from "@/lib/photoMarkup";
import { useSession } from "@/lib/session";
import { UsingChatGptPlan } from "@/features/apps/UsingChatGptPlan";
import styles from "./Presence.module.css";
import { Select } from "@/components/ui/Select";

interface Pick {
  attachment_id: string;
  role: ShowcaseRole;
  use_marked: boolean;
}

interface JobPhoto {
  id: string;
  path: string;
  marked_path: string | null;
  content_type: string | null;
  created_at: string;
  shareable: boolean;
  visit_id: string | null;
  visit_on: string | null;
  can_share: boolean;
  cant_share: string | null;
  url: string | null;
  originalUrl: string | null;
}

/** The showcase's public page. */
export const showcaseLink = (token: string) => `${window.location.origin}/s/${token}`;

/** Marketing → Social's composer with the showcase's photos and a caption with its link. */
export const socialPostPath = (s: { title: string; description: string; token: string }, photoIds: readonly string[]) =>
  `/marketing?tab=social&compose=photos&photos=${photoIds.join(",")}&caption=${encodeURIComponent(showcaseCaption(s.title, s.description, showcaseLink(s.token)))}`;

export function ShowcaseDialog({ jobId, visitId = null, showcaseId = null, onClose }: { jobId: string; visitId?: string | null; showcaseId?: string | null; onClose: () => void }) {
  const session = useSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [id, setId] = useState<string | null>(showcaseId);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [showTown, setShowTown] = useState(false);
  const [picks, setPicks] = useState<Pick[]>([]);
  const [onlyVisit, setOnlyVisit] = useState(Boolean(visitId));
  const [loaded, setLoaded] = useState(!showcaseId);
  // The title and write-up on screen came from "Write it with AI": said under them until the dialog closes.
  const [aiWrote, setAiWrote] = useState(false);

  // The showcase as kept: one being changed, or the one this made once it's saved.
  const existing = useQuery({
    queryKey: ["showcase", id],
    enabled: Boolean(id),
    queryFn: async () => {
      const row = unwrap(await supabase().from("showcases").select("id, title, description, show_town, status, token, visit_id").eq("id", id!).single());
      const photos = unwrap(await supabase().from("showcase_photos").select("attachment_id, role, use_marked").eq("showcase_id", id!).order("sort").order("id"));
      return { ...row, photos };
    },
  });
  useEffect(() => {
    if (!existing.data || loaded) return;
    setTitle(existing.data.title);
    setDescription(existing.data.description);
    setShowTown(existing.data.show_town);
    setPicks(existing.data.photos.map((p) => ({ attachment_id: p.attachment_id, role: p.role as ShowcaseRole, use_marked: p.use_marked })));
    setOnlyVisit(false);
    setLoaded(true);
  }, [existing.data, loaded]);

  const job = useQuery({
    queryKey: ["showcase-job", jobId],
    queryFn: async () => unwrap(await supabase().from("jobs").select("title, property:properties(city, region)").eq("id", jobId).single()),
  });
  const photos = useQuery({
    queryKey: ["record-photos", session.company.id, jobId, "showcase"],
    queryFn: async () => photoLinks((unwrap(await supabase().rpc("record_photos", { p_company: session.company.id, p_job: jobId })) ?? []) as unknown as JobPhoto[]),
  });

  const status = existing.data?.status ?? "draft";
  const published = status === "published";
  const town = (job.data?.property as { city?: string | null; region?: string | null } | null)?.city ?? null;
  const shown = (photos.data ?? []).filter((p) => !onlyVisit || p.visit_id === visitId);
  const opted = (photos.data ?? []).some((p) => p.cant_share === "client_opt_out");
  const problem = showcaseProblem({ title, description, photos: picks.length });
  const pickOf = (photoId: string) => picks.find((p) => p.attachment_id === photoId);
  const toggle = (photo: JobPhoto) =>
    setPicks((list) => (list.some((p) => p.attachment_id === photo.id) ? list.filter((p) => p.attachment_id !== photo.id) : [...list, { attachment_id: photo.id, role: list.length === 0 ? "before" : "after", use_marked: true }]));
  const setPick = (photoId: string, patch: Partial<Pick>) => setPicks((list) => list.map((p) => (p.attachment_id === photoId ? { ...p, ...patch } : p)));

  const refresh = () => {
    for (const key of [["showcases", session.company.id], ["showcase"]]) void queryClient.invalidateQueries({ queryKey: key });
  };

  // Kept as written, then its photos as picked, in order.
  const save = useMutation({
    meta: { inline: true },
    mutationFn: async () => {
      const row = { title: title.trim(), description: description.trim(), show_town: showTown };
      let showcase = id;
      if (!showcase) {
        showcase = unwrap(await supabase().from("showcases").insert({ ...row, company_id: session.company.id, job_id: jobId, visit_id: visitId }).select("id").single()).id;
        setId(showcase);
      } else {
        unwrap(await supabase().from("showcases").update(row).eq("id", showcase));
      }
      const keep = picks.map((p) => p.attachment_id);
      const gone = supabase().from("showcase_photos").delete().eq("showcase_id", showcase);
      unwrap(await (keep.length ? gone.not("attachment_id", "in", `(${keep.join(",")})`) : gone));
      if (picks.length) {
        unwrap(
          await supabase()
            .from("showcase_photos")
            .upsert(picks.map((p, sort) => ({ company_id: session.company.id, showcase_id: showcase!, attachment_id: p.attachment_id, role: p.role, use_marked: p.use_marked, sort })), { onConflict: "showcase_id,attachment_id" }),
        );
      }
      return showcase;
    },
    onSuccess: refresh,
  });
  const publish = useMutation({
    meta: { inline: true, success: "Showcase published. Its link is ready to share." },
    mutationFn: async () => {
      const unshared = picks.filter((p) => !(photos.data ?? []).find((x) => x.id === p.attachment_id)?.shareable).length;
      if (unshared && !(await confirm({ title: "Show photos not marked OK to share?", body: `${unsharedQuestion(unshared, picks.length)} Publishing marks them OK to share, as you.`, confirmLabel: "Publish anyway" }))) return null;
      const showcase = await save.mutateAsync();
      return api.post<{ url: string }>(`/showcases/${showcase}/publish`, { confirm_unshared: unshared > 0 });
    },
    onSuccess: refresh,
  });
  const unpublish = useMutation({
    meta: { inline: true, success: "Unpublished. The link says it isn't available now." },
    mutationFn: () => api.post(`/showcases/${id}/unpublish`),
    onSuccess: refresh,
  });
  const draft = useMutation({
    meta: { inline: true },
    mutationFn: () => api.post<{ title: string; description: string }>("/showcases/draft", { job_id: jobId }),
    onSuccess: (d) => {
      setTitle(d.title);
      setDescription(d.description);
      setAiWrote(true);
    },
  });

  const token = existing.data?.token;
  return (
    <Dialog open onClose={onClose} title={showcaseId ? "Showcase" : "Make a showcase"} description={job.data ? job.data.title : undefined} size="lg">
      {(showcaseId && !loaded) || photos.isPending ? (
        <div className="stack"><Skeleton height={28} /><div className="thumbs">{[0, 1, 2, 3].map((i) => <Skeleton key={i} height={96} radius={8} />)}</div></div>
      ) : photos.error || existing.error ? (
        <ErrorState compact error={photos.error ?? existing.error} onRetry={() => { void photos.refetch(); void existing.refetch(); }} />
      ) : (
        <form className="stack" onSubmit={(e) => { e.preventDefault(); if (!problem) publish.mutate(); }}>
          {published && token && (
            <div className="callout callout-good">
              <Icon name="globe" size={16} />
              <div className="grow stack-sm">
                <strong>Published</strong>
                <span className={styles.linkText}>{showcaseLink(token)}</span>
                <div className={styles.inline}>
                  <Button size="sm" icon="copy" onClick={() => copyText(showcaseLink(token), "Link copied")}>Copy link</Button>
                  <a className="btn btn-sm" href={showcaseLink(token)} target="_blank" rel="noreferrer"><Icon name="external" size={14} />Open</a>
                  <Button size="sm" icon="share" onClick={() => navigate(socialPostPath({ title, description, token }, picks.map((p) => p.attachment_id)))}>Post to Facebook or Instagram</Button>
                </div>
                <span className={styles.fine}>Unpublish it to change what it shows.</span>
              </div>
            </div>
          )}
          {opted && <div className="callout callout-warning"><Icon name="alert" size={16} /><div className="grow">{CLIENT_OPT_OUT} Their photos can't go on a showcase.</div></div>}

          <section className={styles.dialogPart} aria-labelledby="showcase-photos">
            <div className={styles.dialogHead}>
              <h3 id="showcase-photos" className={styles.dialogLabel}>Photos{picks.length > 0 && <span className={styles.dialogCount}>{picks.length} picked</span>}</h3>
              {visitId && <label className="checkbox"><input type="checkbox" checked={!onlyVisit} onChange={(e) => setOnlyVisit(!e.target.checked)} />Show all of the job's photos</label>}
            </div>
            {!shown.length ? (
              <EmptyState inline icon="image" title="No photos yet">{onlyVisit ? "This visit has no photos. Show all of the job's photos, or add some first." : "Add photos to the job or its visits first."}</EmptyState>
            ) : (
              <div className="thumbs" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(130px, 1fr))" }}>
                {shown.map((p) => {
                  const pick = pickOf(p.id);
                  const blocked = p.cant_share === "client_opt_out" || p.cant_share === "format";
                  return (
                    <div key={p.id} className={styles.thumbCell}>
                      <div className="thumb">
                        {p.url ? <img src={(pick && !pick.use_marked ? p.originalUrl : p.url) ?? ""} alt="" loading="lazy" /> : <Skeleton height={130} radius={8} />}
                        <button type="button" className="thumb-pick" aria-pressed={Boolean(pick)} disabled={published || blocked || (!pick && picks.length >= MAX_SHOWCASE_PHOTOS)} aria-label={`Photo from ${formatDate(p.visit_on ?? p.created_at)}`} onClick={() => toggle(p)}>
                          <span className="thumb-pick-badge"><Icon name="check" size={13} bold /></span>
                        </button>
                      </div>
                      {pick ? (
                        <>
                          <Select className={cx("select", styles.roleSelect)} value={pick.role} disabled={published} onChange={(e) => setPick(p.id, { role: e.target.value as ShowcaseRole })} aria-label="Before or after">
                            {SHOWCASE_ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
                          </Select>
                          {p.marked_path && <label className={cx("checkbox", styles.thumbCheck)}><input type="checkbox" checked={pick.use_marked} disabled={published} onChange={(e) => setPick(p.id, { use_marked: e.target.checked })} />Drawn-on copy</label>}
                        </>
                      ) : (
                        <span className={styles.thumbNote}>{p.cant_share === "format" ? "Not a JPEG or PNG" : p.shareable ? "OK to share" : p.marked_path ? "Drawn on" : " "}</span>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          <Field label="Title">
            <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} disabled={published} placeholder="Driveway resealed and restriped" />
          </Field>
          <Field label="What you did" optional hint="Two or three lines: the problem, the work and how it turned out. Leave out the client's name and street.">
            <textarea className="textarea" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} disabled={published} style={{ minHeight: 110 }} />
          </Field>
          {session.config.features.ai && !published && (
            <div className="stack-sm">
              <div><Button size="sm" variant="ghost" icon="sparkle" loading={draft.isPending} onClick={() => draft.mutate()}>Write it with AI</Button><FormError error={draft.error} /></div>
              <UsingChatGptPlan />
              {/* The words above came from AI: said to whoever publishes them. */}
              {aiWrote && <span className="muted small" role="status">Written by AI from the job's services. It can be wrong: check it says what you did before you publish.</span>}
            </div>
          )}
          <label className="checkbox">
            <input type="checkbox" checked={showTown} disabled={published || !town} onChange={(e) => setShowTown(e.target.checked)} />
            <span>Show the town{town ? ` (${town})` : ""}<span className={styles.checkNote}>{town ? "Never the street or the client's name." : "The job has no property with a town."}</span></span>
          </label>

          <FormError error={save.error ?? publish.error ?? unpublish.error} />
          <div className="form-actions">
            <Button onClick={onClose}>Close</Button>
            {published ? (
              <Button variant="danger" loading={unpublish.isPending} onClick={() => unpublish.mutate()}>Unpublish</Button>
            ) : (
              <>
                <Button loading={save.isPending && !publish.isPending} disabled={!title.trim()} onClick={() => save.mutate(undefined, { onSuccess: () => onClose() })}>Save draft</Button>
                <Button type="submit" variant="primary" icon="globe" loading={publish.isPending} disabled={Boolean(problem)} title={problem ?? undefined}>{status === "unpublished" ? "Publish again" : "Publish"}</Button>
              </>
            )}
          </div>
        </form>
      )}
    </Dialog>
  );
}
