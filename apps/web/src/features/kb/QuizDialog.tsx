/**
 * "I've read this" on a guide with a quiz: its questions first. The database checks the answers
 * (public.acknowledge_guide) and says which aren't right, without saying what is.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { FormError } from "@/components/ui/Field";
import { supabase, unwrap } from "@/lib/api";
import { useSession } from "@/lib/session";
import { toast } from "@/lib/toast";

export interface QuizQuestion { question: string; options: string[] }

export function QuizDialog({ pageId, title, questions, onClose }: { pageId: string; title: string; questions: QuizQuestion[]; onClose: () => void }) {
  const { company } = useSession();
  const queryClient = useQueryClient();
  const [answers, setAnswers] = useState<Array<number | null>>(() => questions.map(() => null));
  const [wrong, setWrong] = useState<number[]>([]);
  const check = useMutation({
    meta: { inline: true },
    mutationFn: async () => unwrap(await supabase().rpc("acknowledge_guide", { p_page: pageId, p_answers: answers.map((a) => a ?? -1) })),
    onSuccess: (notRight) => {
      if (notRight.length) return setWrong(notRight);
      toast.success("Marked as read");
      queryClient.invalidateQueries({ queryKey: ["kb", company.id] });
      onClose();
    },
  });
  const choose = (question: number, option: number) => {
    setAnswers((all) => all.map((a, i) => (i === question ? option : a)));
    setWrong((w) => w.filter((i) => i !== question));
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    check.mutate();
  };
  const left = answers.filter((a) => a === null).length;

  return (
    <Dialog open onClose={onClose} title="Check what you read" description={`Answer ${questions.length === 1 ? "this question" : `these ${questions.length} questions`} to confirm you've read “${title}”.`}>
      <form className="stack" onSubmit={submit}>
        {questions.map((q, i) => (
          <fieldset key={i} className="quiz-question" data-wrong={wrong.includes(i) || undefined} aria-describedby={wrong.includes(i) ? `quiz-wrong-${i}` : undefined}>
            <legend><span className="muted tabular">{i + 1}.</span> {q.question}</legend>
            {q.options.map((o, j) => (
              <label key={j} className="quiz-option">
                <input type="radio" name={`quiz-${i}`} checked={answers[i] === j} onChange={() => choose(i, j)} />
                <span>{o}</span>
              </label>
            ))}
            {wrong.includes(i) && <p id={`quiz-wrong-${i}`} className="error-text" role="alert">Not quite. Have another look at the guide.</p>}
          </fieldset>
        ))}
        <FormError error={check.error} />
        <div className="form-actions">
          {left > 0 && <span className="muted small">{left} to answer</span>}
          <span className="spacer" />
          <Button onClick={onClose}>Back to the guide</Button>
          <Button type="submit" variant="primary" loading={check.isPending} disabled={left > 0}>Confirm I've read it</Button>
        </div>
      </form>
    </Dialog>
  );
}
