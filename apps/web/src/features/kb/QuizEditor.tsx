/** Writing a guide's quiz (in the guide editor): questions, their answers, and which answer is right. */
import { Button } from "@/components/ui/Button";
import { blankQuestion, MAX_OPTIONS, MAX_QUESTIONS, type QuizDraft } from "./quiz";

export function QuizEditor({ value, onChange }: { value: QuizDraft[]; onChange: (quiz: QuizDraft[]) => void }) {
  const setQ = (i: number, patch: Partial<QuizDraft>) => onChange(value.map((q, k) => (k === i ? { ...q, ...patch } : q)));
  const setOption = (i: number, j: number, text: string) => setQ(i, { options: value[i].options.map((o, k) => (k === j ? text : o)) });
  const removeOption = (i: number, j: number) => {
    const q = value[i];
    // The right answer stays the same answer as the list shortens.
    setQ(i, { options: q.options.filter((_, k) => k !== j), answer: q.answer === j ? null : q.answer !== null && q.answer > j ? q.answer - 1 : q.answer });
  };

  return (
    <section className="card card-pad stack quiz-editor" aria-labelledby="quiz-editor-title">
      <div className="stack-sm" style={{ gap: 2 }}>
        <strong id="quiz-editor-title">Quiz <span className="muted small" style={{ fontWeight: 400 }}>optional</span></strong>
        <span className="muted small">Questions people answer before they can confirm they've read it. Good for safety guides that are required reading.</span>
      </div>
      {value.map((q, i) => (
        <fieldset key={i} className="quiz-edit">
          <legend className="sr-only">Question {i + 1}</legend>
          <div className="row">
            <span className="muted tabular small quiz-edit-number">{i + 1}</span>
            <input className="input grow" value={q.question} maxLength={300} placeholder="e.g. How long does sealer need to dry before cars drive on it?" aria-label={`Question ${i + 1}`} onChange={(e) => setQ(i, { question: e.target.value })} />
            <Button size="sm" variant="ghost" icon="trash" aria-label={`Remove question ${i + 1}`} onClick={() => onChange(value.filter((_, k) => k !== i))} />
          </div>
          <div className="quiz-edit-options" role="radiogroup" aria-label={`Answers to question ${i + 1}. Pick the right one.`}>
            {q.options.map((o, j) => (
              <div key={j} className="row">
                <input type="radio" name={`quiz-answer-${i}`} checked={q.answer === j} onChange={() => setQ(i, { answer: j })} aria-label={`Answer ${j + 1} is right`} />
                <input className="input input-sm grow" value={o} maxLength={200} placeholder={`Answer ${j + 1}`} aria-label={`Answer ${j + 1} to question ${i + 1}`} onChange={(e) => setOption(i, j, e.target.value)} />
                {q.options.length > 2 && <Button size="sm" variant="ghost" icon="x" aria-label={`Remove answer ${j + 1}`} onClick={() => removeOption(i, j)} />}
              </div>
            ))}
            <div className="row wrap" style={{ gap: 12 }}>
              {q.options.length < MAX_OPTIONS && <button type="button" className="link-btn small" onClick={() => setQ(i, { options: [...q.options, ""] })}>Add an answer</button>}
              <span className="small" style={{ color: q.answer === null ? "var(--warning)" : "var(--text-3)" }}>{q.answer === null ? "Pick the right answer" : "The picked one is the right answer"}</span>
            </div>
          </div>
        </fieldset>
      ))}
      {value.length < MAX_QUESTIONS && (
        <Button size="sm" icon="plus" style={{ justifySelf: "start" }} onClick={() => onChange([...value, blankQuestion()])}>{value.length ? "Add a question" : "Add a quiz"}</Button>
      )}
    </section>
  );
}
