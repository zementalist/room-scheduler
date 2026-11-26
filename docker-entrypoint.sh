#!/bin/sh
set -e

# Start as root only to fix ownership of a mounted data directory, then re-run as "node".
if [ "$(id -u)" = "0" ]; then
  DATA="${DATA_DIR:-/data}"
  mkdir -p "$DATA"
  chown -R node:node "$DATA"
  exec setpriv --reuid=node --regid=node --init-groups /usr/local/bin/docker-entrypoint.sh "$@"
fi

# Optional off-site replication. Without LITESTREAM_BUCKET the app just uses the local disk.
if [ -n "$LITESTREAM_BUCKET" ]; then
  export DATA_DIR="${DATA_DIR:-/data}"
  # Rebuild the database from the bucket when the local disk is empty (fresh deploy, wake-up after sleep).
  litestream restore -if-db-not-exists -if-replica-exists -config /etc/litestream.yml "$DATA_DIR/scheduler.db"
  # Run the app as a child of Litestream so shutdown flushes the last changes before exiting.
  exec litestream replicate -config /etc/litestream.yml -exec "$*"
fi

exec "$@"
