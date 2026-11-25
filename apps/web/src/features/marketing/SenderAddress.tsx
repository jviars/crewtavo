/**
 * Marketing emails have to show the sender's postal address (the FTC's CAN-SPAM guide), so the
 * server sends none until the company's is complete: campaigns and their tests, the automated
 * marketing campaigns, review asks and referral asks by email. This says so where those are
 * written and switched on, with where to add it, instead of leaving it to the refusal.
 */
import { businessCountry } from "@crewtavo/core/countries";
import { hasPostalAddress } from "@crewtavo/core/postcards";
import { Link } from "react-router-dom";
import { Icon } from "@/components/ui/Icon";
import { hasRole, useSession } from "@/lib/session";

/** Whether the company's address (Settings → Company) is all there: a street or box, city, state and ZIP, as addresses are written in its country. */
export function useSenderAddress(): boolean {
  const { company } = useSession();
  return hasPostalAddress(company.address, businessCountry(company));
}

/** `what`: what isn't happening for want of it, as the rest of the sentence ("this can't be sent"). */
export function SenderAddressNote({ what }: { what: string }) {
  const session = useSession();
  if (hasPostalAddress(session.company.address, businessCountry(session.company))) return null;
  return (
    <div className="callout callout-warning">
      <Icon name="alert" size={16} />
      <div className="grow">
        Marketing emails have to show your company's postal address, and it isn't filled in yet, so {what}.
        {hasRole(session, "admin")
          ? <> <Link to="/settings?tab=company" className="strong">Add it in Settings → Company</Link> (a PO box is fine).</>
          : " An owner or admin can add it in Settings → Company (a PO box is fine)."}
      </div>
    </div>
  );
}
