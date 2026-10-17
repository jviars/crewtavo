-- From supabase/supabase docker/volumes/db (Apache-2.0), minus the Edge Functions role Crewtavo doesn't use. Every role shares POSTGRES_PASSWORD, which the template generates.
\set pgpass `echo "$POSTGRES_PASSWORD"`

ALTER USER authenticator WITH PASSWORD :'pgpass';
ALTER USER pgbouncer WITH PASSWORD :'pgpass';
ALTER USER supabase_auth_admin WITH PASSWORD :'pgpass';
ALTER USER supabase_storage_admin WITH PASSWORD :'pgpass';
