import type {Editor} from "obsidian";

const methods = ["replaceRange", "replaceSelection", "setValue", "transaction"] as const;
type Method = (...args: unknown[]) => unknown;

/** Mark synchronous Editor API calls; never infer a particular plugin's identity. */
export class ProgrammaticEdits {
	private editors = new Map<Editor, () => void>();
	private active = new Map<string, number>();
	private disposed = false;

	sync(editors: {editor: Editor; path: () => string | undefined}[]): void {
		if (this.disposed) return;
		const present = new Set(editors.map(entry => entry.editor));
		for (const [editor, cleanup] of this.editors) {
			if (!present.has(editor)) { cleanup(); this.editors.delete(editor); }
		}
		for (const {editor, path} of editors) {
			if (this.editors.has(editor)) continue;
			const target = editor as unknown as Record<string, Method>;
			const cleanup: (() => void)[] = [];
			for (const name of methods) {
				const original = target[name];
				if (typeof original !== "function") continue;
				const own = Object.getOwnPropertyDescriptor(editor, name);
				// Preserve the Editor receiver while marking this tracker’s call scope.
				// eslint-disable-next-line @typescript-eslint/no-this-alias
				const tracker = this;
				const wrapped: Method = function(this: Editor, ...args) {
					const currentPath = path();
					if (tracker.disposed || !currentPath) return original.apply(this, args);
					tracker.active.set(currentPath, (tracker.active.get(currentPath) ?? 0) + 1);
					try { return original.apply(this, args); }
					finally {
						const depth = tracker.active.get(currentPath)! - 1;
						if (depth) tracker.active.set(currentPath, depth);
						else tracker.active.delete(currentPath);
					}
				};
				target[name] = wrapped;
				cleanup.push(() => {
					if (target[name] !== wrapped) return;
					if (own) Object.defineProperty(editor, name, own);
					else delete target[name];
				});
			}
			this.editors.set(editor, () => { for (const restore of cleanup) restore(); });
		}
	}

	isActive(path: string): boolean { return this.active.has(path); }

	dispose(): void {
		this.disposed = true;
		for (const cleanup of this.editors.values()) cleanup();
		this.editors.clear();
		this.active.clear();
	}
}
