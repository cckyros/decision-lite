import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { manifest } from './manifest.mjs';
import { packageRoot } from './installer-support.mjs';
import {
  appDataDir,
  ensurePortablePackage,
  ownedMarker,
  findCli,
  mergeJsonServer,
  readJsonObject,
  removeJsonServer,
  removeManagedDirectory,
  removeManagedFile,
  result,
  runCli,
  serverEntry,
  writeJsonObject,
  writeManagedFile,
} from './installer-support.mjs';

export const targetAdapters = [
  { id: 'claude', label: 'Claude Code', kind: 'native', scope: 'both' },
  { id: 'codex', label: 'Codex', kind: 'native', scope: 'both' },
  { id: 'opencode', label: 'OpenCode', kind: 'native', scope: 'both' },
  { id: 'qwen', label: 'Qwen Code', kind: 'native', scope: 'both' },
  { id: 'reasonix', label: 'Reasonix', kind: 'native', scope: 'both' },
  { id: 'kilo', label: 'Kilo Code', kind: 'native', scope: 'both' },
  { id: 'workbuddy', label: 'WorkBuddy', kind: 'native', scope: 'both' },
  { id: 'devin', label: 'Devin', kind: 'native', scope: 'both' },
  { id: 'trae', label: 'Trae', kind: 'skill', scope: 'project' },
  { id: 'pi', label: 'pi', kind: 'skill', scope: 'project' },
  { id: 'omp', label: 'Oh My Pi', kind: 'skill', scope: 'project' },
  { id: 'dsh', label: 'DeepSeek Harness', kind: 'skill', scope: 'project' },
  { id: 'copilot', label: 'GitHub Copilot', kind: 'plugin', scope: 'global' },
  { id: 'cursor', label: 'Cursor', kind: 'plugin', scope: 'global' },
  { id: 'kiro', label: 'Kiro', kind: 'plugin', scope: 'global' },
  { id: 'openclaw', label: 'OpenClaw', kind: 'plugin', scope: 'global' },
  { id: 'hermes', label: 'Hermes Agent', kind: 'plugin', scope: 'global' },
  { id: 'vscode', label: 'VS Code', kind: 'plugin', scope: 'global' },
  { id: 'chatgpt-codex', label: 'ChatGPT & Codex', kind: 'plugin', scope: 'global' },
  { id: 'grok', label: 'Grok', kind: 'plugin', scope: 'global' },
  { id: 'nanoclaw', label: 'NanoClaw', kind: 'plugin', scope: 'global' },
  { id: 'other', label: 'Other Agent Plugins client', kind: 'plugin', scope: 'global' },
];

const nativeIds = new Set(targetAdapters.filter((target) => target.kind === 'native').map(({ id }) => id));
const skillIds = new Set(targetAdapters.filter((target) => target.kind === 'skill').map(({ id }) => id));
const pluginIds = new Set(targetAdapters.filter((target) => target.kind === 'plugin').map(({ id }) => id));
const mcpServerName = manifest.name;

function appDataPath(home, env) {
  if (process.platform === 'win32') return env.APPDATA || join(home, 'AppData', 'Roaming');
  return join(home, '.config');
}

function nativeMcpLocation(id, ctx) {
  const global = ctx.scope === 'global';
  const appData = appDataPath(ctx.home, ctx.env);
  switch (id) {
    case 'claude': return { file: global ? join(ctx.home, '.claude.json') : join(ctx.dir, '.mcp.json'), key: 'mcpServers' };
    case 'opencode': return { file: global ? join(appData, 'opencode', 'opencode.json') : join(ctx.dir, 'opencode.json'), key: 'mcp', shape: 'local' };
    case 'qwen': return { file: global ? join(ctx.home, '.qwen', 'settings.json') : join(ctx.dir, '.qwen', 'settings.json'), key: 'mcpServers' };
    case 'kilo': return { file: global ? join(ctx.home, '.config', 'kilo', 'kilo.json') : join(ctx.dir, '.kilo', 'kilo.json'), key: 'mcp', shape: 'local' };
    case 'workbuddy': return { file: global ? join(ctx.home, '.codebuddy', '.mcp.json') : join(ctx.dir, '.mcp.json'), key: 'mcpServers', shape: 'stdio' };
    case 'devin': return { file: global ? join(appData, 'devin', 'mcp_config.json') : join(ctx.dir, '.devin', 'mcp_config.json'), key: 'mcpServers' };
    case 'reasonix': return global
      ? { file: join(process.platform === 'win32' ? appData : ctx.home, process.platform === 'win32' ? 'reasonix' : '.reasonix', 'config.toml'), key: 'plugins', shape: 'toml' }
      : { file: join(ctx.dir, '.mcp.json'), key: 'mcpServers' };
    default: return null;
  }
}

