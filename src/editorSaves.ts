/** Recent editor versions awaiting autosave, including versions superseded by a plugin. */
export class EditorSaves {
	private entries: {path: string; text: string; time: number}[] = [];

	set(path: string, text: string): void {
		this.prune();
		this.entries = this.entries.filter(entry => entry.path !== path || entry.text !== text);
		this.entries.push({path, text, time: Date.now()});
		let size = this.entries.reduce((sum, entry) => sum + entry.text.length, 0);
		while (this.entries.length > 64 || size > 8 * 1024 * 1024) {
			size -= this.entries.shift()!.text.length;
		}
	}

	consume(path: string, text: string): boolean {
		this.prune();
		const index = this.entries.findIndex(entry => entry.path === path && entry.text === text);
		if (index < 0) return false;
		this.entries.splice(index, 1);
		return true;
	}

	delete(path: string): void {
		this.entries = this.entries.filter(entry => entry.path !== path);
	}

	clear(): void { this.entries = []; }

	private prune(): void {
		const oldest = Date.now() - 10_000;
		this.entries = this.entries.filter(entry => entry.time >= oldest);
	}
}
