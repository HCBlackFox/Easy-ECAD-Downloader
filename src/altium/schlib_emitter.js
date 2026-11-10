/*
 * Builds a native Altium Designer schematic library (.SchLib) from the
 * normalized EasyEDA symbol model produced by convertSymbolToKiCad. The model
 * uses millimetres with Y pointing up, as Altium does; this module converts
 * pins, graphics, designator, parameters and the optional footprint link into
 * Altium records and packs them into a compound file with compound_file.js.
 */

import { writeCompoundFile } from "./compound_file.js";
import {
  ByteWriter,
  binaryRecord,
  concatBytes,
  coordEntries,
  createUniqueIdFactory,
  isAnsiChar,
  textRecord,
  toAltiumUnits,
  zlibStore
} from "./schlib_records.js";

const LIBRARY_HEADER = "Protel for Windows - Schematic Library Editor Binary File Version 5.0";
const MAX_STORAGE_NAME = 31;
const ROOT_STREAM_NAMES = new Set(["FILEHEADER", "STORAGE", "SECTIONKEYS"]);
const STORAGE_RESERVED_CHARS = '/\\:!<>"|?*';

// Altium colours are BGR integers: dark-red body outline, light-yellow body
// fill, black pins and navy text, as in symbols drawn by Altium Designer.
const BODY_COLOR = 128;
const BODY_FILL_COLOR = 11599871;
const PIN_COLOR = 0;
const TEXT_COLOR = 8388608;
const LINE_WIDTH_SMALL = 1;
const TEXT_LINE_UNITS = 10;

const PIN_ELECTRICAL = {
  input: 0,
  bidirectional: 1,
  output: 2,
  power_in: 7
};
const PIN_ELECTRICAL_PASSIVE = 4;
const PIN_SYMBOL_NEGATED = 1;
const PIN_SYMBOL_CLOCK = 3;
// Pin conglomerate bits: 0-1 orientation, 0x08 name shown, 0x10 designator
// shown; Altium also sets the undocumented 0x20 bit on ordinary pins.
const PIN_FLAGS_VISIBLE = 0x38;

function pinElectricalType(type) {
  const key = String(type || "").replace(/^_/, "");
  return PIN_ELECTRICAL[key] ?? PIN_ELECTRICAL_PASSIVE;
}

function pinEdgeSymbols(style) {
  return {
    inner: style === "clock" || style === "inverted_clock" ? PIN_SYMBOL_CLOCK : 0,
    outer: style === "inverted" || style === "inverted_clock" ? PIN_SYMBOL_NEGATED : 0
  };
}

// EasyEDA marks an active-low label with a trailing '#', per slash-separated
// segment. Altium draws an overbar over each character followed by '\'.
function altiumPinName(name) {
  return String(name || "")
    .split("/")
    .map((segment) => (segment.endsWith("#")
      ? [...segment.slice(0, -1)].map((char) => `${char}\\`).join("")
      : segment))
    .join("/");
}

const DIRECTIONS = { 0: [1, 0], 90: [0, 1], 180: [-1, 0], 270: [0, -1] };

/**
 * The model follows KiCad: (posX, posY) is the connection point and
 * `orientation` points from it along the pin toward the body. Altium stores
 * the body end as Location and an orientation pointing from the body to the
 * connection point, so the location moves by the pin length and the
 * direction turns by 180 degrees (KiCad's importer applies the inverse).
 */
function pinPlacement(pin) {
  const angle = ((Math.round((Number(pin.orientation) || 0) / 90) * 90) % 360 + 360) % 360;
  const [dx, dy] = DIRECTIONS[angle];
  const length = Math.max(0, Number(pin.length) || 0);
  return {
    bodyX: (Number(pin.posX) || 0) + dx * length,
    bodyY: (Number(pin.posY) || 0) + dy * length,
    length,
    orientation: ((angle + 180) % 360) / 90
  };
}

