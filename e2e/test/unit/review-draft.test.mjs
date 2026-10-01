import {strict as assert} from 'node:assert';
import {test} from 'node:test';
import {build} from 'esbuild';
import {EditorState} from '@codemirror/state';
import {history, historyField, undo, redo, undoDepth} from '@codemirror/commands';

const mock = `
export class Component {}
export class Plugin {}
export class ItemView {}
export class FileView {}
export class FileSystemAdapter {}
export class Modal {}
export class PluginSettingTab {}
export class Setting {}
export class App {}
export class MarkdownView {}
export class TAbstractFile {}
export class TFile { constructor(path) { this.path = path; this.extension = path.split('.').pop(); } }
export class Notice { constructor() {} }
export function setIcon() {}
export function setTooltip() {}
`;
const result = await build({
  stdin: {contents: `export {default as Plugin} from './src/main'; export * from './src/reviewDraft'; export {TFile} from 'obsidian'; export {FileLifecycle} from './src/fileLifecycle'; export {DiffView} from './src/DiffView';`, resolveDir: process.cwd()},
  bundle: true, write: false, platform: 'node', format: 'esm',
  plugins: [{name: 'mock-obsidian', setup(b) {
    b.onResolve({filter: /^obsidian$/}, () => ({path: 'obsidian', namespace: 'mock'}));
    b.onResolve({filter: /^electron$/}, () => ({path: 'electron', namespace: 'electron-mock'}));
    b.onLoad({filter: /.*/, namespace: 'electron-mock'}, () => ({contents: 'export const shell = {};', loader: 'js'}));
    b.onLoad({filter: /.*/, namespace: 'mock'}, () => ({contents: mock, loader: 'js'}));
  }}],
});
const {Plugin, TFile, FileLifecycle, DiffView, restoreReview, ReviewConflictError, writeReviewedContent} = await import(
  'data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));

function setup(disk = 'external') {
  const plugin = new Plugin();
  const file = new TFile('note.md');
  const io = {disk, writes: 0, fail: false};
  plugin.persistState = () => {};
  plugin.settings = {enabled: true};
  plugin.app = {workspace: {getLeavesOfType: () => []}, vault: {
    getAbstractFileByPath: () => file,
    read: async () => io.disk,
    process: async (_, transform) => {
      if (io.fail) throw new Error('Disk unavailable');
      io.disk = transform(io.disk);
      io.writes++;
      return io.disk;
    },
  }};
  const diff = plugin.makeDiffCallbacks(file.path, 'original', 'external');
  plugin.pendingDiffs.set(file.path, diff);
  return {plugin, file, io, diff};
}

test('missing files require explicit recreation for both accept and reject', async () => {
  for (const accept of [true, false]) {
    const {plugin, diff, io, file} = setup();
    plugin.app.vault.getAbstractFileByPath = () => null;
    let created;
    plugin.app.vault.create = async (path, content) => { created = {path, content}; return file; };
    diff.onDraftChange('edited draft');
    const apply = () => accept ? diff.onAccept(diff.draftContent) : diff.onReject();
    assert.equal(await apply(), false);
    assert.equal(diff.missing, true);
    assert.equal(created, undefined);
    assert.equal(plugin.pendingDiffs.size, 1);
    diff.recreateMissingFile = true;
    assert.equal(await apply(), true);
    assert.deepEqual(created, {path: 'note.md', content: accept ? 'edited draft' : 'original'});
    assert.equal(plugin.pendingDiffs.size, 0);
    assert.equal(io.writes, 0);
  }
});

test('a reappearing file resets recreation permission and checks its content', async () => {
  const {plugin, diff, file, io} = setup();
  plugin.app.vault.getAbstractFileByPath = () => null;
  plugin.refreshMissingReviews();
  diff.recreateMissingFile = true;
  plugin.app.vault.getAbstractFileByPath = () => file;
  io.disk = 'new Dropbox contents';
  assert.equal(await diff.onReject(), false);
  assert.equal(diff.recreateMissingFile, false);
  assert.equal(diff.conflicted, true);
  assert.equal(io.writes, 0);
});

test('failed recreation preserves the review and never falls back to overwriting', async () => {
  const {plugin, diff, io} = setup();
  plugin.app.vault.getAbstractFileByPath = () => null;
  plugin.refreshMissingReviews();
  diff.recreateMissingFile = true;
  plugin.app.vault.create = async () => { throw new Error('File already exists'); };
  const originalError = console.error;
  console.error = () => {};
  try { assert.equal(await diff.onAccept('draft'), false); }
  finally { console.error = originalError; }
  assert.equal(plugin.pendingDiffs.size, 1);
  assert.equal(io.writes, 0);
});

test('restores legacy entries and discards resolved reviews', () => {
  assert.equal(restoreReview({oldContent:'a', newContent:'b'}, 'a'), null);
  assert.deepEqual(restoreReview({oldContent:'a', newContent:'b'}, 'c'),
    {oldContent:'a', newContent:'c', draftContent:'c', conflicted:false});
});

test('ignoring empty baselines skips only the first fill and preserves existing reviews', () => {
  for (const enabled of [false, true]) {
    const {plugin, file} = setup();
    plugin.pendingDiffs.clear();
    plugin.settings.ignoreEmptyFileChanges = enabled;
    plugin.getExistingDiffView = () => ({addFile() {}, updateReviewStatus() {}});
    plugin.handleExternalChange(file.path, '', 'first content');
    assert.equal(plugin.pendingDiffs.size, enabled ? 0 : 1);
    if (enabled) {
      assert.equal(plugin.baselines.get(file.path), 'first content');
      plugin.handleExternalChange(file.path, plugin.baselines.get(file.path), 'later edit');
      assert.equal(plugin.pendingDiffs.get(file.path).oldContent, 'first content');
    }
    const pending = plugin.pendingDiffs.get(file.path);
    pending.onDraftChange('my draft');
    plugin.handleExternalChange(file.path, '', 'another external edit');
    assert.equal(plugin.pendingDiffs.get(file.path), pending);
    assert.equal(pending.draftContent, 'my draft');
  }
});

test('preserves fully reverted drafts and flags changes made while closed', () => {
  const entry = {oldContent:'a', newContent:'b', draftContent:'a'};
  assert.deepEqual(restoreReview(entry, 'b'), {...entry, conflicted:false});
  assert.deepEqual(restoreReview(entry, 'c'), {...entry, conflicted:true});
});

test('draft edits and full reverts never write or resolve the file', () => {
  const {plugin, io, diff, file} = setup();
  diff.onDraftChange('hand-edited');
  diff.onDraftChange('original');
  assert.equal(io.disk, 'external');
  assert.equal(io.writes, 0);
  assert.equal(plugin.pendingDiffs.get(file.path), diff);
  assert.equal(plugin.serializePendingDiffs()[0].draftContent, 'original');
});

test('accept writes the draft; reject restores the original', async () => {
  for (const accept of [true, false]) {
    const {plugin, io, diff, file} = setup();
    diff.onDraftChange('reviewed');
    assert.equal(await (accept ? diff.onAccept(diff.draftContent) : diff.onReject()), true);
    assert.equal(io.disk, accept ? 'reviewed' : 'original');
    assert.equal(plugin.pendingDiffs.has(file.path), false);
  }
});

test('stale accept and reject preserve both disk and draft', async () => {
  for (const accept of [true, false]) {
    const {plugin, io, diff, file} = setup('newer external change');
    diff.onDraftChange('reviewed');
    assert.equal(await (accept ? diff.onAccept(diff.draftContent) : diff.onReject()), false);
    assert.equal(io.disk, 'newer external change');
    assert.equal(io.writes, 0);
    assert.equal(diff.conflicted, true);
    assert.equal(plugin.pendingDiffs.get(file.path), diff);
  }
});

test('external changes preserve a draft until explicitly reviewed', async () => {
  const {plugin, io, diff, file} = setup();
  diff.onDraftChange('reviewed');
  io.disk = 'new external';
  plugin.handleExternalChange(file.path, 'original', io.disk);
  assert.equal(plugin.pendingDiffs.get(file.path), diff);
  assert.equal(diff.draftContent, 'reviewed');
  assert.equal(diff.conflicted, true);
  await diff.onReviewLatest();
  const next = plugin.pendingDiffs.get(file.path);
  assert.equal(next.oldContent, 'new external');
  assert.equal(next.newContent, 'new external');
  assert.equal(next.draftContent, 'reviewed');
  assert.equal(next.conflicted, false);
  assert.equal(io.writes, 0);
  assert.equal(await next.onAccept(next.draftContent), true);
  assert.equal(io.disk, 'reviewed');
});

test('restores draft text after reload without touching disk', async () => {
  const {plugin, io, diff, file} = setup();
  diff.onDraftChange('persisted draft');
  const entries = plugin.serializePendingDiffs();
  plugin.pendingDiffs.clear();
  await plugin.restorePendingDiffs(entries);
  assert.equal(plugin.pendingDiffs.get(file.path).draftContent, 'persisted draft');
  assert.equal(io.disk, 'external');
  assert.equal(io.writes, 0);
});

test('failed writes keep the review and clear the self-write marker', async () => {
  const {plugin, io, diff, file} = setup();
  io.fail = true;
  const originalError = console.error;
  console.error = () => {};
  try { assert.equal(await diff.onAccept('reviewed'), false); }
  finally { console.error = originalError; }
  assert.equal(plugin.pendingDiffs.get(file.path), diff);
  assert.equal(plugin.selfModifyPaths.has(file.path), false);
});

test('compare happens inside process and conflict never marks a self-write', async () => {
  let marked = false;
  const vault = {process: async (_, transform) => transform('changed just before writing')};
  await assert.rejects(writeReviewedContent(vault, {}, 'external', 'draft', () => {marked = true}), ReviewConflictError);
  assert.equal(marked, false);
});

test('history restores reverted blocks and survives editor recreation', () => {
  let state = EditorState.create({doc:'external', extensions:[history()]});
  state = state.update({changes:{from:0,to:8,insert:'original'}, userEvent:'revert'}).state;
  assert.equal(undoDepth(state), 1);
  const saved = state;
  state = EditorState.create({doc:state.doc, extensions:[history(), historyField.init(() => saved.field(historyField))]});
  const target = {get state(){return state}, dispatch(tr){state = tr.state}};
  assert.equal(undo(target), true);
  assert.equal(state.doc.toString(), 'external');
  assert.equal(redo(target), true);
  assert.equal(state.doc.toString(), 'original');
});

test('accept untouched content acknowledges without writing', async () => {
  const {diff, io, plugin} = setup();
  assert.equal(await diff.onAccept(diff.draftContent), true);
  assert.equal(io.writes, 0);
  assert.equal(plugin.pendingDiffs.size, 0);
});

function lifecycleSetup() {
  const state = setup();
  const {plugin, file, io} = state;
  plugin.settings.trackFileRenames = true;
  plugin.settings.trackFileDeletions = true;
  const files = new Map([[file.path, file]]);
  plugin.app.vault.getAbstractFileByPath = path => files.get(path) ?? null;
  plugin.baselines.set(file.path, 'original');
  let changed = 0;
  const lifecycle = new FileLifecycle({vault: plugin.app.vault, settings: plugin.settings,
    baselines: plugin.baselines, reviews: plugin.pendingDiffs,
    make: (...args) => plugin.makeDiffCallbacks(...args), changed: () => { changed++; }});
  plugin.app.vault.rename = async (f, path) => {
    if (files.has(path)) throw new Error('occupied');
    files.delete(f.path); f.path = path; files.set(path, f);
  };
  plugin.app.vault.createFolder = async path => files.set(path, {path});
  plugin.app.vault.create = async (path, content) => {
    if (files.has(path)) throw new Error('occupied');
    const f = new TFile(path); files.set(path, f); io.disk = content; io.writes++; return f;
  };
  const rename = next => {
    const old = file.path; files.delete(old); file.path = next; files.set(next, file);
    lifecycle.rename(file, old);
  };
  return {...state, files, lifecycle, rename, changed: () => changed};
}

test('confirmed renames preserve identity, order, draft and history through a chain', async () => {
  const {plugin, diff, rename, io} = lifecycleSetup();
  diff.onDraftChange('my draft');
  const state = diff.editorState = EditorState.create({doc: 'my draft', extensions: [history()]});
  plugin.pendingDiffs.set('last.md', plugin.makeDiffCallbacks('last.md', 'a', 'b'));
  rename('second.md'); rename('third.md');
  assert.deepEqual([...plugin.pendingDiffs.keys()], ['third.md', 'last.md']);
  assert.equal(plugin.pendingDiffs.get('third.md'), diff);
  assert.equal(diff.editorState, state);
  assert.equal(diff.originalPath, 'note.md');
  assert.equal(await diff.onAccept('my draft'), true);
  assert.equal(io.disk, 'my draft');
  assert.equal(plugin.pendingDiffs.has('third.md'), false);
});

test('pure rename can be kept without writes or restored without content writes', async () => {
  for (const restore of [false, true]) {
    const {plugin, rename, io, file} = lifecycleSetup();
    plugin.pendingDiffs.clear(); io.disk = 'original';
    rename('new.md');
    const diff = plugin.pendingDiffs.get('new.md');
    assert.equal(await (restore ? diff.onReject() : diff.onAccept(diff.draftContent)), true);
    assert.equal(file.path, restore ? 'note.md' : 'new.md');
    assert.equal(io.writes, 0);
  }
});

test('renaming back removes a pure rename and folder events only migrate existing reviews', () => {
  const {plugin, rename, lifecycle} = lifecycleSetup();
  plugin.pendingDiffs.clear(); rename('new.md'); rename('note.md');
  assert.equal(plugin.pendingDiffs.size, 0);
  plugin.baselines.set('folder/a.md', 'a'); plugin.baselines.set('folder/b.md', 'b');
  const diff = plugin.makeDiffCallbacks('folder/a.md', 'a', 'A');
  plugin.pendingDiffs.set('folder/a.md', diff);
  lifecycle.rename({path: 'moved'}, 'folder');
  assert.deepEqual([...plugin.pendingDiffs.keys()], ['moved/a.md']);
  assert.equal(plugin.baselines.get('moved/b.md'), 'b');
  assert.equal(diff.originalPath, 'folder/a.md');
});

test('occupied original paths block restoration before any content write', async () => {
  const {rename, diff, files, io} = lifecycleSetup();
  rename('new.md'); diff.restoreOriginalPath = true;
  files.set('note.md', new TFile('note.md'));
  const log = console.error; console.error = () => {};
  try { assert.equal(await diff.onReject(), false); } finally { console.error = log; }
  assert.equal(io.writes, 0); assert.equal(io.disk, 'external');
});

test('deletion preserves existing drafts; keep deletion never writes', async () => {
  const {files, file, lifecycle, diff, io, plugin} = lifecycleSetup();
  diff.onDraftChange('precious draft'); files.delete(file.path);
  lifecycle.deleted(file);
  await new Promise(resolve => setTimeout(resolve, 550));
  assert.equal(diff.deleted, true); assert.equal(diff.draftContent, 'precious draft');
  assert.equal(diff.deletionOnly, false);
  assert.equal(await diff.onKeepDeletion(), true);
  assert.equal(io.writes, 0); assert.equal(plugin.pendingDiffs.size, 0);
  lifecycle.dispose();
});

test('transient deletion is ignored and standalone deletion restores parents', async () => {
  const {files, file, lifecycle, plugin, io} = lifecycleSetup();
  plugin.pendingDiffs.clear();
  files.delete(file.path); lifecycle.deleted(file); files.set(file.path, file);
  await new Promise(resolve => setTimeout(resolve, 550));
  assert.equal(plugin.pendingDiffs.size, 0);
  plugin.baselines.set('gone/note.md', 'saved');
  lifecycle.deleted({path: 'gone'});
  await new Promise(resolve => setTimeout(resolve, 550));
  const diff = plugin.pendingDiffs.get('gone/note.md');
  assert.equal(diff.deletionOnly, true);
  assert.equal(await diff.onReject(), true);
  assert.equal(io.disk, 'saved'); assert.ok(files.has('gone')); assert.ok(files.has('gone/note.md'));
  lifecycle.dispose();
});

test('lifecycle reviews survive restart and restore consent is not persisted', async () => {
  const {plugin, diff, rename, files} = lifecycleSetup();
  rename('new.md'); diff.restoreOriginalPath = true; diff.deleted = true; diff.draftContent = 'draft';
  files.clear();
  const entries = plugin.serializePendingDiffs();
  assert.equal(entries[0].restoreOriginalPath, undefined);
  plugin.pendingDiffs.clear();
  await plugin.restorePendingDiffs(entries);
  const restored = plugin.pendingDiffs.get('new.md');
  assert.equal(restored.originalPath, 'note.md'); assert.equal(restored.deleted, true);
  assert.equal(restored.draftContent, 'draft'); assert.equal(restored.missing, true);
});


test('bulk acceptance skips edited drafts and acknowledges deletions and renames without writes', async () => {
  const {plugin, diff, rename, io} = lifecycleSetup();
  rename('renamed.md');
  const edited = plugin.makeDiffCallbacks('draft.md', 'old', 'external');
  edited.draftContent = 'hand edited';
  let saved = 0; edited.onAccept = async () => { saved++; return true; };
  const deleted = plugin.makeDiffCallbacks('deleted.md', 'gone', 'gone');
  deleted.deleted = true;
  plugin.pendingDiffs.set('deleted.md', deleted);
  const view = new DiffView({}, {});
  view.sections.set('renamed.md', {diff, mergeView: null});
  view.sections.set('draft.md', {diff: edited, mergeView: null});
  view.sections.set('deleted.md', {diff: deleted, mergeView: null});
  view.removeFile = path => view.sections.delete(path);
  await view.handleAcceptAll();
  assert.deepEqual([...view.sections.keys()], ['draft.md']);
  assert.equal(saved, 0); assert.equal(io.writes, 0);
});

test('a rename during a content write check cannot apply a stale path', async () => {
  const {plugin, diff, rename, io} = lifecycleSetup();
  const process = plugin.app.vault.process;
  plugin.app.vault.process = async (file, transform) => { rename('moved.md'); return process(file, transform); };
  assert.equal(await diff.onReject(), false);
  assert.equal(io.writes, 0); assert.equal(io.disk, 'external');
  assert.equal(plugin.pendingDiffs.get('moved.md'), diff);
});

test('deletion decisions refuse to dismiss a file that reappeared', async () => {
  const {diff, plugin, io} = lifecycleSetup();
  diff.deleted = true;
  assert.equal(await diff.onKeepDeletion(), false);
  assert.equal(plugin.pendingDiffs.size, 1); assert.equal(io.writes, 0);
});
