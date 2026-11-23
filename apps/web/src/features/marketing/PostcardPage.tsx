/**
 * A postcard campaign (Marketing → Campaigns → Postcards): its size, the picture on the front (a
 * company photo, its drawn-on copy where there is one, or one uploaded), the message on the back
 * with the campaign merge fields, and the segment it goes to, with how many get a card and who's
 * left out and why. Both sides are previewed at their real size, as Lob prints them (the same HTML
 * the server sends: packages/core/src/postcards.ts). Send mails one card per client through the
 * company's Lob account; a live key's Send names the number of cards and has it typed to confirm.
 * After sending: what was made, what failed and why, and what the clients mailed have paid since.
 */
import { audienceKeys, type CampaignAudience } from "@crewtavo/core/campaigns";
import { addressLine, backFit, backHtml, BLEED_IN, frontHtml, frontResolutionWarning, leftOutLine, messageProblem, ONE_PER_ADDRESS, POSTCARD_KEEP_DAYS, POSTCARD_SIZE_INFO, POSTCARD_SIZES, POSTCARD_TOKENS, postcardMessage, type LeftOut, type PostcardSize } from "@crewtavo/core/postcards";
import { greetingName } from "@crewtavo/core/automations";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useDeferredValue, useEffect, useRef, useState, type ChangeEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { featureOn } from "@/components/shell/nav";
import { Button } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { Dialog } from "@/components/ui/Dialog";
import { FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { DetailColumns, DetailHeader } from "@/components/ui/DetailPage";
import { ListFoot } from "@/components/ui/InboxList";
import { BackLink } from "@/components/ui/PageHeader";
import { SaveStatus, useSaveStatus } from "@/components/ui/SaveStatus";
import { Section } from "@/components/ui/Section";
import { DetailSkeleton, SectionSkeleton, Skeleton, StatsSkeleton } from "@/components/ui/Skeleton";
import { Stat, StatStrip } from "@/components/ui/StatStrip";
import { FilterTabs } from "@/components/ui/Toolbar";
import { EmptyState, ErrorState, NoAccess, PageError } from "@/components/ui/States";
import { EntityStatus } from "@/components/ui/StatusPill";
import { api, supabase, unwrap, unwrapOne } from "@/lib/api";
import { compressImage, signedUrls, storedExtension, uploadBody } from "@/lib/files";
import { formatDate, formatMoneyCents } from "@/lib/format";
import { photoLinks } from "@/lib/photoMarkup";
import { can, hasRole, useSession } from "@/lib/session";
import { AudienceFields, useAudienceChoices } from "./AudienceFields";
import { audienceSummary } from "./CampaignPage";
import { MessageField } from "./EmailEditor";
import styles from "./Marketing.module.css";
import { NameInput } from "./NameInput";
import { MarketingPage } from "./MarketingPage";
import { PostcardAudienceDialog } from "./PostcardAudience";
import { ASK_ADMIN_WORDS, blockStyle, deletableFrom, draftAsSaved, duplicateQuestion, needsAdmin, pickablePhotos, proofLink, proofQuestion, waitForSave } from "./postcardForm";
import { PostcardProofs } from "./PostcardProofs";
import { LobMode } from "../apps/LobPanel";

interface Draft {
  name: string;
  size: PostcardSize;
  message: string;
  audience: CampaignAudience;
  front_attachment_id: string | null;
  front_marked: boolean;
  front_path: string | null;
}

interface Setup {
  /** `mode` is the key's own kind, read from the key; `problem` when Apps says it's the other kind. */
  lob: { mode: "test" | "live"; problem?: string | null } | null;
  public_address: boolean;
  return_address: string | null;
  /** What Lob would refuse about the company's address, or null. */
  return_address_problem?: string | null;
  /** What {{link}} prints. */
  link: string;
  can_connect: boolean;
  /** Whether this person may send with a live key: owners and admins. Missing from a server before this was asked. */
  can_send_live?: boolean;
}

interface Summary {
  count: number;
  left_out: Record<LeftOut, number>;
  sample: Array<{ client_id: string; name: string; city: string | null; region: string | null }>;
}

const FIELDS = "id, name, size, message, audience, front_attachment_id, front_marked, front_path, status, mode, started_at, finished_at, stopped_reason, recipients_count, made_count, failed_count, created_at";

/** "Lob charges per card; see your Lob account": Lob's API doesn't say what a card costs. */
export const PRICE_WORDS = "Lob charges per card; see your Lob account.";

export function PostcardPage() {
  const session = useSession();
  if (!hasRole(session, "admin", "office") || !can(session, "marketing")) return <NoAccess title="Postcard" />;
  if (!featureOn(session.company.settings, "marketing")) return <MarketingPage />;
  return <PostcardScreen />;
}

function PostcardScreen() {
  const { id = "" } = useParams();
  const session = useSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [picking, setPicking] = useState(false);
  const [listing, setListing] = useState(false);

  const campaign = useQuery({
    queryKey: ["postcard", id],
    refetchInterval: (q) => ((q.state.data as { status?: string } | undefined)?.status === "sending" ? 3000 : false),
    queryFn: async () => unwrapOne(await supabase().from("postcard_campaigns").select(FIELDS).eq("id", id).maybeSingle(), "This postcard campaign"),
  });
  const c = campaign.data;
  const editable = c?.status === "draft";
  useEffect(() => {
    if (c && !draft) {
      setDraft({ name: c.name, size: c.size as PostcardSize, message: c.message, audience: (c.audience ?? {}) as CampaignAudience, front_attachment_id: c.front_attachment_id, front_marked: c.front_marked, front_path: c.front_path });
    }
  }, [c, draft]);
  const setup = useQuery({ queryKey: ["postcard-setup", session.company.id], queryFn: () => api.get<Setup>("/postcards/setup") });
  const choices = useAudienceChoices(Boolean(c));
  const audience = useDeferredValue(draft?.audience);
  const summary = useQuery({
    queryKey: ["postcard-audience", session.company.id, JSON.stringify(audience)],
    enabled: Boolean(audience) && editable,
    meta: { silent: true },
    queryFn: async () => unwrap(await supabase().rpc("postcard_audience_summary", { p_company: session.company.id, p_audience: audienceKeys(audience) as never })) as unknown as Summary,
  });

  // Autosave, as an email campaign's draft does.
  const saving = useSaveStatus();
  const save = useMutation({
    meta: { inline: true },
    mutationFn: async (d: Draft) => {
      const row = { name: d.name.trim() || "Untitled postcard", size: d.size, message: d.message, audience: audienceKeys(d.audience) as never, front_attachment_id: d.front_attachment_id, front_marked: d.front_marked, front_path: d.front_path };
      unwrap(await supabase().from("postcard_campaigns").update(row).eq("id", id));
      return d;
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["postcard-campaigns", session.company.id] }),
  });
  const savedRef = useRef("");
  useEffect(() => {
    if (!draft || !editable) return;
    const json = JSON.stringify(draft);
    if (!savedRef.current) {
      savedRef.current = json;
      return;
    }
    if (json === savedRef.current) return;
    saving.edited();
    const t = setTimeout(() => {
      savedRef.current = json;
      void saving.track(save.mutateAsync(draft));
    }, 700);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, editable]);

  const shown: Draft | null = draft && c ? (editable ? draft : { ...draft, name: c.name, size: c.size as PostcardSize, message: c.message, audience: (c.audience ?? {}) as CampaignAudience, front_attachment_id: c.front_attachment_id, front_marked: c.front_marked, front_path: c.front_path }) : null;
  const front = useFrontUrl(shown);
  // The picture's own size in pixels, to say when it's below what Lob asks for at the size chosen.
  const frontSize = useQuery({ queryKey: ["postcard-front-size", front.data?.url], enabled: Boolean(front.data?.url), staleTime: Infinity, meta: { silent: true }, queryFn: () => pictureSize(front.data!.url!) });

  const refresh = async () => {
    await campaign.refetch();
    setDraft(null);
    savedRef.current = "";
    void queryClient.invalidateQueries({ queryKey: ["postcard-campaigns", session.company.id] });
  };
  const send = useMutation({
    meta: { success: (r: { recipients: number; mode: string }) => (r.mode === "live" ? `Mailing ${r.recipients.toLocaleString("en-US")} postcards` : `Making ${r.recipients.toLocaleString("en-US")} test postcards`) },
    // `mode` is the kind of key this page said it is: the server sends nothing if the key on file is the other kind.
    // `draft` is the card as this page shows it: the server sends nothing if that isn't what's saved.
    mutationFn: (sent: { count: number; mode: "test" | "live"; draft: ReturnType<typeof draftAsSaved> }) => api.post<{ recipients: number; mode: string }>(`/postcards/${id}/send`, { confirm: sent.count, mode: sent.mode, draft: sent.draft }),
    onSuccess: refresh,
  });
  // One card of the draft to the company's own address, before the campaign goes out.
  const proof = useMutation({
    meta: { success: (r: { mode: string; address: string }) => (r.mode === "live" ? `One card is on its way to ${r.address}` : "One test card made. Lob's picture of it is below.") },
    mutationFn: (sent: { mode: "test" | "live"; draft: ReturnType<typeof draftAsSaved> }) => api.post<{ mode: string; address: string }>(`/postcards/${id}/proof`, { confirm: 1, mode: sent.mode, draft: sent.draft }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["postcard-proofs", id] }),
  });
  const stop = useMutation({
    meta: { success: "Mailing stopped" },
    mutationFn: () => api.post(`/postcards/${id}/stop`),
    onSuccess: refresh,
  });
  const duplicate = useMutation({
    meta: { success: "Copied as a new draft" },
    mutationFn: async () =>
      unwrap(
        await supabase()
          .from("postcard_campaigns")
          .insert({ company_id: session.company.id, name: `${c!.name} (copy)`.slice(0, 120), size: c!.size, message: c!.message, audience: c!.audience, front_attachment_id: c!.front_attachment_id, front_marked: c!.front_marked, front_path: c!.front_path })
          .select("id")
          .single(),
      ),
    onSuccess: (row) => {
      setDraft(null);
      savedRef.current = "";
      navigate(`/marketing/postcards/${row.id}`);
    },
  });
  const remove = useMutation({
    meta: { success: "Postcard campaign deleted" },
    mutationFn: async () => unwrap(await supabase().from("postcard_campaigns").delete().eq("id", id)),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["postcard-campaigns", session.company.id] });
      navigate("/marketing?tab=campaigns", { replace: true });
    },
  });

  if (campaign.isPending || (c && !draft)) return <DetailSkeleton />;
  if (campaign.error || !c || !draft || !shown) return <PageError error={campaign.error} onRetry={() => campaign.refetch()} back={<BackLink to="/marketing?tab=campaigns">Marketing</BackLink>} />;

  const set = (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d));
  const s = setup.data;
  const count = summary.data?.count ?? 0;
  const sample = summary.data?.sample[0]?.name;
  // {{link}} as the server prints it: the booking form's address, else the website.
  const vars = {
    client: { first_name: sample ? greetingName(sample) : "Jordan", name: sample ?? "Jordan Rivera" },
    company: { name: session.company.name, phone: session.company.phone ?? "" },
    link: s?.link ?? "",
  };
  const message = postcardMessage(shown.message, vars);
  const fit = backFit(shown.size, message);
  const soft = frontSize.data && (draft.front_attachment_id || draft.front_path) ? frontResolutionWarning(shown.size, frontSize.data) : null;
  // Send mails what's saved: it waits for the save of what's on screen.
  const unsaved = waitForSave(saving.status);
  // What stands in the way of making any card at all, one to ourselves included.
  const cardProblems = [
    !s?.lob && "Lob isn't connected.",
    s?.lob?.problem,
    s && !s.public_address && "Crewtavo's address isn't public, so Lob can't fetch the front picture.",
    s && !s.return_address && (s.return_address_problem ?? "Add your company's full address in Settings → Company. Lob prints it on each card as the return address."),
    !draft.front_attachment_id && !draft.front_path && "Pick a picture for the front.",
    messageProblem(message, draft.size),
    editable && unsaved.problem,
  ].filter(Boolean) as string[];
  const problems = [...cardProblems, editable && summary.data && !count && "No one in this audience has a complete mailing address."].filter(Boolean) as string[];
  const mode = c.status === "draft" ? s?.lob?.mode : (c.mode as "test" | "live");
  // A live key spends the company's money: an owner or admin sends. The office gets the campaign ready.
  const askAdmin = needsAdmin(mode, s?.can_send_live);

  // A copy of a campaign that's been mailed goes to the same people again: said before it's made.
  const askToDuplicate = async () => {
    const question = duplicateQuestion({ status: c.status, mode: c.mode, made: c.made_count });
    if (!question || (await confirm({ title: question.title, body: question.body, confirmLabel: "Make the copy" }))) duplicate.mutate();
  };

  const askForProof = async () => {
    if (!mode) return;
    const question = proofQuestion(mode, s?.return_address ?? "your company's address");
    if (await confirm({ title: question.title, body: `${question.body}${mode === "live" ? ` ${PRICE_WORDS}` : ""}`, confirmLabel: question.confirmLabel })) proof.mutate({ mode, draft: draftAsSaved(draft) });
  };

  const askToSend = async () => {
    const n = count.toLocaleString("en-US");
    const cards = count === 1 ? "postcard" : "postcards";
    const ok = mode === "live"
      ? await confirm({
          title: `Mail ${n} ${cards}?`,
          body: <>Lob prints and mails {n} {cards} to the clients in this audience, and charges your Lob account for each one. {PRICE_WORDS} Cards Lob has made can't be called back from here.</>,
          confirmLabel: `Mail ${n} ${cards}`,
          typeToConfirm: String(count),
        })
      : await confirm({ title: `Make ${n} test ${cards}?`, body: "This is a test key: Lob makes each card so you can see it in your Lob dashboard, but nothing is printed or mailed, and nothing is charged.", confirmLabel: `Make ${n} test ${cards}` });
    if (ok && mode) send.mutate({ count, mode, draft: draftAsSaved(draft) });
  };

  const askToStop = async () => (await confirm({ title: "Stop mailing?", body: "Cards Lob has already made are still mailed. Lob can cancel them for a short while from your Lob dashboard.", confirmLabel: "Stop", danger: true })) && stop.mutate();
  const askToDelete = async () => {
    // Lob may still fetch the front's picture, which deleting the campaign takes down.
    const wait = deletableFrom(c);
    if (wait) return void (await confirm({ title: "This campaign can't be deleted yet", body: `Lob fetches the picture on the front from Crewtavo while it draws the cards, and deleting the campaign takes the picture down. It can be deleted from ${formatDate(wait.toISOString())}, ${POSTCARD_KEEP_DAYS} days after its last card.`, confirmLabel: "OK" }));
    if (await confirm({ title: "Delete this postcard campaign?", body: c.status === "draft" ? undefined : "Its list of who was mailed goes too. Cards already mailed aren't affected.", confirmLabel: "Delete", danger: true })) remove.mutate();
  };

  return (
    <>
      <DetailHeader
        crumb={{ to: "/marketing?tab=campaigns", label: "Marketing" }}
        title={editable ? <h1 className="page-title"><NameInput value={draft.name} onChange={(name) => set({ name })} label="Campaign name" /></h1> : c.name}
        documentTitle={c.name}
        status={<EntityStatus kind="campaign" status={c.status} />}
        meta={[
          `Postcard · ${POSTCARD_SIZE_INFO[shown.size].label}`,
          editable && <SaveStatus status={saving.status} />,
          c.status !== "draft" && `${c.made_count.toLocaleString("en-US")} of ${c.recipients_count.toLocaleString("en-US")} ${c.mode === "live" ? "mailed" : "made in test mode"}${c.failed_count ? ` · ${c.failed_count} failed` : ""}`,
        ]}
        actions={
          <>
            {editable && !askAdmin && <Button icon="mail" loading={proof.isPending} disabled={cardProblems.length > 0 || unsaved.blocked || !mode} onClick={askForProof}>{mode === "test" ? "Make one test card first" : "Mail one to us first"}</Button>}
            {editable && !askAdmin && <Button variant="primary" icon="send" loading={send.isPending} disabled={problems.length > 0 || summary.isFetching || !count || unsaved.blocked} onClick={askToSend}>{mode === "test" ? "Make test cards" : "Send"}</Button>}
            {c.status === "sending" && <Button variant="danger" icon="x" loading={stop.isPending} onClick={askToStop}>Stop</Button>}
          </>
        }
        moreTitle={c.name}
        more={[
          { label: c.status === "draft" ? "Duplicate" : "Duplicate (mails everyone again)", icon: "copy", kbd: "D", onSelect: askToDuplicate },
          { separator: true, hidden: c.status === "sending" },
          { label: "Delete", icon: "trash", danger: true, hidden: c.status === "sending", onSelect: askToDelete },
        ]}
      />
      {c.stopped_reason && c.stopped_reason !== "Stopped" && <div className="callout callout-warning"><Icon name="alert" size={16} /><div className="grow">{c.stopped_reason}</div></div>}
      {editable && askAdmin && <div className="callout callout-info" role="note"><Icon name="lock" size={16} /><div className="grow"><div>Ask an owner or admin to send it</div>{ASK_ADMIN_WORDS}</div></div>}
      {setup.error ? <ErrorState compact error={setup.error} onRetry={() => setup.refetch()} /> : s && !s.lob && editable ? (
        <div className="callout callout-info">
          <Icon name="info" size={16} />
          <div className="grow">Postcards are printed and mailed by Lob, through your own Lob account. {s.can_connect ? <Link to="/apps/lob">Connect Lob in Apps</Link> : "Ask an owner or admin to connect Lob in Apps."}</div>
        </div>
      ) : (
        <LobMode mode={mode} />
      )}
      {c.status === "sending" && <div className="progress"><span style={{ width: `${c.recipients_count ? ((c.made_count + c.failed_count) / c.recipients_count) * 100 : 0}%` }} /></div>}
      {c.status !== "draft" && <PostcardStats id={c.id} mode={c.mode as "test" | "live"} live={c.status === "sending"} />}

      <DetailColumns
        grouped
        side={
          <>
            <Section title="Audience" count={editable ? (summary.isFetching ? "…" : count.toLocaleString("en-US")) : undefined} flush={editable}>
              {editable ? (
                <div className="stack">
                  <AudienceFields audience={draft.audience} onChange={(a) => set({ audience: a })} choices={choices.data} statusHint="None selected means every status. Archived clients never get a card." />
                  <div className="stack-sm">
                    <p className={styles.count}><b>{count.toLocaleString("en-US")}</b> {count === 1 ? "client" : "clients"} will get a card.</p>
                    {summary.data && leftOutLine(summary.data.left_out) && <p className={styles.fine}>{leftOutLine(summary.data.left_out)}.</p>}
                    {Boolean(summary.data?.sample.length) && (
                      <ul className={styles.sample} aria-label="Who gets a card">
                        {summary.data!.sample.map((r) => <li key={r.client_id}><span>{r.name}</span><span>{[r.city, r.region].filter(Boolean).join(", ")}</span></li>)}
                      </ul>
                    )}
                    {count > 5 && <p className={styles.fine}>and {(count - 5).toLocaleString("en-US")} more</p>}
                    {summary.data && <div><Button size="sm" icon="users" onClick={() => setListing(true)}>See everyone and their addresses</Button></div>}
                    <p className={styles.fine}>Each card goes to the client's billing address, or their first property's when that one can't be mailed to. {ONE_PER_ADDRESS} {PRICE_WORDS}</p>
                  </div>
                </div>
              ) : (
                <p className={styles.audienceLine}>{audienceSummary(shown.audience, choices.data)}</p>
              )}
            </Section>
            {editable && problems.length > 0 && (
              <div className="callout callout-warning" role="note">
                <Icon name="alert" size={16} />
                <ul className={`grow ${styles.problems}`}>{problems.map((p) => <li key={p}>{p}</li>)}</ul>
              </div>
            )}
            <FormError error={send.error} />
            <FormError error={proof.error} />
          </>
        }
      >
        {editable ? (
          <Section title="The card" flush>
            <div className="stack">
              <div className="field">
                <span>Size</span>
                <div className="segmented" role="group" aria-label="Size">
                  {POSTCARD_SIZES.map((size) => <button key={size} type="button" aria-pressed={draft.size === size} onClick={() => set({ size })}>{POSTCARD_SIZE_INFO[size].label}</button>)}
                </div>
              </div>
              <div className="field">
                <span>Front</span>
                <div className={styles.frontPick}>
                  <Button icon="image" onClick={() => setPicking(true)}>Pick a job photo</Button>
                  <UploadFront campaignId={c.id} onUploaded={(path) => set({ front_path: path, front_attachment_id: null })} />
                </div>
                {front.data?.marked && draft.front_attachment_id && (
                  <label className="check-row small" style={{ marginTop: 6 }}>
                    <input type="checkbox" checked={!draft.front_marked} onChange={(e) => set({ front_marked: !e.target.checked })} />
                    Use the photo as taken, without the drawing
                  </label>
                )}
                <span className="hint">The picture fills the front, past the edges, so keep what matters away from them.</span>
                {soft && <div className="callout callout-warning" role="note" style={{ marginTop: 8 }}><Icon name="alert" size={16} /><div className="grow">{soft}</div></div>}
              </div>
              <MessageField value={draft.message} onChange={(m) => set({ message: m })} tokens={[...POSTCARD_TOKENS]} hint={`The back of the card. About ${POSTCARD_SIZE_INFO[draft.size].maxMessage.toLocaleString("en-US")} characters fit, fewer with many short lines. Lob prints your return address beside the client's. Booking link is your booking form's address.`} />
              <p className={fit.fits ? styles.fine : styles.autoNote} data-tone={fit.fits ? undefined : "danger"}>
                {message.length.toLocaleString("en-US")} characters, {fit.fits ? "which fits" : `about ${fit.over} ${fit.over === 1 ? "line" : "lines"} too long for this size`}. Every client's card is checked with their own name when you send.
              </p>
              <FormError error={save.error} />
            </div>
          </Section>
        ) : (
          <PostcardRecipients id={c.id} mode={c.mode as "test" | "live"} live={c.status === "sending"} />
        )}
        <PostcardPreview size={shown.size} frontUrl={front.data?.url ?? null} back={backHtml({ size: shown.size, message })} />
        <PostcardProofs campaignId={c.id} />
      </DetailColumns>
      {picking && <FrontPhotoPicker onClose={() => setPicking(false)} onPick={(photo) => { set({ front_attachment_id: photo, front_path: null, front_marked: true }); setPicking(false); }} />}
      {listing && <PostcardAudienceDialog name={draft.name} audience={draft.audience} onClose={() => setListing(false)} />}
    </>
  );
}

