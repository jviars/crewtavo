/**
 * AI assistants (Claude, ChatGPT): the ones you've connected, each only reading until you choose what
 * it can change or give it full access; and owner and admin controls for the company: on or off,
 * read-only, and what they did.
 */
import { ASSISTANT_AREA_GROUPS, ASSISTANT_AREAS, ASSISTANT_TOOL_LABELS, areasForRole, describeAssistantAccess, type AssistantAccess as Access, type AssistantArea } from "@crewtavo/core/assistants";
import { PERMISSIONS } from "@crewtavo/core/roles";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Button, cx } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { Dialog } from "@/components/ui/Dialog";
import { FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { Section } from "@/components/ui/Section";
import { EmptyState } from "@/components/ui/States";
import { supabase, unwrap } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import { useSession } from "@/lib/session";
import { Fold, kit, Row, RowsSkeleton, SwitchLine } from "./PanelKit";
import { disconnect, endTeamConnection, loadConnections, loadTeamConnections, setAccess, type AssistantConnection, type TeamConnection } from "./assistantConnections";
import { loadSettings } from "@/lib/companySettings";

/** The assistants the signed-in person has connected; `poll` checks again every so many milliseconds. */
export function useAssistantConnections(poll: number | false = false) {
  const session = useSession();
  return useQuery({ queryKey: ["assistant-connections", session.userId], queryFn: () => loadConnections(supabase()), refetchInterval: poll });
}

export function AssistantAccess() {
  const session = useSession();
  const { company } = session;
  const settings = (company.settings ?? {}) as { assistants?: { enabled?: boolean; read_only?: boolean } };
  const enabled = settings.assistants?.enabled !== false;
  const readOnly = settings.assistants?.read_only === true;
  // The switches change in place, which says it worked.
  const save = useMutation({
    mutationFn: async (patch: { enabled?: boolean; read_only?: boolean }) => {
      const s = await loadSettings(company.id);
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
    <div className={cx(kit.form, kit.flushTop)}>
      <div className={kit.rows}>
        <SwitchLine label="Let my team use AI assistants with Crewtavo" checked={enabled} disabled={save.isPending} onChange={(on) => save.mutate({ enabled: on })} />
        <SwitchLine label="Look things up only, whatever each person allows" checked={readOnly} disabled={!enabled || save.isPending} onChange={(on) => save.mutate({ read_only: on })} />
      </div>
      <p className={kit.note}>Each person signs in with their own Crewtavo account, and an assistant can only see and do what that person's role allows.</p>
      <Fold summary="Recent assistant activity">
        {calls.isPending ? (
          <RowsSkeleton rows={2} />
        ) : !calls.data?.length ? (
          <p className={kit.note}>Nothing yet.</p>
        ) : (
          <div className={cx(kit.rows, kit.compact)}>
            {calls.data.map((c) => (
              <Row
                key={c.id}
                title={<>{c.who}<span className={kit.quiet}> · {ASSISTANT_TOOL_LABELS[c.tool] ?? c.tool}</span></>}
                problem={c.ok ? null : `Didn't work${c.detail ? `: ${c.detail}` : ""}`}
                end={<span className={kit.rowTime}>{timeAgo(c.created_at)}</span>}
              />
            ))}
          </div>
        )}
      </Fold>
    </div>
  );
}

/** An assistant's logo on a small white tile, or its first letter. */
function Logo({ src, name }: { src: string | null; name: string }) {
  return <span className={kit.logo} aria-hidden="true">{src ? <img src={src} alt="" /> : name.slice(0, 1)}</span>;
}

/**
 * Every assistant anyone on the team has connected, for the owner alone: who connected which, what
 * they let it change, and Disconnect, which ends it for that person as their own Disconnect would.
 * Turning assistants off above stops them all at once; this is for ending one for good.
 */
export function TeamAssistants() {
  const session = useSession();
  const queryClient = useQueryClient();
  const key = ["team-assistant-connections", session.company.id];
  const team = useQuery({ queryKey: key, queryFn: loadTeamConnections });
  const end = useMutation({
    meta: { success: "Disconnected" },
    mutationFn: (c: TeamConnection) => endTeamConnection(c),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: key });
      // The owner's own are in this list too.
      queryClient.invalidateQueries({ queryKey: ["assistant-connections", session.userId] });
    },
  });
  const askEnd = async (c: TeamConnection) => {
    const mine = c.userId === session.userId;
    const title = `Disconnect ${c.name} from ${mine ? "your" : `${c.person}'s`} sign-in?`;
    const body = `It stops working with Crewtavo for ${mine ? "you" : c.person}. ${mine ? "You" : "They"} can connect it again, and it starts out only reading.`;
    if (await confirm({ title, body, confirmLabel: "Disconnect", danger: true })) end.mutate(c);
  };

  return (
    <Section level={3} title="Your team's connected assistants" count={team.data?.length || undefined} className={kit.panel}>
      <p className={kit.note}>Everyone who has connected an assistant, and what they let it change. Only you, as an owner, see this list.</p>
      {team.isPending ? (
        <RowsSkeleton rows={1} />
      ) : team.error ? (
        <p className={kit.note}>{(team.error as Error).message}</p>
      ) : !team.data.length ? (
        <EmptyState inline title="Nobody has connected one yet." />
      ) : (
        <div className={kit.rows}>
          {team.data.map((c) => (
            <Row
              key={`${c.userId} ${c.clientId}`}
              lead={<Logo src={c.logo} name={c.name} />}
              title={<>{c.person}<span className={kit.quiet}> · {c.name}</span></>}
              sub={`Connected ${timeAgo(c.connectedAt)} · ${describeAssistantAccess(c.access)}`}
              end={
                <Button size="sm" variant="ghost" loading={end.isPending && end.variables === c} disabled={end.isPending} onClick={() => askEnd(c)} aria-label={`Disconnect ${c.name} from ${c.person}'s sign-in`}>
                  Disconnect
                </Button>
              }
            />
          ))}
        </div>
      )}
    </Section>
  );
}

