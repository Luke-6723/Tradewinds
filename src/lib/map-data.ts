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

// ── Sea-lane corridor anchors ──────────────────────────────────────────────
// Reusable sea-lane turning points, labelled by location.
const C = {
  northChannel:   [55.2,  -5.6] as [number, number], // North Channel (between Ireland & Scotland)
  capeMalinHead:  [55.4,  -7.4] as [number, number], // NW tip of Ireland
  offSEIreland:   [51.9,  -6.2] as [number, number], // off Wexford, SE Ireland
  celticSea:      [50.8,  -7.5] as [number, number], // Celtic Sea, SW of Ireland
  lizardPoint:    [49.9,  -5.2] as [number, number], // SW tip of England
  westChannel:    [50.0,  -3.5] as [number, number], // Western English Channel
  doverStrait:    [51.0,   1.5] as [number, number], // Strait of Dover
  bristolChannel: [51.2,  -5.5] as [number, number], // Bristol Channel approach
  capeWrath:      [58.6,  -5.0] as [number, number], // Cape Wrath, NW Scotland
  northScotSea:   [58.2,  -2.5] as [number, number], // NE of Scotland, open North Sea
  humberMouth:    [53.6,   0.1] as [number, number], // off Humber mouth, North Sea
  // Iberian / Atlantic / Med
  ushant:         [48.5,  -5.5] as [number, number], // off Ushant/Finistère, NW France
  bayOfBiscay:    [44.5,  -9.0] as [number, number], // Bay of Biscay, well clear of Spain
  caboCape:       [37.0,  -9.5] as [number, number], // Cape St Vincent, SW Iberia
  gibraltarStr:   [35.9,  -5.4] as [number, number], // Strait of Gibraltar
  gulfOfLion:     [42.5,   3.5] as [number, number], // Gulf of Lion
  sardiniaCh:     [39.2,   7.8] as [number, number], // Sardinia Channel
  messina:        [38.2,  15.6] as [number, number], // off toe of Italy / Messina
  adriaticS:      [40.0,  17.5] as [number, number], // southern Adriatic
  aegeanS:        [36.5,  23.5] as [number, number], // southern Aegean
};

/**
 * Sea-lane waypoints for routes that would draw straight lines over land.
 * Keys are "{PortA}:{PortB}" — order does not matter, seaLaneWaypoints() handles both.
 */
