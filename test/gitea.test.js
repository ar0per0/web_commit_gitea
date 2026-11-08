import { test } from 'node:test';
import assert from 'node:assert/strict';
import { repositoryExists, createRepository } from '../src/gitea.js';

const config = { url: 'https://gitea.example.com/', user: 'tester', token: 'secret-test' };

test('consulta el repositorio y distingue ausente de errores de autenticación', async () => {
  assert.equal(await repositoryExists(config, 'mi proyecto', async (url, options) => {
    assert.equal(url.href, 'https://gitea.example.com/api/v1/repos/tester/mi%20proyecto');
    assert.equal(options.headers.Authorization, 'token secret-test');
    assert.equal(options.redirect, 'error');
    return new Response(null, { status: 404 });
  }), false);
  assert.equal(await repositoryExists(config, 'repo', async () => new Response(null, { status: 200 })), true);
  for (const status of [401, 403, 500]) {
    await assert.rejects(repositoryExists(config, 'repo', async () => new Response(null, { status })), /HTTP/);
  }
});

test('crea privado y vacío con el token solo tras comprobar ausencia e identidad', async () => {
  const calls = [];
  const result = await createRepository(config, 'mi_proyecto', async (url, options) => {
    calls.push(url.pathname);
    if (url.pathname.includes('/repos/tester/')) return new Response(null, { status: 404 });
    if (url.pathname.endsWith('/user')) return Response.json({ login: 'tester' });
    assert.equal(options.method, 'POST');
    assert.deepEqual(JSON.parse(options.body), { name: 'mi_proyecto', private: true, auto_init: false });
    assert.equal(options.headers.Authorization, 'token secret-test');
    return new Response(null, { status: 201 });
  });
  assert.equal(calls.length, 3);
  assert.match(result.message, /creado/);
});

test('no crea si ya existe ni si el token pertenece a otro usuario', async () => {
  let calls = 0;
  await createRepository(config, 'repo', async () => {
    calls++;
    return new Response(null, { status: 200 });
  });
  assert.equal(calls, 1);
  await assert.rejects(createRepository(config, 'repo', async (url) => {
    return url.pathname.endsWith('/user') ? Response.json({ login: 'otro' }) : new Response(null, { status: 404 });
  }), /no pertenece/);
});

test('errores de red no revelan el token y configuración inválida no hace peticiones', async () => {
  await assert.rejects(repositoryExists(config, 'repo', async () => { throw new Error(config.token); }), (error) => !error.message.includes(config.token));
  await assert.rejects(repositoryExists({ ...config, url: 'http://inseguro.test' }, 'repo', async () => assert.fail()), { status: 400 });
  await assert.rejects(createRepository(config, 'repo', async (url) => {
    return url.pathname.endsWith('/user') ? Response.json(null) : new Response(null, { status: 404 });
  }), { status: 400 });
});
