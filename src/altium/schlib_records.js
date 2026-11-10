/*
 * Encodes the low-level building blocks of Altium schematic-library streams:
 * length-prefixed property and binary records, 10-mil coordinates with their
 * fractional parts, ANSI/UTF-8 text values, and zlib-wrapped binary payloads.
 * schlib_emitter.js maps the normalized symbol model onto these records.
 */

const MM_PER_UNIT = 0.254;
const FRACTION_SCALE = 100000;
const RECORD_TEXT = 0;
const RECORD_BINARY = 1;

const utf8Encoder = new TextEncoder();

// Windows-1252 assigns printable characters to 0x80-0x9F; Latin-1 code points
// 0xA0-0xFF map to the same byte values.
const CP1252_EXTRAS = new Map([
  [0x20ac, 0x80], [0x201a, 0x82], [0x0192, 0x83], [0x201e, 0x84], [0x2026, 0x85],
  [0x2020, 0x86], [0x2021, 0x87], [0x02c6, 0x88], [0x2030, 0x89], [0x0160, 0x8a],
  [0x2039, 0x8b], [0x0152, 0x8c], [0x017d, 0x8e], [0x2018, 0x91], [0x2019, 0x92],
  [0x201c, 0x93], [0x201d, 0x94], [0x2022, 0x95], [0x2013, 0x96], [0x2014, 0x97],
  [0x02dc, 0x98], [0x2122, 0x99], [0x0161, 0x9a], [0x203a, 0x9b], [0x0153, 0x9c],
  [0x017e, 0x9e], [0x0178, 0x9f]
]);