function tomlQuote(value) {
  return JSON.stringify(value);
}

function tomlSectionBlock(ctx) {
  const name = tomlQuote(mcpServerName);
  const entry = serverEntry(ctx);
  return [
    `[mcp_servers.${name}]`,
    `# ${manifest.markers.plugin}`,
    `command = ${tomlQuote(entry.command)}`,
    `args = ${JSON.stringify(entry.args)}`,
    '',
  ].join('\n');
}

function upsertTomlSection(file, section, ctx) {
  const header = `[${section}]`;
  const block = tomlSectionBlock(ctx).replace(`[mcp_servers.${tomlQuote(mcpServerName)}]`, header);
  const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const lines = current.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === header);
  let next = current;
  if (start >= 0) {
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      if (/^\s*\[\[?[^\]]+\]\]?\s*$/.test(lines[i])) { end = i; break; }
    }
    const existing = lines.slice(start, end).join('\n');
    if (!existing.includes(manifest.markers.plugin)) return result('manual', `${file} already has a non-managed ${header} section — left untouched`);
    if (existing.trim() === block.trim() || !ctx.update) return result('ok', `${header} already present in ${file} — idempotent`);
    next = [...lines.slice(0, start), ...block.trimEnd().split('\n'), ...lines.slice(end)].join('\n');
  } else {
    next = `${current.trimEnd()}${current.trim() ? '\n\n' : ''}${block}`;
  }
  if (ctx.dryRun) return result('ok', `[dry-run] would write ${header} to ${file}`);
  writeConfigText(file, next);
  return result('ok', `wrote ${header} to ${file}`);
}

function removeTomlSection(file, section, ctx) {
  const header = `[${section}]`;
  if (!existsSync(file)) return result('ok', `no ${file} — nothing to remove`);
  const current = readFileSync(file, 'utf8');
  const lines = current.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === header);
  if (start < 0) return result('ok', `no ${header} section in ${file}`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*\[\[?[^\]]+\]\]?\s*$/.test(lines[i])) { end = i; break; }
  }
  if (!lines.slice(start, end).join('\n').includes(manifest.markers.plugin)) {
    return result('manual', `${header} in ${file} has no Decision Lite marker — kept`);
  }
  if (ctx.dryRun) return result('ok', `[dry-run] would remove ${header} from ${file}`);
  const next = [...lines.slice(0, start), ...lines.slice(end)].join('\n').replace(/\n{3,}/g, '\n\n').trim();
  writeConfigText(file, next ? `${next}\n` : '');
  return result('ok', `removed ${header} from ${file}`);
}

