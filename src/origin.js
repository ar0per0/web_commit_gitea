// El proxy puede cambiar Host. Sec-Fetch-Site lo establece el navegador
// y el JavaScript de otras páginas no puede falsificarlo.
export function isSameOrigin(request) {
  const site = request.headers['sec-fetch-site'];
  if (site === 'same-origin') return true;
  if (site && site !== 'none') return false;
  const origin = request.headers.origin;
  return !origin || [`http://${request.headers.host}`, `https://${request.headers.host}`].includes(origin);
}
