/**
 * Names for newly built ships: random Discord bot names from the TopStats API.
 *
 * GET https://api.topstats.gg/discord/rankings/bots?limit=500&offset=<random> with the raw token in
 * `Authorization` (no "Bearer"); names are `data[].name` and `totalBotCount` sizes the pool. Needs a
 * free key (log in at topstats.gg with Discord → Get Token) in TOPSTATS_API_KEY. One page of 500 is
 * cached for hours, so naming costs about one request per refresh (limit: 60/min per route).
 * Without a key, or if the API fails, names come from a bundled list of well-known bots.
 * Server-only.
 */

const TOPSTATS_URL = "https://api.topstats.gg/discord/rankings/bots";
const PAGE = 500;
const POOL_TTL_MS = 6 * 60 * 60 * 1000;
const RETRY_AFTER_FAILURE_MS = 15 * 60 * 1000;
const MAX_NAME = 40;

/** Used without a TopStats key, or when the API is unreachable. */
const FALLBACK = [
  "Mudae", "Karuta", "MEE6", "Dyno", "Carl-bot", "Dank Memer", "UnbelievaBoat", "Pokétwo", "OwO",
  "Tatsu", "Arcane", "YAGPDB", "Ticket Tool", "Hydra", "Nadeko", "Loritta", "Mantaro", "Ayana",
  "Sesh", "FredBoat", "Craig", "Wick", "Statbot", "Disboard", "Akinator", "Truth or Dare",
  "Rythm", "Groovy", "ProBot", "Zira", "Giveaway Boat", "Mimu", "Bleed", "Jockie Music",
  "Chip", "Owo Hunt", "Gaius", "Lawliet", "Koya", "Starboard",
];

const g = globalThis as {
  __kibbBotNames?: { pool: string[]; fetchedAt: number; total: number | null; failedAt: number };
};
const cache = (g.__kibbBotNames ??= { pool: [], fetchedAt: 0, total: null, failedAt: 0 });

/** Plain, printable, short: drop emoji and control characters, collapse spaces. */
function clean(raw: string): string | null {
  const t = raw.normalize("NFKC").replace(/[\p{Extended_Pictographic}\p{Cc}\p{Cf}]/gu, "");
  // Marks left after NFKC belong to scripts the allow-list below would garble (or are Zalgo): skip.
  if (/\p{M}/u.test(t)) return null;
  const s = Array.from(
    t
      .replace(/[^\p{L}\p{N} .'&!+-]/gu, "")
      .replace(/\s+/g, " ")
      .trim(),
  )
    .slice(0, MAX_NAME)
    .join("")
    .trim();
  return s.length >= 2 && /\p{L}/u.test(s) ? s : null;
}

async function refreshPool(): Promise<void> {
  const key = process.env.TOPSTATS_API_KEY;
  const now = Date.now();
  if (!key || now - cache.fetchedAt < POOL_TTL_MS || now - cache.failedAt < RETRY_AFTER_FAILURE_MS) return;

  // A random page once the pool size is known; the top page the first time.
  const offset = cache.total && cache.total > PAGE ? Math.floor(Math.random() * (cache.total - PAGE)) : 0;
  const url = `${TOPSTATS_URL}?limit=${PAGE}&offset=${offset}&sortBy=monthly_votes_rank&sortMethod=asc`;
  try {
    const res = await fetch(url, {
      headers: { authorization: key, accept: "application/json", "user-agent": "Tradewinds-dashboard/1.0 (ship names)" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 120)}`);
    const body = (await res.json()) as { totalBotCount?: number; data?: Array<{ name?: string }> };
    const names = [...new Set((body.data ?? []).map((b) => (b.name ? clean(b.name) : null)).filter((n): n is string => !!n))];
    if (names.length === 0) throw new Error("no names in response");
    cache.pool = names;
    cache.total = typeof body.totalBotCount === "number" ? body.totalBotCount : cache.total;
    cache.fetchedAt = now;
  } catch (e) {
    cache.failedAt = now;
    console.error(`[ship-names] TopStats fetch failed, using bundled names: ${(e as Error).message}`);
  }
}

/** A random bot name not already used by a ship in this fleet. */
export async function pickShipName(taken: Set<string>): Promise<string> {
  await refreshPool();
  const free = (list: string[]) => list.filter((n) => !taken.has(n));
  const pool = free(cache.pool).length > 0 ? free(cache.pool) : free(FALLBACK);
  if (pool.length > 0) return pool[Math.floor(Math.random() * pool.length)];

  // Every name used: number the next one.
  const base = cache.pool[0] ?? FALLBACK[Math.floor(Math.random() * FALLBACK.length)];
  for (let n = 2; ; n++) {
    const name = `${base} ${n}`;
    if (!taken.has(name)) return name;
  }
}