function upsertReasonixBlock(file, ctx) {
  const start = `# ${manifest.name}:start`;
  const end = `# ${manifest.name}:end`;
  const entry = serverEntry(ctx);
  const block = [start, '[[plugins]]', `name = ${tomlQuote(manifest.name)}`, 'type = "stdio"', `command = ${tomlQuote(entry.command)}`, `args = ${JSON.stringify(entry.args)}`, end, ''].join('\n');
  const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const hasStart = current.includes(start), hasEnd = current.includes(end);
  if (hasStart !== hasEnd) return result('manual', `${file} has a partial Decision Lite plugin block — left untouched`);
  let next;
  if (hasStart) {
    const re = new RegExp(`${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}\\s*`);
    const existing = current.match(re)?.[0] ?? '';
    if (existing.trim() === block.trim() || !ctx.update) return result('ok', `Decision Lite plugin block already present in ${file} — idempotent`);
    next = current.replace(re, `${block}\n`);
  } else {
    next = `${current.trimEnd()}${current.trim() ? '\n\n' : ''}${block}`;
  }
  if (ctx.dryRun) return result('ok', `[dry-run] would write Decision Lite plugin block to ${file}`);
  writeConfigText(file, next);
  return result('ok', `wrote Decision Lite plugin block to ${file}`);
}

function removeReasonixBlock(file, ctx) {
  const start = `# ${manifest.name}:start`;
  const end = `# ${manifest.name}:end`;
  if (!existsSync(file)) return result('ok', `no ${file} — nothing to remove`);
  const current = readFileSync(file, 'utf8');
  const hasStart = current.includes(start), hasEnd = current.includes(end);
  if (hasStart !== hasEnd) return result('manual', `${file} has a partial Decision Lite plugin block — left untouched`);
  if (!hasStart) return result('ok', `no Decision Lite plugin block in ${file}`);
  if (ctx.dryRun) return result('ok', `[dry-run] would remove Decision Lite plugin block from ${file}`);
  const re = new RegExp(`\\s*${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}\\s*`);
  const next = current.replace(re, '\n').trim();
  writeConfigText(file, next ? `${next}\n` : '');
  return result('ok', `removed Decision Lite plugin block from ${file}`);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function writeConfigText(file, content) {
  if (existsSync(file)) backupConfig(file);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content, 'utf8');
}

function backupConfig(file) {
  let backup = `${file}.bak`, suffix = 1;
  while (existsSync(backup)) backup = `${file}.bak.${suffix++}`;
  copyFileSync(file, backup);
  return backup;
}

function installNative(ctx) {
  const materialized = ensurePortablePackage(ctx);
  if (materialized.status !== 'ok') return materialized;
  if (ctx.target.id === 'codex') {
    const base = ctx.scope === 'global' ? ctx.home : ctx.dir;
    return upsertTomlSection(join(base, '.codex', 'config.toml'), `mcp_servers.${JSON.stringify(manifest.name)}`, ctx);
  }
  if (ctx.target.id === 'reasonix' && ctx.scope === 'global') {
    const home = process.platform === 'win32' ? appDataPath(ctx.home, ctx.env) : ctx.home;
    const reasonixRoot = process.platform === 'win32' ? join(home, 'reasonix') : join(home, '.reasonix');
    return upsertReasonixBlock(join(reasonixRoot, 'config.toml'), ctx);
  }
  const location = nativeMcpLocation(ctx.target.id, ctx);
  if (!location) return result('error', `no MCP config mapping for ${ctx.target.id}`);
  return mergeJsonServer(location.file, location.key, mcpServerName, serverEntry(ctx, location.shape), ctx);
}

function installSkill(ctx) {
  const skillFile = join(packageRoot, 'src', 'skill.md');
  if (!existsSync(skillFile)) return result('error', `missing packaged skill ${skillFile}`);
  const body = readFileSync(skillFile, 'utf8');
  const destination = ctx.target.id === 'trae'
    ? join(ctx.dir, '.trae', 'skills', manifest.markers.skillDir, 'SKILL.md')
    : join(ctx.dir, '.agents', 'skills', manifest.markers.skillDir, 'SKILL.md');
  const written = writeManagedFile(destination, body, manifest.markers.skill, ctx);
  if (written.status !== 'ok') return written;
  if (ctx.target.id === 'trae') return result('manual', `${written.detail}; import the skill in Trae Settings → Rules & Skills`);

  const ready = ensurePortablePackage(ctx);
  if (ready.status !== 'ok') return ready;
  if (ctx.target.id === 'pi') {
    const file = join(ctx.home, '.pi', 'agent', 'mcp.json');
    const adapterPresent = existsSync(file) || existsSync(join(ctx.home, '.pi', 'agent', 'npm'));
    if (!adapterPresent) return result('manual', `${written.detail}; package staged at ${ctx.pluginRoot}; install pi-mcp-adapter to expose MCP tools`);
    const mcp = mergeJsonServer(file, 'mcpServers', mcpServerName, serverEntry(ctx), ctx);
    return mcp.status === 'ok' ? result('ok', `${written.detail}; ${mcp.detail}`) : mcp;
  }
  if (ctx.target.id === 'dsh') return result('manual', `${written.detail}; Cordis plugin staged at ${ctx.pluginRoot}; activate the Decision Lite patch in DSH`);
  return result('manual', `${written.detail}; package staged at ${ctx.pluginRoot}; install Decision Lite in ${ctx.target.label} to expose MCP tools`);
}

