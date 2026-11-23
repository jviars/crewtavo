/** Sign in (password, emailed link, Google or a sub's code by text or email), create an account, reset a password, set a new one, or say whether a link for another account switches to it. */
import { SIGN_IN_CODE_DIGITS, SIGN_IN_CODE_MINUTES } from "@crewtavo/core/subs";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ChangeEvent, type FormEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { EntityStatus } from "@/components/ui/StatusPill";
import { api, loadConfig, supabase, type AppConfig } from "@/lib/api";
import { KEY_FILE_NAME, readKeyFile } from "@/lib/keyFile";
import { formatMoney, formatTime } from "@/lib/format";
import { formatPhoneTyping } from "@/lib/validate";
import styles from "./auth.module.css";
import { BrandLockup } from "@/components/shell/BrandMark";
import { afterAsking, ASK_THE_OFFICE, askFor, boxedCode, codeDigits, codeProblem, emailInstead, filledAtOnce, newPhoneOffers, NOTHING_CAME, readAddress, resendIn, resendLabel, sentTo, signInWith, TEXTING_OFF, wholeCode, type CodeStep, type CodeWay } from "./textCode";
import { getLocale, languageChoice, LOCALE_NAMES, msg, pickAtSignIn, showScreenLang, T, t } from "@/lib/i18n";
import { LOCALES } from "@crewtavo/core/i18n";
import { translateError } from "@crewtavo/core/i18n/patterns";

type Mode = "sign_in" | "sign_up" | "magic_link" | "forgot" | "recover" | "code";

type AuthSettings = { external?: Record<string, boolean>; disable_signup?: boolean };

/** Which sign-in methods the Supabase project has turned on. */
function useAuthSettings() {
  return useQuery({
    queryKey: ["auth-settings"],
    staleTime: Infinity,
    retry: 1,
    meta: { silent: true },
    queryFn: async () => {
      const config = await loadConfig();
      const res = await fetch(`${config.supabaseUrl}/auth/v1/settings`, { headers: { apikey: config.supabaseKey } });
      if (!res.ok) throw new Error("settings"); // i18n-ignore: only for the query's retry
      return (await res.json()) as AuthSettings;
    },
  });
}

/**
 * Whether to offer "Create an account": only once Auth has said sign-up is open. A Crewtavo instance
 * turns it off (the owner invites everyone else), so while the answer is on its way, or when it
 * doesn't come (Auth still starting, no signal), there's no link to a form that would be turned away.
 */
export const signupOpen = (settings: AuthSettings | undefined) => settings?.disable_signup === false;

/** Supabase's messages, in plain words. */
export function authMessage(error: { message: string; status?: number; code?: string }): string {
  const m = error.message.toLowerCase();
  if (m.includes("invalid login credentials")) return t("That email and password don't match. Check them, or reset your password.");
  if (m.includes("email not confirmed")) return t("Confirm your email first. We sent you a link when you signed up.");
  if (m.includes("user already registered") || m.includes("already been registered")) return t("There's already an account with that email. Sign in instead.");
  if (m.includes("rate limit") || error.status === 429) return t("Too many attempts. Wait a minute and try again.");
  if (m.includes("signups not allowed") || m.includes("signup is disabled")) return t("New accounts are by invitation. Ask your company's admin to invite you.");
  if (m.includes("same password") || m.includes("different from the old")) return t("Your new password has to be different from the old one.");
  if (m.includes("password should be") || m.includes("weak")) return t("Choose a stronger password: at least 8 characters, mixing letters and numbers.");
  if (m.includes("failed to fetch") || m.includes("network")) return t("You seem to be offline. Check your connection and try again.");
  return translateError(getLocale(), error.message);
}

/**
 * The frame of every screen before the app (Setup-Flow, Setup-SelfHosted): the brand and `top`
 * (a link, the steps) over the form, the language under it, and beside it a quiet picture of what
 * comes next (`aside`), or one column without one. On a phone the picture stays out and `back` is a
 * round button by the steps. `onSignOut` puts Sign out in the foot; `foot` is said on its right.
 */
