-- Material prices: what goes into a service, from a supplier's catalog, at the business's own
-- prices (Apps → ABC Supply, apps/api/src/integrations/abcSupply.ts).
--
--   * public.service_materials: the materials in one unit of a service, by the supplier's item
--     number. "3 bundles of GAF Timberline HDZ Charcoal per square" is per_unit 3 of item
--     02GATZ3CH in BD. The supplier's last price for one of them is kept with it.
--   * services.labor_cost: what a service with materials costs besides them (labor, equipment,
--     disposal), per unit. Its unit_cost stays the whole cost, materials and the rest together,
--     so everything that reads unit_cost (quotes, job costing) keeps working.
--   * quote_line_items.materials and material_cost: what a line's materials came to when it was
--     priced, whole bundles and rolls at the supplier's price that day. An estimate keeps the
--     prices it was made with until someone prices it again.

alter table public.services add column labor_cost numeric(12, 2) check (labor_cost >= 0);
comment on column public.services.labor_cost is 'With materials (service_materials): the cost besides them, per unit. unit_cost is materials and this together.';

create table public.service_materials (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  service_id uuid not null,
  supplier text not null default 'abc_supply' check (supplier in ('abc_supply')),
  item_number text not null check (length(item_number) between 1 and 40),
  name text not null check (length(trim(name)) between 1 and 300),
  -- The supplier's unit of measure, as it prices it: BD (bundle), SQ (square), RL (roll), PC...
  uom text not null check (length(uom) between 1 and 12),
  uom_name text check (length(uom_name) <= 60),
  -- Items cut to length (coil, trim): the length priced, in feet.
  length_ft numeric(8, 3) check (length_ft > 0),
  -- How many of them go into one unit of the service.
  per_unit numeric(14, 6) not null check (per_unit > 0 and per_unit <= 100000),
  -- The supplier's last price for one, when it was asked, and why there's none ("Call for pricing").
  unit_price numeric(12, 2) check (unit_price >= 0),
  priced_at timestamptz,
  price_note text check (length(price_note) <= 300),
  sort integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (company_id, service_id) references public.services (company_id, id) on delete cascade
);
create index service_materials_service_idx on public.service_materials (service_id, sort);
select private.add_touch_triggers(array['service_materials']);

-- The price list's people read and change them, like the services they belong to.
select private.apply_policies('service_materials', '{owner,admin,office,estimator}', '{owner,admin,office,estimator}');
select private.restrict_area('service_materials', 'settings', false);

alter table public.quote_line_items add column materials jsonb check (materials is null or jsonb_typeof(materials) = 'object');
alter table public.quote_line_items add column material_cost numeric(12, 2) check (material_cost >= 0);
comment on column public.quote_line_items.materials is 'The materials priced for this line: supplier, branch, priced_at and items (quantity ordered, unit price, total).';
comment on column public.quote_line_items.material_cost is 'What the line''s materials came to when it was priced (materials.items totals).';

-- Policies above that ask about membership check it once per query (20261018000990_policy_lookups).
select private.fold_member_checks();

notify pgrst, 'reload schema';
