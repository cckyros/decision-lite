import { spawn } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { manifest } from './manifest.mjs';

export const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const ownedMarker = `${manifest.name}:managed`;
const packageEntries = [
  'package.json', 'plugin.json', 'mcp.json', '.mcp.json', 'marketplace.json',
  'openclaw.plugin.json', 'dsh.plugin.json', 'cordis.patch.yml', 'dist',
  'openclaw-dist', 'skills', 'python',
];

export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function result(status, detail) {
  return { status, detail };
}

export function runtimeRoot(ctx) {
  return ctx.scope === 'global'
    ? join(ctx.home, manifest.markers.configDir, 'plugin')
    : join(ctx.dir, manifest.markers.configDir, 'plugin');
}

export function runtimeCliPath(ctx) {
  return join(runtimeRoot(ctx), 'dist', 'cli.mjs');
}

export function serverEntry(ctx, shape = 'standard', root = runtimeRoot(ctx)) {
  const cliPath = join(root, 'dist', 'cli.mjs');
  const command = process.execPath;
  const args = [cliPath, 'mcp'];
  if (shape === 'local') return { type: 'local', command: [command, ...args], enabled: true };
  return {
    ...(shape === 'stdio' ? { type: 'stdio' } : {}),
    command,
    args,
    env: { DECISION_LOG: join(root, 'decisions.jsonl'), ...(ctx.serverEnv ?? {}) },
  };
}

function backupFile(file) {
  if (!existsSync(file)) return null;
  let backup = `${file}.bak`;
  let suffix = 1;
  while (existsSync(backup)) backup = `${file}.bak.${suffix++}`;
  copyFileSync(file, backup);
  return backup;
}

export function readJsonObject(file) {
  if (!existsSync(file)) return { missing: true, data: {} };
  let data;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return { manual: `${file} is not valid JSON (JSONC files are left untouched)` };
  }
  if (!isPlainObject(data)) return { manual: `${file} is not a JSON object — left untouched` };
  return { data };
}

export function writeJsonObject(file, data, ctx) {
  if (ctx.dryRun) return { changed: true, detail: `[dry-run] would write ${file}` };
  const backup = backupFile(file);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  return { changed: true, backup };
}

function managedEntry(entry) {
  const values = [];
  const visit = (value) => {
    if (typeof value === 'string') values.push(value);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (isPlainObject(value)) Object.values(value).forEach(visit);
  };
  visit(entry);
  return values.some((value) => value.includes(manifest.name) || value.includes(manifest.markers.configDir));
}

export function mergeJsonServer(file, key, name, entry, ctx) {
  const loaded = readJsonObject(file);
  if (loaded.manual) return result('manual', loaded.manual);
  const data = loaded.data;
  const current = data[key];
  if (current !== undefined && !isPlainObject(current)) {
    return result('manual', `"${key}" is not an object in ${file} — left untouched`);
  }
  const servers = current ?? {};
  const existing = servers[name];
  if (existing !== undefined) {
    if (!managedEntry(existing)) return result('manual', `${file} already has a different "${name}" entry — left untouched`);
    if (JSON.stringify(existing) === JSON.stringify(entry) || !ctx.update) {
      return result('ok', `${key}["${name}"] already present in ${file} — idempotent`);
    }
  }
  data[key] = { ...servers, [name]: entry };
  const written = writeJsonObject(file, data, ctx);
  return result('ok', `${written.detail ?? `added ${key}["${name}"] to ${file}`}${written.backup ? ` (backup: ${written.backup})` : ''}`);
}

export function removeJsonServer(file, key, name, ctx) {
  const loaded = readJsonObject(file);
  if (loaded.missing) return result('ok', `no ${file} — nothing to remove`);
  if (loaded.manual) return result('manual', loaded.manual);
  const servers = loaded.data[key];
  if (!isPlainObject(servers) || !(name in servers)) return result('ok', `no ${key}["${name}"] entry in ${file}`);
  if (!managedEntry(servers[name])) return result('manual', `${key}["${name}"] in ${file} does not look managed by ${manifest.name} — kept`);
  const next = { ...servers };
  delete next[name];
  if (Object.keys(next).length) loaded.data[key] = next;
  else delete loaded.data[key];
  const written = writeJsonObject(file, loaded.data, ctx);
  return result('ok', `${written.detail ?? `removed ${key}["${name}"] from ${file}`}${written.backup ? ` (backup: ${written.backup})` : ''}`);
}

