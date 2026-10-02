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
export class FuzzySuggestModal {}
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
  stdin: {contents: `export {default as Plugin} from './src/main'; export * from './src/reviewDraft'; export {TFile} from 'obsidian'; export {FileLifecycle} from './src/fileLifecycle'; export {DiffView} from './src/DiffView'; export {InternalOperations} from './src/internalOperations'; export {RenameMatcher} from './src/renameMatcher'; export {RenameReviewModal} from './src/renameReviewModal'; export * from './src/renameSimilarity'; export {selectExportEntries} from './src/export/reviewEntries';`, resolveDir: process.cwd()},
  bundle: true, write: false, platform: 'node', format: 'esm',
  plugins: [{name: 'mock-obsidian', setup(b) {
    b.onResolve({filter: /^obsidian$/}, () => ({path: 'obsidian', namespace: 'mock'}));
    b.onResolve({filter: /^electron$/}, () => ({path: 'electron', namespace: 'electron-mock'}));
    b.onLoad({filter: /.*/, namespace: 'electron-mock'}, () => ({contents: 'export const shell = {};', loader: 'js'}));
    b.onLoad({filter: /.*/, namespace: 'mock'}, () => ({contents: mock, loader: 'js'}));
  }}],
});
const {Plugin, TFile, FileLifecycle, DiffView, InternalOperations, RenameMatcher, RenameReviewModal, fingerprint, similarity, selectExportEntries, restoreReview, ReviewConflictError, writeReviewedContent} = await import(
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

test('external rename round trip clears the returning path without inferring a rename', async () => {
  const {plugin, files, file, io, lifecycle} = lifecycleSetup();
  const originalPath = 'Лев віза.md', temporaryPath = 'Лев_віза.md';
  plugin.pendingDiffs.clear(); plugin.baselines.clear(); files.clear();
  file.path = originalPath; files.set(originalPath, file);
  io.disk = 'unchanged contents'; plugin.baselines.set(originalPath, io.disk);
  const renderedOrders = [];
  plugin.getExistingDiffView = () => ({syncFiles: reviews => renderedOrders.push([...reviews.keys()]), updateReviewStatus() {}});
  try {
    files.delete(originalPath); lifecycle.deleted(file);
    const temporary = new TFile(temporaryPath); files.set(temporaryPath, temporary);
    await plugin.handleCreate(temporary);
    await new Promise(resolve => setTimeout(resolve, 550));
    assert.equal(plugin.pendingDiffs.get(originalPath).deleted, true);
    assert.equal(plugin.pendingDiffs.has(temporaryPath), false);

    files.delete(temporaryPath); lifecycle.deleted(temporary);
    const returning = new TFile(originalPath); files.set(originalPath, returning);
    await plugin.handleCreate(returning);
    assert.equal(plugin.pendingDiffs.has(originalPath), false);
    assert.deepEqual(renderedOrders.at(-1), []);
    assert.equal(plugin.baselines.get(originalPath), io.disk);
    await new Promise(resolve => setTimeout(resolve, 550));
    // Without a confirmed rename event, the other pathname remains a deletion.
    assert.equal(plugin.pendingDiffs.get(temporaryPath).deleted, true);
    assert.equal(io.writes, 0);
  } finally { lifecycle.dispose(); }
});

test('returning files preserve edited drafts and distinguish unchanged and different contents', async () => {
  for (const current of ['external', 'another version']) {
    const {plugin, diff, files, io} = lifecycleSetup();
    diff.deleted = true; diff.missing = true;
    diff.onDraftChange('my edited draft');
    const state = diff.editorState = EditorState.create({doc: diff.draftContent, extensions: [history()]});
    const returning = new TFile('note.md'); files.set('note.md', returning); io.disk = current;
    await plugin.handleCreate(returning);
    assert.equal(plugin.pendingDiffs.get('note.md'), diff);
    assert.equal(diff.draftContent, 'my edited draft');
    assert.equal(diff.editorState, state);
    assert.equal(diff.conflicted, current !== 'external');
    assert.equal(diff.deleted, false); assert.equal(diff.missing, false);
    assert.equal(io.writes, 0);
  }
});

test('a returning file with changed content becomes a content review', async () => {
  const {plugin, diff, io, file} = lifecycleSetup();
  diff.deleted = true; diff.deletionOnly = true; diff.missing = true;
  io.disk = 'replacement contents';
  await plugin.handleCreate(file);
  const updated = plugin.pendingDiffs.get('note.md');
  assert.equal(updated.oldContent, 'original');
  assert.equal(updated.draftContent, 'replacement contents');
  assert.equal(!!updated.deleted, false); assert.equal(!!updated.deletionOnly, false);
  assert.equal(io.writes, 0);
});

test('returning original content keeps a confirmed rename review', async () => {
  const {plugin, diff, rename, io, file} = lifecycleSetup();
  rename('new.md'); diff.deleted = true; diff.missing = true;
  io.disk = diff.oldContent;
  await plugin.handleCreate(file);
  const updated = plugin.pendingDiffs.get('new.md');
  assert.equal(updated.originalPath, 'note.md');
  assert.equal(updated.newContent, updated.oldContent);
  assert.equal(io.writes, 0);
});

test('stale create-event reads cannot resolve a replacement file review', async () => {
  const {plugin, files, file, diff, io} = lifecycleSetup();
  let finishRead;
  plugin.app.vault.read = () => new Promise(resolve => { finishRead = resolve; });
  const pending = plugin.handleCreate(file);
  files.set(file.path, new TFile(file.path));
  finishRead('original'); await pending;
  assert.equal(plugin.pendingDiffs.get(file.path), diff);
  assert.equal(plugin.baselines.get(file.path), 'original');
  assert.equal(io.writes, 0);
});


test('internal operation markers cover folder children, failures, and cleanup', async () => {
  let observer;
  const vault = {
    delete: async file => { assert.equal(observer.isInternal(file.path + '/child.md'), true); throw new Error('failed'); },
    trash: async file => vault.delete(file), rename: async () => {}, create: async () => {},
  };
  const original = vault.delete;
  observer = new InternalOperations(vault);
  await assert.rejects(vault.trash({path: 'folder'}), /failed/);
  assert.equal(observer.isInternal('folder/child.md'), false);
  observer.dispose(); assert.equal(vault.delete, original);
});

test('internal renames follow existing reviews but create none by default', () => {
  const {plugin, lifecycle, files, file, diff} = lifecycleSetup();
  files.delete('note.md'); file.path = 'renamed.md'; files.set(file.path, file);
  lifecycle.rename(file, 'note.md', true);
  assert.equal(plugin.pendingDiffs.get('renamed.md'), diff);
  plugin.pendingDiffs.clear();
  file.path = 'again.md'; lifecycle.rename(file, 'renamed.md', true);
  assert.equal(plugin.pendingDiffs.size, 0);
});

test('internal deletions are opt-in while external deletions remain tracked', async () => {
  for (const trackInAppChanges of [false, true]) {
    const {plugin, lifecycle, files, file} = lifecycleSetup();
    plugin.settings.trackInAppChanges = trackInAppChanges;
    plugin.pendingDiffs.clear(); files.clear(); lifecycle.deleted(file, true);
    await new Promise(resolve => setTimeout(resolve, 550));
    assert.equal(plugin.pendingDiffs.size, trackInAppChanges ? 1 : 0);
    lifecycle.dispose();
  }
});


const matchText = Array.from({length: 100}, (_, i) => `Paragraph ${i}: the project records item_${i}, observations and decisions for later review.`).join('\n');
function matcherSetup() {
  const state = lifecycleSetup();
  const {plugin, files, io} = state;
  const contents = new Map();
  plugin.app.vault.read = async file => contents.get(file.path) ?? io.disk;
  const matcher = new RenameMatcher({vault: plugin.app.vault, settings: plugin.settings,
    reviews: plugin.pendingDiffs, baselines: plugin.baselines, busy: path => plugin.applying.has(path), changed() {}});
  plugin.renameMatcher = matcher;
  const deleted = (path, text = matchText) => {
    files.delete(path);
    const diff = plugin.makeDiffCallbacks(path, text, text);
    diff.deleted = true; diff.deletionOnly = true; diff.matchContent = text;
    plugin.pendingDiffs.set(path, diff); return diff;
  };
  const created = (path, text = matchText) => {
    files.set(path, new TFile(path)); contents.set(path, text); matcher.observe(path, text, true);
  };
  plugin.pendingDiffs.clear(); files.clear();
  return {...state, matcher, contents, deleted, created};
}

test('fingerprints tolerate small edits and reflow, but reject empty and unrelated text', () => {
  const original = fingerprint(matchText);
  assert.equal(similarity(original, fingerprint(matchText)), 1);
  assert.ok(similarity(original, fingerprint(matchText.replace('item_50', 'updated_item'))) > .9);
  assert.ok(similarity(original, fingerprint(matchText.replaceAll('\n', ' '))) > .99);
  assert.equal(fingerprint('   '), null);
  assert.equal(fingerprint('x'.repeat(256 * 1024 + 1)), null);
  assert.equal(similarity(fingerprint('short note'), fingerprint('short changed note')), 0);
  assert.ok(similarity(original, fingerprint('Completely unrelated vocabulary '.repeat(200))) < .8);
});

test('rename candidates are ordered by similarity and support either event order', async () => {
  for (const creationFirst of [false, true]) {
    const {matcher, deleted, created} = matcherSetup();
    try {
      let diff;
      if (!creationFirst) diff = deleted('old.md');
      created('changed.md', matchText.replaceAll('item_50', 'replacement'));
      created('exact.md');
      if (creationFirst) diff = deleted('old.md');
      await matcher.refresh();
      assert.deepEqual(diff.renameCandidates.map(c => c.path), ['exact.md', 'changed.md']);
      assert.equal(diff.renameCandidates[0].score, 1);
      assert.ok(diff.renameCandidates[1].score > .9);
      assert.equal(diff.path, 'old.md'); // Suggestions never associate automatically.
    } finally { matcher.dispose(); }
  }
});

test('ambiguous identical notes remain separate candidates until selected', async () => {
  const {matcher, deleted, created, plugin, io} = matcherSetup();
  try {
    const diff = deleted('old.md'); created('a.md'); created('b.md');
    await matcher.refresh();
    assert.deepEqual(diff.renameCandidates.map(c => c.path), ['a.md', 'b.md']);
    assert.equal(plugin.pendingDiffs.has('old.md'), true);
    assert.equal(io.writes, 0);
  } finally { matcher.dispose(); }
});

test('unresolved deletions can match files delivered much later', async () => {
  const {matcher, deleted, created} = matcherSetup();
  try {
    const diff = deleted('old.md'); await matcher.refresh();
    assert.deepEqual(diff.renameCandidates, []);
    // There is no short source-expiry window for a pending deletion review.
    created('arrived-later.md', matchText.replace('item_42', 'edited_item'));
    await matcher.refresh();
    assert.equal(diff.renameCandidates[0].path, 'arrived-later.md');
  } finally { matcher.dispose(); }
});

test('confirming a changed rename preserves Original and writes no files', async () => {
  const {matcher, deleted, created, plugin, io} = matcherSetup();
  try {
    const diff = deleted('old.md'); const current = matchText.replace('item_42', 'edited_item');
    created('new.md', current); await matcher.refresh();
    await matcher.confirm('old.md', diff, 'new.md', current);
    assert.equal(plugin.pendingDiffs.has('old.md'), false);
    assert.equal(plugin.pendingDiffs.get('new.md'), diff);
    assert.equal(diff.originalPath, 'old.md'); assert.equal(diff.oldContent, matchText);
    assert.equal(diff.draftContent, current); assert.equal(diff.deleted, false);
    assert.equal(io.writes, 0);
  } finally { matcher.dispose(); }
});

test('confirming a rename preserves an edited draft and session history', async () => {
  const {matcher, deleted, created, io} = matcherSetup();
  try {
    const diff = deleted('old.md'); diff.draftContent = 'hand edited draft';
    const state = diff.editorState = EditorState.create({doc: diff.draftContent, extensions: [history()]});
    const current = matchText.replace('item_42', 'remote_edit');
    created('new.md', current); await matcher.refresh();
    await matcher.confirm('old.md', diff, 'new.md', current);
    assert.equal(diff.draftContent, 'hand edited draft'); assert.equal(diff.editorState, state);
    assert.equal(diff.conflicted, true); assert.equal(io.writes, 0);
  } finally { matcher.dispose(); }
});

test('confirmation rechecks preview contents and refuses another edited review', async () => {
  const {matcher, deleted, created, contents, plugin, io} = matcherSetup();
  try {
    const diff = deleted('old.md'); created('new.md'); await matcher.refresh();
    contents.set('new.md', 'changed after preview');
    await assert.rejects(matcher.confirm('old.md', diff, 'new.md', matchText), /changed/);
    contents.set('new.md', matchText);
    const other = plugin.makeDiffCallbacks('new.md', 'initial', matchText);
    other.draftContent = 'precious other draft'; plugin.pendingDiffs.set('new.md', other);
    await assert.rejects(matcher.confirm('old.md', diff, 'new.md', matchText), /unfinished review/);
    assert.equal(plugin.pendingDiffs.get('old.md'), diff); assert.equal(other.draftContent, 'precious other draft');
    assert.equal(io.writes, 0);
  } finally { matcher.dispose(); }
});

test('bulk actions and export skip both sides of unresolved rename suggestions', async () => {
  const {matcher, deleted, created, plugin, io} = matcherSetup();
  try {
    const source = deleted('old.md'); created('new.md');
    const target = plugin.makeDiffCallbacks('new.md', 'initial', matchText);
    plugin.pendingDiffs.set('new.md', target); await matcher.refresh();
    assert.deepEqual(target.renameSources, ['old.md']);
    const view = new DiffView({}, {});
    view.sections.set('old.md', {diff: source, mergeView: null});
    view.sections.set('new.md', {diff: target, mergeView: null});
    view.removeFile = path => view.sections.delete(path);
    await view.handleAcceptAll(); await view.handleRejectAll();
    assert.equal(view.sections.size, 2); assert.equal(io.writes, 0);
    assert.deepEqual(selectExportEntries(plugin.pendingDiffs), {entries: [], omitted: 2});
    matcher.keepSeparate(source); await matcher.refresh();
    assert.deepEqual(target.renameSources, []);
    assert.equal(selectExportEntries(plugin.pendingDiffs).entries.length, 2);
  } finally { matcher.dispose(); }
});

test('saved uncertain matches stay excluded after restart and revalidate selected paths', async () => {
  const {matcher, deleted, created, plugin} = matcherSetup();
  try {
    deleted('old.md'); created('new.md'); await matcher.refresh();
    const saved = plugin.serializePendingDiffs();
    plugin.pendingDiffs.clear(); await plugin.restorePendingDiffs(saved);
    assert.equal(selectExportEntries(plugin.pendingDiffs).omitted, 1);
    await matcher.restore(); await matcher.refresh();
    assert.equal(plugin.pendingDiffs.get('old.md').renameCandidates[0].path, 'new.md');
  } finally { matcher.dispose(); }
});

test('candidate collection is bounded during bulk creation', () => {
  const {matcher, created} = matcherSetup();
  try {
    for (let i = 0; i < 200; i++) created(`file-${i}.md`, `Nonempty note ${i}`);
    assert.equal(matcher.created.size, 128);
    assert.equal(matcher.created.has('file-0.md'), false);
  } finally { matcher.dispose(); }
});


test('empty creation remains eligible when an external editor fills it later', async () => {
  const {matcher, deleted, created, contents} = matcherSetup();
  try {
    const diff = deleted('old.md'); created('new.md', '');
    await matcher.refresh(); assert.deepEqual(diff.renameCandidates, []);
    contents.set('new.md', matchText); matcher.observe('new.md', matchText);
    await matcher.refresh(); assert.equal(diff.renameCandidates[0].path, 'new.md');
  } finally { matcher.dispose(); }
});

test('disabling matching preserves unresolved suggestions and bulk exclusions', async () => {
  const {matcher, deleted, created, plugin} = matcherSetup();
  try {
    const diff = deleted('old.md'); created('new.md'); await matcher.refresh();
    plugin.settings.trackFileRenames = false; await matcher.refresh();
    assert.equal(diff.renameCandidates[0].path, 'new.md');
    assert.equal(selectExportEntries(plugin.pendingDiffs).omitted, 1);
    matcher.keepSeparate(diff); await matcher.refresh();
    assert.equal(selectExportEntries(plugin.pendingDiffs).omitted, 0);
  } finally { matcher.dispose(); }
});

test('rename confirmation explains missing preview and remains retryable after errors', async () => {
  const modal = Object.create(RenameReviewModal.prototype);
  modal.confirmButton = {disabled: false};
  let message = '';
  modal.status = {addClass() {}, setText(value) { message = value; }};
  modal.path = 'old.md'; modal.diff = {deleted: true}; modal.closed = false;
  let attempts = 0; let closed = false;
  modal.matcher = {async confirm() { attempts++; throw new Error('The files changed. Open a new preview before confirming.'); }};
  modal.close = () => { closed = true; };

  await modal.confirm();
  assert.match(message, /Preview a candidate/);
  assert.equal(modal.confirmButton.disabled, false);

  modal.selected = {path: 'new.md', content: 'preview'};
  await modal.confirm();
  assert.match(message, /files changed/);
  assert.equal(modal.confirmButton.disabled, false);
  assert.equal(attempts, 1);
  assert.equal(closed, false);

  modal.matcher.confirm = async () => { attempts++; };
  await modal.confirm();
  assert.equal(attempts, 2);
  assert.equal(closed, true);
});

test('replacement saves compare against the previous baseline', async () => {
  const {plugin, lifecycle, files, file, io} = lifecycleSetup();
  plugin.pendingDiffs.clear();
  plugin.ensureDiffTab = async () => ({addFile() {}});
  files.delete(file.path); lifecycle.deleted(file);
  const replacement = new TFile(file.path);
  files.set(file.path, replacement); io.disk = 'replacement content';
  await plugin.handleCreate(replacement);
  lifecycle.flushDeletions(); lifecycle.dispose();
  assert.equal(plugin.pendingDiffs.get(file.path).oldContent, 'original');
  assert.equal(plugin.pendingDiffs.get(file.path).newContent, 'replacement content');
});

test('missing content reviews preserve edited drafts across restart', async () => {
  const {plugin, diff} = setup();
  diff.draftContent = 'precious edited draft';
  const saved = plugin.serializePendingDiffs();
  plugin.pendingDiffs.clear();
  plugin.app.vault.getAbstractFileByPath = () => null;
  await plugin.restorePendingDiffs(saved);
  const restored = plugin.pendingDiffs.get('note.md');
  assert.equal(restored.draftContent, 'precious edited draft');
  assert.equal(restored.missing, true);
  assert.equal(restored.recreateMissingFile, undefined);
});

test('matching visits older pending sources beyond one bounded batch', async () => {
  const {matcher, deleted, created} = matcherSetup();
  try {
    const oldest = deleted('oldest.md');
    for (let i = 0; i < 129; i++) deleted(`missing-${i}.md`, `different short text ${i}`);
    created('moved.md');
    await matcher.refresh();
    assert.equal(oldest.renameCandidates[0].path, 'moved.md');
    assert.ok(matcher.sources.size <= 128);
  } finally { matcher.dispose(); }
});
