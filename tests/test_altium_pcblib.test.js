/*
 * These tests cover the native Altium .PcbLib footprint emitter: library and
 * footprint streams, section keys for long or illegal names, and the binary
 * pad, via, track, arc, text and region records decoded back from the file,
 * including the Y-up coordinate flip and EasyEDA layer, hole and slot rules.
 */

import { describe, expect, it } from "vitest";

import { exportAltiumPcbLib } from "../src/altium/pcblib_emitter.js";
import { parseEasyedaFootprint } from "../src/kicad/easyeda_footprint_parser.js";
import { convertFootprintToKiCad } from "../src/kicad/kicad_footprint_emitter.js";
import { readCompoundFile } from "./helpers/compound_file_reader.js";
import { createCadData } from "./helpers/fixtures.js";

const MM_PER_UNIT = 0.0254 / 10000;
const NAMES = { 1: "TOP", 32: "BOTTOM", 33: "TOP_OVERLAY", 74: "MULTI_LAYER" };
// Primitive subrecord counts per record type: arc, pad, via, track, text, region.
const SUBRECORDS = { 1: 1, 2: 6, 3: 1, 4: 1, 5: 2, 11: 1 };

function footprintFrom(shapes, cadData = createCadData()) {
  if (shapes) cadData.packageDetail.dataStr.shape = shapes;
  return convertFootprintToKiCad(parseEasyedaFootprint(cadData));
}

function exportLibrary(options = {}, shapes) {
  const bytes = exportAltiumPcbLib(footprintFrom(shapes), {
    footprintName: "QFN-16/Example",
    ...options
  });
  return { bytes, streams: readCompoundFile(bytes).streams };
}

function latin1(bytes) {
  return String.fromCharCode(...bytes);
}