export function ensurePortablePackage(ctx) {
  const dest = runtimeRoot(ctx);
  const markerFile = join(dest, '.decision-lite-managed');
  const required = packageEntries.filter((entry) => !existsSync(join(packageRoot, entry)));
  if (required.length) return result('error', `package build files missing (${required.join(', ')}); run npm run build first`);
  if (existsSync(dest) && (!existsSync(markerFile) || readFileSync(markerFile, 'utf8').trim() !== ownedMarker)) {
    return result('manual', `${dest} exists without the ${manifest.name} ownership marker — left untouched`);
  }
  if (ctx.dryRun) return result('ok', `[dry-run] would materialize ${packageRoot} at ${dest}`);
  mkdirSync(dest, { recursive: true });
  for (const entry of packageEntries) cpSync(join(packageRoot, entry), join(dest, entry), { recursive: true, force: true });
  writeFileSync(markerFile, `${ownedMarker}\n`, 'utf8');
  const mcp = {
    $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
    mcpServers: { [manifest.name]: serverEntry(ctx, 'stdio', dest) },
  };
  const text = `${JSON.stringify(mcp, null, 2)}\n`;
  writeFileSync(join(dest, 'mcp.json'), text, 'utf8');
  writeFileSync(join(dest, '.mcp.json'), text, 'utf8');
  return result('ok', `portable package ready at ${dest}`);
}

export function writeManagedFile(file, content, marker, ctx) {
  if (ctx.dryRun) return result('ok', `[dry-run] would write ${file}`);
  const current = existsSync(file) ? readFileSync(file, 'utf8') : null;
  if (current === content) return result('ok', `${file} already current — idempotent`);
  if (current !== null && !current.includes(marker)) return result('manual', `${file} exists without the ${manifest.name} marker — left untouched`);
  const backup = backupFile(file);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content, 'utf8');
  return result('ok', `wrote ${file}${backup ? ` (backup: ${backup})` : ''}`);
}

export function removeManagedFile(file, marker, ctx) {
  if (!existsSync(file)) return result('ok', `not present: ${file}`);
  const content = readFileSync(file, 'utf8');
  if (!content.includes(marker)) return result('skipped', `${file} has no ownership marker — kept`);
  if (ctx.dryRun) return result('ok', `[dry-run] would remove ${file}`);
  rmSync(file, { force: true });
  return result('ok', `removed ${file}`);
}

export function findCli(name, env = process.env) {
  const dirs = (env.PATH ?? '').split(delimiter).filter(Boolean);
  const extensions = process.platform === 'win32'
    ? (env.PATHEXT ?? '.EXE;.CMD;.BAT;.PS1').split(';')
    : [''];
  for (const dir of dirs) {
    for (const ext of extensions) {
      const candidate = name.includes('.') ? join(dir, name) : join(dir, `${name}${ext}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function winQuote(value) {
  return `"${value.replace(/"/g, '""')}"`;
}

export function runCli(bin, args, { env = process.env, cwd, timeoutMs = 30_000 } = {}) {
  return new Promise((resolvePromise) => {
    const windowsShim = process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin);
    const command = windowsShim ? (env.ComSpec || 'cmd.exe') : bin;
    const argv = windowsShim
      ? ['/d', '/s', '/c', [winQuote(bin), ...args.map(winQuote)].join(' ')]
      : args;
    const child = spawn(command, argv, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false });
    let stdout = '', stderr = '', settled = false;
    const finish = (value) => { if (!settled) { settled = true; clearTimeout(timer); resolvePromise(value); } };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (text) => { stdout += text; });
    child.stderr.on('data', (text) => { stderr += text; });
    const timer = setTimeout(() => { child.kill(); finish({ code: -1, stdout, stderr: `${stderr}\ncommand timed out after ${timeoutMs}ms` }); }, timeoutMs);
    child.on('error', (error) => finish({ code: -1, stdout, stderr: error.message }));
    child.on('close', (code) => finish({ code: code ?? -1, stdout, stderr }));
  });
}

export function appDataDir(home, env = process.env) {
  if (process.platform === 'win32') return env.APPDATA || join(home, 'AppData', 'Roaming');
  return join(home, '.config');
}

export function removeManagedDirectory(dir, ctx) {
  const markerFile = join(dir, '.decision-lite-managed');
  if (!existsSync(dir)) return result('ok', `not present: ${dir}`);
  if (!existsSync(markerFile) || readFileSync(markerFile, 'utf8').trim() !== ownedMarker) {
    return result('skipped', `${dir} has no ownership marker — kept`);
  }
  if (ctx.dryRun) return result('ok', `[dry-run] would remove ${dir}`);
  rmSync(dir, { recursive: true, force: true });
  return result('ok', `removed ${dir}`);
}
