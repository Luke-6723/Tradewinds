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

/**
 * Sea-lane waypoints for routes that would draw straight lines over land.
 * Keys are "{PortA}:{PortB}" with ports in alphabetical order.
 * Values are intermediate [lat, lng] points the route should pass through.
 */
export const SEA_LANE_WAYPOINTS: Record<string, Array<[number, number]>> = {
  // Dublin routes — Irish Sea, St George's Channel, Celtic Sea
  "Bristol:Dublin":      [[51.6, -5.5]],                       // Bristol Channel → Celtic Sea
  "Dublin:Edinburgh":    [[55.2, -5.6]],                       // North Channel
  "Dublin:Glasgow":      [[55.2, -5.6]],                       // North Channel
  "Dublin:Hull":         [[54.0, -5.2], [54.0, -3.0]],         // Irish Sea → NE England coast
  "Dublin:Hamburg":      [[55.2, -5.6], [57.0, -2.0]],         // North Channel → North Sea
  "Dublin:London":       [[51.6, -5.5], [50.5, -3.0]],         // Celtic Sea → English Channel
  "Dublin:Plymouth":     [[51.6, -5.8]],                       // Celtic Sea
  "Dublin:Portsmouth":   [[51.6, -5.5], [50.6, -2.5]],         // Celtic Sea → English Channel
  "Dublin:Rotterdam":    [[53.5, -5.0], [53.0, -2.0]],         // Irish Sea south → North Sea
  "Dublin:Antwerp":      [[52.0, -5.2], [51.5, -2.0]],         // St George's → Channel
  "Dublin:Bremen":       [[55.2, -5.6], [57.0, -1.0]],         // North Channel → North Sea
  "Dublin:Dunkirk":      [[51.6, -5.5], [50.5, -1.5]],         // Celtic Sea → Channel
  "Dublin:Calais":       [[51.6, -5.5], [50.5, -1.5]],         // Celtic Sea → Channel
  "Dublin:Amsterdam":    [[53.5, -5.0], [53.0, -2.0]],         // Irish Sea → North Sea
  // Glasgow routes that cross Scotland/England
  "Calais:Glasgow":      [[55.2, -5.6]],                       // round North Channel
  "Glasgow:Hamburg":     [[57.5, -2.0]],                       // tip of Scotland → North Sea
  "Amsterdam:Glasgow":   [[57.5, -2.0]],                       // North Sea → tip of Scotland
  "Glasgow:Rotterdam":   [[57.5, -2.0]],                       // North Sea → tip of Scotland
  "Antwerp:Glasgow":     [[55.2, -5.6]],                       // round North Channel
  "Dunkirk:Glasgow":     [[55.2, -5.6]],                       // round North Channel
  // Mediterranean routes that might cross land (future-proofing)
  "Genoa:Naples":        [[39.5, 9.5]],                        // west of Sardinia
  "Barcelona:Genoa":     [[41.5, 5.5]],                        // Gulf of Lion
  "Cartagena:Genoa":     [[39.5, 7.0]],                        // via Sardinia west
  "Lisbon:Marseille":    [[36.0, -5.5], [36.5, 0.0]],          // Gibraltar → Gulf of Lion
  "Lisbon:Barcelona":    [[36.0, -5.5]],                       // Gibraltar Strait
  "Lisbon:Cartagena":    [[36.0, -5.5]],                       // Gibraltar Strait
  "Lisbon:Genoa":        [[36.0, -5.5], [39.0, 4.5]],          // Gibraltar → Med
  "Lisbon:Naples":       [[36.0, -5.5], [38.5, 10.0]],         // Gibraltar → Tyrrhenian
  "Lisbon:Venice":       [[36.0, -5.5], [37.5, 12.0]],         // Gibraltar → Adriatic
  "Lisbon:Piraeus":      [[36.0, -5.5], [35.5, 15.0]],         // Gibraltar → Ionian
  "Lisbon:Istanbul":     [[36.0, -5.5], [35.5, 18.0]],         // Gibraltar → Aegean
  "Lisbon:Alexandria":   [[36.0, -5.5], [32.0, 20.0]],         // Gibraltar → E. Med
  "Naples:Venice":       [[39.5, 16.5]],                       // heel of Italy → Adriatic
  "Piraeus:Venice":      [[39.5, 16.5]],                       // Adriatic entry
  "Istanbul:Naples":     [[37.0, 22.0], [38.5, 16.5]],         // Aegean → S. Italy
  "Alexandria:Naples":   [[33.0, 22.0], [38.5, 14.0]],         // E. Med → Tyrrhenian
  "Alexandria:Piraeus":  [[33.5, 25.5]],                       // E. Med north
};

/** Return waypoints for a route between two named ports, regardless of order. */
export function seaLaneWaypoints(
  fromName: string,
  toName: string,
): Array<[number, number]> {
  const key1 = `${fromName}:${toName}`;
  const key2 = `${toName}:${fromName}`;
  return SEA_LANE_WAYPOINTS[key1] ?? SEA_LANE_WAYPOINTS[key2] ?? [];
}

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