function uninstallSkill(ctx) {
  if (ctx.target.id === 'trae') {
    const file = join(ctx.dir, '.trae', 'skills', manifest.markers.skillDir, 'SKILL.md');
    const removed = removeManagedFile(file, manifest.markers.skill, ctx);
    return removed;
  }
  if (ctx.target.id === 'pi') {
    const mcpFile = join(ctx.home, '.pi', 'agent', 'mcp.json');
    const notes = removeJsonServer(mcpFile, 'mcpServers', manifest.name, ctx);
    return result(notes.status, `${notes.detail}; shared .agents/skills/${manifest.markers.skillDir} kept`);
  }
  return result('ok', `shared .agents/skills/${manifest.markers.skillDir} kept; ${ctx.target.label} has no decision-lite-owned uninstall artifact`);
}

function vscodeSettingsPath(ctx) {
  const base = process.platform === 'win32' ? join(ctx.home, 'AppData', 'Roaming')
    : process.platform === 'darwin' ? join(ctx.home, 'Library', 'Application Support')
      : join(ctx.home, '.config');
  for (const name of ['Code', 'Code - Insiders']) {
    const dir = join(base, name, 'User');
    if (existsSync(dir)) return join(dir, 'settings.json');
  }
  return join(base, 'Code', 'User', 'settings.json');
}

function installVscode(ctx) {
  const file = vscodeSettingsPath(ctx);
  const codeInstalled = Boolean(findCli('code', ctx.env)) || existsSync(dirname(file));
  if (!codeInstalled) return result('manual', `VS Code not detected. Import the plugin directory ${ctx.pluginRoot} from a VS Code plugin location`);
  const ready = ensurePortablePackage(ctx);
  if (ready.status !== 'ok') return ready;
  const loaded = readJsonObject(file);
  if (loaded.manual) return result('manual', loaded.manual);
  const chat = loaded.data.chat;
  if (chat !== undefined && !isPlainObject(chat)) return result('manual', `"chat" in ${file} is not an object — left untouched`);
  const chatObject = chat ?? {};
  const locations = chatObject.pluginLocations;
  if (locations !== undefined && !isPlainObject(locations)) return result('manual', `"chat.pluginLocations" in ${file} is not an object — left untouched`);
  const nextLocations = locations ?? {};
  if (nextLocations[ctx.pluginRoot] === true) return result('ok', `plugin location already registered in ${file}`);
  nextLocations[ctx.pluginRoot] = true;
  chatObject.pluginLocations = nextLocations;
  loaded.data.chat = chatObject;
  const written = writeJsonObject(file, loaded.data, ctx);
  return result('ok', `${written.detail ?? `registered ${ctx.pluginRoot} in ${file}`}`);
}

