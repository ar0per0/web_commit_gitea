import { test } from 'node:test';
import assert from 'node:assert/strict';
import { repositoryExists, createRepository, listRepositories } from '../src/gitea.js';

const config = { url: 'https://gitea.example.com/', user: 'tester', token: 'secret-test' };

test('lista todas las páginas y ordena repositorios de usuarios y organizaciones', async () => {
  const pages = [];
  const repos = await listRepositories({ ...config, url: 'https://gitea.example.com/sub/' }, async (url, options) => {
    assert.equal(url.pathname, '/sub/api/v1/user/repos');
    assert.equal(options.headers.Authorization, 'token secret-test');
    assert.equal(url.searchParams.get('limit'), '50');
    const page = Number(url.searchParams.get('page'));
    pages.push(page);
    // Una instancia puede limitar las páginas a menos de los 50 solicitados.
    return Response.json(page === 1 ? [{ name: 'zeta', owner: { login: 'tester' } }]
      : page === 2 ? [{ name: 'alfa', owner: { login: 'organizacion' } }] : []);
  });
  assert.deepEqual(pages, [1, 2, 3]);
  assert.deepEqual(repos, [
    { name: 'organizacion/alfa', url: 'https://gitea.example.com/sub/organizacion/alfa' },
    { name: 'tester/zeta', url: 'https://gitea.example.com/sub/tester/zeta' },
  ]);
});

test('listado vacío, fin por total y errores de Gitea', async () => {
  assert.deepEqual(await listRepositories(config, async () => Response.json([])), []);
  let calls = 0;
  assert.equal((await listRepositories(config, async () => {
    calls++;
    return Response.json([{ name: 'repo', owner: { login: 'tester' } }], { headers: { 'x-total-count': '1' } });
  })).length, 1);
  assert.equal(calls, 1);
  for (const status of [401, 403, 404, 500]) {
    await assert.rejects(listRepositories(config, async () => new Response(null, { status })), { status: 502 });
  }
  for (const body of [null, {}, [{ name: 'sin-owner' }]]) {
    await assert.rejects(listRepositories(config, async () => Response.json(body)), { status: 502 });
  }
});

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

test('conserva el diagnóstico HTTP de creación sin revelar el token', async () => {
  await assert.rejects(createRepository(config, 'repo', async (url) => {
    if (url.pathname.includes('/repos/tester/')) return new Response(null, { status: 404 });
    if (url.pathname.endsWith('/user')) return Response.json({ login: 'tester' });
    return Response.json({ message: `insufficient scope ${config.token}` }, {
      status: 403, headers: { 'x-request-id': 'request-123' },
    });
  }), (error) => {
    assert.equal(error.details.method, 'POST');
    assert.equal(error.details.url, 'https://gitea.example.com/api/v1/user/repos');
    assert.equal(error.details.status, 403);
    assert.equal(error.details.requestId, 'request-123');
    assert.match(error.details.body, /insufficient scope/);
    assert.doesNotMatch(JSON.stringify(error), /secret-test/);
    return true;
  });
});
