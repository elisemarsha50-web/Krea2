(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  let endpoint = '', key = '', connected = false;
  const jobs = new Map(); let jobSerial = 0;
  let posting = 0; const postWaiters = [];
  async function acquirePost() {
    if (posting < 4) posting++; else await new Promise(resolve => postWaiters.push(resolve));
    return () => { const next = postWaiters.shift(); if (next) next(); else posting--; };
  }
  let workflow = null, bindings = null, count = 1, gallery = [], selectedImage = null;
  let toastTimer, resultsView = 'ready'; const selected = new Set();
  const activeJobs = () => [...jobs.values()].filter(j => !['complete', 'cancelled', 'error'].includes(j.state));
  function promptsNow() { return KreaUtils.splitPrompts($('prompt').value, $('batchPrompts').checked); }
  function updateBatchSummary() {
    const total = promptsNow().length;
    $('batchSummary').textContent = `${total} промптов × ${count} = ${total * count} заданий. Пустая строка — разделитель.`;
    $('generateNear').firstElementChild.textContent = total * count > 1 ? `В очередь: ${total * count} заданий` : 'Добавить в очередь';
  }
  const examples = {
    landscape: 'A peaceful mountain lake at sunrise, pine forest, soft golden light, morning mist, landscape photography, no people, no text.',
    portrait: 'Portrait of an adult woman in a linen shirt, soft window light, natural skin texture, subtle film grain, muted warm colors, editorial photography.',
    cinema: 'A quiet Tokyo street after rain, reflections of neon signs on the pavement, cinematic night photography, atmospheric lighting, wide composition.'
  };
  function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 4200); }
  function notice(message = '') { $('notice').textContent = message; $('notice').hidden = !message; }
  function cleanEndpoint(value) {
    const u = new URL(value.trim());
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname))) throw new Error('Нужен HTTPS-адрес шлюза.');
    if (u.username || u.password || u.search || u.hash || !['', '/'].includes(u.pathname)) throw new Error('Укажите только адрес шлюза, без пути, параметров и ключей в ссылке.');
    return u.origin;
  }
  async function request(path, { method = 'GET', body, binary = false, signal, url = endpoint, token = key } = {}) {
    const timeout = AbortSignal.timeout(25000);
    const options = { method, mode: 'cors', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', headers: { Authorization: `Bearer ${token}` }, signal: signal ? AbortSignal.any([signal, timeout]) : timeout };
    if (body !== undefined) { options.headers['Content-Type'] = 'application/json'; options.body = JSON.stringify(body); }
    let response;
    try { response = await fetch(url + path, options); }
    catch (error) { if (error.name === 'AbortError' && signal?.aborted) throw error; throw new Error('Шлюз недоступен. Проверьте, что под работает, а адрес и ключ относятся к нему.'); }
    if (!response.ok) {
      let message;
      try { message = (await response.json()).error; } catch (_) {}
      if (response.status === 401) throw new Error('Ключ доступа не подходит. Загрузите файл подключения от этого пода.');
      throw new Error(message || `Ошибка сервера (${response.status}).`);
    }
    return binary ? response.blob() : response.json();
  }
  function setConnection(value) {
    connected = value;
    $('connectionButton').className = 'connection-button ' + (value ? 'connected' : '');
    $('connectionLabel').textContent = value ? 'Под подключён' : 'Подключить под';
    $('disconnect').hidden = !value;
  }
  function promptCount() { $('promptCount').textContent = `${$('prompt').value.length.toLocaleString('ru-RU')} символов`; updateBatchSummary(); }
  function updateSize() {
    const w = Number($('width').value), h = Number($('height').value);
    $('sizeLabel').textContent = `${w} × ${h}`;
    document.querySelectorAll('[data-size]').forEach(button => { const match = button.dataset.size === `${w},${h}`; button.classList.toggle('selected', match); button.setAttribute('aria-pressed', String(match)); });
    $('sizeNote').textContent = w % 8 || h % 8 ? `Модель округлит latent до ${Math.floor(w / 8) * 8} × ${Math.floor(h / 8) * 8}.` : 'Размер кратен 8. Изменения в workflow могут влиять на итог.';
  }
  function bindingOf(id, field) { return { node: String(id), field }; }
  function resolveInput(graph, id, field, seen = new Set()) {
    const mark = `${id}.${field}`; if (seen.has(mark)) return null; seen.add(mark);
    const value = graph[id]?.inputs?.[field];
    if (!Array.isArray(value)) return value !== undefined ? bindingOf(id, field) : null;
    const node = graph[value[0]];
    if (!node) return null;
    for (const name of ['value', 'seed', 'noise_seed']) if (node.inputs[name] !== undefined && !Array.isArray(node.inputs[name])) return bindingOf(value[0], name);
    return null;
  }
  function detect(graph) {
    const entries = Object.entries(graph), texts = [], seeds = [];
    let size = null, sampler = null;
    for (const [id, node] of entries) {
      const title = `${node._meta?.title || ''} ${node.class_type}`;
      for (const field of ['value', 'text', 'prompt']) {
        if (typeof node.inputs[field] !== 'string') continue;
        if (!/String|TextEncode|TextGenerate|Prompt/i.test(node.class_type)) continue;
        const text = node.inputs[field];
        let score = /user.?prompt|positive|позитив|ваш промпт/i.test(title) ? 100 : 0;
        if (/TextEncode/.test(node.class_type)) score += 40;
        if (/PrimitiveString/.test(node.class_type)) score += 30;
        if (/system|negative|негатив|систем/i.test(title) || /Role:|CRITICAL RULES|EXAMPLE INPUT/.test(text)) score -= 150;
        texts.push({ node: id, field, title: `${node._meta?.title || node.class_type} · ${id}.${field}`, score });
      }
      if (!size && /Empty.*Latent|EmptyLatent/i.test(node.class_type) && Number.isFinite(node.inputs.width) && Number.isFinite(node.inputs.height)) size = { width: bindingOf(id, 'width'), height: bindingOf(id, 'height'), count: node.inputs.batch_size !== undefined ? bindingOf(id, 'batch_size') : null };
      if (/KSampler/.test(node.class_type)) { sampler ||= id; const b = resolveInput(graph, id, 'seed'); if (b) seeds.push(b); }
      if (/RandomNoise/.test(node.class_type)) { const b = resolveInput(graph, id, 'noise_seed'); if (b) seeds.push(b); }
    }
    if (!seeds.length) for (const [id, node] of entries) if (/^Seed/.test(node.class_type) && typeof node.inputs.seed === 'number') seeds.push(bindingOf(id, 'seed'));
    texts.sort((a, b) => b.score - a.score);
    return { prompt: texts[0] ? bindingOf(texts[0].node, texts[0].field) : null, prompts: texts, seeds: [...new Map(seeds.map(b => [`${b.node}.${b.field}`, b])).values()], ...size, sampler };
  }
  function validateWorkflow(value) {
    const graph = value?.prompt && !value.class_type ? value.prompt : value;
    if (!graph || Array.isArray(graph) || typeof graph !== 'object' || graph.nodes || graph.links) throw new Error('Нужен Export (API), а не обычный JSON workflow с нодами и связями.');
    const entries = Object.entries(graph);
    if (!entries.length || entries.length > 1200) throw new Error('API-workflow пустой или слишком большой.');
    for (const [id, n] of entries) {
      if (!n || typeof n.class_type !== 'string' || !n.inputs || Array.isArray(n.inputs) || typeof n.inputs !== 'object') throw new Error(`Неверный API-узел ${id}. Выберите файл Export (API).`);
      for (const v of Object.values(n.inputs)) if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && Number.isInteger(v[1]) && !graph[v[0]]) throw new Error(`Узел ${id} ссылается на отсутствующий узел ${v[0]}.`);
    }
    return graph;
  }
  async function loadWorkflow(value, name, isDefault = false) {
    const graph = validateWorkflow(value), found = detect(graph);
    if (!found.prompt) throw new Error('Не удалось найти текстовый промпт. Для этого API-workflow потребуется ручная настройка полей.');
    workflow = graph; bindings = found;
    $('workflowName').textContent = name;
    $('workflowSummary').textContent = `${Object.keys(graph).length} нод · ${found.seeds.length ? 'seed найден' : 'seed не найден'}`;
    $('promptBinding').replaceChildren();
    found.prompts.forEach(b => { const option = document.createElement('option'); option.value = JSON.stringify(bindingOf(b.node, b.field)); option.textContent = b.title; $('promptBinding').append(option); });
    $('mappingPanel').hidden = isDefault;
    if (!isDefault) { $('prompt').value = String(graph[found.prompt.node].inputs[found.prompt.field]).slice(0, 12000); promptCount(); }
    if (found.width) { $('width').value = graph[found.width.node].inputs[found.width.field]; $('height').value = graph[found.height.node].inputs[found.height.field]; }
    $('width').disabled = $('height').disabled = !found.width;
    $('countPlus').disabled = $('countMinus').disabled = false;
    count = 1; $('count').value = count;
    if (isDefault) { $('width').value = 1500; $('height').value = 1500; }
    if (found.sampler) { $('steps').value = graph[found.sampler].inputs.steps ?? 8; $('cfg').value = graph[found.sampler].inputs.cfg ?? 1; }
    $('steps').disabled = $('cfg').disabled = !found.sampler;
    updateSize(); notice();
    $('workflowCheck').textContent = found.width ? 'Параметры найдены автоматически. Исходный файл не изменяется.' : 'Узел размера не найден: размер будет взят из workflow.';
    if (connected) await inspectWorkflow();
  }
  async function inspectWorkflow() {
    try {
      const report = await request('/api/inspect', { method: 'POST', body: { workflow } });
      const errors = [...report.missing_nodes.map(s => `нет ноды ${s}`), ...report.missing_models.map(s => `нет модели ${s}`)];
      $('workflowCheck').textContent = errors.length ? errors.join('; ') : 'Все ноды и выбранные модели доступны на поде.';
      $('mappingPanel').hidden = false;
      if (errors.length) notice('Workflow требует установки: ' + errors.join('; '));
    } catch (error) { $('workflowCheck').textContent = error.message; }
  }
  async function connect(event) {
    event?.preventDefault(); $('connectError').hidden = true;
    const button = $('connectSubmit'); button.disabled = true; button.textContent = 'Проверяем подключение…';
    try {
      const url = cleanEndpoint($('endpoint').value), token = $('accessKey').value.trim();
      if (activeJobs().length && (url !== endpoint || token !== key)) throw new Error('Дождитесь завершения или отмените задания перед сменой пода.');
      if (token.length < 16) throw new Error('Укажите полный ключ доступа из файла подключения.');
      const info = await request('/api/health', { url, token });
      if (info.service !== 'krea-studio') throw new Error('Это не шлюз Krea Studio. Нужен адрес, выданный установщиком сайта.');
      endpoint = url; key = token; setConnection(true); $('connectDialog').close();
      if (workflow) await inspectWorkflow();
      toast('Подключено · ' + (info.gpu || 'ComfyUI готов'));
    } catch (error) { $('connectError').textContent = error.message; $('connectError').hidden = false; }
    finally { button.disabled = false; button.innerHTML = 'Подключиться <span>↗</span>'; }
  }
  function openConnect() { $('endpoint').value = endpoint || $('endpoint').value; $('accessKey').value = key || $('accessKey').value; $('connectError').hidden = true; $('connectDialog').showModal(); }
  function saveImage(item) {
    const extension = {'image/jpeg':'jpg','image/webp':'webp'}[item.blob.type] || 'png';
    const a = document.createElement('a'); a.href = item.url; a.download = `krea-${item.seed}-${item.index + 1}.${extension}`; document.body.append(a); a.click(); a.remove();
  }
  function selectionTools() {
    $('selectedCount').textContent = `Выбрано: ${selected.size}`;
    $('downloadSelected').disabled = selected.size === 0;
    $('selectAll').checked = gallery.length > 0 && selected.size === gallery.length;
    $('selectAll').indeterminate = selected.size > 0 && selected.size < gallery.length;
  }
  function resultView(view) {
    resultsView = view;
    for (const [id, value] of [['viewReady','ready'],['viewQueue','queue']]) { $(id).classList.toggle('selected', view === value); $(id).setAttribute('aria-pressed', String(view === value)); }
    $('jobQueue').hidden = view !== 'queue'; $('gallery').hidden = view !== 'ready';
    $('emptyState').hidden = view !== 'ready' || gallery.length > 0;
    $('galleryTools').hidden = view !== 'ready' || !gallery.length;
  }
  async function downloadGroup(all) {
    const items = all ? gallery : gallery.filter(item => selected.has(item.id));
    const button = $(all ? 'downloadAll' : 'downloadSelected'); button.disabled = true;
    try { const blob = await KreaUtils.zipImages(items); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `krea-${all ? 'all' : 'selected'}-${items.length}.zip`; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000); toast(`Архив: ${items.length} изображений`); }
    catch (error) { notice(error.message); }
    finally { button.disabled = false; selectionTools(); }
  }
  function openImage(item) { selectedImage = item; $('lightboxImage').src = item.url; $('lightboxInfo').textContent = `${item.width} × ${item.height} · seed ${item.seed}`; $('lightboxPrompt').textContent = item.prompt; $('lightbox').showModal(); }
  function renderGallery() {
    $('emptyState').hidden = gallery.length > 0; $('clearGallery').hidden = gallery.length === 0;
    $('resultCount').textContent = gallery.length ? `${gallery.length} ${gallery.length === 1 ? 'кадр' : gallery.length < 5 ? 'кадра' : 'кадров'} в этой сессии` : 'Здесь появится первая идея';
    $('gallery').replaceChildren();
    for (const item of [...gallery].reverse()) {
      const card = document.createElement('article'); card.className = 'image-card';
      const pick = document.createElement('label'); pick.className = 'image-select'; const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = selected.has(item.id); checkbox.setAttribute('aria-label', `Выбрать кадр ${item.id}`); const pickText = document.createElement('span'); pickText.textContent = 'Выбрать'; pick.append(checkbox, pickText); checkbox.onchange = () => { checkbox.checked ? selected.add(item.id) : selected.delete(item.id); selectionTools(); };
      const imageButton = document.createElement('button'); imageButton.className = 'image-button'; imageButton.setAttribute('aria-label', 'Увеличить изображение');
      const img = document.createElement('img'); img.src = item.url; img.alt = item.prompt; img.loading = 'lazy';
      const overlay = document.createElement('span'); overlay.className = 'image-overlay'; overlay.textContent = 'KREA 2 · ВАШ КАДР'; imageButton.append(img, overlay); imageButton.onclick = () => openImage(item);
      const info = document.createElement('div'); info.className = 'image-info';
      const text = document.createElement('p'); text.className = 'image-description'; text.textContent = item.prompt;
      const meta = document.createElement('div'); meta.className = 'image-meta';
      for (const value of [`${item.width} × ${item.height}`, '·', `${item.seconds} с`, '·', `seed ${item.seed}`]) { const span = document.createElement('span'); span.textContent = value; meta.append(span); }
      const actions = document.createElement('div'); actions.className = 'image-actions';
      for (const [label, action] of [['Скачать ↗', () => saveImage(item)], ['Повторить seed', () => { $('randomSeed').checked = false; $('seedField').hidden = false; $('seed').value = item.seed; $('prompt').value = item.prompt; promptCount(); toast('Промпт и seed восстановлены'); }], ['Удалить', () => { URL.revokeObjectURL(item.url); selected.delete(item.id); gallery = gallery.filter(x => x !== item); renderGallery(); }]]) { const button = document.createElement('button'); button.textContent = label; button.onclick = action; actions.append(button); }
      info.append(text, meta, actions); card.append(pick, imageButton, info); $('gallery').append(card);
    }
    selectionTools(); resultView(resultsView);
  }
  function refreshJobs() {
    const panel = $('generationProgress');
    const running = [...jobs.values()].filter(j => !['complete', 'cancelled', 'error'].includes(j.state));
    panel.hidden = running.length === 0;
    $('cancelJob').hidden = true;
    $('progressTitle').textContent = `Задания: ${running.length} в очереди / работе`;
    $('progressText').textContent = running.map(j => `#${j.localId}: ${j.state === 'queued' ? 'ожидает GPU' : j.state === 'submitting' ? 'отправляется' : 'генерируется'}`).join(' · ');
    $('elapsed').textContent = `${jobs.size} всего`;
    $('generate').disabled = false;
    $('generate').querySelector('span').textContent = 'Добавить в очередь';
    $('queueBadge').textContent = running.length; updateBatchSummary();
    const list = $('jobQueue'); list.replaceChildren();
    for (const j of [...jobs.values()].reverse()) {
      const line = document.createElement('div'); line.className = 'queue-item';
      const label = document.createElement('span');
      label.textContent = `#${j.localId} · ${j.prompt.slice(0, 55)} · ${j.state === 'complete' ? 'готово' : j.state === 'error' ? 'ошибка' : j.state === 'cancelled' ? 'отменено' : j.state === 'queued' ? 'в очереди' : 'в работе'}`;
      line.append(label);
      if (j.state === 'queued' || j.state === 'running' || j.state === 'submitting') {
        const cancel = document.createElement('button'); cancel.textContent = 'Отменить'; cancel.className = 'text-button';
        cancel.onclick = async () => {
          cancel.disabled = true;
          if (!j.id) { j.cancelled = true; cancel.textContent = 'После отправки…'; return; }
          try { const result = await request('/api/cancel', { method: 'POST', body: { id: j.id } }); if (!result.cancelled) { toast('Задание уже завершено; получаем результат'); return; } j.cancelled = true; j.controller.abort(); j.state = 'cancelled'; refreshJobs(); }
          catch (e) { toast(e.message); cancel.disabled = false; }
        };
        line.append(cancel);
      }
      if (j.state === 'error') { const error = document.createElement('small'); error.textContent = j.error; line.append(error); }
      list.append(line);
    }
    if (!jobs.size) { const empty = document.createElement('p'); empty.className = 'field-note'; empty.textContent = 'Заданий пока нет. Отправьте первый промпт.'; list.append(empty); }
    resultView(resultsView);
  }
  async function runJob(j, payload) {
    try {
      const release = await acquirePost(); let job;
      try { if (j.cancelled) { j.state = 'cancelled'; return; } job = await request('/api/generate', { method: 'POST', body: payload }); }
      finally { release(); }
      j.id = job.id; j.state = 'queued'; refreshJobs();
      if (j.cancelled) { const result = await request('/api/cancel', {method:'POST',body:{id:j.id}}); if (result.cancelled) { j.state = 'cancelled'; return; } j.cancelled = false; }
      while (!j.cancelled) {
        const state = await request(`/api/job/${encodeURIComponent(job.id)}`, { signal: j.controller.signal });
        if (state.state === 'error') throw new Error(state.error || 'Ошибка ComfyUI');
        if (state.state === 'cancelled') { j.state = 'cancelled'; break; }
        if (state.state === 'complete') {
          if (!state.images?.length) throw new Error('Задание завершено без изображений');
          for (const image of state.images) {
            const blob = await request(`/api/image?job=${encodeURIComponent(job.id)}&index=${image.index}`, { binary: true, signal: j.controller.signal });
            const bitmap = await createImageBitmap(blob);
            const width = bitmap.width, height = bitmap.height; bitmap.close();
            gallery.push({ id: `${j.localId}-${image.index}`, url: URL.createObjectURL(blob), blob, prompt: j.prompt, width, height, seed: state.seed, seconds: state.seconds, index: image.index });
          }
          renderGallery(); j.state = 'complete'; toast(`Задание #${j.localId} готово`); break;
        }
        j.state = state.state === 'queued' ? 'queued' : 'running'; refreshJobs();
        await new Promise(resolve => setTimeout(resolve, activeJobs().length > 10 ? 5000 : 1500));
      }
    } catch (e) {
      if (j.cancelled || e.name === 'AbortError') j.state = 'cancelled';
      else { j.state = 'error'; j.error = e.message; toast(`Ошибка задания #${j.localId}`); }
    } finally { refreshJobs(); }
  }
  async function generate() {
    notice();
    if (!connected) { openConnect(); return; }
    if (!workflow || !bindings) { notice('Загрузите API-workflow.'); return; }
    const prompt = $('prompt').value.trim(); if (!prompt) { $('prompt').focus(); notice('Опишите изображение перед запуском.'); return; }
    const width = Number($('width').value), height = Number($('height').value), steps = Number($('steps').value), cfg = Number($('cfg').value);
    if (bindings.width && (![width, height].every(n => Number.isInteger(n) && n >= 256 && n <= 2048))) { notice('Размер должен быть целым числом от 256 до 2048.'); return; }
    const seed = $('randomSeed').checked ? null : Number($('seed').value);
    if (seed !== null && (!/^\d+$/.test($('seed').value) || !Number.isSafeInteger(seed) || seed < 0 || seed > 1125899906842623)) { notice('Неверный seed.'); return; }
    if (bindings.sampler && (!(steps >= 1 && steps <= 50 && Number.isInteger(steps)) || !(cfg >= 1 && cfg <= 15))) { notice('Укажите от 1 до 50 шагов и CFG от 1 до 15.'); return; }
    const prompts = promptsNow(), total = prompts.length * count;
    if (prompts.some(text => text.length > 12000)) { notice('Каждый отдельный промпт должен быть не длиннее 12 000 символов.'); return; }
    if (prompts.length > 100 || activeJobs().length + total > 200) { notice('До 100 промптов за раз и до 200 незавершённых заданий. Уменьшите пакет или дождитесь части результатов.'); return; }
    if (seed !== null && seed + total - 1 > 1125899906842623) { notice('Seed слишком велик для этого пакета. Включите случайный seed.'); return; }
    const snapshot = structuredClone({workflow, bindings, width, height, count:1, steps, cfg});
    // One image per API request: each gets a distinct seed and its own queue entry.
    // ComfyUI schedules these jobs on the GPU; it does not run them simultaneously.
    for (let i = 0; i < total; i++) {
      const text = prompts[Math.floor(i / count)];
      const j = { localId: ++jobSerial, prompt:text, state: 'submitting', controller: new AbortController(), cancelled: false };
      jobs.set(j.localId, j);
      const chosenSeed = seed === null ? null : seed + i;
      const payload = { ...snapshot, prompt:text, seed: chosenSeed };
      void runJob(j, payload);
    }
    refreshJobs(); toast(`Добавлено заданий: ${total}. Можно отправлять ещё.`);
  }
  document.querySelectorAll('[data-open-connect]').forEach(b => b.addEventListener('click', openConnect));
  document.querySelector('[data-close-connect]').onclick = () => $('connectDialog').close();
  $('connectForm').onsubmit = connect;
  $('toggleKey').onclick = () => { const showing = $('accessKey').type === 'password'; $('accessKey').type = showing ? 'text' : 'password'; $('toggleKey').setAttribute('aria-label', showing ? 'Скрыть ключ' : 'Показать ключ'); };
  $('disconnect').onclick = () => { if ([...jobs.values()].some(j => !['complete', 'cancelled', 'error'].includes(j.state))) { notice('Сначала завершите или отмените задания.'); $('connectDialog').close(); return; } key = ''; endpoint = ''; $('accessKey').value = ''; $('endpoint').value = ''; setConnection(false); $('connectDialog').close(); toast('Ключ удалён из памяти вкладки'); };
  $('prompt').oninput = promptCount;
  $('prompt').onkeydown = e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); generate(); } };
  document.querySelectorAll('[data-example]').forEach(b => b.onclick = () => { $('prompt').value = examples[b.dataset.example]; promptCount(); $('prompt').focus(); });
  document.querySelectorAll('[data-size]').forEach(b => b.onclick = () => { if ($('width').disabled) return; const [w, h] = b.dataset.size.split(','); $('width').value = w; $('height').value = h; updateSize(); });
  $('width').oninput = $('height').oninput = updateSize;
  $('countMinus').onclick = () => { count = Math.max(1, count - 1); $('count').value = count; updateBatchSummary(); };
  $('countPlus').onclick = () => { count = Math.min(20, count + 1); $('count').value = count; updateBatchSummary(); };
  $('randomSeed').onchange = () => $('seedField').hidden = $('randomSeed').checked;
  $('generate').onclick = generate;
  $('generateNear').onclick = generate; $('batchPrompts').onchange = updateBatchSummary;
  $('importPrompts').onclick = () => $('promptsFile').click();
  $('promptsFile').onchange = async e => { const file = e.target.files[0]; if (!file) return; try { if (file.size > 2 * 1024 * 1024) throw new Error('Файл слишком большой (максимум 2 МБ).'); const text = await file.text(); if (text.length > 600000) throw new Error('В поле помещается до 600 000 символов.'); $('prompt').value = text; $('batchPrompts').checked = true; promptCount(); toast('Промпты загружены'); } catch (error) { notice(error.message); } e.target.value = ''; };
  $('viewReady').onclick = () => resultView('ready'); $('viewQueue').onclick = () => resultView('queue');
  $('selectAll').onchange = e => { selected.clear(); if (e.target.checked) gallery.forEach(item => selected.add(item.id)); renderGallery(); };
  $('downloadSelected').onclick = () => downloadGroup(false); $('downloadAll').onclick = () => downloadGroup(true);
  $('openGuide').onclick = () => $('guideDialog').showModal(); $('closeGuide').onclick = () => $('guideDialog').close();
  $('cancelJob').hidden = true;
  $('clearGallery').onclick = () => { gallery.forEach(i => URL.revokeObjectURL(i.url)); gallery = []; selected.clear(); renderGallery(); toast('Галерея вкладки очищена'); };
  $('closeLightbox').onclick = () => $('lightbox').close();
  $('lightboxDownload').onclick = () => selectedImage && saveImage(selectedImage);
  $('lightbox').addEventListener('close', () => { $('lightboxImage').removeAttribute('src'); selectedImage = null; });
  $('importWorkflow').onclick = () => $('workflowFile').click();
  $('pasteWorkflow').onclick = () => { $('jsonText').value = ''; $('jsonError').hidden = true; $('jsonDialog').showModal(); };
  $('closeJson').onclick = () => $('jsonDialog').close();
  $('applyJson').onclick = async () => {
    try { if ($('jsonText').value.length > 2 * 1024 * 1024) throw new Error('Максимальный размер — 2 МБ.'); await loadWorkflow(JSON.parse($('jsonText').value), 'Мой API-workflow'); $('jsonDialog').close(); $('jsonText').value = ''; toast('API-workflow загружен'); }
    catch (error) { $('jsonError').textContent = error.message; $('jsonError').hidden = false; }
  };
  $('workflowFile').onchange = async event => {
    const file = event.target.files[0]; if (!file) return;
    try { if (file.size > 2 * 1024 * 1024) throw new Error('Максимальный размер API-workflow — 2 МБ.'); await loadWorkflow(JSON.parse(await file.text()), file.name); toast('API-workflow загружен'); }
    catch (error) { notice(error.message.includes('JSON') ? 'Не удалось прочитать JSON. Проверьте файл Export (API).' : error.message); }
    event.target.value = '';
  };
  $('promptBinding').onchange = () => { bindings.prompt = JSON.parse($('promptBinding').value); const b = bindings.prompt; $('prompt').value = String(workflow[b.node].inputs[b.field]).slice(0, 12000); promptCount(); };
  $('importConnection').onclick = () => $('connectionFile').click();
  $('connectionFile').onchange = async event => {
    const file = event.target.files[0]; if (!file) return;
    try { if (file.size > 16384) throw new Error('Это не файл подключения.'); const data = JSON.parse(await file.text()); if (data.kind !== 'krea-studio-connection' || typeof data.key !== 'string') throw new Error('Нужен krea-connection.json из вашего пода.'); $('endpoint').value = cleanEndpoint(data.url); $('accessKey').value = data.key; await connect(); }
    catch (error) { $('connectError').textContent = error.message; $('connectError').hidden = false; }
    event.target.value = '';
  };
  // No analytics, browser storage, remote fonts, or persistent keys.
  fetch('workflow.json', { cache: 'no-store' }).then(r => { if (!r.ok) throw new Error(); return r.json(); }).then(data => loadWorkflow(data, 'Krea 2 · базовый workflow', true)).catch(() => notice('Загрузите API-workflow кнопкой «Загрузить API». Если сайт открыт как файл, запустите локальный сервер по инструкции.'));
  updateSize(); updateBatchSummary(); refreshJobs();
})();
