import {strict as assert} from 'node:assert';
import {test} from 'node:test';
import {build} from 'esbuild';
import {Chunk} from '@codemirror/merge';
import {EditorState, Text} from '@codemirror/state';

const bundle = await build({
  entryPoints: ['src/wordDiff.ts'], bundle: true, write: false, platform: 'node', format: 'esm',
});
const {wordDiff} = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const config = {override: wordDiff};

test('separates distant small edits in a large document into local chunks', () => {
  const original = Array.from({length: 2400}, (_, i) => i % 4 === 0 ? '' :
    `Paragraph ${i}: ` + 'Some unchanged tutorial instructions. '.repeat(4));
  const result = [...original];
  const edited = [89, 200, 424, 700, 1100, 1458, 1849, 2203];
  for (const i of edited) result[i] += ' changed';
  const a = Text.of(original), b = Text.of(result);
  // Reproduces the old viewer's document-wide fallback.
  const oldChunks = Chunk.build(a, b, {scanLimit: 500});
  assert.ok(oldChunks.some(c => a.lineAt(c.endA).number - a.lineAt(c.fromA).number > 1000));
  const chunks = Chunk.build(a, b, config);
  assert.equal(chunks.length, edited.length);
  assert.deepEqual(chunks.map(c => a.lineAt(c.fromA).number), edited.map(i => i + 1));
  assert.ok(chunks.every(c => a.lineAt(c.endA).number - a.lineAt(c.fromA).number <= 1));
});

test('highlights only the changed code fence language', () => {
  const a = 'Intro\n```text\ncommand\n```\n', b = 'Intro\n```bash\ncommand\n```\n';
  const changes = wordDiff(a, b);
  assert.equal(changes.length, 1);
  assert.equal(a.slice(changes[0].fromA, changes[0].toA), 'text');
  assert.equal(b.slice(changes[0].fromB, changes[0].toB), 'bash');
});

test('character ranges preserve unchanged text, line endings, and Unicode', () => {
  for (const [a, b] of [
    ['', 'new\n'], ['old\n', ''], ['a', 'a\n'], ['a\n', 'a'],
    ['a\r\nb\r\n', 'a\r\nB\r\n'], ['🛠️ Старе слово\n', '🛠️ Нове слово\n'],
    ['a\n\nb\n\na\n', 'a\nb\n\na\n'], ['unchanged', 'unchanged'],
  ]) {
    let posA = 0, posB = 0, rebuilt = '';
    for (const c of wordDiff(a, b)) {
      assert.ok(c.fromA >= posA && c.fromB >= posB && c.toA <= a.length && c.toB <= b.length);
      assert.equal(a.slice(posA, c.fromA), b.slice(posB, c.fromB));
      rebuilt += a.slice(posA, c.fromA) + b.slice(c.fromB, c.toB);
      posA = c.toA; posB = c.toB;
    }
    assert.equal(a.slice(posA), b.slice(posB));
    assert.equal(rebuilt + a.slice(posA), b);
  }
});

test('incremental draft edits produce the same chunks as rebuilding', () => {
  const original = 'Header\n```text\ncommand\n```\n\nOther section\nold word\n';
  const a = Text.of(original.split('\n'));
  const state = EditorState.create({doc: original.replace('text', 'bash')});
  const before = Chunk.build(a, state.doc, config);
  const from = state.doc.toString().indexOf('old word');
  const tr = state.update({changes: {from, to: from + 3, insert: 'new'}});
  const updated = Chunk.updateB(before, a, tr.newDoc, tr.changes, config);
  const rebuilt = Chunk.build(a, tr.newDoc, config);
  const ranges = chunks => chunks.map(c => [c.fromA, c.toA, c.fromB, c.toB,
    c.changes.map(d => [d.fromA, d.toA, d.fromB, d.toB])]);
  assert.deepEqual(ranges(updated), ranges(rebuilt));
});
