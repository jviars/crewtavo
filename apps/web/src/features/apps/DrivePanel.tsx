/**
 * Crewtavo - Drive on its Apps page, once it's installed: who has it, the Trash, whether importing
 * from Google Drive is set up on this Crewtavo (and how to set it up when it isn't), how much of the
 * company's storage is used (Settings → Storage has the limit), and where files are stored (Settings
 * → Hosting, on Railway).
 */
import { Link } from "react-router-dom";
import { Icon } from "@/components/ui/Icon";
import { companyLine, fullness, managesStorage, personalLine, shareOf, STORAGE_SETTINGS, useStorageOverview } from "@/features/settings/storage";
import { useSession } from "@/lib/session";

const GOOGLE_IMPORT_DOCS = "https://crewtavo.com/docs/connections/drive/#import-from-google-drive";

export function DrivePanel() {
  const session = useSession();
  const google = Boolean(session.config.googlePicker);
  // Settings → Hosting is there for the owner and admins of a Crewtavo of its own on Railway.
  const hosting = session.config.singleCompany && session.config.platform === "railway";
  const storage = useStorageOverview();
  const managesLimit = managesStorage(session);
  return (
    <section id="app-setup" className="card card-pad stack-sm" aria-labelledby="drive-setup" style={{ gap: 12 }}>
      <h2 id="drive-setup" className="section-title" style={{ fontSize: 17 }}>Drive is on</h2>
      <span className="muted">
        Owners, admins, office staff and estimators have <strong>Drive</strong> in the menu, with your company folders and every file on your clients' properties,
        requests, quotes and jobs. Files deleted in Crewtavo, from plans to visit photos and receipts, stay in the <strong>Trash</strong> for 30 days.
      </span>
      <div className={google ? "callout callout-good" : "callout"}>
        <Icon name={google ? "check" : "cloud"} size={18} />
        <div className="grow">
          {google ? "Importing from Google Drive is ready" : "Importing from Google Drive isn't set up yet"}
          <span style={{ display: "block", fontWeight: 400 }}>
            {google ? (
              "In Drive, Import from Google Drive lets each person pick files from their own Google Drive. Crewtavo copies them in and keeps nothing of their Google account."
            ) : (
              <>
                Whoever runs this Crewtavo adds a Google sign-in and a browser key to it, once.{" "}
                <a href={GOOGLE_IMPORT_DOCS} target="_blank" rel="noreferrer">How to set it up <Icon name="external" size={12} /></a>
              </>
            )}
          </span>
        </div>
      </div>
      {storage.data && <StorageUsed o={storage.data} />}
      <div className="row wrap" style={{ gap: 8 }}>
        <Link className="btn" to="/drive"><Icon name="folder" size={16} />Open Drive</Link>
        <Link className="btn" to="/drive/trash"><Icon name="trash" size={16} />Trash</Link>
        {managesLimit && <Link className="btn" to={STORAGE_SETTINGS}><Icon name="gauge" size={16} />Storage limit</Link>}
        {hosting && <Link className="btn" to="/settings?tab=hosting"><Icon name="hardDrive" size={16} />Where files are stored</Link>}
      </div>
    </section>
  );
}

/** How much of the company's storage is used, against its limit, and the person's own when they have one. */
function StorageUsed({ o }: { o: NonNullable<ReturnType<typeof useStorageOverview>["data"]> }) {
  const share = shareOf(o.used_bytes, o.limit_bytes);
  const level = fullness(share);
  const mine = personalLine(o.me);
  return (
    <div className="stack-sm" style={{ gap: 4 }}>
      <div className="row-between small" style={{ gap: 12 }}>
        <strong>Storage</strong>
        <span className="muted" style={{ textAlign: "right" }}>{level === "full" ? `Full: ${companyLine(o)}` : companyLine(o)}</span>
      </div>
      {share !== null && (
        <div className="progress" role="img" aria-label={`${Math.floor(share * 100)}% of the storage limit used`}>
          <span style={{ width: `${Math.min(100, share * 100)}%`, background: level === "ok" ? undefined : level === "warning" ? "var(--warning)" : "var(--danger)" }} />
        </div>
      )}
      {mine && <span className="muted small">{mine}.</span>}
    </div>
  );
}
