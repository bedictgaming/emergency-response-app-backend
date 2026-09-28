// Simplified NAMRIA administrative boundaries enriched with PSA PSGC codes.
// Source snapshot: https://github.com/bendlikeabamboo/barangay-boundaries-repository/releases/tag/v2026.4.13.0
// A 350 m edge tolerance compensates for the source's 0.005-degree simplification.
type Point = [number, number]; // [longitude, latitude]
type Rings = Point[][];

const BOUNDARIES: Record<string, Rings[]> = {
  alegria: [[[[123.967866485,10.259666218],[123.956748182,10.250718239],[123.953201265,10.255157421],[123.957855956,10.259594339],[123.967866485,10.259666218]]]],
  bangbang: [[[[123.935146951,10.258659343],[123.947947385,10.260067263],[123.948694721,10.258016875],[123.935146951,10.258659343]]]],
  buagsong: [[[[123.936112158,10.248498659],[123.947360184,10.253250374],[123.942284178,10.244375511],[123.936112158,10.248498659]]]],
  catarman: [[[[123.942284178,10.244375511],[123.949965402,10.246945518],[123.94691753,10.242264191],[123.942284178,10.244375511]]]],
  cogon: [[[[123.949754237,10.267118908],[123.955039857,10.260824801],[123.951322589,10.257759798],[123.949754237,10.267118908]]]],
  dapitan: [[[[123.946391776,10.268880649],[123.952503699,10.263282191],[123.949849018,10.256610134],[123.947639505,10.260965837],[123.946391776,10.268880649]]]],
  "day-as": [[[[123.914389111,10.257406401],[123.917993663,10.248128717],[123.915969442,10.246160918],[123.914431283,10.24705409],[123.914389111,10.257406401]]],[[[123.935146951,10.258659343],[123.947080318,10.257163474],[123.947360184,10.253250374],[123.93482052,10.249023035],[123.935146951,10.258659343]]]],
  gabi: [[[[123.960848756,10.270245784],[123.969327129,10.260317409],[123.953201265,10.255157421],[123.953795786,10.266251437],[123.960848756,10.270245784]]]],
  gilutongan: [[[[124.000205923,10.190918634],[124.000734743,10.189951412],[123.999482589,10.190539006],[124.000205923,10.190918634]]],[[[123.986266749,10.20451371],[123.991887988,10.205631346],[123.991206535,10.203316203],[123.986266749,10.20451371]]]],
  ibabao: [[[[123.954991516,10.279807373],[123.959875089,10.270583032],[123.947120556,10.268187843],[123.945677317,10.272812183],[123.954991516,10.279807373]]]],
  pilipog: [[[[123.94494379,10.272283262],[123.946921787,10.263972165],[123.938941468,10.264570442],[123.94494379,10.272283262]]]],
  poblacion: [[[[123.951322589,10.257759798],[123.956119193,10.251346039],[123.956325113,10.2419586],[123.946934687,10.250202108],[123.951322589,10.257759798]]]],
  "san miguel": [[[[123.938941468,10.264570442],[123.947947385,10.260067263],[123.938184728,10.263260979],[123.938941468,10.264570442]]]],
};

const BARANGAY_NAMES: Record<string, string> = {
  alegria: "Alegria",
  bangbang: "Bangbang",
  buagsong: "Buagsong",
  catarman: "Catarman",
  cogon: "Cogon",
  dapitan: "Dapitan",
  "day-as": "Day-as",
  gabi: "Gabi",
  gilutongan: "Gilutongan",
  ibabao: "Ibabao",
  pilipog: "Pilipog",
  poblacion: "Poblacion",
  "san miguel": "San Miguel",
};

const EDGE_TOLERANCE_METERS = 350;

function insideRing([x, y]: Point, ring: Point[]) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function segmentDistanceMeters(point: Point, first: Point, second: Point) {
  const latitudeScale = 111_320;
  const longitudeScale = latitudeScale * Math.cos(point[1] * Math.PI / 180);
  const ax = (first[0] - point[0]) * longitudeScale;
  const ay = (first[1] - point[1]) * latitudeScale;
  const bx = (second[0] - point[0]) * longitudeScale;
  const by = (second[1] - point[1]) * latitudeScale;
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lengthSquared)) : 0;
  return Math.hypot(ax + t * dx, ay + t * dy);
}

export function coordinatesBelongToBarangay(name: string, latitude: number, longitude: number) {
  const polygons = BOUNDARIES[name.trim().toLowerCase()];
  if (!polygons) return false;
  const point: Point = [longitude, latitude];
  return polygons.some((rings) => {
    const outer = rings[0];
    if (insideRing(point, outer)) return true;
    return outer.some((vertex, index) => segmentDistanceMeters(point, vertex, outer[(index + 1) % outer.length]) <= EDGE_TOLERANCE_METERS);
  });
}

function exactBarangayAt(latitude: number, longitude: number): string | undefined {
  const point: Point = [longitude, latitude];
  for (const [key, polygons] of Object.entries(BOUNDARIES)) {
    if (polygons.some((rings) => insideRing(point, rings[0]))) return BARANGAY_NAMES[key];
  }
  return undefined;
}

/**
 * Resolves the most likely canonical barangay for a map pin. Exact polygon
 * matches win; otherwise the closest simplified boundary is accepted only
 * within the same tolerance used by coordinatesBelongToBarangay.
 */
export function detectBarangayFromCoordinates(latitude: number, longitude: number): string | undefined {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return undefined;

  const point: Point = [longitude, latitude];
  let nearestKey: string | undefined;
  let nearestDistance = Number.POSITIVE_INFINITY;

  for (const [key, polygons] of Object.entries(BOUNDARIES)) {
    for (const rings of polygons) {
      const outer = rings[0];
      if (insideRing(point, outer)) return BARANGAY_NAMES[key];

      for (let index = 0; index < outer.length; index += 1) {
        const distance = segmentDistanceMeters(point, outer[index], outer[(index + 1) % outer.length]);
        if (distance < nearestDistance) {
          nearestDistance = distance;
          nearestKey = key;
        }
      }
    }
  }

  return nearestKey && nearestDistance <= EDGE_TOLERANCE_METERS
    ? BARANGAY_NAMES[nearestKey]
    : undefined;
}

/** Prefer a valid selected barangay near an imprecise boundary; otherwise
 * correct the selection from the pin instead of rejecting a legitimate call.
 */
export function resolveBarangayFromCoordinates(name: string, latitude: number, longitude: number): string | undefined {
  const selectedKey = name.trim().toLowerCase();
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return undefined;
  const selectedPolygons = BOUNDARIES[selectedKey];
  if (selectedPolygons?.some((rings) => insideRing([longitude, latitude], rings[0]))) {
    return BARANGAY_NAMES[selectedKey];
  }
  // A point inside another barangay must not be relabelled merely because
  // the selected barangay lies within the 350 m approximation tolerance.
  const exactMatch = exactBarangayAt(latitude, longitude);
  if (exactMatch) return exactMatch;
  if (BARANGAY_NAMES[selectedKey] && coordinatesBelongToBarangay(selectedKey, latitude, longitude)) {
    return BARANGAY_NAMES[selectedKey];
  }
  return detectBarangayFromCoordinates(latitude, longitude);
}
