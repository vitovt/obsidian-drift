/** Bounded fingerprints: exact matches first, then overlap of five-word sequences. */
export const MAX_MATCH_TEXT = 256 * 1024;
export interface Fingerprint {text: string; grams: Set<number>; words: number}

function hash(text: string): number {
	let value = 2166136261;
	for (let i = 0; i < text.length; i++) value = Math.imul(value ^ text.charCodeAt(i), 16777619);
	return value >>> 0;
}

export function fingerprint(text: string): Fingerprint | null {
	if (text.length > MAX_MATCH_TEXT || !text.trim()) return null;
	const words = text.match(/[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu) ?? [];
	if (words.length > 60000) return null;
	const grams = new Set<number>();
	for (let i = 0; i + 5 <= words.length; i++) grams.add(hash(words.slice(i, i + 5).join("\0")));
	return {text, grams, words: words.length};
}

export function similarity(a: Fingerprint, b: Fingerprint): number {
	if (a.text === b.text) return 1;
	// Tiny or repetitive notes contain too little evidence for fuzzy matching.
	if (Math.min(a.words, b.words) < 30 || Math.min(a.grams.size, b.grams.size) < 20) return 0;
	const smaller = a.grams.size < b.grams.size ? a.grams : b.grams;
	const larger = smaller === a.grams ? b.grams : a.grams;
	if (2 * smaller.size / (smaller.size + larger.size) < 0.8) return 0;
	let overlap = 0;
	for (const gram of smaller) if (larger.has(gram)) overlap++;
	// An approximate content score, never proof of identity (hash collisions included).
	return Math.min(0.999, 2 * overlap / (smaller.size + larger.size));
}
