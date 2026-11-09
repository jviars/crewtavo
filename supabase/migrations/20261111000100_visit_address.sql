-- An address on a calendar entry with no client property: a task or event somewhere (the supply
-- yard, a bid walk-through), typed with suggestions in the visit form and tapped to open in the
-- person's maps app. A visit at a client's property keeps using property_id (properties need a
-- client); this is for the rest. Only the address as typed, not a map point, and nothing about where
-- the crew was (on_my_way_eta_test.sql). A sub can't change it: private.visit_sub_guard lets them
-- change only a visit's status and notes.

alter table public.visits add column address text check (char_length(address) <= 300);
comment on column public.visits.address is 'Where an entry with no client property is, as typed or picked from the suggestions (a client''s address is property_id).';