function uninstallVscode(ctx) {
  const file = vscodeSettingsPath(ctx);
  const loaded = readJsonObject(file);
  if (loaded.missing) return result('ok', `no ${file} — nothing to remove`);
  if (loaded.manual) return result('manual', loaded.manual);
  const chat = loaded.data.chat;
  if (!isPlainObject(chat) || !isPlainObject(chat.pluginLocations) || !(ctx.pluginRoot in chat.pluginLocations)) {
    return result('ok', `no Decision Lite plugin location in ${file}`);
  }
  delete chat.pluginLocations[ctx.pluginRoot];
  if (Object.keys(chat.pluginLocations).length === 0) delete chat.pluginLocations;
  if (Object.keys(chat).length === 0) delete loaded.data.chat;
  const written = writeJsonObject(file, loaded.data, ctx);
  return result('ok', written.detail ?? `removed plugin location from ${file}`);
}

function installCursor(ctx) {
  const cursorRoot = join(ctx.home, '.cursor');
  if (!existsSync(cursorRoot)) return result('manual', `Cursor not detected. Import ${ctx.pluginRoot} as a local plugin after running install on a machine with Cursor`);
  const ready = ensurePortablePackage(ctx);
  if (ready.status !== 'ok') return ready;
  const dest = join(cursorRoot, 'plugins', 'local', manifest.markers.cursorDir);
  if (existsSync(dest) && (!existsSync(join(dest, '.decision-lite-managed')) || readFileSync(join(dest, '.decision-lite-managed'), 'utf8').trim() !== ownedMarker)) {
    return result('manual', `${dest} exists without the Decision Lite marker — left untouched`);
  }
  if (ctx.dryRun) return result('ok', `[dry-run] would copy plugin to ${dest}`);
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(ctx.pluginRoot, dest, { recursive: true, force: true });
  return result('ok', `copied plugin to ${dest}; reload Cursor to load it`);
}

function uninstallCursor(ctx) {
  return removeManagedDirectory(join(ctx.home, '.cursor', 'plugins', 'local', manifest.markers.cursorDir), ctx);
}

function materializeCodexMarketplace(ctx) {
  const root = join(ctx.home, manifest.markers.configDir, 'marketplace');
  const marker = join(root, '.decision-lite-managed');
  const pluginCopy = join(root, 'plugin');
  const marketplace = join(root, '.agents', 'plugins', 'marketplace.json');
  if (existsSync(root) && (!existsSync(marker) || readFileSync(marker, 'utf8').trim() !== ownedMarker)) {
    return result('manual', `${root} exists without the Decision Lite marker — left untouched`);
  }
  const ready = ensurePortablePackage(ctx);
  if (ready.status !== 'ok') return ready;
  if (ctx.dryRun) return result('ok', `[dry-run] would create local Codex marketplace at ${root}`);
  mkdirSync(root, { recursive: true });
  cpSync(ctx.pluginRoot, pluginCopy, { recursive: true, force: true });
  mkdirSync(dirname(marketplace), { recursive: true });
  writeFileSync(marker, `${ownedMarker}\n`, 'utf8');
  writeFileSync(marketplace, `${JSON.stringify({
    name: manifest.name,
    owner: { name: manifest.brand },
    plugins: [{ name: manifest.name, source: { source: 'local', path: './plugin' }, category: 'development' }],
  }, null, 2)}\n`, 'utf8');
  return result('ok', `local marketplace ready at ${root}`);
}

function installOpenClaw(ctx) {
  const ready = ensurePortablePackage(ctx);
  if (ready.status !== 'ok') return ready;
  const bin = findCli('openclaw', ctx.env);
  if (!bin) return result('manual', `OpenClaw CLI not found. Install ${ctx.pluginRoot} with "openclaw plugins install ${ctx.pluginRoot}"`);
  if (ctx.dryRun) return result('ok', `[dry-run] would install ${ctx.pluginRoot} and restart the OpenClaw gateway`);
  return runCli(bin, ['plugins', 'list'], ctx).then(async (listed) => {
    if (listed.code === 0 && listed.stdout.includes(manifest.brand)) return result('ok', `Decision Lite already installed via ${bin}`);
    const installed = await runCli(bin, ['plugins', 'install', ctx.pluginRoot], ctx);
    if (installed.code !== 0) return result('error', `openclaw plugins install failed: ${(installed.stderr || installed.stdout).trim()}`);
    const restarted = await runCli(bin, ['gateway', 'restart'], ctx);
    return result('ok', restarted.code === 0 ? 'installed and gateway restarted' : `installed; restart the gateway manually: ${(restarted.stderr || restarted.stdout).trim()}`);
  });
}

