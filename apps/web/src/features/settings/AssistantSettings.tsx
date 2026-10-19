/**
 * Settings → AI assistants, for everyone: the link that connects Claude or ChatGPT to Crewtavo, the
 * assistants you've connected and what each can change, and, for owners and admins, the company's
 * own limits and what assistants did (features/apps/AssistantAccess.tsx).
 */
import { Button } from "@/components/ui/Button";
import { copyText } from "@/lib/clipboard";
import { hasRole, useSession } from "@/lib/session";
import { AssistantAccess, ConnectedAssistants } from "@/features/apps/AssistantAccess";
import { CONNECTOR_STEPS } from "@/features/apps/assistantConnections";

export function AssistantSettings() {
  const session = useSession();
  const mcpUrl = `${window.location.origin}/mcp`;
  return (
    <div className="narrow stack">
      <section className="card card-pad stack-sm" aria-labelledby="assistants-connect">
        <strong id="assistants-connect">Connect Claude or ChatGPT</strong>
        <span className="muted small">
          Ask about your clients and schedule, or have it set up your price list, crews, checklists, booking forms, guides and automations for you. It signs in as you, so it never sees more than you can.
        </span>
        <div className="row wrap" style={{ gap: 8 }}>
          <code className="code-pill grow">{mcpUrl}</code>
          <Button icon="copy" onClick={() => copyText(mcpUrl, "Connector link copied")}>Copy</Button>
        </div>
        <details className="more-options">
          <summary>How to add it</summary>
          <div className="stack-sm">
            <strong className="small">Claude</strong>
            <ol className="app-steps">{CONNECTOR_STEPS.anthropic.map((s) => <li key={s}>{s}</li>)}</ol>
            <strong className="small">ChatGPT</strong>
            <ol className="app-steps">{CONNECTOR_STEPS.chatgpt.map((s) => <li key={s}>{s}</li>)}</ol>
          </div>
        </details>
      </section>
      <ConnectedAssistants card />
      {hasRole(session, "admin") && (
        <section className="card card-pad stack-sm">
          <strong>For everyone at {session.company.name}</strong>
          <AssistantAccess />
        </section>
      )}
    </div>
  );
}
