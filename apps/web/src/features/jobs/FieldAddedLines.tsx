/** The job's lines the crew added on site (add_field_line), with who and when, for the office to look over. */
import { useQuery } from "@tanstack/react-query";
import { Icon } from "@/components/ui/Icon";
import { supabase, unwrap } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { useSession } from "@/lib/session";

interface FieldLine {
  id: string;
  name: string;
  quantity: number;
  unit: string;
  added_in_field_by: string | null;
  added_in_field_at: string | null;
}

const qty = (n: number) => new Intl.NumberFormat("en-US", { maximumFractionDigits: 3 }).format(n);

export function FieldAddedLines({ jobId, lines }: { jobId: string; lines: readonly FieldLine[] }) {
  const { company } = useSession();
  const added = lines.filter((l) => l.added_in_field_at);
  const ids = [...new Set(added.flatMap((l) => (l.added_in_field_by ? [l.added_in_field_by] : [])))].sort();
  const people = useQuery({
    queryKey: ["job", jobId, "added-by", ids],
    enabled: ids.length > 0,
    staleTime: 5 * 60_000,
    meta: { silent: true },
    queryFn: async () => unwrap(await supabase().from("profiles").select("user_id, full_name").in("user_id", ids)),
  });
  if (!added.length) return null;
  const who = (id: string | null) => people.data?.find((p) => p.user_id === id)?.full_name || "The crew";
  return (
    <div className="callout callout-info">
      <Icon name="truck" size={20} />
      <div className="grow stack-sm">
        <strong>Added in the field</strong>
        {added.map((l) => (
          <span key={l.id} className="small">
            {l.name} · {qty(Number(l.quantity))} {l.unit} · {who(l.added_in_field_by)}, {formatDateTime(l.added_in_field_at!, company.timezone)}
          </span>
        ))}
      </div>
    </div>
  );
}
