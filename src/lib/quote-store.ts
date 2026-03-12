import type { Quote } from "@/lib/types";

const STORAGE_KEY = "tw_quotes";

export function saveQuote(quote: Quote): void {
  if (typeof window === "undefined") return;
  const existing = getQuotes();
  // Replace if same token, otherwise append
  const updated = [...existing.filter((q) => q.token !== quote.token), quote];
  localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
}

export function getQuotes(): Quote[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Quote[];
    // Purge already-expired quotes on read
    const now = Date.now();
    const active = parsed.filter((q) => new Date(q.expires_at).getTime() > now);
    if (active.length !== parsed.length) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(active));
    }
    return active;
  } catch {
    return [];
  }
}

export function removeQuote(token: string): void {
  if (typeof window === "undefined") return;
  const updated = getQuotes().filter((q) => q.token !== token);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
}
