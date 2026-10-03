import {appendFile, mkdtemp} from "fs/promises";
import {tmpdir} from "os";
import {join} from "path";

/** Temporary JSONL diagnostics. Callers provide metadata, never note or clipboard text. */
export class DebugLog {
	private sequence = 0;
	private file?: Promise<string>;
	private lines: string[] = [];
	private dropped = 0;
	private timer?: ReturnType<typeof setTimeout>;
	private queue: Promise<void> = Promise.resolve();
	private flushing = false;
	private failed = false;
	private paused = false;
	private cleanupMonitoring?: () => void;
	private lastFlush?: {durationMs: number; lines: number; characters: number};
	private serializationMs = 0;
	constructor(private enabled: () => boolean, private settings: () => Record<string, unknown>,
		private reportError: (message: string) => void) {}

	async location(): Promise<string | undefined> { return this.file; }

	async start(): Promise<void> {
		await this.stop();
		this.file = undefined;
		this.failed = false;
		this.sequence = 0;
		this.paused = false;
		this.lastFlush = undefined;
		this.serializationMs = 0;
	}

	monitor(doc: Document, path: () => string | undefined): void {
		this.cleanupMonitoring?.();
		if (!this.enabled() || this.failed) return;
		this.paused = false;
		const inputCounts: Record<string, number> = {};
		let lastInput = 0;
		const input = (event: Event) => {
			if (!(event.target instanceof Element) || !event.target.closest(".cm-editor")) return;
			const type = event instanceof InputEvent ? event.inputType : event.type;
			inputCounts[type] = (inputCounts[type] ?? 0) + 1;
			const now = performance.now();
			if (event.type === "beforeinput" && now - lastInput < 250) return;
			lastInput = now;
			this.write("input.event", () => ({type: event.type, inputType: type, trusted: event.isTrusted, path: path()}));
		};
		const types = ["beforeinput", "paste", "compositionstart", "compositionend"];
		for (const type of types) doc.addEventListener(type, input, true);
		let expected = performance.now() + 1000;
		const heartbeat = setInterval(() => {
			const now = performance.now();
			this.write("debug.performance", () => ({
				eventLoopDelayMs: Math.max(0, now - expected),
				lastFlush: this.lastFlush, serializationMs: this.serializationMs,
				bufferedEvents: this.lines.length, writing: this.flushing,
				inputCounts: {...inputCounts}, visibility: doc.visibilityState,
			}));
			expected = now + 1000;
			this.serializationMs = 0;
			for (const key of Object.keys(inputCounts)) delete inputCounts[key];
		}, 1000);
		this.cleanupMonitoring = () => {
			clearInterval(heartbeat);
			for (const type of types) doc.removeEventListener(type, input, true);
		};
	}

	async stop(): Promise<void> {
		this.paused = true;
		this.cleanupMonitoring?.();
		this.cleanupMonitoring = undefined;
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		await this.queue;
		this.flush();
		await this.queue;
	}

	write(event: string, details: () => Record<string, unknown> = () => ({})): void {
		if (!this.enabled() || this.failed || this.paused) return;
		const started = performance.now();
		if (!this.file) {
			this.file = mkdtemp(join(tmpdir(), "obsidian-drift-debug-"))
				.then(async directory => {
					const path = join(directory, "events.jsonl");
					await appendFile(path, "", {mode: 0o600});
					return path;
				});
			void this.file.catch(error => this.fail(error));
		}
		if (this.lines.length >= 1000) { this.dropped++; return; }
		this.lines.push(JSON.stringify({
			time: new Date().toISOString(), sequence: ++this.sequence,
			event, settings: this.settings(), ...details(),
		}));
		this.serializationMs += performance.now() - started;
		if (!this.timer) this.timer = setTimeout(() => this.flush(), 250);
	}

	flush(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		if (this.flushing) {
			if (!this.paused) this.timer = setTimeout(() => this.flush(), 250);
			return;
		}
		if (!this.file || !this.lines.length) return;
		const file = this.file;
		const lines = this.lines;
		this.lines = [];
		if (this.dropped) {
			lines.push(JSON.stringify({time: new Date().toISOString(), event: "debug.dropped", count: this.dropped}));
			this.dropped = 0;
		}
		this.flushing = true;
		this.queue = this.queue.then(async () => {
			const started = performance.now();
			const payload = lines.join("\n") + "\n";
			await appendFile(await file, payload);
			const durationMs = performance.now() - started;
			this.lastFlush = {durationMs, lines: lines.length, characters: payload.length};
			// Include the measurement in this batch, without recursively logging another flush.
			await appendFile(await file, JSON.stringify({time: new Date().toISOString(), event: "debug.flush", ...this.lastFlush}) + "\n");
		})
			.catch(error => this.fail(error))
			.finally(() => { this.flushing = false; });
	}

	private fail(error: unknown): void {
		if (this.failed) return;
		this.failed = true;
		this.cleanupMonitoring?.();
		this.cleanupMonitoring = undefined;
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		this.lines = [];
		this.reportError(`Drift could not write its debug log: ${error instanceof Error ? error.message : String(error)}`);
	}
}
