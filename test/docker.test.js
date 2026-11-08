import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, access, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { publishImage } from '../src/docker.js';
import { describeProject } from '../src/projects.js';

const config = { url: 'https://gitea.example.com/', user: 'tester', token: 'secret-token' };
const exec = promisify(execFile);

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'docker-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, 'proyecto'));
  await writeFile(path.join(directory, 'proyecto', 'Dockerfile'), 'FROM scratch\n');
  await exec('git', ['init', '-b', 'main'], { cwd: path.join(directory, 'proyecto') });
  return directory;
}

test('Docker: login privado, build, push, limpieza y progreso sin revelar el token', async (t) => {
  const directory = await fixture(t);
  const calls = [];
  const progress = [];
  const result = await publishImage(directory, 'proyecto', 'v1.0', config, async (args, options) => {
    calls.push({ args, options });
    options.onOutput(`salida ${config.token}`);
  }, (event) => progress.push(event));
  const image = 'gitea.example.com/tester/proyecto:v1.0';
  assert.equal(result.image, image);
  assert.deepEqual(calls.map(({ args }) => args.slice(2)), [
    ['login', 'gitea.example.com', '--username', 'tester', '--password-stdin'],
    ['build', '-f', 'Dockerfile', '-t', image, '.'], ['push', image], ['image', 'rm', image],
  ]);
  assert.equal(calls[0].options.input, `${config.token}\n`);
  assert.equal(JSON.stringify(calls.map(({ args }) => args)).includes(config.token), false);
  assert.equal(JSON.stringify(progress).includes(config.token), false);
  assert.equal(progress.filter((event) => event.step).length, 4);
  await assert.rejects(access(calls[0].options.env.DOCKER_CONFIG), { code: 'ENOENT' });
});

test('Docker: detiene la secuencia al fallar y distingue un fallo de limpieza', async (t) => {
  const directory = await fixture(t);
  for (const failure of ['login', 'build', 'push', 'image']) {
    const calls = [];
    let temporary;
    await assert.rejects(publishImage(directory, 'proyecto', '1.0', config, async (args, options) => {
      temporary = options.env.DOCKER_CONFIG;
      calls.push(args[2]);
      if (args[2] === failure) throw new Error(config.token);
    }), (error) => error.status === 502 && !error.message.includes(config.token)
      && (failure !== 'image' || error.message.includes('enviada')));
    assert.equal(calls.at(-1), failure);
    await assert.rejects(access(temporary), { code: 'ENOENT' });
  }
});

test('Docker: separa las imágenes por rama y conserva la versión', async (t) => {
  const directory = await fixture(t);
  await exec('git', ['symbolic-ref', 'HEAD', 'refs/heads/prova2'], { cwd: path.join(directory, 'proyecto') });
  const calls = [];
  const result = await publishImage(directory, 'proyecto', '1.0', config, async (args) => calls.push(args));
  assert.equal(result.image, 'gitea.example.com/tester/proyecto__prova2:1.0');
  assert.equal(calls[1][6], result.image);
  await exec('git', ['symbolic-ref', 'HEAD', 'refs/heads/feature/prueba'], { cwd: path.join(directory, 'proyecto') });
  await assert.rejects(publishImage(directory, 'proyecto', '1.0', config, () => assert.fail('No debe ejecutar Docker')), { status: 400 });
});

test('Docker: rechaza versiones y nombres inválidos antes de ejecutar comandos', async (t) => {
  const directory = await fixture(t);
  const run = () => assert.fail('No debe ejecutar Docker');
  for (const version of ['', null, '-f', 'a/b', 'con espacio', 'a'.repeat(129)]) {
    await assert.rejects(publishImage(directory, 'proyecto', version, config, run), { status: 400 });
  }
  await assert.rejects(publishImage(directory, 'proyecto', '1', { ...config, user: 'MAYUSCULAS' }, run), { status: 400 });
  for (const url of ['http://gitea.example.com/', 'https://gitea.example.com/?token=x', 'https://gitea.example.com/#x']) {
    await assert.rejects(publishImage(directory, 'proyecto', '1', { ...config, url }, run), { status: 400 });
  }
});

test('Docker: no ejecuta comandos sin un Dockerfile real', async (t) => {
  const directory = await fixture(t);
  assert.equal((await describeProject(directory, 'proyecto')).hasDockerfile, true);
  await rm(path.join(directory, 'proyecto', 'Dockerfile'));
  assert.equal((await describeProject(directory, 'proyecto')).hasDockerfile, false);
  const run = () => assert.fail('No debe ejecutar Docker');
  await assert.rejects(publishImage(directory, 'proyecto', '1', config, run), { status: 409 });
  await mkdir(path.join(directory, 'proyecto', 'dockerfile'));
  assert.equal((await describeProject(directory, 'proyecto')).hasDockerfile, false);
  await assert.rejects(publishImage(directory, 'proyecto', '1', config, run), { status: 409 });
  await rm(path.join(directory, 'proyecto', 'dockerfile'), { recursive: true });
  await writeFile(path.join(directory, 'proyecto', 'dockerfile'), 'FROM scratch\n');
  assert.equal((await describeProject(directory, 'proyecto')).hasDockerfile, true);
  const calls = [];
  await publishImage(directory, 'proyecto', '1', config, async (args) => calls.push(args));
  assert.deepEqual(calls[1].slice(2, 5), ['build', '-f', 'dockerfile']);
});
