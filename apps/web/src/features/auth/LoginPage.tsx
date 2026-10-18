/** Sign in (password, emailed link or Google), create an account, reset a password, or set a new one. */
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { api, loadConfig, supabase } from "@/lib/api";
import styles from "./auth.module.css";
import { BrandLockup } from "@/components/shell/BrandMark";

type Mode = "sign_in" | "sign_up" | "magic_link" | "forgot";

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
      if (!res.ok) throw new Error("settings");
      return (await res.json()) as { external?: Record<string, boolean>; disable_signup?: boolean };
    },
  });
}

/** Supabase's messages, in plain words. */
export function authMessage(error: { message: string; status?: number; code?: string }): string {
  const m = error.message.toLowerCase();
  if (m.includes("invalid login credentials")) return "That email and password don't match. Check them, or reset your password.";
  if (m.includes("email not confirmed")) return "Confirm your email first. We sent you a link when you signed up.";
  if (m.includes("user already registered") || m.includes("already been registered")) return "There's already an account with that email. Sign in instead.";
  if (m.includes("rate limit") || error.status === 429) return "Too many attempts. Wait a minute and try again.";
  if (m.includes("signups not allowed") || m.includes("signup is disabled")) return "New accounts are by invitation. Ask your company's admin to invite you.";
  if (m.includes("same password") || m.includes("different from the old")) return "Your new password has to be different from the old one.";
  if (m.includes("password should be") || m.includes("weak")) return "Choose a stronger password: at least 8 characters, mixing letters and numbers.";
  if (m.includes("failed to fetch") || m.includes("network")) return "You seem to be offline. Check your connection and try again.";
  return error.message;
}

