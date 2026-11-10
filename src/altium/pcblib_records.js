/*
 * Encodes the binary primitives of Altium "PCB 6.0 Binary Library File"
 * footprints: pads, vias, tracks, arcs, texts and regions, plus the shared
 * byte writer, Windows-1252 strings and deterministic identities used by the
 * library-level streams in pcblib_emitter.js. Record layouts follow genuine
 * Altium-written libraries; unknown bytes keep the values Altium writes.
 */

// Altium stores lengths as signed 32-bit integers of 1/10000 mil.
const UNITS_PER_MM = 10000 / 0.0254;

const LAYER = {
  TOP: 1,
  BOTTOM: 32,
  TOP_OVERLAY: 33,
  BOTTOM_OVERLAY: 34,
  TOP_PASTE: 35,
  BOTTOM_PASTE: 36,
  TOP_SOLDER: 37,
  BOTTOM_SOLDER: 38,
  MECHANICAL_1: 57,
  MULTI_LAYER: 74
};

const RECORD = { ARC: 1, PAD: 2, VIA: 3, TRACK: 4, TEXT: 5, REGION: 11 };
const PAD_SHAPE = { ROUND: 1, RECT: 2 };
const HOLE_SHAPE = { ROUND: 0, SLOT: 2 };

function mmToUnits(mm) {
  return Math.round(mm * UNITS_PER_MM);
}

function mechanicalLayer(number) {
  return LAYER.MECHANICAL_1 + number - 1;
}

// Records repeat the legacy layer byte as a V7 layer id: copper 0x0100xxxx,
// mechanical 0x0102xxxx and the remaining fixed layers 0x0103xxxx.
function v7LayerId(layer) {
  if (layer === LAYER.TOP) return 0x01000001;
  if (layer === LAYER.BOTTOM) return 0x0100ffff;
  if (layer >= LAYER.TOP_OVERLAY && layer <= LAYER.BOTTOM_SOLDER) {
    return 0x01030006 + (layer - LAYER.TOP_OVERLAY);
  }
  if (layer >= LAYER.MECHANICAL_1 && layer < LAYER.MECHANICAL_1 + 16) {
    return 0x01020001 + (layer - LAYER.MECHANICAL_1);
  }
  return 0x0103000f;
}

// Region properties name their layer with the V7_LAYER keyword spelling.
function v7LayerName(layer) {
  const names = {
    [LAYER.TOP]: "TOP",
    [LAYER.BOTTOM]: "BOTTOM",
    [LAYER.TOP_OVERLAY]: "TOPOVERLAY",
    [LAYER.BOTTOM_OVERLAY]: "BOTTOMOVERLAY",
    [LAYER.TOP_PASTE]: "TOPPASTE",
    [LAYER.BOTTOM_PASTE]: "BOTTOMPASTE",
    [LAYER.TOP_SOLDER]: "TOPSOLDER",
    [LAYER.BOTTOM_SOLDER]: "BOTTOMSOLDER",
    [LAYER.MULTI_LAYER]: "MULTILAYER"
  };
  if (names[layer]) return names[layer];
  return `MECHANICAL${layer - LAYER.MECHANICAL_1 + 1}`;
}

class ByteWriter {
  constructor() {
    this.bytes = new Uint8Array(1024);
    this.length = 0;
  }

  reserve(count) {
    if (this.length + count <= this.bytes.length) return;
    let size = this.bytes.length * 2;
    while (size < this.length + count) size *= 2;
    const grown = new Uint8Array(size);
    grown.set(this.bytes.subarray(0, this.length));
    this.bytes = grown;
  }

  view(count) {
    this.reserve(count);
    const view = new DataView(this.bytes.buffer, this.length, count);
    this.length += count;
    return view;
  }

  u8(value) {
    this.view(1).setUint8(0, value);
  }

  u32(value) {
    this.view(4).setUint32(0, value >>> 0, true);
  }

  f64(value) {
    this.view(8).setFloat64(0, value, true);
  }

  raw(bytes) {
    this.reserve(bytes.length);
    this.bytes.set(bytes, this.length);
    this.length += bytes.length;
  }

  // Altium subrecords and blocks carry a little-endian u32 byte length prefix.
  block(write) {
    const start = this.length;
    this.u32(0);
    write(this);
    new DataView(this.bytes.buffer).setUint32(start, this.length - start - 4, true);
  }

