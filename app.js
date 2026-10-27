const state = { user: null, clients: [], executives: [], brokers: [], source: 'loading', search: '', status: 'all', executive: 'all', pipe: 'all', updatedAt: null };
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const today = new Date();

function normalize(value = '') { return String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase(); }
function daysSince(dateString) { return dateString ? Math.max(0, Math.floor((today - new Date(dateString)) / 86400000)) : 0; }
function getStatus(client) {
  if (client.status) return client.status;
  if (!client.standard) return 'ok';
  const ratio = daysSince(client.entry) / client.standard;
  return ratio > 1 ? 'late' : ratio >= .75 ? 'attention' : 'ok';
}
function statusLabel(status) { return { ok: 'Dentro do prazo', attention: 'Atenção', late: 'Prazo excedido' }[status]; }
function formatDate(value) { return value ? new Intl.DateTimeFormat('pt-BR').format(new Date(value)) : 'Não informado'; }
function allowedClients() { return state.user.role === 'manager' ? state.clients : state.clients.filter(c => normalize(c.executive) === normalize(state.user.name)); }
function escapeHtml(value = '') { const node = document.createElement('div'); node.textContent = String(value); return node.innerHTML; }

async function loadPipefyData() {
  if (location.protocol === 'file:') return;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await fetch('/api/clients', { headers: { accept: 'application/json' }, cache:'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      state.clients = payload.clients;
      state.executives = payload.executives || [];
      state.brokers = payload.brokers || [];
      state.updatedAt = payload.updatedAt;
      state.source = 'pipefy';
      return;
    } catch (error) {
      console.error(`Não foi possível carregar o Pipefy (tentativa ${attempt}):`, error);
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 900));
    }
  }
  state.clients = [];
  state.source = 'error';
}

