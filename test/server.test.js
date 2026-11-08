import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createServer } from '../src/server.js';

async function start(t, dataPath, options = {}) {
  const server = createServer({ dataPath, ...options });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test('configuración y listado remoto desactivado no consultan Gitea', async (t) => {
  const url = await start(t, './data', {
    showGiteaProjects: false,
    giteaFetch: async () => assert.fail('No debe consultar Gitea'),
  });
  assert.deepEqual(await (await fetch(`${url}/api/config`)).json(), { showGiteaProjects: false });
  assert.equal((await fetch(`${url}/api/gitea/projects`)).status, 404);
  assert.equal((await fetch(`${url}/api/gitea/clone?repository=org/repo`, {
    method: 'POST', headers: { 'X-Requested-With': 'GiteaWorkspace' },
  })).status, 404);
});

test('protege el clonado frente a métodos, orígenes y rutas inválidos', async (t) => {
  const url = await start(t, './data');
  const endpoint = `${url}/api/gitea/clone?repository=org/..`;
  assert.equal((await fetch(endpoint)).status, 405);
  assert.equal((await fetch(endpoint, { method: 'POST' })).status, 403);
  assert.equal((await fetch(endpoint, {
    method: 'POST', headers: { 'X-Requested-With': 'GiteaWorkspace', Origin: 'https://otro.test' },
  })).status, 403);
  assert.equal((await fetch(endpoint, {
    method: 'POST', headers: { 'X-Requested-With': 'GiteaWorkspace' },
  })).status, 400);
});

test('sirve el listado remoto y rechaza métodos de escritura', async (t) => {
  let calls = 0;
  const url = await start(t, './data', {
    gitea: { url: 'https://gitea.example.com/', user: 'tester', token: 'secret' },
    giteaFetch: async () => {
      calls++;
      return Response.json([{ name: 'remoto', owner: { login: 'org' } }], { headers: { 'x-total-count': '1' } });
    },
  });
  assert.deepEqual(await (await fetch(`${url}/api/config`)).json(), { showGiteaProjects: true });
  assert.equal(calls, 0);
  const page = await (await fetch(url)).text();
  assert.match(page, /<details id="gitea-projects" class="panel" hidden>/);
  assert.deepEqual(await (await fetch(`${url}/api/gitea/projects`)).json(), {
    projects: [{ name: 'org/remoto', url: 'https://gitea.example.com/org/remoto' }],
  });
  assert.equal(calls, 1);
  assert.equal((await fetch(`${url}/api/gitea/projects`, { method: 'POST' })).status, 405);
});

test('oculta repositorios con el mismo nombre que una carpeta local de cualquier propietario', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'gitea-web-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, 'existente'));
  await writeFile(path.join(directory, 'pendiente'), 'no es carpeta');
  const url = await start(t, directory, {
    gitea: { url: 'https://gitea.example.com/', user: 'tester', token: 'secret' },
    giteaFetch: async () => Response.json([
      { name: 'existente', owner: { login: 'tester' } },
      { name: 'existente', owner: { login: 'org' } },
      { name: 'pendiente', owner: { login: 'org' } },
    ], { headers: { 'x-total-count': '3' } }),
  });
  assert.deepEqual((await (await fetch(`${url}/api/gitea/projects`)).json()).projects, [
    { name: 'org/pendiente', url: 'https://gitea.example.com/org/pendiente' },
  ]);
  await rm(path.join(directory, 'pendiente'));
  await mkdir(path.join(directory, 'pendiente'));
  assert.deepEqual((await (await fetch(`${url}/api/gitea/projects`)).json()).projects, []);
});