function uninstallOpenClaw(ctx) {
  const bin = findCli('openclaw', ctx.env);
  if (!bin) return result('manual', `OpenClaw CLI not found. Run "openclaw plugins uninstall ${manifest.brand}" manually`);
  if (ctx.dryRun) return result('ok', `[dry-run] would uninstall ${manifest.brand} from OpenClaw`);
  return runCli(bin, ['plugins', 'uninstall', manifest.brand], ctx).then((removed) =>
    removed.code === 0 ? result('ok', 'uninstalled from OpenClaw') : result('error', `openclaw plugins uninstall failed: ${(removed.stderr || removed.stdout).trim()}`));
}

function installGrok(ctx) {
  const ready = ensurePortablePackage(ctx);
  if (ready.status !== 'ok') return ready;
  if (!ctx.trust) return result('manual', `Grok installs local plugins with trust. Review ${ctx.pluginRoot}, then rerun with --target grok --trust`);
  const bin = findCli('grok', ctx.env);
  if (!bin) return result('manual', `Grok CLI not found. Install ${ctx.pluginRoot} in the Grok Plugins UI and trust it explicitly`);
  if (ctx.dryRun) return result('ok', `[dry-run] would run grok plugin install ${ctx.pluginRoot} --trust`);
  return runCli(bin, ['plugin', 'install', ctx.pluginRoot, '--trust'], ctx).then((installed) =>
    installed.code === 0 ? result('ok', 'installed trusted Grok plugin') : result('error', `grok plugin install failed: ${(installed.stderr || installed.stdout).trim()}`));
}

function uninstallGrok(ctx) {
  const bin = findCli('grok', ctx.env);
  if (!bin) return result('manual', `Grok CLI not found. Remove ${manifest.brand} from the Grok Plugins UI`);
  if (ctx.dryRun) return result('ok', `[dry-run] would run grok plugin uninstall ${manifest.brand} --confirm`);
  return runCli(bin, ['plugin', 'uninstall', manifest.brand, '--confirm'], ctx).then((removed) =>
    removed.code === 0 ? result('ok', 'uninstalled Grok plugin') : result('error', `grok plugin uninstall failed: ${(removed.stderr || removed.stdout).trim()}`));
}

async function installPlugin(ctx) {
  switch (ctx.target.id) {
    case 'cursor': return installCursor(ctx);
    case 'vscode': return installVscode(ctx);
    case 'openclaw': return installOpenClaw(ctx);
    case 'grok': return installGrok(ctx);
    case 'chatgpt-codex': {
      const ready = materializeCodexMarketplace(ctx);
      if (ready.status !== 'ok') return ready;
      const bin = findCli('codex', ctx.env);
      const root = join(ctx.home, manifest.markers.configDir, 'marketplace');
      if (!bin) return result('manual', `${ready.detail}; add the local marketplace ${root} in ChatGPT/Codex`);
      if (ctx.dryRun) return result('ok', `[dry-run] would register ${root} and install ${manifest.name}@${manifest.name}`);
      const marketplace = await runCli(bin, ['plugin', 'marketplace', 'add', root], ctx);
      if (marketplace.code !== 0) return result('error', `codex plugin marketplace add failed: ${(marketplace.stderr || marketplace.stdout).trim()}`);
      const added = await runCli(bin, ['plugin', 'add', `${manifest.name}@${manifest.name}`], ctx);
      return added.code === 0 ? result('ok', 'installed Decision Lite from local Codex marketplace') : result('error', `codex plugin add failed: ${(added.stderr || added.stdout).trim()}`);
    }
    case 'nanoclaw': {
      const ready = ensurePortablePackage(ctx);
      if (ready.status !== 'ok') return ready;
      const templates = ctx.env.NANOCLAW_TEMPLATES_DIR || join(ctx.home, manifest.markers.configDir, 'nanoclaw-templates');
      const dest = join(templates, manifest.name);
      if (ctx.dryRun) return result('ok', `[dry-run] would copy plugin to ${dest}; create the NanoClaw group manually`);
      mkdirSync(templates, { recursive: true });
      cpSync(ctx.pluginRoot, dest, { recursive: true, force: true });
      return result('manual', `copied plugin template to ${dest}; create and wire a NanoClaw group in its UI`);
    }
    case 'copilot':
    case 'hermes':
    case 'kiro':
    case 'other': {
      const ready = ensurePortablePackage(ctx);
      if (ready.status !== 'ok') return ready;
      return result('manual', `${ready.detail}; complete plugin registration in ${ctx.target.label}. The decision-lite package is not yet published to npm`);
    }
    default: return result('error', `no plugin installer for ${ctx.target.id}`);
  }
}

