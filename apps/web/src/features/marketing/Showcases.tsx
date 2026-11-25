/**
 * Marketing → Showcases: every job showcase, published first, with its link to copy or open, Post
 * to Facebook or Instagram (Marketing → Social's composer, with its photos and a caption carrying
 * the link), and Edit, Publish or Unpublish (ShowcaseDialog). Showcases are made from a finished
 * job's page, or a finished visit's (?job=…&visit=… opens a new one here).
 *
 * As inbox rows grouped by what needs a look (B-Inbox.dc.html): one that came down by itself first,
 * then the published ones, then drafts, then recent finished jobs with photos and no showcase yet,
 * each a click from being one. A row opens its showcase; its menu shares it.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Button, cx } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { DetailColumns } from "@/components/ui/DetailPage";
import { InboxGroup, InboxList, InboxRow, ListFoot } from "@/components/ui/InboxList";
import { Menu } from "@/components/ui/Menu";
import { InboxSkeleton } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState } from "@/components/ui/States";
import { api, supabase, unwrap } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { formatDate } from "@/lib/format";
import { useSession } from "@/lib/session";
import styles from "./Presence.module.css";
import { ShowcaseDialog, showcaseLink, socialPostPath } from "./ShowcaseDialog";
import { takenDownWords } from "./showcaseWords";
import { Thumb, useThumbs } from "./Thumbs";

type Open = { jobId: string; visitId?: string | null; showcaseId?: string | null };

/** How many recent finished jobs are looked at for photos, and how many of those are suggested. */
const READY_LOOKED_AT = 10;
const READY_SHOWN = 5;

