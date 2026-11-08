import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { isSameOrigin } from './origin.js';

const lifetime = 30 * 24 * 60 * 60;
const cookieName = 'workspace_session';

export function createAuth(password, { now = Date.now } = {}) {
  if (typeof password !== 'string' || !password) throw new Error('Configura WEB_PASSWORD en .env antes de iniciar el servidor.');
  const key = randomBytes(32);
  const expected = createHash('sha256').update(password).digest();
  const sign = (value) => createHmac('sha256', key).update(value).digest('hex');
  let attempts = 0;
  let resetAt = 0;
  const revoked = new Map();
  const sessionExpiry = (token) => {
    if (typeof token !== 'string' || !/^\d+\.[a-f0-9]{64}$/.test(token)) return null;
    const [expires, signature] = token.split('.');
    return Number(expires) > now()
      && timingSafeEqual(Buffer.from(signature), Buffer.from(sign(expires))) ? Number(expires) : null;
  };

  return async (request, response, pathname) => {
    const secure = request.socket.encrypted || request.headers['x-forwarded-proto'] === 'https';
    const cookieOptions = `Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
    const token = request.headers.cookie?.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
    for (const [session, expires] of revoked) {
      if (expires <= now()) revoked.delete(session);
    }
    if (pathname === '/logout' && request.method === 'POST') {
      if (request.headers['x-requested-with'] !== 'GiteaWorkspace' || ['cross-site', 'same-site'].includes(request.headers['sec-fetch-site'])) {
        response.writeHead(403);
        response.end('Origen no permitido.');
        return true;
      }
      const expires = sessionExpiry(token);
      if (expires !== null) revoked.set(token, expires);
      response.writeHead(204, { 'Set-Cookie': `${cookieName}=; Max-Age=0; ${cookieOptions}` });
      response.end();
      return true;
    }
    if (sessionExpiry(token) !== null && !revoked.has(token)) return false;

    const page = (message = '') => {
      const csrfValue = `${now() + 60 * 60 * 1000}:${randomBytes(16).toString('hex')}`;
      const csrf = `${csrfValue}.${sign(`login:${csrfValue}`)}`;
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(`<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="light dark">
    <title>Commit Gitea</title>
    <link rel="icon" type="image/svg+xml" sizes="any" href="/favicon.svg?v=4">
    <link rel="stylesheet" href="/styles.css">
  </head>
  <body class="auth-page">
    <main class="auth-layout">
      <div class="brand auth-brand"><a class="brand-icon" href="/gitea" target="_blank" rel="noopener noreferrer" aria-label="Abrir Gitea">↗</a> Commit Gitea</div>
      <section class="auth-card" aria-label="Iniciar sesión">
        <div class="auth-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="10" width="14" height="11" rx="3"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/></svg></div>
        <form class="auth-form" method="post" action="/login">
          <input type="hidden" name="csrf" value="${csrf}">
          <label for="password">Contraseña</label>
          <input id="password" name="password" type="password" placeholder="Tu contraseña de acceso" autocomplete="current-password" required autofocus${message ? ' aria-invalid="true" aria-describedby="auth-error"' : ''}>
          ${message ? `<p class="auth-error" id="auth-error" role="alert">${message}</p>` : ''}
          <button class="auth-submit" type="submit">Entrar <span aria-hidden="true">→</span></button>
        </form>
      </section>
    </main>
  </body>
</html>`);
    };
    if (['/styles.css', '/favicon.svg', '/gitea'].includes(pathname) && request.method === 'GET') return false;
    if (pathname === '/login' && request.method === 'POST') {
      if (now() >= resetAt) { attempts = 0; resetAt = now() + 60_000; }
      if (++attempts > 10) {
        response.statusCode = 429;
        response.setHeader('Retry-After', String(Math.ceil((resetAt - now()) / 1000)));
        page('Demasiados intentos. Espera un minuto.');
        return true;
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 8192) {
          response.writeHead(413);
          response.end('Petición demasiado grande.');
          return true;
        }
        chunks.push(chunk);
      }
      const payload = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
      const [csrfValue = '', csrfSignature = ''] = (payload.get('csrf') || '').split('.');
      const csrfExpected = sign(`login:${csrfValue}`);
      const validCsrf = /^\d+:[a-f0-9]{32}$/.test(csrfValue) && Number(csrfValue.split(':')[0]) > now()
        && /^[a-f0-9]{64}$/.test(csrfSignature)
        && timingSafeEqual(Buffer.from(csrfSignature), Buffer.from(csrfExpected));
      if (!isSameOrigin(request) && !validCsrf) {
        response.statusCode = 403;
        page('El formulario ha caducado. Vuelve a introducir la contraseña.');
        return true;
      }
      const supplied = payload.get('password') || '';
      if (timingSafeEqual(createHash('sha256').update(supplied).digest(), expected)) {
        const expires = String(now() + lifetime * 1000);
        response.writeHead(303, { Location: '/', 'Set-Cookie': `${cookieName}=${expires}.${sign(expires)}; Max-Age=${lifetime}; ${cookieOptions}` });
        response.end();
      } else {
        response.statusCode = 401;
        page('Contraseña incorrecta.');
      }
      return true;
    }
    if (pathname.startsWith('/api/')) {
      response.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: 'La sesión ha caducado. Recarga la página para acceder.' }));
    } else if (request.method === 'GET') {
      page();
    } else {
      response.writeHead(401);
      response.end('Autenticación necesaria.');
    }
    return true;
  };
}