/** A link to the front's picture, as the person looking can open it, and whether the photo has a drawing. */
function useFrontUrl(d: Pick<Draft, "front_attachment_id" | "front_marked" | "front_path"> | null) {
  return useQuery({
    queryKey: ["postcard-front", d?.front_attachment_id, d?.front_marked, d?.front_path],
    enabled: Boolean(d?.front_attachment_id || d?.front_path),
    staleTime: 30 * 60_000,
    queryFn: async () => {
      if (d!.front_attachment_id) {
        const photo = unwrap(await supabase().from("attachments").select("path, marked_path").eq("id", d!.front_attachment_id).limit(1))[0];
        if (!photo) return { url: null, marked: false };
        const [linked] = await photoLinks([photo]);
        return { url: (d!.front_marked ? linked!.url : linked!.originalUrl) ?? null, marked: Boolean(photo.marked_path) };
      }
      const urls = await signedUrls([d!.front_path!]);
      return { url: urls[d!.front_path!] ?? null, marked: false };
    },
  });
}

/** A picture's size in pixels, as the browser reads it. */
function pictureSize(url: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const picture = new Image();
    picture.onload = () => resolve({ width: picture.naturalWidth, height: picture.naturalHeight });
    picture.onerror = () => reject(new Error("The picture couldn't be read."));
    picture.src = url;
  });
}