// Binary pin layout as written by Altium; KiCad's ParseLibFile reads the same
// sequence. Integer coordinates live here, fractions in the PinFrac stream.
function pinRecord(pin, placement) {
  const edges = pinEdgeSymbols(pin.style);
  const x = toAltiumUnits(placement.bodyX);
  const y = toAltiumUnits(placement.bodyY);
  const length = toAltiumUnits(placement.length);
  const body = new ByteWriter()
    .i32(2) // RECORD=2
    .u8(0)
    .i16(1) // OwnerPartId
    .u8(0) // OwnerPartDisplayMode
    .u8(edges.inner) // Symbol_InnerEdge
    .u8(edges.outer) // Symbol_OuterEdge
    .u8(0) // Symbol_Inner
    .u8(0) // Symbol_Outer
    .pascal("") // Description
    .u8(1) // FormalType
    .u8(pinElectricalType(pin.type))
    .u8(PIN_FLAGS_VISIBLE | placement.orientation)
    .i16(length.whole)
    .i16(x.whole)
    .i16(y.whole)
    .i32(PIN_COLOR)
    .pascal(altiumPinName(pin.name))
    .pascal(pin.number ?? "")
    .pascal("") // SwapIdGroup
    .pascal("|&|") // SwapIdPart|&|SwapIdSequence
    .pascal("") // DefaultValue
    .toBytes();
  const fractions = [x.frac, y.frac, length.frac];
  return { record: binaryRecord(body), fractions: fractions.some(Boolean) ? fractions : null };
}

/**
 * PinFrac holds the sub-unit pin coordinates: a `|HEADER=PinFrac` record,
 * then one binary record per affected pin containing 0xD0, the pin's index
 * among the component's pins as a Pascal string, and an int32-length zlib
 * payload of three int32 values (Location.X, Location.Y, PinLength fractions).
 */
function pinFracStream(entries) {
  const records = [textRecord([["HEADER", "PinFrac"], ["Weight", entries.length]])];
  for (const { index, fractions } of entries) {
    const payload = new ByteWriter();
    fractions.forEach((value) => payload.i32(value));
    const compressed = zlibStore(payload.toBytes());
    records.push(binaryRecord(new ByteWriter()
      .u8(0xd0)
      .pascal(String(index))
      .i32(compressed.length)
      .raw(compressed)
      .toBytes()));
  }
  return concatBytes(records);
}

function normalizeAngle(degrees) {
  const value = ((degrees % 360) + 360) % 360;
  return Number(value.toFixed(3)) === 360 ? 0 : value;
}

function circleThroughPoints([ax, ay], [bx, by], [cx, cy]) {
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) < 1e-9) {
    return null;
  }
  const a2 = ax * ax + ay * ay;
  const b2 = bx * bx + by * by;
  const c2 = cx * cx + cy * cy;
  const x = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d;
  const y = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d;
  return { x, y, radius: Math.hypot(ax - x, ay - y) };
}

/**
 * Altium arcs run counter-clockwise (Y up) from StartAngle to EndAngle around
 * Location. The model's start/middle/end points fix the circle; the sweep
 * that contains the middle point decides which endpoint starts the arc.
 */
function arcGeometry(arc) {
  const start = [arc.startX, arc.startY];
  const middle = [arc.middleX, arc.middleY];
  const end = [arc.endX, arc.endY];
  const circle = circleThroughPoints(start, middle, end);
  if (!circle) {
    return null;
  }
  const angleOf = ([x, y]) => normalizeAngle(Math.atan2(y - circle.y, x - circle.x) * 180 / Math.PI);
  const startAngle = angleOf(start);
  const middleAngle = angleOf(middle);
  const endAngle = angleOf(end);
  const ccwContainsMiddle =
    normalizeAngle(middleAngle - startAngle) < normalizeAngle(endAngle - startAngle);
  return {
    ...circle,
    startAngle: ccwContainsMiddle ? startAngle : endAngle,
    endAngle: ccwContainsMiddle ? endAngle : startAngle
  };
}

// Library primitives belong to part 1 and carry their drawing order in
// IndexInSheet; Altium omits the zero index of the first child.
function primitiveEntries(record, indexInSheet) {
  return [
    ["RECORD", record],
    ["IsNotAccesible", "T"],
    ["IndexInSheet", indexInSheet || undefined],
    ["OwnerPartId", 1]
  ];
}

function pointEntries(points) {
  const entries = [["LocationCount", points.length]];
  points.forEach(([x, y], index) => {
    entries.push(...coordEntries(`X${index + 1}`, x), ...coordEntries(`Y${index + 1}`, y));
  });
  return entries;
}

