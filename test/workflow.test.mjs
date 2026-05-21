import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const testDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(testDir, '..');

test('action.yml exposes capability drift outputs', async () => {
  const action = await readFile(join(packageRoot, 'action.yml'), 'utf8');
  assert.match(action, /name: CapabilityEcho/);
  assert.match(action, /changed-file-count/);
  assert.match(action, /fail-on/);
});

test('self-dogfood workflow uses local action', async () => {
  const workflow = await readFile(join(packageRoot, '.github/workflows/capabilityecho.yml'), 'utf8');
  assert.match(workflow, /uses: \.\//);
  assert.match(workflow, /fetch-depth: 0/);
});
