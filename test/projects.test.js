import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describeProject, initializeProject, projectPath, commitProject, listBranches, changeBranch, createTag, listTags } from '../src/projects.js';

const exec = promisify(execFile);
const config = { user: 'tester', email: 'tester@example.com', token: 'test-secret', url: 'https://gitea.example.com/' };

test('guarda y envía cambios antes de etiquetar; conserva etiquetas y permite reintentar sin moverlas', async (t) => {
  const directory = await fixture(t);
  const project = path.join(directory, 'proyecto');
  let failBranch = false;
  let failTag = false;
  const pushes = [];
  let askpass;
  const runner = async (command, args, options) => {
    if (!args.includes('push')) return exec(command, args, options);
    pushes.push(args.at(-1));
    assert.ok(args.includes('push.followTags=false'));
    assert.ok(args.includes('remote.origin.mirror=false'));
    assert.ok(args.includes('http.followRedirects=false'));
    assert.equal(options.env.GITEA_AUTH_TOKEN, config.token);
    askpass = options.env.GIT_ASKPASS;
    if ((failBranch && args.at(-1).includes('refs/heads/')) || (failTag && args.at(-1).includes('refs/tags/'))) throw new Error(config.token);
  };
  await initializeProject(directory, 'proyecto', config, runner);
  for (const tag of ['', null, '-f', 'con espacios', '../otra', 'v1~1']) {
    await assert.rejects(createTag(directory, 'proyecto', tag, config, runner), { status: 400 });
  }
  await writeFile(path.join(project, 'nuevo.txt'), 'contenido');
  failBranch = true;
  await assert.rejects(createTag(directory, 'proyecto', 'v1.0.0', config, runner), /git push/);
  await assert.rejects(exec('git', ['rev-parse', '--verify', 'refs/tags/v1.0.0'], { cwd: project }));
  failBranch = false;
  failTag = true;
  await assert.rejects(createTag(directory, 'proyecto', 'v1.0.0', config, runner), (error) => error.status === 502 && !error.message.includes(config.token));
  const target = (await exec('git', ['rev-parse', 'refs/tags/v1.0.0'], { cwd: project })).stdout;
  assert.equal(target, (await exec('git', ['rev-parse', 'HEAD'], { cwd: project })).stdout);
  assert.equal((await exec('git', ['show', 'v1.0.0:nuevo.txt'], { cwd: project })).stdout, 'contenido');
  await assert.rejects(readFile(askpass), { code: 'ENOENT' });
  await writeFile(path.join(project, 'otro.txt'), 'pendiente');
  failTag = false;
  await createTag(directory, 'proyecto', 'v1.0.0', config, runner);
  assert.equal((await exec('git', ['rev-parse', 'refs/tags/v1.0.0'], { cwd: project })).stdout, target);
  assert.equal(pushes.at(-1), 'refs/tags/v1.0.0:refs/tags/v1.0.0');
  assert.equal((await exec('git', ['rev-list', '--count', 'HEAD'], { cwd: project })).stdout.trim(), '2');
});

test('añade el prefijo de rama a las etiquetas salvo en main y conserva los reintentos', async (t) => {
  const directory = await fixture(t);
  const project = path.join(directory, 'proyecto');
  const pushes = [];
  const runner = async (command, args, options) => {
    if (!args.includes('push')) return exec(command, args, options);
    pushes.push(args.at(-1));
  };
  await initializeProject(directory, 'proyecto', config, runner);
  await createTag(directory, 'proyecto', 'v1.0', config, runner);
  assert.equal(pushes.at(-1), 'refs/tags/v1.0:refs/tags/v1.0');
  for (const branch of ['prova', 'feature/prueba', 'master']) {
    await exec('git', ['switch', '-c', branch], { cwd: project });
    const tag = `${branch}-v1.0`;
    const result = await createTag(directory, 'proyecto', 'v1.0', config, runner);
    assert.ok(result.message.includes(`«${tag}»`));
    assert.equal(pushes.at(-1), `refs/tags/${tag}:refs/tags/${tag}`);
    const target = (await exec('git', ['rev-parse', `refs/tags/${tag}`], { cwd: project })).stdout;
    await writeFile(path.join(project, 'pendiente.txt'), branch);
    await createTag(directory, 'proyecto', 'v1.0', config, runner);
    assert.equal((await exec('git', ['rev-parse', `refs/tags/${tag}`], { cwd: project })).stdout, target);
    await assert.rejects(createTag(directory, 'proyecto', '-f', config, runner), { status: 400 });
  }
  await exec('git', ['switch', '--detach'], { cwd: project });
  const before = pushes.length;
  await assert.rejects(createTag(directory, 'proyecto', 'v2.0', config, runner), { status: 409 });
  assert.equal(pushes.length, before);
});

