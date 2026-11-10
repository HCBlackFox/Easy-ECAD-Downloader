/*
 * Writes Microsoft Compound File Binary (CFB version 3, 512-byte sectors)
 * containers. Altium .SchLib and .PcbLib libraries are CFB files; the Altium
 * emitters supply their storages and streams as slash-separated paths here.
 */

const SECTOR_SIZE = 512;
const MINI_SECTOR_SIZE = 64;
const MINI_STREAM_CUTOFF = 4096;
const DIRECTORY_ENTRY_SIZE = 128;
const HEADER_DIFAT_ENTRIES = 109;
const FAT_ENTRIES_PER_SECTOR = SECTOR_SIZE / 4;
const MAX_NAME_LENGTH = 31;

const FREESECT = 0xffffffff;
const ENDOFCHAIN = 0xfffffffe;
const FATSECT = 0xfffffffd;
const NOSTREAM = 0xffffffff;

const TYPE_STORAGE = 1;
const TYPE_STREAM = 2;
const TYPE_ROOT = 5;
const COLOR_BLACK = 1;

// CFB orders siblings by UTF-16 name length first, then by the upper-cased
// names; duplicate names are rejected case-insensitively for the same reason.
function compareEntryNames(left, right) {
  if (left.name.length !== right.name.length) {
    return left.name.length - right.name.length;
  }
  const leftUpper = left.name.toUpperCase();
  const rightUpper = right.name.toUpperCase();
  return leftUpper < rightUpper ? -1 : leftUpper > rightUpper ? 1 : 0;
}

function validateEntryName(name, path) {
  if (!name || name.length > MAX_NAME_LENGTH || /[/\\:!]/.test(name)) {
    throw new Error(`Invalid compound file entry name in path: ${path}`);
  }
}

function buildEntryTree(streams) {
  const root = { name: "Root Entry", type: TYPE_ROOT, children: new Map() };
  for (const { path, data: view } of streams) {
    // ArrayBuffer.isView accepts typed arrays created in other JS realms.
    if (!ArrayBuffer.isView(view)) {
      throw new Error(`Compound file stream data must be a byte array: ${path}`);
    }
    const data = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    const names = String(path).split("/");
    let parent = root;
    names.forEach((name, index) => {
      validateEntryName(name, path);
      const key = name.toUpperCase();
      const isStream = index === names.length - 1;
      const existing = parent.children.get(key);
      if (existing && (isStream || existing.type !== TYPE_STORAGE)) {
        throw new Error(`Duplicate compound file path: ${path}`);
      }
      const entry = existing || (isStream
        ? { name, type: TYPE_STREAM, data }
        : { name, type: TYPE_STORAGE, children: new Map() });
      parent.children.set(key, entry);
      parent = entry;
    });
  }
  return root;
}

// Siblings form a binary search tree below their storage's child pointer. A
// midpoint split keeps it balanced; all nodes are black, as in common writers.
function linkSiblingTree(sorted, low = 0, high = sorted.length) {
  if (low >= high) {
    return NOSTREAM;
  }
  const middle = (low + high) >> 1;
  const entry = sorted[middle];
  entry.leftId = linkSiblingTree(sorted, low, middle);
  entry.rightId = linkSiblingTree(sorted, middle + 1, high);
  return entry.id;
}

function flattenEntryTree(root) {
  const entries = [root];
  root.id = 0;
  root.leftId = NOSTREAM;
  root.rightId = NOSTREAM;
  const visit = (storage) => {
    const children = [...storage.children.values()];
    for (const child of children) {
      child.id = entries.length;
      entries.push(child);
    }
    storage.childId = linkSiblingTree([...children].sort(compareEntryNames));
    for (const child of children) {
      if (child.type === TYPE_STORAGE) {
        visit(child);
      }
    }
  };
  visit(root);
  return entries;
}

function sectorCount(byteLength, sectorSize = SECTOR_SIZE) {
  return Math.ceil(byteLength / sectorSize);
}

function writeChain(table, start, length) {
  for (let index = 0; index < length; index += 1) {
    table[start + index] = index === length - 1 ? ENDOFCHAIN : start + index + 1;
  }
}

// Streams below the 4096-byte cutoff live in 64-byte mini sectors inside the
// root entry's mini stream; larger streams occupy ordinary FAT-chained sectors.
function planLayout(entries) {
  const streamEntries = entries.filter((entry) => entry.type === TYPE_STREAM);
  const miniFat = [];
  for (const entry of streamEntries) {
    entry.size = entry.data.length;
    entry.isMini = entry.size > 0 && entry.size < MINI_STREAM_CUTOFF;
    if (entry.isMini) {
      entry.start = miniFat.length;
      writeChain(miniFat, entry.start, sectorCount(entry.size, MINI_SECTOR_SIZE));
    }
  }

  let nextSector = 0;
  const fatChains = [];
  const allocate = (length) => {
    const start = length ? nextSector : ENDOFCHAIN;
    if (length) {
      fatChains.push([start, length]);
      nextSector += length;
    }
    return start;
  };

  for (const entry of streamEntries) {
    if (!entry.isMini) {
      entry.start = allocate(sectorCount(entry.size));
    }
  }
  const miniStreamSize = miniFat.length * MINI_SECTOR_SIZE;
  const miniStreamStart = allocate(sectorCount(miniStreamSize));
  const miniFatSectors = sectorCount(miniFat.length * 4);
  const miniFatStart = allocate(miniFatSectors);
  const directorySectors = sectorCount(entries.length * DIRECTORY_ENTRY_SIZE);
  const directoryStart = allocate(directorySectors);

  let fatSectors = 1;
  while (fatSectors * FAT_ENTRIES_PER_SECTOR < nextSector + fatSectors) {
    fatSectors += 1;
  }
  if (fatSectors > HEADER_DIFAT_ENTRIES) {
    throw new Error("Compound file is too large for the header FAT index.");
  }
  const fatStart = nextSector;
  const totalSectors = nextSector + fatSectors;

  const fat = new Array(fatSectors * FAT_ENTRIES_PER_SECTOR).fill(FREESECT);
  for (const [start, length] of fatChains) {
    writeChain(fat, start, length);
  }
  for (let index = 0; index < fatSectors; index += 1) {
    fat[fatStart + index] = FATSECT;
  }

  return {
    miniFat,
    miniStreamSize,
    miniStreamStart,
    miniFatStart,
    miniFatSectors,
    directoryStart,
    directorySectors,
    fat,
    fatStart,
    fatSectors,
    totalSectors
  };
}

