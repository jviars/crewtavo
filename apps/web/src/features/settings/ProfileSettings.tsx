import { isPlaceholderEmail } from "@crewtavo/core/email";
import { useMutation } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Button, useJustDone } from "@/components/ui/Button";
import { Field, FormChecks, FormError } from "@/components/ui/Field";
import { Face } from "@/components/ui/Avatar";
import { Icon, type IconName } from "@/components/ui/Icon";
import { MapsAppSetting } from "@/components/ui/MapsLink";
import { Section } from "@/components/ui/Section";
import { api, supabase } from "@/lib/api";
import { can, hasRole, isSub, useSession } from "@/lib/session";
import { setTheme, useTheme, type ThemeChoice } from "@/lib/theme";
import { formatPhoneTyping } from "@/lib/validate";
import { signingInNote, subCodeWays } from "../auth/textCode";
import { MeasureMapSetting } from "../measure/ImageryPicker";
import { CalendarFeedCard } from "./CalendarFeedCard";
import { LanguageCard } from "./Language";
import { NotificationSettings } from "./NotificationSettings";
import { PhotoButtons } from "./ProfilePhoto";
import { SaveBar } from "./SettingsKit";
import { SignatureCard } from "./SignatureCard";
import { SpareKeysCard } from "./SpareKeysCard";
import { languageChoice, msg, t } from "@/lib/i18n";

const COLORS = ["#0f2a35", "#3b7d23", "#3474d4", "#c9852a", "#d2445c", "#8b5cf6", "#0e7490", "#57534e"];

export function ProfileSettings() {
  const session = useSession();
  // People who sign estimates for the business keep their signature here.
  const signs = hasRole(session, "admin", "office", "estimator") && can(session, "sales");
  // A sub has no schedule color or calendar feed. On a sign-in Crewtavo made for them, they sign in
  // with a link or a code and stay signed in (no password); someone's own account keeps its password.
  const sub = isSub(session);
  const madeForSub = sub && session.subcontractor?.own_sign_in !== false;
  const email = isPlaceholderEmail(session.profile.email) ? null : session.profile.email;
  const [name, setName] = useState(session.profile.full_name);
  const [phone, setPhone] = useState(session.profile.phone ?? "");
  const [color, setColor] = useState(session.profile.color ?? COLORS[0]);
  const [current, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const save = useMutation({
    meta: { inline: true },
    mutationFn: async () => {
      await api.patch("/me", { full_name: name.trim(), phone: phone.trim() || null });
      if (sub) return;
      const { error } = await supabase().from("profiles").update({ color }).eq("user_id", session.userId);
      if (error) throw new Error(error.message);
    },
    onSuccess: () => session.refresh(),
  });
  const changePassword = useMutation({
    meta: { inline: true },
    mutationFn: async () => {
      if (password.length < 8) throw new Error(t("Use at least 8 characters."));
      if (password !== confirmPw) throw new Error(t("The passwords don't match."));
      // Checked against the current one on the server (apps/api/src/routes/account.ts).
      await api.post("/account/password", { current: current || undefined, password });
    },
    onSuccess: () => {
      setCurrent("");
      setPassword("");
      setConfirmPw("");
    },
  });
  const saved = useJustDone(save);
  const changed = useJustDone(changePassword);
  return (
    <>
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(); }}>
        <Section level={3} title={t("Your details")}>
          <div className="set-me">
            <span className="avatar" style={{ background: color }}><Face name={name || email} photo={session.profile.avatar_url} /></span>
            <div className="set-me-text">
              <strong>{name || t("Your name")}</strong>
              {email && <span className="hint">{email}</span>}
              <PhotoButtons userId={session.userId} photo={session.profile.avatar_url} />
            </div>
          </div>
          <div className="set-grid">
            <Field label={t("Full name")}><input className="input" value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} autoComplete="name" /></Field>
            <Field label={t("Mobile phone")} optional hint={madeForSub ? t("Texts about your jobs go here. Leave it empty to get them at the number {company} has for you.", { company: session.company.name }) : undefined}>
              <input className="input" type="tel" value={phone} onChange={(e) => setPhone(formatPhoneTyping(e.target.value))} maxLength={40} autoComplete="tel" />
            </Field>
            {!sub && <div className="field set-full">
              <span id="schedule-color-label">{t("Color on the schedule")}</span>
              <div className="set-swatches" role="group" aria-labelledby="schedule-color-label">
                {COLORS.map((c) => (
                  <button key={c} type="button" className="set-swatch" aria-label={t("Color {color}", { color: c })} aria-pressed={color === c} onClick={() => setColor(c)} style={{ background: c }} />
                ))}
              </div>
            </div>}
          </div>
        </Section>
        <FormError error={save.error} />
        <SaveBar><Button type="submit" variant="primary" loading={save.isPending} done={saved}>{t("Save profile")}</Button><FormChecks /></SaveBar>
      </form>
      {signs && <SignatureCard />}
      <NotificationSettings phone={session.profile.phone} />
      <Section level={3} title={t("Appearance and language")}>
        <div className="set-items">
          <Appearance />
          {languageChoice() && <LanguageCard />}
        </div>
      </Section>
      <Section level={3} title={t("Maps and directions")}>
        {/* Each says what it is and where it's kept, as an item of its own. */}
        <div className="set-items">
          <MapsAppSetting />
          {!sub && <MeasureMapSetting />}
        </div>
      </Section>
      {!sub && <CalendarFeedCard />}
      <SpareKeysCard />
      {madeForSub && (
        <Section level={3} title={t("Signing in")}>
          <p className="set-note">{signingInNote(session.company.name, subCodeWays(session.config.features, session.subcontractor))}</p>
        </Section>
      )}
      {!madeForSub && (
        <Section level={3} title={t("Password")}>
          <form className="set-grid" onSubmit={(e: FormEvent) => { e.preventDefault(); changePassword.mutate(); }}>
            <Field label={t("Current password")} className="set-full set-half" hint={t("Leave it empty if you don't have one yet.")}><input className="input" type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" /></Field>
            <Field label={t("New password")} hint={t("At least 8 characters.")}><input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" required minLength={8} /></Field>
            <Field label={t("Confirm new password")} error={confirmPw && password !== confirmPw ? t("The passwords don't match.") : null}><input className="input" type="password" value={confirmPw} onChange={(e) => setConfirmPw(e.target.value)} autoComplete="new-password" required /></Field>
            <div className="set-full">
              <FormError error={changePassword.error} />
              <Button type="submit" loading={changePassword.isPending} done={changed} doneLabel={t("Password changed")}>{t("Change password")}</Button>
            </div>
          </form>
        </Section>
      )}
    </>
  );
}

const THEMES: Array<{ value: ThemeChoice; label: string; icon: IconName }> = [
  { value: "light", label: msg("Light"), icon: "sun" },
  { value: "dark", label: msg("Dark"), icon: "moon" },
  { value: "system", label: msg("System"), icon: "monitor" },
];

/** Light, dark or the device's setting. Applies right away and is remembered on this device. */
function Appearance() {
  const theme = useTheme();
  return (
    <div className="set-item">
      <span className="set-item-label" id="appearance-title">{t("Appearance")}</span>
      <div className="segmented" role="group" aria-labelledby="appearance-title">
        {THEMES.map((choice) => (
          <button key={choice.value} type="button" aria-pressed={theme === choice.value} onClick={() => setTheme(choice.value)}>
            <Icon name={choice.icon} size={14} />
            {t(choice.label)}
          </button>
        ))}
      </div>
      <span className="hint">{t("System follows your device's light or dark setting. Saved on this device.")}</span>
    </div>
  );
}
