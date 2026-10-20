"""Run a temporary HTTPS tunnel and write an owner-only connection file."""
import json, os, re, signal, subprocess, time
from pathlib import Path

state = Path(os.environ.get('KREA_STATE','/workspace/.krea-studio'))
binary = os.environ.get('CLOUDFLARED_BIN','cloudflared')
process = subprocess.Popen([binary,'tunnel','--url','http://127.0.0.1:18189','--no-autoupdate'],stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True)
def stop(*_):
    process.terminate()
signal.signal(signal.SIGTERM,stop)
signal.signal(signal.SIGINT,stop)
with (state/'tunnel.log').open('a') as log:
    for line in process.stdout:
        log.write(line);log.flush()
        match = re.search(r'https://[a-z0-9-]+\.trycloudflare\.com',line)
        if match:
            target = Path('/workspace/krea-connection.json')
            data={'kind':'krea-studio-connection','version':1,'url':match.group(0),'key':(state/'access.key').read_text().strip()}
            temp=target.with_suffix('.tmp');temp.write_text(json.dumps(data,indent=2));temp.chmod(0o600);temp.replace(target)
            print('Connection file ready: /workspace/krea-connection.json',flush=True)
raise SystemExit(process.wait())
