/*
 * Converts the normalized footprint model (convertFootprintToKiCad output) into
 * a complete Altium .PcbLib holding one footprint. This module owns the
 * EasyEDA-to-Altium geometry rules (Y-up coordinates, layers, pad and hole
 * shapes, custom polygon pads, arcs and stroke text) and the library-level
 * compound-file streams; pcblib_records.js owns the binary record encodings.
 */

import { writeCompoundFile } from "./compound_file.js";
import { computeArc, fpToKi, parseSvgPath, toNumber } from "../kicad/shared.js";
import {
  ByteWriter,
  LAYER,
  PAD_SHAPE,
  createIdentitySource,
  encodeAnsi,
  formatGuid,
  mechanicalLayer,
  propertyStream,
  u32Stream,
  writeArcRecord,
  writePadRecord,
  writeRegionRecord,
  writeStringBlock,
  writeTextRecord,
  writeTrackRecord,
  writeViaRecord
} from "./pcblib_records.js";

// EasyEDA layer ids map to Altium's legacy layer numbers; graphics on unknown
// layers default to Mechanical 13, the layer used for the KiCad F.Fab content.
const EASYEDA_LAYERS = {
  1: LAYER.TOP,
  2: LAYER.BOTTOM,
  3: LAYER.TOP_OVERLAY,
  4: LAYER.BOTTOM_OVERLAY,
  5: LAYER.TOP_PASTE,
  6: LAYER.BOTTOM_PASTE,
  7: LAYER.TOP_SOLDER,
  8: LAYER.BOTTOM_SOLDER,
  10: mechanicalLayer(1),
  11: mechanicalLayer(1),
  12: mechanicalLayer(12),
  13: mechanicalLayer(13),
  14: mechanicalLayer(14),
  15: mechanicalLayer(15),
  101: mechanicalLayer(13)
};
const ENABLED_MECHANICAL_LAYERS = new Set([1, 12, 13, 14, 15].map(mechanicalLayer));
// Bottom-side layers (B.Cu, B.SilkS, B.Paste, B.Mask, B.Fab) read mirrored.
const BOTTOM_SIDE_LAYER_IDS = new Set([2, 4, 6, 8, 14]);
const PAD_SHAPES = { ELLIPSE: PAD_SHAPE.ROUND, RECT: PAD_SHAPE.RECT, OVAL: PAD_SHAPE.ROUND };
// Root storages a footprint section key must not collide with.
const RESERVED_STORAGES = new Set(["FILEHEADER", "FILEVERSIONINFO", "LIBRARY", "SECTIONKEYS"]);
const MIN_PAD_SIZE_MM = 0.005;

function altiumLayer(layerId) {
  return EASYEDA_LAYERS[toNumber(layerId)] ?? mechanicalLayer(13);
}

function normalizeAngle(degrees) {
  const value = toNumber(degrees) % 360;
  // "+ 0" turns a negative zero into 0 so no -0.0 doubles reach the file.
  return value < 0 ? value + 360 : value + 0;
}

function angleOf(dx, dy) {
  return normalizeAngle((Math.atan2(dy, dx) * 180) / Math.PI);
}

// Library names are 8-bit strings matched between Library/Data and the
// footprint PATTERN, so both carry the same Windows-1252-safe spelling;
// "|" would end the PATTERN property early.
function libraryName(value) {
  const name = String(value ?? "")
    .replace(/[^\x20-\x7e\xa0-\xff]/g, "_")
    .replace(/\|/g, "_")
    .trim()
    .slice(0, 255);
  if (!name) {
    throw new Error("exportAltiumPcbLib requires a footprintName");
  }
  return name;
}

function propertyText(value) {
  return String(value ?? "").replace(/\s*[\r\n|]+\s*/g, " ").trim();
}

// Compound-file names hold at most 31 characters and exclude "/ \ : !".
// Altium stores longer or altered names in the root SectionKeys stream.
function sectionKeyFor(name) {
  let key = name.slice(0, 31).replace(/[/\\:!]/g, "_");
  if (RESERVED_STORAGES.has(key.toUpperCase())) {
    key = `${key.slice(0, 30)}_`;
  }
  return key;
}

