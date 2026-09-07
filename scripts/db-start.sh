#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PG_BIN="/Library/PostgreSQL/18/bin"
DATA_DIR="$PROJECT_DIR/.postgres/data"
SOCKET_DIR="$PROJECT_DIR/.postgres/socket"
LOG_FILE="$PROJECT_DIR/.postgres/postgres.log"
PORT="${PGPORT:-55432}"
DB_USER="${PGUSER:-mvp_user}"
DB_NAME="${PGDATABASE:-lesson4_mvp}"

mkdir -p "$SOCKET_DIR"

if [ ! -s "$DATA_DIR/PG_VERSION" ]; then
  mkdir -p "$DATA_DIR"
  "$PG_BIN/initdb" -D "$DATA_DIR" --auth=trust --username="$DB_USER" --encoding=UTF8 --locale=C >/dev/null
fi

if ! "$PG_BIN/pg_ctl" -D "$DATA_DIR" status >/dev/null 2>&1; then
  "$PG_BIN/pg_ctl" -D "$DATA_DIR" -l "$LOG_FILE" \
    -o "-k $SOCKET_DIR -p $PORT -c listen_addresses=''" start >/dev/null
fi

if ! "$PG_BIN/psql" -h "$SOCKET_DIR" -p "$PORT" -U "$DB_USER" -d postgres -Atqc \
  "SELECT 1 FROM pg_database WHERE datname = '$DB_NAME'" | grep -q 1; then
  "$PG_BIN/createdb" -h "$SOCKET_DIR" -p "$PORT" -U "$DB_USER" "$DB_NAME"
fi

echo "PostgreSQL ready: $SOCKET_DIR port=$PORT database=$DB_NAME"
