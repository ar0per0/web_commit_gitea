import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { cloneProject } from '../src/projects.js';

const config = { url: 'https://gitea.example.com/sub/', user: 'tester', token: 'secret' };

test('clona en el directorio de datos sin guardar credenciales y limpia askpass', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'gitea-clone-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let askpass;
  const result = await cloneProject(directory, 'org/proyecto', config, async (command, args, options) => {
    assert.equal(command, 'git');
    assert.deepEqual(args.slice(-4), ['clone', '--', 'https://gitea.example.com/sub/org/proyecto.git', '.']);
    assert.equal(options.cwd, path.join(directory, 'proyecto'));
    assert.equal(options.env.GITEA_AUTH_TOKEN, config.token);
    assert.ok(args.includes('credential.helper='));
    assert.ok(args.includes('http.followRedirects=false'));
    assert.ok(!args.join(' ').includes(config.token));
    askpass = options.env.GIT_ASKPASS;
    assert.match(await readFile(askpass, 'utf8'), /GITEA_AUTH_TOKEN/);
    await mkdir(path.join(options.cwd, '.git'));
  });
  assert.equal(result.name, 'proyecto');
  assert.deepEqual(await readdir(directory), ['proyecto']);
  await assert.rejects(readFile(askpass), { code: 'ENOENT' });
});

test('no sobrescribe carpetas ni acepta rutas o configuraciones inseguras', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'gitea-clone-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, 'existe'));
  const run = async () => assert.fail('No debe ejecutar Git');
  await assert.rejects(cloneProject(directory, 'org/existe', config, run), { status: 409 });
  for (const name of ['../fuera', 'org/..', 'org/a/b', 'org/-opcion', null, 'org/a\\b']) {
    await assert.rejects(cloneProject(directory, name, config, run), { status: 400 });
  }
  await assert.rejects(cloneProject(directory, 'org/nuevo', { ...config, url: 'http://inseguro.test' }, run), { status: 400 });
  assert.deepEqual(await readdir(directory), ['existe']);
});

test('elimina únicamente el clon fallido y sus credenciales temporales', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'gitea-clone-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let askpass;
  await assert.rejects(cloneProject(directory, 'org/fallo', config, async (_command, _args, options) => {
    askpass = options.env.GIT_ASKPASS;
    throw new Error('fallo de red');
  }), { status: 502 });
  assert.deepEqual(await readdir(directory), []);
  await assert.rejects(readFile(askpass), { code: 'ENOENT' });
});
