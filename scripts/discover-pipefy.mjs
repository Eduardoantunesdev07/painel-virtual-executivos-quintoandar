import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function loadEnv(file) {
  return Object.fromEntries(
    readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#') && line.includes('='))
      .map((line) => {
        const index = line.indexOf('=');
        const key = line.slice(0, index).trim();
        const value = line.slice(index + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
        return [key, value];
      })
  );
}

const env = loadEnv(resolve('.env'));
const required = ['PIPEFY_CLIENT_ID', 'PIPEFY_CLIENT_SECRET', 'PIPEFY_OAUTH_TOKEN_URL'];
const missing = required.filter((key) => !env[key]);
if (missing.length) throw new Error(`Preencha no .env: ${missing.join(', ')}`);

const tokenResponse = await fetch(env.PIPEFY_OAUTH_TOKEN_URL, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
  body: new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: env.PIPEFY_CLIENT_ID,
    client_secret: env.PIPEFY_CLIENT_SECRET
  })
});

if (!tokenResponse.ok) {
  throw new Error(`Falha na autenticação OAuth (${tokenResponse.status}). Confira URL, Client ID e Client secret.`);
}

const tokenPayload = await tokenResponse.json();
const accessToken = tokenPayload.access_token;
if (!accessToken) throw new Error('O Pipefy não retornou access_token.');

const query = `
  query DiscoverResources {
    organizations {
      id
      name
      pipes { id name cards_count }
      tables { edges { node { id name } } }
    }
  }
`;

const apiResponse = await fetch('https://api.pipefy.com/graphql', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    authorization: `Bearer ${accessToken}`
  },
  body: JSON.stringify({ query })
});

if (!apiResponse.ok) throw new Error(`Falha na API GraphQL (${apiResponse.status}).`);
const payload = await apiResponse.json();
if (payload.errors?.length) throw new Error(payload.errors.map((error) => error.message).join('; '));

const result = payload.data.organizations.map((organization) => ({
  organization: { id: organization.id, name: organization.name },
  pipes: organization.pipes.map(({ id, name, cards_count }) => ({ id, name, cards: cards_count })),
  databases: organization.tables.edges.map(({ node }) => ({ id: node.id, name: node.name }))
}));

console.log(JSON.stringify(result, null, 2));
