-- A client's approval in the Client Hub (POST /hub/:token/approve) set the optional lines to the
-- client's choices first and only then marked the quote approved if it was still waiting. So an
-- approval that lost to another one at the same time, or to a change by the office, still rewrote
-- the options of a quote that was approved with others. It can't simply mark the quote approved
-- first either: approving runs the change order trigger (the chosen lines join the job right then)
-- and the activity feed (with the total), and both need the options already picked.
--
-- Now it's one step here. The quote is claimed first (locked, and still waiting for an answer, or
-- nothing changes); then the options follow the client's choices, and the quote is marked approved
-- with the amounts they came to. The server calls it as the service role.
create function public.approve_hub_quote(p_company uuid, p_quote uuid, p_selected uuid[], p_approval jsonb)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_selected uuid[] := coalesce(p_selected, '{}');
begin
  -- A second approval waits here for the first, then finds the quote approved and leaves it alone.
  perform 1 from public.quotes
   where company_id = p_company and id = p_quote and status in ('sent', 'changes_requested')
   for update;
  if not found then
    return false;
  end if;

  -- Optional lines follow the client's choices; required lines stay selected.
  update public.quote_line_items set selected = (id = any(v_selected))
   where quote_id = p_quote and optional and selected is distinct from (id = any(v_selected));

  -- The lines re-ran the quote's totals, so these are the amounts with those choices: the approval
  -- shows the price that was agreed to.
  update public.quotes q
     set status = 'approved', approved_at = now(),
         approval = coalesce(p_approval, '{}') || jsonb_build_object(
           'subtotal', q.subtotal, 'discount_amount', q.discount_amount, 'tax_amount', q.tax_amount, 'total', q.total)
   where q.id = p_quote;
  return true;
end $$;
revoke execute on function public.approve_hub_quote(uuid, uuid, uuid[], jsonb) from public, anon, authenticated;
grant execute on function public.approve_hub_quote(uuid, uuid, uuid[], jsonb) to service_role;

notify pgrst, 'reload schema';
