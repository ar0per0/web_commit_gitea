import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, realpath, readdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const exec = promisify(execFile);
// La configuración local no debe publicar etiquetas/submódulos adicionales ni activar mirror.
const pushOptions = ['-c', 'remote.origin.mirror=false', '-c', 'push.followTags=false', '-c', 'push.recurseSubmodules=no', '-c', 'http.followRedirects=false'];

async function verifyRemote(git, expected) {
  const fetchUrl = (await git(['remote', 'get-url', 'origin'])).stdout.trim();
  const pushUrls = (await git(['remote', 'get-url', '--push', '--all', 'origin'])).stdout.trim().split('\n');
  if (fetchUrl !== expected || pushUrls.length !== 1 || pushUrls[0] !== expected) {
    throw new Error('Origin o su destino de push no coincide con el repositorio configurado');
  }
}

async function branchGit(directory, name, run) {
  const project = await projectPath(directory, name);
  if (!await hasGit(project)) throw Object.assign(new Error('Primero inicializa .git.'), { status: 409 });
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_') && key !== 'GIT_TERMINAL_PROMPT') delete env[key];
  }
  const git = (args, extraEnv = {}) => run('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd: project, env: { ...env, ...extraEnv }, timeout: 120_000, maxBuffer: 1024 * 1024,
  });
  try {
    const top = await git(['rev-parse', '--show-toplevel']);
    if (await realpath(top.stdout.trim()) !== project) throw new Error();
  } catch {
    throw Object.assign(new Error('No se puede comprobar el repositorio Git de esta carpeta.'), { status: 409 });
  }
  return git;
}

export async function listTags(directory, name, run = exec) {
  const git = await branchGit(directory, name, run);
  try {
    const result = await git(['for-each-ref', '--sort=-creatordate', '--format=%(refname:strip=2)', 'refs/tags/']);
    return { tags: result.stdout.trim().split('\n').filter(Boolean) };
  } catch {
    throw Object.assign(new Error('No se pueden consultar las etiquetas locales.'), { status: 409 });
  }
}

export async function listBranches(directory, name, run = exec) {
  const git = await branchGit(directory, name, run);
  try {
    const result = await git(['for-each-ref', '--format=%(refname:strip=2)', 'refs/heads/']);
    let current = null;
    try { current = (await git(['symbolic-ref', '--quiet', '--short', 'HEAD'])).stdout.trim(); } catch { /* HEAD separado. */ }
    return { current, branches: result.stdout.trim().split('\n').filter(Boolean) };
  } catch {
    throw Object.assign(new Error('No se pueden consultar las ramas locales.'), { status: 409 });
  }
}

export async function changeBranch(directory, name, branch, create = false, config = {}, run = exec) {
  if (typeof branch !== 'string' || !branch || branch.length > 255 || branch.startsWith('-') || branch.includes('\0')) {
    throw Object.assign(new Error('Escribe un nombre de rama válido.'), { status: 400 });
  }
  const git = await branchGit(directory, name, run);
  try { await git(['check-ref-format', `refs/heads/${branch}`]); } catch {
    throw Object.assign(new Error('Nombre de rama no válido. No uses espacios ni caracteres especiales de Git.'), { status: 400 });
  }
  const { branches, current } = await listBranches(directory, name, run);
  if (create ? branches.includes(branch) : !branches.includes(branch)) {
    throw Object.assign(new Error(create ? 'Ya existe una rama con ese nombre.' : 'La rama local seleccionada no existe.'), { status: 409 });
  }
  if (!create && current === branch) return { message: `Ya estás en la rama «${branch}».`, committed: false };
  let committed = false;
  let step = 'guardar y enviar la rama actual';
  try {
    if (!current) throw Object.assign(new Error('HEAD está separado. No se puede enviar la rama actual ni cambiar automáticamente.'), { status: 409 });
    const saved = await commitProject(directory, name, `Cambios antes de cambiar a ${branch}`, config, run);
    committed = saved.committed;
    if ((await git(['status', '--porcelain=v1', '--untracked-files=all'])).stdout) {
      throw Object.assign(new Error('Quedan cambios que no se han podido guardar. No se ha cambiado de rama; cualquier commit creado se conserva.'), { status: 409 });
    }
    step = 'cambiar de rama';
    await git(create ? ['switch', '--no-guess', '-c', branch] : ['switch', '--no-guess', branch]);
    if (create) {
      try {
        await commitProject(directory, name, `Publicar rama ${branch}`, config, run, true);
      } catch {
        throw Object.assign(new Error(`La rama «${branch}» está creada y seleccionada localmente, pero ha fallado su push. La rama anterior y sus commits ya se enviaron. Reintenta el envío de la nueva rama con «Commit y push». No se ha borrado ni revertido nada.`), { status: 502 });
      }
    }
  } catch (error) {
    if (error.status) throw error;
    throw Object.assign(new Error(`No se ha podido ${step}. Los cambios y cualquier commit automático se conservan; no se ha forzado el cambio de rama. Comprueba el repositorio y que la rama no esté abierta en otro worktree.`), { status: 409 });
  }
  return { message: `${committed ? 'Commit automático creado. ' : ''}Rama «${current}» enviada a Gitea. ${create ? `Rama «${branch}» creada, seleccionada y enviada a Gitea.` : `Ahora estás en la rama «${branch}».`}`, committed };
}

