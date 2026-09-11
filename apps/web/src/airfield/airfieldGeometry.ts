import {
  AIRFIELD_FOUNDATION_DEPTH_M,
  AIRFIELD_MARKING_OFFSET_M,
  AIRFIELD_PERIMETER_WIDTH_M,
  AIRFIELD_SITE,
  type AirfieldStructure,
} from './airfieldSite';

export type AirfieldMaterialName = 'infield' | 'foundation' | 'pavement' | 'shoulder'
  | 'building' | 'roof' | 'glass' | 'detail' | 'whiteMarking' | 'yellowMarking' | 'edgeLight';
type Triple = readonly [number, number, number];
export interface AirfieldBox {
  readonly material: AirfieldMaterialName;
  readonly position: Triple;
  readonly size: Triple;
  readonly rotation?: Triple;
}

function box(material: AirfieldMaterialName, position: Triple, size: Triple, rotation?: Triple): AirfieldBox {
  return { material, position, size, rotation };
}

function paint(material: 'whiteMarking' | 'yellowMarking', x: number, z: number, width: number, length: number, yaw = 0): AirfieldBox {
  const top = AIRFIELD_MARKING_OFFSET_M;
  return box(material, [x, top - 0.006, z], [width, 0.012, length], [0, yaw, 0]);
}

/** Partition the complete deck into disjoint cells: every surface top is y=0.
 * Overlapping road/apron definitions are a union, never coplanar extra meshes. */
function addDeck(boxes: AirfieldBox[]): void {
  const { bounds, surfaces } = AIRFIELD_SITE;
  const x0 = bounds.eastMinM, x1 = bounds.eastMaxM;
  const z0 = -bounds.northMaxM, z1 = -bounds.northMinM;
  const cuts = (values: number[]) => [...new Set(values)].sort((a, b) => a - b);
  const xs = cuts([x0, x1, ...surfaces.flatMap((s) => [s.centerEastM - s.widthM / 2, s.centerEastM + s.widthM / 2])]);
  const zs = cuts([z0, z1, ...surfaces.flatMap((s) => [s.centerSouthM - s.lengthM / 2, s.centerSouthM + s.lengthM / 2])]);
  const slab = 0.18;
  boxes.push(box('foundation', [(x0 + x1) / 2, -(AIRFIELD_FOUNDATION_DEPTH_M + slab) / 2, (z0 + z1) / 2],
    [x1 - x0, AIRFIELD_FOUNDATION_DEPTH_M - slab, z1 - z0]));
  for (let zi = 0; zi < zs.length - 1; zi++) {
    const z = (zs[zi] + zs[zi + 1]) / 2;
    let start = xs[0];
    let last: AirfieldMaterialName | undefined;
    for (let xi = 0; xi < xs.length; xi++) {
      let material: AirfieldMaterialName | undefined;
      if (xi < xs.length - 1) {
        const x = (xs[xi] + xs[xi + 1]) / 2;
        const containing = surfaces.filter((s) => Math.abs(x - s.centerEastM) < s.widthM / 2
          && Math.abs(z - s.centerSouthM) < s.lengthM / 2);
        const surface = containing.find((s) => s.kind !== 'SHOULDER') ?? containing[0];
        material = surface ? surface.kind === 'SHOULDER' ? 'shoulder' : 'pavement' : 'infield';
      }
      if (material !== last) {
        if (last) boxes.push(box(last, [(start + xs[xi]) / 2, -slab / 2, z], [xs[xi] - start, slab, zs[zi + 1] - zs[zi]]));
        start = xs[xi];
        last = material;
      }
    }
  }
}

const DIGITS: Readonly<Record<string, readonly string[]>> = {
  '1': ['010', '110', '010', '010', '111'],
  '3': ['111', '001', '111', '001', '111'],
  '6': ['111', '100', '111', '101', '111'],
  '8': ['111', '101', '111', '101', '111'],
};

