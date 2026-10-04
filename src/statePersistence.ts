import type {DataAdapter} from "obsidian";
import type {ExternalDiffSettings} from "./settings";
import type {PersistedDiffEntry} from "./reviewDraft";

export interface PersistedData {
	settings?: Partial<ExternalDiffSettings>;
	pendingDiffs?: PersistedDiffEntry[];
	baselines?: [string, string][];
	storage?: StateIndex;
}

interface StateIndex {
	version: 1;
	baselines?: [string, string][];
	reviews: [string, string][];
}

type Adapter = Pick<DataAdapter, "exists" | "mkdir" | "list" | "read" | "write" | "remove">;
interface RecordEntry {file: string; value: unknown}
const RECORD_NAME = /^record-[0-9a-f-]{36}\.json$/;

/** Compare metadata recursively, but compare note text directly without encoding it. */
function equal(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
	if (Array.isArray(a) !== Array.isArray(b)) return false;
	const left = a as Record<string, unknown>, right = b as Record<string, unknown>;
	const keys = Object.keys(left).filter(key => left[key] !== undefined);
	return keys.length === Object.keys(right).filter(key => right[key] !== undefined).length
		&& keys.every(key => equal(left[key], right[key]));
}

/** Detach mutable metadata without copying or serializing the note strings. */
function copy(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(copy);
	if (value && typeof value === "object") {
		const result: Record<string, unknown> = {};
		for (const [key, child] of Object.entries(value)) result[key] = copy(child);
		return result;
	}
	return value;
}

function references(value: unknown): [string, string][] {
	if (!Array.isArray(value)) throw new Error("Invalid Drift state index");
	const paths = new Set<string>();
	for (const entry of value) {
		if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string"
			|| typeof entry[1] !== "string" || !RECORD_NAME.test(entry[1]) || paths.has(entry[0])) {
			throw new Error("Invalid Drift state reference");
		}
		paths.add(entry[0]);
	}
	return value as [string, string][];
}

/** Immutable per-note records; data.json is the commit point for the current generation.
 * Call save serially. Failed record/index writes leave the previously committed records intact.
 */
export class StatePersistence {
	private baselines = new Map<string, RecordEntry>();
	private reviews = new Map<string, RecordEntry>();
	private committed?: PersistedData;
	private garbage = new Set<string>();
	private directoryReady = false;
	private loaded = false;

	constructor(private adapter: Adapter, private directory: string,
		private commit: (data: PersistedData) => Promise<void>,
		private trace: (event: string, details: () => Record<string, unknown>) => void = () => {}) {}

	async load(data: PersistedData): Promise<PersistedData> {
		this.directoryReady = await this.adapter.exists(this.directory);
		if (this.directoryReady) {
			const listed = await this.adapter.list(this.directory);
			for (const path of listed.files) {
				const name = path.slice(this.directory.length + 1);
				if (path === `${this.directory}/${name}` && RECORD_NAME.test(name)) this.garbage.add(name);
			}
		}
		if (!data.storage) {
			this.loaded = true;
			return data; // Legacy data stays intact until migration commits.
		}
		if (data.storage.version !== 1) throw new Error("Unsupported Drift state format");
		const baselineRefs = data.storage.baselines === undefined ? undefined : references(data.storage.baselines);
		const reviewRefs = references(data.storage.reviews);
		const tasks = [
			...(baselineRefs ?? []).map(([path, file]) => ({path, file, review: false})),
			...reviewRefs.map(([path, file]) => ({path, file, review: true})),
		];
		const loadedReviews = new Map<string, PersistedDiffEntry>();
		let next = 0;
		await Promise.all(Array.from({length: Math.min(4, tasks.length)}, async () => {
			while (next < tasks.length) {
				const {path, file, review} = tasks[next++]!;
				const record = JSON.parse(await this.adapter.read(`${this.directory}/${file}`)) as {path?: unknown; value?: unknown};
				if (!record || record.path !== path) throw new Error("Invalid Drift state record");
				this.garbage.delete(file);
				if (review) {
					const value = record.value as PersistedDiffEntry;
					if (!value || value.path !== path || typeof value.oldContent !== "string" || typeof value.newContent !== "string"
						|| value.draftContent !== undefined && typeof value.draftContent !== "string") throw new Error("Invalid Drift review");
					loadedReviews.set(path, value);
					this.reviews.set(path, {file, value: copy(value)});
				} else {
					if (typeof record.value !== "string") throw new Error("Invalid Drift checkpoint");
					this.baselines.set(path, {file, value: record.value});
				}
			}
		}));
		this.committed = copy(data) as PersistedData;
		this.loaded = true;
		return {
			settings: data.settings,
			baselines: baselineRefs?.map(([path]) => [path, this.baselines.get(path)!.value as string]),
			pendingDiffs: reviewRefs.map(([path]) => loadedReviews.get(path)!),
		};
	}

	async save(data: PersistedData): Promise<void> {
		if (!this.loaded) throw new Error("Drift state has not loaded successfully");
		const started = performance.now();
		let changedRecords = 0, recordCharacters = 0;
		// Capture mutable metadata before the first await. Immutable strings are shared.
		const settings = copy(data.settings) as PersistedData["settings"];
		const pendingDiffs = copy(data.pendingDiffs ?? []) as PersistedDiffEntry[];
		const saveRecords = async (values: [string, unknown][], previous: Map<string, RecordEntry>) => {
			const next = new Map<string, RecordEntry>();
			for (const [path, value] of values) {
				const existing = previous.get(path);
				if (existing && equal(existing.value, value)) { next.set(path, existing); continue; }
				if (!this.directoryReady) {
					await this.adapter.mkdir(this.directory);
					this.directoryReady = true;
				}
				const file = `record-${crypto.randomUUID()}.json`;
				const text = JSON.stringify({path, value});
				this.garbage.add(file);
				await this.adapter.write(`${this.directory}/${file}`, text);
				next.set(path, {file, value});
				changedRecords++;
				recordCharacters += text.length;
			}
			return next;
		};
		const baselines = await saveRecords(data.baselines ?? [], this.baselines);
		const reviews = await saveRecords(pendingDiffs.map(review => [review.path, review]), this.reviews);
		const index: PersistedData = {settings, storage: {
			version: 1,
			baselines: data.baselines === undefined ? undefined : [...baselines].map(([path, entry]) => [path, entry.file]),
			reviews: [...reviews].map(([path, entry]) => [path, entry.file]),
		}};
		const changed = !equal(index, this.committed);
		if (changed) await this.commit(index);
		// Only a successful index write makes old records eligible for removal.
		for (const entry of [...this.baselines.values(), ...this.reviews.values()]) this.garbage.add(entry.file);
		for (const entry of [...baselines.values(), ...reviews.values()]) this.garbage.delete(entry.file);
		this.baselines = baselines;
		this.reviews = reviews;
		this.committed = index;
		for (const file of this.garbage) {
			try { await this.adapter.remove(`${this.directory}/${file}`); this.garbage.delete(file); }
			catch { /* Keep obsolete records for a later cleanup attempt. */ }
		}
		this.trace("persistence.saved", () => ({
			changedRecords, recordCharacters, indexWritten: changed,
			indexCharacters: changed ? JSON.stringify(index).length : 0,
			checkpointRecords: baselines.size, reviewRecords: reviews.size,
			durationMs: performance.now() - started,
		}));
	}
}
