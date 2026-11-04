-- A client asking again replaces their waiting request in its own row (routes/public.ts), rather than
-- deleting it first, so a failed save never loses the one already waiting. The office is told about
-- the new ask as it was about the first: the same event and notification as a new request.
create trigger requested_again after update of kind, starts_at, ends_at, scheduled_on, message, reason on public.visit_change_requests
  for each row when (old.status = 'pending' and new.status = 'pending') execute function private.visit_change_requested();
