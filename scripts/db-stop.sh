#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DATA_DIR="$PROJECT_DIR/.postgres/data"

if [ -s "$DATA_DIR/PG_VERSION" ]; then
  /Library/PostgreSQL/18/bin/pg_ctl -D "$DATA_DIR" stop -m fast
else
  echo "Lesson 4 PostgreSQL cluster is not initialized."
fi
