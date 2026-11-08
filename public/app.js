const themeToggle = document.querySelector('#theme-toggle');
const logout = document.querySelector('#logout');
logout.addEventListener('click', async () => {
  logout.disabled = true;
  try {
    const response = await fetch('/logout', { method: 'POST', headers: { 'X-Requested-With': 'GiteaWorkspace' } });
    if (!response.ok && response.status !== 401) throw new Error('No se ha podido cerrar la sesión.');
    window.location.replace('/');
  } catch {
    window.alert('No se ha podido cerrar la sesión. Inténtalo de nuevo.');
    logout.disabled = false;
  }
});
const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
let savedTheme = null;
try {
  savedTheme = localStorage.getItem('theme');
} catch {}

function applyTheme() {
  const dark = savedTheme === 'dark' || (savedTheme !== 'light' && systemTheme.matches);
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
  themeToggle.querySelector('span').textContent = dark ? '☀' : '☾';
  themeToggle.title = dark ? 'Cambiar a modo claro' : 'Cambiar a modo oscuro';
  themeToggle.setAttribute('aria-label', 'Modo oscuro');
  themeToggle.setAttribute('aria-pressed', String(dark));
}

themeToggle.addEventListener('click', () => {
  savedTheme = document.documentElement.style.colorScheme === 'dark' ? 'light' : 'dark';
  try {
    localStorage.setItem('theme', savedTheme);
  } catch {}
  applyTheme();
});
systemTheme.addEventListener('change', applyTheme);
applyTheme();

const refresh = document.querySelector('#refresh');
const panel = document.querySelector('#panel');
const status = document.querySelector('#status');
const folders = document.querySelector('#folders');
const count = document.querySelector('#count');
const title = document.querySelector('#title');

async function loadFolders() {
  refresh.disabled = true;
  panel.setAttribute('aria-busy', 'true');
  status.hidden = false;
  status.className = '';
  status.textContent = 'Cargando carpetas…';
  count.textContent = '—';
  folders.replaceChildren();

  try {
    const response = await fetch('/api/folders');
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);

    for (const folder of data.folders) {
      const item = document.createElement('li');
      item.className = 'folder';
      const link = document.createElement('button');
      link.type = 'button';
      link.className = 'folder-link';
      link.addEventListener('click', () => openProject(folder.name));
      const icon = document.createElement('span');
      icon.className = 'folder-icon';
      icon.setAttribute('aria-hidden', 'true');
      icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10H3z" stroke-linejoin="round"/></svg>';
      const name = document.createElement('span');
      name.className = 'folder-name';
      name.textContent = folder.name;
      link.append(icon, name);
      item.append(link);
      folders.append(item);
    }
    count.textContent = data.folders.length;
    status.hidden = data.folders.length > 0;
    status.textContent = 'Todavía no hay carpetas. Añade tus proyectos al directorio configurado y pulsa Actualizar.';
  } catch (error) {
    status.className = 'error';
    status.textContent = error instanceof TypeError
      ? 'No se puede conectar con el servidor. Comprueba que sigue en marcha y vuelve a intentarlo.'
      : error.message;
  } finally {
    refresh.disabled = false;
    panel.setAttribute('aria-busy', 'false');
  }
}

refresh.addEventListener('click', loadFolders);
loadFolders();

const project = document.querySelector('#project');
const gitState = document.querySelector('#git-state');
const projectStatus = document.querySelector('#project-status');
const initGit = document.querySelector('#init-git');
const createRepo = document.querySelector('#create-repo');
const checkProject = document.querySelector('#check-project');
const back = document.querySelector('#back');
const commitForm = document.querySelector('#commit-form');
const commitMessage = document.querySelector('#commit-message');
const commitButton = document.querySelector('#commit-button');
const branchesPanel = document.querySelector('#branches');
const currentBranch = document.querySelector('#current-branch');
const titleBranch = document.querySelector('#title-branch');
const branchSelect = document.querySelector('#branch-select');
const branchName = document.querySelector('#branch-name');
const switchBranchForm = document.querySelector('#switch-branch-form');
const createBranchForm = document.querySelector('#create-branch-form');
const tagsPanel = document.querySelector('#tags');
const tagName = document.querySelector('#tag-name');
const createTagForm = document.querySelector('#create-tag-form');
const dockerPanel = document.querySelector('#docker');
const dockerForm = document.querySelector('#docker-form');
const dockerVersion = document.querySelector('#docker-version');
const dockerManual = document.querySelector('#docker-manual');
const dockerStatus = document.querySelector('#docker-status');
const dockerProgress = document.querySelector('#docker-progress');
const dockerOutput = document.querySelector('#docker-output');
let branchBusy = false;