/** A picture from the computer or phone, kept in the campaign's own folder. Big enough to print. */
function UploadFront({ campaignId, onUploaded }: { campaignId: string; onUploaded: (path: string) => void }) {
  const session = useSession();
  const input = useRef<HTMLInputElement>(null);
  const upload = useMutation({
    meta: { inline: true },
    mutationFn: async (file: File) => {
      if (!/^image\/(jpeg|png)$/.test(file.type)) throw new Error("Pick a JPEG or PNG picture.");
      const body = await uploadBody(file, (f) => compressImage(f, 3400, 0.9));
      const path = `${session.company.id}/postcards/${campaignId}/${crypto.randomUUID()}.${storedExtension(file, body)}`;
      const { error } = await supabase().storage.from("files").upload(path, body, { contentType: body.type || file.type, upsert: false });
      if (error) throw new Error("The picture couldn't be uploaded. Try again.");
      return path;
    },
    onSuccess: onUploaded,
  });
  return (
    <>
      <input ref={input} type="file" accept="image/jpeg,image/png" hidden onChange={(e: ChangeEvent<HTMLInputElement>) => { const f = e.target.files?.[0]; if (f) upload.mutate(f); e.target.value = ""; }} />
      <Button icon="upload" loading={upload.isPending} onClick={() => input.current?.click()}>Upload a picture</Button>
      <FormError error={upload.error} />
    </>
  );
}

