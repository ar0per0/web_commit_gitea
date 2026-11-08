import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSameOrigin } from '../src/origin.js';

test('acepta el mismo origen detrás de un proxy sin permitir otros sitios', () => {
  const check = (headers) => isSameOrigin({ headers: { host: 'localhost:8804', ...headers } });
  assert.equal(check({ origin: 'https://workspace.example.com', 'sec-fetch-site': 'same-origin' }), true);
  assert.equal(check({ origin: 'https://externo.example', 'sec-fetch-site': 'cross-site' }), false);
  assert.equal(check({ origin: 'https://otro.example.com', 'sec-fetch-site': 'same-site' }), false);
  assert.equal(check({ origin: 'https://externo.example' }), false);
  assert.equal(check({ origin: 'http://localhost:8804' }), true);
  assert.equal(check({ origin: 'null' }), false);
  assert.equal(check({}), true);
});
