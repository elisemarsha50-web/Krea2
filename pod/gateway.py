"""Private, buildless Krea Studio gateway. Python 3.10+, no extra packages."""
import copy, hmac, json, mimetypes, os, re, secrets, threading, time, uuid
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.request import Request, urlopen
from urllib.parse import urlparse, parse_qs, urlencode
from urllib.error import HTTPError, URLError

ROOT = Path(__file__).resolve().parents[1]
STATE = Path(os.environ.get('KREA_STATE', '/workspace/.krea-studio'))
UPSTREAM = os.environ.get('COMFYUI_LOCAL_URL', 'http://127.0.0.1:18188').rstrip('/')
KEY = (STATE / 'access.key').read_text().strip()
INTERNAL = (STATE / 'internal.key').read_text().strip()
JOBS = {}
LOCK = threading.RLock()
STATIC = {'index.html', 'app.js', 'studio-utils.js', 'styles.css', 'workflow.json', 'icon.svg'}

def comfy(path, body=None, raw=False):
    headers = {'X-Krea-Internal': INTERNAL}
    if body is not None: headers['Content-Type'] = 'application/json'
    req = Request(UPSTREAM + path, data=None if body is None else json.dumps(body).encode(), headers=headers)
    try:
        with urlopen(req, timeout=45) as response:
            data = response.read()
            return (data, response.headers.get_content_type()) if raw else (json.loads(data) if data else {})
    except HTTPError as error:
        try:
            info = json.loads(error.read())
            details = []
            for node, problem in info.get('node_errors', {}).items():
                for message in problem.get('errors', []): details.append(f"{node}: {message.get('message', '')} {message.get('details', '')}")
            message = '; '.join(details) or info.get('error', {}).get('message', 'ComfyUI отклонил запрос')
        except Exception: message = 'ComfyUI отклонил запрос'
        raise ValueError(str(message)[:1500]) from None
    except (URLError, TimeoutError, OSError):
        raise ValueError('ComfyUI ещё не готов или недоступен. Проверьте запуск пода.') from None

def graph_from(body):
    graph = body.get('workflow')
    if not isinstance(graph, dict) or not graph or len(graph) > 1200 or 'nodes' in graph:
        raise ValueError('Нужен workflow в формате Export (API).')
    for node in graph.values():
        if not isinstance(node, dict) or not isinstance(node.get('class_type'), str) or not isinstance(node.get('inputs'), dict):
            raise ValueError('Некорректный API-workflow.')
    return copy.deepcopy(graph)

def assign(graph, binding, value):
    if not binding: return
    node, field = str(binding.get('node')), binding.get('field')
    if node not in graph or not isinstance(field, str) or field not in graph[node]['inputs']:
        raise ValueError('Поле настройки не найдено в API-workflow.')
    if isinstance(graph[node]['inputs'][field], list):
        raise ValueError('Поле связано с другим узлом: выберите конечное поле настройки.')
    graph[node]['inputs'][field] = value

def integer(value, low, high, name):
    if isinstance(value, bool) or not isinstance(value, (float, int)) or int(value) != value or not low <= value <= high:
        raise ValueError(f'Недопустимое значение: {name}.')
    return int(value)

def state_of(job):
    if job.get('cancelled'): return {'state': 'cancelled', 'images': []}
    history = comfy('/history/' + job['id']).get(job['id'])
    if history:
        status = history.get('status', {})
        if status.get('status_str') == 'error':
            messages = status.get('messages', [])
            reason = next((data.get('exception_message', '') for name, data in messages if name == 'execution_error'), 'Ошибка выполнения ComfyUI.')
            return {'state': 'error', 'error': str(reason)[:1500], 'images': []}
        images, seen = [], set()
        for output in history.get('outputs', {}).values():
            for image in output.get('images', []):
                identity = tuple(image.get(k, '') for k in ('filename', 'subfolder', 'type'))
                if identity not in seen: seen.add(identity); images.append(image)
        job['images'] = images
        job.setdefault('seconds', round(time.monotonic() - job['started'], 1))
        return {'state': 'complete', 'seed': job['seed'], 'seconds': job['seconds'], 'images': [{'index': i} for i in range(len(images))]}
    queue = comfy('/queue')
    running = any(row[1] == job['id'] for row in queue.get('queue_running', []))
    return {'state': 'running' if running else 'queued', 'images': []}