function disableBranchControls(disabled) {
  for (const control of branchesPanel.querySelectorAll('input, select, button')) control.disabled = disabled;
  for (const control of tagsPanel.querySelectorAll('input, button')) control.disabled = disabled;
  for (const control of dockerPanel.querySelectorAll('input, select, button')) control.disabled = disabled;
}

async function loadTags(name) {
  const previous = dockerVersion.value;
  dockerVersion.replaceChildren();
  dockerVersion.append(new Option('', '', true, !previous));
  try {
    const response = await fetch(`/api/folder/tags?name=${encodeURIComponent(name)}`);
    const data = await response.json();
    if (selected !== name) return;
    if (!response.ok) throw new Error(data.error);
    for (const tag of data.tags) {
      const option = document.createElement('option');
      option.value = tag;
      option.textContent = tag;
      option.selected = tag === previous;
      dockerVersion.append(option);
    }
    if (!data.tags.length) dockerStatus.textContent = 'Sin etiquetas locales. Introduce una versión manual.';
  } catch (error) {
    if (selected === name) dockerStatus.textContent = error.message;
  }
}

dockerForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const name = selected;
  if (!name || branchBusy) return;
  const version = dockerManual.value.trim() || dockerVersion.value;
  if (!version) {
    dockerStatus.textContent = 'Selecciona una etiqueta o introduce una versión manual.';
    return;
  }
  branchBusy = true;
  disableBranchControls(true);
  commitButton.disabled = true;
  back.disabled = true;
  checkProject.disabled = true;
  dockerStatus.textContent = 'Ejecutando login, build, push y limpieza local… Puede tardar varios minutos.';
  dockerProgress.hidden = false;
  dockerOutput.hidden = false;
  dockerOutput.textContent = '';
  try {
    const response = await fetch(`/api/folder/docker?name=${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { 'X-Requested-With': 'GiteaWorkspace', 'Content-Type': 'application/json' },
      body: JSON.stringify({ version }),
    });
    if (!response.ok) throw new Error((await response.json()).error);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    let completed = false;
    while (true) {
      const { value, done } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      const lines = pending.split('\n');
      pending = lines.pop();
      for (const line of lines) {
        if (!line) continue;
        const data = JSON.parse(line);
        if (data.error) throw new Error(data.error);
        if (data.step) dockerStatus.textContent = `Docker: ${data.step}…`;
        if (data.log) {
          dockerOutput.textContent = `${dockerOutput.textContent}${data.log}\n`.slice(-100000);
          dockerOutput.scrollTop = dockerOutput.scrollHeight;
        }
        if (data.done) {
          completed = true;
          dockerStatus.textContent = data.message;
        }
      }
      if (done) break;
    }
    if (!completed) throw new Error('Conexión interrumpida. La operación puede continuar en el servidor; comprueba el registro antes de reintentar.');
  } catch (error) {
    dockerStatus.textContent = error.message;
  } finally {
    dockerProgress.hidden = true;
    branchBusy = false;
    disableBranchControls(false);
    commitButton.disabled = false;
    back.disabled = false;
    checkProject.disabled = false;
  }
});

async function loadBranches(name) {
  branchesPanel.hidden = false;
  currentBranch.textContent = 'Consultando ramas…';
  disableBranchControls(true);
  branchSelect.replaceChildren();
  try {
    const response = await fetch(`/api/folder/branches?name=${encodeURIComponent(name)}`);
    const data = await response.json();
    if (selected !== name) return;
    if (!response.ok) throw new Error(data.error);
    currentBranch.textContent = data.current ? `Rama actual: ${data.current}` : 'HEAD separado: selecciona una rama para continuar.';
    titleBranch.textContent = data.current || '';
    titleBranch.hidden = !data.current;
    for (const branch of data.branches) {
      const option = document.createElement('option');
      option.value = branch;
      option.textContent = branch;
      option.selected = branch === data.current;
      branchSelect.append(option);
    }
    disableBranchControls(branchBusy);
  } catch (error) {
    if (selected === name) currentBranch.textContent = error.message;
  } finally {
    if (selected === name) {
      // Un fallo de Git no debe bloquear las acciones independientes de Docker.
      for (const control of dockerPanel.querySelectorAll('input, select, button')) control.disabled = branchBusy;
    }
  }
}

async function submitBranch(event, action) {
  event.preventDefault();
  const name = selected;
  if (!name || branchBusy) return;
  const branch = action === 'create' ? branchName.value : branchSelect.value;
  branchBusy = true;
  disableBranchControls(true);
  commitButton.disabled = true;
  back.disabled = true;
  checkProject.disabled = true;
  projectStatus.textContent = 'Guardando y enviando la rama actual antes de cambiar…';
  try {
    const response = await fetch(`/api/folder/branch?name=${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { 'X-Requested-With': 'GiteaWorkspace', 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, branch }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    projectStatus.textContent = data.message;
    if (action === 'create') branchName.value = '';
  } catch (error) {
    projectStatus.textContent = error.message;
  } finally {
    branchBusy = false;
    await loadBranches(name);
    commitButton.disabled = false;
    back.disabled = false;
    checkProject.disabled = false;
  }
}

switchBranchForm.addEventListener('submit', (event) => event.preventDefault());
branchSelect.addEventListener('change', (event) => submitBranch(event, 'switch'));
createBranchForm.addEventListener('submit', (event) => submitBranch(event, 'create'));
createTagForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const name = selected;
  if (!name || branchBusy) return;
  branchBusy = true;
  disableBranchControls(true);
  commitButton.disabled = true;
  back.disabled = true;
  checkProject.disabled = true;
  projectStatus.textContent = 'Guardando y enviando cambios antes de crear y enviar la etiqueta…';
  try {
    const response = await fetch(`/api/folder/tag?name=${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { 'X-Requested-With': 'GiteaWorkspace', 'Content-Type': 'application/json' },
      body: JSON.stringify({ tag: tagName.value }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    projectStatus.textContent = data.message;
    tagName.value = '';
    await loadTags(name);
  } catch (error) {
    projectStatus.textContent = error.message;
  } finally {
    branchBusy = false;
    disableBranchControls(false);
    commitButton.disabled = false;
    back.disabled = false;
    checkProject.disabled = false;
  }
});
let selected = null;

async function openProject(name, keepMessage = false) {
  if (selected !== name) {
    commitMessage.value = '';
    tagName.value = '';
    dockerManual.value = '';
    dockerVersion.replaceChildren();
    dockerStatus.textContent = '';
    dockerOutput.textContent = '';
    dockerOutput.hidden = true;
  }
  selected = name;
  titleBranch.hidden = true;
  document.querySelector('.intro').classList.add('project-intro');
  panel.hidden = true;
  project.hidden = false;
  refresh.hidden = true;
  title.textContent = name;
  document.title = `Commit Gitea · ${name}`;
  document.querySelector('.brand-icon').href = `/gitea?name=${encodeURIComponent(name)}`;
  gitState.textContent = 'Comprobando .git…';
  initGit.hidden = true;
  createRepo.hidden = true;
  commitForm.hidden = true;
  branchesPanel.hidden = true;
  tagsPanel.hidden = true;
  dockerPanel.hidden = true;
  if (!keepMessage) projectStatus.textContent = '';
  try {
    const response = await fetch(`/api/folder?name=${encodeURIComponent(name)}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    if (selected !== name) return;
    const localState = 'Esta carpeta todavía no contiene .git.';
    gitState.textContent = data.hasGit ? '' : data.remoteExists === null
      ? `${data.remoteError} ${localState}`
      : `${data.remoteExists ? 'El repositorio existe en Gitea.' : 'El repositorio no existe en Gitea.'} ${localState}`;
    createRepo.hidden = data.remoteExists !== false;
    initGit.hidden = data.remoteExists !== true || data.hasGit;
    commitForm.hidden = !data.hasGit;
    tagsPanel.hidden = !data.hasGit;
    dockerPanel.hidden = !data.hasDockerfile;
    if (data.hasGit) {
      await Promise.all([loadBranches(name), loadTags(name)]);
    } else {
      disableBranchControls(branchBusy);
      dockerStatus.textContent = 'Introduce una versión manual; no hay etiquetas Git locales.';
    }
  } catch (error) {
    if (selected !== name) return;
    gitState.textContent = 'No se ha podido comprobar .git.';
    projectStatus.textContent = error.message;
  }
}

back.addEventListener('click', () => {
  selected = null;
  titleBranch.hidden = true;
  document.querySelector('.intro').classList.remove('project-intro');
  title.textContent = 'Tus proyectos';
  document.title = 'Commit Gitea';
  document.querySelector('.brand-icon').href = '/gitea';
  project.hidden = true;
  panel.hidden = false;
  refresh.hidden = false;
  loadFolders();
});

initGit.addEventListener('click', async () => {
  const name = selected;
  if (!name || !window.confirm(`Se añadirá todo el contenido no excluido por .gitignore de «${name}», se creará el commit "inicio" y se enviará a Gitea. Revisa que no incluya contraseñas ni archivos privados. El repositorio remoto debe existir y estar vacío. ¿Continuar?`)) return;
  initGit.disabled = true;
  back.disabled = true;
  checkProject.disabled = true;
  projectStatus.textContent = 'Inicializando y enviando a Gitea. Espera, puede tardar unos minutos…';
  try {
    const response = await fetch(`/api/folder/init?name=${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { 'X-Requested-With': 'GiteaWorkspace' },
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    projectStatus.textContent = data.message;
  } catch (error) {
    projectStatus.textContent = error.message;
  } finally {
    await openProject(name, true);
    initGit.disabled = false;
    back.disabled = false;
    checkProject.disabled = false;
  }
});

checkProject.addEventListener('click', () => openProject(selected));

commitForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const name = selected;
  if (!name || branchBusy) return;
  branchBusy = true;
  commitButton.disabled = true;
  commitMessage.disabled = true;
  back.disabled = true;
  checkProject.disabled = true;
  projectStatus.textContent = 'Creando commit y enviando a Gitea…';
  disableBranchControls(true);
  try {
    const response = await fetch(`/api/folder/commit?name=${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { 'X-Requested-With': 'GiteaWorkspace', 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: commitMessage.value }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    projectStatus.textContent = data.message;
    if (data.committed) commitMessage.value = '';
  } catch (error) {
    projectStatus.textContent = error.message;
  } finally {
    await openProject(name, true);
    commitButton.disabled = false;
    branchBusy = false;
    disableBranchControls(false);
    commitMessage.disabled = false;
    back.disabled = false;
    checkProject.disabled = false;
  }
});

createRepo.addEventListener('click', async () => {
  const name = selected;
  if (!name || !window.confirm(`¿Crear el repositorio privado y vacío «${name}» en Gitea? No se enviarán archivos todavía.`)) return;
  createRepo.disabled = true;
  back.disabled = true;
  checkProject.disabled = true;
  projectStatus.textContent = 'Creando repositorio en Gitea…';
  try {
    const response = await fetch(`/api/folder/repository?name=${encodeURIComponent(name)}`, {
      method: 'POST', headers: { 'X-Requested-With': 'GiteaWorkspace' },
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    projectStatus.textContent = data.message;
  } catch (error) {
    projectStatus.textContent = error.message;
  } finally {
    await openProject(name, true);
    createRepo.disabled = false;
    back.disabled = false;
    checkProject.disabled = false;
  }
});
