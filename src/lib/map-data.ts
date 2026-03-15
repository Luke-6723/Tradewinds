import type { Route } from "@/lib/types";

export const PORT_COORDS: Record<string, [number, number]> = {
  // North Sea / English Channel
  Rotterdam:  [51.92,  4.48],
  Plymouth:   [50.37, -4.14],
  Portsmouth: [50.80, -1.09],
  Amsterdam:  [52.37,  4.90],
  Hull:       [53.74, -0.33],
  Bremen:     [53.08,  8.80],
  Bristol:    [51.45, -2.59],
  Dublin:     [53.33, -6.25],
  Dunkirk:    [51.03,  2.37],
  Edinburgh:  [55.95, -3.19],
  Calais:     [50.95,  1.85],
  Hamburg:    [53.55, 10.00],
  Antwerp:    [51.22,  4.40],
  Glasgow:    [55.86, -4.26],
  London:     [51.51, -0.13],
  // Iberian / Atlantic
  Lisbon:     [38.72, -9.14],
  Barcelona:  [41.39,  2.17],
  Cartagena:  [37.63, -0.99],
  // Western Mediterranean
  Marseille:  [43.30,  5.37],
  Genoa:      [44.41,  8.95],
  // Italian / Adriatic
  Naples:     [40.85, 14.27],
  Venice:     [45.44, 12.32],
  // Eastern Mediterranean
  Piraeus:    [37.94, 23.65],
  Istanbul:   [41.01, 28.98],
  Alexandria: [31.20, 29.92],
};

export function buildMST(routes: Route[]): Set<string> {
  const parent = new Map<string, string>();
  function find(x: string): string {
    if (!parent.has(x)) parent.set(x, x);
    if (parent.get(x) !== x) parent.set(x, find(parent.get(x)!));
    return parent.get(x)!;
  }
  function union(a: string, b: string): boolean {
    const ra = find(a), rb = find(b);
    if (ra === rb) return false;
    parent.set(ra, rb);
    return true;
  }
  const mstIds = new Set<string>();
  for (const r of [...routes].sort((a, b) => a.distance - b.distance)) {
    if (union(r.from_id, r.to_id)) mstIds.add(r.id);
  }
  return mstIds;
}