function samePoint(left, right) {
  return Math.abs(left[0] - right[0]) < 1e-9 && Math.abs(left[1] - right[1]) < 1e-9;
}

// Each builder returns property entries (without UniqueID) for one primitive.
const graphicBuilders = {
  rectangle(rect, index) {
    return [
      ...primitiveEntries(14, index),
      ...coordEntries("Location.X", Math.min(rect.posX0, rect.posX1)),
      ...coordEntries("Location.Y", Math.min(rect.posY0, rect.posY1)),
      ...coordEntries("Corner.X", Math.max(rect.posX0, rect.posX1)),
      ...coordEntries("Corner.Y", Math.max(rect.posY0, rect.posY1)),
      ["LineWidth", LINE_WIDTH_SMALL],
      ["Color", BODY_COLOR],
      ["AreaColor", BODY_FILL_COLOR],
      ["IsSolid", "T"]
    ];
  },

  // Filled circles become solid ellipses with equal radii; outline circles
  // become full 0-360 degree arcs, both as Altium itself draws them.
  circle(circle, index) {
    const centre = [
      ...coordEntries("Location.X", circle.posX),
      ...coordEntries("Location.Y", circle.posY)
    ];
    if (circle.background) {
      return [
        ...primitiveEntries(8, index),
        ...centre,
        ...coordEntries("Radius", circle.radius),
        ...coordEntries("SecondaryRadius", circle.radius),
        ["LineWidth", LINE_WIDTH_SMALL],
        ["Color", BODY_COLOR],
        ["AreaColor", BODY_FILL_COLOR],
        ["IsSolid", "T"]
      ];
    }
    return [
      ...primitiveEntries(12, index),
      ...centre,
      ...coordEntries("Radius", circle.radius),
      ["LineWidth", LINE_WIDTH_SMALL],
      ["EndAngle", "360.000"],
      ["Color", BODY_COLOR]
    ];
  },

  arc(arc, index) {
    const geometry = arcGeometry(arc);
    if (!geometry) {
      return graphicBuilders.polyline([[arc.startX, arc.startY], [arc.endX, arc.endY]], index);
    }
    const startAngle = geometry.startAngle.toFixed(3);
    return [
      ...primitiveEntries(12, index),
      ...coordEntries("Location.X", geometry.x),
      ...coordEntries("Location.Y", geometry.y),
      ...coordEntries("Radius", geometry.radius),
      ["LineWidth", LINE_WIDTH_SMALL],
      ["StartAngle", startAngle === "0.000" ? undefined : startAngle],
      ["EndAngle", geometry.endAngle.toFixed(3)],
      ["Color", BODY_COLOR]
    ];
  },

  polyline(points, index) {
    return [
      ...primitiveEntries(6, index),
      ["LineWidth", LINE_WIDTH_SMALL],
      ["Color", BODY_COLOR],
      ...pointEntries(points)
    ];
  },

  // Closed outlines are filled with the body colour, matching the KiCad
  // emitter's background fill; Altium closes polygons implicitly.
  polygon(polygon, index) {
    const points = polygon.points.map(([x, y]) => [Number(x) || 0, Number(y) || 0]);
    const closed = polygon.isClosed && points.length > 1 && samePoint(points[0], points.at(-1));
    const outline = closed ? points.slice(0, -1) : points;
    if (!closed || outline.length < 3) {
      return points.length >= 2 ? graphicBuilders.polyline(points, index) : null;
    }
    return [
      ...primitiveEntries(7, index),
      ["LineWidth", LINE_WIDTH_SMALL],
      ["Color", BODY_COLOR],
      ["AreaColor", BODY_FILL_COLOR],
      ["IsSolid", "T"],
      ...pointEntries(outline)
    ];
  }
};

