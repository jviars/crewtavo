/** One-click unsubscribe from marketing email (/u/:token). Transactional email keeps working. */
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { useParams } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { FormError } from "@/components/ui/Field";
import { PrivacyFooter } from "@/components/ui/PrivacyLink";
import { linkToken } from "@/lib/linkToken";
import { publicFetch } from "@/lib/publicApi";
import { Broken, ClientBody, ClientHeader, ClientPage, ClientSkeleton, Done, kit as k } from "./ClientKit";

export function UnsubscribePage() {
  const { token: raw = "" } = useParams();
  const token = linkToken(raw);
  const isTest = token === "test";
  const status = useQuery({
    queryKey: ["unsubscribe", token],
    enabled: !isTest,
    retry: false,
    queryFn: () => publicFetch<{ company: string; unsubscribed: boolean; privacy_url?: string | null; logo?: string | null; color?: string | null }>(`/public/unsubscribe/${token}`),
  });
  const change = useMutation({
    mutationFn: (resubscribe: boolean) => publicFetch<{ unsubscribed: boolean }>(`/public/unsubscribe/${token}`, { resubscribe }),
    onSuccess: () => status.refetch(),
  });
  // Unsubscribing is one click: do it as soon as the page opens.
  useEffect(() => {
    if (status.data && !status.data.unsubscribed && !change.isPending && !change.isSuccess) change.mutate(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status.data]);
  useEffect(() => {
    document.title = "Email preferences";
  }, []);

  return (
    <ClientPage color={status.data?.color}>
      {status.data && <ClientHeader name={status.data.company} logo={status.data.logo} sub="Email preferences" />}
      <ClientBody width="narrow">
        {isTest ? (
          // Nothing happened: a quiet mark, not a check, and no business above it.
          <Done icon="info" tone="quiet" className={k.alone} title="This is a test email">
            <p className={k.doneText}>In a real campaign, this link unsubscribes the client from marketing email.</p>
          </Done>
        ) : status.isPending ? (
          <ClientSkeleton lines={1} />
        ) : status.error ? (
          <Broken title="This link isn't working">{(status.error as Error).message}</Broken>
        ) : status.data?.unsubscribed ? (
          <Done title="You're unsubscribed">
            <p className={k.doneText}>You won't get marketing emails or review requests from {status.data.company} anymore. You'll still get your quotes, invoices and visit reminders.</p>
            <Button className={k.soft} loading={change.isPending} onClick={() => change.mutate(true)}>Subscribe again</Button>
            <FormError error={change.error} />
          </Done>
        ) : (
          <Done icon="mail" tone="brand" title="You're subscribed">
            <p className={k.doneText}>You'll get occasional email from {status.data?.company}.</p>
            <Button className={k.soft} loading={change.isPending} onClick={() => change.mutate(false)}>Unsubscribe</Button>
            <FormError error={change.error} />
          </Done>
        )}
        <div className={k.foot}><PrivacyFooter url={status.data?.privacy_url} /></div>
      </ClientBody>
    </ClientPage>
  );
}
