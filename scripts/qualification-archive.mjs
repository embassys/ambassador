// The package includes the desktop gateway modules. Keep extraction bounded as it grows.
export function validateCandidateEntries(listing) {
  const entries = listing.trim().split("\n");
  if (
    Buffer.byteLength(listing) > 64 * 1024 ||
    entries.length < 2 ||
    entries.length > 1024 ||
    new Set(entries).size !== entries.length ||
    entries.some(
      (entry) =>
        !entry.startsWith("package/") ||
        entry.includes("..") ||
        entry.includes("\\") ||
        [...entry].some(
          (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
        ),
    )
  )
    throw new Error("candidate archive failed");
  return entries;
}
