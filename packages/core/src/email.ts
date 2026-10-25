/**
 * Ways a company can send email from its own account: a Resend account (recommended: it works on
 * every Railway plan, where mail servers are blocked on trial and Hobby), a mailbox it already pays
 * for (Gmail, Google Workspace, Zoho, Microsoft 365, Yahoo, iCloud) over SMTP with an app password,
 * or any other SMTP server. Shared by the Email settings screen and the API that sends.
 */

export type MailSecurity = "tls" | "starttls";

/** A setup step with a heading, and a button to the page where it's done. */
export interface MailStep {
  title: string;
  text: string;
  url?: string;
  urlLabel?: string;
}

export interface MailPreset {
  id: "gmail" | "google_workspace" | "zoho" | "microsoft" | "yahoo" | "icloud" | "other" | "resend";
  label: string;
  /** "smtp": host, port, sign-in and app password. "resend": an API key. */
  kind: "smtp" | "resend";
  /** Shown first, on its own, with this one-line reason. */
  recommended?: boolean;
  summary?: string;
  host?: string;
  port?: number;
  security?: MailSecurity;
  /** What to call the password field: most providers want an app password, not the real one. */
  passwordLabel: string;
  /** Short steps for getting an app password (or API key), shown next to the form. */
  steps: Array<string | MailStep>;
  /** Where the person creates the app password (or API key). */
  helpUrl?: string;
  helpLabel?: string;
  /** About how many emails a day the provider allows from one mailbox. */
  dailyLimit?: string;
  /** Anything worth knowing before picking this one. */
  note?: string;
}

export const MAIL_PRESETS: MailPreset[] = [
  {
    id: "resend",
    label: "Resend",
    kind: "resend",
    recommended: true,
    summary: "Made for sending business email, so it reaches inboxes. Free for up to 100 emails a day, and it works on every Railway plan.",
    passwordLabel: "API key",
    steps: [
      {
        title: "Create a free Resend account",
        text: "Sign up with your email or Google account. The free plan sends up to 100 emails a day (3,000 a month).",
        url: "https://resend.com/signup",
        urlLabel: "Sign up for Resend",
      },
      {
        title: "Add your domain",
        text: "Open Domains, press Add Domain and type your website's address, like yourcompany.com. Resend lists a few DNS records: add them where you manage your domain (GoDaddy, Namecheap, Squarespace, Cloudflare…), then wait for Resend to show Verified. That's usually within 15 minutes.",
        url: "https://resend.com/domains",
        urlLabel: "Open Domains",
      },
      {
        title: "Create an API key",
        text: "Open API keys and press Create API Key. Name it Crewtavo, choose Sending access, and leave the domain on all domains so it isn't tied to just one. Copy the key right away: Resend only shows it once.",
        url: "https://resend.com/api-keys",
        urlLabel: "Open API keys",
      },
      {
        title: "Paste it below",
        text: "Send from can be any address on the domain you added, like office@yourcompany.com. It doesn't need its own inbox.",
      },
    ],
    dailyLimit: "up to 100 emails a day (3,000 a month) on the free plan, more on paid plans",
  },
  {
    id: "gmail",
    label: "Gmail",
    kind: "smtp",
    host: "smtp.gmail.com",
    port: 465,
    security: "tls",
    passwordLabel: "App password",
    steps: [
      "Turn on 2-Step Verification for the Google account, if it isn't on already.",
      "Open App passwords, type Crewtavo as the name and press Create.",
      "Copy the 16-letter password Google shows and paste it here.",
    ],
    helpUrl: "https://myaccount.google.com/apppasswords",
    helpLabel: "Open Google App passwords",
    dailyLimit: "about 500 emails a day",
  },
  {
    id: "google_workspace",
    label: "Google Workspace",
    kind: "smtp",
    host: "smtp.gmail.com",
    port: 465,
    security: "tls",
    passwordLabel: "App password",
    steps: [
      "Sign in as the mailbox you want to send from (for example office@yourcompany.com).",
      "Turn on 2-Step Verification, then open App passwords and create one named Crewtavo.",
      "Copy the 16-letter password and paste it here.",
    ],
    helpUrl: "https://myaccount.google.com/apppasswords",
    helpLabel: "Open Google App passwords",
    dailyLimit: "about 2,000 emails a day",
    note: "If App passwords is missing, your Workspace admin has to allow them (Admin console → Security → Less secure apps and app passwords).",
  },
  {
    id: "zoho",
    label: "Zoho Mail",
    kind: "smtp",
    host: "smtppro.zoho.com",
    port: 465,
    security: "tls",
    passwordLabel: "App-specific password",
    steps: [
      "Open Zoho Accounts → Security → App Passwords.",
      "Generate a new password named Crewtavo.",
      "Paste it here. Your sign-in is your full Zoho email address.",
    ],
    helpUrl: "https://accounts.zoho.com/home#security/app_password",
    helpLabel: "Open Zoho App Passwords",
    note: "Business mailboxes on your own domain use smtppro.zoho.com; free personal accounts use smtp.zoho.com. Accounts in Europe, India or Australia end in .eu, .in or .com.au instead of .com.",
  },
  {
    id: "microsoft",
    label: "Microsoft 365 / Outlook",
    kind: "smtp",
    host: "smtp.office365.com",
    port: 587,
    security: "starttls",
    passwordLabel: "Password or app password",
    steps: [
      "Use the full email address and its password. If the account has two-step sign-in, create an app password instead.",
      "Your Microsoft 365 admin may need to turn on Authenticated SMTP for this mailbox (Admin center → Users → Mail → Manage email apps).",
    ],
    helpUrl: "https://account.microsoft.com/security",
    helpLabel: "Open Microsoft security settings",
    dailyLimit: "about 10,000 emails a day",
    note: "Microsoft is turning password sign-in for sending off by default for business accounts at the end of 2026. An admin can switch it back on; Gmail or Zoho avoid the question.",
  },
  {
    id: "yahoo",
    label: "Yahoo Mail",
    kind: "smtp",
    host: "smtp.mail.yahoo.com",
    port: 465,
    security: "tls",
    passwordLabel: "App password",
    steps: ["Open Yahoo Account security.", "Choose Generate app password, name it Crewtavo, and paste it here."],
    helpUrl: "https://login.yahoo.com/account/security",
    helpLabel: "Open Yahoo Account security",
    dailyLimit: "a few hundred emails a day",
  },
  {
    id: "icloud",
    label: "iCloud Mail",
    kind: "smtp",
    host: "smtp.mail.me.com",
    port: 587,
    security: "starttls",
    passwordLabel: "App-specific password",
    steps: ["Sign in to your Apple Account, open Sign-In and Security → App-Specific Passwords.", "Create one named Crewtavo and paste it here."],
    helpUrl: "https://account.apple.com/account/manage",
    helpLabel: "Open Apple Account",
    dailyLimit: "about 1,000 emails a day",
  },
  {
    id: "other",
    label: "Another email provider",
    kind: "smtp",
    port: 465,
    security: "tls",
    passwordLabel: "Password",
    steps: ["Your email provider's help pages list its SMTP (outgoing mail) server, port and whether it uses SSL.", "Most providers want an app password rather than your normal one."],
  },
];

