import { test } from 'node:test';
import assert from 'node:assert/strict';
import { logError } from '../src/log.js';

test('registra detalles de Git y sus causas sin credenciales', (t) => {
  const lines = [];
  t.mock.method(console, 'error', (line) => lines.push(line));
  const cause = Object.assign(new Error('git push falló'), {
    code: 128, cmd: 'git push origin main', stdout: 'salida',
    stderr: 'fatal: denied https://user:private-password@example.com/repo token=hidden-token known-secret',
  });
  logError(new Error('Ha fallado git push', { cause }), { project: 'proyecto' }, ['known-secret']);
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.error.cause.code, 128);
  assert.equal(entry.error.cause.command, 'git push origin main');
  assert.equal(entry.error.cause.stdout, 'salida');
  assert.match(entry.error.cause.stderr, /fatal: denied/);
  assert.doesNotMatch(lines[0], /private-password|hidden-token|known-secret/);
});