export const SEA_LANE_WAYPOINTS: Record<string, Array<[number, number]>> = {
  // ── Dublin ─────────────────────────────────────────────────────────────────
  // South / English Channel ports — exit via SE Ireland → Celtic Sea → Channel
  "Bristol:Dublin":      [C.bristolChannel, C.offSEIreland],
  "Dublin:Plymouth":     [C.offSEIreland, C.celticSea],
  "Dublin:Portsmouth":   [C.offSEIreland, C.celticSea, C.lizardPoint, C.westChannel],
  "Dublin:London":       [C.offSEIreland, C.celticSea, C.lizardPoint, C.westChannel, C.doverStrait],
  "Dublin:Calais":       [C.offSEIreland, C.celticSea, C.lizardPoint, C.westChannel, C.doverStrait],
  "Dublin:Dunkirk":      [C.offSEIreland, C.celticSea, C.lizardPoint, C.westChannel, C.doverStrait],
  "Dublin:Antwerp":      [C.offSEIreland, C.celticSea, C.lizardPoint, C.westChannel, C.doverStrait],
  "Dublin:Rotterdam":    [C.offSEIreland, C.celticSea, C.lizardPoint, C.westChannel, C.doverStrait],
  "Dublin:Amsterdam":    [C.offSEIreland, C.celticSea, C.lizardPoint, C.westChannel, C.doverStrait],
  "Dublin:Bremen":       [C.offSEIreland, C.celticSea, C.lizardPoint, C.westChannel, C.doverStrait],
  "Dublin:Hamburg":      [C.offSEIreland, C.celticSea, C.lizardPoint, C.westChannel, C.doverStrait],
  // North / Scottish ports — exit via North Channel
  "Dublin:Glasgow":      [C.northChannel],
  "Dublin:Edinburgh":    [C.northChannel, C.northScotSea],
  "Dublin:Hull":         [C.northChannel, C.northScotSea, C.humberMouth],
  // ── Glasgow ────────────────────────────────────────────────────────────────
  // East coast / North Sea — round Cape Wrath
  "Glasgow:Hamburg":     [C.capeWrath, C.northScotSea],
  "Glasgow:Rotterdam":   [C.capeWrath, C.northScotSea],
  "Glasgow:Amsterdam":   [C.capeWrath, C.northScotSea],
  "Glasgow:Antwerp":     [C.capeWrath, C.northScotSea, C.doverStrait],
  "Calais:Glasgow":      [C.doverStrait, C.northScotSea, C.capeWrath],
  "Dunkirk:Glasgow":     [C.doverStrait, C.northScotSea, C.capeWrath],
  "Glasgow:Hull":        [C.capeWrath, C.northScotSea, C.humberMouth],
  "Glasgow:Edinburgh":   [C.capeWrath, C.northScotSea],
  // South coast / Channel ports — round Mull of Kintyre → Irish Sea → Channel
  "Glasgow:Plymouth":    [C.northChannel, C.offSEIreland, C.celticSea],
  "Glasgow:Portsmouth":  [C.northChannel, C.offSEIreland, C.celticSea, C.lizardPoint, C.westChannel],
  "Glasgow:London":      [C.northChannel, C.offSEIreland, C.celticSea, C.lizardPoint, C.westChannel, C.doverStrait],
  "Glasgow:Bristol":     [C.northChannel, C.bristolChannel],
  // ── Edinburgh to western/southern ports ────────────────────────────────────
  "Bristol:Edinburgh":   [C.bristolChannel, C.celticSea, C.lizardPoint, C.westChannel, C.humberMouth, C.northScotSea],
  "Edinburgh:Plymouth":  [C.northScotSea, C.humberMouth, C.westChannel, C.lizardPoint],
  // ── Bristol to North Sea ports (via Channel) ────────────────────────────────
  "Bristol:Hamburg":     [C.bristolChannel, C.celticSea, C.lizardPoint, C.westChannel, C.doverStrait],
  "Bristol:Bremen":      [C.bristolChannel, C.celticSea, C.lizardPoint, C.westChannel, C.doverStrait],
  "Bristol:Dunkirk":     [C.bristolChannel, C.celticSea, C.lizardPoint, C.westChannel],
  "Bristol:Antwerp":     [C.bristolChannel, C.celticSea, C.lizardPoint, C.westChannel],
  // ── Plymouth / Portsmouth to North Sea ─────────────────────────────────────
  "Plymouth:Bremen":     [C.lizardPoint, C.westChannel, C.doverStrait],
  "Plymouth:Rotterdam":  [C.lizardPoint, C.westChannel, C.doverStrait],
  "Plymouth:Antwerp":    [C.westChannel, C.doverStrait],
  "Plymouth:Edinburgh":  [C.lizardPoint, C.celticSea, C.offSEIreland, C.northChannel, C.northScotSea],
  "Portsmouth:Bremen":   [C.doverStrait],
  "Portsmouth:Dublin":   [C.westChannel, C.lizardPoint, C.celticSea, C.offSEIreland],
  // ── Mediterranean routes (future-proofing) ──────────────────────────────────
  // Northern Europe to Med — via Gibraltar
  "Lisbon:Marseille":    [C.caboCape, C.gibraltarStr, C.gulfOfLion],
  "Lisbon:Barcelona":    [C.caboCape, C.gibraltarStr],
  "Lisbon:Cartagena":    [C.caboCape, C.gibraltarStr],
  "Lisbon:Genoa":        [C.caboCape, C.gibraltarStr, C.sardiniaCh],
  "Lisbon:Naples":       [C.caboCape, C.gibraltarStr, C.sardiniaCh],
  "Lisbon:Venice":       [C.caboCape, C.gibraltarStr, C.sardiniaCh, C.adriaticS],
  "Lisbon:Piraeus":      [C.caboCape, C.gibraltarStr, C.sardiniaCh, C.aegeanS],
  "Lisbon:Istanbul":     [C.caboCape, C.gibraltarStr, C.sardiniaCh, C.aegeanS],
  "Lisbon:Alexandria":   [C.caboCape, C.gibraltarStr, C.sardiniaCh, C.aegeanS],
  // Med internal
  "Barcelona:Genoa":     [C.gulfOfLion],
  "Barcelona:Marseille": [C.gulfOfLion],
  "Cartagena:Genoa":     [C.sardiniaCh],
  "Cartagena:Naples":    [C.sardiniaCh],
  "Genoa:Naples":        [[39.0, 9.5]],                          // west of Sardinia
  "Naples:Venice":       [C.adriaticS],                          // around heel of Italy
  "Naples:Piraeus":      [C.messina, C.aegeanS],
  "Naples:Istanbul":     [C.messina, C.aegeanS],
  "Naples:Alexandria":   [C.messina, [34.0, 20.0]],
  "Piraeus:Venice":      [C.aegeanS, C.adriaticS],
  "Istanbul:Piraeus":    [[39.0, 25.0]],                         // through Aegean
  "Alexandria:Piraeus":  [[34.0, 25.0]],                         // E. Med
  "Alexandria:Naples":   [[34.0, 20.0], C.messina],
  "Alexandria:Istanbul": [[34.0, 26.0], [39.0, 27.0]],
};

