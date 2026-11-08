# Gitea Workspace

Interfaz web para explorar las carpetas de primer nivel de una ruta local e inicializar sus repositorios Git y enviarlos a Gitea.

## Iniciar

Para ejecutar directamente necesitas Node.js 22 o superior y Git instalado en el servidor. No requiere instalar dependencias de npm. Para Docker, sigue el apartado siguiente: la imagen incluye Node.js, Git y el cliente Docker con Buildx.

1. Configura `.env` (puedes copiar `.env.example` si no existe):

   ```dotenv
   DATA_PATH=./data
   WEB_PASSWORD=elige-una-contraseña-segura
   GITEA_USER=tu_usuario
   GITEA_EMAIL=tu_email@example.com
   GITEA_TOKEN=
   GITEA_URL=https://gitea.example.com/
   ```

   Se admiten rutas absolutas o relativas a la raíz del proyecto. Si hay espacios, usa comillas. Si no se configura, se utiliza `./data`. El directorio debe existir y tener permisos de lectura.

2. Arranca el servidor:

   ```sh
   npm start
   ```

3. Abre **http://localhost:8804**.

El botón **Actualizar** vuelve a leer las carpetas sin reiniciar. Los cambios en `.env` sí requieren reiniciar el servidor. Los archivos, enlaces simbólicos y subcarpetas anidadas no se muestran.

`.env` y el contenido de `data/` se excluyen de Git para no subir configuraciones locales ni proyectos ajenos.

Las variables `GITEA_USER`, `GITEA_EMAIL`, `GITEA_TOKEN` y `GITEA_URL` se utilizan para inicializar y enviar los proyectos. El token solo se entrega a Git en el servidor mediante un script temporal de autenticación: no se guarda en la URL remota ni se envía al navegador. En Docker se inyecta la configuración en tiempo de ejecución y se monta el directorio de proyectos como volumen.

## Ejecutar con Docker Compose

### Requisitos

- Servidor Linux con Docker Engine iniciado y Docker Compose v2 instalado (`docker version` y `docker compose version`). El motor se instala en el host, no dentro del contenedor.
- Acceso a Internet para descargar la imagen y sus paquetes, y acceso desde el contenedor a Gitea y su registro HTTPS.
- Carpeta de proyectos existente, con permisos de lectura y escritura para el usuario de la aplicación.

### Configuración y arranque

1. Copia `.env.example` a `.env` **solo si todavía no tienes `.env`**. Configura una contraseña segura y los valores `GITEA_*`, incluido el token con permisos sobre repositorios y paquetes.
2. Configura `DATA_PATH` con la carpeta del **host** que contiene tus proyectos, por ejemplo `/srv/proyectos`. Puedes mantener `./data`, pero debe existir. Dentro del contenedor siempre se utiliza `/data`. No montes `.env`: Compose pasa las variables al arrancar y la imagen no incluye secretos ni proyectos.
3. Consulta los identificadores del usuario propietario de los proyectos y del grupo del socket:

   ```sh
   id -u
   id -g
   stat -c '%g' /var/run/docker.sock
   ```

   Guarda esos valores en `.env` como `APP_UID`, `APP_GID` y `DOCKER_GID`, respectivamente. Los dos primeros deben coincidir con el propietario de los proyectos; si pertenecen a otro usuario, consulta sus identificadores. Así Git no rechaza los repositorios por propiedad distinta y los archivos nuevos conservan el usuario correcto. No necesitas ejecutar como root ni dar permisos `666` al socket.
4. Construye y arranca desde la raíz del proyecto:

   ```sh
   docker compose up -d --build
   docker compose ps
   docker compose logs -f workspace
   ```

Abre **http://localhost:8804** en el servidor. El puerto se publica solo en localhost por seguridad. Para entrar desde otros equipos, configura `WEB_BIND_IP=0.0.0.0`, aplica las reglas de firewall apropiadas y utiliza un proxy con HTTPS. `WEB_PORT` cambia el puerto del host. El valor local de `HOST` se sustituye automáticamente por `0.0.0.0` dentro del contenedor.

Incluye comprobación HTTP de salud, reinicio automático y un proceso init para recoger procesos hijos. Los logs utilizan la configuración predeterminada del motor Docker; configura su rotación en el host para limitar el espacio ocupado. Las rutas de los volúmenes deben existir antes del arranque: el formato corto puede crear directorios si faltan. No necesita base de datos ni volúmenes adicionales: los archivos y repositorios persisten en `DATA_PATH`; las sesiones y credenciales temporales no se conservan al recrear el contenedor.

