import assert from 'node:assert/strict';
import {test} from 'node:test';
import {build} from 'esbuild';

const built = await build({entryPoints: ['src/statePersistence.ts'], bundle: true, write: false, platform: 'node', format: 'esm'});
const {StatePersistence} = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'));
const clone = value => JSON.parse(JSON.stringify(value));

function fixture(initial = {}) {
  const files = new Map();
  const writes = [];
  let disk = clone(initial), commits = 0, failWrite = false, failCommit = false;
  const adapter = {
    exists: async () => true,
    list: async () => ({files: [...files.keys()], folders: []}),
    mkdir: async () => {},
    read: async path => { if (!files.has(path)) throw new Error('Missing record'); return files.get(path); },
    write: async (path, text) => {
      if (failWrite) throw new Error('Record write failed');
      files.set(path, text); writes.push({path, text});
    },
    remove: async path => { files.delete(path); },
  };
  const makeStore = () => new StatePersistence(adapter, 'plugin/state', async data => {
    if (failCommit) throw new Error('Index write failed');
    disk = clone(data); commits++;
  });
  return {files, writes, makeStore, get disk() { return disk; }, get commits() { return commits; },
    set failWrite(value) { failWrite = value; }, set failCommit(value) { failCommit = value; }};
}

const legacy = () => ({settings: {reviewWhileClosed: true}, baselines: [['a.md', 'original'], ['b.md', 'unchanged']],
  pendingDiffs: [{path: 'a.md', oldContent: 'original', newContent: 'external', draftContent: 'draft',
    renameUndo: {sourcePath: 'old.md', targetPath: 'a.md', source: {oldContent: 'old', newContent: 'old', draftContent: 'old', conflicted: false}}}]});

test('legacy state migrates and restores checkpoints, drafts and rename history', async () => {
  const data = legacy(), f = fixture(data), store = f.makeStore();
  assert.deepEqual(await store.load(f.disk), data);
  await store.save(data);
  assert.equal(f.commits, 1);
  assert.equal(f.writes.length, 3);
  assert.equal(f.disk.baselines, undefined);
  assert.equal(f.disk.pendingDiffs, undefined);
  assert.equal(f.disk.storage.version, 1);
  assert.deepEqual(await f.makeStore().load(f.disk), data);
});

test('one note edit writes one record and unchanged saves write nothing', async () => {
  const data = legacy(), f = fixture(data), store = f.makeStore();
  await store.load(f.disk); await store.save(data);
  const untouched = f.disk.storage.baselines[1][1], review = f.disk.storage.reviews[0][1];
  f.writes.length = 0;
  data.baselines[0][1] = 'typed';
  await store.save(data);
  assert.equal(f.writes.length, 1);
  assert.equal(f.disk.storage.baselines[1][1], untouched);
  assert.equal(f.disk.storage.reviews[0][1], review);
  assert.equal(f.files.size, 3);
  await store.save(data);
  assert.equal(f.writes.length, 1);
  assert.equal(f.commits, 2);
  const reloaded = f.makeStore();
  await reloaded.load(f.disk); await reloaded.save(data);
  assert.equal(f.writes.length, 1);
  assert.equal(f.commits, 2);
});

test('nested draft metadata changes are detected without rewriting checkpoints', async () => {
  const data = legacy(), f = fixture(data), store = f.makeStore();
  await store.load(f.disk); await store.save(data);
  f.writes.length = 0;
  data.pendingDiffs[0].renameUndo.source.draftContent = 'edited history';
  await store.save(data);
  assert.equal(f.writes.length, 1);
  const restored = await f.makeStore().load(f.disk);
  assert.equal(restored.pendingDiffs[0].renameUndo.source.draftContent, 'edited history');
});

test('settings changes write only the index; removed reviews and disabled checkpoints are pruned', async () => {
  const data = legacy(), f = fixture(data), store = f.makeStore();
  await store.load(f.disk); await store.save(data);
  f.writes.length = 0;
  data.settings.enabled = false;
  await store.save(data);
  assert.equal(f.writes.length, 0);
  assert.equal(f.commits, 2);
  data.baselines = undefined;
  data.pendingDiffs = [];
  await store.save(data);
  assert.equal(f.files.size, 0);
  const restored = await f.makeStore().load(f.disk);
  assert.equal(restored.baselines, undefined);
  assert.deepEqual(restored.pendingDiffs, []);
});

for (const failure of ['failWrite', 'failCommit']) {
  test(`${failure} preserves the old committed state and allows retry`, async () => {
    const data = legacy(), f = fixture(data), store = f.makeStore();
    await store.load(f.disk); await store.save(data);
    const before = clone(f.disk);
    data.baselines[0][1] = 'changed'; data.pendingDiffs[0].draftContent = 'new draft';
    f[failure] = true;
    await assert.rejects(store.save(data));
    assert.deepEqual(f.disk, before);
    assert.deepEqual(await f.makeStore().load(f.disk), legacy());
    f[failure] = false;
    await store.save(data);
    assert.deepEqual(await f.makeStore().load(f.disk), data);
    assert.equal(f.files.size, 3);
  });
  test(`${failure} during migration leaves legacy data readable`, async () => {
    const data = legacy(), f = fixture(data), store = f.makeStore();
    await store.load(f.disk);
    f[failure] = true;
    await assert.rejects(store.save(data));
    assert.deepEqual(f.disk, data);
    assert.deepEqual(await f.makeStore().load(f.disk), data);
  });
}

test('missing records and unsafe references fail closed instead of discarding saved reviews', async () => {
  const data = legacy(), f = fixture(data), store = f.makeStore();
  await store.load(f.disk); await store.save(data);
  const broken = clone(f.disk);
  broken.storage.reviews[0][1] = '../../other.json';
  await assert.rejects(f.makeStore().load(broken), /Invalid Drift state reference/);
  f.files.delete(`plugin/state/${f.disk.storage.reviews[0][1]}`);
  const failed = f.makeStore();
  await assert.rejects(failed.load(f.disk), /Missing record/);
  await assert.rejects(failed.save({}), /not loaded successfully/);
});

test('orphan cleanup after restart touches only owned unreferenced record files', async () => {
  const data = legacy(), f = fixture(data), store = f.makeStore();
  await store.load(f.disk); await store.save(data);
  data.baselines[0][1] = 'uncommitted';
  f.failCommit = true;
  await assert.rejects(store.save(data));
  assert.equal(f.files.size, 4);
  f.files.set('plugin/state/unrelated.json', 'keep');
  f.failCommit = false;
  const restarted = f.makeStore();
  const restored = await restarted.load(f.disk);
  await restarted.save(restored);
  assert.equal(f.files.size, 4);
  assert.equal(f.files.get('plugin/state/unrelated.json'), 'keep');
});

test('metadata is snapshotted before asynchronous writes and later edits remain dirty', async () => {
  const data = legacy(), f = fixture(data), store = f.makeStore();
  await store.load(f.disk);
  const save = store.save(data);
  data.pendingDiffs[0].draftContent = 'typed while saving';
  data.settings.enabled = false;
  await save;
  const first = await f.makeStore().load(f.disk);
  assert.equal(first.pendingDiffs[0].draftContent, 'draft');
  assert.equal(first.settings.enabled, undefined);
  await store.save(data);
  assert.deepEqual(await f.makeStore().load(f.disk), data);
});
