import {strict as assert} from 'node:assert';
import {test} from 'node:test';
import {build} from 'esbuild';
import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {spawnSync} from 'node:child_process';

const result = await build({
  stdin: {contents: `export * from './src/export/unifiedDiff'; export * from './src/export/filename';`, resolveDir: process.cwd()},
  bundle: true, write: false, platform: 'node', format: 'esm',
});
const {createUnifiedExport, formatExportFilename, availableFilename, filenameError, DEFAULT_EXPORT_TEMPLATE} = await import(
  'data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));

const fixtures = [
  ['nested/note.md', 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n', 'ONE\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nTEN\n'],
  ['Українська/🛠️з пробілами.md', 'старе\n', 'нове\n'],
  ['quotes " tab\t.md', 'a\nb', 'a\nc'],
  ['empty.md', '', 'new\n'],
  ['emptied.md', 'old\n', ''],
  ['crlf.md', 'a\r\nb\r\nc\r\n', 'a\r\nB\r\nc\r\n'],
  ['eof-add.md', 'a', 'a\n'],
  ['eof-remove.md', 'b\n', 'b'],
  ['repeated.md', '\n\na\n\nb\n\na\n', '\na\n\na\n\nb\n\n'],
  ['same.md', 'same\n', 'same\n'],
].map(([path, oldContent, draftContent]) => ({path, oldContent, draftContent}));

for (const unicodePaths of [true, false]) {
for (const context of [0, 1, 3, 20]) {
  for (const tool of ['git', 'patch']) {
    test(`${tool} applies multi-file export with ${context} context lines, Unicode paths: ${unicodePaths}`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'drift-export-'));
      try {
        for (const entry of fixtures) {
          const path = join(root, entry.path);
          await mkdir(dirname(path), {recursive: true});
          await writeFile(path, entry.oldContent);
        }
        const patch = createUnifiedExport(fixtures, context, new Date(), unicodePaths);
        const args = tool === 'git' ? ['apply', ...(context === 0 ? ['--unidiff-zero'] : []), '-'] : ['--batch', '-p1'];
        const applied = spawnSync(tool, args, {cwd: root, input: patch, encoding: 'utf8', timeout: 5000});
        assert.equal(applied.status, 0, applied.stdout + applied.stderr);
        for (const entry of fixtures) assert.equal(await readFile(join(root, entry.path), 'utf8'), entry.draftContent, entry.path);
      } finally { await rm(root, {recursive: true, force: true}); }
    });
  }
}
}

test('Unicode paths are readable by default and optionally byte-escaped', () => {
  const entry = fixtures[1];
  const readable = createUnifiedExport([entry]).split('diff --git ')[1];
  assert.ok(readable.includes(`"a/${entry.path}"`));
  assert.ok(readable.includes(`"b/${entry.path}"`));
  const escaped = createUnifiedExport([entry], 3, new Date(), false).split('diff --git ')[1];
  assert.ok(!escaped.includes('🛠️'));
  assert.ok(escaped.includes('\\360\\237'));
});

test('metadata is deterministic and unchanged entries are omitted', () => {
  const patch = createUnifiedExport(fixtures, 3, new Date('2026-09-28T12:30:00Z'));
  assert.match(patch, /Created: 2026-09-28T12:30:00.000Z/);
  assert.match(patch, /Files \(9\):/);
  assert.ok(!patch.includes('same.md'));
  assert.equal(createUnifiedExport([fixtures.at(-1)]), '');
  for (const n of [-1, 1.5, NaN, Infinity]) assert.throws(() => createUnifiedExport(fixtures, n));
  assert.throws(() => createUnifiedExport([{path: '../x', oldContent: 'a', draftContent: 'b'}]));
});

