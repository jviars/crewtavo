/**
 * No marketing email without the sender's postal address. The FTC's CAN-SPAM guide: "Your message
 * must include your valid physical postal address." The footer of every marketing email is the
 * company's name and its address (lib/email.ts companyFooter), but a company that never filled its
 * address in sent "Acme Lawn · Unsubscribe". So campaigns, their test sends, the automated marketing
 * campaigns (Re-engage past clients, Win back lost quotes), review asks and referral asks by email
 * are refused until the address is complete (core hasPostalAddress, as a postcard's return address
 * is read), saying where to add it.
 *
 * The ones that send by themselves don't stop silently at a company that had them on already: its
 * owners and admins are told once, on the bell, what to do (tellAddressNeeded).
 */
import { hasPostalAddress, SENDER_ADDRESS_NEEDED } from "@crewtavo/core/postcards";
import type { Db } from "../lib/supabase";

/** Why the company can't send marketing email yet, or null when its address is all there, as addresses are written in its country. */
export const senderAddressProblem = (company: { address?: unknown; country?: string | null } | null | undefined): string | null =>
  hasPostalAddress(company?.address as Record<string, unknown> | null | undefined, company?.country) ? null : SENDER_ADDRESS_NEEDED;

export const ADDRESS_NOTICE_TITLE = "Marketing emails are waiting for your company's address";
const ADDRESS_NOTICE_BODY =
  "Campaigns, review asks and referral asks by email have to show your postal address, and yours isn't filled in, so they aren't going out. Add it in Settings → Company (a PO box is fine) and they'll go again by themselves.";
const ADDRESS_NOTICE_LINK = "/settings?tab=company";

/**
 * Tells the company's owners and admins, once, that its marketing emails are held for want of an
 * address. Once is for good: the notice stays on their bell, and a second isn't added while any is
 * kept. Never stops the send it came from being refused.
 */
export async function tellAddressNeeded(admin: Db, companyId: string): Promise<void> {
  try {
    const { data: told, error } = await admin.from("notifications").select("id").eq("company_id", companyId).eq("title", ADDRESS_NOTICE_TITLE).limit(1);
    if (error) throw new Error(error.message);
    if (told?.length) return;
    const { data: people, error: peopleError } = await admin.from("memberships").select("user_id").eq("company_id", companyId).eq("active", true).in("role", ["owner", "admin"]);
    if (peopleError) throw new Error(peopleError.message);
    if (!people?.length) return;
    const { error: insertError } = await admin
      .from("notifications")
      .insert(people.map((p) => ({ company_id: companyId, user_id: p.user_id, kind: "info", title: ADDRESS_NOTICE_TITLE, body: ADDRESS_NOTICE_BODY, link: ADDRESS_NOTICE_LINK })));
    if (insertError) throw new Error(insertError.message);
  } catch (error) {
    console.error(`Couldn't tell a company its marketing emails need an address: ${error instanceof Error ? error.message : error}`);
  }
}
