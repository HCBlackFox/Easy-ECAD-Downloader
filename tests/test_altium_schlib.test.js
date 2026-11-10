/*
 * These tests cover the Altium .SchLib emitter for EasyEDA symbols: library
 * header and storages, component, binary pin and graphic records, fields and
 * parameters, footprint implementation links, SectionKeys naming, PinFrac
 * fractions and non-ASCII text. Streams are decoded with the test-only CFB
 * reader and Altium's length-prefixed record framing.
 */

import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import { exportAltiumSchLib } from "../src/altium/schlib_emitter.js";
import { parseEasyedaSymbol } from "../src/kicad/easyeda_symbol_parser.js";
import { convertSymbolToKiCad } from "../src/kicad/kicad_symbol_emitter.js";
import { readCompoundFile } from "./helpers/compound_file_reader.js";
import { createCadData } from "./helpers/fixtures.js";

const MM = 0.254;
const latin1 = (bytes) => String.fromCharCode(...bytes);

// Splitting on '|' is safe for UTF-8 values: multi-byte sequences never
// contain bytes below 0x80. Keys are upper-cased as Altium readers do.
function parseProps(body) {
  expect(body.at(-1)).toBe(0);
  const props = {};
  let start = 0;
  for (let index = 0; index <= body.length - 1; index += 1) {
    if (body[index] !== 0x7c && index !== body.length - 1) {
      continue;
    }
    const segment = body.subarray(start, index);
    start = index + 1;
    const equals = segment.indexOf(0x3d);
    if (equals < 0) {
      continue;
    }
    const key = latin1(segment.subarray(0, equals)).toUpperCase();
    const value = segment.subarray(equals + 1);
    props[key] = key.startsWith("%UTF8%") ? new TextDecoder().decode(value) : latin1(value);
  }
  return props;
}

function readRecords(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const records = [];
  let offset = 0;
  while (offset < bytes.length) {
    const header = view.getUint32(offset, true);
    const body = bytes.subarray(offset + 4, offset + 4 + (header & 0xffffff));
    offset += 4 + (header & 0xffffff);
    records.push(header >>> 24 === 1
      ? { binary: true, body }
      : { binary: false, body, props: parseProps(body) });
  }
  expect(offset).toBe(bytes.length);
  return records;
}

// Mirrors the binary pin layout read by KiCad's Altium library importer.
function decodePin(body) {
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  let offset = 0;
  const u8 = () => body[offset++];
  const i16 = () => (offset += 2, view.getInt16(offset - 2, true));
  const i32 = () => (offset += 4, view.getInt32(offset - 4, true));
  const text = () => {
    const length = u8();
    offset += length;
    return latin1(body.subarray(offset - length, offset));
  };
  const pin = { record: i32(), unknown: u8(), ownerPartId: i16(), displayMode: u8() };
  Object.assign(pin, { innerEdge: u8(), outerEdge: u8(), inner: u8(), outer: u8() });
  Object.assign(pin, { description: text(), formalType: u8(), electrical: u8(), flags: u8() });
  Object.assign(pin, { length: i16(), x: i16(), y: i16(), color: i32() });
  Object.assign(pin, { name: text(), designator: text(), swapGroup: text(), partSeq: text() });
  Object.assign(pin, { defaultValue: text(), orientation: pin.flags & 3, remaining: body.length - offset });
  return pin;
}

function readLibrary(bytes) {
  const { streams } = readCompoundFile(bytes);
  const fileHeader = readRecords(streams.get("FileHeader"))[0].props;
  const dataPath = [...streams.keys()].find((path) => path.endsWith("/Data"));
  const records = readRecords(streams.get(dataPath));
  return {
    streams,
    fileHeader,
    storage: dataPath.slice(0, -"/Data".length),
    records,
    textRecords: records.filter((record) => !record.binary).map((record) => record.props),
    pins: records.filter((record) => record.binary).map((record) => decodePin(record.body))
  };
}

function fixtureSymbol() {
  return convertSymbolToKiCad(parseEasyedaSymbol(createCadData()));
}

function model(overrides = {}) {
  return {
    info: { name: "Part", prefix: "U" },
    pins: [],
    rectangles: [],
    circles: [],
    arcs: [],
    polygons: [],
    ...overrides
  };
}