function viewOf(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function u32(bytes, offset = 0) {
  return viewOf(bytes).getUint32(offset, true);
}

function mm(bytes, offset) {
  return viewOf(bytes).getInt32(offset, true) * MM_PER_UNIT;
}

function f64(bytes, offset) {
  return viewOf(bytes).getFloat64(offset, true);
}

// Reads a "u32 size + NUL-terminated |KEY=VALUE" block into a key map.
function readProperties(bytes, offset = 0) {
  const length = u32(bytes, offset);
  const text = latin1(bytes.subarray(offset + 4, offset + 4 + length));
  expect(text.endsWith("\0")).toBe(true);
  const map = {};
  for (const entry of text.slice(0, -1).split("|")) {
    const index = entry.indexOf("=");
    if (index > 0) map[entry.slice(0, index)] = entry.slice(index + 1);
  }
  return { text: text.slice(0, -1), map, end: offset + 4 + length };
}

// Reads a "u32 size + u8 length + chars" string block.
function readStringBlock(bytes, offset) {
  const size = u32(bytes, offset);
  const length = bytes[offset + 4];
  expect(size).toBe(length + 1);
  return { value: latin1(bytes.subarray(offset + 5, offset + 5 + length)), end: offset + 4 + size };
}

function parseFootprintData(bytes) {
  const name = readStringBlock(bytes, 0);
  const records = [];
  let offset = name.end;
  while (offset < bytes.length) {
    const type = bytes[offset];
    offset += 1;
    const subs = [];
    for (let i = 0; i < SUBRECORDS[type]; i += 1) {
      const length = u32(bytes, offset);
      subs.push(bytes.subarray(offset + 4, offset + 4 + length));
      offset += 4 + length;
    }
    records.push({ type, subs });
  }
  expect(offset).toBe(bytes.length);
  return { name: name.value, records };
}

function decodePad({ subs }) {
  const [designator, , , , main, sizeAndShape] = subs;
  const pad = {
    designator: latin1(designator.subarray(1, 1 + designator[0])),
    layer: main[0],
    x: mm(main, 13),
    y: mm(main, 17),
    sizeX: mm(main, 21),
    sizeY: mm(main, 25),
    hole: mm(main, 45),
    shape: main[49],
    rotation: f64(main, 52),
    plated: main[60],
    padMode: main[62],
    pasteMode: main[101],
    solderMode: main[102],
    v7Layer: u32(main, 114),
    marker: main[185],
    mainLength: main.length,
    sizeAndShapeLength: sizeAndShape.length
  };
  if (sizeAndShape.length) {
    pad.holeShape = sizeAndShape[262];
    pad.slotLength = mm(sizeAndShape, 263);
    pad.slotRotation = f64(sizeAndShape, 267);
  }
  return pad;
}

function decodeTrack({ subs: [b] }) {
  return { layer: b[0], x1: mm(b, 13), y1: mm(b, 17), x2: mm(b, 21), y2: mm(b, 25), width: mm(b, 29), v7: u32(b, 41) };
}

function decodeArc({ subs: [b] }) {
  return {
    layer: b[0], cx: mm(b, 13), cy: mm(b, 17), radius: mm(b, 21),
    startAngle: f64(b, 25), endAngle: f64(b, 33), width: mm(b, 41), length: b.length
  };
}

function decodeRegion({ subs: [b] }) {
  const props = readProperties(b, 18);
  const count = u32(b, props.end);
  const points = [];
  for (let i = 0; i < count; i += 1) {
    const at = props.end + 4 + i * 16;
    points.push([f64(b, at) * MM_PER_UNIT, f64(b, at + 8) * MM_PER_UNIT]);
  }
  expect(props.end + 4 + count * 16).toBe(b.length);
  return { layer: b[0], holes: b[14], props: props.map, points };
}

function decodeText({ subs: [b, text] }) {
  return {
    layer: b[0], x: mm(b, 13), y: mm(b, 17), height: mm(b, 21), font: b[25], rotation: f64(b, 27),
    mirror: b[35], strokeWidth: mm(b, 36), wideStringIndex: u32(b, 115), v7: u32(b, 226),
    text: latin1(text.subarray(1, 1 + text[0])), length: b.length
  };
}

function decodeVia({ subs: [b] }) {
  return {
    layer: b[0], x: mm(b, 13), y: mm(b, 17), diameter: mm(b, 21), hole: mm(b, 25),
    startLayer: b[29], endLayer: b[30], topDiameter: mm(b, 75), length: b.length
  };
}

function primitivesOf(streams, key = "QFN-16_Example") {
  const { name, records } = parseFootprintData(streams.get(`${key}/Data`));
  const byType = (type, decode) => records.filter((record) => record.type === type).map(decode);
  return {
    name,
    records,
    pads: byType(2, decodePad),
    vias: byType(3, decodeVia),
    tracks: byType(4, decodeTrack),
    arcs: byType(1, decodeArc),
    texts: byType(5, decodeText),
    regions: byType(11, decodeRegion)
  };
}

function expectPoint(actual, expected) {
  expect(actual[0]).toBeCloseTo(expected[0], 4);
  expect(actual[1]).toBeCloseTo(expected[1], 4);
}

describe("Altium PcbLib emitter", () => {
  it("writes the library stream set Altium expects without an embedded model", () => {
    const { streams } = exportLibrary();
    expect([...streams.keys()].sort()).toEqual([
      "FileHeader",
      "Library/ComponentParamsTOC/Data",
      "Library/ComponentParamsTOC/Header",
      "Library/Data",
      "Library/EmbeddedFonts",
      "Library/Header",
      "Library/LayerKindMapping/Data",
      "Library/LayerKindMapping/Header",
      "Library/Models/Data",
      "Library/Models/Header",
      "Library/ModelsNoEmbed/Data",
      "Library/ModelsNoEmbed/Header",
      "Library/PadViaLibrary/Data",
      "Library/PadViaLibrary/Header",
      "Library/Textures/Data",
      "Library/Textures/Header",
      "QFN-16_Example/Data",
      "QFN-16_Example/Header",
      "QFN-16_Example/Parameters",
      "QFN-16_Example/UniqueIDPrimitiveInformation/Data",
      "QFN-16_Example/UniqueIDPrimitiveInformation/Header",
      "QFN-16_Example/WideStrings",
      "SectionKeys"
    ]);
    expect(streams.get("Library/Models/Data").length).toBe(0);
    expect(u32(streams.get("Library/Models/Header"))).toBe(0);
    expect([...streams.get("Library/EmbeddedFonts")]).toEqual([0, 0, 0, 0]);
    expect([...streams.get("Library/LayerKindMapping/Data")]).toEqual(
      [8, 0, 0, 0, 0x31, 0, 0x2e, 0, 0x30, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
    );
  });

  it("writes the PCB 6.0 file header and the library footprint list", () => {
    const { streams } = exportLibrary();
    const header = streams.get("FileHeader");
    expect(header.length).toBe(53);
    expect(u32(header)).toBe(27);
    expect(latin1(header.subarray(5, 32))).toBe("PCB 6.0 Binary Library File");
    expect(f64(header, 32)).toBe(5.01);
    expect(u32(header, 40)).toBe(8);
    expect(latin1(header.subarray(45))).toMatch(/^[A-Z]{8}$/);

    const library = streams.get("Library/Data");
    const props = readProperties(library);
    expect(props.map.KIND).toBe("Protel_Advanced_PCB_Library");
    expect(props.map.LAYER1NAME).toBe("Top Layer");
    expect(props.map.LAYER1NEXT).toBe("32");
    expect(props.map.LAYER32PREV).toBe("1");
    expect(props.map.LAYER74NAME).toBe("Multi-Layer");
    expect(props.map.LAYER82NAME).toBe("Via Holes");
    for (const layer of [57, 68, 69, 70, 71]) expect(props.map[`LAYER${layer}MECHENABLED`]).toBe("TRUE");
    expect(props.map.LAYER58MECHENABLED).toBe("FALSE");
    expect(u32(library, props.end)).toBe(1);
    const listed = readStringBlock(library, props.end + 4);
    expect(listed.value).toBe("QFN-16/Example");
    expect(listed.end).toBe(library.length);
    expect(u32(streams.get("Library/Header"))).toBe(1);
  });

  it("records the footprint parameters, primitive count and pad unique ids", () => {
    const { streams } = exportLibrary({ description: "Demo | QFN" });
    const params = readProperties(streams.get("QFN-16_Example/Parameters"));
    expect(params.text).toBe("|PATTERN=QFN-16/Example|HEIGHT=0mil|DESCRIPTION=Demo QFN|ITEMGUID=|REVISIONGUID=");
    const toc = readProperties(streams.get("Library/ComponentParamsTOC/Data"));
    expect(toc.text).toBe("Name=QFN-16/Example|Pad Count=3|Height=0|Description=Demo QFN\r\n");

    const { name, records } = primitivesOf(streams);
    expect(name).toBe("QFN-16/Example");
    expect(u32(streams.get("QFN-16_Example/Header"))).toBe(records.length);
    expect(records.map((record) => record.type)).toEqual([2, 2, 11, 11, 11, 2, 3, 4, 4, 4, 4, 4, 4, 1, 1, 5]);

    const uniqueIds = streams.get("QFN-16_Example/UniqueIDPrimitiveInformation/Data");
    const entries = [];
    for (let offset = 0; offset < uniqueIds.length;) {
      const entry = readProperties(uniqueIds, offset);
      entries.push(entry.map);
      offset = entry.end;
    }
    // Unique ids are keyed by the pad's record index within the Data stream.
    expect(entries.map((entry) => entry.PRIMITIVEINDEX)).toEqual(["0", "1", "5"]);
    expect(entries.every((entry) => entry.PRIMITIVEOBJECTID === "Pad" && /^[A-Z]{8}$/.test(entry.UNIQUEID))).toBe(true);
    expect(u32(streams.get("QFN-16_Example/UniqueIDPrimitiveInformation/Header"))).toBe(3);
  });

  it("converts pads, holes and vias to Altium coordinates with Y pointing up", () => {
    const { pads, vias } = primitivesOf(exportLibrary().streams);
    const [rectPad, polygonAnchor, hole] = pads;

    expect(rectPad).toMatchObject({ designator: "1", layer: 1, shape: 2, rotation: 90, plated: 1, padMode: 0 });
    expect(rectPad).toMatchObject({ pasteMode: 1, solderMode: 1, v7Layer: 0x01000001, marker: 3 });
    expect(rectPad.mainLength).toBe(202);
    expect(rectPad.sizeAndShapeLength).toBe(0);
    expectPoint([rectPad.x, rectPad.y], [0, 0]);
    expectPoint([rectPad.sizeX, rectPad.sizeY], [5.08, 2.54]);
    expect(rectPad.hole).toBe(0);

    expect(polygonAnchor).toMatchObject({ designator: "2", layer: 1, shape: 1, rotation: 0 });
    expectPoint([polygonAnchor.x, polygonAnchor.y], [5.08, 0]);
    expect(polygonAnchor.sizeX).toBeGreaterThan(0.5);
    expect(polygonAnchor.sizeX).toBeLessThan(1.2);

    // HOLE (110, 210) sits below the origin in EasyEDA's Y-down space.
    expect(hole).toMatchObject({ designator: "", layer: 74, shape: 1, plated: 0, marker: 1 });
    expect(hole.v7Layer).toBe(0x0103000f);
    expectPoint([hole.x, hole.y], [2.54, -2.54]);
    expectPoint([hole.sizeX, hole.hole], [1.016, 1.016]);

    expect(vias).toHaveLength(1);
    expect(vias[0]).toMatchObject({ layer: 74, startLayer: 1, endLayer: 32, length: 321 });
    expectPoint([vias[0].x, vias[0].y], [4.572, -2.032]);
    expectPoint([vias[0].diameter, vias[0].hole], [0.762, 0.508]);
    expect(vias[0].topDiameter).toBeCloseTo(0.762, 4);
  });

  it("builds custom polygon pads from copper, solder and paste regions", () => {
    const { regions } = primitivesOf(exportLibrary().streams);
    expect(regions.map((region) => NAMES[region.layer] ?? region.layer)).toEqual(["TOP", 37, 35]);
    expect(regions.map((region) => region.props.V7_LAYER)).toEqual(["TOP", "TOPSOLDER", "TOPPASTE"]);
    for (const region of regions) {
      expect(region.props).toMatchObject({ KIND: "0", ISSHAPEBASED: "FALSE", SUBPOLYINDEX: "-1" });
      expect(region.holes).toBe(0);
      expect(region.points).toHaveLength(3);
      expectPoint(region.points[0], [5.08, 1.27]);
      expectPoint(region.points[1], [6.35, -1.27]);
      expectPoint(region.points[2], [3.81, -1.27]);
    }
  });

  it("emits tracks, rectangle edges, full circles and SVG arcs on mapped layers", () => {
    const { tracks, arcs } = primitivesOf(exportLibrary().streams);
    expect(tracks).toHaveLength(6);
    expect(tracks.every((track) => track.layer === 33 && track.v7 === 0x01030006)).toBe(true);
    expectPoint([tracks[0].x1, tracks[0].y1], [0, 2.54]);
    expectPoint([tracks[0].x2, tracks[0].y2], [5.08, 2.54]);
    expectPoint([tracks[1].x2, tracks[1].y2], [5.08, -2.54]);
    expect(tracks[0].width).toBeCloseTo(0.254, 4);
    // RECT (95, 195) 30x20 becomes four edges starting at its top-left corner.
    expectPoint([tracks[2].x1, tracks[2].y1], [-1.27, 1.27]);
    expectPoint([tracks[3].x2, tracks[3].y2], [6.35, -3.81]);

    const [circle, arc] = arcs;
    expect(circle).toMatchObject({ layer: 33, startAngle: 0, endAngle: 360, length: 60 });
    expectPoint([circle.cx, circle.cy], [2.54, -2.54]);
    expect(circle.radius).toBeCloseTo(1.27, 4);
    // Sweep flag 1 runs clockwise on screen: Altium stores it CCW from end to start.
    expectPoint([arc.cx, arc.cy], [2.54, 0]);
    expect(arc.radius).toBeCloseTo(2.54, 4);
    expect(arc.startAngle).toBeCloseTo(0, 6);
    expect(arc.endAngle).toBeCloseTo(180, 6);
  });

  it("keeps counter-clockwise SVG arcs in their own direction and treats zero radii as lines", () => {
    const { arcs, tracks } = primitivesOf(exportLibrary({}, [
      "ARC~1~3~~M 100 200 A 10 10 0 0 0 120 200~~arc-1~false",
      "ARC~1~13~~M 100 210 A 10 10 0 0 1 110 200~~arc-2~false",
      "ARC~1~4~~M 100 200 A 0 0 0 0 1 110 200~~arc-3~false"
    ]).streams);
    // Counter-clockwise on screen stays start-to-end; 180 -> 0 wraps through 270.
    expect(arcs[0].startAngle).toBeCloseTo(180, 6);
    expect(Object.is(arcs[0].endAngle, 0)).toBe(true);
    // Quarter arc from (0,-2.54) clockwise on screen to (2.54,0), centre (2.54,-2.54).
    expect(arcs[1].layer).toBe(69);
    expectPoint([arcs[1].cx, arcs[1].cy], [2.54, -2.54]);
    expect(arcs[1].startAngle).toBeCloseTo(90, 6);
    expect(arcs[1].endAngle).toBeCloseTo(180, 6);
    expect(tracks).toEqual([expect.objectContaining({ layer: 34, x1: 0, y1: 0 })]);
    expect(tracks[0].x2).toBeCloseTo(2.54, 4);
  });

  it("writes stroke text with a WideStrings entry and moves name text to fabrication", () => {
    const { streams } = exportLibrary();
    const { texts } = primitivesOf(streams);
    expect(texts).toHaveLength(1);
    const [text] = texts;
    expect(text).toMatchObject({ layer: 69, font: 1, rotation: 270, mirror: 0, text: "REF**", length: 252 });
    expect(text.wideStringIndex).toBe(0);
    expect(text.v7).toBe(0x0102000d);
    expect(text.height).toBeCloseTo(1.016, 4);
    // The KiCad anchor (1.27, -1.27) is the left-middle; Altium's is bottom-left.
    expectPoint([text.x, text.y], [0.762, -1.27]);
    expect(readProperties(streams.get("QFN-16_Example/WideStrings")).text).toBe("|ENCODEDTEXT0=82,69,70,42,42");
  });

  it("mirrors bottom-side text, skips hidden text and encodes non-ANSI text as UTF-16", () => {
    const { streams } = exportLibrary({}, [
      "TEXT~P~105~205~0.5~0~~4~~6~BOTTOM~~show~text-1~false",
      "TEXT~L~105~215~0.5~0~~3~~6~HIDDEN~~hide~text-2~false",
      "TEXT~L~105~225~0.5~90~~99~~6~Ω1😀~~show~text-3~false"
    ]);
    const { texts } = primitivesOf(streams);
    expect(texts.map((text) => [text.layer, text.mirror, text.text])).toEqual([
      [34, 1, "BOTTOM"],
      [69, 0, "?1??"]
    ]);
    expect(texts[1].wideStringIndex).toBe(1);
    // ENCODEDTEXT lists UTF-16 code units, so astral characters keep both surrogates.
    expect(readProperties(streams.get("QFN-16_Example/WideStrings")).map.ENCODEDTEXT1).toBe("937,49,55357,56832");
  });

  it("maps slotted, rotated, bottom and non-plated pads like the KiCad emitter", () => {
    const { pads } = primitivesOf(exportLibrary({}, [
      "PAD~ELLIPSE~130~200~8~8~2~~2~0~~0~pad-2~0~~true~false",
      "PAD~OVAL~150~200~12~6~11~~3~2~~405~pad-3~0~~Y~false",
      "PAD~RECT~170~200~10~20~11~~4~2.5~~0~pad-4~12~~N~false",
      "PAD~OVAL~190~200~20~10~11~~5~2~~90~pad-5~14~~Y~false",
      "PAD~RECT~210~200~10~10~1~~6~1~~0~pad-6~0~~~false"
    ]).streams);
    const [bottom, oval, npthSlot, slot, legacyPlated] = pads;

    expect(bottom).toMatchObject({ designator: "2", layer: 32, shape: 1, plated: 1, v7Layer: 0x0100ffff });
    expectPoint([bottom.sizeX, bottom.sizeY], [2.032, 2.032]);

    expect(oval).toMatchObject({ layer: 74, shape: 1, rotation: 45, plated: 1, sizeAndShapeLength: 0 });
    expectPoint([oval.sizeX, oval.sizeY], [3.048, 1.524]);
    expect(oval.hole).toBeCloseTo(1.016, 4);

    // A taller pad slots along local Y: KiCad (drill oval 1.27 3.048).
    expect(npthSlot).toMatchObject({ designator: "", plated: 0, holeShape: 2, slotRotation: 90 });
    expect(npthSlot.sizeAndShapeLength).toBe(651);
    expectPoint([npthSlot.hole, npthSlot.slotLength], [1.27, 3.048]);

    // A wider pad slots along local X: KiCad (drill oval 3.556 1.016).
    expect(slot).toMatchObject({ designator: "5", plated: 1, rotation: 90, holeShape: 2, slotRotation: 0 });
    expectPoint([slot.hole, slot.slotLength], [1.016, 3.556]);

    // Omitted plating keeps the KiCad emitter's plated default; drilled pads become multi-layer.
    expect(legacyPlated).toMatchObject({ designator: "6", layer: 74, plated: 1 });
  });

  it("uses Mechanical layers for outline, document and unknown EasyEDA layers", () => {
    const { tracks } = primitivesOf(exportLibrary({}, [
      "TRACK~1~10~~100 200 110 200~t1~false",
      "TRACK~1~12~~100 200 110 200~t2~false",
      "TRACK~1~14~~100 200 110 200~t3~false",
      "TRACK~1~15~~100 200 110 200~t4~false",
      "TRACK~1~101~~100 200 110 200~t5~false",
      "TRACK~1~42~~100 200 110 200~t6~false",
      "TRACK~1~2~~100 200 110 200~t7~false",
      "TRACK~1~8~~100 200 110 200~t8~false"
    ]).streams);
    expect(tracks.map((track) => track.layer)).toEqual([57, 68, 70, 71, 69, 69, 32, 38]);
    expect(tracks.map((track) => track.v7)).toEqual([
      0x01020001, 0x0102000c, 0x0102000e, 0x0102000f, 0x0102000d, 0x0102000d, 0x0100ffff, 0x0103000b
    ]);
  });

  it("stores long or illegal footprint names through SectionKeys", () => {
    const longName = "CONN-SMD_USB-C-16P-WITH-A-VERY-LONG:NAME!";
    const { streams } = exportLibrary({ footprintName: longName });
    const key = "CONN-SMD_USB-C-16P-WITH-A-VERY-";
    expect(key).toHaveLength(31);
    expect(streams.has(`${key}/Data`)).toBe(true);
    const sectionKeys = streams.get("SectionKeys");
    expect(u32(sectionKeys)).toBe(1);
    const name = readStringBlock(sectionKeys, 4);
    const storage = readStringBlock(sectionKeys, name.end);
    expect([name.value, storage.value, storage.end]).toEqual([longName, key, sectionKeys.length]);
    expect(readProperties(streams.get(`${key}/Parameters`)).map.PATTERN).toBe(longName);
    expect(primitivesOf(streams, key).name).toBe(longName);

    const reserved = exportLibrary({ footprintName: "library" }).streams;
    expect(reserved.has("library_/Data")).toBe(true);
    expect(readStringBlock(reserved.get("SectionKeys"), 4).value).toBe("library");
  });

  it("omits SectionKeys when the name is a valid storage name and sanitizes 8-bit names", () => {
    const plain = exportLibrary({ footprintName: "SOT-23-3" }).streams;
    expect(plain.has("SectionKeys")).toBe(false);
    expect(plain.has("SOT-23-3/Data")).toBe(true);

    const unicode = exportLibrary({ footprintName: "  Ω|PKG µ  " }).streams;
    expect(readProperties(unicode.get("__PKG µ/Parameters")).map.PATTERN).toBe("__PKG µ");
    expect(() => exportAltiumPcbLib(footprintFrom(), { footprintName: "  " })).toThrow(/footprintName/);
  });

  it("is deterministic and keeps per-pad GUIDs distinct", () => {
    const first = exportLibrary().bytes;
    const second = exportLibrary().bytes;
    expect([...first]).toEqual([...second]);
    const { records } = primitivesOf(readCompoundFile(first).streams);
    const pads = records.filter((record) => record.type === 2).map((record) => record.subs[4]);
    const guidA = pads.map((main) => [...main.subarray(126, 142)].join(","));
    const guidB = pads.map((main) => [...main.subarray(142, 158)].join(","));
    expect(new Set(guidA).size).toBe(pads.length);
    expect(new Set(guidB).size).toBe(1);
  });

  it("writes an empty WideStrings table and no unique ids for footprints without text or pads", () => {
    const { streams } = exportLibrary({}, ["TRACK~1~3~~100 200 110 200~t1~false"]);
    expect([...streams.get("QFN-16_Example/WideStrings")]).toEqual([1, 0, 0, 0, 0]);
    expect(streams.has("QFN-16_Example/UniqueIDPrimitiveInformation/Data")).toBe(false);
    expect(readProperties(streams.get("Library/ComponentParamsTOC/Data")).map["Pad Count"]).toBe("0");
  });

  it("rejects arc paths the KiCad emitter also rejects", () => {
    expect(() => exportLibrary({}, ["ARC~1~3~~L 100 200 120 200~~arc-1~false"])).toThrow(/Unsupported footprint arc path/);
  });
});

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