export const mailPreset = (id: string | null | undefined) => MAIL_PRESETS.find((p) => p.id === id);

/** Free personal mail services. Resend only sends from a domain you own, never from one of these. */
const PERSONAL_MAIL = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "ymail.com", "outlook.com", "hotmail.com", "live.com", "msn.com",
  "icloud.com", "me.com", "mac.com", "aol.com", "proton.me", "protonmail.com", "gmx.com", "mail.com", "zoho.com", "yandex.com",
]);
export const isPersonalMailDomain = (domain: string) => PERSONAL_MAIL.has(domain.trim().toLowerCase());
/** The part after the @, lowercased ("" when there isn't one). */
export const emailDomain = (email: string) => (email.includes("@") ? email.slice(email.lastIndexOf("@") + 1).trim().toLowerCase() : "");

/**
 * An address nothing ever emails: the stand-in a sub's sign-in gets when the office has no email for
 * them (subLoginEmail in subs.ts), on the .invalid domain set aside for exactly this (RFC 2606).
 */
export const isPlaceholderEmail = (email: string | null | undefined) => typeof email === "string" && /\.invalid$/i.test(email.trim());

/**
 * An email address in one spelling, trimmed and lower-cased, as signing in with a code by email
 * compares them (private.email_key in supabase/migrations/20261025006001_email_sign_in_codes.sql
 * spells the office's addresses the same way); null when it isn't a whole address.
 */
export function emailKey(input: string | null | undefined): string | null {
  const key = (input ?? "").trim().toLowerCase();
  return key.length <= 254 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(key) ? key : null;
}
