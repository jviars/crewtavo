/**
 * Writing a guide's quiz (the guide editor's Quiz dialog): questions, their answers, and which answer
 * is right. Each answer has the letter people answering it see; picking an answer's letter makes it
 * the right one.
 */
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { EmptyState } from "@/components/ui/States";
import s from "./kbWrite.module.css";
import { blankQuestion, MAX_OPTIONS, MAX_QUESTIONS, type QuizDraft } from "./quiz";

const letter = (j: number) => String.fromCharCode(65 + j);

export function QuizEditor({ value, onChange }: { value: QuizDraft[]; onChange: (quiz: QuizDraft[]) => void }) {
  const setQ = (i: number, patch: Partial<QuizDraft>) => onChange(value.map((q, k) => (k === i ? { ...q, ...patch } : q)));
  const setOption = (i: number, j: number, text: string) => setQ(i, { options: value[i].options.map((o, k) => (k === j ? text : o)) });
  const removeOption = (i: number, j: number) => {
    const q = value[i];
    // The right answer stays the same answer as the list shortens.
    setQ(i, { options: q.options.filter((_, k) => k !== j), answer: q.answer === j ? null : q.answer !== null && q.answer > j ? q.answer - 1 : q.answer });
  };
  const add = () => onChange([...value, blankQuestion()]);

  if (!value.length) return <EmptyState inline icon="help" title="No questions yet" action={<Button size="sm" icon="plus" onClick={add}>Add a question</Button>} />;
  return (
    <div className={s.quiz}>
      {value.map((q, i) => (
        <fieldset key={i} className={s.q}>
          <legend className="sr-only">Question {i + 1}</legend>
          <div className={s.qhead}>
            <span className={s.qnum} aria-hidden="true">Question {i + 1}</span>
            <button type="button" className={s.iconBtn} title="Remove this question" aria-label={`Remove question ${i + 1}`} onClick={() => onChange(value.filter((_, k) => k !== i))}>
              <Icon name="trash" size={15} />
            </button>
          </div>
          <input className="input" value={q.question} maxLength={300} placeholder="e.g. How long does sealer need to dry before cars drive on it?" aria-label={`Question ${i + 1}`} onChange={(e) => setQ(i, { question: e.target.value })} />
          <div className={s.answers} role="radiogroup" aria-label={`Answers to question ${i + 1}. Pick the right one.`}>
            {q.options.map((o, j) => (
              <div key={j} className={s.ans} data-right={q.answer === j || undefined}>
                <label className={s.key} title={q.answer === j ? "The right answer" : "Make this the right answer"}>
                  <input type="radio" name={`quiz-answer-${i}`} checked={q.answer === j} onChange={() => setQ(i, { answer: j })} aria-label={`Answer ${j + 1} is right`} />
                  <span aria-hidden="true">{letter(j)}</span>
                </label>
                <input className="input" value={o} maxLength={200} placeholder={`Answer ${j + 1}`} aria-label={`Answer ${j + 1} to question ${i + 1}`} onChange={(e) => setOption(i, j, e.target.value)} />
                <button type="button" className={s.iconBtn} aria-label={`Remove answer ${j + 1}`} disabled={q.options.length <= 2} onClick={() => removeOption(i, j)}>
                  <Icon name="x" size={15} />
                </button>
              </div>
            ))}
          </div>
          <div className={s.qfoot}>
            {q.options.length < MAX_OPTIONS && <button type="button" className={s.linkBtn} onClick={() => setQ(i, { options: [...q.options, ""] })}>Add an answer</button>}
            <span className={q.answer === null && (q.question.trim() || q.options.some((o) => o.trim())) ? s.warn : undefined}>{q.answer === null ? "Pick the right answer by its letter" : `${letter(q.answer)} is the right answer`}</span>
          </div>
        </fieldset>
      ))}
      {value.length < MAX_QUESTIONS ? (
        <Button size="sm" icon="plus" className={s.addQ} onClick={add}>Add a question</Button>
      ) : (
        <p className={s.footNote} style={{ marginTop: 14 }}>A quiz has up to {MAX_QUESTIONS} questions.</p>
      )}
    </div>
  );
}
