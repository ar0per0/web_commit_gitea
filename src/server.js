import { createServer as createHttpServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describeProject, initializeProject, projectPath, commitProject, listBranches, listTags, changeBranch, createTag } from './projects.js';
import { publishImage } from './docker.js';
import { repositoryExists, createRepository } from './gitea.js';
import { createAuth } from './auth.js';
import { isSameOrigin } from './origin.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const assets = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
};

export function createServer({ dataPath = './data', gitea = {}, giteaFetch = fetch, password } = {}) {
  const directory = path.resolve(root, dataPath);
  const busy = new Set();
  const authenticate = password === undefined ? null : createAuth(password);

  return createHttpServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    response.setHeader('Referrer-Policy', 'no-referrer');
    let url;
    try { url = new URL(request.url, 'http://localhost'); } catch {
      response.writeHead(400);
      response.end('URL no válida');
      return;
    }
    const pathname = url.pathname;
    if (authenticate && await authenticate(request, response, pathname)) return;
    if (['/api/folder', '/api/folder/init', '/api/folder/repository', '/api/folder/commit', '/api/folder/branches', '/api/folder/branch', '/api/folder/tag', '/api/folder/tags', '/api/folder/docker'].includes(pathname)) {
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      const initialize = pathname === '/api/folder/init';
      const createRemote = pathname === '/api/folder/repository';
      const commit = pathname === '/api/folder/commit';
      const branch = pathname === '/api/folder/branch';
      const tag = pathname === '/api/folder/tag';
      const docker = pathname === '/api/folder/docker';
      const write = initialize || createRemote || commit || branch || tag || docker;
      if (request.method !== (write ? 'POST' : 'GET')) {
        response.writeHead(405, { Allow: write ? 'POST' : 'GET' });
        response.end(JSON.stringify({ error: 'Método no permitido.' }));
        return;
      }
      // Las peticiones de escritura solo se aceptan desde nuestra interfaz.
      if (write && (request.headers['x-requested-with'] !== 'GiteaWorkspace' || !isSameOrigin(request))) {
        response.writeHead(403);
        response.end(JSON.stringify({ error: 'Origen no permitido.' }));
        return;
      }
      let lock;
      try {
        const name = url.searchParams.get('name');
        if (write) {
          const target = await projectPath(directory, name);
          if (busy.has(target)) throw Object.assign(new Error('Ya hay una operación en curso en esta carpeta.'), { status: 409 });
          busy.add(target);
          lock = target;
        }
        let result;
        if (commit || branch || tag || docker) {
          const chunks = [];
          let size = 0;
          for await (const chunk of request) {
            size += chunk.length;
            if (size > 20000) throw Object.assign(new Error('Mensaje demasiado largo.'), { status: 413 });
            chunks.push(chunk);
          }
          let payload;
          try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {
            throw Object.assign(new Error('El cuerpo debe ser JSON válido.'), { status: 400 });
          }
          if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
            throw Object.assign(new Error('El cuerpo JSON debe ser un objeto.'), { status: 400 });
          }
          if (branch && !['create', 'switch'].includes(payload?.action)) {
            throw Object.assign(new Error('Acción de rama no válida.'), { status: 400 });
          }
          if (docker) {
            response.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
            response.setHeader('X-Accel-Buffering', 'no');
            response.flushHeaders();
            result = await publishImage(directory, name, payload?.version, gitea, undefined, (event) => {
              if (!response.destroyed) response.write(`${JSON.stringify(event)}\n`);
            });
            response.end(`${JSON.stringify({ done: true, ...result })}\n`);
            return;
          }
          result = tag ? await createTag(directory, name, payload?.tag, gitea) : branch
            ? await changeBranch(directory, name, payload?.branch, payload.action === 'create', gitea)
            : await commitProject(directory, name, payload?.message, gitea);
        } else if (pathname === '/api/folder/tags') {
          result = await listTags(directory, name);
        } else if (pathname === '/api/folder/branches') {
          result = await listBranches(directory, name);
        } else if (createRemote) {
          result = await createRepository(gitea, name, giteaFetch);
        } else if (initialize) {
          if (!await repositoryExists(gitea, name, giteaFetch)) {
            throw Object.assign(new Error('Primero crea el repositorio en Gitea.'), { status: 409 });
          }
          result = await initializeProject(directory, name, gitea);
        } else {
          result = await describeProject(directory, name);
          if (!result.hasGit) {
            try {
              result.remoteExists = await repositoryExists(gitea, name, giteaFetch);
            } catch (error) {
              result.remoteExists = null;
              result.remoteError = error.message;
            }
          }
        }
        response.end(JSON.stringify(result));
      } catch (error) {
        if (response.headersSent) {
          response.end(`${JSON.stringify({ error: error.status ? error.message : 'No se ha podido completar la operación Docker.' })}\n`);
          return;
        }
        response.statusCode = error.status || (error.code === 'ENOENT' ? 404 : 500);
        response.end(JSON.stringify({ error: error.status ? error.message : 'No se puede acceder a la carpeta. Comprueba la ruta y los permisos.' }));
      } finally {
        if (lock) busy.delete(lock);
      }
      return;
    }
    if (request.method !== 'GET') {
      response.writeHead(405, { Allow: 'GET' });
      response.end('Método no permitido');
      return;
    }

    if (pathname === '/gitea') {
      let destination;
      try {
        destination = new URL(gitea.url);
        if (!['http:', 'https:'].includes(destination.protocol) || destination.username || destination.password) throw new Error('URL no válida');
        const project = url.searchParams.get('name');
        if (project !== null) {
          if (!gitea.user || !project || project === '.' || project === '..' || /[/\\]/.test(project)) throw new Error('Proyecto no válido');
          destination.pathname = `${destination.pathname.replace(/\/$/, '')}/${encodeURIComponent(gitea.user)}/${encodeURIComponent(project)}`;
          destination.search = '';
          destination.hash = '';
        }
      } catch {
        response.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('Configura una GITEA_URL válida en .env y reinicia el servidor.');
        return;
      }
      response.writeHead(302, { Location: destination.href });
      response.end();
      return;
    }

    if (pathname === '/api/folders') {
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      try {
        const entries = await readdir(directory, { withFileTypes: true });
        const folders = entries
          .filter((entry) => entry.isDirectory())
          .map((entry) => ({ name: entry.name }))
          .sort((a, b) => a.name.localeCompare(b.name, 'es', { numeric: true }));
        response.end(JSON.stringify({ path: dataPath, folders }));
      } catch (error) {
        response.statusCode = error.code === 'ENOENT' ? 404 : 500;
        response.end(JSON.stringify({
          path: dataPath,
          error: error.code === 'ENOENT'
            ? 'La carpeta configurada no existe. Créala o cambia DATA_PATH en .env y reinicia el servidor.'
            : 'No se puede leer la carpeta configurada. Comprueba la ruta y los permisos.',
        }));
      }
      return;
    }

    const asset = Object.hasOwn(assets, pathname) ? assets[pathname] : null;
    if (!asset) {
      response.writeHead(404);
      response.end('No encontrado');
      return;
    }
    try {
      const content = await readFile(path.join(root, 'public', asset[0]));
      response.writeHead(200, { 'Content-Type': asset[1] });
      response.end(content);
    } catch {
      response.writeHead(500);
      response.end('No se puede cargar la página.');
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    process.loadEnvFile(path.join(root, '.env'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const server = createServer({
    password: process.env.WEB_PASSWORD || '',
    dataPath: process.env.DATA_PATH || './data',
    gitea: { user: process.env.GITEA_USER, email: process.env.GITEA_EMAIL, token: process.env.GITEA_TOKEN, url: process.env.GITEA_URL },
  });
  server.on('error', (error) => {
    console.error(`No se puede iniciar el servidor en el puerto 8804: ${error.message}`);
    process.exitCode = 1;
  });
  const host = process.env.HOST || '127.0.0.1';
  server.listen(8804, host, () => {
    console.log(`Web disponible en http://${host}:8804`);
  });
}
