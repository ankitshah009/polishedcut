#!/usr/bin/env bash
# Serve polishedcut.vercel.app from this Mac, and keep it served.
#
# Vercel cannot run the pipeline (no ffmpeg, read-only disk, request-scoped functions, no long-lived
# Socket.IO for Photon), so production is: `next start` here + a public tunnel into it + a tiny Vercel
# deployment whose only job is to rewrite every path of polishedcut.vercel.app to the tunnel.
#
# Two tunnel transports, picked automatically and re-picked every time the tunnel drops:
#   cloudflared  Cloudflare quick tunnel (HTTP/2; QUIC on 7844 is blocked on some networks). Fast, but
#                needs outbound TCP 7844, which the corporate VPN here blocks (default route on ipsec0).
#   ssh          `ssh -R 80:localhost:3100 nokey@localhost.run` over port 22. Works through the VPN at
#                ~30 KB/s, enough for the app, too slow to be the first choice.
# Both hand out a fresh hostname on every (re)connect, so a watcher redeploys the proxy whenever the
# hostname changes, and also whenever the live domain stops answering while the local server does (that
# is what happens when a push to main makes Vercel's Git integration alias a real build over the proxy;
# `install` also sets the project's Ignored Build Step to `exit 0` so Git pushes never build).
#
#   scripts/live-tunnel.sh            # (up) build if needed, start server + supervised tunnel + proxy
#   scripts/live-tunnel.sh serve      # foreground supervisor; what the launchd agent runs
#   scripts/live-tunnel.sh status     # what is running and the current public URL
#   scripts/live-tunnel.sh stop       # stop tunnel + supervisor (+ the server) — never while a run is in flight
#   scripts/live-tunnel.sh install    # launchd agent (RunAtLoad + KeepAlive): survives logout/login and crashes
#   scripts/live-tunnel.sh uninstall
#
# Logs: /tmp/pc-server.log (next start), /tmp/tunnel.log (tunnel + supervisor), /tmp/pc-proxy.log (Vercel
# deploys). Current public hostname: /tmp/pc-tunnel.url. Nothing here restarts a running server: `up` and
# `serve` only start `next start` when nothing listens on $PORT (see AGENTS.md).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-3100}"
PROXY_DIR="${PROXY_DIR:-/tmp/pc-proxy}"
LIVE_HOST="${LIVE_HOST:-polishedcut.vercel.app}"
URL_FILE=/tmp/pc-tunnel.url
TUNNEL_LOG=/tmp/pc-tunnel-proc.log   # raw output of the current tunnel process
LOG=/tmp/tunnel.log                  # supervisor log (the historical name; status reads it)
LABEL=ai.polishedcut.live
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
# Cloudflare's tunnel edge; cloudflared needs TCP 7844 to one of these.
CF_EDGE_HOSTS="region1.v2.argotunnel.com region2.v2.argotunnel.com"
SSH_REMOTE="${SSH_REMOTE:-nokey@localhost.run}"
RECHECK_CF_EVERY="${RECHECK_CF_EVERY:-300}"   # seconds between "is 7844 open again?" checks while on ssh
HEALTH_EVERY="${HEALTH_EVERY:-60}"            # seconds between live-domain health checks

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) [live] $*" | tee -a "$LOG" >&2; }

status() {
  local pid; pid=$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | awk 'NR==2{print $2}')
  echo "server:     ${pid:-not running}${pid:+ (pid)} on port $PORT"
  echo "supervisor: $(pgrep -f "live-tunnel.sh serve" | head -1 || true)"
  echo "transport:  $(pgrep -fl 'cloudflared tunnel --url' >/dev/null && echo cloudflared || (pgrep -f "ssh .*-R 80:localhost:$PORT" >/dev/null && echo ssh || echo none))"
  echo "tunnel:     $(cat $URL_FILE 2>/dev/null || echo none)"
  echo "proxy:      $(grep -o 'https://[^/"]*' "$PROXY_DIR/vercel.json" 2>/dev/null | head -1 || echo not deployed)"
  echo "launchd:    $(launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1 && echo loaded || echo not loaded)"
  echo "live:       https://$LIVE_HOST/api/health -> $(curl -s -m 15 -o /dev/null -w '%{http_code}' "https://$LIVE_HOST/api/health" || echo unreachable)"
}

kill_tunnels() {
  pkill -f 'cloudflared tunnel --url' 2>/dev/null || true
  pkill -f "ssh .*-R 80:localhost:$PORT" 2>/dev/null || true
  pkill -f /tmp/pc-ssh-tunnel.sh 2>/dev/null || true   # the hand-rolled fallback loop from 2026-10-31
  pkill -f /tmp/pc-tunnel.sh 2>/dev/null || true       # the pre-supervisor watcher
}

