# The database service for one Crewtavo instance (Railway template or docker compose): Supabase's
# Postgres image, plus the setup Supabase's own docker setup mounts in (role passwords and JWT
# expiry). See deploy/README.md.
#
# From Docker Hub: anonymous pulls from public.ecr.aws fail on GitHub's runners ("Data limit
# exceeded"), and the release workflow builds this image there. It's the same image on both.
#
# Pinned to one exact build (the part after @), as the app's own Dockerfile is: a release carries
# the database that was tested, not whatever the tag points at that day. To move to a newer one:
#   docker buildx imagetools inspect supabase/postgres:<version>
# then put the version and the Digest it prints here, and build and test the image before releasing.
FROM supabase/postgres:17.11.0.004@sha256:b15d862126dd2dac02da524696ccfde2dcce2ceaee0a58973b2727befe492706

# Railway volumes have a lost+found folder at their root, which initdb refuses, so the data lives
# one level down. Mount the volume at /var/lib/postgresql/data.
ENV PGDATA=/var/lib/postgresql/data/pgdata \
    JWT_EXP=3600

COPY init/roles.sql /docker-entrypoint-initdb.d/init-scripts/99-roles.sql
COPY init/jwt.sql /docker-entrypoint-initdb.d/init-scripts/99-jwt.sql

# Supabase's postgresql.conf names the data directory itself; point it at the subfolder too.
CMD ["postgres", "-c", "config_file=/etc/postgresql/postgresql.conf", "-c", "data_directory=/var/lib/postgresql/data/pgdata", "-c", "log_min_messages=fatal"]
