export function normalizeMergeFragment(fragment: string): string {
  return String(fragment || "").replace(/\s+/g, "").replace(/[，。！？；、,.!?;：:]/g, "").toLowerCase();
}

export function mergeDistinctContentFragments(oldContent: string, newContent: string): string {
  const oldS = String(oldContent || "").trim();
  const newS = String(newContent || "").trim();
  if (!oldS) return newS;
  if (!newS) return oldS;
  const parts = oldS.split("|").map(s => s.trim()).filter(Boolean);
  const newParts = newS.split("|").map(s => s.trim()).filter(Boolean);
  for (const np of newParts) {
    const key = normalizeMergeFragment(np);
    if (!key) continue;
    if (parts.some((existing) => normalizeMergeFragment(existing).includes(key))) continue;
    const shorterCovered = parts.some((existing) => key.includes(normalizeMergeFragment(existing)) && key.length > normalizeMergeFragment(existing).length);
    if (shorterCovered) {
      for (let i = 0; i < parts.length; i++) {
        if (key.includes(normalizeMergeFragment(parts[i])) && key.length > normalizeMergeFragment(parts[i]).length) {
          parts[i] = np;
          break;
        }
      }
    } else {
      parts.push(np);
    }
  }
  return parts.join(" | ");
}

export function mergeNodeContent(oldContent: string, newContent: string): string {
  const oldS = String(oldContent || "").trim();
  const newS = String(newContent || "").trim();
  if (!oldS) return newS;
  if (!newS) return oldS;
  const deduped = mergeDistinctContentFragments(oldS, newS);
  return deduped;
}

export function mergeContent(oldContent: string, newContent: string): string {
  const oldS = String(oldContent || "").trim();
  const newS = String(newContent || "").trim();
  if (!oldS) return newS;
  if (!newS) return oldS;
  const merged = `${oldS} | ${newS}`;
  return merged.length <= 1000 ? merged : mergeNodeContent(oldS, newS);
}