async function loadDirectory() {
  const response = await fetch('/api/directory', { headers:{ accept:'application/json' }, cache:'no-store' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = await response.json();
  state.executives = payload.executives || [];
  state.brokers = payload.brokers || [];
  populateExecutives();
}

async function login(user) {
  state.user = user;
  $('#loginScreen').classList.add('hidden');
  $('#appShell').classList.remove('hidden');
  $('#sidebarName').textContent = user.name;
  $('#sidebarRole').textContent = user.role === 'manager' ? 'Gestor RTx' : 'Executivo QuintoAndar';
  $('#sidebarAvatar').textContent = user.initials;
  $('#roleBadge').textContent = user.role === 'manager' ? 'Visão de gestor' : 'Visão de executivo';
  $('#welcomeTitle').textContent = `Olá, ${user.name.split(' ')[0]}.`;
  $$('.manager-only').forEach(el => el.style.display = user.role === 'manager' ? '' : 'none');
  $('#executiveFilter').parentElement.classList.toggle('hidden', user.role !== 'manager');
  render();
  await loadPipefyData();
  populateExecutives();
  render();
}

function populateExecutives() {
  const names = [...new Set([...state.clients.map(c => c.executive), ...state.executives.map(item => item.name)].filter(Boolean))].sort();
  $('#executiveFilter').innerHTML = '<option value="all">Todos os executivos</option>' + names.map(name => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join('');
}

function filteredClients() {
  const term = normalize(state.search);
  return allowedClients().filter(client => {
    const matchText = !term || [client.name, client.phase, client.executive, client.broker, client.rtxResponsible].some(v => normalize(v).includes(term));
    return matchText && (state.status === 'all' || getStatus(client) === state.status) && (state.executive === 'all' || client.executive === state.executive) && (state.pipe === 'all' || client.pipeId === state.pipe);
  });
}

function render() {
  const all = allowedClients().filter(client => state.pipe === 'all' || client.pipeId === state.pipe);
  const rows = filteredClients();
  const totals = { ok: 0, attention: 0, late: 0 };
  all.forEach(client => totals[getStatus(client)]++);
  $('#metricActive').textContent = all.length;
  $('#metricOnTime').textContent = totals.ok;
  $('#metricAttention').textContent = totals.attention;
  $('#metricLate').textContent = totals.late;
  $('#metricOnTimePercent').textContent = `${all.length ? Math.round(totals.ok / all.length * 100) : 0}% da carteira`;
  const selectedPipe = state.pipe === '306812867' ? 'Painel Aprovação' : state.pipe === '306826870' ? 'Painel Processos' : null;
  $('#portfolioTitle').textContent = selectedPipe || (state.user?.role === 'manager' ? 'Carteira de todos os executivos' : 'Seus clientes');
  $('#portfolioSubtitle').textContent = state.source === 'pipefy' ? 'Dados reais sincronizados com o Pipefy.' : state.source === 'loading' ? 'Conectando ao Pipefy…' : 'Conexão indisponível. Use o botão para tentar novamente.';
  $('#retryDataButton').classList.toggle('hidden', state.source !== 'error');
  $('#clientsTableBody').innerHTML = rows.map(client => {
    const status = getStatus(client); const days = client.daysInPhase ?? daysSince(client.entry);
    return `<tr><td><strong>${escapeHtml(client.name)}</strong><small>${escapeHtml(client.pipeName || '')}</small></td><td class="manager-only" style="display:${state.user.role === 'manager' ? '' : 'none'}">${escapeHtml(client.executive || 'Não vinculado')}</td><td>${escapeHtml(client.broker || 'Não informado')}</td><td><span class="phase">${escapeHtml(client.phase)}</span></td><td>${formatDate(client.entry)}</td><td><span class="days-number">${days}</span> dias</td><td>${client.standard ? `${client.standard} dias` : 'Não configurado'}</td><td><span class="status-pill status-${status}">${statusLabel(status)}</span></td><td><button class="view-button" data-client-id="${escapeHtml(client.id)}">Ver detalhes</button></td></tr>`;
  }).join('');
  $('#emptyState').classList.toggle('hidden', rows.length > 0);
  $('.table-wrap').classList.toggle('hidden', rows.length === 0);
  $('#resultCount').textContent = `${rows.length} ${rows.length === 1 ? 'cliente' : 'clientes'}`;
  $('#dataSourceLabel').textContent = state.source === 'pipefy' ? `Pipefy · Atualizado ${state.updatedAt ? new Intl.DateTimeFormat('pt-BR', { dateStyle:'short', timeStyle:'short' }).format(new Date(state.updatedAt)) : 'agora'}` : 'Pipefy desconectado';
  $$('.view-button').forEach(button => button.addEventListener('click', () => openClient(button.dataset.clientId)));
}

async function retryPipefyData() {
  const button = $('#retryDataButton');
  button.disabled = true;
  button.textContent = 'Reconectando…';
  await loadPipefyData();
  populateExecutives();
  render();
  button.disabled = false;
  button.textContent = 'Reconectar ao Pipefy';
}

function openClient(id) {
  const client = allowedClients().find(c => String(c.id) === String(id)); if (!client) return;
  $('#dialogClientName').textContent = client.name;
  $('#dialogExecutive').innerHTML = `Executivo QuintoAndar: <strong>${escapeHtml(client.executive || 'Não vinculado')}</strong> · Corretor: <strong>${escapeHtml(client.broker || 'Não informado')}</strong>${client.rtxResponsible ? `<br>Responsável RTx: <strong>${escapeHtml(client.rtxResponsible)}</strong>` : ''}<br>${client.daysInPhase ?? daysSince(client.entry)} dias na fase atual${contactLinks(client)}`;
  const history = client.history?.length ? client.history : [client.phase];
  $('#dialogTimeline').innerHTML = history.map((step,index) => `<div class="timeline-item ${index === history.length - 1 ? 'current' : ''}"><span class="timeline-dot"></span><div class="timeline-copy"><strong>${escapeHtml(step)}</strong><span>${index === history.length - 1 ? `Fase atual · desde ${formatDate(client.entry)}` : 'Etapa anterior'}</span></div></div>`).join('');
  $('#clientDialog').showModal();
}

function contactLinks(client) {
  const contacts = [
    client.executiveContact && { label:'Executivo', ...client.executiveContact },
    client.brokerContact && { label:'Corretor', ...client.brokerContact }
  ].filter(Boolean);
  if (!contacts.length) return '';
  return `<span class="process-contacts">${contacts.map(contact => `<span><b>${contact.label}:</b> ${contact.email ? `<a href="mailto:${escapeHtml(contact.email)}">${escapeHtml(contact.email)}</a>` : ''}${contact.phone ? ` <a href="tel:${escapeHtml(contact.phone)}">${escapeHtml(contact.phone)}</a>` : ''}</span>`).join('')}</span>`;
}

function renderDirectory(term = '') {
  const query = normalize(term);
  const contacts = [
    ...state.executives.map(item => ({ ...item, role:'Executivo' })),
    ...state.brokers.map(item => ({ ...item, role:'Corretor' }))
  ].filter(item => !query || normalize(`${item.name} ${item.email} ${item.phone} ${item.executive}`).includes(query));
  $('#directoryList').innerHTML = contacts.length ? contacts.map(item => {
    const activeClients = item.role === 'Executivo'
      ? state.clients.filter(client => normalize(client.executive) === normalize(item.name)).length
      : state.clients.filter(client => normalize(client.broker) === normalize(item.name)).length;
    return `<article class="contact-card"><span>${escapeHtml(item.role)}</span><strong>${escapeHtml(item.name)}</strong>${item.role === 'Corretor' ? `<small class="contact-team">Equipe: ${escapeHtml(item.executive || 'Executivo não vinculado')}</small>` : ''}<small class="contact-active">${activeClients} ${activeClients === 1 ? 'cliente ativo' : 'clientes ativos'}</small>${item.email ? `<a href="mailto:${escapeHtml(item.email)}">${escapeHtml(item.email)}</a>` : '<small>E-mail não informado</small>'}${item.phone ? `<a href="tel:${escapeHtml(item.phone)}">${escapeHtml(item.phone)}</a>` : '<small>Telefone não informado</small>'}</article>`;
  }).join('') : '<div class="directory-empty">Nenhum contato encontrado.</div>';
}

async function openDirectory() {
  if (!$('#teamDialog').open) $('#teamDialog').showModal();
  $('#directoryList').innerHTML = '<div class="directory-empty">Carregando contatos do Pipefy…</div>';
  try {
    if (!state.executives.length && !state.brokers.length) await loadDirectory();
    renderDirectory($('#directorySearch').value);
  } catch (error) {
    console.error('Não foi possível carregar o diretório:', error);
    $('#directoryList').innerHTML = '<div class="directory-empty"><strong>Não foi possível conectar ao Pipefy.</strong><span>Verifique se o servidor local está aberto e tente novamente.</span><button class="view-button" id="directoryRetry" type="button">Tentar novamente</button></div>';
    $('#directoryRetry').addEventListener('click', openDirectory);
  }
  $('#directorySearch').focus();
}

function closeExecutiveDialog() {
  $('#executiveDialog').close();
  $('#executiveFormMessage').textContent = '';
  $('#executiveFormMessage').className = 'form-message';
}

async function createExecutive(event) {
  event.preventDefault();
  if (state.user?.role !== 'manager') return;
  const submit = $('#executiveSubmitButton');
  const message = $('#executiveFormMessage');
  const formData = new FormData(event.currentTarget);
  submit.disabled = true;
  submit.textContent = 'Salvando…';
  message.textContent = '';
  message.className = 'form-message';
  try {
    const response = await fetch('/api/executives', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(Object.fromEntries(formData))
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'Não foi possível cadastrar o executivo.');
    message.textContent = `${payload.executive.name} foi cadastrado com sucesso.`;
    message.classList.add('success');
    event.currentTarget.reset();
  } catch (error) {
    message.textContent = error.message;
    message.classList.add('error');
  } finally {
    submit.disabled = false;
    submit.innerHTML = 'Salvar no Pipefy <span>→</span>';
  }
}

$('#dateLabel').textContent = new Intl.DateTimeFormat('pt-BR', { weekday:'long', day:'2-digit', month:'long', year:'numeric' }).format(today);
$('#loginForm').addEventListener('submit', async event => {
  event.preventDefault();
  const submit = event.currentTarget.querySelector('button[type="submit"]');
  submit.disabled = true;
  $('#loginError').textContent = '';
  try {
    const response = await fetch('/api/auth/login', { method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({ username:$('#username').value.trim(), password:$('#password').value }) });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'Não foi possível entrar.');
    $('#password').value = '';
    await login(payload.user);
  } catch (error) { $('#loginError').textContent = error instanceof TypeError ? 'O servidor do painel está desligado. Inicie o Painel RTx no VS Code e tente novamente.' : error.message; }
  finally { submit.disabled = false; }
});
$$('[data-pipe]').forEach(button => button.addEventListener('click', () => { state.pipe = button.dataset.pipe; $$('.nav-item').forEach(item => item.classList.toggle('active', item === button)); $('#sidebar').classList.remove('open'); render(); }));
$('#togglePassword').addEventListener('click', () => { const visible = $('#password').type === 'text'; $('#password').type = visible ? 'password' : 'text'; $('#togglePassword').textContent = visible ? 'Mostrar' : 'Ocultar'; });
$('#globalSearch').addEventListener('input', event => { state.search = event.target.value; render(); });
$('#statusFilter').addEventListener('change', event => { state.status = event.target.value; render(); });
$('#executiveFilter').addEventListener('change', event => { state.executive = event.target.value; render(); });
$('#dialogClose').addEventListener('click', () => $('#clientDialog').close());
$('#newExecutiveButton').addEventListener('click', () => {
  if (state.user?.role !== 'manager') return;
  $('#sidebar').classList.remove('open');
  $('#executiveDialog').showModal();
  $('#executiveName').focus();
});
$('#executiveDialogClose').addEventListener('click', closeExecutiveDialog);
$('#executiveCancelButton').addEventListener('click', closeExecutiveDialog);
$('#executiveForm').addEventListener('submit', createExecutive);
$('#teamDirectoryButton').addEventListener('click', openDirectory);
$('#teamDialogClose').addEventListener('click', () => $('#teamDialog').close());
$('#directorySearch').addEventListener('input', event => renderDirectory(event.target.value));
$('#retryDataButton').addEventListener('click', retryPipefyData);
$('#menuButton').addEventListener('click', () => $('#sidebar').classList.toggle('open'));
$('#logoutButton').addEventListener('click', async () => { await fetch('/api/auth/logout', { method:'POST' }).catch(() => {}); state.user = null; state.clients = []; state.executives = []; state.brokers = []; state.source = 'loading'; state.search = ''; state.status = 'all'; state.executive = 'all'; state.pipe = 'all'; $('#appShell').classList.add('hidden'); $('#loginScreen').classList.remove('hidden'); $('#username').value = ''; $('#password').value = ''; });

async function restoreSession() {
  try {
    const response = await fetch('/api/auth/me', { cache:'no-store' });
    if (response.ok) await login((await response.json()).user);
  } catch (error) { console.error('Não foi possível restaurar a sessão:', error); }
}
restoreSession();
