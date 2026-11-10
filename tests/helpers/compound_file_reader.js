/*
 * Test-only Compound File Binary reader. It walks the header FAT, directory
 * sibling trees and mini stream so tests can inspect Altium library streams
 * produced by src/altium/compound_file.js without a production dependency.
 */

const ENDOFCHAIN = 0xfffffffe;
const NOSTREAM = 0xffffffff;

function readChain(table, start) {
  const chain = [];
  for (let sector = start; sector !== ENDOFCHAIN; sector = table[sector]) {
    if (sector === undefined || chain.length > table.length) {
      throw new Error("Broken compound file sector chain.");
    }
    chain.push(sector);
  }
  return chain;
}

function readCompoundFile(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const signature = [...bytes.subarray(0, 8)].map((byte) => byte.toString(16)).join("");
  if (signature !== "d0cf11e0a1b11ae1") {
    throw new Error("Not a compound file.");
  }
  const sectorSize = 1 << view.getUint16(0x1e, true);
  const miniSectorSize = 1 << view.getUint16(0x20, true);
  const miniCutoff = view.getUint32(0x38, true);
  const fatSectorCount = view.getUint32(0x2c, true);
  const sectorBytes = (sector) =>
    bytes.subarray(sectorSize * (sector + 1), sectorSize * (sector + 2));
  const readUint32Table = (sectors) => {
    const table = [];
    for (const sector of sectors) {
      const data = sectorBytes(sector);
      const dataView = new DataView(data.buffer, data.byteOffset, data.byteLength);
      for (let offset = 0; offset < data.length; offset += 4) {
        table.push(dataView.getUint32(offset, true));
      }
    }
    return table;
  };
  const concatSectors = (sectors) => {
    const output = new Uint8Array(sectors.length * sectorSize);
    sectors.forEach((sector, index) => output.set(sectorBytes(sector), index * sectorSize));
    return output;
  };

  const fatSectors = [];
  for (let index = 0; index < fatSectorCount; index += 1) {
    fatSectors.push(view.getUint32(0x4c + index * 4, true));
  }
  const fat = readUint32Table(fatSectors);
  const directory = concatSectors(readChain(fat, view.getUint32(0x30, true)));
  const directoryView = new DataView(directory.buffer);
  const entries = [];
  for (let offset = 0; offset < directory.length; offset += 128) {
    const nameLength = directoryView.getUint16(offset + 0x40, true);
    let name = "";
    for (let index = 0; index < nameLength / 2 - 1; index += 1) {
      name += String.fromCharCode(directoryView.getUint16(offset + index * 2, true));
    }
    entries.push({
      name,
      type: directory[offset + 0x42],
      color: directory[offset + 0x43],
      leftId: directoryView.getUint32(offset + 0x44, true),
      rightId: directoryView.getUint32(offset + 0x48, true),
      childId: directoryView.getUint32(offset + 0x4c, true),
      start: directoryView.getUint32(offset + 0x74, true),
      size: directoryView.getUint32(offset + 0x78, true)
    });
  }

  const root = entries[0];
  const miniFatStart = view.getUint32(0x3c, true);
  const miniFat = miniFatStart === ENDOFCHAIN ? [] : readUint32Table(readChain(fat, miniFatStart));
  const miniStream = root.start === ENDOFCHAIN ? new Uint8Array() : concatSectors(readChain(fat, root.start));

  const readStream = (entry) => {
    if (!entry.size) {
      return new Uint8Array();
    }
    if (entry.size < miniCutoff) {
      const chain = readChain(miniFat, entry.start);
      const output = new Uint8Array(chain.length * miniSectorSize);
      chain.forEach((sector, index) =>
        output.set(miniStream.subarray(sector * miniSectorSize, (sector + 1) * miniSectorSize), index * miniSectorSize)
      );
      return output.subarray(0, entry.size);
    }
    return concatSectors(readChain(fat, entry.start)).subarray(0, entry.size);
  };

  // In-order traversal of each sibling tree yields the CFB name order, which
  // tests use to confirm the writer's search-tree invariant.
  const streams = new Map();
  const siblingOrder = new Map();
  const walkSiblings = (id, prefix, order) => {
    if (id === NOSTREAM) return;
    const entry = entries[id];
    walkSiblings(entry.leftId, prefix, order);
    order.push(entry.name);
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.type === 2) {
      streams.set(path, readStream(entry));
    } else {
      const childOrder = [];
      siblingOrder.set(path, childOrder);
      walkSiblings(entry.childId, path, childOrder);
    }
    walkSiblings(entry.rightId, prefix, order);
  };
  const rootOrder = [];
  siblingOrder.set("", rootOrder);
  walkSiblings(root.childId, "", rootOrder);

  return { streams, siblingOrder, entries };
}

export { readCompoundFile };

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