const PHOTO_PAGE = 48;

/**
 * The photos that may go on a card, newest first, each shown as it's shown everywhere (its drawing,
 * when it has one): only photos marked OK to share, never of a client who asked that photos of
 * their property not be posted (public.social_photos, as a social post's are picked), and of those
 * only the ones the person looking can open themselves (their own read of attachments). The server
 * checks the same again at Send.
 */
function FrontPhotoPicker({ onClose, onPick }: { onClose: () => void; onPick: (id: string) => void }) {
  const session = useSession();
  const photos = useInfiniteQuery({
    queryKey: ["postcard-photos", session.company.id],
    initialPageParam: null as null | { at: string; id: string },
    getNextPageParam: (last: { next: { at: string; id: string } | null }) => last.next,
    queryFn: async ({ pageParam }) => {
      const shared = unwrap(await supabase().rpc("social_photos", { p_company: session.company.id, p_limit: PHOTO_PAGE, ...(pageParam ? { p_before_at: pageParam.at, p_before_id: pageParam.id } : {}) }));
      const readable = shared.length ? unwrap(await supabase().from("attachments").select("id, path, marked_path, created_at").in("id", shared.map((p) => p.id))) : [];
      return { rows: await photoLinks(pickablePhotos(shared, readable)), next: shared.length === PHOTO_PAGE ? { at: shared.at(-1)!.created_at, id: shared.at(-1)!.id } : null };
    },
  });
  const all = photos.data?.pages.flatMap((page) => page.rows) ?? [];
  return (
    <Dialog open onClose={onClose} title="Pick a photo for the front" size="lg">
      {photos.isPending ? (
        <div className="thumbs">{[0, 1, 2, 3].map((i) => <Skeleton key={i} height={110} radius={8} />)}</div>
      ) : photos.error ? (
        <ErrorState compact error={photos.error} onRetry={() => photos.refetch()} />
      ) : !all.length && !photos.hasNextPage ? (
        <EmptyState icon="image" title="No photos marked OK to share">Only photos marked OK to share on their job can go on a postcard, and never a client's who asked that photos of their property not be posted. Mark one on its job, or upload a picture instead.</EmptyState>
      ) : (
        <div className="stack">
          <div className="thumbs" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))" }}>
            {all.map((p) => (
              <div key={p.id} className="thumb">
                {p.url ? <img src={p.url} alt="" loading="lazy" /> : <Skeleton height={110} radius={8} />}
                <button type="button" className="thumb-pick" aria-label={`Photo from ${formatDate(p.created_at)}${p.marked_path ? ", drawn on" : ""}`} onClick={() => onPick(p.id)} />
              </div>
            ))}
          </div>
          {photos.hasNextPage && <Button loading={photos.isFetchingNextPage} onClick={() => photos.fetchNextPage()}>Show more</Button>}
          <span className="muted small">Photos marked OK to share. A client's who asked that photos of their property not be posted are never here.</span>
        </div>
      )}
    </Dialog>
  );
}