test('consulta la última etiqueta de cada rama sin confundir etiquetas heredadas', async (t) => {
  const directory = await fixture(t);
  const project = path.join(directory, 'proyecto');
  const runner = async (command, args, options) => {
    if (!args.includes('push')) return exec(command, args, options);
  };
  await initializeProject(directory, 'proyecto', config, runner);
  assert.deepEqual(await listTags(directory, 'proyecto'), { tags: [], current: 'main', latest: null });
  await createTag(directory, 'proyecto', 'v1.0', config, runner);
  assert.equal((await listTags(directory, 'proyecto')).latest, 'v1.0');
  await exec('git', ['switch', '-c', 'prova'], { cwd: project });
  assert.equal((await listTags(directory, 'proyecto')).latest, null);
  assert.deepEqual((await listTags(directory, 'proyecto')).tags, []);
  await createTag(directory, 'proyecto', 'v1.0', config, runner);
  assert.equal((await listTags(directory, 'proyecto')).latest, 'prova-v1.0');
  assert.deepEqual((await listTags(directory, 'proyecto')).tags, ['prova-v1.0']);
  await writeFile(path.join(project, 'nuevo.txt'), 'otra versión');
  await createTag(directory, 'proyecto', 'v2.0', config, runner);
  // Fija fechas distintas para que la prueba no dependa de la resolución de un segundo de Git.
  await exec('git', ['tag', '-a', 'prova-v3.0', '-m', 'Nueva versión'], {
    cwd: project, env: { ...process.env, GIT_COMMITTER_DATE: '2030-01-01T00:00:00Z' },
  });
  assert.equal((await listTags(directory, 'proyecto')).latest, 'prova-v3.0');
  await exec('git', ['switch', 'main'], { cwd: project });
  await exec('git', ['merge', '--ff-only', 'prova'], { cwd: project });
  assert.equal((await listTags(directory, 'proyecto')).latest, 'v1.0');
  assert.deepEqual((await listTags(directory, 'proyecto')).tags, ['v1.0']);
  await exec('git', ['switch', '--detach'], { cwd: project });
  assert.equal((await listTags(directory, 'proyecto')).latest, null);
});

test('crea y cambia ramas locales sin perder cambios ni aceptar nombres no válidos', async (t) => {
  const directory = await fixture(t);
  const project = path.join(directory, 'proyecto');
  let failPush = false;
  const pushes = [];
  const runner = async (command, args, options) => {
    if (!args.includes('push')) return exec(command, args, options);
    pushes.push(args.at(-1));
    if (failPush) throw new Error('push fallido');
  };
  await initializeProject(directory, 'proyecto', config, async (command, args, options) => {
    if (!args.includes('push')) return exec(command, args, options);
  });
  assert.deepEqual(await listBranches(directory, 'proyecto'), { current: 'main', branches: ['main'] });
  await changeBranch(directory, 'proyecto', 'feature/prueba', true, config, runner);
  assert.equal((await listBranches(directory, 'proyecto')).current, 'feature/prueba');
  await assert.rejects(changeBranch(directory, 'proyecto', 'feature/prueba', true), { status: 409 });
  await changeBranch(directory, 'proyecto', 'main', false, config, runner);
  for (const branch of ['-f', 'con espacios', '../otra', 'main~1', '@{-1}', '', null]) {
    await assert.rejects(changeBranch(directory, 'proyecto', branch, true), { status: 400 });
  }
  await assert.rejects(changeBranch(directory, 'proyecto', 'inexistente'), { status: 409 });
  await writeFile(path.join(project, 'pendiente.txt'), 'no perder');
  failPush = true;
  await assert.rejects(changeBranch(directory, 'proyecto', 'feature/prueba', false, config, runner), /git push/);
  assert.equal(await readFile(path.join(project, 'pendiente.txt'), 'utf8'), 'no perder');
  assert.deepEqual(await listBranches(directory, 'proyecto'), { current: 'main', branches: ['feature/prueba', 'main'] });
  assert.equal((await exec('git', ['log', '-1', '--format=%s'], { cwd: project })).stdout.trim(), 'Cambios antes de cambiar a feature/prueba');
  failPush = false;
  await changeBranch(directory, 'proyecto', 'feature/prueba', false, config, runner);
  assert.equal((await listBranches(directory, 'proyecto')).current, 'feature/prueba');
  assert.equal((await exec('git', ['rev-list', '--count', 'main'], { cwd: project })).stdout.trim(), '2');
  await writeFile(path.join(project, 'otro.txt'), 'contenido');
  await exec('git', ['add', '.'], { cwd: project });
  await changeBranch(directory, 'proyecto', 'otra', true, config, runner);
  assert.equal((await listBranches(directory, 'proyecto')).current, 'otra');
  assert.equal(await readFile(path.join(project, 'otro.txt'), 'utf8'), 'contenido');
  assert.deepEqual(pushes, ['HEAD:refs/heads/main', 'HEAD:refs/heads/feature/prueba', 'HEAD:refs/heads/feature/prueba', 'HEAD:refs/heads/main', 'HEAD:refs/heads/main', 'HEAD:refs/heads/feature/prueba', 'HEAD:refs/heads/otra']);
});

