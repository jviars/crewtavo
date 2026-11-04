-- Custom fields, the way Jobber has them: a business adds its own fields to clients, properties,
-- jobs, quotes and invoices (a gate code, a permit number, an HVAC unit's model, "pets on site").
-- custom_field_definitions says which fields there are; each record keeps its values in its own
-- custom_fields, keyed by the field's key (packages/core/src/customFields.ts checks and shows them).
-- The client import keeps the old system's ID in clients.custom_fields.source_id, so no field can
-- take that key.
--
-- Read by the team (crews see a visit's job and property fields), changed by the office with the
-- Settings area, like checklists. Settings archives a field rather than deleting it: its values
-- stay on their records, out of sight, until it's restored. Who may change a record's values is
-- that record's own rules, since they're one of its columns.

create table public.custom_field_definitions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  record_type text not null check (record_type in ('client', 'property', 'job', 'quote', 'invoice')),
  key text not null check (key ~ '^[a-z][a-z0-9_]{0,59}$' and key <> 'source_id'),
  label text not null check (length(btrim(label)) between 1 and 80),
  type text not null check (type in ('text', 'number', 'date', 'choice', 'yes_no')),
  choices text[] not null default '{}' check (cardinality(choices) <= 50),
  show_on_pdf boolean not null default false,
  show_in_portal boolean not null default false,
  sort integer not null default 0,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, record_type, key),
  check (type <> 'choice' or cardinality(choices) > 0)
);
select private.add_touch_triggers(array['custom_field_definitions']);

select private.apply_policies('custom_field_definitions', '{owner,admin,office}');
select private.restrict_area('custom_field_definitions', 'settings', false);

-- A field's key is what its values are filed under, so it never changes: a new name is a new label.
create function private.custom_field_key_kept() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.key <> old.key or new.record_type <> old.record_type or new.company_id <> old.company_id then
    raise exception 'A field keeps its key and what it''s on. Add a new field instead.' using errcode = '22023';
  end if;
  return new;
end $$;
create trigger key_kept before update of key, record_type, company_id on public.custom_field_definitions
  for each row execute function private.custom_field_key_kept();

comment on table public.custom_field_definitions is 'A business''s own fields on clients, properties, jobs, quotes and invoices; the values are on each record''s custom_fields.';

-- ---------------------------------------------------------------------------------------------
-- The values, on each record (clients already have them)
-- ---------------------------------------------------------------------------------------------

alter table public.properties add column custom_fields jsonb not null default '{}';
alter table public.jobs add column custom_fields jsonb not null default '{}';
alter table public.quotes add column custom_fields jsonb not null default '{}';
alter table public.invoices add column custom_fields jsonb not null default '{}';
alter table public.clients add constraint clients_custom_fields_object check (jsonb_typeof(custom_fields) = 'object');
alter table public.properties add constraint properties_custom_fields_object check (jsonb_typeof(custom_fields) = 'object');
alter table public.jobs add constraint jobs_custom_fields_object check (jsonb_typeof(custom_fields) = 'object');
alter table public.quotes add constraint quotes_custom_fields_object check (jsonb_typeof(custom_fields) = 'object');
alter table public.invoices add constraint invoices_custom_fields_object check (jsonb_typeof(custom_fields) = 'object');

-- ---------------------------------------------------------------------------------------------
-- Carried forward: a quote's to its job, a job's (and its quote's) to its invoice
-- ---------------------------------------------------------------------------------------------

-- The values one record carries to a record made from it: each whose key is a field on both, of the
-- same type, and not archived on the new one.
create function private.carried_custom_fields(p_company uuid, p_from text, p_to text, p_values jsonb) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_object_agg(v.key, v.value), '{}')
  from jsonb_each(coalesce(p_values, '{}')) v
  join public.custom_field_definitions f on f.company_id = p_company and f.record_type = p_from and f.key = v.key
  join public.custom_field_definitions t on t.company_id = p_company and t.record_type = p_to and t.key = v.key and t.type = f.type and t.archived_at is null
$$;

-- On the new row, so every way a job or invoice is made carries them (convert_quote_to_job,
-- create_invoice_for_job, autopay); a value the new row is given itself wins.
create function private.carry_custom_fields() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  -- Nested, since each table's row has only its own columns.
  if tg_table_name = 'jobs' then
    if new.quote_id is not null then
      new.custom_fields := coalesce((
        select private.carried_custom_fields(q.company_id, 'quote', 'job', q.custom_fields)
        from public.quotes q where q.id = new.quote_id and q.company_id = new.company_id), '{}') || new.custom_fields;
    end if;
  elsif new.job_id is not null then
    new.custom_fields := coalesce((
      select private.carried_custom_fields(j.company_id, 'quote', 'invoice', q.custom_fields) || private.carried_custom_fields(j.company_id, 'job', 'invoice', j.custom_fields)
      from public.jobs j left join public.quotes q on q.id = j.quote_id
      where j.id = new.job_id and j.company_id = new.company_id), '{}') || new.custom_fields;
  end if;
  return new;
end $$;
create trigger carry_custom_fields before insert on public.jobs for each row execute function private.carry_custom_fields();
create trigger carry_custom_fields before insert on public.invoices for each row execute function private.carry_custom_fields();
-- Only ever run by their triggers.
revoke all on function private.custom_field_key_kept(), private.carried_custom_fields(uuid, text, text, jsonb), private.carry_custom_fields() from public;

select private.fold_member_checks();

notify pgrst, 'reload schema';