export function AuthLayout({ children, aside, asideAlign, panel, caption, wide, top, back, foot, onSignOut, width, center, step }: {
  children: ReactNode;
  /**
   * Which question of a setup this is. A new one comes in from the side it's on (ahead, or back
   * when the number is lower) and its picture fades in, as one-question onboarding flows move.
   */
  step?: number | string;
  aside?: ReactNode;
  asideAlign?: "top";
  /** The picture fills an inset panel of its own (sign-in's), instead of sitting on the grouped ground. */
  panel?: boolean;
  caption?: ReactNode;
  /** A narrower picture and a form as wide as its column (the trades). */
  wide?: boolean;
  top?: ReactNode;
  back?: { label: string; onClick: () => void };
  foot?: ReactNode;
  onSignOut?: () => void;
  width?: "wide" | "read";
  /** A message in the middle of the screen (check your email, setting it up). */
  center?: boolean;
}) {
  // The step shown last, to tell going on from going back.
  const shown = useRef(step);
  const goingBack = typeof step === "number" && typeof shown.current === "number" && step < shown.current;
  useEffect(() => {
    shown.current = step;
  }, [step]);
  return (
    <div className={styles.page} data-layout={aside ? undefined : "one"} data-aside={aside && wide ? "wide" : undefined}>
      <div className={styles.left}>
        <header className={styles.top}>
          {back && <button type="button" className={styles.back} aria-label={back.label} onClick={back.onClick}><Icon name="chevronLeft" size={20} /></button>}
          <span className={styles.brand}><BrandLockup size={22} /></span>
          {top && <div className={styles.topEnd}>{top}</div>}
        </header>
        <main key={step} className={center ? styles.center : styles.main} data-width={wide ? "wide" : width} data-enter={step === undefined ? undefined : goingBack ? "back" : "on"}>{children}</main>
        <footer className={styles.foot}>
          {onSignOut ? <button type="button" className="link-btn" onClick={onSignOut}>{t("Sign out")}</button> : languageChoice() && <LanguageSwitch />}
          {onSignOut ? languageChoice() && <LanguageSwitch /> : <span>{foot}</span>}
        </footer>
      </div>
      {aside && (
        <aside className={styles.aside} data-align={asideAlign} data-panel={panel || undefined}>
          <div key={step} className={styles.asideBody} data-enter={step === undefined ? undefined : ""}>{aside}</div>
          {caption && <p className={styles.cap}>{caption}</p>}
        </aside>
      )}
    </div>
  );
}

/** English · Español under the sign-in screens: the page reloads in it, and it's saved with whoever then signs in (never left for the next person). */
function LanguageSwitch() {
  const current = getLocale();
  return (
    <nav className={styles.lang} aria-label={t("Language")}>
      {LOCALES.map((locale) =>
        locale === current ? (
          <strong key={locale} lang={locale} aria-current="true">{LOCALE_NAMES[locale]}</strong>
        ) : (
          <button key={locale} type="button" className="link-btn" lang={locale} onClick={() => pickAtSignIn(locale)}>{LOCALE_NAMES[locale]}</button>
        ),
      )}
    </nav>
  );
}

/** The four stages across the top of sign-in's picture, each in its own color, as Home shows them. */
const PICTURE_STAGES = [
  { icon: "requests", label: msg("Requests"), figure: 6 },
  { icon: "quote", label: msg("Quotes"), figure: 18400, money: true },
  { icon: "job", label: msg("Jobs"), figure: 9 },
  { icon: "invoice", label: msg("Invoices"), figure: 8920, money: true },
] as const;

/** A day of the app drawn small beside sign-in: a picture, so it's read as one (the headline says what it shows). */
const DAY = [
  { at: 8, what: msg("Weekly mowing"), who: "Rosa D.", hue: "#2f6f6a", status: "completed" }, // i18n-ignore: a person's name
  { at: 10.5, what: msg("Leaf cleanup"), who: "Maya O.", hue: "#2f6f6a", status: "in_progress" }, // i18n-ignore: a person's name
  { at: 13, what: msg("Holiday lights"), who: "Henderson", hue: "#6b3fa0", status: "scheduled" },
] as const;

/**
 * Sign-in's picture (as Square, Origin and Pin do theirs): an inset navy panel with what Crewtavo does
 * in one line, and a slice of Home under it, cut off at the panel's edges so it reads as the real thing.
 */
function DayPicture() {
  const at = (hours: number) => formatTime(new Date(2026, 10, 21, Math.floor(hours), (hours % 1) * 60).toISOString());
  return (
    <div className={styles.panel}>
      <p className={styles.panelHead}>{t("Requests, quotes, the schedule, invoices and your crews in one place.")}</p>
      <div className={styles.shot} aria-hidden="true">
        <div className={styles.shotStrip}>
          {PICTURE_STAGES.map((s) => (
            <div key={s.icon} data-stage={s.icon}>
              <span><Icon name={s.icon} size={16} />{t(s.label)}</span>
              <b>{"money" in s ? formatMoney(s.figure) : s.figure}</b>
            </div>
          ))}
        </div>
        <div className={styles.dayHead}><span>{t("Today")}</span><span>{t("{done} of {total} done", { done: 3, total: 8 })}</span></div>
        {DAY.map((v) => (
          <div key={v.at} className={styles.dayRow}>
            <time>{at(v.at)}</time>
            <i style={{ background: v.hue }} />
            <span className={styles.dayWhat}>{t(v.what)} <span className={styles.who}>· {v.who}</span></span>
            <EntityStatus kind="visit" status={v.status} />
          </div>
        ))}
        <div className={styles.dayQuote}>
          <span><small>{t("Quote #{number} approved", { number: 88 })}</small><b>{t(DAY[2].what)}</b></span>
          <b>{formatMoney(4850)}</b>
        </div>
      </div>
    </div>
  );
}