### Docker desde la aplicación

La imagen contiene el **cliente** Docker y Buildx, no un segundo daemon. El socket del host permite construir, enviar y eliminar imágenes con su motor. Comprueba las herramientas y la conexión:

```sh
docker compose exec workspace git --version
docker compose exec workspace docker version
docker compose exec workspace docker buildx version
```

**Importante:** acceder al socket Docker equivale en la práctica a permisos de administrador sobre el host. Solo deben acceder usuarios y proyectos de confianza. No se utiliza `privileged`, pero el socket sigue dando esos privilegios. Las imágenes y cachés ocupan espacio en el host.

Para Docker rootless, ajusta `DOCKER_SOCKET` a su ruta real (por ejemplo `/run/user/1000/docker.sock`) y `DOCKER_GID` al grupo de ese socket. Si Gitea está en el propio servidor, no uses `localhost` en `GITEA_URL`: dentro del contenedor se refiere al contenedor. Utiliza un nombre DNS accesible desde él y certificados HTTPS válidos.

### Actualizar y detener

```sh
docker compose up -d --build
docker compose down
```

El primer comando reconstruye y aplica también cambios de `.env`; `restart` no actualiza las variables de Compose. El segundo elimina el contenedor, pero no los proyectos del host. Haz copias de seguridad de `DATA_PATH` y guarda `.env` de forma segura.

## Inicializar un proyecto

Pulsa el nombre de una carpeta para ver su contenido. Primero se comprueba si existe `.git` local (directorio o archivo). Si existe, no se consulta Gitea ni se muestran botones de creación o inicialización. Solo si falta `.git` se consulta en Gitea si existe `GITEA_USER/nombre-carpeta`, usando `GITEA_TOKEN` exclusivamente desde el servidor.

Si no existe, aparece **Crear repositorio Gitea**. Tras confirmar, se crea con `POST /api/v1/user/repos`, `private: true` y `auto_init: false`. Se verifica que el token pertenezca a `GITEA_USER`. Si hay errores de conexión o permisos, no se considera que el repositorio esté ausente y se bloquean las acciones hasta poder comprobarlo. **Actualizar estado** permite volver a consultar.

Una vez exista el remoto, se muestra **Iniciar .git** únicamente si no existe `.git` local (directorio o archivo). Crear el repositorio remoto no inicializa ni envía archivos automáticamente.

Al confirmar, se ejecutan en esa carpeta `git init`, `git checkout -b main`, la configuración local de usuario y email, `git add .`, `git commit -m "inicio"`, `git remote add origin` y `git push -u origin main`. Se permite un commit vacío para carpetas sin archivos y se desactivan hooks y firma del commit para evitar interacciones del servidor.

El remoto se construye como `GITEA_URL/GITEA_USER/nombre-carpeta.git`. El repositorio remoto debe estar vacío para la primera subida, y el token debe tener permisos de consulta, creación de repositorios y escritura. Puedes crearlo desde la web con el botón anterior. La inicialización vuelve a comprobar su existencia antes de modificar los archivos locales y no sobrescribe historiales con un push forzado.

Revisa `.gitignore` antes de confirmar: `git add .` incluye todos los archivos no ignorados, también posibles secretos. Si falla un paso, se detiene la secuencia y se conservan los pasos ya realizados. La presencia de `.git` impide repetir la inicialización. Si ya se crearon el commit y `origin`, puedes reintentar el envío con **Commit y push**; si el fallo fue anterior, completa la configuración local manualmente.

## Desarrollo

### Guardar cambios posteriores

Cuando existe `.git`, aparece un campo opcional de mensaje y **Commit y push**. Si el mensaje está vacío o contiene solo espacios, se usa `Commit <fecha y hora>`, por ejemplo `Commit 08/11/2026, 16:30:00`, en la zona configurada con `TZ=Europe/Madrid` en `.env` (incluido el horario de verano). Añade todos los cambios no ignorados (`git add .`), crea el commit con el mensaje y hace push a la rama actual de `origin`, sin forzar. Se verifica que `origin` coincida con el repositorio HTTPS configurado antes de operar y se usa el token sin guardarlo en la URL.

Si falla el push, el commit local se conserva. Puedes repetir con el mismo botón: si no hay cambios nuevos, no crea otro commit y solo reintenta el push. No se realizan pull, merges ni resolución automática de conflictos.

```sh
npm run dev
npm test
```