stop() {
  if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    echo "launchd agent unloaded (run 'install' to load it again)"
  fi
  pkill -f "live-tunnel.sh serve" 2>/dev/null || true
  kill_tunnels
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | xargs kill 2>/dev/null || true
  echo stopped
}

# ---------------------------------------------------------------------------------------------- proxy
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
  local out
  out=$(cd "$PROXY_DIR" && vercel --prod --yes 2>&1 | grep -E 'Aliased|Error' || true)
  log "proxy -> $url: ${out:-no output from vercel}"
  echo "$out" >> /tmp/pc-proxy.log
}

# Vercel's Git integration builds the real app on every push to main and aliases it over the proxy.
# An Ignored Build Step of `exit 0` makes Git-triggered builds no-ops; CLI deploys are unaffected.
disable_git_builds() {
  local auth="$HOME/Library/Application Support/com.vercel.cli/auth.json" token pid org
  [ -f "$auth" ] || { echo "no vercel CLI login; skipping Ignored Build Step"; return 0; }
  token=$(python3 -I -c "import json;print(json.load(open('$auth')).get('token',''))")
  pid=$(python3 -I -c "import json;print(json.load(open('$ROOT/.vercel/project.json'))['projectId'])")
  org=$(python3 -I -c "import json;print(json.load(open('$ROOT/.vercel/project.json'))['orgId'])")
  [ -n "$token" ] || { echo "vercel token empty; skipping"; return 0; }
  curl -s -m 20 -X PATCH "https://api.vercel.com/v9/projects/$pid?teamId=$org" \
    -H "Authorization: Bearer $token" -H "content-type: application/json" \
    --data '{"commandForIgnoringBuildStep":"exit 0"}' \
    | python3 -I -c "import json,sys;d=json.load(sys.stdin);print('ignored build step:',d.get('commandForIgnoringBuildStep') or d.get('error'))"
}

# --------------------------------------------------------------------------------------------- tunnel
cf_reachable() {
  local h ip
  for h in $CF_EDGE_HOSTS; do
    for ip in $(dig +short "$h" 2>/dev/null | head -2); do
      nc -z -G 5 "$ip" 7844 >/dev/null 2>&1 && return 0
    done
  done
  return 1
}

# Run one tunnel process in the foreground until it exits; publish its hostname to $URL_FILE as soon as
# it appears. $1 = cloudflared | ssh.
run_tunnel() {
  local transport="$1" pattern
  : > "$TUNNEL_LOG"; : > "$URL_FILE"
  case "$transport" in
    cloudflared)
      pattern='https://[a-z0-9-]*\.trycloudflare\.com'
      cloudflared tunnel --url "http://localhost:$PORT" --no-autoupdate --protocol http2 >> "$TUNNEL_LOG" 2>&1 &
      ;;
    ssh)
      pattern='https://[a-z0-9-]*\.lhr\.life'
      ssh -o StrictHostKeyChecking=no -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=3 \
          -o ExitOnForwardFailure=yes -T -R "80:localhost:$PORT" "$SSH_REMOTE" >> "$TUNNEL_LOG" 2>&1 &
      ;;
  esac
  local pid=$! url="" i
  for i in $(seq 1 40); do
    kill -0 "$pid" 2>/dev/null || break
    url=$(grep -ao "$pattern" "$TUNNEL_LOG" | tail -1 || true)
    [ -n "$url" ] && break
    sleep 1
  done
  if [ -n "$url" ]; then
    echo "$url" > "$URL_FILE"; log "$transport up: $url"
  else
    log "$transport gave no hostname in 40s (see $TUNNEL_LOG)"; kill "$pid" 2>/dev/null || true
  fi
  # Watch for a hostname change in the same process (cloudflared re-registers after an edge drop).
  while kill -0 "$pid" 2>/dev/null; do
    sleep 5
    local now; now=$(grep -ao "$pattern" "$TUNNEL_LOG" | tail -1 || true)
    if [ -n "$now" ] && [ "$now" != "$(cat $URL_FILE 2>/dev/null)" ]; then echo "$now" > "$URL_FILE"; log "$transport moved: $now"; fi
    # On ssh: switch back to cloudflared once 7844 opens up again (VPN off).
    if [ "$transport" = ssh ] && [ $((SECONDS % RECHECK_CF_EVERY)) -lt 5 ] && cf_reachable; then
      log "port 7844 reachable again; switching to cloudflared"; kill "$pid" 2>/dev/null || true
    fi
  done
  wait "$pid" 2>/dev/null || true
  : > "$URL_FILE"
}

