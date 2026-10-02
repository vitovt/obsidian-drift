import {build} from 'esbuild';
import {performance} from 'node:perf_hooks';

const built = await build({
  stdin: {contents: "export {RenameMatcher} from './src/renameMatcher'; export {TFile} from 'obsidian';", resolveDir: process.cwd()},
  bundle: true, write: false, platform: 'node', format: 'esm',
  plugins: [{name: 'vault-fixture', setup(b) {
    b.onResolve({filter: /^obsidian$/}, () => ({path: 'obsidian', namespace: 'fixture'}));
    b.onLoad({filter: /.*/, namespace: 'fixture'}, () => ({contents: 'export class TFile { constructor(path) { this.path=path; this.extension="md"; } }'}));
  }}],
});
const {RenameMatcher, TFile} = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'));
const results = [];
for (const count of [32, 128, 512]) {
  const reviews = new Map(), files = new Map();
  const text = Array.from({length: 350}, (_, i) => `Item ${i} records observation_${i} and its supporting evidence.\n`).join('');
  for (let i=0; i<count; i++) reviews.set(`missing-${i}.md`, {deleted: true, oldContent: text, newContent: text, draftContent: text, matchContent: text});
  const matcher = new RenameMatcher({
    vault: {getAbstractFileByPath: path => files.get(path)},
    settings: {enabled: true, trackFileRenames: true}, reviews, baselines: new Map(), busy: () => false, changed() {},
  });
  let last = performance.now(), maxGap = 0;
  const heartbeat = setInterval(() => { const now = performance.now(); maxGap = Math.max(maxGap, now-last); last=now; }, 1);
  const start = performance.now(), heap = process.memoryUsage().heapUsed;
  for (let i=0; i<Math.min(count,128); i++) {
    const path = `created-${i}.md`; files.set(path, new TFile(path)); matcher.observe(path, i % 2 ? text + `Additional observation ${i}.` : text, true);
  }
  clearTimeout(matcher.timer); matcher.timer = undefined;
  await matcher.refresh();
  const elapsed = performance.now()-start;
  const matched = [...reviews.values()].filter(diff => diff.renameCandidates?.length).length;
  results.push({missingFiles:count, creationEvents:Math.min(count,128), matched, retainedCreationPaths:matcher.created.size, milliseconds:Math.round(elapsed), maxEventLoopGapMs:Math.round(maxGap), heapDeltaMiB:+((process.memoryUsage().heapUsed-heap)/1024/1024).toFixed(1)});
  clearInterval(heartbeat); matcher.dispose();
}
console.log(JSON.stringify({node:process.version, platform:process.platform, corpus:'~21 KiB Markdown notes with identical or slightly edited contents (ambiguous matches)', results}, null, 2));
