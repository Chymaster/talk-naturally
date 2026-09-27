/**
 * Deterministic knowledge-point identity — design/30-domain-model.md §4.
 *
 * Progress is worthless if ids move, so an id is a pure function of stable
 * content: kind + canonical title + target language. Never an import index,
 * never a fresh UUID.
 *
 * The hash is FNV-1a (64-bit), not a cryptographic digest, on purpose: it keeps
 * `core/` free of platform APIs (no `node:crypto`), it is trivially
 * reproducible, and a collision is detectable because `canonicalKey` is stored
 * alongside the id and checked during reconciliation.
 */

const FNV_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK_64 = 0xffffffffffffffffn;

/** Lowercase, NFC, collapse whitespace, trim, drop trailing punctuation. */
export function canonicalize(text: string): string {
 return text
 .normalize("NFC")
 .toLowerCase()
 .replace(/\s+/gu, " ")
 .replace(/[.,;:!?]+$/u, "")
 .trim();
}

/** The exact string an id is derived from. Stored so the scheme is auditable. */
export function canonicalKeyOf(
 kind: string,
 title: string,
 targetLanguage: string,
): string {
 return [kind, canonicalize(title), canonicalize(targetLanguage)].join("\u0000");
}

export function fnv1a64Hex(input: string): string {
 let hash = FNV_OFFSET_BASIS;
 for (let index = 0; index < input.length; index += 1) {
 hash ^= BigInt(input.charCodeAt(index));
 hash = (hash * FNV_PRIME) & MASK_64;
 }
 return hash.toString(16).padStart(16, "0");
}

export function knowledgePointId(
 kind: string,
 title: string,
 targetLanguage: string,
): string {
 return `kp_${fnv1a64Hex(canonicalKeyOf(kind, title, targetLanguage))}`;
}

/** Class ids are derived the same way, so re-importing the same class is stable. */
export function classIdOf(title: string, targetLanguage: string): string {
 return `cls_${fnv1a64Hex([canonicalize(title), canonicalize(targetLanguage)].join("\u0000"))}`;
}
