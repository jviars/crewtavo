/** Roles: name a role, pick its access level, and choose which areas it includes. */
import { LEVEL_PERMISSIONS, LEVEL_SUMMARY, PERMISSIONS, ROLE_LABELS, ROLES, type Permission, type Role } from "@crewtavo/core/roles";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { Dialog } from "@/components/ui/Dialog";
import { Field, FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { CardSkeleton, Loading } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState } from "@/components/ui/States";
import { api, supabase, unwrap } from "@/lib/api";
import { useSession } from "@/lib/session";
import { useCompanyRoles, type CompanyRole } from "./roles";

const LEVELS = ROLES.filter((r) => r !== "owner");
const label = (p: Permission) => PERMISSIONS.find((x) => x.key === p)?.label ?? p;

export function RolesSettings() {
  const session = useSession();
  const queryClient = useQueryClient();
  const roles = useCompanyRoles();
  const team = useQuery({ queryKey: ["team", session.company.id], queryFn: () => api.get<Array<{ role_id: string | null; active: boolean }>>("/team") });
  const [editing, setEditing] = useState<CompanyRole | "new" | null>(null);
  const remove = useMutation({
    meta: { success: "Role deleted" },
    mutationFn: async (id: string) => unwrap(await supabase().from("company_roles").delete().eq("id", id)),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["company-roles", session.company.id] });
      queryClient.invalidateQueries({ queryKey: ["team", session.company.id] });
    },
  });
  const count = (id: string) => team.data?.filter((m) => m.active && m.role_id === id).length ?? 0;

  return (
    <div className="stack">
      <div className="row-between">
        <span />
        <Button variant="primary" icon="plus" onClick={() => setEditing("new")}>New role</Button>
      </div>
      {roles.error ? (
        <div className="card"><ErrorState error={roles.error} onRetry={() => roles.refetch()} /></div>
      ) : roles.isPending ? (
        <Loading label="Loading roles"><div className="grid-cards">{[0, 1, 2].map((i) => <CardSkeleton key={i} lines={3} />)}</div></Loading>
      ) : roles.data.length === 0 ? (
        <div className="card"><EmptyState icon="lock" title="No custom roles yet" action={<Button variant="primary" icon="plus" onClick={() => setEditing("new")}>New role</Button>} /></div>
      ) : (
        <div className="grid-cards">
          {roles.data.map((r) => (
            <div key={r.id} className="card card-pad stack-sm role-card">
              <div className="row-between" style={{ alignItems: "flex-start" }}>
                <div className="stack-sm" style={{ gap: 2 }}>
                  <strong style={{ fontSize: 16 }}>{r.name}</strong>
                  <span className="muted small">{ROLE_LABELS[r.base_role]} access · {count(r.id)} {count(r.id) === 1 ? "person" : "people"}</span>
                </div>
                <div className="row" style={{ gap: 2 }}>
                  <button type="button" className="icon-btn" aria-label={`Edit ${r.name}`} onClick={() => setEditing(r)}><Icon name="edit" size={16} /></button>
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label={`Delete ${r.name}`}
                    onClick={async () => {
                      const n = count(r.id);
                      if (await confirm({ title: `Delete “${r.name}”?`, body: n ? `${n} ${n === 1 ? "person has" : "people have"} this role. They keep ${ROLE_LABELS[r.base_role]} access.` : undefined, confirmLabel: "Delete role", danger: true })) remove.mutate(r.id);
                    }}
                  >
                    <Icon name="trash" size={16} />
                  </button>
                </div>
              </div>
              <div className="row wrap" style={{ gap: 6 }}>
                {r.permissions.length ? r.permissions.map((p) => <span key={p} className="chip">{label(p)}</span>) : <span className="muted small">Their own work only</span>}
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="card">
        <div className="card-head"><strong>Built-in roles</strong></div>
        {ROLES.map((r) => (
          <div key={r} className="card-row" style={{ alignItems: "flex-start" }}>
            <strong style={{ width: 110, flex: "none" }}>{ROLE_LABELS[r]}</strong>
            <span className="muted small">{LEVEL_SUMMARY[r]}</span>
          </div>
        ))}
      </div>
      {editing && <RoleDialog role={editing === "new" ? null : editing} existing={roles.data ?? []} onClose={() => setEditing(null)} />}
    </div>
  );
}

function RoleDialog({ role, existing, onClose }: { role: CompanyRole | null; existing: CompanyRole[]; onClose: () => void }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const [name, setName] = useState(role?.name ?? "");
  const [level, setLevel] = useState<Role>(role?.base_role ?? "office");
  const [perms, setPerms] = useState<Permission[]>(role?.permissions ?? [...LEVEL_PERMISSIONS.office]);
  const allowed = LEVEL_PERMISSIONS[level];

  const save = useMutation({
    meta: { inline: true, success: role ? "Role saved" : "Role created" },
    mutationFn: async () => {
      const clean = name.trim();
      if (!clean) throw new Error("Give the role a name.");
      if (existing.some((r) => r.id !== role?.id && r.name.trim().toLowerCase() === clean.toLowerCase())) throw new Error("There's already a role with that name.");
      const row = { name: clean, base_role: level, permissions: perms.filter((p) => allowed.includes(p)) };
      if (role) unwrap(await supabase().from("company_roles").update(row).eq("id", role.id));
      else unwrap(await supabase().from("company_roles").insert({ ...row, company_id: session.company.id }));
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["company-roles", session.company.id] });
      queryClient.invalidateQueries({ queryKey: ["team", session.company.id] });
      onClose();
    },
  });

  const changeLevel = (next: Role) => {
    setLevel(next);
    // Keep what still applies; a brand-new role starts with everything the level allows.
    setPerms(role ? perms.filter((p) => LEVEL_PERMISSIONS[next].includes(p)) : [...LEVEL_PERMISSIONS[next]]);
  };

  return (
    <Dialog open onClose={onClose} title={role ? `Edit ${role.name}` : "New role"}>
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(); }}>
        <Field label="Name"><input className="input" value={name} onChange={(e) => { setName(e.target.value); save.reset(); }} maxLength={60} placeholder="e.g. Foreman" autoFocus /></Field>
        <Field label="Access level" hint={LEVEL_SUMMARY[level]}>
          <select className="select" value={level} onChange={(e) => changeLevel(e.target.value as Role)}>
            {LEVELS.map((l) => <option key={l} value={l}>{ROLE_LABELS[l]}</option>)}
          </select>
        </Field>
        {allowed.length > 0 ? (
          <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend style={{ marginBottom: 8 }}>Can use</legend>
            <div className="perm-list">
              {PERMISSIONS.filter((p) => allowed.includes(p.key)).map((p) => (
                <label key={p.key} className="switch-row" style={{ fontWeight: 500 }}>
                  <input type="checkbox" className="switch" checked={perms.includes(p.key)} onChange={(e) => setPerms(e.target.checked ? [...perms, p.key] : perms.filter((x) => x !== p.key))} />
                  {p.label}
                </label>
              ))}
            </div>
          </fieldset>
        ) : (
          <p className="muted small" style={{ margin: 0 }}>This level sees only their own visits and time.</p>
        )}
        <FormError error={save.error} />
        <div className="form-actions">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending}>{role ? "Save role" : "Create role"}</Button>
        </div>
      </form>
    </Dialog>
  );
}
