import { randomBytes, scryptSync } from 'node:crypto';
import { createInterface } from 'node:readline';

const input = createInterface({ input:process.stdin, terminal:false });
input.once('line', password => {
  if (!password) throw new Error('Senha vazia.');
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  process.stdout.write(JSON.stringify({ salt, hash }));
  input.close();
});
