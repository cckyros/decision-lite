import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, '..', 'package.json'), 'utf8'));

export const manifest = Object.freeze({
  name: pkg.name,
  version: pkg.version,
  brand: 'decision-lite',
  description: pkg.description,
  markers: Object.freeze({
    configDir: '.decision-lite',
    skillDir: 'decision-lite',
    skill: 'decision-lite:skill',
    plugin: 'decision-lite:managed',
    cursorDir: 'decision-lite',
    cursorMarkerFile: '.decision-lite-managed',
    agentsStart: '<!-- decision-lite:start -->',
    agentsEnd: '<!-- decision-lite:end -->',
  }),
});
