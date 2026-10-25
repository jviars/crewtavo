/**
 * Offering a sub the job from its pay (docs/subcontractors-plan.md, phase D): sending a draft as an
 * offer, and sending a new price for agreed pay, each with a time to answer by. What's wrong with the
 * sub's insurance shows before it goes, plainly, and never stops it (the owner's decision): the offer
 * records it. The sub takes it or turns it down in the field app's My jobs.
 */
import { insuranceWarningText, moneyShort, offerText, type InsuranceWarningItem } from "@crewtavo/core/subOffers";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Field, FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { formatMoneyCents, todayIn } from "@/lib/format";
import { useSession } from "@/lib/session";
import { otherWork, priceDrafts, priceLines, priceTotal, reachWords, REPLY_BY_CHOICES, replyByAt, replyByProblem, replyByWords, samePrice, type PickedTime, type PriceDraft, type ReplyBy } from "../subs/offers";
import { draftAmount, quantityWords } from "../subs/pay";
import { changeOffer, refreshPay, sendOffer, type JobPay } from "../subs/payData";

/** The time to answer by: none, in 2 hours, end of today, tomorrow at noon, or a day and time picked (the company's clock). */
function useReplyBy() {
  const { company } = useSession();
  const [choice, setChoice] = useState<ReplyBy>("none");
  const [picked, setPicked] = useState<PickedTime>({ date: todayIn(company.timezone), time: "17:00" });
  const at = replyByAt(choice, company.timezone, new Date(), picked);
  return {
    choice,
    picked,
    at,
    problem: replyByProblem(choice, at),
    setChoice,
    setPicked,
    // Worked out again as it goes, so "in 2 hours" is from the moment it's sent.
    now: () => replyByAt(choice, company.timezone, new Date(), picked),
  };
}
type ReplyByState = ReturnType<typeof useReplyBy>;

function ReplyByPicker({ state, disabled }: { state: ReplyByState; disabled?: boolean }) {
  const { company } = useSession();
  return (
    <Field label="They answer by">
      <div className="stack-sm">
        {REPLY_BY_CHOICES.map((c) => (
          <label key={c.key} className="checkbox">
            <input type="radio" name="reply-by" checked={state.choice === c.key} disabled={disabled} onChange={() => state.setChoice(c.key)} />
            <span>{c.label}</span>
          </label>
        ))}
        {state.choice === "pick" && (
          <div className="row wrap" style={{ gap: 8 }}>
            <input className="input" type="date" aria-label="Day" value={state.picked.date} min={todayIn(company.timezone)} disabled={disabled} onChange={(e) => state.setPicked({ ...state.picked, date: e.target.value })} style={{ width: "auto" }} />
            <input className="input" type="time" aria-label="Time" value={state.picked.time} disabled={disabled} onChange={(e) => state.setPicked({ ...state.picked, time: e.target.value })} style={{ width: "auto" }} />
          </div>
        )}
        {state.problem ? <span className="field-error" role="alert">{state.problem}</span> : <span className="muted small">{replyByWords(state.at, company.timezone)}</span>}
      </div>
    </Field>
  );
}

/** What's wrong with their insurance, as the office reads it. It never stops the offer. */
function InsuranceCallout({ items, subId }: { items: readonly InsuranceWarningItem[]; subId: string }) {
  if (!items.length) return null;
  return (
    <div className="callout callout-warning">
      <Icon name="alert" size={18} />
      <div className="grow small" style={{ fontWeight: 400 }}>
        <div style={{ fontWeight: 700 }}>Check their insurance</div>
        {items.map((i) => <div key={`${i.requirement}-${i.problem}`}>{insuranceWarningText(i, "office")}</div>)}
        <div>You can still send it. The offer notes this, and work given without current certificates may cost you at your workers' comp audit. <Link to={`/subs/${subId}`}>Their paperwork</Link></div>
      </div>
    </div>
  );
}