function addRunway(boxes: AirfieldBox[]): void {
  const { runwayWidthM, runwayLengthM, thresholdBars, northDesignation, southDesignation } = AIRFIELD_SITE.dimensions;
  for (const x of [-runwayWidthM / 2 + 1.3, runwayWidthM / 2 - 1.3]) {
    boxes.push(paint('whiteMarking', x, 0, 0.3, runwayLengthM - 40));
  }
  for (let z = -630; z <= 630; z += 60) boxes.push(paint('whiteMarking', 0, z, 0.45, 30));
  for (const end of [-1, 1]) {
    for (let i = 0; i < thresholdBars / 2; i++) {
      for (const side of [-1, 1]) boxes.push(paint('whiteMarking', side * (3.6 + i * 3.3), end * (runwayLengthM / 2 - 20), 1.5, 22));
    }
    const number = end < 0 ? northDesignation : southDesignation;
    // Rotate the complete inscription 180° at the north end, including digit order.
    [...number].forEach((digit, index) => DIGITS[digit].forEach((row, r) => [...row].forEach((cell, c) => {
      if (cell === '1') boxes.push(paint('whiteMarking', end * ((index - 0.5) * 9.4 + (c - 1) * 1.8),
        end * (runwayLengthM / 2 - 72 + (r - 2) * 3.6), 1.8, 3.6));
    })));
    for (const x of [-9, 9]) boxes.push(paint('whiteMarking', x, end * 500, 4, 40));
    for (const x of [-12, 12]) boxes.push(paint('whiteMarking', x, end * 610, 1.3, 22));
  }
}

function addApronAndTaxi(boxes: AirfieldBox[]): void {
  const taxi = AIRFIELD_SITE.surfaces.find((s) => s.kind === 'TAXIWAY')!;
  boxes.push(paint('yellowMarking', taxi.centerEastM, taxi.centerSouthM, 0.22, taxi.lengthM - 30));
  for (const s of AIRFIELD_SITE.surfaces.filter((s) => s.kind === 'CONNECTOR')) {
    boxes.push(paint('yellowMarking', s.centerEastM, s.centerSouthM, s.widthM, 0.22));
    if (s.id.startsWith('taxi-connector')) {
      for (const x of [-46, -45]) boxes.push(paint('yellowMarking', x, s.centerSouthM, 0.18, s.lengthM - 2));
    }
  }
  for (const { footprint: f } of AIRFIELD_SITE.structures.filter((s) => s.kind === 'HANGAR')) {
    const endX = f.eastMaxM + 5;
    boxes.push(paint('yellowMarking', (endX + taxi.centerEastM) / 2, f.centerSouthM, taxi.centerEastM - endX, 0.22));
    boxes.push(paint('yellowMarking', endX, f.centerSouthM, 0.25, 12));
    for (const side of [-1, 1]) {
      const z = f.centerSouthM + side * 34;
      for (const x of [f.eastMaxM + 7, taxi.centerEastM - 10]) boxes.push(paint('yellowMarking', x, z, 0.16, 18));
      for (const edgeZ of [z - 9, z + 9]) boxes.push(paint('yellowMarking', (f.eastMaxM + 7 + taxi.centerEastM - 10) / 2, edgeZ,
        taxi.centerEastM - 10 - f.eastMaxM - 7, 0.16));
    }
  }
}

function addPad(boxes: AirfieldBox[]): void {
  const p = AIRFIELD_SITE.surfaces.find((s) => s.kind === 'PAD')!;
  for (const x of [p.centerEastM - p.widthM / 2 + 2, p.centerEastM + p.widthM / 2 - 2]) {
    boxes.push(paint('yellowMarking', x, p.centerSouthM, 0.25, p.lengthM - 4));
  }
  for (const z of [p.centerSouthM - p.lengthM / 2 + 2, p.centerSouthM + p.lengthM / 2 - 2]) {
    boxes.push(paint('yellowMarking', p.centerEastM, z, p.widthM - 4, 0.25));
  }
  const radius = 37, segments = 20;
  for (let i = 0; i < segments; i++) {
    const a = i * 2 * Math.PI / segments;
    boxes.push(paint('whiteMarking', p.centerEastM + radius * Math.sin(a), p.centerSouthM + radius * Math.cos(a),
      1.2, 2 * radius * Math.tan(Math.PI / segments), a + Math.PI / 2));
  }
  for (const side of [-1, 1]) boxes.push(paint('whiteMarking', p.centerEastM + side * 9, p.centerSouthM, 1.8, 26));
  boxes.push(paint('whiteMarking', p.centerEastM, p.centerSouthM, 18, 1.8));
}