  toBytes() {
    return this.bytes.slice(0, this.length);
  }
}

// Altium's 8-bit strings use the Windows code page; characters outside
// Latin-1 cannot round-trip there and become "?".
function encodeAnsi(text) {
  const value = String(text ?? "");
  const bytes = new Uint8Array(value.length);
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    bytes[i] = code <= 0xff ? code : 0x3f;
  }
  return bytes;
}

function writePascalShort(writer, text) {
  const bytes = encodeAnsi(text).subarray(0, 255);
  writer.u8(bytes.length);
  writer.raw(bytes);
}

// String block: u32 size, then a length-prefixed short string.
function writeStringBlock(writer, text) {
  writer.block((w) => writePascalShort(w, text));
}

// Property block: u32 size, then "|KEY=VALUE..." text with a NUL terminator.
function writePropertyBlock(writer, text) {
  writer.block((w) => {
    w.raw(encodeAnsi(text));
    w.u8(0);
  });
}

function propertyStream(text) {
  const writer = new ByteWriter();
  writePropertyBlock(writer, text);
  return writer.toBytes();
}

function u32Stream(value) {
  const writer = new ByteWriter();
  writer.u32(value);
  return writer.toBytes();
}

function hexBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function utf16Hex(text) {
  return [...text].map((char) => char.charCodeAt(0).toString(16).padStart(2, "0") + "00").join("");
}

// Templates hold the constant non-zero runs of genuine records; geometry,
// layers and identities are patched over them per primitive.
function fromTemplate(size, runs) {
  const bytes = new Uint8Array(size);
  for (const [offset, hex] of runs) bytes.set(hexBytes(hex), offset);
  return { bytes, view: new DataView(bytes.buffer) };
}

// Bytes 1-12 of every primitive: flags (unlocked), no net, polygon or component.
const COMMON_HEADER = `0c00${"ff".repeat(10)}`;

// Deterministic identity source (mulberry32 seeded by FNV-1a) so a given
// footprint always produces identical bytes while each primitive gets its own GUID.
function createIdentitySource(seedText) {
  let state = 0x811c9dc5;
  for (const char of String(seedText)) {
    state = Math.imul(state ^ char.charCodeAt(0), 0x01000193) >>> 0;
  }
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0);
  };
  return {
    guid() {
      const bytes = new Uint8Array(16);
      for (let i = 0; i < 16; i += 1) bytes[i] = next() & 0xff;
      bytes[7] = (bytes[7] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      return bytes;
    },
    // Altium unique ids are eight upper-case letters.
    uniqueId() {
      let id = "";
      for (let i = 0; i < 8; i += 1) id += String.fromCharCode(65 + (next() % 26));
      return id;
    }
  };
}

function formatGuid(bytes) {
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0").toUpperCase());
  const le = (from, to) => hex.slice(from, to).reverse().join("");
  return `{${le(0, 4)}-${le(4, 6)}-${le(6, 8)}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}}`;
}

// Pad subrecord 5 (202 bytes, current Altium format). Offsets: 0 layer,
// 13 position, 21/29/37 top/mid/bottom size, 45 hole, 49 shapes, 52 rotation,
// 60 plated, 101/102 paste/solder expansion mode (1 = rule), 114 V7 layer,
// 126 per-pad GUID, 142 per-footprint GUID, 185 marker (3 SMD, 1 through-hole).
const PAD_TEMPLATE = [
  [0, `4a${COMMON_HEADER}`],
  [68, "a08601000400a0860100400d0300400d03"],
  [90, "409c"],
  [101, "0101"],
  [121, "409c"],
  [162, "ffffff7fffffff7f00011a"],
  [184, "01"]
];

