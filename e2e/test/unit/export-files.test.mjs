import {strict as assert} from 'node:assert';
import {test} from 'node:test';
import {build} from 'esbuild';

const result = await build({
  stdin: {contents: `export * from './src/export/files'; export {TFile, FileSystemAdapter} from 'obsidian'; export {shell} from 'electron';`, resolveDir: process.cwd()},
  bundle: true, write: false, platform: 'node', format: 'esm',
  plugins: [{name: 'mock-platform', setup(b) {
    b.onResolve({filter: /^(obsidian|electron)$/}, ({path}) => ({path, namespace: 'mock'}));
    b.onLoad({filter: /.*/, namespace: 'mock'}, ({path}) => ({loader: 'js', contents: path === 'electron'
      ? `export const shell = {paths: [], error: '', async openPath(path) { this.paths.push(path); return this.error; }};`
      : `export class FileView {} export class FileSystemAdapter { getFullPath(path) { return '/vault/' + path; } }
         export class TFile { constructor(path) { this.path = path; this.extension = path.split('.').at(-1); } }` }));
  }}],
});
const {inspectDestination, saveExport, openExport, TFile, FileSystemAdapter, shell} = await import(
  'data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));

function setup() {
  const files = new Map(), contents = new Map(), opened = [];
  const adapter = new FileSystemAdapter();
  adapter.stat = async path => files.has(path) ? {type: files.get(path) instanceof TFile ? 'file' : 'folder'} : null;
  const app = {vault: {
    adapter,
    getAbstractFileByPath: path => files.get(path),
    create: async (path, text) => {
      assert.ok(!files.has(path));
      const file = new TFile(path); files.set(path, file); contents.set(path, text); return file;
    },
    modify: async (file, text) => { contents.set(file.path, text); },
  }, workspace: {getLeaf: kind => {
    assert.equal(kind, 'tab');
    return {openFile: async file => opened.push(file), setViewState: async state => opened.push(state)};
  }}};
  return {app, files, contents, opened};
}

test('creates an export and explicitly overwrites an existing destination', async () => {
  const {app, contents} = setup();
  assert.deepEqual(await inspectDestination(app, 'export.diff.txt'), {exists: false, error: null});
  const first = await saveExport(app, 'export.diff.txt', 'first patch');
  assert.deepEqual(await inspectDestination(app, first.path), {exists: true, error: null});
  const second = await saveExport(app, first.path, 'replacement');
  assert.equal(second, first);
  assert.equal(contents.get(first.path), 'replacement');
});

test('refuses folders and paths outside the vault root', async () => {
  const {app, files, contents} = setup();
  files.set('folder', {});
  for (const name of ['folder', '../outside.txt', 'nested/export.txt']) {
    assert.ok((await inspectDestination(app, name)).error);
    await assert.rejects(saveExport(app, name, 'patch'));
  }
  assert.equal(contents.size, 0);
});

test('opens markdown and text in new Obsidian tabs, other extensions through the system', async () => {
  const {app, opened} = setup();
  const md = new TFile('export.md');
  await openExport(app, md);
  await openExport(app, new TFile('export.TXT'));
  assert.equal(opened[0], md);
  assert.deepEqual(opened[1], {type: 'drift-export-text', state: {file: 'export.TXT'}, active: true});
  await openExport(app, new TFile('export.diff'));
  assert.deepEqual(shell.paths, ['/vault/export.diff']);
  shell.error = 'No application';
  await assert.rejects(openExport(app, new TFile('export.unknown')), /No application/);
});
