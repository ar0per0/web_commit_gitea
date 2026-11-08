# Revisión técnica — 8 de noviembre de 2026

## Alcance y validación

Revisión de todos los módulos de `src/`, JavaScript, HTML y CSS de `public/`, pruebas, documentación y archivos de configuración de ejemplo. No se han leído secretos de `.env` ni modificado proyectos de `data/`.

`npm test`: 27 pruebas correctas. Git se ejecuta realmente sobre repositorios temporales; los envíos remotos y Docker se simulan. No se ha verificado un despliegue real contra Gitea/Docker ni realizado una prueba visual en navegador. Entorno de validación: Node.js 26.13.0; falta comprobar también Node.js 22, la versión mínima declarada. La configuración Compose se valida sin desplegar ni mostrar sus secretos.

## Correcciones aplicadas

- **Sesiones:** validación estricta del formato completo de la cookie, compartida por autenticación y cierre de sesión. Antes se podía eludir la revocación añadiendo un sufijo al token. Las pruebas verifican el rechazo de sufijos antes y después del logout.
- **Compose:** construcción local con `build: .`, contraseña obligatoria y variables de configuración tomadas del entorno o `.env`, sin credenciales fijas. Puerto publicado en localhost por defecto; usuario, grupo, ruta de datos, socket y puerto configurables. Dentro del contenedor se fijan `HOST=0.0.0.0` y `DATA_PATH=/data`.
- **Enlace Gitea:** el proyecto seleccionado y la vuelta a carpetas actualizan el enlace `.brand-icon`, no el contenedor sin navegación.
- **Destinos Git:** comprobar solo la URL de lectura de `origin` permitía que `pushurl` enviara el código y solicitara credenciales para otro servidor. Ahora se comprueban todos los destinos efectivos de push antes de guardar cambios o publicar. Se rechazan destinos múltiples.
- **Configuración de push:** se desactivan mirror, envío automático de etiquetas, publicación recursiva de submódulos y redirecciones HTTP en las operaciones de envío.
- **Servidor:** rutas como `/constructor` heredaban propiedades del objeto de recursos y podían provocar excepciones fuera del bloque de captura. Ahora solo se admiten propiedades propias y se capturan URLs inválidas.
- **JSON:** lectura con límite en bytes y decodificación al final para no corromper caracteres UTF-8 divididos entre paquetes. Se rechazan cuerpos que no sean objetos y se verifica la liberación del bloqueo después de errores.
- **Exposición:** escucha local por defecto, con `HOST` explícito para acceso de red. Cabeceras contra inclusión en marcos, filtración de referencias y carga de recursos ajenos.
- **Docker:** selección explícita del archivo de construcción, incluido `dockerfile` en minúsculas. Validación HTTPS de la configuración del registro.
- **Interfaz:** Docker deja de quedar bloqueado al entrar en un proyecto sin Git después de otro proyecto o cuando falla la consulta de ramas. Protección adicional contra envíos simultáneos desde formularios durante un commit.
- **Validaciones:** tipos de nombre de carpeta y respuesta nula de identidad de Gitea.
- **Documentación:** configuración de escucha, límites de confianza y recuperación de un push de inicialización fallido.

## Riesgos y mejoras pendientes

1. **Acceso remoto.** La aplicación exige `WEB_PASSWORD` en su arranque normal y protege la web y la API con una cookie HttpOnly y SameSite=Strict de 30 días. Usar una contraseña robusta y un proxy HTTPS que establezca `X-Forwarded-Proto: https` para activar Secure. El encabezado personalizado y la comprobación de origen son protecciones adicionales del navegador, no sustitutos de la autenticación. El límite de intentos es global: terceros pueden provocar bloqueos temporales del login. Las sesiones se invalidan al reiniciar el servidor.
2. **Proyectos de confianza.** Los filtros/configuraciones Git y los Dockerfiles pueden ejecutar código. El acceso al daemon Docker suele equivaler a privilegios elevados sobre el host. No montar proyectos de terceros sin aislamiento externo y permisos mínimos.
3. **Procesos Docker.** No existe tiempo máximo de ejecución ni cancelación administrativa. Si el cliente se desconecta, la publicación continúa y el bloqueo se mantiene hasta terminar. Diseñar trabajos persistentes con estado/cancelación antes de añadir límites arbitrarios que puedan interrumpir construcciones legítimas.
4. **Concurrencia externa.** Los bloqueos solo cubren una instancia del servidor. No protegen contra comandos Git manuales ni contra otra instancia usando los mismos proyectos. Ejecutar una sola instancia y evitar modificaciones externas durante las operaciones.
5. **Fallos parciales de inicialización.** Si falla antes de configurar el commit y `origin`, sigue siendo necesaria una recuperación manual. No se borran repositorios ni se revierten pasos automáticamente para evitar pérdidas.
6. **Cobertura adicional.** Añadir pruebas de interfaz en navegador y una integración opcional con Gitea y un registro Docker aislados. La suite actual no demuestra el funcionamiento real de autenticación de Git, credenciales Docker o renderizado móvil.

La aplicación dispone de autenticación propia sin dependencias adicionales. En esta revisión no se han modificado `.env`, proyectos de `data/` ni historiales Git de usuario. El archivo de pruebas `compose.yo.yaml` fue eliminado por el usuario y no forma parte del despliegue revisado.
