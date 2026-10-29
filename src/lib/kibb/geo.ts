/**
 * Map geometry for the kibb.io world. The catalog has no coordinates, so ports sit at their real
 * positions, each sea zone at a point inside it, and routes run port → zone → … → zone → port
 * (the node ids `/v1/world/route` legs use). Lanes that would cut across land get waypoints.
 */

import type { RivalShip } from "./rivals";
import type { ShipResult } from "./types";

export type LatLng = [number, number];

/** Every route node: ports and sea zones. */
export const NODE_COORDS: Record<string, LatLng> = {
  // ── Ports ──
  dover: [51.13, 1.31],
  calais: [50.96, 1.85],
  portsmouth: [50.8, -1.1],
  london: [51.51, -0.08],
  dunkirk: [51.04, 2.37],
  le_havre: [49.49, 0.11],
  ostend: [51.23, 2.92],
  amsterdam: [52.37, 4.9],
  newcastle: [54.97, -1.61],
  hamburg: [53.55, 9.97],
  bergen: [60.39, 5.32],
  copenhagen: [55.68, 12.57],
  stockholm: [59.33, 18.07],
  danzig: [54.35, 18.65],
  konigsberg: [54.71, 20.51],
  riga: [56.95, 24.11],
  nantes: [47.22, -1.55],
  bordeaux: [44.84, -0.58],
  lisbon: [38.71, -9.14],
  cadiz: [36.53, -6.29],
  madeira: [32.65, -16.91],
  tenerife: [28.47, -16.25],
  cape_verde: [14.93, -23.51],
  elmina: [5.08, -1.35],
  bridgetown: [13.1, -59.62],
  port_royal: [17.94, -76.84],
  santo_domingo: [18.47, -69.89],
  havana: [23.14, -82.36],
  cartagena: [10.39, -75.51],
  veracruz: [19.18, -96.13],
  st_helena: [-15.93, -5.72],
  cape_town: [-33.92, 18.42],
  zanzibar: [-6.16, 39.19],
  muscat: [23.61, 58.59],
  goa: [15.49, 73.82],
  calicut: [13.08, 80.29],
  colombo: [6.93, 79.85],
  aceh: [5.55, 95.32],
  malacca: [2.19, 102.25],
  batavia: [-6.12, 106.81],
  ternate: [0.79, 127.38],
  canton: [23.1, 113.43],
  // The American colonies (Phase 2, guide 3.15). The catalog ids aren't published: these are guesses at them; a port the
  // catalog names otherwise is placed by its sea zone (placeCatalog), and a node placed nowhere is simply not drawn.
  st_johns: [47.56, -52.71],
  boston: [42.36, -71.05],
  new_york: [40.7, -74.01],
  philadelphia: [39.95, -75.14],
  norfolk: [36.85, -76.29],
  charleston: [32.78, -79.93],
  // Smugglers' coves (guide 3.18).
  st_peter_port: [49.46, -2.54],
  roscoff: [48.73, -3.98],
  flushing: [51.44, 3.57],
  st_eustatius: [17.49, -62.98],
  ocracoke_inlet: [35.07, -76.02],

  // ── Sea zones ──
  dover_strait: [51.0, 1.45],
  english_channel: [50.15, -0.6],
  thames_estuary: [51.55, 1.15],
  flemish_banks: [51.35, 2.6],
  zuiderzee_texel: [53.1, 4.5],
  dogger_north_sea: [55.0, 2.5],
  heligoland_bight: [54.15, 7.9],
  norwegian_trench: [58.6, 4.3],
  the_sound: [55.9, 12.75],
  gdansk_bay: [54.75, 18.9],
  central_baltic: [57.8, 19.6],
  gulf_of_riga: [57.6, 23.4],
  bay_of_biscay: [46.0, -5.5],
  iberian_coast: [40.0, -10.0],
  gulf_of_cadiz: [36.4, -7.4],
  macaronesia: [30.5, -16.5],
  guinea_current: [3.5, -13.0],
  lesser_antilles: [13.5, -58.5],
  caribbean_sea: [15.8, -72.5],
  spanish_main: [13.5, -79.0],
  florida_straits: [24.0, -81.5],
  south_atlantic: [-15.0, -10.0],
  cape_of_good_hope: [-36.0, 19.5],
  mozambique_channel: [-16.0, 42.5],
  arabian_sea: [15.5, 65.0],
  bay_of_bengal: [11.0, 86.0],
  malacca_strait: [3.8, 99.8],
  java_sea: [-5.0, 110.5],
  south_china_sea: [14.0, 114.5],
  // The north-about passage and the colonies' waters (guessed ids, approximate: see the ports above).
  orkney: [59.2, -2.6],
  north_atlantic: [56.5, -28.0],
  grand_banks: [45.5, -50.5],
  gulf_of_maine: [42.6, -68.8],
  chesapeake: [37.0, -75.4],
  carolina_banks: [34.2, -76.4],
};