export function Showcases() {
  const session = useSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [open, setOpen] = useState<Open | null>(null);
  // Opened from a finished visit: a new showcase of its job, its photos first.
  useEffect(() => {
    const job = params.get("job");
    if (!job) return;
    setOpen({ jobId: job, visitId: params.get("visit") });
    setParams({ tab: "showcases" }, { replace: true });
  }, [params, setParams]);

  const list = useQuery({
    queryKey: ["showcases", session.company.id],
    queryFn: async () =>
      unwrap(
        await supabase()
          .from("showcases")
          .select("id, job_id, visit_id, title, description, status, token, published_at, unpublished_reason, created_at, job:jobs(number, title), photos:showcase_photos(attachment_id, sort, use_marked)")
          .eq("company_id", session.company.id)
          .order("created_at", { ascending: false })
          .limit(200),
      ),
  });
  // Finished jobs with photos that could be shared, newest first, so making a showcase is a click from
  // here: the same photos the dialog offers (record_photos), for the few most recent jobs.
  const ready = useQuery({
    queryKey: ["showcase-ready", session.company.id],
    queryFn: async () => {
      const jobs = unwrap(
        await supabase()
          .from("jobs")
          .select("id, number, title, client:clients(display_name)")
          .eq("company_id", session.company.id)
          .in("status", ["requires_invoicing", "completed"])
          .order("updated_at", { ascending: false })
          .limit(READY_LOOKED_AT),
      );
      const counted = await Promise.all(
        jobs.map(async (j) => {
          const photos = ((unwrap(await supabase().rpc("record_photos", { p_company: session.company.id, p_job: j.id })) ?? []) as Array<{ id: string; can_share: boolean }>).filter((p) => p.can_share);
          return { ...j, photos: photos.length, first: photos[0]?.id ?? null };
        }),
      );
      return counted.filter((j) => j.photos > 0);
    },
  });
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["showcases", session.company.id] });
    void queryClient.invalidateQueries({ queryKey: ["showcase-ready", session.company.id] });
  };
  const unpublish = useMutation({ meta: { success: "Unpublished" }, mutationFn: (id: string) => api.post(`/showcases/${id}/unpublish`), onSuccess: refresh });
  const remove = useMutation({
    meta: { success: "Showcase deleted" },
    mutationFn: async (s: { id: string; status: string }) => {
      if (s.status === "published") await api.post(`/showcases/${s.id}/unpublish`);
      unwrap(await supabase().from("showcases").delete().eq("id", s.id));
    },
    onSuccess: refresh,
  });

  type Row = NonNullable<typeof list.data>[number];
  const rows = list.data ?? [];
  // What needs a look first: one that came down by itself, then the live ones, then the rest.
  const takenDown = rows.filter((s) => takenDownWords(s));
  const published = rows.filter((s) => s.status === "published");
  const drafts = rows.filter((s) => s.status !== "published" && !takenDownWords(s));
  const made = new Set(rows.map((s) => s.job_id));
  const suggestions = (ready.data ?? []).filter((j) => !made.has(j.id)).slice(0, READY_SHOWN);
  // Each row leads with its first photo, as a social post does.
  const firstPhoto = (s: Row) => [...(s.photos ?? [])].sort((a, b) => a.sort - b.sort)[0];
  const thumbs = useThumbs([
    ...rows.map((s) => ({ key: s.id, attachmentId: firstPhoto(s)?.attachment_id, marked: firstPhoto(s)?.use_marked })),
    ...suggestions.map((j) => ({ key: j.id, attachmentId: j.first })),
  ]).data ?? {};

  const row = (s: Row) => {
    const job = s.job as { number: number; title: string } | null;
    const photoIds = [...(s.photos ?? [])].sort((a, b) => a.sort - b.sort).map((p) => p.attachment_id);
    const live = s.status === "published";
    const down = takenDownWords(s);
    return (
      // The row opens the showcase in its dialog, not a page: the shared row's button form.
      <InboxRow
        key={s.id}
        className={styles.showcase}
        onClick={() => setOpen({ jobId: s.job_id, showcaseId: s.id })}
        title={s.title}
        avatar={<Thumb url={thumbs[s.id]} />}
        square
        // It came down by itself: why, in place of what it's about, as on the bell, so nobody wonders where the page went.
        subject={down ? <span className={styles.downLine}>{down}</span> : s.description.trim() || job?.title || "Job"}
        meta={[
          job && <span><Link className={styles.metaLink} to={`/jobs/${s.job_id}`}>Job #{job.number}</Link></span>,
          `${photoIds.length} ${photoIds.length === 1 ? "photo" : "photos"}`,
          live && s.published_at && `Published ${formatDate(s.published_at)}`,
          !live && !down && (s.status === "unpublished" ? "Unpublished" : "Draft"),
        ]}
        aside={
          <Menu
            triggerClassName={cx("btn btn-sm btn-ghost btn-icon", styles.asideMore)}
            label={`Actions for ${s.title}`}
            title={s.title}
            items={[
              { label: live ? "View" : "Edit", icon: live ? "eye" : "edit", kbd: "E", onSelect: () => setOpen({ jobId: s.job_id, showcaseId: s.id }) },
              { label: "Copy link", icon: "copy", kbd: "C", hidden: !live, onSelect: () => copyText(showcaseLink(s.token), "Link copied") },
              { label: "Open page", icon: "external", hidden: !live, onSelect: () => window.open(showcaseLink(s.token), "_blank", "noopener") },
              { label: "Post to Facebook or Instagram", icon: "share", hidden: !live || !photoIds.length, onSelect: () => navigate(socialPostPath(s, photoIds)) },
              { separator: true },
              { label: "Unpublish", icon: "x", hidden: !live, onSelect: () => unpublish.mutate(s.id) },
              { label: "Delete", icon: "trash", danger: true, onSelect: async () => (await confirm({ title: "Delete this showcase?", body: live ? "Its link stops working. The job's photos aren't touched." : "The job's photos aren't touched.", confirmLabel: "Delete", danger: true })) && remove.mutate(s) },
            ]}
          />
        }
      />
    );
  };

  const suggestion = (j: (typeof suggestions)[number]) => (
    <InboxRow
      key={j.id}
      className={styles.showcase}
      onClick={() => setOpen({ jobId: j.id })}
      title={j.title}
      avatar={<Thumb url={thumbs[j.id]} />}
      square
      subject={(j.client as { display_name: string } | null)?.display_name ?? "Job"}
      meta={[j.number != null && `Job #${j.number}`, `${j.photos} ${j.photos === 1 ? "photo" : "photos"}`]}
      aside={<Button size="sm" icon="image" onClick={() => setOpen({ jobId: j.id })}>Make a showcase</Button>}
    />
  );

  return (
    <div className={cx("m-grouped", styles.tab)}>
      <DetailColumns>
        <p className={styles.lede}>
          A finished job's before and after photos and a few lines about the work, on a page you can share. Make one from a finished job's page (its menu) or a finished visit. The client's name and address are never shown.
        </p>
        {list.isPending ? <InboxSkeleton rows={3} /> : list.error ? (
          <ErrorState error={list.error} onRetry={() => list.refetch()} />
        ) : !rows.length && !suggestions.length ? (
          <EmptyState icon="image" title="No showcases yet" action={<Link className="btn" to="/jobs">Go to jobs</Link>}>Finished jobs with photos show up here, ready to make into one.</EmptyState>
        ) : (
          <InboxList
            label="Showcases"
            inset
            foot={<ListFoot>Posting to Facebook or Instagram shares the photos as taken, without their drawings.</ListFoot>}
          >
            {takenDown.length > 0 && <InboxGroup label="Taken down" count={takenDown.length} tone="warning" icon="alert">{takenDown.map(row)}</InboxGroup>}
            {published.length > 0 && <InboxGroup label="Published" count={published.length}>{published.map(row)}</InboxGroup>}
            {drafts.length > 0 && <InboxGroup label="Drafts" count={drafts.length}>{drafts.map(row)}</InboxGroup>}
            {suggestions.length > 0 && <InboxGroup label="Ready to showcase" count={suggestions.length}>{suggestions.map(suggestion)}</InboxGroup>}
          </InboxList>
        )}
      </DetailColumns>
      {open && <ShowcaseDialog key={open.showcaseId ?? open.jobId} jobId={open.jobId} visitId={open.visitId} showcaseId={open.showcaseId} onClose={() => { setOpen(null); refresh(); }} />}
    </div>
  );
}
