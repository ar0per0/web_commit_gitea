import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const filter = source.slice(source.indexOf('function filterGiteaProjects()'), source.indexOf("giteaSearch.addEventListener('input'"));

function search(names, query, loaded = true) {
  const context = {
    giteaLoaded: loaded,
    giteaSearch: { value: query },
    giteaList: { children: names.map(projectName => ({ dataset: { projectName }, hidden: false })) },
    giteaCount: { textContent: '—' },
    giteaStatus: { hidden: false, textContent: 'Cargando proyectos de Gitea…' },
  };
  runInNewContext(`${filter}\nfilterGiteaProjects();`, context);
  return context;
}

test('busca por parte del nombre sin distinguir mayúsculas y recorta espacios', () => {
  const result = search(['MiProyecto', 'otro', 'proyecto-web'], ' PROYECTO ');
  assert.deepEqual(result.giteaList.children.map(item => item.hidden), [false, true, false]);
  assert.equal(result.giteaCount.textContent, 2);
  assert.equal(result.giteaStatus.hidden, true);
  assert.equal(search(['uno', 'dos'], '').giteaCount.textContent, 2);
});

test('distingue búsquedas sin coincidencias de una lista sin proyectos pendientes', () => {
  const result = search(['uno'], 'dos');
  assert.equal(result.giteaCount.textContent, 0);
  assert.equal(result.giteaStatus.hidden, false);
  assert.equal(result.giteaStatus.textContent, 'No hay proyectos que coincidan con la búsqueda.');
  assert.equal(search([], 'dos').giteaStatus.textContent, 'No hay proyectos de Gitea pendientes de descargar.');
});

test('no reemplaza el estado mientras los proyectos no están cargados', () => {
  const result = search([], 'proyecto', false);
  assert.equal(result.giteaCount.textContent, '—');
  assert.equal(result.giteaStatus.textContent, 'Cargando proyectos de Gitea…');
});
