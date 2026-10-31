#!/usr/bin/env bash
# Serve polishedcut.vercel.app from this Mac.
#
# Vercel cannot run the pipeline (no ffmpeg, read-only disk, request-scoped functions, no long-lived
# Socket.IO for Photon), so production is: `next start` here + an SSH reverse tunnel (serveo.net, port
# 22; Cloudflare's tunnel port 7844 is blocked on some networks) + a tiny Vercel deployment whose only
# job is to rewrite every path of polishedcut.vercel.app to the tunnel.
#
#   scripts/live-tunnel.sh            # build if needed, start server + tunnel, deploy the proxy
#   scripts/live-tunnel.sh status     # what is running and the current public URL
#   scripts/live-tunnel.sh stop
#
# Logs: /tmp/pc-server.log, /tmp/serveo.log, /tmp/pc-proxy.log. The tunnel hostname changes on every
# reconnect; a watcher inside the tunnel loop redeploys the proxy automatically when that happens.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-3100}"
PROXY_DIR=/tmp/pc-proxy

status() {
  local pid; pid=$(lsof -nP -iTCP:$PORT -sTCP:LISTEN 2>/dev/null | awk 'NR==2{print $2}')
  echo "server:  ${pid:-not running}${pid:+ (pid)} on port $PORT"
  echo "tunnel:  $(grep -o 'https://[a-z0-9.-]*serveousercontent\.com\|https://[a-z0-9-]*\.serveo\.net' /tmp/serveo.log 2>/dev/null | tail -1 || echo none)"
  echo "proxy:   $(grep -o 'https://[^/"]*' $PROXY_DIR/vercel.json 2>/dev/null | head -1 || echo not deployed)"
  echo "photon:  $(curl -s localhost:$PORT/api/photon/webhook 2>/dev/null || echo server down)"
}

stop() {
  pkill -f "$ROOT/.*serveo" 2>/dev/null || true
  pkill -f /tmp/serveo.sh 2>/dev/null || true
  pkill -f 'ssh .* -R 80:localhost' 2>/dev/null || true
  lsof -nP -iTCP:$PORT -sTCP:LISTEN -t 2>/dev/null | xargs kill 2>/dev/null || true
  echo stopped
}

case "${1:-up}" in
  status) status; exit 0 ;;
  stop) stop; exit 0 ;;
esac

cd "$ROOT"
[ -d .next ] || npm run build
if ! lsof -nP -iTCP:$PORT -sTCP:LISTEN -t >/dev/null 2>&1; then
  nohup npx next start -p "$PORT" > /tmp/pc-server.log 2>&1 &
  sleep 4
fi

# The proxy: a tiny Vercel deployment that rewrites every path of polishedcut.vercel.app to the tunnel.
deploy_proxy() {
  local url="$1"
  mkdir -p "$PROXY_DIR/.vercel"; cp "$ROOT/.vercel/project.json" "$PROXY_DIR/.vercel/"
  cat > "$PROXY_DIR/vercel.json" <<JSON
{
  "framework": null,
  "buildCommand": "mkdir -p public && echo proxy > public/.keep",
  "outputDirectory": "public",
  "rewrites": [
    { "source": "/", "destination": "$url/" },
    { "source": "/:path*", "destination": "$url/:path*" }
  ]
}
JSON
  (cd "$PROXY_DIR" && vercel --prod --yes 2>&1 | grep -E 'Aliased|Error' || true)
}
export -f deploy_proxy
export ROOT PROXY_DIR

# serveo expires a forwarding after a while and hands out a new hostname on reconnect, which left the
# proxy pointing at a dead URL (502 on the live site). The loop below reconnects, and a watcher
# redeploys the proxy whenever the hostname in the log stops matching the one in vercel.json.
cat > /tmp/serveo.sh <<SH
#!/bin/bash
export PATH="$PATH"
ROOT="$ROOT"; PROXY_DIR="$PROXY_DIR"
$(declare -f deploy_proxy)
(
  while true; do
    sleep 15
    url=\$(grep -o 'https://[a-z0-9.-]*serveousercontent\.com\|https://[a-z0-9-]*\.serveo\.net' /tmp/serveo.log 2>/dev/null | tail -1)
    cur=\$(grep -o 'https://[^/"]*' "\$PROXY_DIR/vercel.json" 2>/dev/null | head -1)
    if [ -n "\$url" ] && [ "\$url" != "\$cur" ]; then
      echo "[watcher] tunnel moved to \$url; redeploying proxy" >> /tmp/pc-proxy.log
      deploy_proxy "\$url" >> /tmp/pc-proxy.log 2>&1
    fi
  done
) &
while true; do
  ssh -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes -R 80:localhost:$PORT serveo.net
  sleep 3
done
SH
chmod +x /tmp/serveo.sh
pkill -f /tmp/serveo.sh 2>/dev/null || true; pkill -f 'ssh .* -R 80:localhost' 2>/dev/null || true
: > /tmp/serveo.log
nohup /tmp/serveo.sh > /tmp/serveo.log 2>&1 &
for _ in $(seq 1 20); do
  URL=$(grep -o 'https://[a-z0-9.-]*serveousercontent\.com\|https://[a-z0-9-]*\.serveo\.net' /tmp/serveo.log | tail -1 || true)
  [ -n "$URL" ] && break; sleep 1
done
[ -n "${URL:-}" ] || { echo "no tunnel URL after 20s; see /tmp/serveo.log"; exit 1; }
echo "tunnel: $URL"

deploy_proxy "$URL"
status