/**
 * The assistants this person has connected, with what each can change. Everyone has it in Settings
 * → AI assistants, whatever their role: the one place assistants are connected and managed.
 */
export function ConnectedAssistants({ card = false }: { card?: boolean }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const key = ["assistant-connections", session.userId];
  const settings = (session.company.settings ?? {}) as { assistants?: { enabled?: boolean; read_only?: boolean } };
  // The company's own setting comes first (AssistantAccess above).
  const companyNote =
    settings.assistants?.enabled === false
      ? `AI assistants are turned off for ${session.company.name} for now.`
      : settings.assistants?.read_only === true
        ? `For now ${session.company.name} only lets assistants look things up, whatever you choose here.`
        : null;
  const connections = useAssistantConnections();
  const shown = connections.data ?? [];
  const [editing, setEditing] = useState<AssistantConnection | null>(null);
  const remove = useMutation({
    meta: { success: "Disconnected" },
    mutationFn: (clientId: string) => disconnect(supabase(), clientId),
    onSettled: () => queryClient.invalidateQueries({ queryKey: key }),
  });
  const askDisconnect = async (c: AssistantConnection) => {
    const body = "It stops working with Crewtavo. You can connect it again any time, and it starts out only reading.";
    if (await confirm({ title: `Disconnect ${c.name}?`, body, confirmLabel: "Disconnect", danger: true })) remove.mutate(c.clientId);
  };

  return (
    <Section level={card ? 2 : 3} title="Your connected assistants" count={shown.length || undefined} className={kit.panel}>
      <p className={kit.note}>
        An assistant you connect can look things up, but can't add or change anything until you choose what it can change. Only one with full access can delete.
      </p>
      {connections.isPending ? (
        <RowsSkeleton rows={1} />
      ) : connections.error ? (
        <p className={kit.note}>{(connections.error as Error).message}</p>
      ) : !shown.length ? (
        <EmptyState inline title="None yet. Once you connect one with the link above, it shows up here." />
      ) : (
        <div className={kit.rows}>
          {shown.map((c) => (
            <Row
              key={c.clientId}
              lead={<Logo src={c.logo} name={c.name} />}
              title={c.name}
              sub={`Connected ${timeAgo(c.connectedAt)} · ${describeAssistantAccess(c.access)}`}
              end={
                <>
                  <Button size="sm" icon="lock" disabled={remove.isPending} onClick={() => setEditing(c)} aria-label={`What ${c.name} can change`}>
                    Access
                  </Button>
                  <Button size="sm" variant="ghost" loading={remove.isPending && remove.variables === c.clientId} disabled={remove.isPending} onClick={() => askDisconnect(c)}>
                    Disconnect
                  </Button>
                </>
              }
            />
          ))}
        </div>
      )}
      {companyNote && (
        <div className="callout callout-info" role="note">
          <Icon name="info" size={16} />
          <div className="grow">{companyNote}</div>
        </div>
      )}
      {editing && <AccessDialog connection={editing} onClose={() => setEditing(null)} />}
    </Section>
  );
}

const LEVELS: Array<{ level: Access["level"]; label: string; hint: string }> = [
  { level: "read", label: "Read only", hint: "Looks things up. Can't add or change anything." },
  { level: "areas", label: "Choose what it can change", hint: "Adds and changes things in the areas you tick, but doesn't delete." },
  { level: "full", label: "Full access", hint: "Everything you can change, including deleting, people and money." },
  { level: "full_no_money", label: "Full access, no money", hint: "Everything you can change, including deleting, except prices, quotes, invoices, payments, pay and promo codes." },
];

