/** Owner and admin controls for AI assistants (Claude, ChatGPT): on or off, read-only, and what they did. */
import { useMutation, useQuery } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/Skeleton";
import { supabase, unwrap } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import { useSession } from "@/lib/session";

const TOOL_LABELS: Record<string, string> = {
  search_clients: "Searched clients",
  get_client: "Looked at a client",
  list_requests: "Listed requests",
  create_request: "Logged a request",
  get_schedule: "Checked the schedule",
  add_note: "Added a note",
  search_sops: "Searched the knowledge base",
};

export function AssistantAccess() {
  const session = useSession();
  const { company } = session;
  const settings = (company.settings ?? {}) as { assistants?: { enabled?: boolean; read_only?: boolean } };
  const enabled = settings.assistants?.enabled !== false;
  const readOnly = settings.assistants?.read_only === true;
  const save = useMutation({
    meta: { success: "Saved" },
    mutationFn: async (patch: { enabled?: boolean; read_only?: boolean }) => {
      const current = unwrap(await supabase().from("companies").select("settings").eq("id", company.id).single());
      const s = (current.settings ?? {}) as Record<string, unknown>;
      unwrap(await supabase().from("companies").update({ settings: { ...s, assistants: { enabled, read_only: readOnly, ...(s.assistants as object), ...patch } } as never }).eq("id", company.id));
    },
    onSuccess: () => session.refresh(),
  });
  const calls = useQuery({
    queryKey: ["assistant-calls", company.id],
    queryFn: async () => {
      const rows = unwrap(await supabase().from("assistant_calls").select("id, user_id, tool, ok, detail, created_at").eq("company_id", company.id).order("created_at", { ascending: false }).limit(15));
      const ids = [...new Set(rows.map((r) => r.user_id).filter(Boolean))] as string[];
      const people = ids.length ? unwrap(await supabase().from("profiles").select("user_id, full_name").in("user_id", ids)) : [];
      const names = new Map(people.map((p) => [p.user_id, p.full_name]));
      return rows.map((r) => ({ ...r, who: (r.user_id && names.get(r.user_id)) || "Someone" }));
    },
  });

  return (
    <div className="stack-sm" style={{ borderTop: "1px solid var(--divider)", paddingTop: 12 }}>
      <label className="switch-row" style={{ fontWeight: 500 }}>
        <input type="checkbox" className="switch" checked={enabled} disabled={save.isPending} onChange={(e) => save.mutate({ enabled: e.target.checked })} />
        Let my team use AI assistants with Crewtavo
      </label>
      <label className="switch-row" style={{ fontWeight: 500, opacity: enabled ? 1 : 0.5 }}>
        <input type="checkbox" className="switch" checked={readOnly} disabled={!enabled || save.isPending} onChange={(e) => save.mutate({ read_only: e.target.checked })} />
        Look things up only (no new requests or notes)
      </label>
      <span className="muted small">Each person signs in with their own Crewtavo account, and an assistant can only see and do what that person's role allows.</span>
      <details className="more-options">
        <summary>Recent assistant activity</summary>
        {calls.isPending ? (
          <Skeleton height={60} radius={8} />
        ) : !calls.data?.length ? (
          <span className="muted small">Nothing yet.</span>
        ) : (
          <div className="card" style={{ boxShadow: "none" }}>
            {calls.data.map((c) => (
              <div key={c.id} className="card-row" style={{ fontSize: 13 }}>
                <span className="grow" style={{ minWidth: 0 }}>
                  <strong>{c.who}</strong> · {TOOL_LABELS[c.tool] ?? c.tool}
                  {!c.ok && <span style={{ color: "var(--danger)" }}> · didn't work{c.detail ? `: ${c.detail}` : ""}</span>}
                </span>
                <span className="muted small">{timeAgo(c.created_at)}</span>
              </div>
            ))}
          </div>
        )}
      </details>
    </div>
  );
}
