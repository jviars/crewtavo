/**
 * Settings → Sales areas: the zip codes each salesperson covers, and who gets leads from everywhere
 * else. A new request goes to the person whose zip matches its property (the longest match, so
 * 46201 before 462), from any trade and any source, and a quote made from it goes to the same
 * person; whoever gets it is told. Kept in sales_areas and matched by the database
 * (supabase/migrations/20261110000200_sales_areas.sql). A zip is one person's.
 */
import { SALES } from "@crewtavo/core/roles";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Field, FormError } from "@/components/ui/Field";
import { SaveStatus, useSaveStatus } from "@/components/ui/SaveStatus";
import { CardSkeleton, Loading } from "@/components/ui/Skeleton";
import { ErrorState } from "@/components/ui/States";
import { api, supabase, unwrap } from "@/lib/api";
import { useSession } from "@/lib/session";
import { parseZips } from "./salesAreas";
import type { Member } from "./TeamSettings";

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

  if (data.isPending) return <Loading label="Loading your sales areas"><CardSkeleton lines={4} /></Loading>;
  if (data.error) return <div className="card"><ErrorState error={data.error} onRetry={() => data.refetch()} /></div>;

  const { areas, team } = data.data;
  const zipsOf = (userId: string) => areas.filter((a) => a.user_id === userId && a.zip !== "").map((a) => a.zip);
  const elseUser = areas.find((a) => a.zip === "")?.user_id ?? "";
  // The people who sell, and anyone who has left but still has zips (so they can be handed on).
  const people = team
    .filter((m) => (m.active && SALES.includes(m.role)) || areas.some((a) => a.user_id === m.user_id))
    .sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
  const ownerOf = (zip: string) => team.find((m) => m.user_id === areas.find((a) => a.zip === zip)?.user_id);

  return (
    <div className="stack">
      <p className="muted" style={{ margin: 0 }}>
        New requests go to the salesperson who covers the property's zip code, from your forms, the phone or anywhere else, and a quote made from one goes to the same person. They get a notification. Put in whole zip codes, or the first digits for a wider area: 462 covers every zip that starts with 462, and 46201 still goes to whoever has it.
      </p>
      <section className="card card-pad stack" aria-labelledby="sales-areas-title">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h2 id="sales-areas-title" className="section-title" style={{ margin: 0 }}>Who covers where</h2>
          <SaveStatus status={saving.status} />
        </div>
        {people.map((m) => (
          <ZipField
            key={`${m.user_id}:${zipsOf(m.user_id).join()}`}
            label={`${nameOf(m)}${m.active ? "" : " (no longer on the team)"}`}
            zips={zipsOf(m.user_id)}
            takenBy={(zip) => {
              const owner = ownerOf(zip);
              return owner && owner.user_id !== m.user_id ? nameOf(owner) : null;
            }}
            onSave={(add, drop) => void saving.track(setZips.mutateAsync({ userId: m.user_id, add, drop }))}
          />
        ))}
        <Field label="Everywhere else" hint="A request from a zip nobody covers, or with no address.">
          <select className="select" value={elseUser} onChange={(e) => void saving.track(setElse.mutateAsync(e.target.value))}>
            <option value="">Nobody: leave it unassigned</option>
            {people.map((m) => <option key={m.user_id} value={m.user_id}>{nameOf(m)}</option>)}
          </select>
        </Field>
        <FormError error={setZips.error ?? setElse.error} />
      </section>
    </div>
  );
}

/** One salesperson's zips, saved when they leave the box. */
function ZipField({ label, zips, takenBy, onSave }: { label: string; zips: string[]; takenBy: (zip: string) => string | null; onSave: (add: string[], drop: string[]) => void }) {
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <Field label={label} error={problem}>
      <input
        className="input"
        defaultValue={zips.join(", ")}
        placeholder="Like 46201, 46202, 462"
        onBlur={(e) => {
          const typed = parseZips(e.target.value);
          if (typed.bad.length) return setProblem(`${typed.bad.join(", ")} ${typed.bad.length === 1 ? "isn't a zip code" : "aren't zip codes"}.`);
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