test('conserva la nueva rama seleccionada si falla su publicación y permite reintentar', async (t) => {
  const directory = await fixture(t);
  const project = path.join(directory, 'proyecto');
  let fail = true;
  const runner = async (command, args, options) => {
    if (!args.includes('push')) return exec(command, args, options);
    if (fail && args.at(-1) === 'HEAD:refs/heads/nueva') throw new Error('fallo de red');
  };
  await initializeProject(directory, 'proyecto', config, runner);
  await assert.rejects(changeBranch(directory, 'proyecto', 'nueva', true, config, runner), /creada y seleccionada localmente/);
  assert.equal((await listBranches(directory, 'proyecto')).current, 'nueva');
  assert.equal((await exec('git', ['rev-list', '--count', 'HEAD'], { cwd: project })).stdout.trim(), '1');
  fail = false;
  const result = await commitProject(directory, 'proyecto', 'reintentar', config, runner);
  assert.equal(result.committed, false);
});

test('commit con mensaje y push; reintenta un push fallido sin duplicar el commit', async (t) => {
  const directory = await fixture(t);
  const project = path.join(directory, 'proyecto');
  await initializeProject(directory, 'proyecto', config, async (command, args, options) => {
    if (!args.includes('push')) return exec(command, args, options);
  });
  await writeFile(path.join(project, 'nuevo.txt'), 'contenido');
  let failPush = true;
  let pushes = 0;
  let askpass;
  const runner = async (command, args, options) => {
    if (!args.includes('push')) return exec(command, args, options);
    pushes++;
    assert.equal(options.env.GITEA_AUTH_TOKEN, config.token);
    assert.equal(args.at(-1), 'HEAD:refs/heads/main');
    askpass = options.env.GIT_ASKPASS;
    if (failPush) throw new Error(config.token);
  };
  await assert.rejects(commitProject(directory, 'proyecto', 'nuevo mensaje', config, runner), (error) => error.message.includes('git push') && !error.message.includes(config.token));
  assert.equal((await exec('git', ['log', '-1', '--format=%s'], { cwd: project })).stdout.trim(), 'nuevo mensaje');
  await assert.rejects(readFile(askpass), { code: 'ENOENT' });
  failPush = false;
  const result = await commitProject(directory, 'proyecto', 'reintento', config, runner);
  assert.equal(result.committed, false);
  assert.equal(pushes, 2);
  assert.equal((await exec('git', ['rev-list', '--count', 'HEAD'], { cwd: project })).stdout.trim(), '2');
  await writeFile(path.join(project, 'automatico.txt'), 'mensaje automático');
  const automatic = await commitProject(directory, 'proyecto', '  ', config, runner);
  assert.equal(automatic.committed, true);
  assert.match((await exec('git', ['log', '-1', '--format=%s'], { cwd: project })).stdout.trim(), /^Commit \d{2}\/\d{2}\/\d{4}, \d{2}:\d{2}:\d{2}$/);
  await assert.rejects(commitProject(directory, 'proyecto', 123, config), { status: 400 });
});

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'gitea-project-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, 'proyecto'));
  return directory;
}

