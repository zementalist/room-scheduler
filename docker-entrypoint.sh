#!/bin/sh
# Hosts mount persistent disks/volumes owned by root. Start as root, make sure the data directory
# is writable by the unprivileged "node" user, then drop privileges before running the app.
set -e
if [ "$(id -u)" = "0" ]; then
  DATA="${DATA_DIR:-/data}"
  mkdir -p "$DATA"
  chown -R node:node "$DATA"
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi
exec "$@"