function uninstallPlugin(ctx) {
  switch (ctx.target.id) {
    case 'cursor': return uninstallCursor(ctx);
    case 'vscode': return uninstallVscode(ctx);
    case 'openclaw': return uninstallOpenClaw(ctx);
    case 'grok': return uninstallGrok(ctx);
    case 'chatgpt-codex': {
      const bin = findCli('codex', ctx.env);
      if (!bin) return result('manual', `Codex CLI not found. Remove ${manifest.name} from the ChatGPT/Codex plugin UI; the local marketplace remains at ${join(ctx.home, manifest.markers.configDir, 'marketplace')}`);
      if (ctx.dryRun) return result('ok', `[dry-run] would run codex plugin remove ${manifest.name}@${manifest.name}`);
      return runCli(bin, ['plugin', 'remove', `${manifest.name}@${manifest.name}`], ctx).then((removed) =>
        removed.code === 0 ? result('ok', 'uninstalled Codex plugin; local marketplace kept') : result('error', `codex plugin remove failed: ${(removed.stderr || removed.stdout).trim()}`));
    }
    case 'copilot':
    case 'hermes':
    case 'kiro':
    case 'nanoclaw':
    case 'other': return result('manual', `remove ${manifest.brand} from ${ctx.target.label}; shared plugin files are retained`);
    default: return result('error', `no plugin uninstaller for ${ctx.target.id}`);
  }
}

function uninstallNative(ctx) {
  if (ctx.target.id === 'codex') {
    const base = ctx.scope === 'global' ? ctx.home : ctx.dir;
    return removeTomlSection(join(base, '.codex', 'config.toml'), `mcp_servers.${JSON.stringify(manifest.name)}`, ctx);
  }
  if (ctx.target.id === 'reasonix' && ctx.scope === 'global') {
    const home = process.platform === 'win32' ? appDataDir(ctx.home, ctx.env) : ctx.home;
    const root = process.platform === 'win32' ? join(home, 'reasonix') : join(home, '.reasonix');
    return removeReasonixBlock(join(root, 'config.toml'), ctx);
  }
  const location = nativeMcpLocation(ctx.target.id, ctx);
  return location ? removeJsonServer(location.file, location.key, manifest.name, ctx)
    : result('error', `no MCP config mapping for ${ctx.target.id}`);
}

export function installTarget(ctx) {
  if (nativeIds.has(ctx.target.id)) return installNative(ctx);
  if (skillIds.has(ctx.target.id)) return installSkill(ctx);
  if (pluginIds.has(ctx.target.id)) return installPlugin(ctx);
  return result('error', `unknown target ${ctx.target.id}`);
}

export function uninstallTarget(ctx) {
  if (nativeIds.has(ctx.target.id)) return uninstallNative(ctx);
  if (skillIds.has(ctx.target.id)) return uninstallSkill(ctx);
  if (pluginIds.has(ctx.target.id)) return uninstallPlugin(ctx);
  return result('error', `unknown target ${ctx.target.id}`);
}