/** Other spellings the catalog may use for the guessed ids above. */
const ALIASES: Record<string, string> = {
  saint_johns: "st_johns",
  st_john_s: "st_johns",
  saint_peter_port: "st_peter_port",
  vlissingen: "flushing",
  sint_eustatius: "st_eustatius",
  saint_eustatius: "st_eustatius",
  ocracoke: "ocracoke_inlet",
  orkney_isles: "orkney",
  orkney_passage: "orkney",
  pentland_firth: "orkney",
  north_about: "north_atlantic",
  western_ocean: "north_atlantic",
  chesapeake_bay: "chesapeake",
  outer_banks: "carolina_banks",
  cape_hatteras: "carolina_banks",
};

/** Nodes the catalog names that NODE_COORDS doesn't know, placed from the catalog itself (placeCatalog). */
const DERIVED: Record<string, LatLng> = {};

/** Where a node sits: its own coordinates, an alias's, or one placed from the catalog; undefined: not placed. */
export function coordOf(id: string | null | undefined): LatLng | undefined {
  if (!id) return undefined;
  return NODE_COORDS[id] ?? NODE_COORDS[ALIASES[id] ?? ""] ?? DERIVED[id];
}

/**
 * Places catalog nodes with no coordinates of their own (a new port or zone, or ids guessed wrong above): a zone at the
 * middle of its placed ports, then a port just off its zone (each a little apart). A node still unplaced is skipped
 * everywhere (never drawn at 0,0).
 */
export function placeCatalog(catalog: { ports: Array<{ id: string; sea_zone_id: string }>; sea_zones: Array<{ id: string }> }): void {
  for (const z of catalog.sea_zones) {
    if (coordOf(z.id)) continue;
    const at = catalog.ports.filter((p) => p.sea_zone_id === z.id).map((p) => NODE_COORDS[p.id] ?? NODE_COORDS[ALIASES[p.id] ?? ""]).filter((c): c is LatLng => !!c);
    if (at.length) DERIVED[z.id] = [at.reduce((n, c) => n + c[0], 0) / at.length, at.reduce((n, c) => n + c[1], 0) / at.length];
  }
  const unplaced = catalog.ports.filter((p) => !coordOf(p.id));
  unplaced.forEach((p, i) => {
    const z = coordOf(p.sea_zone_id);
    if (!z) return;
    // Spread around the zone so ports sharing it don't sit on each other.
    const a = (i * 2 * Math.PI) / Math.max(3, unplaced.length);
    DERIVED[p.id] = [z[0] + 0.6 * Math.cos(a), z[1] + 0.9 * Math.sin(a)];
  });
}

