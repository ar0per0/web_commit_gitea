import { redact } from './log.js';

function apiUrl(config, endpoint) {
  try {
    const url = new URL(config.url);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error();
    if (!config.user || !config.token) throw new Error();
    const [pathname, search = ''] = endpoint.split('?');
    url.pathname = `${url.pathname.replace(/\/$/, '')}/api/v1/${pathname}`;
    url.search = search;
    return url;
  } catch {
    throw Object.assign(new Error('Comprueba GITEA_URL (HTTPS), GITEA_USER y GITEA_TOKEN en .env.'), { status: 400 });
  }
}

async function request(config, endpoint, options, fetcher) {
  const url = apiUrl(config, endpoint);
  let response;
  try {
    response = await fetcher(url, {
      ...options,
      headers: { Authorization: `token ${config.token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
    });
  } catch (cause) {
    throw Object.assign(new Error('No se puede conectar con Gitea. Comprueba la URL y la conexión.'), {
      status: 502,
      details: { method: options.method, url: url.href, cause: redact(cause.stack || cause, [config.token]) },
    });
  }
  if (!response.ok && !(response.status === 404 && endpoint.startsWith('repos/'))) {
    let body;
    try { body = await response.text(); } catch (error) { body = `No se pudo leer la respuesta: ${error.message}`; }
    throw Object.assign(failure(response.status), {
      details: {
        method: options.method, url: url.href, status: response.status,
        statusText: response.statusText,
        requestId: response.headers.get('x-request-id'),
        body: redact(body, [config.token]),
      },
    });
  }
  return response;
}

function failure(status) {
  return Object.assign(new Error(`Gitea ha respondido HTTP ${status}. Comprueba el usuario, los permisos del token y el nombre del repositorio.`), { status: 502 });
}

export async function repositoryExists(config, name, fetcher = fetch) {
  const response = await request(config, `repos/${encodeURIComponent(config.user)}/${encodeURIComponent(name)}`, { method: 'GET' }, fetcher);
  await response.body?.cancel();
  if (response.status === 404) return false;
  if (response.status === 200) return true;
  throw failure(response.status);
}

export async function listRepositories(config, fetcher = fetch) {
  const repositories = new Map();
  let received = 0;
  for (let page = 1; ; page++) {
    const response = await request(config, `user/repos?page=${page}&limit=50`, { method: 'GET' }, fetcher);
    let batch;
    try { batch = await response.json(); } catch { throw failure(502); }
    if (!Array.isArray(batch)) throw failure(502);
    received += batch.length;
    for (const repo of batch) {
      if (typeof repo?.name !== 'string' || typeof repo?.owner?.login !== 'string') throw failure(502);
      const fullName = `${repo.owner.login}/${repo.name}`;
      const url = new URL(config.url);
      url.pathname = `${url.pathname.replace(/\/$/, '')}/${encodeURIComponent(repo.owner.login)}/${encodeURIComponent(repo.name)}`;
      repositories.set(fullName, { name: fullName, url: url.href });
    }
    if (!batch.length) break;
    const total = response.headers.get('x-total-count');
    if (total !== null && /^\d+$/.test(total) && received >= Number(total)) break;
  }
  return [...repositories.values()].sort((a, b) => a.name.localeCompare(b.name, 'es', { numeric: true }));
}

export async function createRepository(config, name, fetcher = fetch) {
  if (await repositoryExists(config, name, fetcher)) return { message: 'El repositorio ya existe en Gitea.' };
  // /user/repos crea para el usuario del token: verificar que sea el configurado.
  const userResponse = await request(config, 'user', { method: 'GET' }, fetcher);
  if (!userResponse.ok) {
    await userResponse.body?.cancel();
    throw failure(userResponse.status);
  }
  let user;
  try { user = await userResponse.json(); } catch { throw failure(502); }
  if (typeof user?.login !== 'string' || user.login.toLowerCase() !== config.user.toLowerCase()) {
    throw Object.assign(new Error('El token no pertenece a GITEA_USER. No se ha creado ningún repositorio.'), { status: 400 });
  }
  const response = await request(config, 'user/repos', {
    method: 'POST', body: JSON.stringify({ name, private: true, auto_init: false }),
  }, fetcher);
  await response.body?.cancel();
  if (response.status !== 201) throw failure(response.status);
  return { message: 'Repositorio privado y vacío creado en Gitea.' };
}