function concatBytes(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function isAscii(text) {
  return /^[\x20-\x7e]*$/.test(text);
}

function isAnsiChar(char) {
  const code = char.codePointAt(0);
  return (code >= 0x20 && code < 0x7f) || (code >= 0xa0 && code <= 0xff) || CP1252_EXTRAS.has(code);
}

// Characters outside Windows-1252 become '?', so the ANSI copy of a value
// never carries partial multi-byte sequences.
function encodeAnsi(text) {
  const bytes = [];
  for (const char of String(text)) {
    const code = char.codePointAt(0);
    if (code < 0x80 || (code >= 0xa0 && code <= 0xff)) {
      bytes.push(code);
    } else {
      bytes.push(CP1252_EXTRAS.get(code) ?? 0x3f);
    }
  }
  return Uint8Array.from(bytes);
}

function asciiBytes(text) {
  return Uint8Array.from(text, (char) => char.charCodeAt(0));
}

function isControlChar(char) {
  const code = char.charCodeAt(0);
  return code < 0x20 || code === 0x7f;
}

function replaceControlChars(text, replacement = " ") {
  return Array.from(String(text ?? ""), (char) => (isControlChar(char) ? replacement : char)).join("");
}

// '|' separates properties and NUL ends a record, so neither may appear in a
// value; Altium itself substitutes the broken bar for a literal bar.
function sanitizeValue(value) {
  return replaceControlChars(value).replace(/\|/g, "\u00a6");
}

function frameRecord(type, body) {
  // Each record starts with a little-endian uint32: the low 24 bits hold the
  // body length and the high byte the record type (0 text, 1 binary).
  const out = new Uint8Array(4 + body.length);
  new DataView(out.buffer).setUint32(0, ((type & 0xff) << 24 | body.length) >>> 0, true);
  out.set(body, 4);
  return out;
}

/**
 * Builds a NUL-terminated `|KEY=value` property record. Entries whose value is
 * undefined or null are skipped. Non-ASCII values are written twice, as
 * Altium does: a `%UTF8%KEY` copy followed by the Windows-1252 `KEY` copy.
 */
function textRecord(entries) {
  const chunks = [];
  for (const [key, rawValue] of entries) {
    if (rawValue === undefined || rawValue === null) {
      continue;
    }
    const value = sanitizeValue(rawValue);
    if (!isAscii(value)) {
      chunks.push(asciiBytes(`|%UTF8%${key}=`), utf8Encoder.encode(value));
    }
    chunks.push(asciiBytes(`|${key}=`), encodeAnsi(value));
  }
  chunks.push(Uint8Array.of(0));
  return frameRecord(RECORD_TEXT, concatBytes(chunks));
}

function binaryRecord(body) {
  return frameRecord(RECORD_BINARY, body);
}

class ByteWriter {
  constructor() {
    this.bytes = [];
  }

  u8(value) {
    this.bytes.push(value & 0xff);
    return this;
  }

  i16(value) {
    if (!Number.isInteger(value) || value < -32768 || value > 32767) {
      throw new RangeError(`Altium binary coordinate out of range: ${value}`);
    }
    return this.u8(value).u8(value >> 8);
  }

  i32(value) {
    return this.u8(value).u8(value >> 8).u8(value >> 16).u8(value >> 24);
  }

  raw(bytes) {
    for (const byte of bytes) {
      this.bytes.push(byte);
    }
    return this;
  }

  // Short Pascal strings carry a one-byte length, so values stop at 255 bytes.
  // Being length-prefixed, they may contain '|' (pins store "part|&|seq").
  pascal(text) {
    const bytes = encodeAnsi(replaceControlChars(text)).subarray(0, 255);
    return this.u8(bytes.length).raw(bytes);
  }

  toBytes() {
    return Uint8Array.from(this.bytes);
  }
}

/**
 * Converts millimetres to Altium's 10-mil unit as an integer part plus a
 * fraction in 1/100000 units. Both parts share the value's sign, matching
 * genuine files such as `X1=-5|X1_Frac=-90550` for -5.9055 units.
 */
function toAltiumUnits(mm) {
  const value = Number(mm);
  const scaled = Math.round((Number.isFinite(value) ? value : 0) / MM_PER_UNIT * FRACTION_SCALE);
  const whole = Math.trunc(scaled / FRACTION_SCALE);
  const frac = scaled - whole * FRACTION_SCALE;
  return { whole: whole + 0, frac: frac + 0 };
}

// Altium omits zero-valued coordinates and fractions; readers default them to 0.
function coordEntries(key, mm) {
  const { whole, frac } = toAltiumUnits(mm);
  return [[key, whole || undefined], [`${key}_Frac`, frac || undefined]];
}

function adler32(bytes) {
  let a = 1;
  let b = 0;
  for (const byte of bytes) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/**
 * Wraps bytes in a zlib stream using one stored (uncompressed) deflate block,
 * which every inflater accepts and needs no compressor in the browser.
 */
function zlibStore(data) {
  if (data.length > 0xffff) {
    throw new RangeError("Stored zlib block exceeds 65535 bytes.");
  }
  const out = new Uint8Array(2 + 5 + data.length + 4);
  const view = new DataView(out.buffer);
  // CMF 0x78 (deflate, 32 KiB window) with FLG 0x01 satisfies the header check.
  out[0] = 0x78;
  out[1] = 0x01;
  out[2] = 0x01; // BFINAL=1, BTYPE=00 (stored)
  view.setUint16(3, data.length, true);
  view.setUint16(5, ~data.length & 0xffff, true);
  out.set(data, 7);
  view.setUint32(7 + data.length, adler32(data), false);
  return out;
}

function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (const byte of utf8Encoder.encode(String(text))) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

// Altium UniqueIDs are eight uppercase letters. A xorshift sequence seeded
// from the library reference keeps repeated exports byte-identical.
function createUniqueIdFactory(seedText) {
  let state = fnv1a(seedText) || 0x9e3779b9;
  return () => {
    let id = "";
    for (let index = 0; index < 8; index += 1) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      state >>>= 0;
      id += String.fromCharCode(65 + (state % 26));
    }
    return id;
  };
}

export {
  ByteWriter,
  binaryRecord,
  concatBytes,
  coordEntries,
  createUniqueIdFactory,
  isAnsiChar,
  textRecord,
  toAltiumUnits,
  zlibStore
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
