/**
 * Settings → Sales areas: the zip codes each salesperson covers, and who gets leads from everywhere
 * else. A new request goes to the person whose zip matches its property (the longest match, so
 * 46201 before 462), from any trade and any source, and a quote made from it goes to the same
 * person; whoever gets it is told. Kept in sales_areas and matched by the database
 * (supabase/migrations/20261110000200_sales_areas.sql). A zip is one person's.
 */
import { businessCountry } from "@crewtavo/core/countries";
import { SALES } from "@crewtavo/core/roles";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Field, FormError } from "@/components/ui/Field";
import { SaveStatus, useSaveStatus } from "@/components/ui/SaveStatus";
import { Face } from "@/components/ui/Avatar";
import { Section } from "@/components/ui/Section";
import { Loading, SectionSkeleton } from "@/components/ui/Skeleton";
import { ErrorState } from "@/components/ui/States";
import { api, supabase, unwrap } from "@/lib/api";
import { useSession } from "@/lib/session";
import { areaWords, parseZips, type AreaWords } from "./salesAreas";
import styles from "./settings.module.css";
import type { Member } from "./TeamSettings";
import { Select } from "@/components/ui/Select";

const nameOf = (m: Member) => m.profile?.full_name || m.profile?.email || "Team member";

export function SalesAreaSettings() {
  const { company } = useSession();
  const queryClient = useQueryClient();
  const key = ["sales-areas", company.id];
  const data = useQuery({
    queryKey: key,
    queryFn: async () => {
      const [areas, team] = await Promise.all([supabase().from("sales_areas").select("zip, user_id").eq("company_id", company.id).order("zip"), api.get<Member[]>("/team")]);
      return { areas: unwrap(areas), team };
    },
  });
  const saving = useSaveStatus();
  const refresh = () => void queryClient.invalidateQueries({ queryKey: key });
  const setZips = useMutation({
    meta: { inline: true },
    mutationFn: async ({ userId, add, drop }: { userId: string; add: string[]; drop: string[] }) => {
      const db = supabase();
      if (drop.length) unwrap(await db.from("sales_areas").delete().eq("company_id", company.id).eq("user_id", userId).in("zip", drop));
      if (add.length) unwrap(await db.from("sales_areas").insert(add.map((zip) => ({ company_id: company.id, user_id: userId, zip }))));
    },
    onSettled: refresh,
  });
  const setElse = useMutation({
    meta: { inline: true },
    mutationFn: async (userId: string) =>
      unwrap(
        userId
          ? await supabase().from("sales_areas").upsert({ company_id: company.id, zip: "", user_id: userId })
          : await supabase().from("sales_areas").delete().eq("company_id", company.id).eq("zip", ""),
      ),
    onSettled: refresh,
  });

  if (data.isPending) return <Loading label="Loading your sales areas"><SectionSkeleton rows={4} /></Loading>;
  if (data.error) return <ErrorState error={data.error} onRetry={() => data.refetch()} />;

  const { areas, team } = data.data;
  const zipsOf = (userId: string) => areas.filter((a) => a.user_id === userId && a.zip !== "").map((a) => a.zip);
  const elseUser = areas.find((a) => a.zip === "")?.user_id ?? "";
  // The people who sell, and anyone who has left but still has zips (so they can be handed on).
  const people = team
    .filter((m) => (m.active && SALES.includes(m.role)) || areas.some((a) => a.user_id === m.user_id))
    .sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
  const ownerOf = (zip: string) => team.find((m) => m.user_id === areas.find((a) => a.zip === zip)?.user_id);
  const words = areaWords(businessCountry(company));

  return (
    <Section level={3} title="Who covers where" action={<SaveStatus status={saving.status} />}>
      <p className="set-note">{words.note}</p>
      <div className={styles.zips}>
        {people.map((m) => (
          <ZipField
            key={`${m.user_id}:${zipsOf(m.user_id).join()}`}
            person={m}
            words={words}
            label={`${nameOf(m)}${m.active ? "" : " (no longer on the team)"}`}
            zips={zipsOf(m.user_id)}
            takenBy={(zip) => {
              const owner = ownerOf(zip);
              return owner && owner.user_id !== m.user_id ? nameOf(owner) : null;
            }}
            onSave={(add, drop) => void saving.track(setZips.mutateAsync({ userId: m.user_id, add, drop }))}
          />
        ))}
        <Field label="Everywhere else" hint={`A request from a ${words.code} nobody covers, or with no address.`} className={styles.zip}>
          <Select className="select" value={elseUser} onChange={(e) => void saving.track(setElse.mutateAsync(e.target.value))}>
            <option value="">Nobody: leave it unassigned</option>
            {people.map((m) => <option key={m.user_id} value={m.user_id}>{nameOf(m)}</option>)}
          </Select>
        </Field>
      </div>
      <FormError error={setZips.error ?? setElse.error} />
    </Section>
  );
}

/** One salesperson's zips, saved when they leave the box. */
function ZipField({ person, words, label, zips, takenBy, onSave }: { person: Member; words: AreaWords; label: string; zips: string[]; takenBy: (zip: string) => string | null; onSave: (add: string[], drop: string[]) => void }) {
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <Field label={<span className={styles.zipWho}><span className="avatar" aria-hidden="true" style={{ background: person.profile?.color || "var(--avatar)" }}><Face name={nameOf(person)} photo={person.profile?.avatar_url} /></span>{label}</span>} error={problem} className={styles.zip}>
      <input
        className="input"
        defaultValue={zips.join(", ")}
        placeholder={words.placeholder}
        onBlur={(e) => {
          const typed = parseZips(e.target.value);
          if (typed.bad.length) return setProblem(`${typed.bad.join(", ")} ${typed.bad.length === 1 ? `isn't a ${words.code}` : `aren't ${words.codes}`}.`);
          const taken = typed.zips.find((z) => takenBy(z));
          if (taken) return setProblem(`${taken} is ${takenBy(taken)}'s already. Take it off them first.`);
          setProblem(null);
          const add = typed.zips.filter((z) => !zips.includes(z));
          const drop = zips.filter((z) => !typed.zips.includes(z));
          if (add.length || drop.length) onSave(add, drop);
        }}
      />
    </Field>
  );
}