function symbolBounds(symbol, placements) {
  const xs = [];
  const ys = [];
  const add = (x, y) => {
    if (Number.isFinite(x) && Number.isFinite(y)) {
      xs.push(x);
      ys.push(y);
    }
  };
  for (const rect of symbol.rectangles || []) {
    add(rect.posX0, rect.posY0);
    add(rect.posX1, rect.posY1);
  }
  for (const circle of symbol.circles || []) {
    add(circle.posX - circle.radius, circle.posY - circle.radius);
    add(circle.posX + circle.radius, circle.posY + circle.radius);
  }
  for (const arc of symbol.arcs || []) {
    add(arc.startX, arc.startY);
    add(arc.middleX, arc.middleY);
    add(arc.endX, arc.endY);
  }
  for (const polygon of symbol.polygons || []) {
    polygon.points.forEach(([x, y]) => add(x, y));
  }
  const graphicsLeft = xs.length ? Math.min(...xs) : null;
  (symbol.pins || []).forEach((pin, index) => {
    add(Number(pin.posX), Number(pin.posY));
    add(placements[index].bodyX, placements[index].bodyY);
  });
  return {
    left: graphicsLeft ?? (xs.length ? Math.min(...xs) : 0),
    top: ys.length ? Math.max(...ys) : 0,
    bottom: ys.length ? Math.min(...ys) : 0
  };
}

// Altium names the component storage after the LibReference, cut to the
// 31-character compound-file limit, and records any differing name in the
// root SectionKeys stream. Reserved, path-like and non-ANSI characters become
// '_' so readers that resolve storages from the ANSI LibRef0 still find it.
function resolveStorageName(libReference) {
  const name = Array.from(libReference, (char) =>
    (isAnsiChar(char) && !STORAGE_RESERVED_CHARS.includes(char) ? char : "_"))
    .join("")
    .slice(0, MAX_STORAGE_NAME);
  return ROOT_STREAM_NAMES.has(name.toUpperCase()) ? `${name.slice(0, MAX_STORAGE_NAME - 1)}_` : name;
}

// Field text sits on whole units outside the drawing: rounding away from the
// body keeps labels clear of the outline.
function textUnits(mm, round) {
  const { whole, frac } = toAltiumUnits(mm);
  return round(whole + frac / 100000) + 0;
}

/**
 * @param {object} symbol  normalized symbol = convertSymbolToKiCad(parseEasyedaSymbol(cadData))
 * @param {{ libReference: string, footprintName?: string, description?: string }} options
 * @returns {Uint8Array} complete .SchLib file bytes
 */
