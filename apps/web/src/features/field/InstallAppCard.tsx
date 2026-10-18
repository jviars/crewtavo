/**
 * Crewtavo as an app on the crew's phones (lib/install.ts): on their Home and My day, an install
 * button where the browser offers one (Android), or how to add it in Safari on an iPhone. The × puts
 * it away for good on this phone. The office gets the button in Settings only.
 */
import { Button, type ButtonProps } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { dismissInstallTip, installApp, useInstallHint, useInstallTipDismissed } from "@/lib/install";

export function InstallAppCard() {
  const hint = useInstallHint();
  const dismissed = useInstallTipDismissed();
  if (!hint || dismissed) return null;
  return (
    <div className="callout callout-info">
      <Icon name={hint === "ios" ? "share" : "apps"} size={18} />
      {hint === "ios" ? (
        <div className="grow small" style={{ fontWeight: 400 }}>
          <div style={{ fontWeight: 700 }}>Add Crewtavo to your Home Screen</div>
          Tap Share <span style={{ verticalAlign: "-2px" }}><Icon name="share" size={14} /></span>, then <strong>Add to Home Screen</strong>. It opens like any other app.
        </div>
      ) : (
        <div className="grow small" style={{ fontWeight: 400 }}>
          <div style={{ fontWeight: 700 }}>Get the Crewtavo app</div>
          It opens from your home screen like any other app.
          <div style={{ marginTop: 8 }}><InstallAppButton size="sm" /></div>
        </div>
      )}
      <button type="button" className="icon-btn" aria-label="Don't show this again" title="Don't show this again" onClick={dismissInstallTip}><Icon name="x" size={16} /></button>
    </div>
  );
}

/** Opens the browser's install prompt. Only shown while the browser offers one (useInstallHint() === "prompt"). */
export function InstallAppButton(props: Omit<ButtonProps, "onClick" | "children">) {
  return (
    <Button variant="primary" icon="download" {...props} onClick={() => void installApp().catch(() => undefined)}>
      Install the app
    </Button>
  );
}
