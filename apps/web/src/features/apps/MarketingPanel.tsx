/**
 * Crewtavo - Marketing on its Apps page, once it's installed: who has it, and its four tabs as rows,
 * each saying what's set up there. Installing and uninstalling it is
 * features/marketing/useMarketingSwitch.ts. An admin who connects apps without the marketing area
 * manages it here but can't open Marketing, so the tabs aren't links for them: the page says who has
 * it instead.
 */
import { Link } from "react-router-dom";
import { Icon, type IconName } from "@/components/ui/Icon";
import { RelatedList, RelatedRow, Section } from "@/components/ui/Section";
import { useSession } from "@/lib/session";
import { usesMarketing } from "./catalog";
import { kit } from "./PanelKit";

const TABS: Array<{ tab: string; icon: IconName; title: string; text: string }> = [
  { tab: "reviews", icon: "star", title: "Reviews", text: "Choose when clients are asked for a review, and how many reminders follow." },
  { tab: "referrals", icon: "gift", title: "Referrals", text: "Set the credit for each friend who becomes a client, and when clients are asked for referrals." },
  {
    tab: "campaigns",
    icon: "mail",
    title: "Campaigns",
    text: "Turn on the automated campaigns (re-engage past clients, win back lost quotes, close pending quotes), write one-off emails, and see the opens, clicks and work each brings in.",
  },
  {
    tab: "social",
    icon: "share",
    title: "Social",
    text: "Post job photos marked OK to share and 4 and 5-star Google reviews to your Facebook Page, Instagram and Google Business Profile, now or later, or have new 5-star reviews post by themselves.",
  },
];

export function MarketingPanel() {
  const session = useSession();
  const opens = usesMarketing(session);
  return (
    <Section className={kit.panel} id="app-setup" title="Marketing is on">
      <p className={kit.text}>Owners, admins and office staff with the marketing area have <strong>Marketing</strong> in the menu.</p>
      <RelatedList label="Marketing">
        {TABS.map((t) => (
          <RelatedRow
            key={t.tab}
            to={opens ? `/marketing?tab=${t.tab}` : undefined}
            lead={<span className="rel-icon"><Icon name={t.icon} size={15} /></span>}
            title={t.title}
            sub={t.text}
          />
        ))}
      </RelatedList>
      {!opens && <p className={kit.note}>Your role doesn't have the marketing area, so Marketing isn't in your menu. An owner can add it to your role in Settings → Roles.</p>}
      <p className={kit.note}>
        Connect <Link to="/apps/google_business">Google Business Profile</Link> to bring your Google reviews into Reviews, reply to them, and stop asking clients who already left one.
        Connect <Link to="/apps/meta">Facebook & Instagram</Link> to post to your Page and Instagram account.
      </p>
    </Section>
  );
}
