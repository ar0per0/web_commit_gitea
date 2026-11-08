import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { projectPath } from './projects.js';

function runDocker(args, { cwd, env, input = '', onOutput = () => {} }) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding('utf8');
      let pending = '';
      stream.on('data', (chunk) => {
        pending += chunk;
        const lines = pending.split(/[\r\n]/);
        pending = lines.pop();
        for (const line of lines) if (line) onOutput(line);
        if (pending.length > 65536) pending = pending.slice(-65536);
      });
      stream.on('end', () => { if (pending) onOutput(pending); });
    }
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error('Docker falló')));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

export async function publishImage(directory, name, version, config = {}, run = runDocker, onProgress = () => {}) {
  if (typeof version !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(version)) {
    throw Object.assign(new Error('Versión Docker no válida: usa hasta 128 letras, números, puntos, guiones o guiones bajos.'), { status: 400 });
  }
  const project = await projectPath(directory, name);
  const entries = await readdir(project, { withFileTypes: true });
  const dockerfile = ['Dockerfile', 'dockerfile'].find((name) => entries.some((entry) => entry.name === name && entry.isFile()));
  if (!dockerfile) {
    throw Object.assign(new Error('La carpeta no contiene un archivo Dockerfile o dockerfile. No se puede construir la imagen.'), { status: 409 });
  }
  let registry;
  try {
    const url = new URL(config.url);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !url.hostname) throw new Error();
    registry = url.host;
    const component = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/;
    if (!component.test(config.user || '') || !component.test(name) || !config.token) throw new Error();
  } catch {
    throw Object.assign(new Error('Comprueba GITEA_URL, GITEA_USER y GITEA_TOKEN. El usuario y la carpeta deben ser nombres Docker válidos en minúsculas.'), { status: 400 });
  }
  const image = `${registry}/${config.user}/${name}:${version}`;
  const temporary = await mkdtemp(path.join(tmpdir(), 'gitea-docker-'));
  const env = { ...process.env };
  delete env.GITEA_TOKEN;
  delete env.GITEA_AUTH_TOKEN;
  env.DOCKER_CONFIG = temporary;
  const onOutput = (line) => onProgress({ log: line.split(config.token).join('[TOKEN OCULTO]').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '') });
  const docker = (args, input) => {
    onProgress({ step: args[0] === 'image' ? 'Limpieza local' : args[0] });
    return run(['--config', temporary, ...args], { cwd: project, env, input, onOutput });
  };
  let step = 'login';
  let pushed = false;
  try {
    await docker(['login', registry, '--username', config.user, '--password-stdin'], `${config.token}\n`);
    step = 'build';
    await docker(['build', '-f', dockerfile, '-t', image, '.']);
    step = 'push';
    await docker(['push', image]);
    pushed = true;
    step = 'image rm';
    await docker(['image', 'rm', image]);
    return { image, message: `Imagen ${image} enviada a Gitea y eliminada localmente.` };
  } catch {
    throw Object.assign(new Error(pushed
      ? `Imagen ${image} enviada, pero no se ha podido eliminar localmente (docker image rm).`
      : `Ha fallado docker ${step}. Comprueba Docker, el Dockerfile, los permisos del registro y que el token permita escribir paquetes. No se ha completado la publicación; cualquier imagen local se conserva.`), { status: 502 });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
