/**
 * Roles: name a role, pick its access level, choose which areas it includes, and the guide that's its
 * job description (the knowledge base shows it to the people with the role). Owners also give a
 * role, or a built-in level, a storage limit for everyone with it (Settings → Storage has the rest).
 */
import { adminLevel, LEVEL_PERMISSIONS, LEVEL_SUMMARY, PERMISSIONS, ROLE_LABELS, STAFF, type Permission, type Role } from "@crewtavo/core/roles";
import { formatBytes } from "@crewtavo/core/storage";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { Dialog } from "@/components/ui/Dialog";
import { Field, FormChecks, FormError } from "@/components/ui/Field";
import { Menu } from "@/components/ui/Menu";
import { RelatedRow, Section } from "@/components/ui/Section";
import { InboxSkeleton } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState } from "@/components/ui/States";
import { api, supabase, unwrap } from "@/lib/api";
import { useListAnimation } from "@/lib/motion";
import { useSession } from "@/lib/session";
import { useSopIndex } from "../kb/kbData";
import { useCompanyRoles, type CompanyRole } from "./roles";
import { gbField, parseGb, refreshStorage, setAllowance, setsAllowances, useStorageOverview } from "./storage";
import { AllowanceDialog, GbInput } from "./StorageSettings";
import { SettingsActions, SwitchRow } from "./SettingsKit";
import styles from "./settings.module.css";
import { YourPassword } from "./TeamSettings";
import { Select } from "@/components/ui/Select";

// The team's levels. A custom role is never a sub's (the database refuses it).
const LEVELS = STAFF.filter((r) => r !== "owner");
const GROUPS = [...new Set(PERMISSIONS.map((p) => p.group))];
const label = (p: Permission) => PERMISSIONS.find((x) => x.key === p)?.label ?? p;
/** A role's areas in a quiet line: the first few by name, then how many more. */
const areas = (list: Permission[]) => (list.length <= 3 ? list.map(label).join(", ") : `${list.slice(0, 3).map(label).join(", ")} and ${list.length - 3} more`);

export function RolesSettings() {
  const session = useSession();
  const queryClient = useQueryClient();
  const roles = useCompanyRoles();
  const navigate = useNavigate();
  const guides = useSopIndex();
  const team = useQuery({ queryKey: ["team", session.company.id], queryFn: () => api.get<Array<{ role_id: string | null; active: boolean }>>("/team") });
  const [editing, setEditing] = useState<CompanyRole | "new" | null>(null);
  // Storage limits for everyone with a role: owners only.
  const owner = setsAllowances(session);
  const storage = useStorageOverview(owner);
  const [limitFor, setLimitFor] = useState<{ key: string; name: string } | null>(null);
  const storageLimit = (key: string) => storage.data?.roles?.find((r) => r.role_key === key)?.limit_bytes ?? null;
  const remove = useMutation({
    meta: { success: "Role deleted" },
    mutationFn: async (id: string) => unwrap(await supabase().from("company_roles").delete().eq("id", id)),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["company-roles", session.company.id] });
      queryClient.invalidateQueries({ queryKey: ["team", session.company.id] });
    },
  });
  const count = (id: string) => team.data?.filter((m) => m.active && m.role_id === id).length ?? 0;
  const rows = useListAnimation<HTMLUListElement>();
  const askDelete = async (r: CompanyRole) => {
    const n = count(r.id);
    if (await confirm({ title: `Delete “${r.name}”?`, body: n ? `${n} ${n === 1 ? "person has" : "people have"} this role. They keep ${ROLE_LABELS[r.base_role]} access.` : undefined, confirmLabel: "Delete role", danger: true })) remove.mutate(r.id);
  };

  return (
    <>
      <SettingsActions><Button variant="primary" icon="plus" onClick={() => setEditing("new")}>New role</Button></SettingsActions>
      <Section level={3} title="Your roles" count={roles.data?.length || undefined}>
        {roles.error ? (
          <ErrorState compact error={roles.error} onRetry={() => roles.refetch()} />
        ) : roles.isPending ? (
          <InboxSkeleton rows={3} />
        ) : roles.data.length === 0 ? (
          <EmptyState inline title="No custom roles yet" action={<Button onClick={() => setEditing("new")}>Add a role</Button>} />
        ) : (
          <ul className="rel" role="list" ref={rows}>
            {roles.data.map((r) => {
              const guide = r.guide_id ? guides.data?.pages.find((g) => g.id === r.guide_id)?.title ?? "open the guide" : null;
              const n = count(r.id);
              return (
                <RelatedRow
                  key={r.id}
                  onClick={() => setEditing(r)}
                  title={r.name}
                  detail={`${ROLE_LABELS[r.base_role]} access`}
                  sub={[
                    // Who has it and what it includes as one run of words, so a long line wraps as words, not around a dot.
                    `${n} ${n === 1 ? "person" : "people"} · ${r.permissions.length ? areas(r.permissions) : "Their own work only"}`,
                    owner && storageLimit(r.id) ? `Storage: ${formatBytes(storageLimit(r.id)!)} each` : null,
                    r.guide_id && <Link key="guide" to={`/kb/${r.guide_id}`} className={styles.inlineLink}>Job description: {guide}</Link>,
                  ]}
                  actions={
                    <Menu
                      label={`More for ${r.name}`}
                      title={r.name}
                      triggerClassName="btn btn-sm btn-ghost btn-icon"
                      items={[
                        { label: "Edit role", icon: "edit", kbd: "E", onSelect: () => setEditing(r) },
                        { label: "Open the job description", icon: "book", hidden: !r.guide_id, onSelect: () => navigate(`/kb/${r.guide_id}`) },
                        { separator: true },
                        { label: "Delete role", icon: "trash", danger: true, onSelect: () => void askDelete(r) },
                      ]}
                    />
                  }
                />
              );
            })}
          </ul>
        )}
      </Section>
      <Section level={3} title="Built-in roles">
        <p className="set-note">Every business has these. A role of your own starts from one of them.</p>
        <ul className="rel" role="list">
          {STAFF.map((r) => (
            <RelatedRow
              key={r}
              title={ROLE_LABELS[r]}
              sub={LEVEL_SUMMARY[r]}
              actions={owner && storage.data && r !== "owner" ? (
                <button type="button" className="btn btn-sm" onClick={() => setLimitFor({ key: r, name: ROLE_LABELS[r] })} aria-label={`Storage limit for ${ROLE_LABELS[r]}`}>
                  {storageLimit(r) ? `Storage: ${formatBytes(storageLimit(r)!)} each` : "Storage limit"}
                </button>
              ) : undefined}
            />
          ))}
        </ul>
      </Section>
      {editing && (
        <RoleDialog
          role={editing === "new" ? null : editing}
          existing={roles.data ?? []}
          storage={owner && storage.data ? { limit: editing === "new" ? null : storageLimit(editing.id) } : null}
          onClose={() => setEditing(null)}
        />
      )}
      {limitFor && <AllowanceDialog target={{ role: limitFor.key }} name={limitFor.name} current={storageLimit(limitFor.key)} onClose={() => setLimitFor(null)} />}
    </>
  );
}

