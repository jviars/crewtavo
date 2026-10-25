/**
 * Who a visit is for, and how to reach them, on the crew's screens. The team reads the client from
 * the visit's job or request. A sub can't read clients: the server gives them visit_contact(), the
 * client's name always, and their phone and email only when the office turned on "Can contact
 * clients" for that sub. No React here, so it's tested on its own (test/subField.test.ts).
 */

/** visit_contact() for one visit, as GET /api/schedule adds it to a sub's visits. */
export interface VisitContact {
  name: string | null;
  phone: string | null;
  email: string | null;
}

/** The client's name and phone: the team's join first, else what visit_contact() allows. */
export function visitContact(client: { display_name: string; phone?: string | null } | null | undefined, contact: VisitContact | null | undefined): { name: string | null; phone: string | null } {
  if (client) return { name: client.display_name, phone: client.phone?.trim() || null };
  return { name: contact?.name ?? null, phone: contact?.phone?.trim() || null };
}

/** Call and Text, only with a phone to use. */
export function contactLinks(contact: { phone: string | null }): Array<{ label: "Call" | "Text"; href: string }> {
  if (!contact.phone) return [];
  return [
    { label: "Call", href: `tel:${contact.phone}` },
    { label: "Text", href: `sms:${contact.phone}` },
  ];
}
