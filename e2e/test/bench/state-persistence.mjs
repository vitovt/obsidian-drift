import {build} from 'esbuild';
import {mkdtemp, mkdir, readFile, writeFile, readdir, rm, unlink, access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';

const built = await build({entryPoints: ['src/statePersistence.ts'], bundle: true, write: false, platform: 'node', format: 'esm'});
const {StatePersistence} = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'));
const root = await mkdtemp(join(tmpdir(), 'drift-persistence-'));
const results = [];
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
try {
  for (const kib of [100, 1024, 5120, 10240]) {
    const directory = join(root, String(kib));
    await mkdir(directory);
    let bytes = 0, writes = 0;
    const write = async (path, text) => {
      // Include UTF-8 encoding/file preparation in the measured save, as in the trace.
      const buffer = Buffer.from(text, 'utf8');
      bytes += buffer.byteLength; writes++;
      await writeFile(path, buffer);
    };
    const adapter = {
      exists: async path => { try { await access(path); return true; } catch { return false; } },
      mkdir: path => mkdir(path),
      list: async path => ({files: (await readdir(path)).map(name => join(path, name)), folders: []}),
      read: path => readFile(path, 'utf8'), write, remove: path => unlink(path),
    };
    const note = 'Markdown observation with Unicode: спостереження.\n'.repeat(130);
    const count = Math.max(1, Math.ceil(kib * 1024 / Buffer.byteLength(note)));
    const data = {settings: {reviewWhileClosed: true}, pendingDiffs: [],
      baselines: Array.from({length: count}, (_, i) => [`note-${i}.md`, `${i}\n${note}`])};
    const store = new StatePersistence(adapter, join(directory, 'state'),
      index => write(join(directory, 'data.json'), JSON.stringify(index, null, 2)));
    await store.load(data);
    const migrationStart = performance.now();
    await store.save(data);
    const migrationMs = performance.now() - migrationStart;
    const fullTimes = [], incrementalTimes = [];
    let fullBytes = 0, incrementalBytes = 0, incrementalWrites = 0;
    for (let iteration = 0; iteration < 5; iteration++) {
      data.baselines[0][1] += `Edit ${iteration}.\n`;
      bytes = writes = 0;
      let start = performance.now();
      await write(join(directory, 'legacy.json'), JSON.stringify(data, null, 2));
      fullTimes.push(performance.now() - start); fullBytes = bytes;
      bytes = writes = 0;
      start = performance.now();
      await store.save(data);
      incrementalTimes.push(performance.now() - start);
      incrementalBytes = bytes; incrementalWrites = writes;
    }
    bytes = writes = 0;
    await store.save(data);
    results.push({targetKiB: kib, notes: count, fullBytes, incrementalBytes, incrementalWrites,
      unchangedWrites: writes, fullMedianMs: +median(fullTimes).toFixed(2),
      incrementalMedianMs: +median(incrementalTimes).toFixed(2), migrationMs: +migrationMs.toFixed(2)});
  }
  console.log(JSON.stringify({node: process.version, platform: process.platform,
    description: 'Synthetic Node filesystem benchmark, five one-note edits per size. Not Obsidian renderer timings. Migration measured separately.', results}, null, 2));
} finally { await rm(root, {recursive: true, force: true}); }
