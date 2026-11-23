/**
 * Website forms (routes/websiteForms.ts): new addresses, the email for each message, and the pages
 * people see at the form's address: the thank-you page after sending, what went wrong when it
 * didn't, and what the address is for when someone opens it. The pages are plain HTML from the
 * server, so they work whatever the website is built with, without the web app.
 */
import { documentColor } from "@crewtavo/core/documents";
import { PRIVACY_LINK_LABEL } from "@crewtavo/core/privacyPolicy";
import { cardColors } from "@crewtavo/core/social";
import { messageEmail, type PromoResult, type Submission } from "@crewtavo/core/websiteForms";
import type { Env } from "../env";
import { renderEmail } from "../lib/email";
import { sendEmail } from "../lib/notify";
import { logoImage } from "./logo";

/** A form's address: 10 letters and digits, random (website_forms.key). */
export function newFormKey(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  // 252 is the largest multiple of 36 under 256, so every character is as likely as the next.
  const out: string[] = [];
  while (out.length < 10) {
    for (const byte of crypto.getRandomValues(new Uint8Array(16))) {
      if (byte < 252 && out.length < 10) out.push(alphabet[byte % 36]!);
    }
  }
  return out.join("");
}

export interface FormCompany {
  id: string;
  name: string;
  settings: unknown;
  /** Its website on Settings → Company: where a form's _next may send people (routes/websiteForms.ts). */
  website?: string | null;
}

/**
 * Email each message to the people the form names, replying to whoever sent it. Sent one by one; a
 * failure is logged. `base`: this Crewtavo's own address (APP_URL), for the request's link and the
 * logo; null without one, when the address a request came to is whatever its sender wrote, so the
 * email has neither and says where the request is.
 */
export async function emailMessage(
  env: Env,
  input: { base: string | null; company: FormCompany; form: { name: string; email_to: string[] }; submission: Submission; requestId: string; promo?: PromoResult },
): Promise<void> {
  const { base, company, form, submission } = input;
  const { subject, text } = messageEmail({ formName: form.name, submission, link: base ? `${base}/requests/${input.requestId}` : null, promo: input.promo });
  // What the visitor typed is in it: only the request's own link here is a button.
  const email = renderEmail({ companyName: company.name, logo: base ? logoImage(base, company.id, company.settings) : null, text, base });
  for (const to of form.email_to) {
    const result = await sendEmail(env, { to, subject, text: email.text, html: email.html, replyTo: submission.email ?? undefined, fromName: company.name }, company.id);
    if (!result.sent) console.warn(`Website form email to ${to} wasn't sent: ${result.reason ?? "unknown reason"}`);
  }
}

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export interface FormPage {
  title: string;
  heading: string;
  text: string;
  /**
   * The business, when the address is one of its forms: its logo, or its name, its privacy policy link
   * when it set one, and its brand color (brandColor(settings)) for the check and the button.
   */
  company?: { name: string; logo: { src: string; width: number; height: number } | null; privacy_url?: string | null; color?: string | null } | null;
  /** A button back to the page people came from (shown only when there is one). */
  back?: string;
  tone?: "good" | "problem";
}

/**
 * One of the form address's own pages. Always light, as every page a business's clients see is, in the
 * business's brand color; without one, the navy its quotes and invoices print in (as the Client Hub).
 */
export function formPage({ title, heading, text, company, back, tone = "good" }: FormPage): string {
  const color = /^#[0-9a-f]{6}$/i.test(company?.color ?? "") ? company!.color! : documentColor({ color: null }, null);
  // White or ink on the button, whichever reads; a light brand color's check is drawn in that ink too.
  const onColor = cardColors(color).text;
  const good = onColor === "#ffffff" ? color : onColor;
  const brand = company
    ? company.logo
      ? `<img src="${escape(company.logo.src)}" width="${company.logo.width}" height="${company.logo.height}" alt="${escape(company.name)}">`
      : `<p class="brand">${escape(company.name)}</p>`
    : "";
  const mark = tone === "good"
    ? `<svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`
    : `<svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true"><path d="M12 7v6M12 16.5v.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>${escape(title)}</title>
<style>
:root{color-scheme:light;--bg:#f6f5f1;--card:#fff;--text:#0f2a35;--muted:#5f6f76;--line:#e3e2dd;--brand:${color};--on-brand:${onColor};--good:${good};--good-bg:color-mix(in srgb,${color} 12%,#fff);--problem:#a3461b;--problem-bg:#f8e7dc}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px 16px;background:var(--bg);color:var(--text);font:16px/1.55 -apple-system,"Segoe UI",Helvetica,Arial,sans-serif}
main{width:100%;max-width:440px;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:28px 24px;text-align:center}
img{max-width:100%;height:auto;margin:0 auto 18px;display:block}
.brand{margin:0 0 18px;font-weight:800;font-size:17px}
.mark{width:52px;height:52px;border-radius:50%;display:grid;place-items:center;margin:0 auto 14px;color:var(--${tone});background:var(--${tone}-bg)}
h1{font-size:21px;line-height:1.3;margin:0 0 8px}
p{margin:0;color:var(--muted)}
.foot{margin-top:20px;font-size:13px}
.foot a{color:inherit}
button{margin-top:22px;font:inherit;font-weight:700;color:var(--on-brand);background:var(--brand);border:0;border-radius:8px;padding:11px 20px;cursor:pointer}
button:focus-visible{outline:2px solid var(--good);outline-offset:3px}
</style></head>
<body><main>
${brand}
<div class="mark">${mark}</div>
<h1>${escape(heading)}</h1>
<p>${escape(text)}</p>
${back ? `<button type="button" id="back" hidden>${escape(back)}</button>
<script>if (history.length > 1) { var b = document.getElementById("back"); b.hidden = false; b.onclick = function () { history.back(); }; }</script>` : ""}
${company?.privacy_url ? `<p class="foot"><a href="${escape(company.privacy_url)}" target="_blank" rel="noopener noreferrer">${PRIVACY_LINK_LABEL}</a></p>` : ""}
</main></body></html>`;
}