// Same designator rule as the KiCad emitter: "(1)" becomes "1".
function padDesignator(number) {
  let designator = String(number || "");
  if (designator.includes("(") && designator.includes(")")) {
    designator = designator.split("(")[1].split(")")[0];
  }
  return designator;
}

// Mirrors drillToKi: a nonzero holeLength is a slot along the pad's longer
// local axis. Altium stores the slot width as the hole size, the full slot
// length separately, and a 0/90 degree slot rotation relative to the pad.
function drillGeometry(holeRadius, holeLength, padHeight, padWidth) {
  if (!(holeRadius > 0)) {
    return { holeSize: 0, slotLength: 0, slotRotation: 0 };
  }
  const diameter = holeRadius * 2;
  if (holeLength && holeLength !== 0) {
    const longest = Math.max(diameter, holeLength);
    const alongY = padHeight - longest >= padWidth - longest;
    const [drillX, drillY] = alongY ? [diameter, holeLength] : [holeLength, diameter];
    if (drillX > drillY) return { holeSize: drillY, slotLength: drillX, slotRotation: 0 };
    if (drillY > drillX) return { holeSize: drillX, slotLength: drillY, slotRotation: 90 };
    return { holeSize: drillX, slotLength: 0, slotRotation: 0 };
  }
  return { holeSize: diameter, slotLength: 0, slotRotation: 0 };
}