export function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <div className={styles.brand}><BrandLockup size={34} /></div>
        {children}
      </main>
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
  const settings = useAuthSettings();
  const [mode, setMode] = useState<Mode>("sign_in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState<false | "form" | "google">(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<null | { kind: "link" | "confirm" | "reset"; email: string }>(null);
  const [cooldown, setCooldown] = useState(0);
  const [confirming, setConfirming] = useState<{ email: string; password: string } | null>(null);
  useSignInWhenConfirmed(confirming);
  const google = settings.data?.external?.google ?? false;
  const signupOpen = !settings.data?.disable_signup;

  useEffect(() => {
    if (!cooldown) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  const switchTo = (next: Mode) => {
    setMode(next);
    setError(null);
  };

  async function send(kind: "link" | "reset" | "confirm") {
    if (kind === "confirm") {
      const { error } = await supabase().auth.resend({ type: "signup", email: email.trim(), options: { emailRedirectTo: window.location.origin } });
      if (error) throw error;
    } else {
      // Sent by the API from the company's own mailbox, so it reaches people Supabase's mailer won't.
      await api.post("/auth/email-link", { email: email.trim(), kind: kind === "link" ? "magiclink" : "recovery" });
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
        if (fullName.trim().length < 2) throw new Error("Enter your name.");
        const { data, error } = await auth.signUp({ email: email.trim(), password, options: { data: { full_name: fullName.trim() }, emailRedirectTo: window.location.origin } });
        if (error) throw error;
        if (!data.session) {
          setSent({ kind: "confirm", email: email.trim() });
          setConfirming({ email: email.trim(), password });
          setCooldown(60);
        }
      } else {
        await send(mode === "magic_link" ? "link" : "reset");
      }
    } catch (err) {
      setError(authMessage(err as { message: string }));
    } finally {
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

  if (sent)
    return (
      <AuthLayout>
        <div className={`card card-pad ${styles.card}`} style={{ padding: 32 }}>
          <div className={styles.sent}>
            <span className={styles.sentIcon}><Icon name="mail" size={26} /></span>
            <h1 className={styles.title} style={{ fontSize: 22 }}>Check your email</h1>
            <p className="muted" style={{ margin: 0 }}>
              {sent.kind === "link" ? "Sign-in link sent to " : sent.kind === "reset" ? "Reset link sent to " : "Confirmation link sent to "}
              <strong style={{ color: "var(--ink)" }}>{sent.email}</strong>
            </p>
            {sent.kind === "confirm" && (
              <>
                <p style={{ margin: 0 }}>Open the link in that email, then come back to this tab. You'll be signed in automatically.</p>
                <p className="muted small" style={{ margin: 0 }}>If the link opens a page that doesn't load, that's fine: your email is still confirmed. Not there after a few minutes? Check your spam folder.</p>
              </>
            )}
          </div>
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
            {cooldown > 0 ? `Send again in ${cooldown}s` : "Send again"}
          </Button>
          {error && <p role="alert" className="field-error" style={{ margin: 0 }}>{error}</p>}
          <Button variant="ghost" icon="arrowLeft" onClick={() => { setSent(null); setConfirming(null); switchTo("sign_in"); }}>Back to sign in</Button>
        </div>
      </AuthLayout>
    );

  const heading = { sign_in: "Sign in", sign_up: "Create your account", magic_link: "Sign in with email", forgot: "Reset your password" }[mode];

  return (
    <AuthLayout>
      <form className={`card card-pad ${styles.card}`} style={{ padding: 28 }} onSubmit={submit} noValidate={false}>
        <h1 className={styles.title}>{heading}</h1>
        {notice && mode === "sign_in" && <div className="callout callout-warning" role="status" style={{ padding: "10px 12px" }}><Icon name="alert" size={16} /><span className="grow small" style={{ fontWeight: 600 }}>{notice}</span></div>}

        {mode === "sign_up" && (
          <Field label="Your name"><input className="input" value={fullName} onChange={(e) => setFullName(e.target.value)} autoComplete="name" required minLength={2} maxLength={120} autoFocus /></Field>
        )}
        <Field label="Email"><input className="input" type="email" value={email} onChange={(e) => { setEmail(e.target.value); setError(null); }} autoComplete="email" required autoFocus={mode !== "sign_up"} inputMode="email" /></Field>
        {(mode === "sign_in" || mode === "sign_up") && (
          <div style={{ position: "relative" }}>
          {mode === "sign_in" && <button type="button" className="link-btn small" style={{ position: "absolute", top: 0, right: 0, zIndex: 1 }} onClick={() => switchTo("forgot")}>Forgot password?</button>}
          <Field label="Password" hint={mode === "sign_up" ? "At least 8 characters." : undefined}>
            <div className="input-group">
              <input className="input" type={show ? "text" : "password"} value={password} onChange={(e) => { setPassword(e.target.value); setError(null); }} autoComplete={mode === "sign_up" ? "new-password" : "current-password"} minLength={mode === "sign_up" ? 8 : 1} required style={{ paddingLeft: 12, paddingRight: 40 }} />
              <button type="button" className="icon-btn" style={{ position: "absolute", right: 3 }} aria-label={show ? "Hide password" : "Show password"} onClick={() => setShow(!show)}><Icon name={show ? "eye" : "lock"} size={16} /></button>
            </div>
          </Field>
          </div>
        )}

        {error && <div className="callout callout-warning" role="alert" style={{ padding: "10px 12px" }}><Icon name="alert" size={16} /><span className="grow small" style={{ fontWeight: 600 }}>{error}</span></div>}

        <Button type="submit" variant="primary" size="lg" loading={busy === "form"} disabled={Boolean(busy)}>
          {{ sign_in: "Sign in", sign_up: "Create account", magic_link: "Email me a link", forgot: "Send reset link" }[mode]}
        </Button>

        {(mode === "sign_in" || (mode === "sign_up" && google)) && (
          <>
            <div className={styles.divider}>or</div>
            {google && <Button size="lg" loading={busy === "google"} disabled={Boolean(busy)} onClick={withGoogle} icon="globe">Continue with Google</Button>}
            {mode === "sign_in" && <Button size="lg" variant="ghost" icon="mail" onClick={() => switchTo("magic_link")}>Email me a sign-in link</Button>}
          </>
        )}

        <div className={styles.links} style={{ justifyContent: "center" }}>
          {mode === "sign_in" ? (
            signupOpen && <span className="muted">New to Crewtavo? <button type="button" className="link-btn" onClick={() => switchTo("sign_up")}>Create an account</button></span>
          ) : (
            <span className="muted">{mode === "sign_up" ? "Already have an account? " : ""}<button type="button" className="link-btn" onClick={() => switchTo("sign_in")}>{mode === "sign_up" ? "Sign in" : "Back to sign in"}</button></span>
          )}
        </div>
      </form>
    </AuthLayout>
  );
}

/**
 * After a password-reset or invitation link: choose a password, then carry on into the app.
 * `onSignOut` is the session's, which leaves nothing of theirs on the phone; true once signed out.
 */
export function SetPasswordPage({ kind, onDone, onSignOut }: { kind: "recovery" | "invite"; onDone: () => void; onSignOut: () => Promise<boolean> }) {
  const [password, setPassword] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 8) return setError("Use at least 8 characters.");
    if (password !== confirmPw) return setError("Those passwords don't match.");
    setBusy(true);
    const { error } = await supabase().auth.updateUser({ password });
    setBusy(false);
    if (error) setError(authMessage(error));
    else onDone();
  }
  return (
    <AuthLayout>
      <form className={`card card-pad ${styles.card}`} style={{ padding: 28 }} onSubmit={submit}>
        <h1 className={styles.title}>{kind === "invite" ? "Set your password" : "Choose a new password"}</h1>
        <Field label="New password" hint="At least 8 characters.">
          <div className="input-group">
            <input className="input" type={show ? "text" : "password"} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" minLength={8} required autoFocus style={{ paddingLeft: 12, paddingRight: 40 }} />
            <button type="button" className="icon-btn" style={{ position: "absolute", right: 3 }} aria-label={show ? "Hide password" : "Show password"} onClick={() => setShow(!show)}><Icon name={show ? "eye" : "lock"} size={16} /></button>
          </div>
        </Field>
        <Field label="Confirm password"><input className="input" type={show ? "text" : "password"} value={confirmPw} onChange={(e) => setConfirmPw(e.target.value)} autoComplete="new-password" required /></Field>
        {error && <div className="callout callout-warning" role="alert" style={{ padding: "10px 12px" }}><Icon name="alert" size={16} /><span className="grow small" style={{ fontWeight: 600 }}>{error}</span></div>}
        <Button type="submit" variant="primary" size="lg" loading={busy}>Save password</Button>
        {kind === "invite" ? <Button variant="ghost" onClick={onDone}>Skip for now</Button> : <Button variant="ghost" icon="arrowLeft" onClick={() => onSignOut().then((signedOut) => signedOut && onDone())}>Back to sign in</Button>}
      </form>
    </AuthLayout>
  );
}