/**
 * A role's name, level and areas. `storage` (owners only) adds its storage limit: the role's limit
 * now, saved with the role (null: none).
 */
export function RoleDialog({ role, existing, storage, onClose }: { role: CompanyRole | null; existing: CompanyRole[]; storage: { limit: number | null } | null; onClose: () => void }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const [name, setName] = useState(role?.name ?? "");
  const [level, setLevel] = useState<Role>(role?.base_role ?? "office");
  const [perms, setPerms] = useState<Permission[]>(role?.permissions ?? [...LEVEL_PERMISSIONS.office]);
  const [guideId, setGuideId] = useState(role?.guide_id ?? "");
  const guides = useSopIndex();
  // What's typed, or the role's limit as it stands (which may arrive after the dialog opens).
  const [typed, setTyped] = useState<string | null>(null);
  const size = typed ?? gbField(storage?.limit);
  // A new role saved before its storage limit failed: trying again saves that role, not another.
  const created = useRef<string | null>(null);
  const allowed = LEVEL_PERMISSIONS[level];
  const kept = perms.filter((p) => allowed.includes(p));
  // Saving admin access the role didn't have takes your password (POST and PUT /api/team/roles check it).
  const grants = adminLevel(level, kept) && !(role && adminLevel(role.base_role, role.permissions));
  const [password, setPassword] = useState("");

  const save = useMutation({
    meta: { inline: true, success: role ? "Role saved" : "Role created" },
    mutationFn: async (current_password: string) => {
      const clean = name.trim();
      if (!clean) throw new Error("Give the role a name.");
      const id = role?.id ?? created.current;
      if (existing.some((r) => r.id !== id && r.name.trim().toLowerCase() === clean.toLowerCase())) throw new Error("There's already a role with that name.");
      // Checked before anything's saved, so a size that isn't one saves nothing.
      let limit: number | null | undefined;
      if (storage) {
        const parsed = size.trim() ? parseGb(size) : null;
        if (parsed && "problem" in parsed) throw new Error(`Storage limit: ${parsed.problem}`);
        limit = parsed ? parsed.bytes : null;
      }
      const row = { name: clean, base_role: level, permissions: kept, guide_id: guideId || null, current_password: current_password || undefined };
      let saved = id;
      if (saved) await api.put(`/team/roles/${saved}`, row);
      else saved = created.current = (await api.post<{ id: string }>("/team/roles", row)).id;
      if (storage && limit !== undefined && gbField(limit) !== gbField(storage.limit)) await setAllowance(session.company.id, { role: saved! }, limit);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["company-roles", session.company.id] });
      queryClient.invalidateQueries({ queryKey: ["team", session.company.id] });
      if (storage) refreshStorage(queryClient);
      onClose();
    },
  });

  const changeLevel = (next: Role) => {
    setLevel(next);
    // Keep what still applies; a brand-new role starts with everything the level allows.
    setPerms(role ? perms.filter((p) => LEVEL_PERMISSIONS[next].includes(p)) : [...LEVEL_PERMISSIONS[next]]);
  };

  return (
    <Dialog open onClose={onClose} title={role ? `Edit ${role.name}` : "New role"} size="lg">
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(grants ? password : ""); setPassword(""); }}>
        <div className="role-edit">
          <div className="role-edit-side">
            <Field label="Name" requiredMessage="Give the role a name."><input className="input" value={name} onChange={(e) => { setName(e.target.value); save.reset(); }} maxLength={60} placeholder="e.g. Foreman" required autoFocus /></Field>
            {/* The level first, each with what it reaches (Jobber's preset levels); then its areas, grouped, each saying what it opens. */}
            <fieldset className="role-fieldset">
              <legend className="role-legend">Starts from</legend>
              <div className="set-rows">
                {LEVELS.map((l) => (
                  <label key={l} className="set-row set-choice">
                    <input type="radio" name="role-level" checked={level === l} onChange={() => changeLevel(l)} />
                    <span className="set-row-text"><span className="set-row-label">{ROLE_LABELS[l]}</span><span className="set-row-hint">{LEVEL_SUMMARY[l]}</span></span>
                  </label>
                ))}
              </div>
            </fieldset>
            <Field className="role-extra" label="Job description" optional hint="The guide that says what this job is. It and every guide it links to are the job's training: people with this role have to read them all, and it shows how far each person is.">
              <Select className="select" value={guideId} onChange={(e) => { setGuideId(e.target.value); save.reset(); }}>
                <option value="">None</option>
                {(guides.data?.pages ?? []).map((g) => <option key={g.id} value={g.id}>{g.title}{g.status === "draft" ? " (draft)" : ""}</option>)}
              </Select>
            </Field>
            {storage && (
              <Field className="role-extra" label="Storage limit for everyone with this role" optional hint="For each person with this role who has no limit of their own: it stops what they add to Drive, plans and guides. Leave it empty for no limit.">
                <GbInput value={size} placeholder="No limit" onChange={(v) => { setTyped(v); save.reset(); }} />
              </Field>
            )}
          </div>
          <div className="role-edit-main">
            {allowed.length > 0 ? (
              <fieldset className="role-fieldset">
                <legend className="role-legend">
                  Can use <span className="role-count">{kept.length} of {allowed.length}</span>
                  <button type="button" className="btn btn-sm btn-ghost" onClick={() => setPerms(kept.length === allowed.length ? [] : [...allowed])}>{kept.length === allowed.length ? "Turn all off" : "Turn all on"}</button>
                </legend>
                {GROUPS.map((g) => {
                  const items = PERMISSIONS.filter((p) => p.group === g && allowed.includes(p.key));
                  return items.length ? (
                    <div key={g} className="set-rows role-group" role="group" aria-label={g}>
                      <p className="role-group-title">{g}</p>
                      {items.map((p) => (
                        <SwitchRow key={p.key} label={p.label} hint={p.hint} checked={perms.includes(p.key)} onChange={(on) => setPerms(on ? [...perms, p.key] : perms.filter((x) => x !== p.key))} />
                      ))}
                    </div>
                  ) : null;
                })}
                {level === "admin" && <p className="set-note">With Business setup, Manage people and roles or Connect apps on, this is an admin role: saving it asks for your password.</p>}
                {allowed.length < PERMISSIONS.length && (
                  <p className="set-note">Others, like {PERMISSIONS.find((p) => !allowed.includes(p.key))!.label}, come with a higher level.</p>
                )}
              </fieldset>
            ) : (
              <p className="set-note">This level sees only their own visits and time.</p>
            )}
          </div>
        </div>
        {grants && <YourPassword value={password} onChange={setPassword} />}
        <FormError error={save.error} />
        <div className="form-actions">
          <FormChecks />
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending}>{role ? "Save role" : "Create role"}</Button>
        </div>
      </form>
    </Dialog>
  );
}