const recordsOf = (library, id) => library.textRecords.filter((props) => props.RECORD === String(id));

describe("Altium SchLib emitter", () => {
  it("writes the library header, icon storage and component storage", () => {
    const bytes = exportAltiumSchLib(fixtureSymbol(), {
      libReference: "Logic Buffer",
      description: "Demo Logic Part"
    });
    const library = readLibrary(bytes);

    expect([...library.streams.keys()].sort()).toEqual(["FileHeader", "Logic Buffer/Data", "Storage"]);
    expect(library.fileHeader).toMatchObject({
      HEADER: "Protel for Windows - Schematic Library Editor Binary File Version 5.0",
      WEIGHT: String(library.records.length + 1),
      FONTIDCOUNT: "1",
      SIZE1: "10",
      FONTNAME1: "Times New Roman",
      COMPCOUNT: "1",
      LIBREF0: "Logic Buffer",
      COMPDESCR0: "Demo Logic Part",
      PARTCOUNT0: "2"
    });
    expect(library.fileHeader.UNIQUEID).toMatch(/^[A-Z]{8}$/);
    expect(latin1(library.streams.get("Storage"))).toBe("\x15\0\0\0|HEADER=Icon storage\0");
  });

  it("starts the data stream with the component record", () => {
    const library = readLibrary(exportAltiumSchLib(fixtureSymbol(), {
      libReference: "Logic Buffer",
      description: "Demo Logic Part"
    }));

    expect(library.textRecords[0]).toMatchObject({
      RECORD: "1",
      LIBREFERENCE: "Logic Buffer",
      COMPONENTDESCRIPTION: "Demo Logic Part",
      PARTCOUNT: "2",
      DISPLAYMODECOUNT: "1",
      OWNERPARTID: "-1",
      CURRENTPARTID: "1",
      DESIGNITEMID: "Logic Buffer",
      ALLPINCOUNT: "1"
    });
    expect(library.records[0].binary).toBe(false);
  });

  it("encodes the createCadData pin as a binary record located at the body end", () => {
    const symbol = fixtureSymbol();
    const [pin] = readLibrary(exportAltiumSchLib(symbol, { libReference: "Logic Buffer" })).pins;

    expect(pin).toMatchObject({
      record: 2,
      ownerPartId: 1,
      designator: "1",
      name: "C\\L\\K\\/R\\E\\S\\E\\T\\",
      electrical: 0,
      innerEdge: 3,
      outerEdge: 1,
      formalType: 1,
      orientation: 0,
      length: 10,
      x: 0,
      y: -10,
      partSeq: "|&|",
      remaining: 0
    });
    expect(pin.flags & 0x18).toBe(0x18);
    // Rightwards: the connection point lies one pin length to the right of
    // the body end, which is where the KiCad model places it.
    expect([(pin.x + pin.length) * MM, pin.y * MM]).toEqual([
      expect.closeTo(symbol.pins[0].posX, 9),
      expect.closeTo(symbol.pins[0].posY, 9)
    ]);
  });

  it("maps pin directions, electrical types and edge symbols", () => {
    const pinAt = (orientation, type, style, number) => ({
      name: `P${number}`, number: String(number), style, type, orientation, length: 2.54, posX: 5.08, posY: 2.54
    });
    const pins = [
      pinAt(0, "input", "line", 1),
      pinAt(90, "bidirectional", "inverted", 2),
      pinAt(180, "output", "clock", 3),
      pinAt(270, "power_in", "inverted_clock", 4),
      pinAt(0, "unspecified", "line", 5)
    ];
    const decoded = readLibrary(exportAltiumSchLib(model({ pins }), { libReference: "Pins" })).pins;

    expect(decoded.map((pin) => pin.orientation)).toEqual([2, 3, 0, 1, 2]);
    expect(decoded.map((pin) => [pin.x, pin.y])).toEqual([[30, 10], [20, 20], [10, 10], [20, 0], [30, 10]]);
    expect(decoded.map((pin) => pin.electrical)).toEqual([0, 1, 2, 7, 4]);
    expect(decoded.map((pin) => [pin.innerEdge, pin.outerEdge])).toEqual([[0, 0], [0, 1], [3, 0], [3, 1], [0, 0]]);
    expect(decoded.map((pin) => pin.designator)).toEqual(["1", "2", "3", "4", "5"]);
  });

  it("writes rectangles, circles, arcs, polylines and polygons as primitives of part 1", () => {
    const library = readLibrary(exportAltiumSchLib(fixtureSymbol(), { libReference: "Logic Buffer" }));
    const graphics = library.textRecords.slice(1, 7);

    expect(graphics.map((props) => props.RECORD)).toEqual(["14", "12", "12", "6", "7", "7"]);
    expect(graphics.map((props) => props.INDEXINSHEET)).toEqual([undefined, "1", "2", "3", "4", "5"]);
    for (const props of graphics) {
      expect(props).toMatchObject({ OWNERPARTID: "1", ISNOTACCESIBLE: "T", COLOR: "128" });
      expect(props.UNIQUEID).toMatch(/^[A-Z]{8}$/);
    }
    expect(graphics[0]).toMatchObject({
      "LOCATION.X": "20", "LOCATION.Y": "-25", "CORNER.X": "60", "CORNER.Y": "-5",
      ISSOLID: "T", AREACOLOR: "11599871"
    });
    // An unfilled circle is a full arc; Altium omits the zero start angle.
    expect(graphics[1]).toMatchObject({ "LOCATION.X": "40", "LOCATION.Y": "-15", RADIUS: "5", ENDANGLE: "360.000" });
    expect(graphics[1].STARTANGLE).toBeUndefined();
    expect(graphics[2]).toMatchObject({ STARTANGLE: "315.000", ENDANGLE: "135.000", RADIUS: "7", RADIUS_FRAC: "7107" });
    expect(graphics[3]).toMatchObject({ LOCATIONCOUNT: "3", X1: "20", Y1: "-5", X3: "60", Y3: "-25" });
    expect(graphics[3].ISSOLID).toBeUndefined();
    // Closed outlines drop the repeated first point and keep the body fill.
    expect(graphics[5]).toMatchObject({
      LOCATIONCOUNT: "3", X1: "20", Y1: "-5", X2: "30", Y2: "-15", X3: "20", Y3: "-25", ISSOLID: "T"
    });
  });

  it("draws filled circles as solid ellipses and open polygons as polylines", () => {
    const library = readLibrary(exportAltiumSchLib(model({
      circles: [{ posX: 2.54, posY: -1.27, radius: 0.762, background: true }],
      polygons: [{ points: [[0, 0], [2.54, 0], [2.54, 2.54]], isClosed: false }, { points: [[0, 0]], isClosed: false }]
    }), { libReference: "Shapes" }));

    expect(recordsOf(library, 8)).toEqual([expect.objectContaining({
      "LOCATION.X": "10", "LOCATION.Y": "-5", RADIUS: "3", SECONDARYRADIUS: "3", ISSOLID: "T"
    })]);
    expect(recordsOf(library, 6)).toEqual([expect.objectContaining({ LOCATIONCOUNT: "3", X2: "10", Y3: "10" })]);
    expect(recordsOf(library, 7)).toEqual([]);
  });

  it("derives arc centre, radius and counter-clockwise angles from three points", () => {
    const quarter = Math.SQRT1_2 * 2.54;
    const arcs = [
      { startX: 2.54, startY: 0, middleX: quarter, middleY: quarter, endX: 0, endY: 2.54 },
      { startX: 0, startY: 2.54, middleX: quarter, middleY: quarter, endX: 2.54, endY: 0 },
      { startX: 2.54, startY: 0, middleX: 0, middleY: -2.54, endX: 0, endY: 2.54 },
      { startX: 0, startY: 0, middleX: 1.27, middleY: 0, endX: 2.54, endY: 0 }
    ];
    const library = readLibrary(exportAltiumSchLib(model({ arcs }), { libReference: "Arcs" }));
    const angles = recordsOf(library, 12).map((props) => [props.STARTANGLE, props.ENDANGLE, props.RADIUS]);

    expect(angles).toEqual([
      [undefined, "90.000", "10"],
      [undefined, "90.000", "10"],
      ["90.000", "0.000", "10"]
    ]);
    expect(recordsOf(library, 12)[0]["LOCATION.X"]).toBeUndefined();
    // Collinear points have no circle and fall back to a straight segment.
    expect(recordsOf(library, 6)).toEqual([expect.objectContaining({ LOCATIONCOUNT: "2", X2: "10" })]);
  });

  it("adds the designator, comment and hidden part parameters", () => {
    const library = readLibrary(exportAltiumSchLib(fixtureSymbol(), { libReference: "Logic Buffer" }));
    const parameters = recordsOf(library, 41);

    expect(recordsOf(library, 34)).toEqual([expect.objectContaining({
      TEXT: "U?", NAME: "Designator", OWNERPARTID: "-1", FONTID: "1", READONLYSTATE: "1"
    })]);
    expect(parameters.map((props) => [props.NAME, props.TEXT, props.ISHIDDEN])).toEqual([
      ["Comment", "Logic / Buffer", undefined],
      ["Manufacturer", "ACME Semi", "T"],
      ["LCSC Part", "C12345", "T"],
      ["Package", "QFN-16/Example", "T"],
      ["Datasheet", "https://cdn.example.test/datasheets/demo-part.pdf", "T"]
    ]);
    // Field text sits above and below the drawing, which spans Y -25..5.
    expect(Number(recordsOf(library, 34)[0]["LOCATION.Y"])).toBeGreaterThan(5);
    expect(Number(parameters[0]["LOCATION.Y"])).toBeLessThan(-25);

    const bare = readLibrary(exportAltiumSchLib(model({ info: { name: "", prefix: "" } }), {
      libReference: "Bare"
    }));
    expect(recordsOf(bare, 34)[0].TEXT).toBe("U?");
    expect(recordsOf(bare, 41).map((props) => [props.NAME, props.TEXT])).toEqual([["Comment", "Bare"]]);
  });

  it("links a footprint through implementation records only when one is named", () => {
    const linked = readLibrary(exportAltiumSchLib(fixtureSymbol(), {
      libReference: "Logic Buffer",
      footprintName: "QFN-16_EP"
    }));
    const recordIds = linked.records.map((record) => (record.binary ? "pin" : record.props.RECORD));
    const listIndex = recordIds.indexOf("44");
    const implementationIndex = recordIds.indexOf("45");

    expect(recordIds.slice(listIndex)).toEqual(["44", "45", "46", "48"]);
    expect(linked.records[listIndex].props.OWNERINDEX).toBeUndefined();
    expect(linked.records[implementationIndex].props).toMatchObject({
      OWNERINDEX: String(listIndex),
      MODELNAME: "QFN-16_EP",
      MODELTYPE: "PCBLIB",
      DATAFILECOUNT: "1",
      MODELDATAFILEENTITY0: "QFN-16_EP",
      MODELDATAFILEKIND0: "PCBLib",
      ISCURRENT: "T"
    });
    for (const child of linked.records.slice(implementationIndex + 1)) {
      expect(child.props.OWNERINDEX).toBe(String(implementationIndex));
    }

    const unlinked = readLibrary(exportAltiumSchLib(fixtureSymbol(), { libReference: "Logic Buffer" }));
    expect(unlinked.records.at(-1).props).toEqual({ RECORD: "44" });
    expect(recordsOf(unlinked, 45)).toEqual([]);
  });

  it("maps long, reserved and non-ANSI library references through SectionKeys", () => {
    const longName = "ST MICROELECTRONICS STM32F103C8T6 LQFP48";
    const long = readLibrary(exportAltiumSchLib(fixtureSymbol(), { libReference: longName }));
    expect(long.storage).toBe(longName.slice(0, 31));
    expect(long.fileHeader.LIBREF0).toBe(longName);
    expect(readRecords(long.streams.get("SectionKeys"))[0].props).toEqual({
      KEYCOUNT: "1",
      LIBREF0: longName,
      SECTIONKEY0: longName.slice(0, 31)
    });

    const slash = readLibrary(exportAltiumSchLib(fixtureSymbol(), { libReference: "Logic / Buffer" }));
    expect(slash.storage).toBe("Logic _ Buffer");
    expect(readRecords(slash.streams.get("SectionKeys"))[0].props.SECTIONKEY0).toBe("Logic _ Buffer");

    const reserved = readLibrary(exportAltiumSchLib(model(), { libReference: "Storage" }));
    expect(reserved.storage).toBe("Storage_");
    expect(reserved.streams.has("SectionKeys")).toBe(true);

    const unicode = readLibrary(exportAltiumSchLib(model(), { libReference: "电阻 10k" }));
    expect(unicode.storage).toBe("__ 10k");
    expect(readRecords(unicode.streams.get("SectionKeys"))[0].props).toMatchObject({
      "%UTF8%LIBREF0": "电阻 10k",
      LIBREF0: "?? 10k",
      SECTIONKEY0: "__ 10k"
    });

    const plain = readLibrary(exportAltiumSchLib(fixtureSymbol(), { libReference: "Logic Buffer" }));
    expect(plain.streams.has("SectionKeys")).toBe(false);
  });

  it("keeps sub-unit coordinates in _Frac fields and the PinFrac stream", () => {
    const pins = [
      { name: "A", number: "1", style: "line", type: "input", orientation: 0, length: 2.54, posX: -5.207, posY: 0 },
      { name: "B", number: "2", style: "line", type: "input", orientation: 180, length: 2.54, posX: 5.08, posY: 0 }
    ];
    const polygons = [{ points: [[-0.381, 0.0635], [2.54, 0]], isClosed: false }];
    const library = readLibrary(exportAltiumSchLib(model({ pins, polygons }), { libReference: "Fractions" }));

    expect(recordsOf(library, 6)[0]).toMatchObject({ X1: "-1", X1_FRAC: "-50000", Y1_FRAC: "25000" });
    expect(recordsOf(library, 6)[0].Y1).toBeUndefined();
    expect(library.pins.map((pin) => [pin.x, pin.y, pin.length])).toEqual([[-10, 0, 10], [10, 0, 10]]);

    const pinFrac = readRecords(library.streams.get("Fractions/PinFrac"));
    expect(pinFrac[0].props).toEqual({ HEADER: "PinFrac", WEIGHT: "1" });
    expect(pinFrac).toHaveLength(2);
    const entry = pinFrac[1].body;
    expect(pinFrac[1].binary).toBe(true);
    expect([entry[0], entry[1], entry[2]]).toEqual([0xd0, 1, "0".charCodeAt(0)]);
    const compressedLength = new DataView(entry.buffer, entry.byteOffset).getInt32(3, true);
    expect(entry.length).toBe(7 + compressedLength);
    const values = new Int32Array(new Uint8Array(inflateSync(entry.subarray(7))).buffer);
    // Body end: -5.207 mm + 2.54 mm = -2.667 mm = -10.5 units.
    expect([...values]).toEqual([-50000, 0, 0]);

    const whole = readLibrary(exportAltiumSchLib(fixtureSymbol(), { libReference: "Logic Buffer" }));
    expect(whole.streams.has("Logic Buffer/PinFrac")).toBe(false);
  });

  it("writes non-ASCII text as %UTF8% values with a Windows-1252 copy", () => {
    const symbol = model({
      info: { name: "电阻 ±5% | 0402", prefix: "R", manufacturer: "Ωmega – Corp" },
      pins: [{ name: "Ω1", number: "1", style: "line", type: "input", orientation: 0, length: 2.54, posX: 0, posY: 0 }]
    });
    const library = readLibrary(exportAltiumSchLib(symbol, { libReference: "R0402" }));
    const [comment, manufacturer] = recordsOf(library, 41);
    const commentBytes = [...library.records.find((record) => record.props?.NAME === "Comment").body];

    expect(comment["%UTF8%TEXT"]).toBe("电阻 ±5% ¦ 0402");
    expect(comment.TEXT).toBe("?? ±5% ¦ 0402");
    expect(commentBytes).toContain(0xb1);
    expect(manufacturer).toMatchObject({ "%UTF8%TEXT": "Ωmega – Corp", TEXT: "?mega \x96 Corp" });
    expect(library.pins[0].name).toBe("?1");
    expect(library.textRecords[0]["%UTF8%LIBREFERENCE"]).toBeUndefined();
  });

  it("produces identical bytes for repeated exports", () => {
    const options = { libReference: "Logic Buffer", footprintName: "QFN-16_EP" };
    expect([...exportAltiumSchLib(fixtureSymbol(), options)]).toEqual([
      ...exportAltiumSchLib(fixtureSymbol(), options)
    ]);
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