/** Return waypoints for a route between two named ports, regardless of order. */

// Per North Sea port: waypoints from that port out to the Atlantic (near Ushant)
const NS_TO_ATLANTIC: Record<string, Array<[number, number]>> = {
  Hamburg:    [C.doverStrait, C.westChannel, C.ushant],
  Bremen:     [C.doverStrait, C.westChannel, C.ushant],
  Amsterdam:  [C.doverStrait, C.westChannel, C.ushant],
  Antwerp:    [C.doverStrait, C.westChannel, C.ushant],
  Calais:     [C.westChannel, C.ushant],
  Dunkirk:    [C.westChannel, C.ushant],
  Rotterdam:  [C.westChannel, C.ushant],
  London:     [C.westChannel, C.ushant],
  Portsmouth: [C.westChannel, C.ushant],
  Hull:       [C.humberMouth, C.doverStrait, C.westChannel, C.ushant],
  Plymouth:   [C.lizardPoint, C.ushant],
  Bristol:    [C.bristolChannel, C.celticSea, C.ushant],
  Dublin:     [C.offSEIreland, C.celticSea, C.ushant],
  Edinburgh:  [C.northScotSea, C.humberMouth, C.doverStrait, C.westChannel, C.ushant],
  Glasgow:    [C.northChannel, C.offSEIreland, C.celticSea, C.ushant],
};

// Per Mediterranean port: waypoints from Gibraltar heading east into that port
const GIB_TO_MED: Record<string, Array<[number, number]>> = {
  Barcelona:  [C.gulfOfLion],
  Cartagena:  [],                             // Alboran Sea — all water, no waypoints needed
  Marseille:  [C.gulfOfLion],
  Genoa:      [C.gulfOfLion],
  Naples:     [C.sardiniaCh],
  Venice:     [C.sardiniaCh, C.adriaticS],
  Piraeus:    [C.sardiniaCh, C.aegeanS],
  Istanbul:   [C.sardiniaCh, C.aegeanS],
  Alexandria: [C.sardiniaCh, C.aegeanS],
};

export function seaLaneWaypoints(
  fromName: string,
  toName: string,
): Array<[number, number]> {
  const key1 = `${fromName}:${toName}`;
  const key2 = `${toName}:${fromName}`;
  const pts = SEA_LANE_WAYPOINTS[key1] ?? SEA_LANE_WAYPOINTS[key2];
  if (pts) {
    return SEA_LANE_WAYPOINTS[key2] && !SEA_LANE_WAYPOINTS[key1] ? [...pts].reverse() : pts;
  }

  const fromIsNS = fromName in NS_TO_ATLANTIC;
  const toIsNS   = toName   in NS_TO_ATLANTIC;
  const fromMedWpts = GIB_TO_MED[fromName];
  const toMedWpts   = GIB_TO_MED[toName];

  // North Sea ↔ Lisbon (Lisbon is Atlantic-facing; no Gibraltar needed)
  if (fromIsNS && toName === "Lisbon") {
    return [...NS_TO_ATLANTIC[fromName], C.bayOfBiscay, C.caboCape];
  }
  if (fromName === "Lisbon" && toIsNS) {
    return [C.caboCape, C.bayOfBiscay, ...[...NS_TO_ATLANTIC[toName]].reverse()];
  }

  // North Sea → Mediterranean (via Bay of Biscay + Gibraltar)
  if (fromIsNS && toMedWpts !== undefined) {
    return [...NS_TO_ATLANTIC[fromName], C.bayOfBiscay, C.caboCape, C.gibraltarStr, ...toMedWpts];
  }

  // Mediterranean → North Sea (reverse of the above)
  if (fromMedWpts !== undefined && toIsNS) {
    const medToGib = [...fromMedWpts].reverse() as Array<[number, number]>;
    return [...medToGib, C.gibraltarStr, C.caboCape, C.bayOfBiscay, ...[...NS_TO_ATLANTIC[toName]].reverse()];
  }

  return [];
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
