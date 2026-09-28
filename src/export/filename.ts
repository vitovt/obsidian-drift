export const DEFAULT_EXPORT_TEMPLATE = "drift-%Y-%m-%d_%H-%M.diff.txt";

export function filenameError(name: string): string | null {
	if (!name || name !== name.trim()) return "Enter a filename without leading or trailing spaces.";
	if (name === "." || name === ".." || /[/\\:*?"<>|]/.test(name) ||
		Array.from(name).some(char => char.charCodeAt(0) < 32) || name.endsWith(".")) {
		return "Use a filename only, without folders or reserved characters.";
	}
	if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) return "This filename is reserved by the operating system.";
	if (new TextEncoder().encode(name).length > 255) return "The filename is too long.";
	return null;
}

export function formatExportFilename(template: string, date = new Date()): string {
	const pad = (value: number) => ("0" + value).slice(-2);
	const tokens: Record<string, string> = {
		Y: String(date.getFullYear()), m: pad(date.getMonth() + 1), d: pad(date.getDate()),
		H: pad(date.getHours()), M: pad(date.getMinutes()), S: pad(date.getSeconds()), "%": "%",
	};
	const name = template.replace(/%(.|$)/g, (_, token: string) => {
		if (tokens[token] === undefined) throw new Error("Use only %Y, %m, %d, %H, %M, %S or %% in the filename template.");
		return tokens[token];
	});
	const error = filenameError(name);
	if (error) throw new Error(error);
	return name;
}

export async function availableFilename(name: string, exists: (path: string) => Promise<boolean>): Promise<string> {
	const extensionAt = name.endsWith(".diff.txt") ? name.length - 9 : name.lastIndexOf(".");
	const stem = extensionAt > 0 ? name.slice(0, extensionAt) : name;
	const extension = extensionAt > 0 ? name.slice(extensionAt) : "";
	let candidate = name;
	for (let suffix = 2; await exists(candidate); suffix++) candidate = `${stem}-${suffix}${extension}`;
	return candidate;
}