/** Sign-in's picture, on its panel. */
const signInAside = () => ({ aside: <DayPicture />, panel: true });

/** A problem with what was sent, said once and read out. */
function Problem({ children }: { children: ReactNode }) {
  return <div className="callout callout-warning" role="alert"><Icon name="alert" size={16} /><span className="grow" style={{ fontWeight: 600 }}>{children}</span></div>;
}

/** The password, with Show or Hide inside the field. */
export function PasswordInput({ value, onChange, autoComplete, minLength, autoFocus, show: shown, onShow }: { value: string; onChange: (value: string) => void; autoComplete: string; minLength: number; autoFocus?: boolean; show?: boolean; onShow?: (show: boolean) => void }) {
  const [own, setOwn] = useState(false);
  const show = shown ?? own;
  const setShow = onShow ?? setOwn;
  return (
    <div className={`input-group ${styles.password}`}>
      <input className="input" type={show ? "text" : "password"} value={value} onChange={(e) => onChange(e.target.value)} autoComplete={autoComplete} minLength={minLength} required autoFocus={autoFocus} />
      <button type="button" className={styles.reveal} aria-label={show ? t("Hide password") : t("Show password")} onClick={() => setShow(!show)}>{show ? t("Hide") : t("Show")}</button>
    </div>
  );
}

/**
 * After signing up, sign in from this tab as soon as the email is confirmed. The confirmation link
 * may open somewhere else (another device, or a page that doesn't load while the Supabase project's
 * Site URL is still its default), so this doesn't wait for a redirect. Tries every 15 seconds and
 * whenever the tab comes back into view, for half an hour (well inside Supabase's sign-in rate limit).
 */
function useSignInWhenConfirmed(pending: { email: string; password: string } | null) {
  useEffect(() => {
    if (!pending) return;
    let stopped = false;
    let last = 0;
    const started = Date.now();
    const attempt = async () => {
      if (stopped || document.visibilityState !== "visible" || Date.now() - last < 5_000) return;
      if (Date.now() - started > 30 * 60_000) return stop();
      last = Date.now();
      const { error } = await supabase().auth.signInWithPassword(pending);
      if (!error) stop(); // SessionProvider takes it from here.
    };
    const timer = setInterval(attempt, 15_000);
    const onVisible = () => void attempt();
    window.addEventListener("focus", onVisible);
    document.addEventListener("visibilitychange", onVisible);
    function stop() {
      stopped = true;
      clearInterval(timer);
      window.removeEventListener("focus", onVisible);
      document.removeEventListener("visibilitychange", onVisible);
    }
    return stop;
  }, [pending]);
}

