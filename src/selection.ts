export interface ResourceLike {
  readonly fsPath: string;
  toString(): string;
}

/**
 * Explorer commands receive the clicked resource plus every selected resource.
 * Prefer the selection, de-duplicate it, and sort by path for stable payloads.
 */
export function selectResources<T extends ResourceLike>(
  uriArg: T | undefined,
  selectionArg: T[] | undefined,
): T[] {
  const candidates = Array.isArray(selectionArg) && selectionArg.length > 0
    ? selectionArg
    : uriArg
      ? [uriArg]
      : [];
  const seen = new Set<string>();
  const unique: T[] = [];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate.fsPath !== "string") {
      continue;
    }
    const key = candidate.toString();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(candidate);
  }
  return unique.sort((left, right) => left.fsPath.localeCompare(right.fsPath));
}
