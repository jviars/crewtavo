/**
 * Under a guide: "Was this guide helpful?" with Yes and No, and "Suggest a change", for everyone
 * reading it (KB-Guide.dc.html). In the guide's rail, for the office: how this revision's votes went
 * and the suggestions still to look at, each marked done once handled. Sent through
 * public.guide_feedback, which tells the guide's reviewer (or the office) about a suggestion.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Face } from "@/components/ui/Avatar";
import { Button, cx } from "@/components/ui/Button";
import { Field, FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { personHue } from "@/components/ui/InboxList";
import { supabase, unwrap } from "@/lib/api";
import { formatDateTime, timeAgo } from "@/lib/format";
import { useSession } from "@/lib/session";
import { t } from "@/lib/i18n";
import s from "./kb.module.css";

interface Person { name: string; photo?: string | null }

export function GuideFeedback({ page }: { page: { id: string; revision: number } }) {
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
    meta: { inline: true, success: t("Sent to the office") },
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
    <section className={cx(s.help, "no-print")} aria-labelledby="guide-feedback-title">
      <div className={s.helpRow}>
        <h2 id="guide-feedback-title" className={s.helpAsk}>{suggest.isSuccess ? t("Thanks. The office will take a look.") : voted === null ? t("Was this guide helpful?") : voted ? t("Thanks. Glad it helped.") : t("Thanks. What would make it better?")}</h2>
        <div className={s.helpVotes}>
          <Button size="sm" aria-pressed={voted === true} disabled={mine.isPending} onClick={() => vote.mutate(true)}><Icon name="thumbsUp" size={14} />{t("Yes")}</Button>
          <Button size="sm" aria-pressed={voted === false} disabled={mine.isPending} onClick={() => vote.mutate(false)}><span className={s.flip}><Icon name="thumbsUp" size={14} /></span>{t("No")}</Button>
        </div>
        {!writing && <button type="button" className={cx("link-btn", s.suggest)} onClick={() => setWriting(true)}><Icon name="edit" size={14} />{t("Suggest a change")}</button>}
      </div>
      {writing ? (
        <form className={s.suggestForm} onSubmit={send}>
          <Field label={t("What's wrong or missing?")} hint={t("The office sees this with your name, and the guide it's about.")}>
            <textarea className="textarea" rows={3} maxLength={2000} value={text} onChange={(e) => setText(e.target.value)} placeholder={t("e.g. Step 3 says 20 gallons, but we use 30 now.")} autoFocus />
          </Field>
          <FormError error={suggest.error ?? vote.error} />
          <div className={s.suggestActions}>
            <Button type="submit" variant="primary" loading={suggest.isPending} disabled={!text.trim()}>{t("Send to the office")}</Button>
            <Button onClick={() => { setWriting(false); suggest.reset(); }}>{t("Cancel")}</Button>
          </div>
        </form>
      ) : (
        <FormError error={vote.error} />
      )}
    </section>
  );
}

/** For the office, in the guide's rail: this revision's votes, and the suggestions still to look at. */
export function OfficeFeedback({ page, person }: { page: { id: string; revision: number }; person: (id: string | null) => Person }) {
  const { company, userId } = useSession();
  const queryClient = useQueryClient();
  const feedback = useQuery({
    queryKey: ["kb", company.id, "feedback", page.id],
    queryFn: async () => unwrap(await supabase().from("sop_feedback").select("id, revision, user_id, helpful, message, created_at, resolved_at").eq("page_id", page.id).order("created_at", { ascending: false }).limit(300)),
  });
  const done = useMutation({
    meta: { inline: true, success: t("Marked done") },
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
    <section className={s.railSec} aria-labelledby="office-feedback-title">
      <div className={s.railRow}><h2 id="office-feedback-title" className={s.railHead}>{t("Feedback")}</h2><span className={s.railCount}>{t("Revision {number}", { number: page.revision })}</span></div>
      <p className={s.railNote}>{votes.length ? t("{done} of {count} found this revision helpful", { done: helpful, count: votes.length }) : t("No votes on this revision yet")}</p>
      {votes.length > 0 && <span className={s.bar} data-tone={helpful / votes.length < 0.5 ? "danger" : undefined}><b style={{ width: `${(helpful / votes.length) * 100}%` }} /></span>}
      <FormError error={feedback.error ?? done.error} />
      {open.length === 0 ? (
        <p className={s.railNote}>{handled ? t("No suggestions to look at ({count} done).", { count: handled }) : t("No suggestions to look at.")}</p>
      ) : (
        <>
          <p className={s.toLook}>{t("{count} to look at", { count: open.length })}</p>
          <ul className={s.suggestions}>
            {open.map((f) => {
              const who = person(f.user_id);
              return (
                <li key={f.id} className={s.suggestion}>
                  <div className={s.suggestionWho}>
                    <span className={cx("avatar", s.face)} style={{ background: personHue(who.name) }}><Face name={who.name} photo={who.photo} /></span>
                    <b>{who.name}</b>
                    <span title={formatDateTime(f.created_at)}>{timeAgo(f.created_at)}</span>
                  </div>
                  <p className={s.suggestionText}>{f.message}</p>
                  {f.revision !== page.revision && <p className={s.railNote}>{t("about revision {number}", { number: f.revision })}</p>}
                  <Button size="sm" icon="check" loading={done.isPending && done.variables === f.id} aria-label={t("Done with {name}'s suggestion", { name: who.name })} onClick={() => done.mutate(f.id)}>{t("Done")}</Button>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}
