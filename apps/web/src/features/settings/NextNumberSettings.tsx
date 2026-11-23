/**
 * Settings → Company → Numbering: the number the next request, quote, job and invoice gets. A
 * business coming from another system sets each to carry on from there (invoice #4311 after #4310)
 * rather than starting again at 1. Owners and admins only, which the database checks (nextNumbers.ts).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Button, useJustDone } from "@/components/ui/Button";
import { Field, FormChecks, FormError } from "@/components/ui/Field";
import { Section } from "@/components/ui/Section";
import { Loading, SectionSkeleton } from "@/components/ui/Skeleton";
import { ErrorState } from "@/components/ui/States";
import { supabase, unwrap } from "@/lib/api";
import { useSession } from "@/lib/session";
import p from "./Prefs.module.css";
import { changedNumbers, HIGHEST_NUMBER, nextNumberProblem, NUMBER_KINDS, type NextNumber } from "./nextNumbers";
import { NumberInput } from "@/components/ui/NumberInput";

export function NextNumbers() {
  const { company } = useSession();
  const queryClient = useQueryClient();
  const key = ["company", company.id, "next-numbers"];
  const numbers = useQuery({
    queryKey: key,
    queryFn: async () => unwrap(await supabase().rpc("next_numbers", { p_company: company.id })) as NextNumber[],
  });
  // Only what's been typed: a number nobody touched follows the documents made meanwhile.
  const [typed, setTyped] = useState<Record<string, string>>({});
  const saved = numbers.data ?? [];
  const highest = (kind: string) => Number(saved.find((s) => s.kind === kind)?.highest_used ?? 0);
  const changes = changedNumbers(saved, typed);
  const problems = Object.fromEntries(changes.map((c) => [c.kind, nextNumberProblem(c.kind, typed[c.kind]!, highest(c.kind))]));

  const save = useMutation({
    meta: { inline: true },
    mutationFn: async () => {
      // All checked before any is saved, so one that's refused doesn't leave the others half done.
      if (changes.some((c) => problems[c.kind])) throw new Error("Fix the numbers marked above first.");
      for (const c of changes) unwrap(await supabase().rpc("set_next_number", { p_company: company.id, p_kind: c.kind, p_next: c.next }));
    },
    onSuccess: () => setTyped({}),
    // Read again however it went: one may have saved before another was refused.
    onSettled: () => queryClient.invalidateQueries({ queryKey: key }),
  });
  const done = useJustDone(save);

  if (numbers.isPending) return <Loading label="Loading the next numbers"><SectionSkeleton rows={2} /></Loading>;
  if (numbers.error) return <ErrorState error={numbers.error} onRetry={() => numbers.refetch()} />;

  return (
    <form onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(); }}>
      <Section level={3} title="Numbering">
        <p className="set-note">
          The number the next one of each gets. Coming from another system, set each to one more than the last you used there: 4311 if your last invoice was #4310. It can&apos;t be a number already used here, or one below it.
        </p>
        <div className="set-grid">
          {NUMBER_KINDS.map(({ kind, label }) => {
            const row = saved.find((s) => s.kind === kind);
            return (
              <Field key={kind} label={label} error={problems[kind]} hint={highest(kind) > 0 ? `The highest used so far is #${highest(kind)}.` : "None made yet."}>
                <NumberInput
                  className="input"
                  inputMode="numeric"
                  min={1}
                  max={HIGHEST_NUMBER}
                  step={1}
                  required
                  value={typed[kind] ?? String(row?.next_number ?? 1)}
                  onChange={(e) => setTyped({ ...typed, [kind]: e.target.value })}
                />
              </Field>
            );
          })}
        </div>
        <FormError error={save.error} />
        <div className={p.groupSave}>
          <Button type="submit" size="sm" loading={save.isPending} done={done} disabled={!changes.length}>Save numbers</Button>
          {changes.length > 0 && !save.isPending && <span className="set-save-note">{changes.length === 1 ? "1 unsaved change" : `${changes.length} unsaved changes`}</span>}
          <FormChecks />
        </div>
      </Section>
    </form>
  );
}