export async function createTag(directory, name, tag, config, run = exec) {
  if (typeof tag !== 'string' || !tag || tag.length > 255 || tag.startsWith('-') || tag.includes('\0')) {
    throw Object.assign(new Error('Escribe un nombre de etiqueta válido.'), { status: 400 });
  }
  const git = await branchGit(directory, name, run);
  try { await git(['check-ref-format', `refs/tags/${tag}`]); } catch {
    throw Object.assign(new Error('Nombre de etiqueta no válido. No uses espacios ni caracteres especiales de Git.'), { status: 400 });
  }
  if (!config.user || !config.token || !config.url) {
    throw Object.assign(new Error('Configura GITEA_USER, GITEA_TOKEN y GITEA_URL.'), { status: 400 });
  }
  try {
    const expected = new URL(config.url);
    if (expected.protocol !== 'https:' || expected.username || expected.password || expected.search || expected.hash) throw new Error();
    expected.pathname = `${expected.pathname.replace(/\/$/, '')}/${encodeURIComponent(config.user)}/${encodeURIComponent(name)}.git`;
    await verifyRemote(git, expected.href);
    await git(['rev-parse', '--verify', 'HEAD^{commit}']);
  } catch {
    throw Object.assign(new Error('Comprueba que origin coincide con Gitea y que existe al menos un commit.'), { status: 409 });
  }
  const ref = `refs/tags/${tag}`;
  const existing = (await git(['for-each-ref', '--format=%(refname)', ref])).stdout.split('\n').includes(ref);
  if (!existing) {
    await commitProject(directory, name, `Cambios antes de crear la etiqueta ${tag}`, config, run);
    if ((await git(['status', '--porcelain=v1', '--untracked-files=all'])).stdout) {
      throw Object.assign(new Error('Quedan cambios sin guardar. No se ha creado la etiqueta; los commits y envíos realizados se conservan.'), { status: 409 });
    }
    try { await git(['-c', 'tag.gpgsign=false', 'tag', '--no-sign', '--', tag, 'HEAD']); } catch {
      throw Object.assign(new Error('No se ha podido crear la etiqueta. Comprueba si el nombre entra en conflicto con otra etiqueta.'), { status: 409 });
    }
  }
  let temporary;
  try {
    temporary = await mkdtemp(path.join(tmpdir(), 'gitea-auth-'));
    const askpass = path.join(temporary, 'askpass.sh');
    await writeFile(askpass, '#!/bin/sh\ncase "$1" in\n  *Username*) printf "%s\\n" "$GITEA_AUTH_USER" ;;\n  *) printf "%s\\n" "$GITEA_AUTH_TOKEN" ;;\nesac\n', { mode: 0o700 });
    await git([...pushOptions, '-c', 'credential.helper=', 'push', 'origin', `${ref}:${ref}`], {
      GIT_ASKPASS: askpass, GITEA_AUTH_USER: config.user, GITEA_AUTH_TOKEN: config.token,
    });
  } catch {
    throw Object.assign(new Error(`La etiqueta «${tag}» se conserva localmente, pero ha fallado su envío. Reintenta con el mismo nombre. No se sobrescriben etiquetas remotas.`), { status: 502 });
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
  return { message: `Etiqueta «${tag}» ${existing ? 'existente enviada' : 'creada y enviada'} a Gitea.` };
}

export async function commitProject(directory, name, message, config, run = exec, pushOnly = false) {
  if (message === undefined) message = '';
  if (typeof message !== 'string' || message.length > 4000 || message.includes('\0')) {
    throw Object.assign(new Error('El mensaje de commit debe ser texto de hasta 4000 caracteres.'), { status: 400 });
  }
  message = message.trim() || `Commit ${new Intl.DateTimeFormat('es-ES', {
    timeZone: process.env.TZ || 'Europe/Madrid',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).format(new Date())}`;
  const project = await projectPath(directory, name);
  if (!await hasGit(project)) throw Object.assign(new Error('Primero inicializa .git.'), { status: 409 });
  if (!config.user || !config.email || !config.token || !config.url) throw Object.assign(new Error('Configura GITEA_USER, GITEA_EMAIL, GITEA_TOKEN y GITEA_URL.'), { status: 400 });
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_') && key !== 'GIT_TERMINAL_PROMPT') delete env[key];
  }
  const git = (args) => run('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd: project, env, timeout: 120_000, maxBuffer: 1024 * 1024,
  });
  let step = 'comprobar el repositorio';
  let committed = false;
  let temporary;
  try {
    const top = await git(['rev-parse', '--show-toplevel']);
    if (await realpath(top.stdout.trim()) !== await realpath(project)) {
      throw new Error('Repositorio externo');
    }
    step = 'comprobar origin y la rama actual';
    const expected = new URL(config.url);
    if (expected.protocol !== 'https:' || expected.username || expected.password || expected.search || expected.hash) throw new Error();
    expected.pathname = `${expected.pathname.replace(/\/$/, '')}/${encodeURIComponent(config.user)}/${encodeURIComponent(name)}.git`;
    await verifyRemote(git, expected.href);
    const branch = (await git(['symbolic-ref', '--short', 'HEAD'])).stdout.trim();
    if (!pushOnly) {
      step = 'git add .';
      await git(['add', '.']);
      step = 'comprobar los cambios';
      const changes = await git(['diff', '--cached', '--name-only', '-z']);
      if (changes.stdout) {
        step = 'git commit';
        await git(['-c', `user.name=${config.user}`, '-c', `user.email=${config.email}`, '-c', 'commit.gpgsign=false', 'commit', '-m', message.trim()]);
        committed = true;
      }
    }
    step = 'git push';
    temporary = await mkdtemp(path.join(tmpdir(), 'gitea-auth-'));
    const askpass = path.join(temporary, 'askpass.sh');
    await writeFile(askpass, '#!/bin/sh\ncase "$1" in\n  *Username*) printf "%s\\n" "$GITEA_AUTH_USER" ;;\n  *) printf "%s\\n" "$GITEA_AUTH_TOKEN" ;;\nesac\n', { mode: 0o700 });
    Object.assign(env, { GIT_ASKPASS: askpass, GITEA_AUTH_USER: config.user, GITEA_AUTH_TOKEN: config.token });
    await git([...pushOptions, '-c', 'credential.helper=', 'push', '-u', 'origin', `HEAD:refs/heads/${branch}`]);
    return { message: committed ? 'Commit creado y enviado a Gitea.' : 'No había cambios nuevos. Los commits pendientes se han enviado a Gitea.', committed };
  } catch {
    throw Object.assign(new Error(`Ha fallado ${step}. Comprueba origin, la rama, los permisos y la conexión. Los cambios y cualquier commit local se conservan. Puedes reintentar con el mismo botón; si no hay cambios nuevos, solo se enviarán los commits pendientes.`), { status: 500 });
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
}