function addHangar(boxes: AirfieldBox[], structure: AirfieldStructure): void {
  const f = structure.footprint;
  const { centerEastM: x, centerSouthM: z, widthM: w, lengthM: l } = f;
  const eave = structure.heightM, rise = (structure.roofHeightM ?? eave + 4) - eave;
  boxes.push(box('detail', [x, 0.175, z], [w, 0.35, l]));
  boxes.push(box('building', [x, (eave + 0.35) / 2, z], [w - 0.5, eave - 0.35, l - 0.5]));
  // Stepped gable infill is hidden beneath the two sloping roof sheets.
  for (let i = 0; i < 32; i++) boxes.push(box('building', [x, eave + rise * (i + 0.5) / 32, z],
    [(w - 0.5) * (1 - i / 32), rise / 32, l - 0.5]));
  for (const side of [-1, 1]) boxes.push(box('roof', [x + side * w / 4, eave + rise / 2 + 0.2, z],
    [Math.hypot(w / 2, rise) + 1.2, 0.4, l + 1.4], [0, 0, -side * Math.atan2(rise, w / 2)]));
  boxes.push(box('detail', [x, eave + rise + 0.42, z], [0.6, 0.28, l + 1.5]));

  const facade = f.eastMaxM - 0.14;
  const doorSpan = l * 0.72, doorHeight = eave - 3;
  for (let i = 0; i < 8; i++) {
    const panelZ = z - doorSpan / 2 + doorSpan * (i + 0.5) / 8;
    boxes.push(box('roof', [facade, 0.4 + doorHeight / 2, panelZ], [0.2, doorHeight, doorSpan / 8 - 0.18]));
    boxes.push(box('glass', [facade + 0.11, 8.3, panelZ], [0.025, 1.1, doorSpan / 8 - 1.2]));
    boxes.push(box('detail', [facade + 0.11, 2, panelZ], [0.025, 0.7, 0.09]));
  }
  boxes.push(box('detail', [facade, doorHeight + 0.65, z], [0.24, 0.3, doorSpan + 1]));
  boxes.push(box('glass', [facade, eave - 1, z], [0.22, 0.9, l - 4]));
  for (const side of [-1, 1]) {
    boxes.push(box('detail', [facade, 1.55, z + side * (l / 2 - 6)], [0.22, 2.4, 1.4]));
    boxes.push(box('whiteMarking', [facade + 0.11, 2.92, z + side * (l / 2 - 6)], [0.02, 0.22, 1.7]));
  }
  for (let ribZ = f.southMinM + 3; ribZ < f.southMaxM; ribZ += 8) {
    for (const ribX of [f.eastMinM + 0.12, f.eastMaxM - 0.12]) {
      boxes.push(box('building', [ribX, (eave + 0.4) / 2, ribZ], [0.2, eave - 0.4, 0.16]));
    }
  }
  for (const ventZ of [z - l / 4, z + l / 4]) {
    boxes.push(box('detail', [x, eave + rise + 0.9, ventZ], [3.5, 1.1, 6]));
    boxes.push(box('roof', [x, eave + rise + 1.55, ventZ], [4.2, 0.25, 6.6]));
  }
}