El servidor escucha por defecto en `127.0.0.1:8804`. Para permitir acceso desde la red o desde fuera de un contenedor, configura `HOST=0.0.0.0` explícitamente. `WEB_PASSWORD` es obligatoria al arrancar y protege la web y la API. El navegador conserva una cookie de sesión HttpOnly y SameSite=Strict durante **30 días**, sin guardar la contraseña. Reiniciar el servidor o cambiar la contraseña e iniciar de nuevo invalida las sesiones. Para acceso remoto, utiliza un proxy con HTTPS y configura `X-Forwarded-Proto: https` para activar también el atributo Secure de la cookie. Las comprobaciones de origen no sustituyen a la autenticación.

Solo deben montarse proyectos de confianza: Git puede ejecutar filtros definidos en su configuración y Docker ejecuta instrucciones del Dockerfile con acceso al daemon. El aislamiento del directorio y la desactivación de hooks no convierten estos proyectos en código seguro.
### Gestionar ramas

Debajo de **Commit y push**, la sección **Ramas** muestra la rama actual y permite seleccionar otra rama local o crear una nueva desde la actual y pasar a ella. No consulta Gitea ni descarga ramas remotas.

Antes de crear o cambiar de rama, si hay cambios pendientes (incluidos archivos nuevos no ignorados), se ejecuta `git add .` y se crea un commit en la rama actual con el mensaje `Cambios antes de cambiar a <rama>`, usando el usuario y email configurados. Después hace push de la rama actual, también si solo hay commits pendientes. Si falla el commit o el push, no cambia de rama y conserva cualquier commit creado para reintentar sin duplicarlo. Seleccionar la misma rama no ejecuta estas operaciones.

Las operaciones usan `git switch` sin forzar ni descartar cambios. Al crear una rama, después de seleccionarla también se hace push de la nueva rama a Gitea y se configura su seguimiento remoto, sin crear otro commit. Si falla ese envío, la rama queda creada y seleccionada localmente: puedes reintentar con **Commit y push**.

### Docker

El apartado **Docker**, debajo de **Etiquetas**, solo aparece si existe un archivo `Dockerfile` o `dockerfile` en la raíz del proyecto. Permite seleccionar una etiqueta Git local o escribir una versión manual (tiene prioridad). Construye el contenido actual de la carpeta, no un checkout de la etiqueta seleccionada; no hace commit ni cambia de rama.

Ejecuta `docker login` en el host de `GITEA_URL` (HTTPS) con el usuario y token de `.env`, `docker build -f <Dockerfile o dockerfile> -t <host>/<usuario>/<carpeta>:<version> .`, `docker push` y, tras un push correcto, `docker image rm` sin forzar. Muestra una barra de actividad, la etapa y la salida/errores en directo. No calcula un porcentaje global.

Necesita Docker instalado y acceso al daemon desde el servidor, un Dockerfile en el proyecto y permisos de escritura de paquetes en Gitea. Los nombres de usuario y carpeta deben ser compatibles con Docker y estar en minúsculas. Revisa `.dockerignore`: Git y Docker no comparten las exclusiones y podrían incluirse secretos. Las credenciales se pasan por stdin y se guardan solo en una configuración temporal que se elimina al terminar. Los logs de construcción se muestran en la web: no imprimas secretos desde el Dockerfile.

Si falla login/build/push, no continúa ni elimina la imagen local. Si falla la limpieza tras el push, informa de que la imagen ya está publicada. La limpieza elimina la referencia local, no toda la caché de construcción ni imágenes compartidas; no ejecuta `prune`. Volver a usar una versión puede actualizar esa etiqueta en el registro.

### Crear etiquetas

Debajo de **Ramas**, **Etiquetas** permite escribir un nombre (por ejemplo `v1.0.0`) y pulsar **Crear y enviar a Gitea**. Primero guarda todos los cambios no ignorados con el mensaje `Cambios antes de crear la etiqueta <nombre>` y hace push de la rama actual. Si no hay cambios, solo hace push. Si falla ese paso o quedan cambios pendientes, no crea la etiqueta.

Después crea una etiqueta ligera en el commit actual y envía únicamente esa etiqueta, sin forzar. Si falla el envío, la etiqueta local se conserva: repite con el mismo nombre para reenviarla. Un nombre que ya existe localmente solo reenvía esa etiqueta, sin moverla ni incluir cambios posteriores; para etiquetar una versión nueva, usa otro nombre. Nunca sobrescribe etiquetas remotas distintas.
