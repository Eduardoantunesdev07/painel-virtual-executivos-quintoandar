import { readFileSync } from 'node:fs';

const env = Object.fromEntries(readFileSync('.env', 'utf8').split(/\r?\n/)
  .map((line) => line.trim()).filter((line) => line && !line.startsWith('#') && line.includes('='))
  .map((line) => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1).trim().replace(/^(['"])(.*)\1$/, '$2')]; }));

const auth = await fetch(env.PIPEFY_OAUTH_TOKEN_URL, {
  method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'client_credentials', client_id: env.PIPEFY_CLIENT_ID, client_secret: env.PIPEFY_CLIENT_SECRET })
});
const { access_token } = await auth.json();
const query = `query SchemaFields {
  card: __type(name: "Card") { fields { name type { kind name ofType { kind name ofType { kind name } } } } }
  phase: __type(name: "Phase") { fields { name type { kind name ofType { kind name } } } }
  history: __type(name: "PhaseDetail") { fields { name type { kind name ofType { kind name } } } }
  createTableRecordInput: __type(name: "CreateTableRecordInput") { inputFields { name type { kind name ofType { kind name ofType { kind name } } } } }
  fieldValueInput: __type(name: "FieldValueInput") { inputFields { name type { kind name ofType { kind name } } } }
}`;
const response = await fetch('https://api.pipefy.com/graphql', {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${access_token}` }, body: JSON.stringify({ query })
});
const payload = await response.json();
if (payload.errors) throw new Error(payload.errors.map((error) => error.message).join('; '));
for (const [typeName, type] of Object.entries(payload.data)) {
  console.log(`\n[${typeName}]`);
  const fields = type?.fields || type?.inputFields;
  console.log(fields ? fields.map((field) => `${field.name}: ${JSON.stringify(field.type)}`).join('\n') : '(tipo não encontrado)');
}
