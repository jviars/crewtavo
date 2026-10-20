-- Settings → Hosting (apps/api/src/services/hosting.ts): warnings before Railway stops Crewtavo
-- (the trial, credit or card running out, a usage limit, a full volume) or bills more than the
-- plan includes. Only owners and admins get them. They're a notification topic of their own,
-- "hosting", by email and push unless someone turns it off: a Crewtavo that stops can't tell anyone.
do $$
declare c text;
begin
  for c in select conname from pg_constraint where conrelid = 'public.notification_prefs'::regclass and contype = 'c' loop
    execute format('alter table public.notification_prefs drop constraint %I', c);
  end loop;
end $$;
alter table public.notification_prefs add constraint notification_prefs_topics_check check (
  email <@ array['schedule','client','equipment','time','alerts','chat','hosting']
  and sms <@ array['schedule','client','equipment','time','alerts','chat','hosting']
  and push <@ array['schedule','client','equipment','time','alerts','chat','hosting']
);
alter table public.notification_prefs alter column email set default '{schedule,hosting}';
alter table public.notification_prefs alter column push set default '{schedule,client,equipment,time,alerts,chat,hosting}';
update public.notification_prefs set email = array_append(email, 'hosting') where not ('hosting' = any (email));
update public.notification_prefs set push = array_append(push, 'hosting') where not ('hosting' = any (push));