class Handler(BaseHTTPRequestHandler):
    server_version = 'KreaStudio/1.0'
    def log_message(self, fmt, *args):
        # Never log headers, keys, prompts, request bodies, or image paths.
        print(time.strftime('%H:%M:%S'), self.command, urlparse(self.path).path, flush=True)

    def headers_common(self, content_type, length):
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(length))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', 'Authorization, Content-Type')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self' https: http://localhost:* http://127.0.0.1:*; object-src 'none'; base-uri 'self'; frame-ancestors 'none'")

    def send(self, status, data, content_type='application/json; charset=utf-8'):
        if not isinstance(data, bytes): data = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(status); self.headers_common(content_type, len(data)); self.end_headers()
        try: self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError): pass

    def authenticated(self):
        received = self.headers.get('Authorization', '')
        if not hmac.compare_digest(received.encode(), ('Bearer ' + KEY).encode()):
            self.send(401, {'error': 'Неверный ключ доступа.'}); return False
        return True

    def body(self):
        length = int(self.headers.get('Content-Length', '0'))
        if not 0 < length <= 2 * 1024 * 1024: raise ValueError('Размер запроса должен быть не более 2 МБ.')
        if self.headers.get_content_type() != 'application/json': raise ValueError('Ожидается application/json.')
        data = json.loads(self.rfile.read(length))
        if not isinstance(data, dict): raise ValueError('Ожидается объект JSON.')
        return data

    def do_OPTIONS(self): self.send(204, b'')

    def do_GET(self):
        path = urlparse(self.path).path
        if path in ('/', '/index.html') or path.lstrip('/') in STATIC:
            name = 'index.html' if path == '/' else path.lstrip('/')
            data = (ROOT / name).read_bytes()
            return self.send(200, data, mimetypes.guess_type(name)[0] or 'application/octet-stream')
        if not path.startswith('/api/'): return self.send(404, {'error': 'Не найдено.'})
        if not self.authenticated(): return
        try:
            if path == '/api/health':
                stats = comfy('/system_stats')
                gpu = next((d.get('name', '') for d in stats.get('devices', []) if d.get('type') == 'cuda'), 'ComfyUI готов')
                return self.send(200, {'service': 'krea-studio', 'version': 1, 'gpu': gpu})
            if path.startswith('/api/job/'):
                job = JOBS.get(path.removeprefix('/api/job/'))
                if not job: return self.send(404, {'error': 'Задание не найдено в этой сессии шлюза.'})
                result = state_of(job)
                return self.send(200, result)
            if path == '/api/image':
                query = parse_qs(urlparse(self.path).query)
                job = JOBS.get(query.get('job', [''])[0]); index = int(query.get('index', ['-1'])[0])
                if not job or not job.get('images') or not 0 <= index < len(job['images']): return self.send(404, {'error': 'Изображение не найдено.'})
                image = job['images'][index]
                data, kind = comfy('/view?' + urlencode({k: image.get(k, '') for k in ('filename', 'subfolder', 'type')}), raw=True)
                if kind not in ('image/png', 'image/jpeg', 'image/webp'): raise ValueError('ComfyUI вернул не изображение.')
                return self.send(200, data, kind)
            self.send(404, {'error': 'Не найдено.'})
        except (ValueError, KeyError, TypeError, json.JSONDecodeError) as error: self.send(400, {'error': str(error)[:1500]})
        except Exception: self.send(502, {'error': 'Ошибка шлюза. Проверьте ComfyUI на поде.'})

    def do_POST(self):
        if not self.authenticated(): return
        path = urlparse(self.path).path
        try:
            body = self.body()
            if path == '/api/inspect':
                graph = graph_from(body); info = comfy('/object_info')
                missing_nodes = sorted({n['class_type'] for n in graph.values()} - set(info))
                missing_models = []
                for node in graph.values():
                    definition = info.get(node['class_type'], {}).get('input', {})
                    fields = {**definition.get('required', {}), **definition.get('optional', {})}
                    for name in ('unet_name','clip_name','vae_name','ckpt_name','lora_name','model_name'):
                        value = node['inputs'].get(name); spec = fields.get(name, [])
                        choices = spec[0] if spec and isinstance(spec[0], list) else (spec[1].get('options', []) if len(spec)>1 and isinstance(spec[1], dict) else [])
                        if isinstance(value, str) and choices and value not in choices: missing_models.append(value)
                return self.send(200, {'missing_nodes': missing_nodes, 'missing_models': sorted(set(missing_models))})
            if path == '/api/generate':
                graph = graph_from(body); bindings = body.get('bindings', {})
                prompt = body.get('prompt')
                if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > 12000: raise ValueError('Промпт должен содержать от 1 до 12000 символов.')
                if not bindings.get('prompt'): raise ValueError('Не выбрано поле промпта.')
                seed = secrets.randbits(48) if body.get('seed') is None else integer(body['seed'], 0, 1125899906842623, 'seed')
                assign(graph, bindings['prompt'], prompt.strip())
                for name in ('width','height'): assign(graph, bindings.get(name), integer(body.get(name,1500),256,2048,name))
                assign(graph, bindings.get('count'), integer(body.get('count',1),1,4,'count'))
                for binding in bindings.get('seeds', []): assign(graph, binding, seed)
                sampler = bindings.get('sampler')
                if sampler:
                    assign(graph, {'node':sampler,'field':'steps'}, integer(body.get('steps',8),1,50,'steps'))
                    cfg = body.get('cfg',1)
                    if isinstance(cfg,bool) or not isinstance(cfg,(float,int)) or not 1 <= cfg <= 15: raise ValueError('CFG должен быть от 1 до 15.')
                    assign(graph, {'node':sampler,'field':'cfg'}, cfg)
                with LOCK:
                    if len(JOBS) >= 2000: raise ValueError('Достигнут лимит сессии (2000 заданий). Сохраните изображения и перезапустите шлюз.')
                    queued = comfy('/prompt', {'prompt':graph,'client_id':str(uuid.uuid4())})
                    pid = queued['prompt_id']; JOBS[pid] = {'id':pid,'seed':seed,'started':time.monotonic()}
                return self.send(200, {'id':pid, 'seed':seed})
            if path == '/api/cancel':
                with LOCK:
                    job = JOBS.get(body.get('id'))
                    if not job: raise ValueError('Неизвестное задание.')
                    result = comfy('/api/jobs/' + job['id'] + '/cancel', {})
                    cancelled = bool(result.get('cancelled'))
                    if cancelled: job['cancelled'] = True
                return self.send(200, {'ok':True, 'cancelled':cancelled})
            self.send(404, {'error':'Не найдено.'})
        except (ValueError, KeyError, TypeError, json.JSONDecodeError) as error: self.send(400, {'error':str(error)[:1500]})
        except Exception: self.send(502, {'error':'Ошибка шлюза. Проверьте журнал ComfyUI.'})

if __name__ == '__main__':
    address = ('127.0.0.1', int(os.environ.get('KREA_PORT', '18189')))
    print(f'Krea Studio ready at http://{address[0]}:{address[1]}', flush=True)
    ThreadingHTTPServer(address, Handler).serve_forever()