/** A draft to the sub as an offer. `warning` is what's wrong with their insurance for the work it covers. */
export function SendOfferDialog({ pay, name, jobTitle, dates, warning, onClose }: {
  pay: JobPay;
  name: string;
  jobTitle: string;
  /** The days of the visits it covers. */
  dates: readonly (string | null)[];
  warning: readonly InsuranceWarningItem[];
  onClose: () => void;
}) {
  const session = useSession();
  const queryClient = useQueryClient();
  const replyBy = useReplyBy();
  const send = useMutation({
    meta: { inline: true, success: `Offer sent to ${name}` },
    mutationFn: () => sendOffer(pay.id, replyBy.now()),
    onSuccess: () => {
      refreshPay(queryClient, pay.job_id);
      onClose();
    },
  });
  const nothing = Number(pay.total) <= 0;
  const preview = offerText({ title: jobTitle, dates, lines: pay.lines, total: pay.total }, { respondBy: replyBy.at, timeZone: session.company.timezone });
  const noVisits = dates.length === 0;

  return (
    <Dialog open onClose={onClose} title={`Send the offer to ${name}`} size="md" description={reachWords(session.config.features.sms)}>
      <form
        className="dialog-body"
        onSubmit={(e) => {
          e.preventDefault();
          if (!replyBy.problem && !nothing) send.mutate();
        }}
      >
        <div className="card card-pad stack-sm">
          <span className="muted small">What they'll see</span>
          <strong>{preview}</strong>
          <span className="muted small">Before they take it they see the town, the days, the work and their price, not the address or the client.</span>
        </div>
        {noVisits && (
          <div className="callout callout-warning">
            <Icon name="alert" size={18} />
            <div className="grow small" style={{ fontWeight: 400 }}>
              This offer doesn't cover any visits, so they won't be put on the job when they accept it. To fix that, close this and tick the visits it covers.
            </div>
          </div>
        )}
        {pay.subcontractor_id && <InsuranceCallout items={warning} subId={pay.subcontractor_id} />}
        <ReplyByPicker state={replyBy} disabled={send.isPending} />
        {nothing && <div className="form-error" role="alert">Add what you'll pay them first.</div>}
        <FormError error={send.error} />
        <div className="form-actions">
          <Button onClick={onClose} disabled={send.isPending}>Cancel</Button>
          <Button type="submit" variant="primary" icon="send" disabled={nothing || Boolean(replyBy.problem)} loading={send.isPending}>{warning.length || noVisits ? "Send anyway" : "Send offer"}</Button>
        </div>
      </form>
    </Dialog>
  );
}

/**
 * A new price for agreed pay, sent to the sub to accept. The price they agreed stays if they say no,
 * don't answer in time, or the office takes it back; they stay on the job meanwhile.
 */
export function ChangePriceDialog({ pay, name, warning, onClose }: { pay: JobPay; name: string; warning: readonly InsuranceWarningItem[]; onClose: () => void }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const replyBy = useReplyBy();
  const [drafts, setDrafts] = useState<PriceDraft[]>(() => priceDrafts(pay.lines));
  const [next, setNext] = useState(1);
  const [touched, setTouched] = useState(false);
  const checked = priceLines(drafts);
  const same = samePrice(drafts, pay.lines);
  const problem = checked.problem ?? (same ? "That's the price they agreed. Change something first." : null);
  const send = useMutation({
    meta: { inline: true, success: `New price sent to ${name}` },
    mutationFn: () => changeOffer(pay.id, { lines: checked.lines!, respond_by: replyBy.now() }),
    onSuccess: () => {
      refreshPay(queryClient, pay.job_id);
      onClose();
    },
  });
  const update = (key: string, patch: Partial<PriceDraft>) => setDrafts((all) => all.map((d) => (d.key === key ? { ...d, ...patch } : d)));

  return (
    <Dialog
      open
      onClose={onClose}
      title="Change the price"
      size="lg"
      description={`${name} will be asked to accept the new price. If they say no or don't answer in time, the price they agreed (${moneyShort(pay.total)}) stays, and they stay on the job.`}
    >
      <form
        className="dialog-body"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          setTouched(true);
          if (!problem && !replyBy.problem) send.mutate();
        }}
      >
        <div className="card">
          {drafts.map((d) => {
            const unit = d.basis === "per_unit" ? d.unit : d.basis === "per_day" ? "day" : "job";
            const amount = draftAmount(d);
            return (
              <div key={d.key} className="card-row" style={{ flexWrap: "wrap", alignItems: "flex-start" }}>
                <input className="input input-sm grow" style={{ minWidth: 200 }} value={d.description} maxLength={200} aria-label="Description" disabled={send.isPending} onChange={(e) => update(d.key, { description: e.target.value })} />
                <span className="row" style={{ gap: 6, flexWrap: "wrap", flex: "1 1 260px", justifyContent: "flex-end", minWidth: 0 }}>
                  <input className="input input-sm tabular" style={{ flex: "1 1 64px", maxWidth: 96, minWidth: 0, textAlign: "right" }} inputMode="decimal" value={d.quantity} aria-label={`Quantity for ${d.description}`} disabled={send.isPending} onChange={(e) => update(d.key, { quantity: e.target.value.replace(/[^0-9.]/g, "") })} />
                  <span className="muted small">{quantityWords(Number(d.quantity) || 0, unit).replace(/^[\d.,]+ /, "")} ×</span>
                  <span className="input-group" style={{ flex: "1 1 88px", maxWidth: 120, minWidth: 0 }}>
                    <span className="addon">$</span>
                    <input className="input input-sm tabular" style={{ textAlign: "right", paddingLeft: 22 }} inputMode="decimal" value={d.rate} aria-label={`Rate for ${d.description}`} disabled={send.isPending} onChange={(e) => update(d.key, { rate: e.target.value.replace(/[^0-9.]/g, "") })} />
                  </span>
                  <span className="row" style={{ gap: 6, marginLeft: "auto" }}>
                    <span className="tabular strong" style={{ minWidth: 80, textAlign: "right" }}>{amount === null ? "—" : formatMoneyCents(amount)}</span>
                    <Button size="sm" variant="ghost" icon="trash" aria-label={`Remove ${d.description}`} disabled={drafts.length === 1 || send.isPending} onClick={() => setDrafts((all) => all.filter((x) => x.key !== d.key))} />
                  </span>
                </span>
              </div>
            );
          })}
          <div className="card-row">
            <Button size="sm" variant="ghost" icon="plus" disabled={drafts.length >= 50 || send.isPending} onClick={() => { setDrafts((all) => [...all, otherWork(`new-${next}`)]); setNext(next + 1); }}>Add a line</Button>
            <span className="grow" style={{ textAlign: "right" }}>
              <strong>New price</strong>
              <span className="muted small" style={{ display: "block" }}>Agreed: {formatMoneyCents(Number(pay.total))}</span>
            </span>
            <strong className="tabular" style={{ minWidth: 90, textAlign: "right" }}>{formatMoneyCents(priceTotal(drafts))}</strong>
          </div>
        </div>
        {touched && problem ? <div className="form-error" role="alert">{problem}</div> : same && <span className="muted small">Change a quantity, a rate or a line, and send them the new price.</span>}
        {pay.subcontractor_id && <InsuranceCallout items={warning} subId={pay.subcontractor_id} />}
        <ReplyByPicker state={replyBy} disabled={send.isPending} />
        <span className="muted small">{reachWords(session.config.features.sms)}</span>
        <FormError error={send.error} />
        <div className="form-actions">
          <Button onClick={onClose} disabled={send.isPending}>Cancel</Button>
          <Button type="submit" variant="primary" icon="send" disabled={Boolean(replyBy.problem) || same} loading={send.isPending}>{warning.length ? "Send anyway" : "Send the new price"}</Button>
        </div>
      </form>
    </Dialog>
  );
}
