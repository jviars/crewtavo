/** Sign in (password, emailed link, Google or a sub's code by text or email), create an account, reset a password, or set a new one. */
import { SIGN_IN_CODE_DIGITS, SIGN_IN_CODE_MINUTES } from "@crewtavo/core/subs";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ChangeEvent, type ClipboardEvent, type FormEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { api, loadConfig, supabase, type AppConfig } from "@/lib/api";
import { KEY_FILE_NAME, readKeyFile } from "@/lib/keyFile";
import styles from "./auth.module.css";
import { BrandLockup } from "@/components/shell/BrandMark";
import { afterAsking, ASK_THE_OFFICE, askFor, codeDigits, codeProblem, emailInstead, filledAtOnce, newPhoneOffers, NOTHING_CAME, readAddress, resendIn, resendLabel, sentTo, signInWith, TEXTING_OFF, wholeCode, type CodeStep, type CodeWay } from "./textCode";

type Mode = "sign_in" | "sign_up" | "magic_link" | "forgot" | "recover" | "code";

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
  // Already loaded by SessionProvider: whether this Crewtavo can text or email a sub a code on a new phone.
  const config = useQuery({ queryKey: ["config"], queryFn: loadConfig, staleTime: Infinity, meta: { silent: true } });
  const [mode, setMode] = useState<Mode>("sign_in");
  const [codeWay, setCodeWay] = useState<CodeWay>("text");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [show, setShow] = useState(false);
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
  const signupOpen = !settings.data?.disable_signup;

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
        if (fullName.trim().length < 2) throw new Error("Enter your name.");
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
    const notAKeyFile = `That doesn't look like your key file. It's called ${KEY_FILE_NAME}.`;
    if (file.size > 20_000) return setError(notAKeyFile);
    const { email: account, keys } = readKeyFile(await file.text());
    if (!keys.length) return setError(notAKeyFile);
    if (!account) {
      setTypingKey(true);
      return setError("Enter your email, then one of the keys from the file.");
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
        <div className={`card card-pad ${styles.card}`} style={{ padding: 28 }}>
          <h1 className={styles.title} style={{ fontSize: 22 }}>We can't email you a link</h1>
          <p className="muted" style={{ margin: 0 }}>This Crewtavo isn't set up to send email yet, so here's how to get back in:</p>
          <ul style={{ margin: 0, paddingLeft: 20, display: "grid", gap: 10, lineHeight: 1.5 }}>
            <li><strong>On a team?</strong> Ask the owner or an admin for a reset link. They make one under <strong>Settings → People</strong>, next to your name.</li>
            <li><strong>The owner?</strong> Upload the key file you saved when you set up Crewtavo.</li>
          </ul>
          <Button variant="primary" icon="lock" onClick={() => { setEmailOff(false); switchTo("recover"); }}>I'm the owner: use my key file</Button>
          <Button variant="ghost" icon="arrowLeft" onClick={() => { setEmailOff(false); switchTo("sign_in"); }}>Back to sign in</Button>
        </div>
      </AuthLayout>
    );

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

  const heading = { sign_in: "Sign in", sign_up: "Create your account", magic_link: "Sign in with email", forgot: "Reset your password", recover: typingKey ? "Type a spare key" : "Use your key file" }[mode];

  return (
    <AuthLayout>
      <form className={`card card-pad ${styles.card}`} style={{ padding: 28 }} onSubmit={submit} noValidate={false}>
        <h1 className={styles.title}>{heading}</h1>
        {notice && mode === "sign_in" && <div className="callout callout-warning" role="status" style={{ padding: "10px 12px" }}><Icon name="alert" size={16} /><span className="grow small" style={{ fontWeight: 600 }}>{notice}</span></div>}

        {mode === "recover" && !typingKey && (
          <>
            <p style={{ margin: 0, lineHeight: 1.5 }}>Upload the key file you saved when you set up Crewtavo. It's called <strong>{KEY_FILE_NAME}</strong>.</p>
            <input ref={keyFileInput} type="file" accept=".txt,text/plain" hidden onChange={submitKeyFile} />
            <Button variant="primary" size="lg" icon="upload" loading={busy === "form"} onClick={() => keyFileInput.current?.click()}>Upload key file</Button>
          </>
        )}
        {mode === "recover" && typingKey && (
          <p className="muted small" style={{ margin: 0, lineHeight: 1.5 }}>
            Enter your email and one of the keys from your key file or printout. Each key works once.
          </p>
        )}
        {mode === "sign_up" && (
          <Field label="Your name"><input className="input" value={fullName} onChange={(e) => setFullName(e.target.value)} autoComplete="name" required minLength={2} maxLength={120} autoFocus /></Field>
        )}
        {!(mode === "recover" && !typingKey) && <Field label="Email"><input className="input" type="email" value={email} onChange={(e) => { setEmail(e.target.value); setError(null); }} autoComplete="email" required autoFocus={mode !== "sign_up"} inputMode="email" /></Field>}
        {mode === "recover" && typingKey && (
          <Field label="Spare key" hint="Like 7K4M-PQ2X-9DRF. Dashes and capitals don't matter.">
            <input className="input" value={code} onChange={(e) => { setCode(e.target.value); setError(null); }} autoComplete="off" autoCapitalize="characters" spellCheck={false} required minLength={12} maxLength={500} style={{ fontFamily: "ui-monospace, Menlo, Consolas, monospace", letterSpacing: "0.04em" }} />
          </Field>
        )}
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

        {!(mode === "recover" && !typingKey) && (
          <Button type="submit" variant="primary" size="lg" loading={busy === "form"} disabled={Boolean(busy)}>
            {{ sign_in: "Sign in", sign_up: "Create account", magic_link: "Email me a link", forgot: "Send reset link", recover: "Continue" }[mode]}
          </Button>
        )}
        {mode === "recover" && (
          <button type="button" className="link-btn small" style={{ justifySelf: "center" }} onClick={() => { setTypingKey(!typingKey); setError(null); }}>
            {typingKey ? "Upload the key file instead" : "No file? Type a key from your printout"}
          </button>
        )}

        {(mode === "sign_in" || (mode === "sign_up" && google)) && (
          <>
            <div className={styles.divider}>or</div>
            {google && <Button size="lg" loading={busy === "google"} disabled={Boolean(busy)} onClick={withGoogle} icon="globe">Continue with Google</Button>}
            {mode === "sign_in" && <Button size="lg" variant="ghost" icon="mail" onClick={() => switchTo("magic_link")}>Email me a sign-in link</Button>}
          </>
        )}
        {mode === "sign_in" && config.data && <NewPhoneOffer offers={newPhoneOffers(config.data.features)} onPick={(way) => { setCodeWay(way); switchTo("code"); }} />}

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
 * Under the sign-in form, for a sub on a new phone: a code by text (and by email instead, for a sub
 * with no phone on file), a code by email, or asking the office.
 */
function NewPhoneOffer({ offers, onPick }: { offers: ReturnType<typeof newPhoneOffers>; onPick: (way: CodeWay) => void }) {
  if (offers === "ask_office") return <p className="muted small" style={{ margin: 0, textAlign: "center" }}>{ASK_THE_OFFICE}</p>;
  return offers.map((offer) => (
    <button key={offer.way} type="button" className="link-btn small" style={{ justifySelf: "center" }} onClick={() => onPick(offer.way)}>
      {offer.label}
    </button>
  ));
}

/** The words that change with the way the code goes. */
const WAY_WORDS = {
  text: {
    intro: `For subcontractors. We'll text a ${SIGN_IN_CODE_DIGITS}-digit code to the number the office has for you.`,
    send: "Text me a code",
    icon: "smartphone",
    other: "Use a different number",
    switchTo: "Get a code by text instead",
  },
  email: {
    intro: `For subcontractors. We'll email a ${SIGN_IN_CODE_DIGITS}-digit code to the address the office has for you.`,
    send: "Email me a code",
    icon: "mail",
    other: "Use a different email",
    switchTo: "No phone on file? Get a code by email instead",
  },
} as const;

/**
 * A sub on a new phone signs in with a code (textCode.ts): their number or email, then the code. Text
 * comes first when this Crewtavo can text, with email for a sub with no phone on file; email alone when
 * it can't. The answer never says whether the number or address has a sign-in. Once in, the app opens
 * where they were: the offer or visit link they opened, or My day (AppShell sends a sub anywhere else there).
 */
function CodeSignIn({ initialWay, features, onBack }: { initialWay: CodeWay; features: AppConfig["features"] | undefined; onBack: () => void }) {
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

  // Filled in from the text, or pasted (maxLength would cut "123 456" short): sign in straight away.
  function enterCode(input: string) {
    const next = codeDigits(input);
    const all = filledAtOnce(code, next);
    setCode(next);
    setError(null);
    if (all && step.step === "code" && !busy) void signIn(step.address, next);
  }
  function pasteCode(e: ClipboardEvent<HTMLInputElement>) {
    e.preventDefault();
    enterCode(e.clipboardData.getData("text"));
  }

  function switchWay(next: CodeWay) {
    setWay(next);
    setStep({ step: "address" });
    setCode("");
    setError(null);
  }

  const alert = error && <div className="callout callout-warning" role="alert" style={{ padding: "10px 12px" }}><Icon name="alert" size={16} /><span className="grow small" style={{ fontWeight: 600 }}>{error}</span></div>;

  if (step.step === "off")
    return (
      <AuthLayout>
        <div className={`card card-pad ${styles.card}`} style={{ padding: 28 }}>
          <h1 className={styles.title} style={{ fontSize: 22 }}>We can't text you a code</h1>
          <p className="muted" style={{ margin: 0 }}>{TEXTING_OFF}</p>
          {features?.emailCodes && <Button variant="primary" icon="mail" onClick={() => switchWay("email")}>Get a code by email instead</Button>}
          <Button variant="ghost" icon="arrowLeft" onClick={onBack}>Back to sign in</Button>
        </div>
      </AuthLayout>
    );

  return (
    <AuthLayout>
      <form className={`card card-pad ${styles.card}`} style={{ padding: 28 }} onSubmit={submit} noValidate>
        {step.step === "address" ? (
          <>
            <h1 className={styles.title}>Get a sign-in code</h1>
            <p className="muted" style={{ margin: 0, lineHeight: 1.5 }}>{words.intro}</p>
            {way === "text" ? (
              <Field label="Mobile phone" hint="With the area code. Outside the US and Canada, start with + and your country code.">
                <input className="input" type="tel" inputMode="tel" autoComplete="tel" value={typed.text} onChange={(e) => { setTyped({ ...typed, text: e.target.value }); setError(null); }} maxLength={40} required autoFocus />
              </Field>
            ) : (
              <Field label="Email">
                <input className="input" type="email" inputMode="email" autoComplete="email" autoCapitalize="none" spellCheck={false} value={typed.email} onChange={(e) => { setTyped({ ...typed, email: e.target.value }); setError(null); }} maxLength={254} required autoFocus />
              </Field>
            )}
            {alert}
            <Button type="submit" variant="primary" size="lg" icon={words.icon} loading={busy === "send"}>{words.send}</Button>
            {otherWay && <button type="button" className="link-btn small" style={{ justifySelf: "center" }} onClick={() => switchWay(otherWay)}>{WAY_WORDS[otherWay].switchTo}</button>}
          </>
        ) : (
          <>
            <h1 className={styles.title}>Enter your code</h1>
            <p className="muted" style={{ margin: 0, lineHeight: 1.5 }}>{sentTo(way, step.address)}</p>
            <Field label="Code" hint={`It runs out in ${SIGN_IN_CODE_MINUTES} minutes.`}>
              <input
                className="input"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]*"
                maxLength={SIGN_IN_CODE_DIGITS}
                value={code}
                onChange={(e) => enterCode(e.target.value)}
                onPaste={pasteCode}
                autoFocus
                style={{ fontSize: 22, letterSpacing: "0.3em", fontVariantNumeric: "tabular-nums" }}
              />
            </Field>
            {alert}
            <Button type="submit" variant="primary" size="lg" loading={busy === "sign_in"} disabled={!wholeCode(code) || Boolean(busy)}>Sign in</Button>
            <Button disabled={wait > 0 || Boolean(busy)} loading={busy === "send"} onClick={() => sendCode(step.address)}>{resendLabel(wait)}</Button>
            <p className="muted small" style={{ margin: 0, textAlign: "center" }}>{NOTHING_CAME[way]}</p>
            <button type="button" className="link-btn small" style={{ justifySelf: "center" }} onClick={() => { setStep({ step: "address" }); setCode(""); setError(null); }}>{words.other}</button>
          </>
        )}
        <div className={styles.links} style={{ justifyContent: "center" }}>
          <button type="button" className="link-btn" onClick={onBack}>Back to sign in</button>
        </div>
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
    if (password.length < 8) return setError("Use at least 8 characters.");
    if (password !== confirmPw) return setError("Those passwords don't match.");
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