/** Zone-to-zone lanes, from `/v1/world/route` across all four phases. Ports join their own zone. */
export const ZONE_LANES: Array<[string, string]> = [
  ["arabian_sea", "bay_of_bengal"],
  ["arabian_sea", "mozambique_channel"],
  ["bay_of_bengal", "malacca_strait"],
  ["bay_of_biscay", "english_channel"],
  ["bay_of_biscay", "iberian_coast"],
  ["cape_of_good_hope", "mozambique_channel"],
  ["cape_of_good_hope", "south_atlantic"],
  ["caribbean_sea", "florida_straits"],
  ["caribbean_sea", "lesser_antilles"],
  ["caribbean_sea", "spanish_main"],
  ["central_baltic", "gdansk_bay"],
  ["central_baltic", "gulf_of_riga"],
  ["dogger_north_sea", "norwegian_trench"],
  ["dogger_north_sea", "thames_estuary"],
  ["dogger_north_sea", "the_sound"],
  ["dogger_north_sea", "zuiderzee_texel"],
  ["dover_strait", "english_channel"],
  ["dover_strait", "flemish_banks"],
  ["dover_strait", "thames_estuary"],
  ["english_channel", "florida_straits"],
  ["flemish_banks", "zuiderzee_texel"],
  ["gdansk_bay", "gulf_of_riga"],
  ["gdansk_bay", "the_sound"],
  ["guinea_current", "lesser_antilles"],
  ["guinea_current", "macaronesia"],
  ["guinea_current", "south_atlantic"],
  ["gulf_of_cadiz", "iberian_coast"],
  ["gulf_of_cadiz", "macaronesia"],
  ["heligoland_bight", "the_sound"],
  ["heligoland_bight", "zuiderzee_texel"],
  ["java_sea", "malacca_strait"],
  ["java_sea", "south_china_sea"],
  ["lesser_antilles", "macaronesia"],
  ["norwegian_trench", "the_sound"],
  // Phase 2's colonies (guide 3.15), on the guessed ids: north-about from the North Sea by Orkney and the open-ocean
  // crossing to the Grand Banks, then down the coast to the West Indies. Lanes on ids the catalog doesn't use aren't drawn;
  // the map adds every zone-to-zone leg our ships' routes show.
  ["dogger_north_sea", "orkney"],
  ["grand_banks", "orkney"],
  ["grand_banks", "gulf_of_maine"],
  ["chesapeake", "gulf_of_maine"],
  ["carolina_banks", "chesapeake"],
  ["carolina_banks", "florida_straits"],
];

const SKAGERRAK: LatLng[] = [[57.95, 10.8], [56.9, 11.7]];

/** Detours around land, keyed `a|b` with a < b, listed in the a → b direction. */
const WAYPOINTS: Record<string, LatLng[]> = {
  "bay_of_biscay|english_channel": [[48.6, -5.8], [49.95, -3.0]],
  "bay_of_biscay|iberian_coast": [[44.0, -9.6]],
  "english_channel|florida_straits": [[49.6, -6.2], [23.5, -75.0]],
  "gulf_of_cadiz|iberian_coast": [[37.0, -9.3]],
  "dogger_north_sea|the_sound": [[57.3, 7.0], ...SKAGERRAK],
  "heligoland_bight|the_sound": [[55.5, 7.6], [57.4, 8.5], ...SKAGERRAK],
  "norwegian_trench|the_sound": SKAGERRAK,
  "gdansk_bay|the_sound": [[55.3, 13.6]],
  "gdansk_bay|gulf_of_riga": [[57.0, 20.6], [57.75, 22.0]],
  "central_baltic|gulf_of_riga": [[57.8, 21.8]],
  "guinea_current|macaronesia": [[10.0, -17.5], [21.0, -19.5]],
  "caribbean_sea|florida_straits": [[19.8, -73.8], [21.6, -75.5], [23.0, -78.5]],
  "spanish_main|veracruz": [[18.5, -83.0], [22.2, -86.5], [21.0, -94.5]],
  "cape_of_good_hope|mozambique_channel": [[-35.5, 27.0], [-30.0, 34.0]],
  "arabian_sea|bay_of_bengal": [[7.0, 76.0], [5.3, 80.5]],
  "bay_of_bengal|malacca_strait": [[6.2, 96.5]],
  "aceh|malacca_strait": [[5.9, 97.0]],
  "java_sea|malacca_strait": [[-2.0, 106.7], [1.1, 104.2]],
  "java_sea|ternate": [[-6.0, 121.0], [-1.8, 125.5]],
  "java_sea|south_china_sea": [[-2.0, 108.5], [3.5, 108.0]],
  "chesapeake|gulf_of_maine": [[40.6, -70.0]],
  "carolina_banks|chesapeake": [[35.1, -75.2]],
  "carolina_banks|florida_straits": [[27.0, -79.6], [24.6, -80.0]],
};