test('muestra solo directorios del primer nivel, ordenados, y permite actualizar', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'gitea-web-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, 'Beta', 'anidada'), { recursive: true });
  await mkdir(path.join(directory, 'Alfa'));
  await writeFile(path.join(directory, 'archivo.txt'), 'no es carpeta');
  await symlink(path.join(directory, 'Alfa'), path.join(directory, 'enlace'));
  const url = await start(t, directory);
  const response = await fetch(`${url}/api/folders`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { path: directory, folders: [{ name: 'Alfa' }, { name: 'Beta' }] });
  await mkdir(path.join(directory, 'Nueva'));
  assert.equal((await (await fetch(`${url}/api/folders`)).json()).folders.length, 3);
});

test('directorio vacío y ruta inexistente', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'gitea-web-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const url = await start(t, directory);
  assert.deepEqual((await (await fetch(`${url}/api/folders`)).json()).folders, []);
  const missingUrl = await start(t, path.join(directory, 'no-existe'));
  const response = await fetch(`${missingUrl}/api/folders`);
  assert.equal(response.status, 404);
  assert.match((await response.json()).error, /no existe/);
});

test('sirve la web y limita rutas y métodos', async (t) => {
  const url = await start(t, './data');
  for (const asset of ['/', '/styles.css', '/app.js']) {
    assert.equal((await fetch(`${url}${asset}`)).status, 200);
  }
  assert.equal((await fetch(`${url}/.env`)).status, 404);
  for (const route of ['/constructor', '/toString', '/__proto__']) {
    assert.equal((await fetch(`${url}${route}`)).status, 404);
  }
  const page = await fetch(url);
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal((await fetch(`${url}/api/folders`, { method: 'POST' })).status, 405);
  assert.equal((await fetch(`${url}/api/folder/init?name=prueba`, { method: 'POST' })).status, 403);
  assert.equal((await fetch(`${url}/api/folder/init?name=prueba`, {
    method: 'POST', headers: { 'X-Requested-With': 'GiteaWorkspace', Origin: 'https://externo.example' },
  })).status, 403);
  assert.equal((await fetch(`${url}/api/folder?name=..`)).status, 400);
});

test('valida objetos JSON y el tamaño del cuerpo y libera el bloqueo tras errores', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'gitea-json-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, 'proyecto'));
  const url = await start(t, directory);
  const endpoint = `${url}/api/folder/commit?name=proyecto`;
  const post = (body) => fetch(endpoint, {
    method: 'POST', headers: { 'X-Requested-With': 'GiteaWorkspace' }, body,
  });
  for (const body of ['null', '[]', '123', '"texto"']) {
    assert.equal((await post(body)).status, 400);
  }
  assert.equal((await post(JSON.stringify({ message: 'á'.repeat(11000) }))).status, 413);
  assert.equal((await post('{}')).status, 409);
});

test('el enlace Gitea redirige a la URL configurada y rechaza destinos inválidos', async (t) => {
  const url = await start(t, './data', { gitea: { url: 'https://gitea.example.com/mi-gitea/', user: 'aropero' } });
  const response = await fetch(`${url}/gitea`, { redirect: 'manual' });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), 'https://gitea.example.com/mi-gitea/');
  const project = await fetch(`${url}/gitea?name=prova11`, { redirect: 'manual' });
  assert.equal(project.status, 302);
  assert.equal(project.headers.get('location'), 'https://gitea.example.com/mi-gitea/aropero/prova11');
  for (const destination of [undefined, 'javascript:alert(1)', 'https://user:secret@gitea.example.com/']) {
    const invalid = await start(t, './data', { gitea: { url: destination } });
    assert.equal((await fetch(`${invalid}/gitea`, { redirect: 'manual' })).status, 503);
  }
});