export function LoginPage({ notice = null }: { notice?: string | null } = {}) {
  // The sign-in page is in the language picked on it, and the page says so (it may follow an English office screen).
  useEffect(() => showScreenLang(window.location.pathname, window.location.search, false), []);
  const settings = useAuthSettings();
  // Already loaded by SessionProvider: whether this Crewtavo can text or email a sub a code on a new phone.
  const config = useQuery({ queryKey: ["config"], queryFn: loadConfig, staleTime: Infinity, meta: { silent: true } });
  const [mode, setMode] = useState<Mode>("sign_in");
  const [codeWay, setCodeWay] = useState<CodeWay>("text");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [busy, setBusy] = useState<false | "form" | "google">(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<null | { kind: "link" | "confirm" | "reset"; email: string }>(null);
  const [cooldown, setCooldown] = useState(0);
  const [emailOff, setEmailOff] = useState(false);
  const [code, setCode] = useState("");
  // Recovering: upload the key file, or (no file) type one key from a printout.
  const [typingKey, setTypingKey] = useState(false);
  const keyFileInput = useRef<HTMLInputElement>(null);
  const [confirming, setConfirming] = useState<{ email: string; password: string } | null>(null);
  useSignInWhenConfirmed(confirming);
  const google = settings.data?.external?.google ?? false;

  useEffect(() => {
    if (!cooldown) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  const switchTo = (next: Mode) => {
    setMode(next);
    setTypingKey(false);
    setError(null);
  };

  async function send(kind: "link" | "reset" | "confirm") {
    if (kind === "confirm") {
      const { error } = await supabase().auth.resend({ type: "signup", email: email.trim(), options: { emailRedirectTo: window.location.origin } });
      if (error) throw error;
    } else {
      // Sent by the API from the company's own mailbox, so it reaches people Supabase's mailer won't.
      const result = await api.post<{ sent: boolean }>("/auth/email-link", { email: email.trim(), kind: kind === "link" ? "magiclink" : "recovery" });
      // This Crewtavo can't send email at all (the same answer for every address).
      if (!result.sent) return setEmailOff(true);
    }
    setSent({ kind, email: email.trim() });
    setCooldown(60);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy("form");
    setError(null);
    try {
      const auth = supabase().auth;
      if (mode === "sign_in") {
        const { error } = await auth.signInWithPassword({ email: email.trim(), password });
        if (error) throw error;
      } else if (mode === "sign_up") {
        if (fullName.trim().length < 2) throw new Error(t("Enter your name."));
        const { data, error } = await auth.signUp({ email: email.trim(), password, options: { data: { full_name: fullName.trim() }, emailRedirectTo: window.location.origin } });
        if (error) throw error;
        if (!data.session) {
          setSent({ kind: "confirm", email: email.trim() });
          setConfirming({ email: email.trim(), password });
          setCooldown(60);
        }
      } else if (mode === "recover") {
        // The owner's way back in without email: a spare key (apps/api/src/routes/recovery.ts).
        const { link } = await api.post<{ link: string }>("/auth/recover", { email: email.trim(), code });
        window.location.assign(link);
        return;
      } else {
        await send(mode === "magic_link" ? "link" : "reset");
      }
    } catch (err) {
      setError(authMessage(err as { message: string }));
    } finally {
      setBusy(false);
    }
  }

  /** The owner's key file (lib/keyFile.ts): its email and keys go to the API, which uses the first unused key. */
  async function submitKeyFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // so picking the same file again still counts
    if (!file) return;
    setError(null);
    const notAKeyFile = t("That doesn't look like your key file. It's called {name}.", { name: KEY_FILE_NAME });
    if (file.size > 20_000) return setError(notAKeyFile);
    const { email: account, keys } = readKeyFile(await file.text());
    if (!keys.length) return setError(notAKeyFile);
    if (!account) {
      setTypingKey(true);
      return setError(t("Enter your email, then one of the keys from the file."));
    }
    setBusy("form");
    try {
      const { link } = await api.post<{ link: string }>("/auth/recover", { email: account, keys });
      window.location.assign(link);
    } catch (err) {
      setError(authMessage(err as { message: string }));
      setBusy(false);
    }
  }

  async function withGoogle() {
    setBusy("google");
    setError(null);
    const { error } = await supabase().auth.signInWithOAuth({ provider: "google", options: { redirectTo: window.location.href } });
    if (error) {
      setError(authMessage(error));
      setBusy(false);
    }
  }

  if (mode === "code") return <CodeSignIn initialWay={codeWay} features={config.data?.features} onBack={() => switchTo("sign_in")} />;

  if (emailOff)
    return (
      <AuthLayout>
        <div className={styles.flow}>
          <h1 className={styles.title}>{t("We can't email you a link")}</h1>
          <p className={styles.sub}>{t("This Crewtavo isn't set up to send email yet, so here's how to get back in:")}</p>
          <ul className={styles.list} style={{ marginTop: 20 }}>
            <li><Icon name="users" size={16} /><span><T text="<b>On a team?</b> Ask the owner or an admin for a reset link. They make one under <b>Settings → People</b>, next to your name." b={(s) => <b>{s}</b>} /></span></li>
            <li><Icon name="lock" size={16} /><span><T text="<b>The owner?</b> Upload the key file you saved when you set up Crewtavo." b={(s) => <b>{s}</b>} /></span></li>
          </ul>
          <div className={styles.acts} data-stack="">
            <Button variant="primary" icon="lock" onClick={() => { setEmailOff(false); switchTo("recover"); }}>{t("I'm the owner: use my key file")}</Button>
            <Button variant="ghost" icon="arrowLeft" onClick={() => { setEmailOff(false); switchTo("sign_in"); }}>{t("Back to sign in")}</Button>
          </div>
        </div>
      </AuthLayout>
    );

  if (sent)
    return (
      <AuthLayout center>
        <span className={styles.mailTile} aria-hidden="true"><Icon name="mail" size={28} /></span>
        <h1 className={styles.title}>{t("Check your email")}</h1>
        <p className={styles.sub}>
          <T
            text={sent.kind === "link" ? "Sign-in link sent to <b>{email}</b>" : sent.kind === "reset" ? "Reset link sent to <b>{email}</b>" : "Confirmation link sent to <b>{email}</b>"}
            b={(s) => <strong>{s}</strong>}
            email={sent.email}
          />
        </p>
        {sent.kind === "confirm" && (
          <>
            <p className={styles.sub} style={{ maxWidth: 440 }}>{t("Open the link in that email, then come back to this tab. You'll be signed in automatically.")}</p>
            <span className={styles.status} role="status" style={{ marginTop: 22 }}>{t("Waiting for you to open the link")}</span>
          </>
        )}
        <p className={styles.hint} style={{ marginTop: 14, maxWidth: 440 }}>
          {sent.kind === "confirm" ? t("If the link opens a page that doesn't load, that's fine: your email is still confirmed. Not there after a few minutes? Check your spam folder.") : t("Not there after a minute? Check your spam folder.")}
        </p>
        {error && <div style={{ marginTop: 16 }}><Problem>{error}</Problem></div>}
        <div className={styles.acts}>
          <Button
            disabled={cooldown > 0}
            loading={busy === "form"}
            onClick={async () => {
              setBusy("form");
              try {
                await send(sent.kind);
              } catch (err) {
                setError(authMessage(err as { message: string }));
              } finally {
                setBusy(false);
              }
            }}
          >
            {cooldown > 0 ? t("Send again in {seconds}s", { seconds: cooldown }) : t("Send again")}
          </Button>
          <Button variant="ghost" onClick={() => { setSent(null); setConfirming(null); switchTo("sign_in"); }}>{t("Back to sign in")}</Button>
        </div>
      </AuthLayout>
    );

  const heading = { sign_in: t("Sign in"), sign_up: t("Create your account"), magic_link: t("Sign in with email"), forgot: t("Reset your password"), recover: typingKey ? t("Type a spare key") : t("Use your key file") }[mode];
  const top =
    mode === "sign_in" ? (
      signupOpen(settings.data) && <><span className={styles.topLead}>{t("New to Crewtavo?")}</span><button type="button" className="link-btn" onClick={() => switchTo("sign_up")}>{t("Create an account")}</button></>
    ) : mode === "sign_up" ? (
      <><span className={styles.topLead}>{t("Already have an account? ")}</span><button type="button" className="link-btn" onClick={() => switchTo("sign_in")}>{t("Sign in")}</button></>
    ) : null;

  return (
    <AuthLayout {...signInAside()} top={top}>
      <form className={styles.flow} onSubmit={submit} noValidate={false}>
        <h1 className={styles.title}>{heading}</h1>
        {mode === "sign_up" && <p className={styles.sub}>{t("Next you'll set up your business, then invite your team.")}</p>}
        {mode === "recover" && !typingKey && <p className={styles.sub}><T text="Upload the key file you saved when you set up Crewtavo. It's called <b>{file}</b>." b={(s) => <strong>{s}</strong>} file={KEY_FILE_NAME} /></p>}
        {mode === "recover" && typingKey && <p className={styles.sub}>{t("Enter your email and one of the keys from your key file or printout. Each key works once.")}</p>}

        <div className={styles.form}>
          {notice && mode === "sign_in" && <div className="callout callout-warning" role="status"><Icon name="alert" size={16} /><span className="grow" style={{ fontWeight: 600 }}>{notice}</span></div>}
          {mode === "recover" && !typingKey && <input ref={keyFileInput} type="file" accept=".txt,text/plain" hidden onChange={submitKeyFile} />}
          {mode === "sign_up" && (
            <Field label={t("Your name")}><input className="input" value={fullName} onChange={(e) => setFullName(e.target.value)} autoComplete="name" required minLength={2} maxLength={120} autoFocus /></Field>
          )}
          {!(mode === "recover" && !typingKey) && <Field label={t("Email")}><input className="input" type="email" value={email} onChange={(e) => { setEmail(e.target.value); setError(null); }} autoComplete="email" required autoFocus={mode !== "sign_up"} inputMode="email" /></Field>}
          {mode === "recover" && typingKey && (
            <Field label={t("Spare key")} hint={t("Like 7K4M-PQ2X-9DRF. Dashes and capitals don't matter.")}>
              <input className={`input ${styles.keyInput}`} value={code} onChange={(e) => { setCode(e.target.value); setError(null); }} autoComplete="off" autoCapitalize="characters" spellCheck={false} required minLength={12} maxLength={500} />
            </Field>
          )}
          {(mode === "sign_in" || mode === "sign_up") && (
            <div className={styles.labelRow}>
              {mode === "sign_in" && <button type="button" className={`link-btn ${styles.forgot}`} onClick={() => switchTo("forgot")}>{t("Forgot password?")}</button>}
              <Field label={t("Password")} hint={mode === "sign_up" ? t("At least 8 characters.") : undefined}>
                <PasswordInput value={password} onChange={(next) => { setPassword(next); setError(null); }} autoComplete={mode === "sign_up" ? "new-password" : "current-password"} minLength={mode === "sign_up" ? 8 : 1} />
              </Field>
            </div>
          )}
          {error && <Problem>{error}</Problem>}
        </div>

        <div className={styles.acts} data-stack="">
          {mode === "recover" && !typingKey ? (
            <Button variant="primary" icon="upload" loading={busy === "form"} onClick={() => keyFileInput.current?.click()}>{t("Upload key file")}</Button>
          ) : (
            <Button type="submit" variant="primary" loading={busy === "form"} disabled={Boolean(busy)}>
              {{ sign_in: t("Sign in"), sign_up: t("Create account"), magic_link: t("Email me a link"), forgot: t("Send reset link"), recover: t("Continue") }[mode]}
            </Button>
          )}
          {(mode === "sign_in" || (mode === "sign_up" && google)) && <div className={styles.or}>{t("or")}</div>}
          {google && (mode === "sign_in" || mode === "sign_up") && <Button loading={busy === "google"} disabled={Boolean(busy)} onClick={withGoogle} icon="globe">{t("Continue with Google")}</Button>}
          {mode === "sign_in" && <Button icon="mail" onClick={() => switchTo("magic_link")}>{t("Email me a sign-in link")}</Button>}
        </div>

        <div className={styles.ways}>
          {mode === "sign_in" && config.data && <NewPhoneOffer offers={newPhoneOffers(config.data.features)} onPick={(way) => { setCodeWay(way); switchTo("code"); }} />}
          {mode === "recover" && (
            <button type="button" className="link-btn" onClick={() => { setTypingKey(!typingKey); setError(null); }}>
              {typingKey ? t("Upload the key file instead") : t("No file? Type a key from your printout")}
            </button>
          )}
          {mode !== "sign_in" && mode !== "sign_up" && <button type="button" className="link-btn" onClick={() => switchTo("sign_in")}>{t("Back to sign in")}</button>}
        </div>
      </form>
    </AuthLayout>
  );
}

/**
 * Under the sign-in form, for a sub on a new phone: one way in, a code by text or by email, or asking
 * the office. The other way (email for a sub with no phone on file) is a link inside the code screen,
 * so sign-in keeps to one quiet line under its buttons.
 */
function NewPhoneOffer({ offers, onPick }: { offers: ReturnType<typeof newPhoneOffers>; onPick: (way: CodeWay) => void }) {
  if (offers === "ask_office") return <p style={{ margin: 0 }}>{t(ASK_THE_OFFICE)}</p>;
  return offers.slice(0, 1).map((offer) => (
    <button key={offer.way} type="button" className="link-btn" onClick={() => onPick(offer.way)}>
      {offer.label}
    </button>
  ));
}

/** The words that change with the way the code goes: said with t() where they're shown. */
const WAY_WORDS = {
  text: {
    intro: msg("For subcontractors. We'll text a {digits}-digit code to the number the office has for you."),
    send: msg("Text me a code"),
    icon: "smartphone",
    other: msg("Use a different number"),
    switchTo: msg("Get a code by text instead"),
  },
  email: {
    intro: msg("For subcontractors. We'll email a {digits}-digit code to the address the office has for you."),
    send: msg("Email me a code"),
    icon: "mail",
    other: msg("Use a different email"),
    switchTo: msg("No phone on file? Get a code by email instead"),
  },
} as const;

/**
 * A sub on a new phone signs in with a code (textCode.ts): their number or email, then the code. Text
 * comes first when this Crewtavo can text, with email for a sub with no phone on file; email alone when
 * it can't. The answer never says whether the number or address has a sign-in. Once in, the app opens
 * where they were: the offer or visit link they opened, or My day (AppShell sends a sub anywhere else there).
 */
/**
 * The code's boxes (components/ui/CodeField) bring Base UI's OTP field with them, so they're fetched
 * when someone starts signing in with a code, not with the sign-in page every visit downloads. Until
 * they've arrived, or if they can't be fetched, the code goes in one plain box as before.
 */
type CodeBoxes = typeof import("@/components/ui/CodeField").CodeField;
function useCodeBoxes(): CodeBoxes | null {
  const [boxes, setBoxes] = useState<CodeBoxes | null>(null);
  useEffect(() => {
    let live = true;
    import("@/components/ui/CodeField").then((m) => live && setBoxes(() => m.CodeField)).catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return boxes;
}

function CodeSignIn({ initialWay, features, onBack }: { initialWay: CodeWay; features: AppConfig["features"] | undefined; onBack: () => void }) {
  const CodeBoxes = useCodeBoxes();
  const [way, setWay] = useState<CodeWay>(initialWay);
  const [step, setStep] = useState<CodeStep>({ step: "address" });
  // What was typed for each way, so switching back and forth keeps it.
  const [typed, setTyped] = useState<Record<CodeWay, string>>({ text: "", email: "" });
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState<false | "send" | "sign_in">(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now);
  const wait = step.step === "code" ? resendIn(step.sentAt, now) : 0;
  const words = WAY_WORDS[way];
  // Both ways are open only when this Crewtavo texts and emails; the other way is a link under the form.
  const otherWay: CodeWay | null = emailInstead(features) ? (way === "text" ? "email" : "text") : null;

  // The countdown to "Send a new code", from the time the last one went (a timer alone drifts in a background tab).
  useEffect(() => {
    if (!wait) return;
    const t = setTimeout(() => setNow(Date.now()), 1000);
    return () => clearTimeout(t);
  }, [wait, now]);

  async function sendCode(address: string) {
    setBusy("send");
    setError(null);
    try {
      setStep(afterAsking(await askFor(way, address), address, Date.now()));
      setNow(Date.now());
      setCode("");
    } catch (err) {
      setError(codeProblem(err));
    } finally {
      setBusy(false);
    }
  }

  async function signIn(address: string, entered: string) {
    setBusy("sign_in");
    setError(null);
    try {
      await signInWith(way, address, entered); // SessionProvider opens the app.
    } catch (err) {
      setError(codeProblem(err));
      setBusy(false);
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (step.step === "address") {
      const read = readAddress(way, typed[way]);
      if ("error" in read) return setError(read.error);
      void sendCode(read.address);
    } else if (step.step === "code" && wholeCode(code)) {
      void signIn(step.address, code);
    }
  }

  // Filled in from the text, or pasted: sign in straight away.
  function enterCode(input: string) {
    const next = codeDigits(input);
    const all = filledAtOnce(code, next);
    setCode(next);
    setError(null);
    if (all && step.step === "code" && !busy) void signIn(step.address, next);
  }

  function switchWay(next: CodeWay) {
    setWay(next);
    setStep({ step: "address" });
    setCode("");
    setError(null);
  }

  const alert = error && <Problem>{error}</Problem>;

  if (step.step === "off")
    return (
      <AuthLayout>
        <div className={styles.flow}>
          <h1 className={styles.title}>{t("We can't text you a code")}</h1>
          <p className={styles.sub}>{t(TEXTING_OFF)}</p>
          <div className={styles.acts} data-stack="">
            {features?.emailCodes && <Button variant="primary" icon="mail" onClick={() => switchWay("email")}>{t("Get a code by email instead")}</Button>}
            <Button variant="ghost" icon="arrowLeft" onClick={onBack}>{t("Back to sign in")}</Button>
          </div>
        </div>
      </AuthLayout>
    );

  return (
    <AuthLayout {...signInAside()}>
      <form className={styles.flow} onSubmit={submit} noValidate>
        {step.step === "address" ? (
          <>
            <h1 className={styles.title}>{t("Get a sign-in code")}</h1>
            <p className={styles.sub}>{t(words.intro, { digits: SIGN_IN_CODE_DIGITS })}</p>
            <div className={styles.form}>
              {way === "text" ? (
                <Field label={t("Mobile phone")} hint={t("With the area code. Outside the US and Canada, start with + and your country code.")}>
                  <input className="input" type="tel" inputMode="tel" autoComplete="tel" value={typed.text} onChange={(e) => { setTyped({ ...typed, text: formatPhoneTyping(e.target.value) }); setError(null); }} maxLength={40} required autoFocus />
                </Field>
              ) : (
                <Field label={t("Email")}>
                  <input className="input" type="email" inputMode="email" autoComplete="email" autoCapitalize="none" spellCheck={false} value={typed.email} onChange={(e) => { setTyped({ ...typed, email: e.target.value }); setError(null); }} maxLength={254} required autoFocus />
                </Field>
              )}
              {alert}
            </div>
            <div className={styles.acts} data-stack="">
              <Button type="submit" variant="primary" icon={words.icon} loading={busy === "send"}>{t(words.send)}</Button>
            </div>
            <div className={styles.ways}>
              {otherWay && <button type="button" className="link-btn" onClick={() => switchWay(otherWay)}>{t(WAY_WORDS[otherWay].switchTo)}</button>}
              <button type="button" className="link-btn" onClick={onBack}>{t("Back to sign in")}</button>
            </div>
          </>
        ) : (
          <>
            <h1 className={styles.title}>{t("Enter your code")}</h1>
            <p className={styles.sub}>{sentTo(way, step.address)}</p>
            <div className={styles.form}>
              <Field label={t("Code")} hint={t("It runs out in {minutes} minutes.", { minutes: SIGN_IN_CODE_MINUTES })}>
                {CodeBoxes ? (
                  <CodeBoxes length={SIGN_IN_CODE_DIGITS} value={code} onChange={enterCode} normalize={boxedCode} autoFocus />
                ) : (
                  <input className={`input ${styles.codeInput}`} inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => enterCode(boxedCode(e.target.value))} autoFocus />
                )}
              </Field>
              {alert}
            </div>
            <div className={styles.acts} data-stack="">
              <Button type="submit" variant="primary" loading={busy === "sign_in"} disabled={!wholeCode(code) || Boolean(busy)}>{t("Sign in")}</Button>
              <Button disabled={wait > 0 || Boolean(busy)} loading={busy === "send"} onClick={() => sendCode(step.address)}>{resendLabel(wait)}</Button>
            </div>
            <div className={styles.ways}>
              <p style={{ margin: 0 }}>{t(NOTHING_CAME[way])}</p>
              <button type="button" className="link-btn" onClick={() => { setStep({ step: "address" }); setCode(""); setError(null); }}>{t(words.other)}</button>
              <button type="button" className="link-btn" onClick={onBack}>{t("Back to sign in")}</button>
            </div>
          </>
        )}
      </form>
    </AuthLayout>
  );
}

/**
 * After a password-reset or invitation link: choose a password, then carry on into the app.
 * `onSignOut` is the session's, which leaves nothing of theirs on the phone; true once signed out.
 */
export function SetPasswordPage({ kind, onDone, onSignOut, onSignOutElsewhere }: { kind: "recovery" | "invite"; onDone: () => void; onSignOut: () => Promise<boolean>; onSignOutElsewhere: () => Promise<void> }) {
  const [password, setPassword] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 8) return setError(t("Use at least 8 characters."));
    if (password !== confirmPw) return setError(t("Those passwords don't match."));
    setBusy(true);
    const { error } = await supabase().auth.updateUser({ password });
    if (error) {
      setBusy(false);
      return setError(authMessage(error));
    }
    // A reset may follow a lost phone or a leaked password: sign out everywhere else.
    if (kind === "recovery") await onSignOutElsewhere();
    setBusy(false);
    onDone();
  }
  return (
    <AuthLayout>
      <form className={styles.flow} onSubmit={submit}>
        <h1 className={styles.title}>{kind === "invite" ? t("Set your password") : t("Choose a new password")}</h1>
        <div className={styles.form}>
          <Field label={t("New password")} hint={t("At least 8 characters.")}>
            <PasswordInput value={password} onChange={setPassword} autoComplete="new-password" minLength={8} autoFocus show={show} onShow={setShow} />
          </Field>
          <Field label={t("Confirm password")}><input className="input" type={show ? "text" : "password"} value={confirmPw} onChange={(e) => setConfirmPw(e.target.value)} autoComplete="new-password" required /></Field>
          {error && <Problem>{error}</Problem>}
        </div>
        <div className={styles.acts} data-stack="">
          <Button type="submit" variant="primary" loading={busy}>{t("Save password")}</Button>
          {kind === "invite" ? <Button variant="ghost" onClick={onDone}>{t("Skip for now")}</Button> : <Button variant="ghost" icon="arrowLeft" onClick={() => onSignOut().then((signedOut) => signedOut && onDone())}>{t("Back to sign in")}</Button>}
        </div>
      </form>
    </AuthLayout>
  );
}

/**
 * An emailed sign-in, reset or invitation link opened while someone else is signed in here
 * (lib/emailLink.ts): it switches only if they say so. Staying is the first choice, and the link's
 * sign-in is ended then.
 */
export function SwitchAccountPage({ current, link, onAnswer }: { current: string; link: string; onAnswer: (switchAccounts: boolean) => void }) {
  return (
    <AuthLayout>
      <div className={styles.flow}>
        <h1 className={styles.title}>{t("Switch accounts?")}</h1>
        <p className={styles.sub}>
          <T text="This link signs in as <b>{link}</b>. You're signed in here as <b>{current}</b>." b={(s) => <strong style={{ overflowWrap: "anywhere" }}>{s}</strong>} link={link} current={current} />
        </p>
        <p className={styles.sub}>{t("Only switch if you asked for this link yourself. A link someone else sent you signs you in to their account.")}</p>
        <div className={styles.acts} data-stack="">
          <Button variant="primary" autoFocus onClick={() => onAnswer(false)}>{t("Stay signed in")}</Button>
          <Button variant="ghost" onClick={() => onAnswer(true)}>{t("Switch accounts")}</Button>
        </div>
      </div>
    </AuthLayout>
  );
}