function addTower(boxes: AirfieldBox[], structure: AirfieldStructure): void {
  const { centerEastM: x, centerSouthM: z, widthM, lengthM } = structure.footprint;
  const roofTop = structure.heightM, cabTop = roofTop - 1.3, cabBottom = cabTop - 4.2;
  boxes.push(box('detail', [x, 0.175, z], [widthM, 0.35, lengthM]));
  boxes.push(box('building', [x, (cabBottom + 0.35) / 2, z], [12, cabBottom - 0.35, 12]));
  boxes.push(box('glass', [x + 6.02, 13, z], [0.08, 13, 2.6]));
  boxes.push(box('detail', [x + 6.06, 1.65, z], [0.12, 2.6, 1.6]));
  boxes.push(box('roof', [x, cabBottom - 0.25, z], [30, 0.5, 30]));
  boxes.push(box('building', [x, (cabBottom + cabTop) / 2, z], [24, cabTop - cabBottom, 24]));
  for (const side of [-1, 1]) {
    boxes.push(box('glass', [x + side * 12.05, (cabBottom + cabTop) / 2, z], [0.12, 3.6, 23.5]));
    boxes.push(box('glass', [x, (cabBottom + cabTop) / 2, z + side * 12.05], [23.5, 3.6, 0.12]));
    boxes.push(box('detail', [x + side * 14.5, cabBottom + 1.1, z], [0.1, 0.1, 29]));
    boxes.push(box('detail', [x, cabBottom + 1.1, z + side * 14.5], [29, 0.1, 0.1]));
    for (let offset = -12; offset <= 12; offset += 4) {
      boxes.push(box('detail', [x + side * 12.15, (cabBottom + cabTop) / 2, z + offset], [0.12, 4.2, 0.15]));
      boxes.push(box('detail', [x + offset, (cabBottom + cabTop) / 2, z + side * 12.15], [0.15, 4.2, 0.12]));
      boxes.push(box('detail', [x + side * 14.5, cabBottom + 0.55, z + offset], [0.1, 1.1, 0.1]));
      boxes.push(box('detail', [x + offset, cabBottom + 0.55, z + side * 14.5], [0.1, 1.1, 0.1]));
    }
  }
  boxes.push(box('roof', [x, (roofTop + cabTop) / 2, z], [28, roofTop - cabTop, 28]));
  boxes.push(box('detail', [x, roofTop + 3, z], [0.22, 6, 0.22]));
  boxes.push(box('detail', [x, roofTop + 5, z], [3, 0.15, 0.15]));
  boxes.push(box('edgeLight', [x, roofTop + 6.1, z], [0.25, 0.2, 0.25]));
}

function addPerimeterAndLights(boxes: AirfieldBox[]): void {
  const b = AIRFIELD_SITE.bounds, post = AIRFIELD_PERIMETER_WIDTH_M;
  const x0 = b.eastMinM + post / 2, x1 = b.eastMaxM - post / 2;
  const z0 = -b.northMaxM + post / 2, z1 = -b.northMinM - post / 2;
  for (const x of [x0, x1]) {
    for (const y of [0.65, 1.3]) boxes.push(box('detail', [x, y, (z0 + z1) / 2], [0.08, 0.08, z1 - z0]));
    const count = Math.ceil((z1 - z0) / 25);
    for (let i = 0; i <= count; i++) boxes.push(box('detail', [x, 0.8, z0 + (z1 - z0) * i / count], [post, 1.6, post]));
  }
  for (const z of [z0, z1]) {
    for (const y of [0.65, 1.3]) boxes.push(box('detail', [(x0 + x1) / 2, y, z], [x1 - x0, 0.08, 0.08]));
    const count = Math.ceil((x1 - x0) / 25);
    for (let i = 1; i < count; i++) boxes.push(box('detail', [x0 + (x1 - x0) * i / count, 0.8, z], [post, 1.6, post]));
  }
  const light = (x: number, z: number) => {
    boxes.push(box('detail', [x, 0.08, z], [0.3, 0.16, 0.3]));
    boxes.push(box('edgeLight', [x, 0.2, z], [0.22, 0.12, 0.22]));
  };
  for (const x of [-26, 26]) for (let z = -780; z <= 780; z += 60) light(x, z);
  for (let z = -780; z <= 780; z += 80) {
    if (AIRFIELD_SITE.surfaces.some((s) => s.kind === 'CONNECTOR' && Math.abs(z - s.centerSouthM) < s.lengthM / 2 + 2)) continue;
    light(-83, z);
  }
  const p = AIRFIELD_SITE.surfaces.find((s) => s.kind === 'PAD')!;
  for (const x of [p.centerEastM - p.widthM / 2 + 1, p.centerEastM + p.widthM / 2 - 1]) {
    for (const z of [p.centerSouthM - p.lengthM / 2 + 1, p.centerSouthM + p.lengthM / 2 - 1]) light(x, z);
  }
}

function buildAirfieldBoxes(): readonly AirfieldBox[] {
  const boxes: AirfieldBox[] = [];
  addDeck(boxes);
  addRunway(boxes);
  addApronAndTaxi(boxes);
  addPad(boxes);
  for (const structure of AIRFIELD_SITE.structures) {
    if (structure.kind === 'HANGAR') addHangar(boxes, structure);
    else addTower(boxes, structure);
  }
  addPerimeterAndLights(boxes);
  return boxes;
}

export const AIRFIELD_BOXES = buildAirfieldBoxes();
