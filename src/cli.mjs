#!/usr/bin/env node
import { manifest } from './manifest.mjs';
import { listTargets, runInstaller } from './installer.mjs';

const [command = 'mcp', ...args] = process.argv.slice(2);

if (command === 'mcp') {
  await import('./index.mjs');
} else if (command === 'install' || command === 'uninstall') {
  process.exitCode = await runInstaller(command, args);
} else if (command === 'list-targets') {
  if (args.includes('--json')) process.stdout.write(`${JSON.stringify(listTargets(), null, 2)}\n`);
  else for (const target of listTargets()) process.stdout.write(`${target.id.padEnd(16)} ${target.label} (${target.kind})\n`);
} else if (command === 'eval') {
  const { runEvalCommand } = await import('./eval.mjs');
  process.exitCode = await runEvalCommand(args);
} else if (command === 'version') {
  process.stdout.write(`${manifest.version}\n`);
} else if (command === 'help' || command === '--help' || command === '-h') {
  process.stdout.write([
    `${manifest.name} v${manifest.version} — ${manifest.description}`,
    '',
    'Usage:',
    '  decision-lite mcp',
    '  decision-lite install --target <id[,id...]> [--scope project|global] [--dry-run]',
    '  decision-lite uninstall --target <id[,id...]> [--scope project|global] [--dry-run]',
    '  decision-lite list-targets [--json]',
    '  decision-lite eval --dataset <path.json> [--out report.json] [--compare base.json] [--tolerance 0.02] [--limit N] [--quiet]',
    '  decision-lite version',
    '',
  ].join('\n'));
} else {
  process.stderr.write(`decision-lite: unknown command "${command}" (try: decision-lite help)\n`);
  process.exitCode = 2;
}
