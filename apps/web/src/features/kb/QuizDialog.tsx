/**
 * "I've read this" on a guide with a quiz (KB-Extras.dc.html, Quiz): its questions one at a time, with
 * a bar of them to move between, and A, B, C to answer. The database checks the answers
 * (public.acknowledge_guide) and says which aren't right, without saying what is. Once they're all
 * right it says so, and offers the next guide that's still theirs to read.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Button, cx } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { supabase, unwrap } from "@/lib/api";
import { useSession } from "@/lib/session";
import { t } from "@/lib/i18n";
import s from "./kb.module.css";

export interface QuizQuestion { question: string; options: string[] }

const LETTERS = "ABCDEFGH";

export function QuizDialog({ pageId, title, revision, questions, next, onClose }: {
  pageId: string;
  title: string;
  revision: number;
  questions: QuizQuestion[];
  /** The next guide still theirs to read, and how many there are, for once this one's done. */
  next?: { id: string; title: string; more: number } | null;
  onClose: () => void;
}) {
  const { company } = useSession();
  const queryClient = useQueryClient();
  const [answers, setAnswers] = useState<Array<number | null>>(() => questions.map(() => null));
  const [wrong, setWrong] = useState<number[]>([]);
  // Once checked, the bar shows which were right; until then, which are answered.
  const [checked, setChecked] = useState(false);
  const [at, setAt] = useState(0);
  const [passed, setPassed] = useState(false);
  const fieldset = useRef<HTMLFieldSetElement>(null);
  const moved = useRef(false);
  const check = useMutation({
    meta: { inline: true },
    mutationFn: async () => unwrap(await supabase().rpc("acknowledge_guide", { p_page: pageId, p_answers: answers.map((a) => a ?? -1) })),
    onSuccess: (notRight) => {
      setChecked(true);
      if (notRight.length) {
        setWrong(notRight);
        go(notRight[0]!);
        return;
      }
      setPassed(true);
      queryClient.invalidateQueries({ queryKey: ["kb", company.id] });
    },
  });
  const go = (i: number) => {
    moved.current = true;
    setAt(Math.max(0, Math.min(questions.length - 1, i)));
  };
  // A question moved to takes the focus at its chosen answer (or its first), so a keyboard goes on from there.
  useEffect(() => {
    if (!moved.current) return;
    moved.current = false;
    const radios = fieldset.current?.querySelectorAll<HTMLInputElement>("input[type=radio]");
    (Array.from(radios ?? []).find((r) => r.checked) ?? radios?.[0])?.focus();
  }, [at]);
  const choose = (question: number, option: number) => {
    setAnswers((all) => all.map((a, i) => (i === question ? option : a)));
    setWrong((w) => w.filter((i) => i !== question));
  };
  const last = at === questions.length - 1;
  const left = answers.filter((a) => a === null).length;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!last && !checked) return go(at + 1);
    if (left === 0 && wrong.length === 0) check.mutate();
  };
  // A, B, C… answers the question showing, wherever the focus is in the dialog (it opens on the dialog itself, not in the form).
  const onKey = useRef((_: KeyboardEvent) => {});
  onKey.current = (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.key.length !== 1) return;
    const option = LETTERS.indexOf(e.key.toUpperCase());
    if (option < 0 || option >= questions[at]!.options.length) return;
    e.preventDefault();
    choose(at, option);
    fieldset.current?.querySelectorAll<HTMLInputElement>("input[type=radio]")[option]?.focus();
  };
  useEffect(() => {
    const dialog = fieldset.current?.closest("dialog");
    if (!dialog) return;
    const listen = (e: KeyboardEvent) => onKey.current(e);
    dialog.addEventListener("keydown", listen);
    return () => dialog.removeEventListener("keydown", listen);
  }, [passed]);
  const q = questions[at]!;
  const stateOf = (i: number) => (checked ? (wrong.includes(i) ? "no" : "ok") : answers[i] !== null ? "on" : undefined);
  const stateWords = (i: number) => (checked ? (wrong.includes(i) ? t("not right") : t("right")) : answers[i] !== null ? t("answered") : t("not answered"));

  if (passed) {
    return (
      <Dialog open onClose={onClose} title={t("You've read this revision")} description={t("{title} · Revision {number} · confirmed. The office can see it.", { title, number: revision })}>
        <div className={s.quizDone} role="status">
          <span className={s.doneIcon} data-ok=""><Icon name="check" size={18} bold /></span>
          <p>{next ? t.plural(next.more, { one: "{count} more required guide", other: "{count} more required guides" }) : t("Nothing else is waiting for you to read.")}</p>
          {next && <Link to={`/kb/${next.id}`} className={s.quizNext} onClick={onClose}><Icon name="book" size={16} /><span>{next.title}</span><Icon name="chevronRight" size={16} /></Link>}
        </div>
        <div className="form-actions">
          <Button variant="ghost" onClick={onClose}>{t("Back to the guide")}</Button>
          <span className="spacer" />
          {next && <Link className="btn btn-primary" to={`/kb/${next.id}`} onClick={onClose}>{t("Next required guide")}</Link>}
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog open onClose={onClose} title={t("Check what you read")} description={t.plural(questions.length, { one: "Answer this question to confirm you've read “{title}”.", other: "Answer these {count} questions to confirm you've read “{title}”." }, { title })}>
      <form className={s.quiz} onSubmit={submit}>
        {questions.length > 1 && (
          <div className={s.quizTop}>
            <div className={s.quizBar} role="group" aria-label={t("Questions")}>
              {questions.map((_, i) => (
                <button key={i} type="button" className={s.quizSeg} data-state={stateOf(i)} aria-current={i === at ? "step" : undefined} aria-label={t("Question {number}, {state}", { number: i + 1, state: stateWords(i) })} onClick={() => go(i)} />
              ))}
            </div>
            <span className={s.quizCount}>
              {t("Question {number} of {count}", { number: at + 1, count: questions.length })}
              {checked && wrong.length > 0 && <> · <span className={s.quizFix}>{t("{count} to fix", { count: wrong.length })}</span></>}
            </span>
          </div>
        )}
        <fieldset key={at} ref={fieldset} className={s.quizQuestion} data-wrong={wrong.includes(at) || undefined} aria-describedby={wrong.includes(at) ? `quiz-wrong-${at}` : undefined}>
          <legend className={s.quizStem}>{q.question}</legend>
          <div className={s.quizOptions}>
            {q.options.map((o, j) => (
              <label key={j} className={s.quizOption} data-on={answers[at] === j || undefined}>
                <input type="radio" name={`quiz-${at}`} checked={answers[at] === j} onChange={() => choose(at, j)} aria-keyshortcuts={LETTERS[j]} />
                <span className={s.quizKey} aria-hidden="true">{LETTERS[j]}</span>
                <span>{o}</span>
              </label>
            ))}
          </div>
        </fieldset>
        {wrong.includes(at) && <p id={`quiz-wrong-${at}`} className={s.quizFlag} role="alert"><Icon name="alert" size={16} />{t("Not quite. Have another look at the guide.")}</p>}
        <FormError error={check.error} />
        <div className="form-actions">
          <Button variant="ghost" className={s.quizBack} onClick={onClose}>{t("Back to the guide")}</Button>
          <span className="spacer" />
          {!checked && left > 0 && <span className={cx("muted small", s.quizLeft)}>{t("{count} to answer", { count: left })}</span>}
          {questions.length > 1 && <Button icon="chevronLeft" className={s.quizNav} aria-label={t("Previous question")} disabled={at === 0} onClick={() => go(at - 1)} />}
          {checked && questions.length > 1 && <Button icon="chevronRight" className={s.quizNav} aria-label={t("Next question")} disabled={last} onClick={() => go(at + 1)} />}
          {!last && !checked ? (
            <Button type="submit" variant="primary">{t("Next question")}<Icon name="arrowRight" size={16} /></Button>
          ) : (
            <Button type="submit" variant="primary" loading={check.isPending} disabled={left > 0 || wrong.length > 0}>{t("Confirm I've read it")}</Button>
          )}
        </div>
      </form>
    </Dialog>
  );
}
