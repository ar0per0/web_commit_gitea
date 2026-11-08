export function redact(value, secrets = []) {
  let text = String(value);
  for (const secret of secrets.filter(Boolean)) {
    text = text.split(secret).join('[REDACTED]');
    text = text.split(encodeURIComponent(secret)).join('[REDACTED]');
  }
  return text
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/((?:authorization|password|passwd|token|secret|cookie)["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;}]+)/gi, '$1[REDACTED]');
}

export function logError(error, context = {}, secrets = []) {
  const describe = (value, depth = 0) => value instanceof Error ? {
    name: value.name, message: value.message, stack: value.stack,
    code: value.code, status: value.status, details: value.details,
    command: value.cmd, stdout: value.stdout, stderr: value.stderr,
    signal: value.signal, killed: value.killed,
    ...(value.cause && depth < 3 ? { cause: describe(value.cause, depth + 1) } : {}),
  } : String(value);
  console.error(redact(JSON.stringify({
    timestamp: new Date().toISOString(), level: 'error', ...context, error: describe(error),
  }), secrets));
}
