/** Settings → Your data: everything the business keeps here as one .zip, to keep or to take to another app (exportData.ts). Owners only. */
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { downloadBlob } from "@/lib/csv";
import { useSession } from "@/lib/session";
import { exportEverything } from "./exportData";

export function DataSettings() {
  const session = useSession();
  const [step, setStep] = useState<string | null>(null);
  const download = useMutation({
    meta: { success: "Your data is downloaded" },
    mutationFn: async () => {
      const { name, blob } = await exportEverything(session, setStep);
      downloadBlob(name, blob);
    },
    onSettled: () => setStep(null),
  });

  return (
    <div className="stack">
      <div className="card card-pad stack-sm" style={{ gap: 12 }}>
        <div className="stack-sm" style={{ gap: 2 }}>
          <strong>Download all your data</strong>
          <span className="muted small">
            Everything {session.company.name} keeps in Crewtavo, as one .zip file. Keep it as a copy, or take it to another app. It opens on any computer, with nothing to install.
          </span>
        </div>
        <ul className="app-steps">
          <li><strong>Spreadsheets</strong> of clients, properties, requests, quotes, jobs, visits, invoices, payments, expenses, the price list, the team, timesheets and equipment, for Excel, Google Sheets or another app&apos;s import.</li>
          <li><strong>Files ready for Jobber</strong>: clients, quotes, jobs and invoices laid out the way Jobber&apos;s imports read them, with the steps to bring them in.</li>
        </ul>
        <span className="muted small">Photos, signed documents and messages aren&apos;t in it yet. It includes pay rates and subcontractors&apos; details, so keep it somewhere safe.</span>
        <div>
          <Button variant="primary" icon="download" loading={download.isPending} onClick={() => download.mutate()}>
            {download.isPending ? step ?? "Getting ready…" : "Download all your data"}
          </Button>
        </div>
      </div>
      <div className="card card-pad stack-sm" style={{ gap: 12 }}>
        <strong>Moving to Jobber</strong>
        <ol className="app-steps">
          <li>Download your data and unzip it.</li>
          <li>Open the jobber folder and read its READ ME.</li>
          <li>In Jobber, as an admin, import the files in their numbered order: clients, then quotes, jobs and invoices.</li>
        </ol>
        <span className="muted small">
          Jobber&apos;s imports don&apos;t take payments, a job&apos;s line items, or lost quotes. The READ ME says what comes in differently, and the spreadsheets keep all of it.
        </span>
      </div>
    </div>
  );
}