/** What each full level lets it do, for the warning before giving it. */
const FULL_WARNING: Record<"full" | "full_no_money", (name: string) => { title: string; body: string; confirmLabel: string }> = {
  full: (name) => ({
    title: `Give ${name} full access?`,
    body: `${name} will be able to add, change and delete anything you can in Crewtavo: clients, jobs and the schedule, prices, quotes, invoices and payments, people and roles, time and pay, marketing and promo codes, and the business's setup. It still can't change anyone's sign-in or password, connected apps and keys, or its own access, and it can't refund or delete payments. It sends quotes and invoices only to the client and their contacts on file, and invites only crew leads and field crew. Everything it does shows in Recent assistant activity, and you can switch it back to Read only any time.`,
    confirmLabel: "Give full access",
  }),
  full_no_money: (name) => ({
    title: `Give ${name} full access, without money?`,
    body: `${name} will be able to add, change and delete anything you can in Crewtavo except money: clients, jobs and the schedule, people and roles (it invites only crew leads and field crew), time, marketing, and the business's setup. It can't change what clients pay (the price list, job prices and billing, extra work, tax, payment terms, the minimum charge, late fees and tips), quotes, invoices, payments, pay or promo codes, anyone's sign-in or password, connected apps and keys, or its own access. Everything it does shows in Recent assistant activity, and you can switch it back to Read only any time.`,
    confirmLabel: "Give full access",
  }),
};

function savedMessage(name: string, access: Access) {
  if (access.level === "full") return `${name} has full access now`;
  if (access.level === "full_no_money") return `${name} has full access, without money, now`;
  if (access.level === "areas") return `${name} can change ${access.areas.map((a) => ASSISTANT_AREAS.find((x) => x.key === a)?.label.toLowerCase() ?? a).join(", ")} now`;
  return `${name} can only read now`;
}

/** Read only, chosen areas, or full access with or without money, which asks first. Areas the person's role can't change aren't offered. */
function AccessDialog({ connection, onClose }: { connection: AssistantConnection; onClose: () => void }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const offered = areasForRole(session.role, session.role === "owner" ? PERMISSIONS.map((p) => p.key) : session.permissions);
  const [level, setLevel] = useState(connection.access.level);
  const [areas, setAreas] = useState<AssistantArea[]>(connection.access.areas.filter((a) => offered.includes(a)));
  const toggle = (area: AssistantArea, on: boolean) => setAreas(on ? [...areas, area] : areas.filter((a) => a !== area));
  const save = useMutation({
    meta: { inline: true, success: (saved: Access | null) => (saved ? savedMessage(connection.name, saved) : null) },
    mutationFn: async (): Promise<Access | null> => {
      const access: Access = level === "areas" && !areas.length ? { level: "read", areas: [] } : { level, areas: level === "areas" ? areas : [] };
      if ((access.level === "full" || access.level === "full_no_money") && connection.access.level !== access.level) {
        if (!(await confirm({ ...FULL_WARNING[access.level](connection.name), danger: true }))) return null;
      }
      await setAccess(supabase(), session.userId, connection.clientId, access);
      return access;
    },
    onSuccess: (saved) => {
      if (!saved) return;
      queryClient.invalidateQueries({ queryKey: ["assistant-connections", session.userId] });
      onClose();
    },
  });

  return (
    <Dialog open onClose={onClose} title={`What ${connection.name} can change`} description="It always sees only what your role lets you see.">
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(); }}>
        <fieldset className={kit.choices}>
          <legend className="sr-only">Access</legend>
          {LEVELS.map((l) => (
            <label key={l.level} className={kit.choice}>
              <input type="radio" name="access" checked={level === l.level} onChange={() => setLevel(l.level)} />
              <span className={kit.rowText}>
                <span className={kit.rowTitle}><span>{l.label}</span></span>
                <span className={kit.rowSub}>{l.hint}</span>
              </span>
            </label>
          ))}
        </fieldset>
        {level === "areas" && (
          <fieldset className={kit.areas}>
            <legend className={kit.label}>It can change</legend>
            {ASSISTANT_AREA_GROUPS.map((group) => (
              <div key={group} className={kit.areaGroup}>
                <span className={kit.groupLabel}>{group}</span>
                {ASSISTANT_AREAS.filter((a) => a.group === group).map((a) => {
                  const allowed = offered.includes(a.key);
                  return (
                    <label key={a.key} className="checkbox" data-off={allowed ? undefined : true}>
                      <input type="checkbox" checked={allowed && areas.includes(a.key)} disabled={!allowed} onChange={(e) => toggle(a.key, e.target.checked)} />
                      <span>
                        {a.label}
                        {!allowed && <span className={kit.hint} style={{ display: "block" }}>Your role can't change this</span>}
                      </span>
                    </label>
                  );
                })}
              </div>
            ))}
            {!areas.length && <p className={kit.note}>Tick at least one, or it stays read only.</p>}
          </fieldset>
        )}
        <FormError error={save.error} />
        <div className="form-actions">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending}>Save</Button>
        </div>
      </form>
    </Dialog>
  );
}
