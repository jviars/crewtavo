import { canMakeResetLink, LEVEL_SUMMARY, type Role } from "@crewtavo/core/roles";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { Dialog } from "@/components/ui/Dialog";
import { Field, FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { MoneyInput } from "@/components/ui/MoneyInput";
import { TableSkeleton } from "@/components/ui/Skeleton";
import { ErrorState } from "@/components/ui/States";
import { StatusPill } from "@/components/ui/StatusPill";
import { initials } from "@/components/shell/AppShell";
import { api, supabase, unwrap } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { can, useSession } from "@/lib/session";
import { choiceFor, patchFor, roleChoices, roleName, useCompanyRoles } from "./roles";

export interface Member { user_id: string; role: Role; role_id: string | null; active: boolean; labor_rate: number | null; profile: { full_name: string; email: string | null; color: string | null } | null }

export function TeamSettings() {
  const session = useSession();
  const queryClient = useQueryClient();
  const [inviting, setInviting] = useState(false);
  const [resetting, setResetting] = useState<Member | null>(null);
  const team = useQuery({ queryKey: ["team", session.company.id], queryFn: () => api.get<Member[]>("/team") });
  const roles = useCompanyRoles();
  const update = useMutation({
    meta: { success: (_: unknown, v: { patch: { role?: Role; role_id?: string | null; active?: boolean; labor_rate?: number | null } }) => (v.patch.active === false ? "Access removed" : v.patch.active ? "Access restored" : "role_id" in v.patch ? "Role changed" : "Saved") },
    mutationFn: async ({ userId, patch }: { userId: string; patch: { role?: Role; role_id?: string | null; labor_rate?: number | null; active?: boolean } }) =>
      unwrap(await supabase().from("memberships").update(patch).eq("company_id", session.company.id).eq("user_id", userId)),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["team", session.company.id] });
      queryClient.invalidateQueries({ queryKey: ["dispatch-options", session.company.id] });
    },
  });
  const isOwner = session.role === "owner";
  const members = [...(team.data ?? [])].sort((a, b) => Number(b.active) - Number(a.active) || (a.profile?.full_name ?? "").localeCompare(b.profile?.full_name ?? ""));

  return (
    <div className="stack">
      <div className="row-between">
        <span className="muted">{members.filter((m) => m.active).length} people with access</span>
        <Button variant="primary" icon="plus" onClick={() => setInviting(true)}>Invite someone</Button>
      </div>
      {team.isPending ? <TableSkeleton columns={4} rows={4} /> : team.error ? <div className="card"><ErrorState error={team.error} onRetry={() => team.refetch()} /></div> : (
        <div className="card">
          <table className="table table-stack">
            <thead><tr><th>Person</th><th>Role</th><th className="num">Labor cost / hr</th><th>Access</th></tr></thead>
            <tbody>
              {members.map((m) => {
                const me = m.user_id === session.userId;
                const locked = me || (m.role === "owner" && !isOwner);
                const name = m.profile?.full_name || "Invited user";
                return (
                  <tr key={m.user_id} style={m.active ? undefined : { opacity: 0.6 }}>
                    <td>
                      <div className="row">
                        <span className="avatar" style={{ width: 32, height: 32, fontSize: 12, background: m.profile?.color || "var(--text-3)" }}>{initials(name)}</span>
                        <span>
                          <strong>{name}</strong>{me && <span className="chip" style={{ marginLeft: 6 }}>You</span>}<div className="muted small">{m.profile?.email}</div>
                          {m.active && !me && can(session, "team") && canMakeResetLink(session.role, m.role) && (
                            <button type="button" className="link-btn small" onClick={() => setResetting(m)}>Reset password</button>
                          )}
                        </span>
                      </div>
                    </td>
                    <td>
                      {locked ? <span>{roleName(m, roles.data)}</span> : (
                        <RolePicker value={choiceFor(m)} roles={roles.data} viewerIsOwner={isOwner || m.role === "owner"} disabled={!m.active} label={`Role for ${name}`} onChange={(choice) => update.mutate({ userId: m.user_id, patch: patchFor(choice) })} />
                      )}
                    </td>
                    <td className="num">
                      <MoneyInput value={Number(m.labor_rate ?? 0)} max={1000} width={110} label={`Labor cost for ${name}`} onSave={(v) => update.mutate({ userId: m.user_id, patch: { labor_rate: v || null } })} />
                    </td>
                    <td>
                      {locked ? <StatusPill label={m.active ? "Active" : "Removed"} tone={m.active ? "good" : "muted"} /> : (
                        <Button
                          size="sm"
                          variant={m.active ? "danger" : "secondary"}
                          onClick={async () => {
                            if (!m.active) return update.mutate({ userId: m.user_id, patch: { active: true } });
                            if (await confirm({ title: `Remove ${name}'s access?`, body: "They're signed out of this company right away. Their visits, time and notes stay on record, and you can restore access later.", confirmLabel: "Remove access", danger: true })) update.mutate({ userId: m.user_id, patch: { active: false } });
                          }}
                        >
                          {m.active ? "Remove" : "Restore"}
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {inviting && <InviteDialog onClose={() => setInviting(false)} />}
      {resetting && <ResetPasswordDialog member={resetting} onClose={() => setResetting(null)} />}
    </div>
  );
}

/**
 * A one-time link for someone to choose a new password, for when they're locked out (POST
 * /api/team/:id/password-link). Emailed when the company can send email; otherwise the admin hands
 * it over. Only for people below the admin's own level (canMakeResetLink).
 */
function ResetPasswordDialog({ member, onClose }: { member: Member; onClose: () => void }) {
  const session = useSession();
  const name = member.profile?.full_name || member.profile?.email || "this person";
  const first = name.split(/\s+/)[0];
  const reset = useMutation({
    meta: { inline: true },
    mutationFn: () => api.post<{ emailed: boolean; link: string | null }>(`/team/${member.user_id}/password-link`),
  });
  return (
    <Dialog open onClose={onClose} title={reset.data ? (reset.data.emailed ? "Reset link sent" : "Reset link ready") : `Reset ${first}'s password?`}>
      {reset.data ? (
        <div className="dialog-body">
          {reset.data.emailed ? (
            <div className="stack-sm" style={{ justifyItems: "center", textAlign: "center" }}>
              <span className="success-mark"><Icon name="check" size={30} strokeWidth={2.5} /></span>
              <p style={{ margin: 0 }}>We emailed {member.profile?.email ?? first} a link to choose a new password.</p>
              {session.config.features.devMail && <span className="muted small">Test mode: the email is in the local Mailpit inbox (http://localhost:56324).</span>}
            </div>
          ) : (
            <div className="stack-sm">
              <div className="callout callout-warning">
                <Icon name="lock" size={18} />
                <div className="grow small">
                  Give this link to {first} yourself, in person or by text. Whoever opens it can choose a new password for {first}'s account, so don't share it anywhere else. It works once and stops working within a day.
                </div>
              </div>
              <Button icon="copy" onClick={() => copyText(reset.data!.link!, "Reset link copied")}>Copy reset link</Button>
            </div>
          )}
          <p className="muted small" style={{ margin: 0 }}>{first} will see a note about this when they're back in, and it's in your activity log.</p>
          <div className="form-actions"><Button variant="primary" onClick={onClose}>Done</Button></div>
        </div>
      ) : (
        <div className="dialog-body">
          <p style={{ margin: 0 }}>This makes a one-time link for {name} to choose a new password. Their current password keeps working until they do.</p>
          <FormError error={reset.error} />
          <div className="form-actions">
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" icon="lock" loading={reset.isPending} onClick={() => reset.mutate()}>Make reset link</Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

function InviteDialog({ onClose }: { onClose: () => void }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const roles = useCompanyRoles();
  const [choice, setChoice] = useState<string | null>(null);
  const employee = roles.data?.find((r) => r.base_role === "field_crew");
  const picked = choice ?? (employee ? `role:${employee.id}` : "level:field_crew");
  const invite = useMutation({
    meta: { inline: true },
    mutationFn: () => {
      const patch = patchFor(picked);
      const level = patch.role ?? roles.data?.find((r) => r.id === patch.role_id)?.base_role ?? "field_crew";
      return api.post<{ invited: boolean; emailed: boolean; reason: string | null; link: string | null }>("/team/invite", { email: email.trim(), full_name: name.trim() || undefined, role: level, role_id: patch.role_id });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["team", session.company.id] }),
  });
  return (
    <Dialog open onClose={onClose} title={invite.data ? (invite.data.invited ? (invite.data.emailed ? "Invite sent" : "Invite ready") : "Added to your team") : "Invite someone"}>
      {invite.data ? (
        <div className="dialog-body">
          <div className="stack-sm" style={{ justifyItems: "center", textAlign: "center" }}>
            <span className="success-mark"><Icon name="check" size={30} strokeWidth={2.5} /></span>
            <p style={{ margin: 0 }}>
              {invite.data.invited
                ? invite.data.emailed ? `We emailed ${email} a link to set up their account.` : `${email} can join with the link below.`
                : `${email} already had an account and now has access.${invite.data.emailed ? " We emailed them to let them know." : ""}`}
            </p>
            {session.config.features.devMail && invite.data.emailed && <span className="muted small">Test mode: the email is in the local Mailpit inbox (http://localhost:56324).</span>}
          </div>
          {invite.data.link && (
            <div className="stack-sm">
              <div className="callout callout-info">
                <Icon name="info" size={18} />
                <div className="grow small">
                  {invite.data.reason ?? "Email isn't connected yet."} Copy the link and text it to them. It works once and expires in a day.
                  {can(session, "apps") || session.role === "owner" ? <> To send invites automatically, <Link to="/settings?tab=email">connect your email</Link>.</> : null}
                </div>
              </div>
              <Button icon="copy" onClick={() => copyText(invite.data!.link!, "Invite link copied")}>Copy invite link</Button>
            </div>
          )}
          <div className="form-actions"><Button variant="primary" onClick={onClose}>Done</Button></div>
        </div>
      ) : (
        <form onSubmit={(e: FormEvent) => { e.preventDefault(); invite.mutate(); }}>
          <div className="form-grid">
            <Field label="Email"><input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required maxLength={200} /></Field>
            <Field label="Name" optional><input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} /></Field>
          </div>
          <Field label="Role" hint={levelHint(picked, roles.data)}>
            <RolePicker value={picked} roles={roles.data} viewerIsOwner={session.role === "owner"} onChange={setChoice} label="Role" />
          </Field>
          <FormError error={invite.error} />
          <div className="form-actions">
            <Button onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="primary" icon="send" loading={invite.isPending}>Send invite</Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

function levelHint(choice: string, roles: ReturnType<typeof useCompanyRoles>["data"]): string {
  const patch = patchFor(choice);
  const level = patch.role ?? roles?.find((r) => r.id === patch.role_id)?.base_role;
  return level ? LEVEL_SUMMARY[level] : "";
}

function RolePicker({ value, roles, viewerIsOwner, disabled, label, onChange }: { value: string; roles: ReturnType<typeof useCompanyRoles>["data"]; viewerIsOwner: boolean; disabled?: boolean; label: string; onChange: (choice: string) => void }) {
  const choices = roleChoices(roles, viewerIsOwner);
  return (
    <select className="select input-sm" value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} aria-label={label}>
      {(["Your roles", "Built-in"] as const).map((g) => {
        const items = choices.filter((c) => c.group === g);
        return items.length ? <optgroup key={g} label={g}>{items.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}</optgroup> : null;
      })}
    </select>
  );
}
