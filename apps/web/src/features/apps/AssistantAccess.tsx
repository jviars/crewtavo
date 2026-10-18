/**
 * AI assistants (Claude, ChatGPT): the ones you've connected, each only reading until you let it
 * change things; and owner and admin controls for the company: on or off, read-only, and what
 * they did.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { Skeleton } from "@/components/ui/Skeleton";
import { supabase, unwrap } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import { useSession } from "@/lib/session";
import { disconnect, loadConnections, setAllowChanges, type AssistantConnection } from "./assistantConnections";

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

/** The assistants this person has connected. Each one only reads until they turn on Allow changes. */
export function ConnectedAssistants() {
  const session = useSession();
  const queryClient = useQueryClient();
  const key = ["assistant-connections", session.userId];
  const settings = (session.company.settings ?? {}) as { assistants?: { enabled?: boolean; read_only?: boolean } };
  // The company's own setting comes first (AssistantAccess below).
  const companyNote =
    settings.assistants?.enabled === false
      ? `AI assistants are turned off for ${session.company.name} for now.`
      : settings.assistants?.read_only === true
        ? `For now ${session.company.name} only lets assistants look things up, however this is set.`
        : null;
  const connections = useQuery({ queryKey: key, queryFn: () => loadConnections(supabase()) });
  const refresh = () => queryClient.invalidateQueries({ queryKey: key });
  const toggle = useMutation({
    meta: { success: (_: never, v: { allow: boolean }) => (v.allow ? "It can make changes now" : "It can only read now") },
    mutationFn: (v: { clientId: string; allow: boolean }) => setAllowChanges(supabase(), session.userId, v.clientId, v.allow),
    onSettled: refresh,
  });
  const remove = useMutation({
    meta: { success: "Disconnected" },
    mutationFn: (clientId: string) => disconnect(supabase(), clientId),
    onSettled: refresh,
  });
  const askDisconnect = async (c: AssistantConnection) => {
    const body = "It stops working with Crewtavo. You can connect it again any time, and it starts out only reading.";
    if (await confirm({ title: `Disconnect ${c.name}?`, body, confirmLabel: "Disconnect", danger: true })) remove.mutate(c.clientId);
  };

  return (
    <div className="stack-sm" style={{ borderTop: "1px solid var(--divider)", paddingTop: 12 }}>
      <strong>Your connected assistants</strong>
      <span className="muted small">
        An assistant you connect can look things up, but can't add or change anything until you turn on Allow changes for it. Assistants connected before this switch
        was added can only read too, until you turn it on.
      </span>
      {connections.isPending ? (
        <Skeleton height={52} radius={8} />
      ) : connections.error ? (
        <span className="muted small">{(connections.error as Error).message}</span>
      ) : !connections.data.length ? (
        <span className="muted small">None yet. Once you connect one with the steps above, it shows up here.</span>
      ) : (
        <div className="card" style={{ boxShadow: "none" }}>
          {connections.data.map((c) => (
            <div key={c.clientId} className="card-row" style={{ gap: 10, flexWrap: "wrap" }}>
              <span className="app-icon" data-size="sm" aria-hidden="true">
                {c.logo ? <img src={c.logo} alt="" /> : <span className="app-icon-letter">{c.name.slice(0, 1)}</span>}
              </span>
              <span className="grow" style={{ minWidth: 0 }}>
                <strong>{c.name}</strong>
                <span className="muted small" style={{ display: "block" }}>
                  Connected {timeAgo(c.connectedAt)} · {c.allowChanges ? "can make changes" : "can only read"}
                </span>
              </span>
              <label className="switch-row small">
                <input
                  type="checkbox"
                  className="switch"
                  // Shows the new setting while it saves.
                  checked={toggle.isPending && toggle.variables.clientId === c.clientId ? toggle.variables.allow : c.allowChanges}
                  disabled={toggle.isPending || remove.isPending}
                  onChange={(e) => toggle.mutate({ clientId: c.clientId, allow: e.target.checked })}
                  aria-label={`Allow changes for ${c.name}`}
                />
                Allow changes
              </label>
              <Button size="sm" variant="ghost" loading={remove.isPending && remove.variables === c.clientId} disabled={remove.isPending} onClick={() => askDisconnect(c)}>
                Disconnect
              </Button>
            </div>
          ))}
        </div>
      )}
      {companyNote && <span className="muted small">{companyNote}</span>}
    </div>
  );
}