# Keep the proxy pointed at the current hostname, and re-deploy it when the live domain is broken
# while the local server is fine (something else took over the alias).
watcher() {
  local last_health=0
  while true; do
    sleep 10
    local url cur; url=$(cat $URL_FILE 2>/dev/null || true); cur=$(grep -o 'https://[^/"]*' "$PROXY_DIR/vercel.json" 2>/dev/null | head -1 || true)
    if [ -n "$url" ] && [ "$url" != "$cur" ]; then
      log "hostname changed ($cur -> $url); redeploying proxy"; deploy_proxy "$url"; continue
    fi
    if [ -n "$url" ] && [ $((SECONDS - last_health)) -ge "$HEALTH_EVERY" ]; then
      last_health=$SECONDS
      local live local_ok
      live=$(curl -s -m 20 -o /dev/null -w '%{http_code}' "https://$LIVE_HOST/api/health" || echo 000)
      local_ok=$(curl -s -m 5 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/health" || echo 000)
      if [ "$local_ok" = 200 ] && [ "$live" != 200 ]; then
        local direct; direct=$(curl -s -m 20 -o /dev/null -w '%{http_code}' "$url/api/health" || echo 000)
        if [ "$direct" = 200 ]; then log "live $live but tunnel direct 200; redeploying proxy"; deploy_proxy "$url"
        else log "live $live, tunnel direct $direct; waiting for the tunnel to reconnect"; fi
      fi
    fi
  done
}

ensure_server() {
  cd "$ROOT"
  [ -d .next ] || npm run build
  if ! lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t >/dev/null 2>&1; then
    log "starting next start -p $PORT"
    nohup npx next start -p "$PORT" > /tmp/pc-server.log 2>&1 &
    sleep 4
  fi
}

serve() {
  command -v cloudflared >/dev/null || log "cloudflared missing (brew install cloudflared); ssh transport only"
  # another supervisor alive (launchd started us while a manual one runs, or vice versa): defer to it
  for p in $(pgrep -f "live-tunnel.sh serve"); do
    if [ "$p" != "$$" ] && [ "$p" != "$PPID" ]; then log "supervisor $p already running; exiting"; exit 0; fi
  done
  ensure_server
  kill_tunnels
  trap 'kill_tunnels; kill 0 2>/dev/null' EXIT INT TERM
  watcher &
  while true; do
    if command -v cloudflared >/dev/null && cf_reachable; then run_tunnel cloudflared; else run_tunnel ssh; fi
    log "tunnel exited; reconnecting in 3s"; sleep 3
  done
}

# launchd: start everything at every login and restart it whenever it dies. (LaunchAgents run after the
# user logs in; with FileVault the Mac must get past the login screen first.)
install() {
  mkdir -p "$HOME/Library/LaunchAgents"
  cat > "$PLIST" <<XML
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$ROOT/scripts/live-tunnel.sh</string><string>serve</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>$PATH</string>
    <key>HOME</key><string>$HOME</string>
    <key>PORT</key><string>$PORT</string>
  </dict>
  <key>StandardOutPath</key><string>/tmp/pc-launchd.log</string>
  <key>StandardErrorPath</key><string>/tmp/pc-launchd.log</string>
</dict></plist>
XML
  disable_git_builds || true
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  pkill -f "live-tunnel.sh serve" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
  echo "installed $PLIST (KeepAlive; log /tmp/pc-launchd.log)"
}
uninstall() { launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true; rm -f "$PLIST"; echo "removed $PLIST"; }

case "${1:-up}" in
  status) status; exit 0 ;;
  stop) stop; exit 0 ;;
  install) install; exit 0 ;;
  uninstall) uninstall; exit 0 ;;
  serve) serve ;;
  up)
    if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
      launchctl kickstart "gui/$(id -u)/$LABEL"; echo "launchd agent kicked"
    elif pgrep -f "live-tunnel.sh serve" >/dev/null; then
      echo "supervisor already running"
    else
      nohup bash "$0" serve >> /tmp/pc-launchd.log 2>&1 &
      echo "supervisor started (pid $!)"
    fi
    for _ in $(seq 1 60); do [ -s "$URL_FILE" ] && break; sleep 1; done
    sleep 2; status ;;
  *) echo "usage: $0 [up|serve|status|stop|install|uninstall]"; exit 1 ;;
esac
