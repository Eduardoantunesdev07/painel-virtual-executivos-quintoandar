import { readFileSync } from 'node:fs';

const env = Object.fromEntries(readFileSync('.env', 'utf8').split(/\r?\n/)
  .map(line => line.trim()).filter(line => line && !line.startsWith('#') && line.includes('='))
  .map(line => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1).trim().replace(/^(['"])(.*)\1$/, '$2')]; }));

const auth = await fetch(env.PIPEFY_OAUTH_TOKEN_URL, {
  method:'POST', headers:{ 'content-type':'application/x-www-form-urlencoded' },
  body:new URLSearchParams({ grant_type:'client_credentials', client_id:env.PIPEFY_CLIENT_ID, client_secret:env.PIPEFY_CLIENT_SECRET })
});
const { access_token } = await auth.json();
const query = `query Executives($tableId: ID!, $after: String) {
  table_records(table_id: $tableId, first: 50, after: $after) {
    edges { node { id title record_fields { name value } } }
    pageInfo { hasNextPage endCursor }
  }
}`;
let after = null; const records = [];
do {
  const response = await fetch('https://api.pipefy.com/graphql', {
    method:'POST', headers:{ 'content-type':'application/json', authorization:`Bearer ${access_token}` },
    body:JSON.stringify({ query, variables:{ tableId:env.PIPEFY_DATABASE_EXECUTIVOS_ID, after } })
  });
  const payload = await response.json();
  if (payload.errors) throw new Error(payload.errors.map(error => error.message).join('; '));
  records.push(...payload.data.table_records.edges.map(edge => edge.node));
  after = payload.data.table_records.pageInfo.hasNextPage ? payload.data.table_records.pageInfo.endCursor : null;
} while (after);

const wanted = /exequiel|leonardo|cristiano\s+crusius/i;
console.log(JSON.stringify({ total:records.length, matches:records.filter(record => wanted.test(`${record.title} ${record.record_fields.map(field => field.value).join(' ')}`)) }, null, 2));