test('comprueba .git como carpeta o archivo y rechaza rutas externas', async (t) => {
  const directory = await fixture(t);
  assert.equal((await describeProject(directory, 'proyecto')).hasGit, false);
  await writeFile(path.join(directory, 'proyecto', '.git'), 'gitdir: otro');
  assert.equal((await describeProject(directory, 'proyecto')).hasGit, true);
  for (const name of ['..', '.', '../externa', '/tmp', 'otra\\carpeta', null, 123, {}, []]) {
    await assert.rejects(projectPath(directory, name), { status: 400 });
  }
  await symlink(path.join(directory, 'proyecto'), path.join(directory, 'enlace'));
  await assert.rejects(projectPath(directory, 'enlace'), { status: 400 });
  await assert.rejects(initializeProject(directory, 'proyecto', config), { status: 409 });
});

test('rechaza pushurl y múltiples destinos antes de guardar cambios o enviar credenciales', async (t) => {
  const directory = await fixture(t);
  const project = path.join(directory, 'proyecto');
  const runner = async (command, args, options) => {
    if (!args.includes('push')) return exec(command, args, options);
  };
  await initializeProject(directory, 'proyecto', config, runner);
  await writeFile(path.join(project, 'pendiente.txt'), 'sin guardar');
  const expected = 'https://gitea.example.com/tester/proyecto.git';
  for (const destinations of [['https://otro.example/repo.git'], [expected, 'https://otro.example/repo.git']]) {
    await exec('git', ['config', '--unset-all', 'remote.origin.pushurl'], { cwd: project }).catch(() => {});
    for (const destination of destinations) {
      await exec('git', ['config', '--add', 'remote.origin.pushurl', destination], { cwd: project });
    }
    const noPush = async (command, args, options) => {
      assert.equal(args.includes('push'), false);
      return exec(command, args, options);
    };
    await assert.rejects(commitProject(directory, 'proyecto', 'no guardar', config, noPush), /origin/);
    await assert.rejects(createTag(directory, 'proyecto', 'v1', config, noPush), { status: 409 });
    assert.equal((await exec('git', ['rev-list', '--count', 'HEAD'], { cwd: project })).stdout.trim(), '1');
    assert.equal((await exec('git', ['diff', '--cached', '--name-only'], { cwd: project })).stdout, '');
  }
});

test('ejecuta Git localmente, prepara main y origin sin guardar el token; simula solo el push', async (t) => {
  const directory = await fixture(t);
  const project = path.join(directory, 'proyecto');
  await writeFile(path.join(project, 'hola.txt'), 'hola');
  const calls = [];
  let askpass;
  const result = await initializeProject(directory, 'proyecto', config, async (command, args, options) => {
    calls.push(args);
    assert.equal(args.some((arg) => arg.includes(config.token)), false);
    if (args.includes('push')) {
      assert.equal(options.env.GITEA_AUTH_TOKEN, config.token);
      askpass = options.env.GIT_ASKPASS;
      assert.match(await readFile(askpass, 'utf8'), /GITEA_AUTH_TOKEN/);
      return;
    }
    return exec(command, args, options);
  });
  assert.equal(result.hasGit, true);
  assert.equal(calls.length, 10);
  assert.equal((await exec('git', ['branch', '--show-current'], { cwd: project })).stdout.trim(), 'main');
  assert.equal((await exec('git', ['log', '-1', '--format=%s|%an|%ae'], { cwd: project })).stdout.trim(), 'inicio|tester|tester@example.com');
  assert.equal((await exec('git', ['remote', 'get-url', 'origin'], { cwd: project })).stdout.trim(), 'https://gitea.example.com/tester/proyecto.git');
  assert.doesNotMatch(await readFile(path.join(project, '.git/config'), 'utf8'), /test-secret/);
  await assert.rejects(readFile(askpass), { code: 'ENOENT' });
});

test('valida configuración antes de modificar y no expone secretos si falla Git', async (t) => {
  const directory = await fixture(t);
  await assert.rejects(initializeProject(directory, 'proyecto', {}), { status: 400 });
  assert.equal((await describeProject(directory, 'proyecto')).hasGit, false);
  await assert.rejects(initializeProject(directory, 'proyecto', { ...config, url: 'http://inseguro.test' }), { status: 400 });
  await assert.rejects(initializeProject(directory, 'proyecto', config, async () => {
    throw new Error(config.token);
  }), (error) => error.message.includes('git init') && !error.message.includes(config.token));
});
