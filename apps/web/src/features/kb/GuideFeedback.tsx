/**
 * Under a guide: "Was this helpful?" and "Suggest a change" for everyone reading it, and for the
 * office the suggestions still to look at and how this revision's votes went. Sent through
 * public.guide_feedback, which tells the guide's reviewer (or the office) about a suggestion.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Face } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { Field, FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { supabase, unwrap } from "@/lib/api";
import { formatDateTime, timeAgo } from "@/lib/format";
import { useSession } from "@/lib/session";

interface Person { name: string; photo?: string | null }

export function GuideFeedback({ page, editor, person }: { page: { id: string; revision: number }; editor: boolean; person: (id: string | null) => Person }) {
  const { company, userId } = useSession();
  const queryClient = useQueryClient();
  const [writing, setWriting] = useState(false);
  const [text, setText] = useState("");
  const mine = useQuery({
    queryKey: ["kb", company.id, "my-vote", page.id, page.revision],
    queryFn: async () => unwrap(await supabase().from("sop_feedback").select("helpful").eq("page_id", page.id).eq("revision", page.revision).eq("user_id", userId).is("message", null).maybeSingle())?.helpful ?? null,
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["kb", company.id] });
  const vote = useMutation({
    meta: { inline: true },
    mutationFn: async (helpful: boolean) => unwrap(await supabase().rpc("guide_feedback", { p_page: page.id, p_helpful: helpful })),
    onMutate: (helpful) => {
      queryClient.setQueryData(["kb", company.id, "my-vote", page.id, page.revision], helpful);
      if (!helpful) setWriting(true);
    },
    onSettled: refresh,
  });
  const suggest = useMutation({
    meta: { inline: true, success: "Sent to the office" },
    mutationFn: async (message: string) => unwrap(await supabase().rpc("guide_feedback", { p_page: page.id, p_message: message })),
    onSuccess: () => {
      setWriting(false);
      setText("");
    },
    onSettled: refresh,
  });
  const voted = mine.data ?? null;
  const send = (e: FormEvent) => {
    e.preventDefault();
    if (text.trim()) suggest.mutate(text.trim());
  };

  return (
    <>
      <section className="card card-pad guide-feedback no-print" aria-labelledby="guide-feedback-title">
        <div className="guide-feedback-ask">
          <strong id="guide-feedback-title">{suggest.isSuccess ? "Thanks. The office will take a look." : voted === null ? "Was this guide helpful?" : voted ? "Thanks. Glad it helped." : "Thanks. What would make it better?"}</strong>
          <div className="row" style={{ gap: 8 }}>
            <Button size="sm" aria-pressed={voted === true} disabled={mine.isPending} onClick={() => vote.mutate(true)}><Icon name="thumbsUp" size={16} />Yes</Button>
            <Button size="sm" aria-pressed={voted === false} disabled={mine.isPending} onClick={() => vote.mutate(false)}><span className="icon-flip"><Icon name="thumbsUp" size={16} /></span>No</Button>
          </div>
        </div>
        {writing ? (
          <form className="stack-sm" onSubmit={send}>
            <Field label="What's wrong or missing?" hint="The office sees this with your name, and the guide it's about.">
              <textarea className="textarea" rows={3} maxLength={2000} value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. Step 3 says 20 gallons, but we use 30 now." autoFocus />
            </Field>
            <FormError error={suggest.error ?? vote.error} />
            <div className="row" style={{ gap: 8 }}>
              <Button type="submit" size="sm" variant="primary" loading={suggest.isPending} disabled={!text.trim()}>Send to the office</Button>
              <Button size="sm" variant="ghost" onClick={() => { setWriting(false); suggest.reset(); }}>Cancel</Button>
            </div>
          </form>
        ) : (
          <>
            <FormError error={vote.error} />
            <button type="button" className="link-btn small" style={{ justifySelf: "start" }} onClick={() => setWriting(true)}>Suggest a change</button>
          </>
        )}
      </section>
      {editor && <OfficeFeedback page={page} person={person} />}
    </>
  );
}

/** For the office: suggestions still to look at, each marked done once handled, and this revision's votes. */
function OfficeFeedback({ page, person }: { page: { id: string; revision: number }; person: (id: string | null) => Person }) {
  const { company, userId } = useSession();
  const queryClient = useQueryClient();
  const feedback = useQuery({
    queryKey: ["kb", company.id, "feedback", page.id],
    queryFn: async () => unwrap(await supabase().from("sop_feedback").select("id, revision, user_id, helpful, message, created_at, resolved_at").eq("page_id", page.id).order("created_at", { ascending: false }).limit(300)),
  });
  const done = useMutation({
    meta: { inline: true, success: "Marked done" },
    mutationFn: async (id: string) => unwrap(await supabase().from("sop_feedback").update({ resolved_at: new Date().toISOString(), resolved_by: userId }).eq("id", id)),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["kb", company.id] }),
  });
  const rows = feedback.data ?? [];
  const votes = rows.filter((r) => r.message === null && r.revision === page.revision);
  const helpful = votes.filter((r) => r.helpful).length;
  const open = rows.filter((r) => r.message !== null && !r.resolved_at);
  const handled = rows.filter((r) => r.message !== null && r.resolved_at).length;
  if (feedback.isPending || (!rows.length && !feedback.error)) return null;

  return (
    <section className="card no-print" aria-labelledby="office-feedback-title">
      <div className="card-head row-between">
        <strong id="office-feedback-title">Feedback</strong>
        <span className="muted small">{votes.length ? `${helpful} of ${votes.length} found this revision helpful` : "No votes on this revision yet"}</span>
      </div>
      <FormError error={feedback.error ?? done.error} />
      {open.length === 0 ? (
        <p className="muted small card-pad" style={{ margin: 0 }}>No suggestions to look at{handled ? ` (${handled} done)` : ""}.</p>
      ) : (
        open.map((f) => {
          const who = person(f.user_id);
          return (
            <div key={f.id} className="card-row" style={{ alignItems: "flex-start" }}>
              <span className="avatar" style={{ width: 28, height: 28, fontSize: 11 }}><Face name={who.name} photo={who.photo} /></span>
              <span className="grow stack-sm" style={{ gap: 2, minWidth: 0 }}>
                <span className="small">
                  <strong>{who.name}</strong>
                  <span className="muted" title={formatDateTime(f.created_at)}> · {timeAgo(f.created_at)}{f.revision !== page.revision ? ` · about revision ${f.revision}` : ""}</span>
                </span>
                <span className="pre-wrap">{f.message}</span>
              </span>
              <Button size="sm" icon="check" loading={done.isPending && done.variables === f.id} onClick={() => done.mutate(f.id)}>Done</Button>
            </div>
          );
        })
      )}
    </section>
  );
}