/**
 * All lanes to draw: zone-to-zone plus each port to its zone, plus `seen` (zone-to-zone legs from our ships' routes:
 * passages the fixed list may not know).
 */
export function seaLanes(ports: Array<{ id: string; sea_zone_id: string }>, seen: Array<[string, string]> = []): Array<[string, string]> {
  const key = ([a, b]: [string, string]) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const known = new Set(ZONE_LANES.map(key));
  const extra: Array<[string, string]> = [];
  for (const l of seen) {
    if (l[0] === l[1] || known.has(key(l))) continue;
    known.add(key(l));
    extra.push(l);
  }
  return [...ZONE_LANES, ...extra, ...ports.map((p) => [p.id, p.sea_zone_id] as [string, string])];
}

/** Polyline for one leg between two nodes, including any detour; empty when either end isn't placed. */
export function legPath(from: string, to: string): LatLng[] {
  const a = coordOf(from);
  const b = coordOf(to);
  if (!a || !b) return [];
  const [f, t] = [ALIASES[from] ?? from, ALIASES[to] ?? to];
  const forward = f < t;
  const via = WAYPOINTS[forward ? `${f}|${t}` : `${t}|${f}`] ?? [];
  return [a, ...(forward ? via : [...via].reverse()), b];
}

// Distances in projected degrees (longitude scaled by latitude) — good enough to place a ship along a line.
function segLen(a: LatLng, b: LatLng): number {
  const k = Math.cos((((a[0] + b[0]) / 2) * Math.PI) / 180);
  return Math.hypot(b[0] - a[0], (b[1] - a[1]) * k);
}

/** Point at fraction t (0..1) along a polyline, with the heading (degrees from north) there. */
export function pointAlong(path: LatLng[], t: number): { pos: LatLng; heading: number } {
  if (path.length === 0) return { pos: [0, 0], heading: 0 };
  if (path.length === 1) return { pos: path[0], heading: 0 };
  const lens = path.slice(1).map((p, i) => segLen(path[i], p));
  const total = lens.reduce((n, l) => n + l, 0);
  let target = Math.min(Math.max(t, 0), 1) * total;
  for (let i = 0; i < lens.length; i++) {
    if (target <= lens[i] || i === lens.length - 1) {
      const f = lens[i] > 0 ? Math.min(target / lens[i], 1) : 0;
      const [a, b] = [path[i], path[i + 1]];
      return { pos: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f], heading: heading(a, b) };
    }
    target -= lens[i];
  }
  return { pos: path[path.length - 1], heading: 0 };
}

function heading(a: LatLng, b: LatLng): number {
  const k = Math.cos((a[0] * Math.PI) / 180);
  return ((Math.atan2((b[1] - a[1]) * k, b[0] - a[0]) * 180) / Math.PI + 360) % 360;
}

export interface ShipFix {
  pos: LatLng;
  /** Degrees clockwise from north; 0 in port. */
  heading: number;
  /** Rest of the voyage, from the ship's position to its destination. Empty in port. */
  ahead: LatLng[];
  /** Where it is bound, while sailing. */
  dest: string | null;
}

/**
 * Where a ship is now. In port it sits on the port; at sea it is placed along its current leg by
 * the leg's departure and arrival times.
 */
