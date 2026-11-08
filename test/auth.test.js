import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from '../src/server.js';
import { createAuth } from '../src/auth.js';

test('protege web y API y recuerda el acceso con una cookie de 30 días', async (t) => {
  const server = createServer({ password: '1234', gitea: { url: 'https://gitea.example.com/' } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const loginPage = await (await fetch(url)).text();
  assert.match(loginPage, /type="password"/);
  assert.match(loginPage, /<title>Commit Gitea<\/title>/);
  assert.match(loginPage, /rel="icon" type="image\/svg\+xml" sizes="any" href="\/favicon.svg\?v=4"/);
  const favicon = await fetch(`${url}/favicon.svg`);
  assert.equal(favicon.status, 200);
  assert.equal(favicon.headers.get('content-type'), 'image/svg+xml');
  assert.match(await favicon.text(), /<svg[^>]+viewBox=/);
  assert.match(loginPage, /class="auth-icon"/);
  assert.match(loginPage, /aria-label="Iniciar sesión"/);
  assert.doesNotMatch(loginPage, /Workspace|workspace|auth-eyebrow/);
  assert.doesNotMatch(loginPage, /TU ESPACIO DE TRABAJO|Todo listo para empezar|Introduce tu contraseña|30 días|Tus proyectos, en un solo lugar|Accede a tus proyectos/);
  assert.match(loginPage, /<a class="brand-icon" href="\/gitea" target="_blank" rel="noopener noreferrer"/);
  const giteaLink = await fetch(`${url}/gitea`, { redirect: 'manual' });
  assert.equal(giteaLink.status, 302);
  assert.equal(giteaLink.headers.get('location'), 'https://gitea.example.com/');
  for (const route of ['/api/folders', '/api/folder?name=demo', '/app.js']) {
    const response = await fetch(`${url}${route}`, { redirect: 'manual' });
    if (route.startsWith('/api/')) assert.equal(response.status, 401);
    else assert.match(await response.text(), /type="password"/);
  }
  const login = (password, headers = {}) => fetch(`${url}/login`, {
    method: 'POST', body: new URLSearchParams({ password }), headers, redirect: 'manual',
  });
  assert.equal((await login('incorrecta')).status, 401);
  assert.equal((await login('1234', { Origin: 'https://externo.example' })).status, 403);
  assert.equal((await login('1234', { Origin: 'https://externo.example', 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await login('1234', { Origin: 'https://workspace.example.com', 'Sec-Fetch-Site': 'same-origin' })).status, 303);
  const html = await (await fetch(url)).text();
  const csrf = html.match(/name="csrf" value="([^"]+)"/)[1];
  const proxyLogin = await fetch(`${url}/login`, {
    method: 'POST', headers: { Origin: 'https://public.example.com' },
    body: new URLSearchParams({ password: '1234', csrf }), redirect: 'manual',
  });
  assert.equal(proxyLogin.status, 303);
  const forgedLogin = await fetch(`${url}/login`, {
    method: 'POST', headers: { Origin: 'https://public.example.com' },
    body: new URLSearchParams({ password: '1234', csrf: `${csrf}bad` }), redirect: 'manual',
  });
  assert.equal(forgedLogin.status, 403);
  const response = await login('1234', { 'X-Forwarded-Proto': 'https' });
  assert.equal(response.status, 303);
  const cookie = response.headers.get('set-cookie');
  assert.match(cookie, /Max-Age=2592000/);
  assert.match(cookie, /HttpOnly; SameSite=Strict; Secure/);
  assert.ok(!cookie.includes('1234'));
  const headers = { Cookie: cookie.split(';')[0] };
  const homePage = await (await fetch(url, { headers })).text();
  assert.match(homePage, /Tus proyectos/);
  assert.match(homePage, /rel="icon" type="image\/svg\+xml" sizes="any" href="\/favicon.svg\?v=4"/);
  assert.match(homePage, /<\/a> Commit Gitea<\/div>/);
  assert.match(homePage, /<a class="brand-icon" href="\/gitea" target="_blank" rel="noopener noreferrer"/);
  assert.doesNotMatch(homePage, /Workspace/);
  assert.equal((await fetch(`${url}/api/folders`, { headers })).status, 200);
  assert.equal((await fetch(`${url}/api/folders`, { headers: { Cookie: `${headers.Cookie}bad` } })).status, 401);
  for (const suffix of ['.extra', '.', '.extra.more']) {
    assert.equal((await fetch(`${url}/api/folders`, { headers: { Cookie: `${headers.Cookie}${suffix}` } })).status, 401);
  }
  assert.equal((await fetch(`${url}/logout`, { method: 'POST', headers })).status, 403);
  const closed = await fetch(`${url}/logout`, { method: 'POST', headers: { ...headers, 'X-Requested-With': 'GiteaWorkspace' } });
  assert.equal(closed.status, 204);
  assert.match(closed.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await fetch(`${url}/api/folders`, { headers })).status, 401);
  assert.equal((await fetch(`${url}/api/folders`, { headers: { Cookie: `${headers.Cookie}.extra` } })).status, 401);
});

test('caduca a los 30 días e invalida sesiones al recrear autenticación', async () => {
  let time = 1_000_000;
  const authenticate = createAuth('1234', { now: () => time });
  const response = () => ({ headers: {}, setHeader(key, value) { this.headers[key] = value; },
    writeHead(status, headers) { this.statusCode = status; Object.assign(this.headers, headers); }, end() {} });
  const request = { headers: {}, socket: {}, method: 'POST', async *[Symbol.asyncIterator]() { yield Buffer.from('password=1234'); } };
  const login = response();
  await authenticate(request, login, '/login');
  request.method = 'GET';
  request.headers.cookie = login.headers['Set-Cookie'].split(';')[0];
  time += 30 * 24 * 60 * 60 * 1000 - 1;
  assert.equal(await authenticate(request, response(), '/api/folders'), false);
  assert.equal(await createAuth('1234', { now: () => time })(request, response(), '/api/folders'), true);
  time++;
  const expired = response();
  assert.equal(await authenticate(request, expired, '/api/folders'), true);
  assert.equal(expired.statusCode, 401);
  assert.throws(() => createAuth(''), /WEB_PASSWORD/);
});

test('limita los intentos de contraseña', async () => {
  const authenticate = createAuth('1234');
  for (let i = 0; i < 11; i++) {
    const request = { headers: {}, socket: {}, method: 'POST', async *[Symbol.asyncIterator]() { yield Buffer.from('password=no'); } };
    const response = { setHeader() {}, end() {} };
    await authenticate(request, response, '/login');
    assert.equal(response.statusCode, i < 10 ? 401 : 429);
  }
});