test('consulta Gitea aunque exista .git local, sea directorio o archivo', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'gitea-web-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, 'con-git', '.git'), { recursive: true });
  await mkdir(path.join(directory, 'con-archivo-git'));
  await writeFile(path.join(directory, 'con-archivo-git', '.git'), 'gitdir: otro');
  await mkdir(path.join(directory, 'sin-git'));
  let requests = 0;
  const url = await start(t, directory, {
    gitea: { url: 'https://gitea.example.com/', user: 'tester', token: 'test' },
    giteaFetch: async () => {
      requests++;
      return new Response(null, { status: 404 });
    },
  });
  for (const name of ['con-git', 'con-archivo-git']) {
    const response = await fetch(`${url}/api/folder?name=${name}`);
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.hasGit, true);
    assert.equal(data.giteaRequired, true);
    assert.equal(data.remoteExists, false);
  }
  assert.equal(requests, 2);
  const data = await (await fetch(`${url}/api/folder?name=sin-git`)).json();
  assert.equal(data.hasGit, false);
  assert.equal(data.remoteExists, false);
  assert.equal(requests, 3);
});

test('permite desactivar el requisito de Gitea sin omitir su consulta', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'gitea-optional-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, 'proyecto', '.git'), { recursive: true });
  for (const status of [200, 404, 500]) {
    let requests = 0;
    const url = await start(t, directory, {
      giteaRequired: false,
      gitea: { url: 'https://gitea.example.com/', user: 'tester', token: 'test' },
      giteaFetch: async () => {
        requests++;
        return new Response(null, { status });
      },
    });
    const response = await fetch(`${url}/api/folder?name=proyecto`);
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.hasGit, true);
    assert.equal(data.giteaRequired, false);
    assert.equal(data.remoteExists, status === 500 ? null : status === 200);
    assert.equal(requests, 1);
  }
});
test('protege las operaciones de ramas y valida sus peticiones', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'gitea-branches-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, 'proyecto'));
  const url = await start(t, directory);
  const endpoint = `${url}/api/folder/branch?name=proyecto`;
  assert.equal((await fetch(endpoint, { method: 'POST' })).status, 403);
  assert.equal((await fetch(endpoint)).status, 405);
  assert.equal((await fetch(endpoint, {
    method: 'POST', headers: { 'X-Requested-With': 'GiteaWorkspace' }, body: '{',
  })).status, 400);
  assert.equal((await fetch(endpoint, {
    method: 'POST', headers: { 'X-Requested-With': 'GiteaWorkspace' },
    body: JSON.stringify({ action: 'delete', branch: 'main' }),
  })).status, 400);
  assert.equal((await fetch(`${url}/api/folder/branches?name=proyecto`)).status, 409);
  const tagEndpoint = `${url}/api/folder/tag?name=proyecto`;
  const dockerEndpoint = `${url}/api/folder/docker?name=proyecto`;
  assert.equal((await fetch(dockerEndpoint)).status, 405);
  assert.equal((await fetch(dockerEndpoint, { method: 'POST' })).status, 403);
  assert.equal((await fetch(dockerEndpoint, {
    method: 'POST', headers: { 'X-Requested-With': 'GiteaWorkspace', Origin: 'https://otro.example.com' }, body: '{}',
  })).status, 403);
  const invalidDocker = await fetch(dockerEndpoint, {
    method: 'POST', headers: { 'X-Requested-With': 'GiteaWorkspace' }, body: '{}',
  });
  assert.match(invalidDocker.headers.get('content-type'), /ndjson/);
  assert.match((await invalidDocker.json()).error, /Versión Docker/);
  assert.equal((await fetch(`${url}/api/folder/tags?name=proyecto`)).status, 409);
  assert.equal((await fetch(tagEndpoint)).status, 405);
  assert.equal((await fetch(tagEndpoint, { method: 'POST' })).status, 403);
  assert.equal((await fetch(tagEndpoint, {
    method: 'POST', headers: { 'X-Requested-With': 'GiteaWorkspace', Origin: 'https://otro.example.com' }, body: '{}',
  })).status, 403);
  for (const body of ['{', '{}', '{"tag":"-f"}']) {
    assert.equal((await fetch(tagEndpoint, {
      method: 'POST', headers: { 'X-Requested-With': 'GiteaWorkspace' }, body,
    })).status, 400);
  }
});
