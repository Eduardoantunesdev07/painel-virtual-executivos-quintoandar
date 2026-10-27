import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const ROOT = resolve('.');
const PIPEFY_API = 'https://api.pipefy.com/graphql';
const CACHE_TTL = 5 * 60 * 1000;
const MIME = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.png':'image/png', '.svg':'image/svg+xml' };

function parseEnv(source) {
  return Object.fromEntries(source.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#') && line.includes('='))
    .map(line => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1).trim().replace(/^(['"])(.*)\1$/, '$2')]; }));
}
async function localEnv(fileName) {
  try { return parseEnv(await readFile(join(ROOT, fileName), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
}
const env = { ...await localEnv('.env'), ...await localEnv('.env.local'), ...process.env };
const PORT = Number(env.PORT || 4173);
const HOST = env.HOST || (env.RENDER ? '0.0.0.0' : '127.0.0.1');
const EXECUTIVE_PASSWORD_SALT = env.EXECUTIVE_PASSWORD_SALT;
const EXECUTIVE_PASSWORD_HASH = env.EXECUTIVE_PASSWORD_HASH;
let oauth = { token: null, expiresAt: 0 };
let cache = { clients: null, updatedAt: null, expiresAt: 0 };
let directoryCache = { executives: null, brokers: null, expiresAt: 0 };
const sessions = new Map();
const loginAttempts = new Map();
const SESSION_TTL = 8 * 60 * 60 * 1000;

function adminUser() {
  const name = env.ADMIN_USERNAME || 'Gestor RTx';
  return { username:name, name, role:'manager', initials:name.split(/\s+/).slice(0, 2).map(part => part[0]).join('').toUpperCase() };
}

function executiveUser(executive) {
  return {
    username:executive.email,
    email:executive.email,
    name:executive.name,
    role:'executive',
    initials:executive.name.split(/\s+/).slice(0, 2).map(part => part[0]).join('').toUpperCase()
  };
}

function cookieValue(req, name) {
  const item = String(req.headers.cookie || '').split(';').map(value => value.trim()).find(value => value.startsWith(`${name}=`));
  return item ? decodeURIComponent(item.slice(name.length + 1)) : '';
}

function clientKey(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.socket.remoteAddress || 'local';
}

function sessionCookie(req, token, maxAge) {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').toLocaleLowerCase('en-US');
  const secure = env.NODE_ENV === 'production' || forwardedProto === 'https';
  return `rtx_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

function authenticatedUser(req) {
  const token = cookieValue(req, 'rtx_session');
  const session = sessions.get(token);
  if (!session || session.expiresAt <= Date.now()) { if (token) sessions.delete(token); return null; }
  session.expiresAt = Date.now() + SESSION_TTL;
  return session.user;
}

function requireUser(req, res) {
  const user = authenticatedUser(req);
  if (!user) json(res, 401, { error:'Faça login para acessar o painel.' });
  return user;
}

function passwordMatches(password, salt, hash) {
  if (typeof password !== 'string' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'hex');
  if (!expected.length) return false;
  const received = scryptSync(password, salt, expected.length);
  return expected.length === received.length && timingSafeEqual(expected, received);
}

function normalizeIdentity(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLocaleLowerCase('pt-BR');
}

function loginBlocked(req) {
  const key = clientKey(req);
  const current = loginAttempts.get(key);
  if (!current || current.resetAt <= Date.now()) { loginAttempts.delete(key); return false; }
  return current.count >= 5;
}

function registerFailedLogin(req) {
  const key = clientKey(req);
  const current = loginAttempts.get(key);
  loginAttempts.set(key, !current || current.resetAt <= Date.now() ? { count:1, resetAt:Date.now() + 15 * 60 * 1000 } : { ...current, count:current.count + 1 });
}

async function getToken() {
  if (oauth.token && Date.now() < oauth.expiresAt - 60000) return oauth.token;
  const response = await fetch(env.PIPEFY_OAUTH_TOKEN_URL, {
    method:'POST', headers:{ 'content-type':'application/x-www-form-urlencoded', accept:'application/json' },
    body:new URLSearchParams({ grant_type:'client_credentials', client_id:env.PIPEFY_CLIENT_ID, client_secret:env.PIPEFY_CLIENT_SECRET })
  });
  if (!response.ok) throw new Error(`Falha OAuth Pipefy (${response.status})`);
  const payload = await response.json();
  oauth = { token: payload.access_token, expiresAt: Date.now() + Number(payload.expires_in || 300) * 1000 };
  return oauth.token;
}

async function graphql(query, variables) {
  const response = await fetch(PIPEFY_API, { method:'POST', headers:{ 'content-type':'application/json', authorization:`Bearer ${await getToken()}` }, body:JSON.stringify({ query, variables }) });
  const payload = await response.json();
  if (!response.ok || payload.errors?.length) throw new Error(payload.errors?.map(e => e.message).join('; ') || `Pipefy HTTP ${response.status}`);
  return payload.data;
}

const CREATE_EXECUTIVE_MUTATION = `mutation CreateExecutive($input: CreateTableRecordInput!) {
  createTableRecord(input: $input) { table_record { id title } }
}`;

function cleanText(value, maxLength) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, maxLength) : '';
}

function normalizePhone(value) {
  const raw = cleanText(value, 24);
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 15) return null;
  return `+${digits.startsWith('55') ? digits : `55${digits}`}`;
}

async function readJson(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16 * 1024) throw new Error('PAYLOAD_TOO_LARGE');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('INVALID_JSON'); }
}

async function createExecutive(input) {
  const name = cleanText(input.name, 120);
  const email = cleanText(input.email, 160).toLowerCase();
  const phone = normalizePhone(input.phone);
  if (name.length < 3) throw new Error('Informe o nome completo do executivo.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Informe um e-mail válido.');
  if (!phone) throw new Error('Informe um telefone válido com DDD.');
  const data = await graphql(CREATE_EXECUTIVE_MUTATION, { input: {
    table_id: env.PIPEFY_DATABASE_EXECUTIVOS_ID,
    title: name,
    fields_attributes: [
      { field_id:'executivo_negocia_o', field_value:name },
      { field_id:'e_mail_executivo', field_value:email },
      { field_id:'telefone_executivo', field_value:phone }
    ]
  } });
  return { id:data.createTableRecord.table_record.id, name, email, phone };
}

const PIPE_PHASES_QUERY = `query PipePhases($pipeId: ID!) {
  pipe(id: $pipeId) { phases { id name done } }
}`;

const PHASE_CARDS_QUERY = `query PhaseCards($phaseId: ID!, $after: String) {
  phase(id: $phaseId) { cards(first: 50, after: $after) {
    edges { node {
      id title done late started_current_phase_at current_phase_age
      current_phase { id name done lateness_time }
      pipe { id name }
      fields { name value }
      phases_history { firstTimeIn lastTimeIn phase { id name } }
    } }
    pageInfo { hasNextPage endCursor }
  } }
}`;

const TABLE_RECORDS_QUERY = `query Directory($tableId: ID!, $after: String) {
  table_records(table_id: $tableId, first: 50, after: $after) {
    edges { node { id title record_fields { name value } } }
    pageInfo { hasNextPage endCursor }
  }
}`;

function directoryField(record, wanted) {
  return record.record_fields.find(field => wanted.some(name => field.name?.toLocaleLowerCase('pt-BR').includes(name)))?.value?.trim() || '';
}

async function getDirectory() {
  if (directoryCache.executives && Date.now() < directoryCache.expiresAt) return directoryCache;
  const records = []; let after = null;
  do {
    const data = await graphql(TABLE_RECORDS_QUERY, { tableId:env.PIPEFY_DATABASE_EXECUTIVOS_ID, after });
    records.push(...data.table_records.edges.map(edge => edge.node));
    after = data.table_records.pageInfo.hasNextPage ? data.table_records.pageInfo.endCursor : null;
  } while (after);
  const executivesByName = new Map(); const brokersByName = new Map();
  for (const record of records) {
    const executive = directoryField(record, ['executivo negocia']);
    const broker = directoryField(record, ['corretor de imóveis', 'corretor de imoveis']);
    if (executive) {
      const key = normalizeIdentity(executive);
      const current = executivesByName.get(key) || {};
      executivesByName.set(key, {
        name:current.name || executive,
        phone:current.phone || directoryField(record, ['telefone executivo']),
        email:current.email || directoryField(record, ['e-mail executivo'])
      });
    }
    if (broker) {
      const key = normalizeIdentity(broker);
      const current = brokersByName.get(key) || {};
      brokersByName.set(key, {
        name:current.name || broker,
        phone:current.phone || directoryField(record, ['telefone corretor']),
        email:current.email || directoryField(record, ['e-mail corretor']),
        executive:current.executive || executive
      });
    }
  }
  directoryCache = { executives:[...executivesByName.values()].sort((a,b) => a.name.localeCompare(b.name, 'pt-BR')), brokers:[...brokersByName.values()].sort((a,b) => a.name.localeCompare(b.name, 'pt-BR')), expiresAt:Date.now() + CACHE_TTL };
  return directoryCache;
}

async function fetchPhaseCards(phaseId) {
  const cards = []; let after = null;
  do {
    const data = await graphql(PHASE_CARDS_QUERY, { phaseId, after });
    cards.push(...data.phase.cards.edges.map(edge => edge.node));
    after = data.phase.cards.pageInfo.hasNextPage ? data.phase.cards.pageInfo.endCursor : null;
  } while (after);
  return cards;
}

async function fetchPipeCards(pipeId) {
  const data = await graphql(PIPE_PHASES_QUERY, { pipeId });
  const activePhases = data.pipe.phases.filter(phase => !phase.done);
  return (await Promise.all(activePhases.map(phase => fetchPhaseCards(phase.id)))).flat();
}

function fieldValue(card, wanted) {
  const field = card.fields.find(item => wanted.some(name => item.name?.toLocaleLowerCase('pt-BR').includes(name)));
  return field?.value?.trim() || '';
}
function connectorValue(value) {
  if (!value) return '';
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter(Boolean).join(', ') : String(parsed || '');
  } catch { return value; }
}
function standardDays(phase) {
  if (phase?.lateness_time) return Math.ceil(phase.lateness_time / 86400);
  const match = phase?.name?.match(/\((\d+)\s*D?\)/i);
  return match ? Number(match[1]) : null;
}
function mapCard(card) {
  const standard = standardDays(card.current_phase);
  const phaseStartedAt = card.started_current_phase_at ? new Date(card.started_current_phase_at) : null;
  const daysInPhase = phaseStartedAt && !Number.isNaN(phaseStartedAt.valueOf())
    ? Math.max(0, Math.floor((Date.now() - phaseStartedAt.valueOf()) / 86400000))
    : Math.max(0, Math.floor(Number(card.current_phase_age || 0) / 86400));
  const ratio = standard ? daysInPhase / standard : 0;
  const status = card.late || ratio > 1 ? 'late' : ratio >= .75 ? 'attention' : 'ok';
  const broker = connectorValue(fieldValue(card, ['corretor']));
  return {
    id: card.id, name: card.title, document: '', pipeId: String(card.pipe.id), pipeName: card.pipe.name,
    executive: '', rtxResponsible:fieldValue(card, ['responsável', 'responsavel']), broker, phase: card.current_phase.name,
    entry: card.started_current_phase_at, daysInPhase, standard, status,
    history: [...card.phases_history].sort((a,b) => new Date(a.firstTimeIn || a.lastTimeIn) - new Date(b.firstTimeIn || b.lastTimeIn)).map(item => item.phase.name)
  };
}

async function getClients() {
  if (cache.clients && Date.now() < cache.expiresAt) return cache;
  const pipeIds = [env.PIPEFY_PIPE_APROVACAO_ID, env.PIPEFY_PIPE_PROCESSOS_ID];
  const cards = (await Promise.all(pipeIds.map(fetchPipeCards))).flat();
  const directory = await getDirectory();
  const executiveContacts = new Map(directory.executives.map(item => [normalizeIdentity(item.name), item]));
  const brokerContacts = new Map(directory.brokers.map(item => [normalizeIdentity(item.name), item]));
  const contactFor = (map, name) => map.get(normalizeIdentity(name)) || null;
  const clients = cards.filter(card => !card.done && !card.current_phase.done).map(mapCard).map(client => {
    const brokerContact = contactFor(brokerContacts, client.broker);
    const executive = brokerContact?.executive || '';
    return { ...client, executive, executiveContact:contactFor(executiveContacts, executive), brokerContact };
  });
  cache = { clients, executives:directory.executives, brokers:directory.brokers, updatedAt:new Date().toISOString(), expiresAt:Date.now() + CACHE_TTL };
  return cache;
}

function json(res, status, payload) { res.writeHead(status, { 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store' }); res.end(JSON.stringify(payload)); }

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'same-origin');
    res.setHeader('x-frame-options', 'DENY');
    if (url.pathname === '/api/health') {
      if (req.method !== 'GET') return json(res, 405, { error:'Método não permitido.' });
      return json(res, 200, { ok:true });
    }
    if (url.pathname === '/api/auth/login') {
      if (req.method !== 'POST') return json(res, 405, { error:'Método não permitido.' });
      if (loginBlocked(req)) return json(res, 429, { error:'Muitas tentativas. Aguarde 15 minutos.' });
      const input = await readJson(req);
      const username = cleanText(input.username, 160);
      const isManager = normalizeIdentity(username) === normalizeIdentity(env.ADMIN_USERNAME)
        && passwordMatches(input.password, env.ADMIN_PASSWORD_SALT, env.ADMIN_PASSWORD_HASH);
      let user = isManager ? adminUser() : null;
      if (!user && passwordMatches(input.password, EXECUTIVE_PASSWORD_SALT, EXECUTIVE_PASSWORD_HASH)) {
        const directory = await getDirectory();
        const executive = directory.executives.find(item => normalizeIdentity(item.email) === normalizeIdentity(username));
        if (executive) user = executiveUser(executive);
      }
      if (!user) { registerFailedLogin(req); return json(res, 401, { error:'Usuário ou senha inválidos.' }); }
      loginAttempts.delete(clientKey(req));
      const token = randomBytes(32).toString('hex');
      sessions.set(token, { user, expiresAt:Date.now() + SESSION_TTL });
      res.setHeader('set-cookie', sessionCookie(req, token, SESSION_TTL / 1000));
      return json(res, 200, { user });
    }
    if (url.pathname === '/api/auth/me') {
      if (req.method !== 'GET') return json(res, 405, { error:'Método não permitido.' });
      const user = authenticatedUser(req);
      return user ? json(res, 200, { user }) : json(res, 401, { error:'Sessão não encontrada.' });
    }
    if (url.pathname === '/api/auth/logout') {
      if (req.method !== 'POST') return json(res, 405, { error:'Método não permitido.' });
      sessions.delete(cookieValue(req, 'rtx_session'));
      res.setHeader('set-cookie', sessionCookie(req, '', 0));
      return json(res, 200, { ok:true });
    }
    if (url.pathname === '/api/clients') {
      if (req.method !== 'GET') return json(res, 405, { error:'Método não permitido.' });
      const user = requireUser(req, res); if (!user) return;
      const { clients, executives, brokers, updatedAt } = await getClients();
      if (user.role === 'manager') return json(res, 200, { clients, executives, brokers, updatedAt });
      const scopedClients = clients.filter(client => normalizeIdentity(client.executive) === normalizeIdentity(user.name));
      const brokerNames = new Set(scopedClients.map(client => normalizeIdentity(client.broker)).filter(Boolean));
      return json(res, 200, {
        clients:scopedClients,
        executives:executives.filter(item => normalizeIdentity(item.name) === normalizeIdentity(user.name)),
        brokers:brokers.filter(item => brokerNames.has(normalizeIdentity(item.name))),
        updatedAt
      });
    }
    if (url.pathname === '/api/directory') {
      if (req.method !== 'GET') return json(res, 405, { error:'Método não permitido.' });
      const user = requireUser(req, res); if (!user) return;
      if (user.role !== 'manager') return json(res, 403, { error:'Apenas o gestor pode acessar o diretório completo.' });
      const { executives, brokers } = await getDirectory();
      return json(res, 200, { executives, brokers });
    }
    if (url.pathname === '/api/executives') {
      if (req.method !== 'POST') return json(res, 405, { error:'Método não permitido.' });
      const user = requireUser(req, res); if (!user) return;
      if (user.role !== 'manager') return json(res, 403, { error:'Apenas o gestor pode cadastrar executivos.' });
      try {
        const executive = await createExecutive(await readJson(req));
        directoryCache.expiresAt = 0;
        cache.expiresAt = 0;
        return json(res, 201, { executive });
      }
      catch (error) {
        if (error.message === 'INVALID_JSON' || error.message === 'PAYLOAD_TOO_LARGE') return json(res, 400, { error:'Dados do formulário inválidos.' });
        if (['Informe o nome completo do executivo.', 'Informe um e-mail válido.', 'Informe um telefone válido com DDD.'].includes(error.message)) return json(res, 400, { error:error.message });
        throw error;
      }
    }
    const relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
    const file = normalize(join(ROOT, relative));
    if (!file.startsWith(ROOT) || !(await stat(file)).isFile()) return json(res, 404, { error:'Não encontrado' });
    res.writeHead(200, { 'content-type':MIME[extname(file)] || 'application/octet-stream', 'cache-control':['.html','.js','.css'].includes(extname(file)) ? 'no-store' : 'public, max-age=3600' });
    res.end(await readFile(file));
  } catch (error) {
    console.error(error.message);
    json(res, 500, { error:'Não foi possível consultar o Pipefy.' });
  }
});

server.listen(PORT, HOST, () => console.log(`Painel RTx disponível em http://${HOST}:${PORT}`));