export async function projectPath(directory, name) {
  if (typeof name !== 'string' || !name || name === '.' || name === '..' || /[\\/\0]/.test(name)) {
    throw Object.assign(new Error('Nombre de carpeta no válido.'), { status: 400 });
  }
  const base = await realpath(directory);
  const candidate = path.join(base, name);
  const info = await lstat(candidate);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(candidate) !== candidate) {
    throw Object.assign(new Error('Selecciona una carpeta del primer nivel, no un enlace.'), { status: 400 });
  }
  return candidate;
}

export async function hasGit(directory) {
  try {
    await lstat(path.join(directory, '.git'));
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

export async function describeProject(directory, name) {
  const project = await projectPath(directory, name);
  const entries = await readdir(project, { withFileTypes: true });
  return {
    name,
    hasGit: await hasGit(project),
    hasDockerfile: entries.some((entry) => ['Dockerfile', 'dockerfile'].includes(entry.name) && entry.isFile()),
    entries: entries.map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory() }))
      .sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name, 'es', { numeric: true })),
  };
}

export async function initializeProject(directory, name, config, run = exec) {
  const project = await projectPath(directory, name);
  if (await hasGit(project)) {
    throw Object.assign(new Error('La carpeta ya contiene .git. No se ha modificado.'), { status: 409 });
  }
  if (!config.user || !config.email || !config.token || !config.url) {
    throw Object.assign(new Error('Configura GITEA_USER, GITEA_EMAIL, GITEA_TOKEN y GITEA_URL en .env y reinicia.'), { status: 400 });
  }
  let remote;
  try {
    remote = new URL(config.url);
    if (remote.protocol !== 'https:' || remote.username || remote.password || remote.search || remote.hash) throw new Error();
    remote.pathname = `${remote.pathname.replace(/\/$/, '')}/${encodeURIComponent(config.user)}/${encodeURIComponent(name)}.git`;
  } catch {
    throw Object.assign(new Error('GITEA_URL debe ser una URL HTTPS sin credenciales ni parámetros.'), { status: 400 });
  }

  const temporary = await mkdtemp(path.join(tmpdir(), 'gitea-auth-'));
  const askpass = path.join(temporary, 'askpass.sh');
  try {
    await writeFile(askpass, '#!/bin/sh\ncase "$1" in\n  *Username*) printf "%s\\n" "$GITEA_AUTH_USER" ;;\n  *) printf "%s\\n" "$GITEA_AUTH_TOKEN" ;;\nesac\n', { mode: 0o700 });
    const env = { ...process.env, GIT_ASKPASS: askpass, GIT_TERMINAL_PROMPT: '0', GITEA_AUTH_USER: config.user, GITEA_AUTH_TOKEN: config.token };
    // No permitir que variables Git heredadas redirijan las operaciones a otro repositorio.
    for (const key of Object.keys(env)) {
      if (key.startsWith('GIT_') && !['GIT_ASKPASS', 'GIT_TERMINAL_PROMPT'].includes(key)) delete env[key];
    }
    const steps = [
      ['git init', ['init']],
      ['git checkout -b main', ['checkout', '-b', 'main']],
      ['configurar usuario', ['config', 'user.name', config.user]],
      ['configurar email', ['config', 'user.email', config.email]],
      ['git add .', ['add', '.']],
      ['git commit -m "inicio"', ['-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'inicio']],
      ['git remote add origin', ['remote', 'add', 'origin', remote.href]],
      ['git push -u origin main', [...pushOptions, '-c', 'credential.helper=', 'push', '-u', 'origin', 'main']],
    ];
    for (const [label, args] of steps) {
      try {
        if (args.includes('push')) {
          await verifyRemote((args) => run('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
            cwd: project, env, timeout: 120_000, maxBuffer: 1024 * 1024,
          }), remote.href);
        }
        await run('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: project, env, timeout: 120_000, maxBuffer: 1024 * 1024 });
      } catch {
        throw Object.assign(new Error(`Ha fallado ${label}. Los pasos anteriores se conservan. Comprueba que Git está instalado, los permisos, la conexión y que el repositorio remoto existe y permite el acceso. Si ya se creó .git, no vuelvas a inicializarlo.`), { status: 500 });
      }
    }
    return { message: 'Repositorio inicializado y enviado a Gitea.', hasGit: true };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
