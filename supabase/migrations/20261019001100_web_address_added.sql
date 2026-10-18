-- Whether Crewtavo added the address to Railway itself, or found it there (bought from Railway, or
-- added by hand). Stopping a change only takes back out what Crewtavo put in.
alter table public.web_address add column railway_domain_added boolean not null default false;