function exportAltiumSchLib(symbol, options = {}) {
  const info = symbol?.info || {};
  const libReference = String(options.libReference || info.name || "Component").trim() || "Component";
  const description = options.description ? String(options.description) : undefined;
  const footprintName = options.footprintName ? String(options.footprintName) : "";
  const nextUniqueId = createUniqueIdFactory(libReference);
  const pins = symbol?.pins || [];
  const placements = pins.map(pinPlacement);

  const records = [];
  const addText = (entries, withUniqueId = true) => {
    records.push(textRecord(withUniqueId ? [...entries, ["UniqueID", nextUniqueId()]] : entries));
    return records.length - 1;
  };

  addText([
    ["RECORD", 1],
    ["LibReference", libReference],
    ["ComponentDescription", description],
    ["PartCount", 2], // Altium stores the part count plus one.
    ["DisplayModeCount", 1],
    ["IndexInSheet", -1],
    ["OwnerPartId", -1],
    ["CurrentPartId", 1],
    ["LibraryPath", "*"],
    ["SourceLibraryName", "*"],
    ["SheetPartFileName", "*"],
    ["TargetFileName", "*"],
    ["UniqueID", nextUniqueId()],
    ["AreaColor", BODY_FILL_COLOR],
    ["Color", BODY_COLOR],
    ["PartIDLocked", "T"],
    ["DesignItemId", libReference],
    ["AllPinCount", pins.length]
  ], false);

  // Children are drawn in record order: filled bodies first, pins on top.
  let childIndex = 0;
  const graphics = [
    ...(symbol?.rectangles || []).map((item) => ["rectangle", item]),
    ...(symbol?.circles || []).map((item) => ["circle", item]),
    ...(symbol?.arcs || []).map((item) => ["arc", item]),
    ...(symbol?.polygons || []).map((item) => ["polygon", item])
  ];
  for (const [kind, item] of graphics) {
    const entries = graphicBuilders[kind](item, childIndex);
    if (entries) {
      addText(entries);
      childIndex += 1;
    }
  }

  const fracEntries = [];
  pins.forEach((pin, index) => {
    const { record, fractions } = pinRecord(pin, placements[index]);
    records.push(record);
    childIndex += 1;
    if (fractions) {
      fracEntries.push({ index, fractions });
    }
  });

  const bounds = symbolBounds(symbol || {}, placements);
  const textX = textUnits(bounds.left, Math.floor);
  const fieldEntries = (x, y) => [
    ["IndexInSheet", -1],
    ["OwnerPartId", -1],
    ["Location.X", x || undefined],
    ["Location.Y", y || undefined],
    ["Color", TEXT_COLOR],
    ["FontID", 1]
  ];

  addText([
    ["RECORD", 34],
    ...fieldEntries(textX, textUnits(bounds.top, Math.ceil) + 2),
    ["Text", `${String(info.prefix || "U").replace(/\?+$/, "") || "U"}?`],
    ["Name", "Designator"],
    ["ReadOnlyState", 1]
  ]);

  let textY = textUnits(bounds.bottom, Math.floor) - 2 - TEXT_LINE_UNITS;
  addText([
    ["RECORD", 41],
    ...fieldEntries(textX, textY),
    ["Text", info.name || libReference],
    ["Name", "Comment"]
  ]);

  const hiddenParameters = [
    ["Manufacturer", info.manufacturer],
    ["LCSC Part", info.lcscId],
    ["Package", info.package],
    ["Datasheet", info.datasheet]
  ];
  for (const [name, value] of hiddenParameters) {
    if (value) {
      textY -= TEXT_LINE_UNITS;
      addText([
        ["RECORD", 41],
        ...fieldEntries(textX, textY),
        ["IsHidden", "T"],
        ["Text", value],
        ["Name", name]
      ]);
    }
  }

  // OwnerIndex counts every record in the Data stream, binary pins included,
  // with the component record at index 0 (the implicit owner of record 44).
  const implementationList = addText([["RECORD", 44]], false);
  if (footprintName) {
    const implementation = addText([
      ["RECORD", 45],
      ["OwnerIndex", implementationList],
      ["IndexInSheet", -1],
      ["ModelName", footprintName],
      ["ModelType", "PCBLIB"],
      ["DatafileCount", 1],
      ["ModelDatafileEntity0", footprintName],
      ["ModelDatafileKind0", "PCBLib"],
      ["IsCurrent", "T"]
    ]);
    addText([["RECORD", 46], ["OwnerIndex", implementation]], false);
    addText([["RECORD", 48], ["OwnerIndex", implementation]], false);
  }

  const storageName = resolveStorageName(libReference);
  const fileHeader = textRecord([
    ["HEADER", LIBRARY_HEADER],
    ["Weight", records.length + 1],
    ["MinorVersion", 9],
    ["UniqueID", nextUniqueId()],
    ["FontIdCount", 1],
    ["Size1", 10],
    ["FontName1", "Times New Roman"],
    ["UseMBCS", "T"],
    ["IsBOC", "T"],
    ["SheetStyle", 9],
    ["BorderOn", "T"],
    ["SheetNumberSpaceSize", 12],
    ["AreaColor", 16317695],
    ["SnapGridOn", "T"],
    ["SnapGridSize", 10],
    ["VisibleGridOn", "T"],
    ["VisibleGridSize", 10],
    ["CustomX", 18000],
    ["CustomY", 18000],
    ["UseCustomSheet", "T"],
    ["ReferenceZonesOn", "T"],
    ["Display_Unit", 0],
    ["CompCount", 1],
    ["LibRef0", libReference],
    ["CompDescr0", description],
    ["PartCount0", 2]
  ]);

  const streams = [
    { path: "FileHeader", data: fileHeader },
    { path: "Storage", data: textRecord([["HEADER", "Icon storage"]]) },
    { path: `${storageName}/Data`, data: concatBytes(records) }
  ];
  if (storageName !== libReference) {
    streams.push({
      path: "SectionKeys",
      data: textRecord([["KeyCount", 1], ["LibRef0", libReference], ["SectionKey0", storageName]])
    });
  }
  if (fracEntries.length) {
    streams.push({ path: `${storageName}/PinFrac`, data: pinFracStream(fracEntries) });
  }
  return writeCompoundFile(streams);
}

export { exportAltiumSchLib };

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
