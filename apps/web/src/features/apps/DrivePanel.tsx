/**
 * Crewtavo - Drive on its Apps page, once it's installed: who has it, the Trash, whether importing
 * from Google Drive is set up on this Crewtavo (and how to set it up when it isn't), how much of the
 * company's storage is used (Settings → Storage has the limit), and where files are stored (Settings
 * → Hosting, on Railway).
 */
import { Icon } from "@/components/ui/Icon";
import { Fact, Facts, RelatedList, RelatedRow, Section } from "@/components/ui/Section";
import { companyLine, fullness, managesStorage, personalLine, shareOf, STORAGE_SETTINGS, useStorageOverview } from "@/features/settings/storage";
import { useSession } from "@/lib/session";
import { kit } from "./PanelKit";

const GOOGLE_IMPORT_DOCS = "https://crewtavo.com/docs/connections/drive/#import-from-google-drive";

export function DrivePanel() {
  const session = useSession();
  const google = Boolean(session.config.googlePicker);
  // Settings → Hosting is there for the owner and admins of a Crewtavo of its own on Railway.
  const hosting = session.config.singleCompany && session.config.platform === "railway";
  const storage = useStorageOverview();
  const managesLimit = managesStorage(session);
  return (
    <Section className={kit.panel} id="app-setup" title="Drive is on">
      <p className={kit.text}>
        Owners, admins, office staff and estimators have <strong>Drive</strong> in the menu, with your company folders and every file on your clients' properties,
        requests, quotes and jobs. Files deleted in Crewtavo, from plans to visit photos and receipts, stay in the <strong>Trash</strong> for 30 days.
      </p>
      {storage.data && (
        <Facts>
          <Fact label="Storage"><StorageUsed o={storage.data} /></Fact>
        </Facts>
      )}
      <RelatedList label="Drive">
        <RelatedRow to="/drive/trash" lead={<span className="rel-icon"><Icon name="trash" size={15} /></span>} title="Trash" />
        {managesLimit && <RelatedRow to={STORAGE_SETTINGS} lead={<span className="rel-icon"><Icon name="gauge" size={15} /></span>} title="Storage limit" />}
        {hosting && <RelatedRow to="/settings?tab=hosting" lead={<span className="rel-icon"><Icon name="hardDrive" size={15} /></span>} title="Where files are stored" />}
      </RelatedList>
      <div className={google ? "callout callout-good" : "callout callout-info"}>
        <Icon name={google ? "check" : "cloud"} size={16} />
        <div className="grow">
          <div>{google ? "Importing from Google Drive is ready" : "Importing from Google Drive isn't set up yet"}</div>
          {google ? (
            "In Drive, Import from Google Drive lets each person pick files from their own Google Drive. Crewtavo copies them in and keeps nothing of their Google account."
          ) : (
            <>
              Whoever runs this Crewtavo adds a Google sign-in and a browser key to it, once.{" "}
              <a href={GOOGLE_IMPORT_DOCS} target="_blank" rel="noreferrer">How to set it up <Icon name="external" size={12} /></a>
            </>
          )}
        </div>
      </div>
    </Section>
  );
}

/** How much of the company's storage is used, against its limit (a bar), and the person's own when they have one: a fact's value. */
function StorageUsed({ o }: { o: NonNullable<ReturnType<typeof useStorageOverview>["data"]> }) {
  const share = shareOf(o.used_bytes, o.limit_bytes);
  const level = fullness(share);
  const mine = personalLine(o.me);
  return (
    <div className="app-meter">
      <span>{level === "full" ? `Full: ${companyLine(o)}` : companyLine(o)}</span>
      {share !== null && (
        <div className="progress" role="img" aria-label={`${Math.floor(share * 100)}% of the storage limit used`}>
          <span style={{ width: `${Math.min(100, share * 100)}%`, background: level === "ok" ? undefined : level === "warning" ? "var(--warning)" : "var(--danger)" }} />
        </div>
      )}
      {mine && <span className={kit.note}>{mine}.</span>}
    </div>
  );
}