function writeHeader(view, layout) {
  [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1].forEach((byte, index) =>
    view.setUint8(index, byte)
  );
  view.setUint16(0x18, 0x003e, true);
  view.setUint16(0x1a, 0x0003, true);
  view.setUint16(0x1c, 0xfffe, true);
  view.setUint16(0x1e, 9, true);
  view.setUint16(0x20, 6, true);
  view.setUint32(0x2c, layout.fatSectors, true);
  view.setUint32(0x30, layout.directoryStart, true);
  view.setUint32(0x38, MINI_STREAM_CUTOFF, true);
  view.setUint32(0x3c, layout.miniFatSectors ? layout.miniFatStart : ENDOFCHAIN, true);
  view.setUint32(0x40, layout.miniFatSectors, true);
  view.setUint32(0x44, ENDOFCHAIN, true);
  for (let index = 0; index < HEADER_DIFAT_ENTRIES; index += 1) {
    const sector = index < layout.fatSectors ? layout.fatStart + index : FREESECT;
    view.setUint32(0x4c + index * 4, sector, true);
  }
}

function writeDirectoryEntry(view, offset, entry) {
  if (!entry) {
    view.setUint32(offset + 0x44, NOSTREAM, true);
    view.setUint32(offset + 0x48, NOSTREAM, true);
    view.setUint32(offset + 0x4c, NOSTREAM, true);
    return;
  }
  for (let index = 0; index < entry.name.length; index += 1) {
    view.setUint16(offset + index * 2, entry.name.charCodeAt(index), true);
  }
  view.setUint16(offset + 0x40, (entry.name.length + 1) * 2, true);
  view.setUint8(offset + 0x42, entry.type);
  view.setUint8(offset + 0x43, COLOR_BLACK);
  view.setUint32(offset + 0x44, entry.leftId, true);
  view.setUint32(offset + 0x48, entry.rightId, true);
  view.setUint32(offset + 0x4c, entry.type === TYPE_STREAM ? NOSTREAM : entry.childId, true);
  view.setUint32(offset + 0x74, entry.type === TYPE_STORAGE ? 0 : entry.start, true);
  view.setUint32(offset + 0x78, entry.type === TYPE_STORAGE ? 0 : entry.size, true);
}

/**
 * @param {{ path: string, data: Uint8Array }[]} streams Stream paths such as
 *   "FileHeader" or "Component/Data"; intermediate storages are implied.
 * @returns {Uint8Array} Complete compound file bytes.
 */
function writeCompoundFile(streams) {
  const root = buildEntryTree(streams);
  const entries = flattenEntryTree(root);
  const layout = planLayout(entries);
  root.start = layout.miniStreamSize ? layout.miniStreamStart : ENDOFCHAIN;
  root.size = layout.miniStreamSize;

  const bytes = new Uint8Array(SECTOR_SIZE * (1 + layout.totalSectors));
  const view = new DataView(bytes.buffer);
  const sectorOffset = (sector) => SECTOR_SIZE * (1 + sector);
  writeHeader(view, layout);

  for (const entry of entries) {
    if (entry.type !== TYPE_STREAM || !entry.size) {
      continue;
    }
    const offset = entry.isMini
      ? sectorOffset(layout.miniStreamStart) + entry.start * MINI_SECTOR_SIZE
      : sectorOffset(entry.start);
    bytes.set(entry.data, offset);
  }

  layout.miniFat.forEach((value, index) =>
    view.setUint32(sectorOffset(layout.miniFatStart) + index * 4, value, true)
  );
  const miniFatEntries = layout.miniFatSectors * FAT_ENTRIES_PER_SECTOR;
  for (let index = layout.miniFat.length; index < miniFatEntries; index += 1) {
    view.setUint32(sectorOffset(layout.miniFatStart) + index * 4, FREESECT, true);
  }

  const directoryEntries = layout.directorySectors * (SECTOR_SIZE / DIRECTORY_ENTRY_SIZE);
  for (let index = 0; index < directoryEntries; index += 1) {
    writeDirectoryEntry(
      view,
      sectorOffset(layout.directoryStart) + index * DIRECTORY_ENTRY_SIZE,
      entries[index]
    );
  }

  layout.fat.forEach((value, index) =>
    view.setUint32(sectorOffset(layout.fatStart) + index * 4, value, true)
  );
  return bytes;
}

export { writeCompoundFile };

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
