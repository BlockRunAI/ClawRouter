import { readFileSync } from 'node:fs';
import { test } from 'vitest';
import assert from 'node:assert/strict';

const css = readFileSync(new URL('../src/window-drag.css', import.meta.url), 'utf8');
const entry = readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8');
const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]+)\}/g)];
const rule = selector => rules.find(([, selectors]) => selectors.split(',').map(s => s.trim()).includes(selector))?.[2] ?? '';
test('source build imports the same drag stylesheet used by the release', () => {
  assert.match(entry, /import "\.\/window-drag\.css"/);
});
test('title and brand drag without selecting text', () => {
  for (const s of ['.topbar', '.brand']) {
    assert.match(rule(s), /app-region: drag;/);
    assert.match(rule(s), /user-select: none;/);
  }
});
test('interactive title controls remain clickable', () => {
  for (const s of ['.topbar-actions', '.topbar button', '.topbar a', '.topbar input', '.topbar select', '.brand button', '.brand a'])
    assert.match(rule(s), /app-region: no-drag;/);
});
test('persistent handle preserves layout, traffic lights, and scrollbar access', () => {
  const handle = rule('.shell::before');
  for (const declaration of ['position: fixed;', 'height: 28px;', 'left: 80px;', 'right: 16px;']) assert.ok(handle.includes(declaration));
  assert.equal(rule('body'), '');
  assert.equal(rule('main'), '');
});
