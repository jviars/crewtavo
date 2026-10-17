# The database service for one Crewtavo instance (Railway template or docker compose): Supabase's
# Postgres image, plus the setup Supabase's own docker setup mounts in (role passwords, JWT expiry,
# the Realtime schema). See deploy/README.md.
FROM public.ecr.aws/supabase/postgres:17.11.0.004

# Railway volumes have a lost+found folder at their root, which initdb refuses, so the data lives
# one level down. Mount the volume at /var/lib/postgresql/data.
ENV PGDATA=/var/lib/postgresql/data/pgdata \
    JWT_EXP=3600

COPY init/roles.sql /docker-entrypoint-initdb.d/init-scripts/99-roles.sql
COPY init/jwt.sql /docker-entrypoint-initdb.d/init-scripts/99-jwt.sql
COPY init/realtime.sql /docker-entrypoint-initdb.d/migrations/99-realtime.sql

# Supabase's postgresql.conf names the data directory itself; point it at the subfolder too.
CMD ["postgres", "-c", "config_file=/etc/postgresql/postgresql.conf", "-c", "data_directory=/var/lib/postgresql/data/pgdata", "-c", "log_min_messages=fatal"]