function distanceToSegment([px, py], [ax, ay], [bx, by]) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function containsPoint(outline, [px, py]) {
  let inside = false;
  for (let i = 0, j = outline.length - 1; i < outline.length; j = i, i += 1) {
    const [xi, yi] = outline[i];
    const [xj, yj] = outline[j];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

// The numbered placeholder pad of a custom shape sits inside the copper
// region; size it to the largest circle that stays within the outline.
function placeholderDiameter(outline, anchor) {
  if (!containsPoint(outline, anchor)) return MIN_PAD_SIZE_MM;
  let nearest = Infinity;
  outline.forEach((point, index) => {
    nearest = Math.min(nearest, distanceToSegment(anchor, point, outline[(index + 1) % outline.length]));
  });
  return Math.max(MIN_PAD_SIZE_MM, nearest * 1.9);
}

// Layers that carry a custom pad's copper, mask and paste regions, matching
// the KiCad emitter's custom pad layer sets (no paste on drilled pads).
function customPadRegionLayers(layerId, hasHole) {
  const top = [LAYER.TOP, LAYER.TOP_SOLDER, ...(hasHole ? [] : [LAYER.TOP_PASTE])];
  const bottom = [LAYER.BOTTOM, LAYER.BOTTOM_SOLDER, ...(hasHole ? [] : [LAYER.BOTTOM_PASTE])];
  if (layerId === 1) return top;
  if (layerId === 2) return bottom;
  if (layerId === 11) return [...top, ...bottom];
  return [altiumLayer(layerId)];
}

function padLayer(layerId, hasHole) {
  if (hasHole || layerId === 11) return LAYER.MULTI_LAYER;
  if (layerId === 1) return LAYER.TOP;
  if (layerId === 2) return LAYER.BOTTOM;
  return altiumLayer(layerId);
}

// Collects primitives in footprint coordinates: millimetres relative to the
// EasyEDA bbox origin with Y negated, because Altium's PCB Y axis points up.
function collectPrimitives(footprint, identity) {
  const origin = footprint.bbox;
  const point = (x, y) => [x - origin.x, -(y - origin.y)];
  const footprintGuid = identity.guid();
  const primitives = [];
  const add = (kind, write) => primitives.push({ kind, write });
  const addTrack = (layer, width, [x1, y1], [x2, y2]) =>
    add("track", (w) => writeTrackRecord(w, { layer, width, x1, y1, x2, y2 }));
  const addPad = (pad) =>
    add("pad", (w) => writePadRecord(w, { ...pad, guid: identity.guid(), footprintGuid }));

  for (const pad of footprint.pads) {
    const hasHole = pad.holeRadius > 0;
    const rawPoints = String(pad.points || "").trim().split(/\s+/).filter(Boolean).map(fpToKi);
    const outline = [];
    for (let i = 0; i + 1 < rawPoints.length; i += 2) outline.push(point(rawPoints[i], rawPoints[i + 1]));
    const shape = PAD_SHAPES[pad.shape];
    const isCustom = !shape && outline.length >= 3;
    let width = Math.max(pad.width, 0.01);
    let height = Math.max(pad.height, 0.01);
    if (isCustom) {
      width = MIN_PAD_SIZE_MM;
      height = MIN_PAD_SIZE_MM;
    }
    const [x, y] = point(pad.centerX, pad.centerY);
    const plated = !(hasHole && !pad.isPlated);
    const common = {
      x,
      y,
      layer: padLayer(pad.layerId, hasHole),
      plated,
      designator: plated ? padDesignator(pad.number) : "",
      ...drillGeometry(pad.holeRadius, pad.holeLength, height, width)
    };
    if (isCustom) {
      const diameter = placeholderDiameter(outline, [x, y]);
      addPad({ ...common, shape: PAD_SHAPE.ROUND, sizeX: diameter, sizeY: diameter, rotation: 0 });
      for (const layer of customPadRegionLayers(pad.layerId, hasHole)) {
        add("region", (w) => writeRegionRecord(w, { layer, points: outline }));
      }
      continue;
    }
    addPad({
      ...common,
      shape: shape ?? PAD_SHAPE.RECT,
      sizeX: width,
      // KiCad draws circle pads from their width alone.
      sizeY: pad.shape === "ELLIPSE" ? width : height,
      rotation: normalizeAngle(pad.rotation)
    });
  }

  for (const hole of footprint.holes) {
    const [x, y] = point(hole.centerX, hole.centerY);
    const size = hole.radius * 2;
    addPad({
      x,
      y,
      layer: LAYER.MULTI_LAYER,
      plated: false,
      designator: "",
      shape: PAD_SHAPE.ROUND,
      sizeX: size,
      sizeY: size,
      rotation: 0,
      holeSize: size,
      slotLength: 0,
      slotRotation: 0
    });
  }

  for (const via of footprint.vias) {
    const [x, y] = point(via.centerX, via.centerY);
    const viaRecord = { x, y, diameter: via.diameter, holeSize: via.radius * 2, footprintGuid };
    add("via", (w) => writeViaRecord(w, { ...viaRecord, guid: identity.guid() }));
  }

  for (const track of footprint.tracks) {
    const values = String(track.points || "").trim().split(/\s+/).map(fpToKi);
    const width = Math.max(track.strokeWidth, 0.01);
    for (let i = 0; i < values.length - 2; i += 2) {
      addTrack(altiumLayer(track.layerId), width, point(values[i], values[i + 1]),
        point(values[i + 2], values[i + 3]));
    }
  }

  for (const rect of footprint.rectangles) {
    const corners = [
      point(rect.x, rect.y),
      point(rect.x + rect.width, rect.y),
      point(rect.x + rect.width, rect.y + rect.height),
      point(rect.x, rect.y + rect.height)
    ];
    const width = Math.max(rect.strokeWidth, 0.01);
    corners.forEach((corner, index) =>
      addTrack(altiumLayer(rect.layerId), width, corner, corners[(index + 1) % 4]));
  }

  for (const circle of footprint.circles) {
    const [cx, cy] = point(circle.cx, circle.cy);
    const arc = {
      layer: altiumLayer(circle.layerId),
      cx,
      cy,
      radius: circle.radius,
      startAngle: 0,
      endAngle: 360,
      width: Math.max(circle.strokeWidth, 0.01)
    };
    add("arc", (w) => writeArcRecord(w, arc));
  }

  for (const arc of footprint.arcs) {
    const record = convertArc(arc, origin);
    if (record.track) {
      addTrack(record.layer, record.width, record.track[0], record.track[1]);
    } else {
      add("arc", (w) => writeArcRecord(w, record));
    }
  }

  const wideStrings = [];
  for (const text of footprint.texts) {
    // Altium free strings have no hidden state, so hidden EasyEDA texts are omitted.
    if (text.isDisplayed === false) continue;
    let layerId = toNumber(text.layerId);
    // Like the KiCad emitter, name ("N") texts move from silkscreen to fabrication.
    if (text.type === "N" && (layerId === 3 || layerId === 4)) layerId += 10;
    const height = Math.max(text.fontSize, 1);
    const rotation = normalizeAngle(text.rotation);
    const radians = (rotation * Math.PI) / 180;
    const [ax, ay] = point(text.centerX, text.centerY);
    // KiCad output centres the text vertically on its anchor; Altium anchors
    // stroke text at the bottom-left, so shift half a height along local -Y.
    const record = {
      layer: altiumLayer(layerId),
      x: ax + (height / 2) * Math.sin(radians),
      y: ay - (height / 2) * Math.cos(radians),
      height,
      rotation,
      mirror: BOTTOM_SIDE_LAYER_IDS.has(layerId),
      strokeWidth: Math.max(text.strokeWidth, 0.01),
      text: String(text.text ?? ""),
      wideStringIndex: wideStrings.length
    };
    wideStrings.push(record.text);
    add("text", (w) => writeTextRecord(w, record));
  }

  return { primitives, wideStrings };
}

// EasyEDA arcs are SVG endpoint arcs in Y-down coordinates. computeArc finds
// the centre as the KiCad emitter does; after the Y flip a clockwise SVG sweep
// (sweep flag 1) becomes Altium's counter-clockwise arc from end to start.
function convertArc(arc, origin) {
  const [move, ellipseArc] = parseSvgPath(arc.path);
  if (move?.type !== "M" || ellipseArc?.type !== "A") {
    throw new Error("Unsupported footprint arc path: expected absolute M and A commands");
  }
  const layer = altiumLayer(arc.layerId);
  const width = Math.max(fpToKi(arc.strokeWidth), 0.01);
  const startX = fpToKi(move.startX) - origin.x;
  const startY = fpToKi(move.startY) - origin.y;
  const endX = fpToKi(ellipseArc.endX) - origin.x;
  const endY = fpToKi(ellipseArc.endY) - origin.y;
  const radiusX = fpToKi(ellipseArc.radiusX);
  const radiusY = fpToKi(ellipseArc.radiusY);
  // SVG treats a zero radius as a straight segment.
  if (radiusX === 0 || radiusY === 0) {
    return { layer, width, track: [[startX, -startY], [endX, -endY]] };
  }
  const { cx, cy } = computeArc(startX, startY, radiusX, radiusY, ellipseArc.xAxisRotation,
    ellipseArc.flagLargeArc, ellipseArc.flagSweep, endX, endY);
  const startAngle = angleOf(startX - cx, -(startY - cy));
  const endAngle = angleOf(endX - cx, -(endY - cy));
  const clockwise = ellipseArc.flagSweep;
  return {
    layer,
    width,
    cx,
    cy: -cy,
    radius: Math.hypot(startX - cx, startY - cy),
    startAngle: clockwise ? endAngle : startAngle,
    endAngle: clockwise ? startAngle : endAngle
  };
}

function legacyLayerName(number) {
  const fixed = {
    1: "Top Layer",
    32: "Bottom Layer",
    33: "Top Overlay",
    34: "Bottom Overlay",
    35: "Top Paste",
    36: "Bottom Paste",
    37: "Top Solder",
    38: "Bottom Solder",
    55: "Drill Guide",
    56: "Keep-Out Layer"
  };
  const tail = ["Drill Drawing", "Multi-Layer", "Connections", "Background", "DRC Error Markers",
    "Selections", "Visible Grid 1", "Visible Grid 2", "Pad Holes", "Via Holes"];
  if (fixed[number]) return fixed[number];
  if (number < 32) return `Mid-Layer ${number - 1}`;
  if (number < 55) return `Internal Plane ${number - 38}`;
  if (number < 73) return `Mechanical ${number - 56}`;
  return tail[number - 73];
}

// Library/Data properties: the library kind plus the legacy LAYERn table of
// Altium's 82 layers (two-layer stack, mechanical layers used here enabled),
// which both Altium and KiCad's importer read for layer names and state.
function libraryProperties() {
  let text = "|KIND=Protel_Advanced_PCB_Library|VERSION=3.00";
  for (let number = 1; number <= 82; number += 1) {
    // Top/bottom copper link to each other; top/bottom side layers link to their copper.
    const prev = number === 32 ? 1 : [34, 36, 38].includes(number) ? 32 : 0;
    const next = number === 1 ? 32 : [33, 35, 37].includes(number) ? 1 : 0;
    const key = `LAYER${number}`;
    text += `|${key}NAME=${legacyLayerName(number)}|${key}PREV=${prev}` +
      `|${key}NEXT=${next}|${key}MECHENABLED=${ENABLED_MECHANICAL_LAYERS.has(number) ? "TRUE" : "FALSE"}` +
      `|${key}COPTHICK=1.4mil|${key}DIELTYPE=0|${key}DIELCONST=4.800|${key}DIELHEIGHT=12.6mil` +
      `|${key}DIELMATERIAL=FR-4`;
  }
  return text;
}

// FileHeader: u32 character count and short string of the format name, the
// 5.01 format version double, then an eight-letter library id the same way.
function fileHeader(uniqueId) {
  const writer = new ByteWriter();
  const title = "PCB 6.0 Binary Library File";
  writer.u32(title.length);
  writer.u8(title.length);
  writer.raw(encodeAnsi(title));
  writer.f64(5.01);
  writer.u32(uniqueId.length);
  writer.u8(uniqueId.length);
  writer.raw(encodeAnsi(uniqueId));
  return writer.toBytes();
}

function libraryData(name) {
  const writer = new ByteWriter();
  writer.raw(propertyStream(libraryProperties()));
  writer.u32(1);
  writeStringBlock(writer, name);
  return writer.toBytes();
}

// LayerKindMapping/Data as Altium writes it: u32 size, UTF-16 "1.0" + NUL, padding.
function layerKindMapping() {
  const writer = new ByteWriter();
  writer.u32(8);
  for (const char of "1.0\0") {
    writer.u8(char.charCodeAt(0));
    writer.u8(0);
  }
  writer.raw(new Uint8Array(8));
  return writer.toBytes();
}

// SectionKeys: u32 count, then the full footprint name and its storage key
// as string blocks.
function sectionKeysStream(name, key) {
  const writer = new ByteWriter();
  writer.u32(1);
  writeStringBlock(writer, name);
  writeStringBlock(writer, key);
  return writer.toBytes();
}

// WideStrings maps text indices to UTF-16 code units for non-ANSI text.
function wideStringsText(texts) {
  return texts
    .map((text, index) => {
      const units = Array.from({ length: text.length }, (_, i) => text.charCodeAt(i));
      return `|ENCODEDTEXT${index}=${units.join(",")}`;
    })
    .join("");
}

function exportAltiumPcbLib(footprint, options = {}) {
  const name = libraryName(options.footprintName);
  const description = propertyText(options.description);
  const key = sectionKeyFor(name);
  const identity = createIdentitySource(name);
  const libraryId = identity.uniqueId();
  const padViaLibraryId = formatGuid(identity.guid());
  const { primitives, wideStrings } = collectPrimitives(footprint, identity);

  const data = new ByteWriter();
  writeStringBlock(data, name);
  const padIndices = [];
  primitives.forEach((primitive, index) => {
    if (primitive.kind === "pad") padIndices.push(index);
    primitive.write(data);
  });

  // Pads carry an eight-letter unique id keyed by their record index.
  const uniqueIds = new ByteWriter();
  for (const index of padIndices) {
    uniqueIds.raw(propertyStream(
      `|PRIMITIVEINDEX=${index}|PRIMITIVEOBJECTID=Pad|UNIQUEID=${identity.uniqueId()}`
    ));
  }

  const empty = new Uint8Array(0);
  const streams = [
    { path: "FileHeader", data: fileHeader(libraryId) },
    { path: "Library/Header", data: u32Stream(1) },
    { path: "Library/Data", data: libraryData(name) },
    { path: "Library/EmbeddedFonts", data: u32Stream(0) },
    { path: "Library/LayerKindMapping/Header", data: u32Stream(1) },
    { path: "Library/LayerKindMapping/Data", data: layerKindMapping() },
    { path: "Library/Models/Header", data: u32Stream(0) },
    { path: "Library/Models/Data", data: empty },
    { path: "Library/ModelsNoEmbed/Header", data: u32Stream(0) },
    { path: "Library/ModelsNoEmbed/Data", data: empty },
    { path: "Library/Textures/Header", data: u32Stream(0) },
    { path: "Library/Textures/Data", data: empty },
    { path: "Library/PadViaLibrary/Header", data: u32Stream(0) },
    {
      path: "Library/PadViaLibrary/Data",
      data: propertyStream(`|PADVIALIBRARY.LIBRARYID=${padViaLibraryId}` +
        "|PADVIALIBRARY.LIBRARYNAME=<Local>|PADVIALIBRARY.DISPLAYUNITS=1")
    },
    { path: "Library/ComponentParamsTOC/Header", data: u32Stream(1) },
    {
      path: "Library/ComponentParamsTOC/Data",
      data: propertyStream(`Name=${name}|Pad Count=${padIndices.length}|Height=0|Description=${description}\r\n`)
    },
    { path: `${key}/Header`, data: u32Stream(primitives.length) },
    {
      path: `${key}/Parameters`,
      data: propertyStream(`|PATTERN=${name}|HEIGHT=0mil|DESCRIPTION=${description}|ITEMGUID=|REVISIONGUID=`)
    },
    { path: `${key}/WideStrings`, data: propertyStream(wideStringsText(wideStrings)) },
    { path: `${key}/Data`, data: data.toBytes() }
  ];
  if (padIndices.length) {
    streams.push(
      { path: `${key}/UniqueIDPrimitiveInformation/Header`, data: u32Stream(padIndices.length) },
      { path: `${key}/UniqueIDPrimitiveInformation/Data`, data: uniqueIds.toBytes() }
    );
  }
  if (key !== name) {
    streams.push({ path: "SectionKeys", data: sectionKeysStream(name, key) });
  }
  return writeCompoundFile(streams);
}

export { exportAltiumPcbLib };

/*
######################################################################################################################


                                        AAAAAAAA
                                      AAAA    AAAAA              AAAAAAAA
                                    AAA          AAA           AAAA    AAA
                                    AA            AA          AAA       AAA
                                    AA            AAAAAAAAAA  AAA       AAAAAAAAAA
                                    AAA                  AAA  AAA               AA
                                     AAA                AAA    AAAAA            AA
                                      AAAAA            AAA        AAA           AA
                                         AAA          AAA                       AA
                                         AAA         AAA                        AA
                                         AA         AAA                         AA
                                         AA        AAA                          AA
                                        AAA       AAAAAAAAA                     AA
                                        AAA       AAAAAAAAA                     AA
                                        AA                   AAAAAAAAAAAAAA     AA
                                        AA  AAAAAAAAAAAAAAAAAAAAAAAA    AAAAAAA AA
                                       AAAAAAAAAAA                           AA AA
                                                                           AAA  AA
                                                                         AAAA   AA
                                                                      AAAA      AA
                                                                   AAAAA        AA
                                                               AAAAA            AA
                                                            AAAAA               AA
                                                        AAAAAA                  AA
                                                    AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA


######################################################################################################################

                                                Copyright (c) JoeShade
                              Licensed under the GNU Affero General Public License v3.0

######################################################################################################################

                                        +44 (0) 7356 042702 | joe@jshade.co.uk

######################################################################################################################
*/