/** Both sides at the size they're printed (a scroll across on a phone), the cut edge as the card's edge. */
export function PostcardPreview({ size, frontUrl, back }: { size: PostcardSize; frontUrl: string | null; back: string }) {
  const { width, height } = POSTCARD_SIZE_INFO[size];
  const side = (label: string, html: string | null, zone: boolean) => (
    <figure className={styles.side}>
      <figcaption>{label}</figcaption>
      <div className={styles.card} style={{ width: `${width}in`, height: `${height}in` }}>
        {html ? (
          <iframe title={label} srcDoc={html} sandbox="" style={{ position: "absolute", left: `-${BLEED_IN}in`, top: `-${BLEED_IN}in`, width: `${width + 2 * BLEED_IN}in`, height: `${height + 2 * BLEED_IN}in`, border: 0, pointerEvents: "none" }} />
        ) : (
          <div className={styles.cardEmpty}>Pick a picture for the front</div>
        )}
        {zone && (
          <div className={styles.zone} style={blockStyle(size)}>
            Lob prints your return address, the client's address, the barcode and postage here
          </div>
        )}
      </div>
    </figure>
  );
  return (
    <Section title="Preview" count={`Real size, ${POSTCARD_SIZE_INFO[size].label}`} flush>
      <div className={styles.sides}>
        {side("Front", frontUrl ? frontHtml(size, frontUrl) : null, false)}
        {side("Back", back, true)}
      </div>
    </Section>
  );
}