test('header and patch preserve supplied viewer order while omitting unchanged entries', () => {
  const entries = ['z.md', 'unchanged.md', 'a.md'].map(path => ({
    path, oldContent: 'old\n', draftContent: path === 'unchanged.md' ? 'old\n' : 'new\n',
  }));
  for (const ordered of [entries, [...entries].reverse()]) {
    const patch = createUnifiedExport(ordered);
    const expected = ordered.filter(e => e.oldContent !== e.draftContent).map(e => e.path);
    assert.deepEqual([...patch.matchAll(/^  "([^"]+)"$/gm)].map(m => m[1]), expected);
    assert.deepEqual([...patch.matchAll(/^diff --git a\/(\S+) b\/\S+$/gm)].map(m => m[1]), expected);
    assert.deepEqual(entries.map(e => e.path), ['z.md', 'unchanged.md', 'a.md']);
  }
});

test('filename templates use local time and reject invalid names or tokens', () => {
  const date = new Date(2026, 8, 28, 14, 5, 9);
  assert.equal(formatExportFilename(DEFAULT_EXPORT_TEMPLATE, date), 'drift-2026-09-28_14-05.diff.txt');
  assert.equal(formatExportFilename('%S-%%.txt', date), '09-%.txt');
  for (const value of ['', '../a.txt', 'a/b', 'CON.txt', 'a.', '%Q', 'trailing%']) assert.throws(() => formatExportFilename(value));
  assert.equal(filenameError('мій патч.txt'), null);
});

test('unique suggestions preserve the full diff.txt extension', async () => {
  const occupied = new Set(['drift.diff.txt', 'drift-2.diff.txt']);
  assert.equal(await availableFilename('drift.diff.txt', async name => occupied.has(name)), 'drift-3.diff.txt');
  assert.equal(await availableFilename('free.txt', async () => false), 'free.txt');
});

for (const tool of ['git', 'patch']) {
  test(`${tool} applies deletion and renamed-content sections with warning comments`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'drift-lifecycle-export-'));
    try {
      await writeFile(join(root, 'gone.md'), 'removed\n');
      await writeFile(join(root, 'current.md'), 'old\n');
      const patch = createUnifiedExport([
        {path: 'gone.md', oldContent: 'removed\n', draftContent: 'preserved draft', deleted: true},
        {path: 'current.md', originalPath: 'previous.md', oldContent: 'old\n', draftContent: 'new\n'},
      ]);
      assert.match(patch, /\+\+\+ \/dev\/null/);
      assert.ok(patch.indexOf('# WARNING: FILE WAS RENAMED FROM:') < patch.indexOf('diff --git a/current.md'));
      const applied = spawnSync(tool, tool === 'git' ? ['apply', '-'] : ['--batch', '-p1'], {cwd: root, input: patch, encoding: 'utf8', timeout: 5000});
      assert.equal(applied.status, 0, applied.stdout + applied.stderr);
      await assert.rejects(readFile(join(root, 'gone.md')), {code: 'ENOENT'});
      assert.equal(await readFile(join(root, 'current.md'), 'utf8'), 'new\n');
    } finally { await rm(root, {recursive: true, force: true}); }
  });
}

test('pure rename exports metadata without invented text changes', () => {
  const patch = createUnifiedExport([{path: 'new.md', originalPath: 'old.md', oldContent: 'same', draftContent: 'same'}]);
  assert.match(patch, /FILE WAS RENAMED FROM: "old.md"/);
  assert.match(patch, /CURRENT PATH: "new.md"/);
  assert.ok(!patch.includes('@@'));
});

test('git applies deletion of an empty file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drift-empty-deletion-'));
  try {
    await writeFile(join(root, 'empty.md'), '');
    const patch = createUnifiedExport([{path: 'empty.md', oldContent: '', draftContent: '', deleted: true}]);
    const applied = spawnSync('git', ['apply', '-'], {cwd: root, input: patch, encoding: 'utf8', timeout: 5000});
    assert.equal(applied.status, 0, applied.stdout + applied.stderr);
    await assert.rejects(readFile(join(root, 'empty.md')), {code: 'ENOENT'});
  } finally { await rm(root, {recursive: true, force: true}); }
});

for (const content of ['', 'new note\n']) {
  test(`git applies creation exports including empty notes: ${content.length}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'drift-created-'));
    try {
      const patch = createUnifiedExport([{path: 'new.md', oldContent: '', draftContent: content, created: true}]);
      const applied = spawnSync('git', ['apply', '-'], {cwd: root, input: patch, encoding: 'utf8', timeout: 5000});
      assert.equal(applied.status, 0, applied.stdout + applied.stderr);
      assert.equal(await readFile(join(root, 'new.md'), 'utf8'), content);
    } finally { await rm(root, {recursive: true, force: true}); }
  });
}
