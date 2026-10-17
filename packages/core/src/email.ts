/**
 * Ways a company can send email from its own account: a mailbox it already pays for (Gmail, Google
 * Workspace, Zoho, Microsoft 365, Yahoo, iCloud) over SMTP with an app password, any other SMTP
 * server, or a Resend account. Shared by the Email settings screen and the API that sends.
 */

export type MailSecurity = "tls" | "starttls";

export interface MailPreset {
  id: "gmail" | "google_workspace" | "zoho" | "microsoft" | "yahoo" | "icloud" | "other" | "resend";
  label: string;
  /** "smtp": host, port, sign-in and app password. "resend": an API key. */
  kind: "smtp" | "resend";
  host?: string;
  port?: number;
  security?: MailSecurity;
  /** What to call the password field: most providers want an app password, not the real one. */
  passwordLabel: string;
  /** Short steps for getting an app password, shown next to the form. */
  steps: string[];
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
  {
    id: "resend",
    label: "Resend",
    kind: "resend",
    passwordLabel: "API key",
    steps: [
      "Create a free Resend account and add your domain under Domains (it shows a few DNS records to add where your domain is hosted).",
      "Once the domain shows Verified, create an API key with Sending access and paste it here.",
    ],
    helpUrl: "https://resend.com/domains",
    helpLabel: "Open Resend",
    dailyLimit: "100 a day free, more on paid plans",
    note: "Best for large email campaigns. It needs DNS changes on your domain, so a mailbox above is quicker to set up.",
  },
];

export const mailPreset = (id: string | null | undefined) => MAIL_PRESETS.find((p) => p.id === id);
