/* eslint-disable @typescript-eslint/unbound-method -- Preserve original methods and explicitly forward their receivers. */
import type {Vault} from "obsidian";

/** Mark calls through public Vault APIs before their filesystem events fire. */
export class InternalOperations {
	private paths = new Map<string, number>();
	private cleanup: (() => void)[] = [];
	private enabled = true;

	constructor(vault: Vault) {
		const run = this.run.bind(this);
		const remove = vault.delete;
		const trash = vault.trash;
		const rename = vault.rename;
		const create = vault.create;
		const wrappedDelete: Vault["delete"] = function(this: Vault, file, force) {
			return run(file.path, () => remove.call(this, file, force));
		};
		const wrappedTrash: Vault["trash"] = function(this: Vault, file, system) {
			return run(file.path, () => trash.call(this, file, system));
		};
		const wrappedRename: Vault["rename"] = function(this: Vault, file, path) {
			return run(file.path, () => rename.call(this, file, path));
		};
		const wrappedCreate: Vault["create"] = function(this: Vault, path, data, options) {
			return run(path, () => create.call(this, path, data, options));
		};
		vault.delete = wrappedDelete;
		vault.trash = wrappedTrash;
		vault.rename = wrappedRename;
		vault.create = wrappedCreate;
		this.cleanup.push(() => {
			if (vault.delete === wrappedDelete) vault.delete = remove;
			if (vault.trash === wrappedTrash) vault.trash = trash;
			if (vault.rename === wrappedRename) vault.rename = rename;
			if (vault.create === wrappedCreate) vault.create = create;
		});
	}

	isInternal(path: string): boolean {
		return [...this.paths.keys()].some(parent => path === parent || path.startsWith(parent + "/"));
	}

	private async run<T>(path: string, action: () => Promise<T>): Promise<T> {
		if (!this.enabled) return action();
		this.paths.set(path, (this.paths.get(path) ?? 0) + 1);
		try { return await action(); }
		finally {
			const count = (this.paths.get(path) ?? 1) - 1;
			if (count) this.paths.set(path, count);
			else this.paths.delete(path);
		}
	}

	dispose(): void {
		this.enabled = false;
		for (const cleanup of this.cleanup) cleanup();
		this.paths.clear();
	}
}
