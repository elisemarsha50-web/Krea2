#!/bin/bash
set -euo pipefail
set +x
APP_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export KREA_STATE=/workspace/.krea-studio
export COMFYUI_LOCAL_URL=http://127.0.0.1:18188
PYTHON=/venv/main/bin/python
test -x "$PYTHON" || PYTHON=python3
test -d /workspace/ComfyUI || { echo 'ComfyUI not found at /workspace/ComfyUI'; exit 1; }
# Restart only an idle ComfyUI. Never interrupt another generation.
"$PYTHON" - <<'PY'
import json,os,urllib.request
from pathlib import Path
p=Path(os.environ['KREA_STATE'])/'internal.key'
headers={'X-Krea-Internal':p.read_text().strip()} if p.exists() else {}
try:
 r=urllib.request.urlopen(urllib.request.Request(os.environ['COMFYUI_LOCAL_URL']+'/queue',headers=headers),timeout=5)
 q=json.load(r)
except Exception:q={}
if q.get('queue_running') or q.get('queue_pending'):raise SystemExit('ComfyUI queue is busy. Wait for completion, then run install.sh again.')
PY
"$PYTHON" - <<'PY'
import os,secrets
from pathlib import Path
p=Path(os.environ['KREA_STATE']);p.mkdir(exist_ok=True,mode=0o700);p.chmod(0o700)
for name in ('access.key','internal.key'):
 f=p/name
 if not f.exists():f.write_text(secrets.token_urlsafe(36))
 f.chmod(0o600)
PY
mkdir -p /workspace/ComfyUI/custom_nodes/krea-studio-guard
cp "$APP_ROOT/pod/comfy_guard/__init__.py" /workspace/ComfyUI/custom_nodes/krea-studio-guard/__init__.py
CLOUDFLARED_BIN="$(command -v cloudflared || true)"
if [ -z "$CLOUDFLARED_BIN" ]; then
  CLOUDFLARED_BIN="$KREA_STATE/cloudflared"
  if [ ! -x "$CLOUDFLARED_BIN" ]; then
    arch="$(uname -m)"
    case "$arch" in x86_64) arch=amd64;; aarch64|arm64) arch=arm64;; *) echo 'Unsupported CPU'; exit 1;; esac
    curl -fL --retry 3 "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$arch" -o "$CLOUDFLARED_BIN"
    chmod 700 "$CLOUDFLARED_BIN"
  fi
fi
export CLOUDFLARED_BIN
if command -v supervisorctl >/dev/null && [ -d /etc/supervisor/conf.d ]; then
  cat > /etc/supervisor/conf.d/krea-studio.conf <<EOF
[program:krea-studio]
command=$PYTHON -u $APP_ROOT/pod/gateway.py
directory=$APP_ROOT
autostart=true
autorestart=true
stopasgroup=true
killasgroup=true
environment=KREA_STATE="$KREA_STATE",COMFYUI_LOCAL_URL="$COMFYUI_LOCAL_URL"
stdout_logfile=$KREA_STATE/gateway.log
stderr_logfile=$KREA_STATE/gateway-error.log

[program:krea-studio-tunnel]
command=$PYTHON -u $APP_ROOT/pod/tunnel.py
directory=$APP_ROOT
autostart=true
autorestart=true
stopasgroup=true
killasgroup=true
environment=KREA_STATE="$KREA_STATE",CLOUDFLARED_BIN="$CLOUDFLARED_BIN"
stdout_logfile=$KREA_STATE/tunnel-status.log
stderr_logfile=$KREA_STATE/tunnel-error.log
EOF
  supervisorctl reread
  supervisorctl update
  supervisorctl restart krea-studio krea-studio-tunnel
  supervisorctl restart comfyui
else
  echo 'Supervisor configuration not found. Installation stopped before opening a public tunnel.'
  echo 'Configure gateway.py and tunnel.py as services, then restart ComfyUI to activate its guard.'
  exit 1
fi
echo 'Krea Studio installed. Download /workspace/krea-connection.json from Jupyter.'
echo 'Import that file into Krea Studio. Do not commit it to GitHub.'
echo 'Direct ComfyUI now requires Basic auth: username studio; password = key from connection file.'
