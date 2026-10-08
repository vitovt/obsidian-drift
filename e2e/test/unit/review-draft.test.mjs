import {strict as assert} from 'node:assert';
import {test} from 'node:test';
import {build} from 'esbuild';
import {createRequire} from 'node:module';
const rootRequire = createRequire(new URL('../../../package.json', import.meta.url));
const {EditorState} = rootRequire('@codemirror/state');
const {history, historyField, undo, redo, undoDepth} = rootRequire('@codemirror/commands');

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
  stdin: {contents: `export {default as Plugin} from './src/main'; export {EditorSaves} from './src/editorSaves'; export {ProgrammaticEdits} from './src/programmaticEdits'; export * from './src/reviewDraft'; export {TFile} from 'obsidian'; export {FileLifecycle} from './src/fileLifecycle'; export {DiffView} from './src/DiffView'; export {InternalOperations} from './src/internalOperations'; export {RenameMatcher} from './src/renameMatcher'; export {RenameReviewModal} from './src/renameReviewModal'; export * from './src/renameSimilarity'; export * from './src/renameSearch'; export {renderRenameSuggestions} from './src/renameSuggestions'; export * from './src/checkpoint'; export * from './src/reviewActions'; export {selectExportEntries} from './src/export/reviewEntries';`, resolveDir: process.cwd()},
  bundle: true, write: false, platform: 'node', format: 'esm',
  plugins: [{name: 'mock-obsidian', setup(b) {
    b.onResolve({filter: /^obsidian$/}, () => ({path: 'obsidian', namespace: 'mock'}));
    b.onResolve({filter: /^electron$/}, () => ({path: 'electron', namespace: 'electron-mock'}));
    b.onLoad({filter: /.*/, namespace: 'electron-mock'}, () => ({contents: 'export const shell = {};', loader: 'js'}));
    b.onLoad({filter: /.*/, namespace: 'mock'}, () => ({contents: mock, loader: 'js'}));
  }}],
});
const {searchRenameFiles, renderRenameSuggestions, ProgrammaticEdits, EditorSaves, reviewDecision, reviewLabels, summarizeReviews, checkpoint, readCheckpoint, Plugin, TFile, FileLifecycle, DiffView, InternalOperations, RenameMatcher, RenameReviewModal, fingerprint, similarity, selectExportEntries, restoreReview, ReviewConflictError, writeReviewedContent} = await import(
  'data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));

function setup(disk = 'external') {
  const plugin = new Plugin();
  plugin.persistence = {save: data => plugin.saveData(data)};
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

test('explicit restore actions recreate missing results and originals', async () => {
  for (const accept of [true, false]) {
    const {plugin, diff, io, file} = setup();
    plugin.app.vault.getAbstractFileByPath = () => null;
    plugin.app.vault.createFolder = async () => {};
    let created;
    plugin.app.vault.create = async (path, content) => { created = {path, content}; return file; };
    diff.onDraftChange('edited draft');
    const apply = () => accept ? diff.onAccept(diff.draftContent) : diff.onReject();
    assert.equal(await apply(), true);
    assert.deepEqual(created, {path: 'note.md', content: accept ? 'edited draft' : 'original'});
    assert.equal(plugin.pendingDiffs.size, 0);
    assert.equal(io.writes, 0);
  }
});

test('a reappearing file is checked against the reviewed contents', async () => {
  const {plugin, diff, file, io} = setup();
  plugin.app.vault.getAbstractFileByPath = () => null;
  plugin.refreshMissingReviews();
  plugin.app.vault.getAbstractFileByPath = () => file;
  io.disk = 'new Dropbox contents';
  assert.equal(await diff.onReject(), false);
  assert.equal(diff.conflicted, true);
  assert.equal(io.writes, 0);
});

test('failed recreation preserves the review and never falls back to overwriting', async () => {
  const {plugin, diff, io} = setup();
  plugin.app.vault.getAbstractFileByPath = () => null;
  plugin.refreshMissingReviews();
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
  rename('new.md');
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

test('lifecycle reviews preserve paths and drafts across restart', async () => {
  const {plugin, diff, rename, files} = lifecycleSetup();
  rename('new.md'); diff.deleted = true; diff.draftContent = 'draft';
  files.clear();
  const entries = plugin.serializePendingDiffs();
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

test('API deletion reviews obey their independent setting', async () => {
  for (const trackApiChanges of [false, true]) {
    const {plugin, lifecycle, files, file} = lifecycleSetup();
    plugin.settings.trackApiChanges = trackApiChanges;
    plugin.pendingDiffs.clear(); files.clear(); lifecycle.deleted(file, true);
    await new Promise(resolve => setTimeout(resolve, 550));
    assert.equal(plugin.pendingDiffs.size, trackApiChanges ? 1 : 0);
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

test('ignored API writes preserve an existing external review', async () => {
  const {plugin, diff, file, io} = setup();
  file.saving = true; io.disk = 'plugin changed it again';
  plugin.app.vault.cachedRead = async () => io.disk;
  await plugin.handleModify(file);
  assert.equal(plugin.pendingDiffs.get(file.path), diff);
  assert.equal(diff.oldContent, 'original');
  assert.equal(diff.conflicted, true);
});

test('API review is independent of typing review', async () => {
  const {plugin, file, io} = setup();
  plugin.settings.trackApiChanges = true;
  plugin.settings.trackInAppChanges = false;
  plugin.ensureDiffTab = async () => ({addFile() {}});
  plugin.baselines.set(file.path, 'original');
  file.saving = true; io.disk = 'AI API write';
  plugin.app.vault.cachedRead = async () => io.disk;
  await plugin.handleModify(file);
  assert.equal(plugin.pendingDiffs.get(file.path).newContent, 'AI API write');
  assert.equal(plugin.pendingDiffs.get(file.path).internalReview, false);
});

test('external creation opens a review, persists, and rejects to trash', async () => {
  const {plugin, file, io} = setup('new note');
  plugin.pendingDiffs.clear(); plugin.baselineReady = true; plugin.settings.reviewNewFiles = true;
  plugin.ensureDiffTab = async () => ({addFile() {}});
  let trashed = false;
  plugin.app.fileManager = {trashFile: async () => { trashed = true; }};
  await plugin.handleCreate(file);
  await plugin.creationQueue.flush(file.path);
  assert.equal(plugin.pendingDiffs.get(file.path).created, true);
  const saved = plugin.serializePendingDiffs(); plugin.pendingDiffs.clear();
  await plugin.restorePendingDiffs(saved);
  const diff = plugin.pendingDiffs.get(file.path);
  assert.equal(diff.created, true);
  assert.equal(await diff.onReject(), true);
  assert.equal(trashed, true); assert.equal(io.writes, 0);
});

test('creation review refuses to trash contents changed since review', async () => {
  const {plugin, diff, io} = setup(); diff.created = true;
  let trashed = false; plugin.app.fileManager = {trashFile: async () => { trashed = true; }};
  io.disk = 'another device wrote this';
  assert.equal(await diff.onReject(), false);
  assert.equal(trashed, false); assert.equal(diff.conflicted, true);
});

test('editor autosaves do not become plugin reviews when typing review is off', async () => {
  const {plugin, file} = setup('my typing');
  plugin.pendingDiffs.clear(); plugin.settings.trackApiChanges = true;
  plugin.typingContents.set(file.path, 'my typing');
  plugin.baselines.set(file.path, 'my typing');
  file.saving = true;
  plugin.app.vault.cachedRead = async () => 'my typing';
  await plugin.handleModify(file);
  assert.equal(plugin.pendingDiffs.size, 0);
  assert.equal(plugin.baselines.get(file.path), 'my typing');
});

test('delayed URL autosave never reverses a newer editor link conversion', async () => {
  for (const withDraft of [false, true]) {
    const {plugin, file, diff} = setup();
    if (!withDraft) plugin.pendingDiffs.clear();
    else diff.draftContent = 'precious draft';
    plugin.settings.trackApiChanges = true;
    plugin.ensureDiffTab = async () => ({addFile() {}});
    const raw = 'https://example.com/';
    const linked = '[Example](https://example.com/)';
    plugin.typingContents.set(file.path, raw);
    plugin.typingContents.set(file.path, linked);
    plugin.baselines.set(file.path, linked);
    file.saving = true;
    for (const saved of [raw, linked]) {
      plugin.app.vault.cachedRead = async () => saved;
      await plugin.handleModify(file);
      assert.equal(plugin.baselines.get(file.path), linked);
      assert.equal(plugin.pendingDiffs.size, withDraft ? 1 : 0);
      if (withDraft) {
        assert.equal(plugin.pendingDiffs.get(file.path), diff);
        assert.equal(diff.draftContent, 'precious draft');
      }
    }
    if (!withDraft) {
      // A later API write of that same raw URL is a real change, not an autosave.
      plugin.app.vault.cachedRead = async () => raw;
      await plugin.handleModify(file);
      assert.equal(plugin.pendingDiffs.get(file.path).oldContent, linked);
      assert.equal(plugin.pendingDiffs.get(file.path).newContent, raw);
    }
  }
});

test('editor advancing during an autosave read does not rewind the baseline', async () => {
  const {plugin, file} = setup();
  plugin.pendingDiffs.clear(); plugin.settings.trackApiChanges = true;
  plugin.typingContents.set(file.path, 'URL');
  plugin.baselines.set(file.path, 'URL');
  file.saving = true;
  let resolveRead;
  plugin.app.vault.cachedRead = () => new Promise(resolve => { resolveRead = resolve; });
  const pending = plugin.handleModify(file);
  plugin.typingContents.set(file.path, 'Markdown link');
  plugin.baselines.set(file.path, 'Markdown link');
  resolveRead('URL'); await pending;
  assert.equal(plugin.pendingDiffs.size, 0);
  assert.equal(plugin.baselines.get(file.path), 'Markdown link');
});

test('startup reconciles offline edits, creations, deletions and rename candidates', async () => {
  const {plugin, matcher, files, contents} = matcherSetup();
  try {
    plugin.settings.reviewWhileClosed = true;
    plugin.settings.reviewNewFiles = true;
    plugin.savedBaselines = [['edited.md', 'before'], ['old.md', matchText]];
    for (const [path, text] of [['edited.md', 'after'], ['moved.md', matchText]]) {
      files.set(path, new TFile(path)); contents.set(path, text);
    }
    plugin.app.vault.getMarkdownFiles = () => [...files.values()];
    plugin.ensureDiffTab = async () => ({syncFiles() {}});
    let persisted;
    plugin.saveData = async data => { persisted = data; };
    await plugin.initializeBaselinesAndRestore();
    await matcher.refresh();
    assert.equal(plugin.pendingDiffs.get('edited.md').oldContent, 'before');
    assert.equal(plugin.pendingDiffs.get('edited.md').newContent, 'after');
    assert.equal(plugin.pendingDiffs.get('moved.md').created, true);
    assert.equal(plugin.pendingDiffs.get('old.md').renameCandidates[0].path, 'moved.md');
    assert.equal(new Map(persisted.baselines).get('edited.md'), 'after');
  } finally { matcher.dispose(); }
});

test('first startup establishes checkpoints without reviewing existing notes', async () => {
  const {plugin, matcher, files, contents} = matcherSetup();
  try {
    plugin.settings.reviewWhileClosed = true;
    files.set('existing.md', new TFile('existing.md')); contents.set('existing.md', 'existing');
    plugin.app.vault.getMarkdownFiles = () => [...files.values()];
    plugin.saveData = async () => {};
    await plugin.initializeBaselinesAndRestore();
    assert.equal(plugin.pendingDiffs.size, 0);
    assert.equal(plugin.baselines.get('existing.md'), 'existing');
  } finally { matcher.dispose(); }
});

test('startup read failures keep checkpoint text and edited review drafts', async () => {
  const {plugin, matcher, files, deleted} = matcherSetup();
  try {
    plugin.settings.reviewWhileClosed = true;
    const diff = deleted('unreadable.md'); diff.draftContent = 'saved draft';
    plugin.restoredDiffs = plugin.serializePendingDiffs(); plugin.pendingDiffs.clear();
    plugin.savedBaselines = [['unreadable.md', 'previous checkpoint']];
    files.set('unreadable.md', new TFile('unreadable.md'));
    plugin.app.vault.getMarkdownFiles = () => [...files.values()];
    plugin.app.vault.read = async () => { throw new Error('sync lock'); };
    plugin.ensureDiffTab = async () => ({syncFiles() {}});
    plugin.saveData = async () => {};
    await plugin.initializeBaselinesAndRestore();
    assert.equal(plugin.baselines.get('unreadable.md'), 'previous checkpoint');
    assert.equal(plugin.pendingDiffs.get('unreadable.md').draftContent, 'saved draft');
  } finally { matcher.dispose(); }
});

test('startup scan bounds concurrent reads and preserves per-file failures', async () => {
  const files = Array.from({length: 15}, (_, i) => new TFile(`${i}.md`));
  let active = 0, peak = 0;
  const {contents, unavailable} = await readCheckpoint({
    getMarkdownFiles: () => files,
    getAbstractFileByPath: path => files.find(f => f.path === path),
    read: async file => {
      active++; peak = Math.max(active, peak);
      await new Promise(resolve => setTimeout(resolve, 1)); active--;
      if (file.path === '3.md') throw new Error('locked');
      return file.path;
    },
  });
  assert.equal(contents.size, 14); assert.deepEqual([...unavailable], ['3.md']);
  assert.ok(peak <= 4);
});

test('rename dismissal is reversible and manual association can be undone', async () => {
  const {matcher, deleted, created, plugin} = matcherSetup();
  try {
    const diff = deleted('old.md'); created('new.md');
    await matcher.refresh(); matcher.keepSeparate(diff); await matcher.refresh();
    assert.equal(diff.renameCandidates.length, 0);
    matcher.resume(diff); await matcher.refresh();
    assert.equal(diff.renameCandidates[0].path, 'new.md');
    await matcher.confirm('old.md', diff, 'new.md', matchText);
    diff.draftContent = 'draft edited after association';
    await diff.onUndoRename();
    assert.equal(plugin.pendingDiffs.get('old.md'), diff);
    assert.equal(diff.deleted, true);
    assert.equal(diff.draftContent, 'draft edited after association');
    assert.equal(plugin.pendingDiffs.has('new.md'), false);
  } finally { matcher.dispose(); }
});

test('suggestion-only updates leave comparison editors intact', () => {
  const {diff} = setup();
  const view = Object.create(DiffView.prototype);
  view.settings = {trackFileRenames: true};
  view.sections = new Map([['note.md', {diff, layoutKey: view.layoutKey('note.md', diff), mergeView: {sentinel: true}}]]);
  view.updateReviewStatus = () => {};
  view.updateExportAvailability = () => {};
  let rebuilt = false; view.render = () => { rebuilt = true; };
  diff.renameSources = ['missing.md'];
  view.syncFiles(new Map([['note.md', diff]]));
  assert.equal(rebuilt, false);
  assert.equal(view.sections.get('note.md').mergeView.sentinel, true);
});

test('new files establish a baseline by default, remain rename candidates, and later edits are reviewed', async () => {
  const {plugin, matcher, deleted, files, contents} = matcherSetup();
  try {
    plugin.baselineReady = true; plugin.settings.reviewNewFiles = false;
    plugin.ensureDiffTab = async () => ({addFile() {}});
    const source = deleted('old.md');
    const file = new TFile('copied.md'); files.set(file.path, file); contents.set(file.path, matchText);
    await plugin.handleCreate(file);
    await plugin.creationQueue.flush(file.path);
    assert.equal(plugin.pendingDiffs.has(file.path), false);
    assert.equal(plugin.baselines.get(file.path), matchText);
    await matcher.refresh();
    assert.equal(source.renameCandidates[0].path, file.path);
    const changed = matchText + '\nLater edit'; contents.set(file.path, changed);
    await plugin.handleModify(file);
    assert.equal(plugin.pendingDiffs.get(file.path).oldContent, matchText);
    assert.equal(plugin.pendingDiffs.get(file.path).newContent, changed);
    assert.equal(plugin.pendingDiffs.get(file.path).created, false);
  } finally { matcher.dispose(); }
});

test('bulk restoration never applies new or changed reviews outside its confirmation', async () => {
  const {diff} = setup();
  const view = Object.create(DiffView.prototype);
  view.sections = new Map([['note.md', {diff}]]);
  const approved = new Map([['note.md', {diff, decision: reviewDecision(diff)}]]);
  diff.draftContent = 'draft changed while dialog was open';
  view.sections.set('later.md', {diff: {...diff}});
  let restored = 0; view.handleReject = async () => { restored++; };
  await view.handleRejectAll(approved);
  assert.equal(restored, 0);
});

test('keep and restore labels and counts describe actual lifecycle effects', () => {
  const {diff} = setup();
  assert.equal(reviewLabels(diff).keep, 'Keep current');
  diff.originalPath = 'old.md';
  assert.equal(reviewLabels(diff).restore, 'Restore original');
  diff.missing = true;
  assert.equal(reviewLabels(diff).keep, 'Restore result');
  const counts = summarizeReviews([diff]);
  assert.equal(counts.keep, 0); assert.equal(counts.restore, 1);
  assert.equal(counts.conflicts, 0); assert.equal(counts.unavailable, 1);
});

test('initial copy create/modify events settle into one baseline, independently of empty-file setting', async () => {
  const {plugin, file, io} = setup('');
  plugin.pendingDiffs.clear(); plugin.baselineReady = true;
  plugin.settings.reviewNewFiles = false; plugin.settings.ignoreEmptyFileChanges = false;
  plugin.ensureDiffTab = async () => ({addFile() {}});
  await plugin.handleCreate(file);
  io.disk = 'initial copied content';
  await plugin.handleModify(file);
  await plugin.creationQueue.flush(file.path);
  assert.equal(plugin.pendingDiffs.size, 0);
  assert.equal(plugin.baselines.get(file.path), 'initial copied content');
  io.disk = 'later edit'; await plugin.handleModify(file);
  assert.equal(plugin.pendingDiffs.get(file.path).oldContent, 'initial copied content');
  assert.equal(plugin.pendingDiffs.get(file.path).newContent, 'later edit');
});


test('editor autosave history expires and stays bounded', () => {
  const originalNow = Date.now;
  let now = 1000;
  Date.now = () => now;
  try {
    const saves = new EditorSaves();
    saves.set('note.md', 'old editor text');
    now += 10001;
    assert.equal(saves.consume('note.md', 'old editor text'), false);
    for (let i = 0; i < 100; i++) saves.set('note.md', `version ${i}`);
    assert.equal(saves.consume('note.md', 'version 0'), false);
    assert.equal(saves.consume('note.md', 'version 99'), true);
    assert.equal(saves.consume('note.md', 'version 99'), false);
    saves.set('large.md', 'x'.repeat(9 * 1024 * 1024));
    assert.equal(saves.entries.length, 0);
  } finally { Date.now = originalNow; }
});


test('Editor API tracking preserves nested calls, receivers, exceptions and cleanup', () => {
  const tracker = new ProgrammaticEdits();
  let path = 'note.md';
  const prototype = {
    replaceRange(text) {
      assert.equal(this, editor);
      assert.equal(tracker.isActive(path), true);
      if (text === 'fail') throw new Error('edit failed');
      return text;
    },
    replaceSelection(text) { return this.replaceRange(text); },
  };
  const editor = Object.create(prototype);
  tracker.sync([{editor, path: () => path}]);
  const wrapped = editor.replaceRange;
  tracker.sync([{editor, path: () => path}]);
  assert.equal(editor.replaceRange, wrapped);
  assert.equal(editor.replaceSelection('link'), 'link');
  assert.equal(tracker.isActive(path), false);
  assert.throws(() => editor.replaceSelection('fail'), /edit failed/);
  assert.equal(tracker.isActive(path), false);
  path = 'renamed.md';
  assert.equal(editor.replaceRange('new text'), 'new text');
  tracker.sync([]);
  assert.equal(Object.hasOwn(editor, 'replaceRange'), false);
  tracker.sync([{editor, path: () => path}]);
  const originalWrapper = editor.replaceRange;
  editor.replaceRange = function(text) { return text; };
  tracker.dispose();
  assert.notEqual(editor.replaceRange, originalWrapper);
  const detached = new ProgrammaticEdits();
  const receiver = {replaceRange() { return detached.isActive('other.md'); }};
  detached.sync([{editor: receiver, path: () => 'other.md'}]);
  const retainedWrapper = receiver.replaceRange;
  detached.dispose();
  assert.equal(retainedWrapper.call(receiver), false);
});


test('programmatic conversion retains older autosave versions and its forward review', async () => {
  const {plugin, file} = setup();
  plugin.pendingDiffs.clear(); plugin.settings.trackApiChanges = true;
  plugin.ensureDiffTab = async () => ({addFile() {}});
  const raw = 'https://example.com/';
  const linked = '[Example](https://example.com/)';
  plugin.typingContents.set(file.path, raw);
  plugin.baselines.set(file.path, raw);
  const editor = {replaceRange() {
    plugin.handleExternalChange(file.path, raw, linked);
    plugin.typingContents.set(file.path, linked);
  }};
  plugin.programmaticEdits.sync([{editor, path: () => file.path}]);
  editor.replaceRange();
  file.saving = true;
  for (const text of [raw, linked]) {
    plugin.app.vault.cachedRead = async () => text;
    await plugin.handleModify(file);
    assert.equal(plugin.pendingDiffs.get(file.path).oldContent, raw);
    assert.equal(plugin.pendingDiffs.get(file.path).newContent, linked);
    assert.equal(plugin.baselines.get(file.path), linked);
  }
  plugin.programmaticEdits.dispose();
});

function persistenceFixture(t) {
  const previousWindow = globalThis.window;
  let now = 0;
  let nextId = 0;
  const timers = new Map();
  globalThis.window = {
    setTimeout(callback, delay) {
      const id = ++nextId;
      timers.set(id, {callback, due: now + delay});
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
  };
  t.after(() => {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  });
  const plugin = new Plugin();
  plugin.persistence = {save: data => plugin.saveData(data)};
  plugin.settings = {reviewWhileClosed: true};
  plugin.baselineReady = true;
  const writes = [];
  plugin.saveData = async data => { writes.push(data); };
  return {plugin, writes, async advance(ms) {
    now += ms;
    for (const [id, timer] of timers) {
      if (timer.due <= now) { timers.delete(id); timer.callback(); }
    }
    await plugin.saveQueue;
  }};
}

test('continuous edits defer full-state persistence until five seconds idle', async t => {
  const {plugin, writes, advance} = persistenceFixture(t);
  let snapshots = 0;
  const serialize = plugin.serializePendingDiffs.bind(plugin);
  plugin.serializePendingDiffs = () => { snapshots++; return serialize(); };
  for (let i = 0; i < 120; i++) {
    plugin.baselines.set('note.md', `edit ${i}`);
    plugin.persistState();
    await advance(250);
  }
  assert.equal(writes.length, 0);
  assert.equal(snapshots, 0);
  await advance(4749);
  assert.equal(writes.length, 0);
  await advance(1);
  assert.equal(writes.length, 1);
  assert.equal(snapshots, 1);
  assert.deepEqual(writes[0].baselines, [['note.md', 'edit 119']]);
  await advance(10000);
  assert.equal(writes.length, 1);
});

test('unload flushes pending drafts and cancels the idle timer', async t => {
  const {plugin, writes, advance} = persistenceFixture(t);
  plugin.pendingDiffs.set('note.md', {oldContent: 'old', newContent: 'new', draftContent: 'draft'});
  plugin.persistState();
  plugin.onunload();
  await plugin.saveQueue;
  assert.equal(writes.length, 1);
  assert.equal(writes[0].pendingDiffs[0].draftContent, 'draft');
  plugin.persistState();
  await advance(10000);
  assert.equal(writes.length, 1);
});

test('explicit saves cancel deferred saves and wait for prior writes', async t => {
  const {plugin, writes, advance} = persistenceFixture(t);
  let release;
  plugin.saveData = data => {
    writes.push(data);
    return new Promise(resolve => { release = resolve; });
  };
  const first = plugin.saveState();
  await Promise.resolve();
  plugin.persistState();
  const second = plugin.saveState();
  plugin.baselines.set('note.md', 'latest');
  assert.equal(writes.length, 1);
  release();
  await first;
  await Promise.resolve();
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[1].baselines, [['note.md', 'latest']]);
  release();
  await second;
  await advance(10000);
  assert.equal(writes.length, 2);
});

test('editor updates defer existing saves without persisting checkpoint-only changes when disabled', async t => {
  const {plugin, writes, advance} = persistenceFixture(t);
  plugin.settings = {enabled: true, reviewWhileClosed: false};
  plugin.getPathForEditorView = () => 'note.md';
  const onUpdate = plugin.createDetectionExtension()[1].value;
  const update = {docChanged: true, transactions: [], state: {doc: {toString: () => 'typed'}}, view: {}};
  onUpdate(update);
  await advance(6000);
  assert.equal(writes.length, 0);
  assert.equal(plugin.baselines.get('note.md'), 'typed');
  plugin.persistState(); // A pending review still needs saving.
  await advance(4000);
  onUpdate(update);
  await advance(4000);
  assert.equal(writes.length, 0);
  await advance(1000);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].baselines, undefined);
});

test('plugin migrates inline data and reloads per-note state through its lifecycle', async () => {
  const files = new Map();
  let disk = {settings: {reviewWhileClosed: true}, baselines: [['note.md', 'before']],
    pendingDiffs: [{path: 'note.md', oldContent: 'before', newContent: 'external', draftContent: 'draft'}]};
  const create = () => {
    const plugin = new Plugin();
    plugin.manifest = {id: 'drift', dir: '.obsidian/plugins/drift'};
    plugin.app = {vault: {adapter: {
      exists: async () => true,
      list: async () => ({files: [...files.keys()], folders: []}),
      mkdir: async () => {},
      read: async path => files.get(path),
      write: async (path, text) => { files.set(path, text); },
      remove: async path => { files.delete(path); },
    }}};
    plugin.loadData = async () => disk;
    plugin.saveData = async data => { disk = JSON.parse(JSON.stringify(data)); };
    return plugin;
  };
  const plugin = create();
  await plugin.loadSettings();
  assert.equal(plugin.savedBaselines[0][1], 'before');
  // Saving before the startup scan must preserve restored data too.
  await plugin.saveState();
  assert.equal(disk.storage.version, 1);
  assert.equal(disk.baselines, undefined);
  assert.equal(disk.pendingDiffs, undefined);
  assert.equal(files.size, 2);
  const reloaded = create();
  await reloaded.loadSettings();
  assert.deepEqual(reloaded.savedBaselines, [['note.md', 'before']]);
  assert.equal(reloaded.restoredDiffs[0].draftContent, 'draft');
});

test('missing legacy reviews survive restart and link with tracking disabled', async () => {
  const {matcher, plugin, files, created, io} = matcherSetup();
  try {
    plugin.settings.trackFileRenames = false;
    plugin.settings.trackFileDeletions = false;
    const entries = ['old.md', 'vokoscreenNG-old.md'].map(path => ({path, oldContent: 'original ' + path, newContent: matchText}));
    await plugin.restorePendingDiffs(entries);
    assert.equal(plugin.pendingDiffs.size, 2);
    const diff = plugin.pendingDiffs.get('old.md');
    assert.equal(diff.missing, true); assert.equal(diff.deleted, undefined);
    created('known.md'); plugin.baselines.set('known.md', matchText);
    await matcher.confirm('old.md', diff, 'known.md', matchText);
    assert.equal(diff.oldContent, 'original old.md');
    assert.equal(plugin.pendingDiffs.get('known.md'), diff);
    assert.equal(plugin.pendingDiffs.has('vokoscreenNG-old.md'), true);
    const saved = plugin.serializePendingDiffs();
    plugin.pendingDiffs.clear(); await plugin.restorePendingDiffs(saved);
    const restored = plugin.pendingDiffs.get('known.md');
    await matcher.undo(restored);
    assert.equal(plugin.pendingDiffs.get('old.md').oldContent, 'original old.md');
    assert.equal(plugin.pendingDiffs.get('old.md').missing, true);
    assert.equal(files.has('known.md'), true); assert.equal(io.writes, 0);
  } finally { matcher.dispose(); }
});

test('manual missing-file linking preserves drafts and refuses every destination review', async () => {
  const {matcher, plugin, created, deleted} = matcherSetup();
  try {
    const diff = deleted('old.md'); diff.deleted = undefined; diff.missing = true;
    diff.draftContent = 'precious draft';
    created('new.md', 'remote revision');
    const other = plugin.makeDiffCallbacks('new.md', 'independent original', 'remote revision');
    plugin.pendingDiffs.set('new.md', other);
    await assert.rejects(matcher.confirm('old.md', diff, 'new.md', 'remote revision'), /unfinished review/);
    assert.equal(plugin.pendingDiffs.get('new.md'), other);
    plugin.pendingDiffs.delete('new.md');
    await matcher.confirm('old.md', diff, 'new.md', 'remote revision');
    assert.equal(diff.oldContent, matchText); assert.equal(diff.draftContent, 'precious draft');
    assert.equal(diff.conflicted, true);
  } finally { matcher.dispose(); }
});

test('missing-file controls offer manual linking without rename tracking', () => {
  const buttons = [];
  const container = {empty() {}, removeAttribute() {}, createEl(tag, options) {
    if (tag === 'button') buttons.push(options.text);
    return {addEventListener() {}};
  }};
  renderRenameSuggestions(container, {missing: true}, false);
  assert.deepEqual(buttons, ['Link to existing file…']);
});

test('explicit vault search finds known paths, ranks exact matches, and cancels', async () => {
  const {matcher, plugin, created, files} = matcherSetup();
  try {
    plugin.settings.trackFileRenames = false;
    created('known.md'); created('edited.md', matchText + '\nAn additional sentence.');
    for (const file of files.values()) file.stat = {size: 100};
    plugin.app.vault.getMarkdownFiles = () => [...files.values()];
    plugin.baselines.set('known.md', matchText);
    const results = await searchRenameFiles(plugin.app.vault, 'old.md', matchText, () => false, () => {});
    assert.equal(results[0].path, 'known.md'); assert.equal(results[0].score, 1);
    assert.equal(results[1].path, 'edited.md');
    let cancelled = false;
    const stopped = await searchRenameFiles(plugin.app.vault, 'old.md', matchText, () => cancelled, () => { cancelled = true; });
    assert.deepEqual(stopped, []);
  } finally { matcher.dispose(); }
});

test('recent creation metadata survives restart, updates contents and retains expiry', async () => {
  const {matcher, plugin, created, contents, deleted} = matcherSetup();
  try {
    created('new.md', 'first contents');
    const saved = matcher.serializeCandidates();
    matcher.created.clear(); contents.set('new.md', matchText);
    const diff = deleted('old.md'); diff.deleted = undefined; diff.missing = true;
    await matcher.restore(saved); await matcher.refresh();
    assert.equal(diff.renameCandidates[0].path, 'new.md');
    assert.equal(matcher.serializeCandidates()[0][1], saved[0][1]);
    matcher.created.clear(); diff.renameCandidates = [];
    await matcher.restore([['new.md', Date.now() - 31 * 60 * 1000]]);
    assert.deepEqual(matcher.serializeCandidates(), []);
  } finally { matcher.dispose(); }
});

test('manual linking refuses a source that reappears during confirmation', async () => {
  const {matcher, plugin, created, deleted, files} = matcherSetup();
  try {
    const diff = deleted('old.md'); diff.deleted = undefined; diff.missing = true;
    created('new.md');
    plugin.app.vault.read = async () => { files.set('old.md', new TFile('old.md')); return matchText; };
    await assert.rejects(matcher.confirm('old.md', diff, 'new.md', matchText), /changed/);
    assert.equal(plugin.pendingDiffs.get('old.md'), diff);
    assert.equal(plugin.pendingDiffs.has('new.md'), false);
  } finally { matcher.dispose(); }
});
