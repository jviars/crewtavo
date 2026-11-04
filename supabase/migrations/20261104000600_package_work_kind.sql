-- A package estimate knows its kind of work, roofing or paving, for a business with both apps
-- installed (20261103000500_paving_roofing_apps.sql). Before, Roofing made every package estimate
-- roof work, so a paving estimate got roof pricing and a paving package (no roof service) was refused.
--   quotes.work_kind   where it was made: the Roofing or the Paving section. Null for an estimate made
--                      anywhere else; then its packages tell (a roof package has its roof), in
--                      apps/api/src/services/roofPackages.ts workKind. With one app it changes nothing.

alter table public.quotes add column work_kind text constraint quotes_work_kind_check check (work_kind in ('roofing', 'paving'));

comment on column public.quotes.work_kind is 'Roofing or paving: the section the estimate was made in, for a business with both apps. Null elsewhere, where its packages tell.';
