-- A guide's cover photo: a picture in the files bucket under <company>/kb/, shown on the guide's
-- card in the knowledge base and across the top of the guide. It isn't part of a revision, so a new
-- cover doesn't ask anyone to read the guide again.
alter table public.sop_pages add column cover_path text
  check (cover_path is null or (private.path_company(cover_path) = company_id and split_part(cover_path, '/', 2) = 'kb'));

notify pgrst, 'reload schema';