function writePadRecord(writer, pad) {
  const { bytes, view } = fromTemplate(202, PAD_TEMPLATE);
  const x = mmToUnits(pad.x);
  const y = mmToUnits(pad.y);
  const sizeX = mmToUnits(pad.sizeX);
  const sizeY = mmToUnits(pad.sizeY);
  bytes[0] = pad.layer;
  view.setInt32(13, x, true);
  view.setInt32(17, y, true);
  for (const offset of [21, 29, 37]) {
    view.setInt32(offset, sizeX, true);
    view.setInt32(offset + 4, sizeY, true);
  }
  view.setInt32(45, mmToUnits(pad.holeSize), true);
  bytes.fill(pad.shape, 49, 52);
  view.setFloat64(52, pad.rotation, true);
  bytes[60] = pad.plated ? 1 : 0;
  view.setUint32(114, v7LayerId(pad.layer), true);
  bytes.set(pad.guid, 126);
  bytes.set(pad.footprintGuid, 142);
  bytes[185] = pad.holeSize > 0 ? 0x01 : 0x03;

  writer.u8(RECORD.PAD);
  writer.block((w) => writePascalShort(w, pad.designator));
  writer.block((w) => w.u8(0));
  writer.block((w) => writePascalShort(w, "|&|0"));
  writer.block((w) => w.u8(0));
  writer.block((w) => w.raw(bytes));
  writer.block((w) => {
    if (pad.slotLength > 0) w.raw(padSizeAndShape(pad, sizeX, sizeY));
  });
}

// Pad subrecord 6 (651 bytes) is only written when the padstack needs it,
// here for slotted holes: 29 inner-layer sizes and shapes, hole shape, slot
// length and rotation, 32 hole offsets, 32 alternate shapes, 32 corner radii,
// then a trailer repeating the top shape and size.
function padSizeAndShape(pad, sizeX, sizeY) {
  const writer = new ByteWriter();
  for (let i = 0; i < 29; i += 1) writer.u32(sizeX);
  for (let i = 0; i < 29; i += 1) writer.u32(sizeY);
  for (let i = 0; i < 29; i += 1) writer.u8(pad.shape);
  writer.u8(0);
  writer.u8(HOLE_SHAPE.SLOT);
  writer.u32(mmToUnits(pad.slotLength));
  writer.f64(pad.slotRotation);
  writer.raw(new Uint8Array(257));
  for (let i = 0; i < 32; i += 1) writer.u8(1);
  writer.raw(new Uint8Array(64));
  writer.raw(hexBytes("010000000f00000004008001"));
  writer.u8(pad.shape);
  writer.u32(sizeX);
  writer.u32(sizeY);
  writer.raw(hexBytes("3200"));
  return writer.toBytes();
}

// Via subrecord (321 bytes): 13 position, 21 diameter, 25 hole, 29/30
// start/end layer, 75 per-layer diameters (32), 259/275 per-via and
// per-footprint GUIDs. Thermal and mask settings keep Altium's rule defaults.
const VIA_TEMPLATE = [
  [0, `4a${COMMON_HEADER}`],
  [29, "012000a08601000400a0860100400d0300400d03"],
  [54, "409c"],
  [66, "01"],
  [203, "0f000301"],
  [242, "409c"],
  [254, "2a"],
  [291, "ffffff7fffffff7f"],
  [304, "1e"],
  [308, "09"],
  [320, "01"]
];

function writeViaRecord(writer, via) {
  const { bytes, view } = fromTemplate(321, VIA_TEMPLATE);
  const diameter = mmToUnits(via.diameter);
  view.setInt32(13, mmToUnits(via.x), true);
  view.setInt32(17, mmToUnits(via.y), true);
  view.setInt32(21, diameter, true);
  view.setInt32(25, mmToUnits(via.holeSize), true);
  for (let i = 0; i < 32; i += 1) view.setInt32(75 + i * 4, diameter, true);
  bytes.set(via.guid, 259);
  bytes.set(via.footprintGuid, 275);
  writer.u8(RECORD.VIA);
  writer.block((w) => w.raw(bytes));
}

// Track subrecord (49 bytes): 13 start, 21 end, 29 width, 41 V7 layer.
function writeTrackRecord(writer, track) {
  const { bytes, view } = fromTemplate(49, [[0, `01${COMMON_HEADER}`]]);
  bytes[0] = track.layer;
  view.setInt32(13, mmToUnits(track.x1), true);
  view.setInt32(17, mmToUnits(track.y1), true);
  view.setInt32(21, mmToUnits(track.x2), true);
  view.setInt32(25, mmToUnits(track.y2), true);
  view.setInt32(29, mmToUnits(track.width), true);
  view.setUint32(41, v7LayerId(track.layer), true);
  writer.u8(RECORD.TRACK);
  writer.block((w) => w.raw(bytes));
}