interface Results {
  campaign_id: string;
  mode: "test" | "live";
  made: number;
  failed: number;
  skipped: number;
  clients_paid: number | null;
  revenue: number | null;
}

function PostcardStats({ id, mode, live }: { id: string; mode: "test" | "live"; live: boolean }) {
  const session = useSession();
  const results = useQuery({
    queryKey: ["postcard-results", session.company.id, id],
    refetchInterval: live ? 3000 : false,
    queryFn: async () => ((unwrap(await supabase().rpc("postcard_results", { p_company: session.company.id, p_campaign: id })) as unknown as Results[])[0] ?? null),
  });
  const r = results.data;
  if (results.isPending) return <StatsSkeleton count={4} />;
  if (results.error) return <ErrorState compact error={results.error} onRetry={() => results.refetch()} />;
  return (
    <>
      <StatStrip label="What it made">
        <Stat label={mode === "live" ? "Mailed" : "Made in test mode"} value={(r?.made ?? 0).toLocaleString("en-US")} note={mode === "live" ? "Accepted by Lob to print and mail" : "Not printed or mailed"} />
        <Stat label="Failed" value={(r?.failed ?? 0).toLocaleString("en-US")} tone={r?.failed ? "danger" : undefined} note="Lob refused them or couldn't print them" />
        <Stat label="Skipped" value={(r?.skipped ?? 0).toLocaleString("en-US")} note="Stopped, opted out or archived" />
        {/* Someone without the Invoices area has no revenue to see. */}
        {r?.revenue != null && (
          <Stat
            label="Revenue"
            value={formatMoneyCents(r.revenue)}
            note={mode === "test" ? "Test cards weren't mailed" : `${(r?.clients_paid ?? 0).toLocaleString("en-US")} ${r?.clients_paid === 1 ? "client" : "clients"} paid, before tax`}
          />
        )}
      </StatStrip>
      <div className="stack-sm">
        <p className={styles.fine}>Lob draws each card after it accepts it. For {POSTCARD_KEEP_DAYS} days after the last card, Crewtavo asks Lob every hour whether any failed, and marks those failed below with Lob's reason.</p>
        {mode === "live" && <p className={styles.fine}>Revenue is paid invoices from clients this was mailed to, made after their card and within 90 days of it, before tax. A postcard has no link to follow, so it counts work they'd have booked anyway too.</p>}
      </div>
    </>
  );
}

const RECIPIENT_PAGE = 50;
type Recipient = {
  id: number;
  name: string;
  address: { line1?: string; line2?: string | null; city?: string; region?: string; postal_code?: string } | null;
  status: string;
  error: string | null;
  lob_id: string | null;
  expected_delivery: string | null;
  /** Lob's PDF of the card as it drew it, and when Lob gave the link (it works for 30 days). */
  proof_url: string | null;
  proof_at: string | null;
};

function PostcardRecipients({ id, mode, live }: { id: string; mode: "test" | "live"; live: boolean }) {
  const [failedOnly, setFailedOnly] = useState(false);
  const list = useInfiniteQuery({
    queryKey: ["postcard-recipients", id, failedOnly],
    refetchInterval: live ? 5000 : false,
    initialPageParam: null as number | null,
    getNextPageParam: (last: Recipient[]) => (last.length === RECIPIENT_PAGE ? last.at(-1)!.id : null),
    queryFn: async ({ pageParam }) => {
      let q = supabase().from("postcard_recipients").select("id, name, address, status, error, lob_id, expected_delivery, proof_url, proof_at").eq("campaign_id", id);
      if (failedOnly) q = q.eq("status", "failed");
      if (pageParam) q = q.lt("id", pageParam);
      return unwrap(await q.order("id", { ascending: false }).limit(RECIPIENT_PAGE)) as unknown as Recipient[];
    },
  });
  const rows = list.data?.pages.flat() ?? [];
  const words = (r: Recipient) =>
    r.status === "made" ? (mode === "live" ? `Mailed${r.expected_delivery ? `, expected ${formatDate(r.expected_delivery)}` : ""}` : "Made in test mode")
      : r.status === "failed" ? `Failed: ${r.error ?? "Lob couldn't make it"}`
      : r.status === "skipped" ? `Skipped: ${r.error ?? "not mailed"}`
      : "Waiting";
  return (
    <Section title="Who it went to" flush>
      <div className={styles.filters}>
        <FilterTabs label="Show" value={failedOnly ? "failed" : "all"} onChange={(v) => setFailedOnly(v === "failed")} options={[{ value: "all", label: "Everyone" }, { value: "failed", label: "Failed" }]} />
      </div>
      {list.isPending ? <SectionSkeleton rows={3} /> : list.error ? <ErrorState compact error={list.error} onRetry={() => list.refetch()} /> : !rows.length ? (
        <EmptyState inline title={failedOnly ? "None failed" : "No one yet"} />
      ) : (
        <>
          <ul className="rel" aria-label="Who it went to">
            {rows.map((r) => (
              <li key={r.id} className={styles.recipient}>
                <div className={styles.recipientBody}>
                  <span className={styles.recipientName}>{r.name}</span>
                  <div className={styles.recipientMeta}>{r.address?.line1 ? addressLine({ line1: r.address.line1, line2: r.address.line2, city: r.address.city ?? "", region: r.address.region ?? "", postal_code: r.address.postal_code ?? "" }) : ""}{r.lob_id ? ` · ${r.lob_id}` : ""}</div>
                  {proofLink(r) && <a className={styles.recipientMeta} href={proofLink(r)!} target="_blank" rel="noreferrer">See the card as Lob drew it <Icon name="external" size={12} /></a>}
                </div>
                <span className={styles.recipientEnd} data-tone={r.status === "failed" ? "danger" : undefined}>{words(r)}</span>
              </li>
            ))}
          </ul>
          {list.hasNextPage && <ListFoot more={{ onClick: () => void list.fetchNextPage(), loading: list.isFetchingNextPage, label: "Show more" }}>{rows.length.toLocaleString("en-US")} shown</ListFoot>}
        </>
      )}
    </Section>
  );
}