export function shipFix(r: ShipResult, now = Date.now()): ShipFix | null {
  const s = r.ship;
  if (s.status !== "sailing") {
    const at = coordOf(s.current_port_id);
    return at ? { pos: at, heading: 0, ahead: [], dest: null } : null;
  }

  const legs = r.route_legs;
  if (legs.length === 0) return null;
  const idx = Math.min(r.voyage?.current_leg_idx ?? s.current_leg_idx, legs.length - 1);
  const leg = legs[idx];
  const est = r.voyage?.legs.find((l) => l.leg_idx === idx);

  const arrive = Date.parse(s.leg_arrives_at ?? est?.estimated_arrival_at ?? "") || now;
  const prevArrive = r.voyage?.legs.find((l) => l.leg_idx === idx - 1)?.estimated_arrival_at;
  // Fallback leg length: distance at the voyage speed, 1 game hour per real minute.
  const speedKn = (r.voyage?.speed_centiknots ?? est?.speed_centiknots ?? 600) / 100;
  const depart =
    Date.parse(s.leg_departs_at ?? prevArrive ?? "") || arrive - (leg.distance_nm / Math.max(speedKn, 1)) * 60_000;
  const t = arrive > depart ? (now - depart) / (arrive - depart) : 1;

  // A leg with an end we can't place runs between the nearest placed nodes before and after it on the route;
  // none placed at all: not shown (rather than at 0,0).
  let here = legPath(leg.from_node, leg.to_node);
  if (here.length === 0) {
    const back = [...legs.slice(0, idx + 1)].reverse().map((l) => coordOf(l.from_node)).find(Boolean);
    const fwd = legs.slice(idx).map((l) => coordOf(l.to_node)).find(Boolean);
    here = [back, fwd].filter((c): c is LatLng => !!c);
    if (here.length === 0) return null;
  }
  const { pos, heading: hdg } = pointAlong(here, t);

  // Remaining path: rest of this leg, then every later leg.
  const lens = here.slice(1).map((p, i) => segLen(here[i], p));
  const total = lens.reduce((n, l) => n + l, 0);
  let walked = Math.min(Math.max(t, 0), 1) * total;
  let cut = 0;
  while (cut < lens.length && walked > lens[cut]) walked -= lens[cut++];
  const ahead: LatLng[] = [pos, ...here.slice(cut + 1)];
  for (const l of legs.slice(idx + 1)) ahead.push(...legPath(l.from_node, l.to_node).slice(1));

  return { pos, heading: hdg, ahead, dest: legs[legs.length - 1].to_node };
}

/**
 * Where a rival ship probably is: along its route by the share of the estimated passage elapsed,
 * or on the port it was seen in (or bound for, once it should have arrived).
 */
export function rivalFix(r: RivalShip, now = Date.now()): (ShipFix & { estimated: boolean }) | null {
  // Sunk or taken: nowhere to show it.
  if (r.lost) return null;
  const v = r.voyage;
  // Not sailed yet (a standing policy, a forming convoy): in the port it leaves from.
  if (v && now < v.departAt) {
    const at = coordOf(v.from);
    return at ? { pos: at, heading: 0, ahead: [], dest: v.to, estimated: true } : null;
  }
  if (v && now < v.arriveAt) {
    const path: LatLng[] = [];
    for (const [a, b] of v.legs) path.push(...legPath(a, b).slice(path.length ? 1 : 0));
    if (path.length < 2) return null;
    const t = (now - v.departAt) / Math.max(v.arriveAt - v.departAt, 1);
    const { pos, heading } = pointAlong(path, t);
    return { pos, heading, ahead: [], dest: v.to, estimated: true };
  }
  // Past its estimated arrival: in the port it was bound for, whatever the server thought then.
  const port = r.inPort ?? (v && now >= v.arriveAt ? v.to : null);
  const at = coordOf(port);
  return at ? { pos: at, heading: 0, ahead: [], dest: null, estimated: r.voyage !== null } : null;
}