// Arc subrecord (60 bytes): 13 center, 21 radius, 25/33 start/end angle in
// degrees (counter-clockwise, Y up), 41 width, 52 V7 layer.
function writeArcRecord(writer, arc) {
  const { bytes, view } = fromTemplate(60, [[0, `01${COMMON_HEADER}`]]);
  bytes[0] = arc.layer;
  view.setInt32(13, mmToUnits(arc.cx), true);
  view.setInt32(17, mmToUnits(arc.cy), true);
  view.setInt32(21, mmToUnits(arc.radius), true);
  view.setFloat64(25, arc.startAngle, true);
  view.setFloat64(33, arc.endAngle, true);
  view.setInt32(41, mmToUnits(arc.width), true);
  view.setUint32(52, v7LayerId(arc.layer), true);
  writer.u8(RECORD.ARC);
  writer.block((w) => w.raw(bytes));
}

// Text subrecord 1 (252 bytes): 13 bottom-left anchor, 21 height, 25 stroke
// font (1 = Default), 27 rotation, 35 mirror, 36 stroke width, 115 WideStrings
// index, 124/128 cached bounding size, 132 justification (3 = left bottom),
// 226 V7 layer, 244 anchor copy. Subrecord 2 holds the 8-bit text.
const TEXT_TEMPLATE = [
  [0, `21${COMMON_HEADER}`],
  [25, "01"],
  [46, utf16Hex("Arial")],
  [132, "03"],
  [137, "a037a000200b2000400d0300400d03"],
  [158, `010100${utf16Hex("Arial")}`],
  [225, "01"],
  [235, "80"],
  [239, "80"]
];

function writeTextRecord(writer, text) {
  const { bytes, view } = fromTemplate(252, TEXT_TEMPLATE);
  const x = mmToUnits(text.x);
  const y = mmToUnits(text.y);
  bytes[0] = text.layer;
  view.setInt32(13, x, true);
  view.setInt32(17, y, true);
  view.setInt32(21, mmToUnits(text.height), true);
  view.setFloat64(27, text.rotation, true);
  bytes[35] = text.mirror ? 1 : 0;
  view.setInt32(36, mmToUnits(text.strokeWidth), true);
  view.setUint32(115, text.wideStringIndex, true);
  // Altium refreshes this cached extent on load; approximate the Default font.
  view.setInt32(124, mmToUnits(text.height * 0.95 * Math.max(text.text.length, 1)), true);
  view.setInt32(128, mmToUnits(text.height * 1.2), true);
  view.setUint32(226, v7LayerId(text.layer), true);
  view.setInt32(244, x, true);
  view.setInt32(248, y, true);
  writer.u8(RECORD.TEXT);
  writer.block((w) => w.raw(bytes));
  writer.block((w) => writePascalShort(w, text.text));
}

// Region subrecord: 22-byte header (holes count at 14), a property block,
// then the outline vertex count and (x, y) doubles in internal units. The
// outline is implicitly closed, matching Altium-written regions.
function writeRegionRecord(writer, region) {
  writer.u8(RECORD.REGION);
  writer.block((w) => {
    const header = fromTemplate(18, [[0, `00${COMMON_HEADER}`]]).bytes;
    header[0] = region.layer;
    w.raw(header);
    writePropertyBlock(
      w,
      `V7_LAYER=${v7LayerName(region.layer)}|NAME= |KIND=0|SUBPOLYINDEX=-1|UNIONINDEX=0|` +
        "ARCRESOLUTION=0.5mil|ISSHAPEBASED=FALSE|CAVITYHEIGHT=0mil"
    );
    w.u32(region.points.length);
    for (const [x, y] of region.points) {
      w.f64(x * UNITS_PER_MM);
      w.f64(y * UNITS_PER_MM);
    }
  });
}

export {
  ByteWriter,
  LAYER,
  PAD_SHAPE,
  createIdentitySource,
  encodeAnsi,
  formatGuid,
  mechanicalLayer,
  mmToUnits,
  propertyStream,
  u32Stream,
  writeArcRecord,
  writePadRecord,
  writeRegionRecord,
  writeStringBlock,
  writeTextRecord,
  writeTrackRecord,
  writeViaRecord
};

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
