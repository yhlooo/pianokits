#!/bin/sh
# dsh-bridges devcontainer entrypoint: start dsh web once, then keep the
# container alive. Runs as PID 1 because devcontainer.json sets
# overrideCommand=false, so dsh survives: processes spawned by lifecycle
# exec sessions (postStartCommand etc.) are killed when the session ends,
# but PID 1's children are not.

trap "exit 0" 15

# Idempotent start: skip when something already listens on 127.0.0.1:3080.
if node -e "require('net').connect(3080, '127.0.0.1').on('connect', () => process.exit(0)).on('error', () => process.exit(1))" 2>/dev/null; then
  echo "dsh web: already listening on http://127.0.0.1:3080"
else
  dsh web >>/tmp/dsh-web.log 2>&1 &
  echo $! >/tmp/dsh-web.pid
  echo "dsh web: starting in background (log: /tmp/dsh-web.log)"
fi

# Keep-alive loop (mirrors the devcontainer CLI default command).
while sleep 1 & wait $!; do :; done
