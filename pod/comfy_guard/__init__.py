"""Require owner credentials on ComfyUI itself, including images and history."""
import base64, hmac, os
from urllib.parse import urlparse
from pathlib import Path
from aiohttp import web
from server import PromptServer

state = Path(os.environ.get('KREA_STATE', '/workspace/.krea-studio'))
internal = (state / 'internal.key').read_text().strip()
access = (state / 'access.key').read_text().strip()
basic = 'Basic ' + base64.b64encode(('studio:' + access).encode()).decode()

@web.middleware
async def guard(request, handler):
    # Schema and readiness only: needed by the image's native startup checker.
    path = request.path
    public = (request.method == 'GET' and (path == '/system_stats' or path == '/object_info' or path.startswith('/object_info/'))) or (request.method == 'POST' and path == '/workflow/convert')
    owned = hmac.compare_digest(request.headers.get('X-Krea-Internal','').encode(), internal.encode())
    browser = hmac.compare_digest(request.headers.get('Authorization','').encode(), basic.encode())
    origin = request.headers.get('Origin')
    host = request.headers.get('X-Forwarded-Host', request.host).split(',')[0].strip()
    if browser and ((origin and urlparse(origin).netloc != host) or request.headers.get('Sec-Fetch-Site') == 'cross-site'):
        browser = False
    if public or owned or browser: return await handler(request)
    return web.Response(status=401, text='Private ComfyUI. Username: studio. Password: your Krea Studio access key.', headers={'WWW-Authenticate':'Basic realm="Private Krea Studio", charset="UTF-8"','Cache-Control':'no-store'})

PromptServer.instance.app.middlewares.append(guard)
NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}
