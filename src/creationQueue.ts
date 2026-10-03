import type {TFile} from "obsidian";

/** A copy may emit create(empty) then modify(full). Establish one settled baseline. */
export class CreationQueue {
	private pending = new Map<string, {file: TFile; internal: boolean; started: number; timer: ReturnType<typeof setTimeout>}>();
	constructor(private settled: (file: TFile, internal: boolean) => Promise<void>) {}

	defer(file: TFile, internal: boolean): void {
		const previous = this.pending.get(file.path);
		if (previous) clearTimeout(previous.timer);
		const started = previous?.started ?? Date.now();
		const path = file.path;
		const timer = setTimeout(() => { void this.flush(path); }, Math.min(250, Math.max(0, 2000 - (Date.now() - started))));
		this.pending.set(path, {file, internal, started, timer});
	}

	touch(file: TFile): boolean {
		const entry = this.pending.get(file.path);
		if (!entry) return false;
		this.defer(file, entry.internal);
		return true;
	}

	async flush(path: string): Promise<void> {
		const entry = this.pending.get(path);
		if (!entry) return;
		clearTimeout(entry.timer);
		this.pending.delete(path);
		if (entry.file.path === path) await this.settled(entry.file, entry.internal);
	}

	dispose(): void {
		for (const entry of this.pending.values()) clearTimeout(entry.timer);
		this.pending.clear();
	}
}
