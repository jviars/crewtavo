import { useMutation } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { Field, FormError } from "@/components/ui/Field";
import { initials } from "@/components/shell/AppShell";
import { Icon, type IconName } from "@/components/ui/Icon";
import { api, supabase } from "@/lib/api";
import { useSession } from "@/lib/session";
import { setTheme, useTheme, type ThemeChoice } from "@/lib/theme";
import { toast } from "@/lib/toast";
import { CalendarFeedCard } from "./CalendarFeedCard";
import { NotificationSettings } from "./NotificationSettings";

const COLORS = ["#0f2a35", "#3b7d23", "#3474d4", "#c9852a", "#d2445c", "#8b5cf6", "#0e7490", "#57534e"];

export function ProfileSettings() {
  const session = useSession();
  const [name, setName] = useState(session.profile.full_name);
  const [phone, setPhone] = useState(session.profile.phone ?? "");
  const [color, setColor] = useState(session.profile.color ?? COLORS[0]);
  const [password, setPassword] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const save = useMutation({
    meta: { inline: true, success: "Profile saved" },
    mutationFn: async () => {
      await api.patch("/me", { full_name: name.trim(), phone: phone.trim() || null });
      const { error } = await supabase().from("profiles").update({ color }).eq("user_id", session.userId);
      if (error) throw new Error(error.message);
    },
    onSuccess: () => session.refresh(),
  });
  const changePassword = useMutation({
    meta: { inline: true },
    mutationFn: async () => {
      if (password.length < 8) throw new Error("Use at least 8 characters.");
      if (password !== confirmPw) throw new Error("The passwords don't match.");
      const { error } = await supabase().auth.updateUser({ password });
      if (error) throw new Error(/same/i.test(error.message) ? "That's already your password." : error.message);
    },
    onSuccess: () => {
      setPassword("");
      setConfirmPw("");
      toast.success("Password changed");
    },
  });
  return (
    <div className="two-col">
      <form className="wide card card-pad stack" onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(); }}>
        <div className="row" style={{ gap: 14 }}>
          <span className="avatar" style={{ width: 56, height: 56, fontSize: 20, background: color }}>{initials(name || session.profile.email)}</span>
          <div>
            <strong style={{ fontSize: 16 }}>{name || "Your name"}</strong>
            <div className="muted small">{session.profile.email}</div>
          </div>
        </div>
        <div className="form-grid">
          <Field label="Full name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} autoComplete="name" /></Field>
          <Field label="Mobile phone" optional><input className="input" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={40} autoComplete="tel" /></Field>
        </div>
        <div className="field">
          <span>Color on the schedule</span>
          <div className="row wrap" style={{ gap: 8 }}>
            {COLORS.map((c) => (
              <button key={c} type="button" aria-label={`Color ${c}`} aria-pressed={color === c} onClick={() => setColor(c)} style={{ width: 30, height: 30, borderRadius: "50%", background: c, border: color === c ? "3px solid var(--surface)" : "0", boxShadow: color === c ? `0 0 0 2px ${c}` : "none", cursor: "pointer", transition: "box-shadow 150ms" }} />
            ))}
          </div>
        </div>
        <FormError error={save.error} />
        <div className="form-actions"><Button type="submit" variant="primary" loading={save.isPending} disabled={!name.trim()}>Save profile</Button></div>
      </form>
      <div className="narrow stack">
      <NotificationSettings phone={session.profile.phone} />
      <Appearance />
      <CalendarFeedCard />
      <form className="card card-pad stack-sm" onSubmit={(e: FormEvent) => { e.preventDefault(); changePassword.mutate(); }}>
        <strong>Change password</strong>
        <Field label="New password" hint="At least 8 characters."><input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" minLength={8} /></Field>
        <Field label="Confirm new password" error={confirmPw && password !== confirmPw ? "Doesn't match" : null}><input className="input" type="password" value={confirmPw} onChange={(e) => setConfirmPw(e.target.value)} autoComplete="new-password" /></Field>
        <FormError error={changePassword.error} />
        <Button type="submit" loading={changePassword.isPending} disabled={!password || !confirmPw} style={{ justifySelf: "start" }}>Change password</Button>
      </form>
      </div>
    </div>
  );
}

const THEMES: Array<{ value: ThemeChoice; label: string; icon: IconName }> = [
  { value: "light", label: "Light", icon: "sun" },
  { value: "dark", label: "Dark", icon: "moon" },
  { value: "system", label: "System", icon: "monitor" },
];

/** Light, dark or the device's setting. Applies right away and is remembered on this device. */
function Appearance() {
  const theme = useTheme();
  return (
    <div className="card card-pad stack-sm">
      <strong id="appearance-title">Appearance</strong>
      <div className="segmented" role="group" aria-labelledby="appearance-title" style={{ justifySelf: "start" }}>
        {THEMES.map((t) => (
          <button key={t.value} type="button" aria-pressed={theme === t.value} onClick={() => setTheme(t.value)}>
            <Icon name={t.icon} size={15} />
            {t.label}
          </button>
        ))}
      </div>
      <span className="muted small">System follows your device's light or dark setting. Saved on this device.</span>
    </div>
  );
}
