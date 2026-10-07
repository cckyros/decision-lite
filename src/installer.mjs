import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { manifest } from './manifest.mjs';
import { removeManagedDirectory, runtimeRoot } from './installer-support.mjs';
import { installTarget, targetAdapters, uninstallTarget } from './targets.mjs';

const valueFlags = new Set([
  'target', 'scope', 'dir', 'backend', 'model', 'mode', 'samples', 'temperature',
  'python', 'needle-generation',
]);

function parseFlags(args) {
  const flags = new Map();
  for (let i = 0; i < args.length; i++) {
    const value = args[i];
    if (!value.startsWith('--')) continue;
    const equals = value.indexOf('=');
    if (equals >= 0) {
      flags.set(value.slice(2, equals), value.slice(equals + 1));
      continue;
    }
    const name = value.slice(2);
    if (valueFlags.has(name) && args[i + 1] !== undefined && !args[i + 1].startsWith('--')) {
      flags.set(name, args[++i]);
    } else {
      flags.set(name, '');
    }
  }
  return flags;
}

function selectedTargets(raw) {
  if (raw === 'all') return { ids: targetAdapters.map(({ id }) => id), unknown: [], targets: [...targetAdapters] };
  const ids = (raw ?? '').split(',').map((id) => id.trim()).filter(Boolean);
  const unknown = ids.filter((id) => !targetAdapters.some((target) => target.id === id));
  return { ids, unknown, targets: targetAdapters.filter((target) => ids.includes(target.id)) };
}

function scopesFor(target, requested) {
  if (target.scope !== 'both') return [target.scope];
  if (requested === 'global' || requested === 'project') return [requested];
  if (requested === 'both') return ['project', 'global'];
  return ['project'];
}

function serverEnv(flags) {
  const mapping = {
    backend: 'DECISION_BACKEND',
    model: 'DECISION_MODEL',
    mode: 'DECISION_MODE',
    samples: 'DECISION_SAMPLES',
    temperature: 'DECISION_TEMPERATURE',
    python: 'DECISION_PYTHON',
    'needle-generation': 'DECISION_NEEDLE_GENERATION',
  };
  return Object.fromEntries(Object.entries(mapping)
    .filter(([flag]) => flags.has(flag) && flags.get(flag) !== '')
    .map(([flag, env]) => [env, flags.get(flag)]));
}

function makeContext(target, scope, flags, options) {
  const env = options.env ?? process.env;
  const dir = resolve(options.cwd ?? process.cwd(), flags.get('dir') ?? '.');
  const home = options.home ?? env.USERPROFILE ?? env.HOME ?? homedir();
  return {
    target,
    scope,
    dir,
    home,
    pluginRoot: runtimeRoot({ scope, dir, home }),
    env,
    dryRun: flags.has('dry-run'),
    update: flags.has('update'),
    trust: flags.has('trust'),
    serverEnv: serverEnv(flags),
    log: options.log ?? (() => {}),
  };
}

function writeLine(options, line, error = false) {
  const write = error ? options.stderr : options.stdout;
  (write ?? ((text) => (error ? process.stderr : process.stdout).write(text)))(`${line}\n`);
}

export function listTargets() {
  return targetAdapters.map(({ id, kind, label, scope }) => ({ id, kind, label, scope }));
}

export async function runInstaller(command, args = [], options = {}) {
  const flags = parseFlags(args);
  const rawTargets = flags.get('target');
  if (!rawTargets) {
    writeLine(options, `usage: decision-lite ${command} --target <id[,id...]> [--scope project|global|both] [--dry-run]`, true);
    return 2;
  }
  if (flags.has('api-key')) {
    writeLine(options, 'API keys are never written by the installer; set DECISION_API_KEY in the MCP host configuration instead.', true);
    return 2;
  }
  const selection = selectedTargets(rawTargets);
  if (selection.unknown.length) {
    writeLine(options, `unknown target(s): ${selection.unknown.join(', ')}`, true);
    return 2;
  }
  if (command === 'uninstall' && flags.has('purge-config') && rawTargets !== 'all') {
    writeLine(options, 'uninstall --purge-config requires --target all; shared runtime files may be used by other clients.', true);
    return 2;
  }

  const results = [];
  const runtimeRoots = new Map();
  for (const target of selection.targets) {
    for (const scope of scopesFor(target, flags.get('scope'))) {
      const ctx = makeContext(target, scope, flags, options);
      const action = command === 'install' ? installTarget : uninstallTarget;
      let targetResult;
      try {
        targetResult = await action(ctx);
      } catch (error) {
        targetResult = { status: 'error', detail: error instanceof Error ? error.message : String(error) };
      }
      results.push({ id: target.id, label: target.label, scope, ...targetResult });
      runtimeRoots.set(ctx.pluginRoot, ctx);
      const status = targetResult.status.toUpperCase();
      writeLine(options, `  [${status}] ${target.label} (${scope})${targetResult.detail ? ` — ${targetResult.detail}` : ''}`);
    }
  }

  if (command === 'uninstall' && flags.has('purge-config')) {
    const blockers = results.filter((entry) => entry.status === 'manual' || entry.status === 'error');
    if (blockers.length) {
      writeLine(options, `[${manifest.name}] shared package kept: one or more targets still need manual cleanup.`);
    } else {
      for (const [root, ctx] of runtimeRoots) {
        const purged = removeManagedDirectory(root, ctx);
        writeLine(options, `  [${purged.status.toUpperCase()}] ${purged.detail}`);
      }
    }
  }

  const failures = results.filter((entry) => entry.status === 'error').length;
  writeLine(options, `[${manifest.name}] ${command} complete: ${results.length} target result(s), ${failures} error(s)${flags.has('dry-run') ? ' (dry-run; no writes or commands performed)' : ''}`);
  return failures ? 1 : 0;
}
