/*
 * These tests cover the Compound File Binary writer used for Altium libraries:
 * mini and regular stream placement, nested storages, sibling ordering and
 * rejected entry names.
 */

import { describe, expect, it } from "vitest";

import { writeCompoundFile } from "../src/altium/compound_file.js";
import { readCompoundFile } from "./helpers/compound_file_reader.js";

const bytesOf = (length, seed) =>
  Uint8Array.from({ length }, (_, index) => (index * 31 + seed) % 251);

describe("Altium compound file writer", () => {
  it("round-trips nested mini and regular streams", () => {
    const streams = [
      { path: "FileHeader", data: new TextEncoder().encode("|HEADER=test|") },
      { path: "Part A/Data", data: bytesOf(5000, 1) },
      { path: "Part A/Parameters", data: bytesOf(63, 2) },
      { path: "Library/Models/Header", data: bytesOf(4096, 3) },
      { path: "Library/Models/Data", data: bytesOf(4095, 4) },
      { path: "Empty", data: new Uint8Array() }
    ];

    const file = writeCompoundFile(streams);
    expect(file.length % 512).toBe(0);

    const { streams: read } = readCompoundFile(file);
    expect([...read.keys()].sort()).toEqual(streams.map((stream) => stream.path).sort());
    for (const stream of streams) {
      // jsdom's TextEncoder returns another realm's Uint8Array; compare bytes.
      expect([...read.get(stream.path)]).toEqual([...stream.data]);
    }
  });

  it("orders siblings by name length, then case-insensitive name", () => {
    const names = ["bb", "A", "Ccc", "aa", "Zz9", "d", "LongerName", "B"];
    const file = writeCompoundFile(
      names.map((name) => ({ path: name, data: new TextEncoder().encode(name) }))
    );
    const { siblingOrder, entries } = readCompoundFile(file);
    expect(siblingOrder.get("")).toEqual(["A", "B", "d", "aa", "bb", "Ccc", "Zz9", "LongerName"]);
    expect(entries[0]).toMatchObject({ name: "Root Entry", type: 5 });
  });

  it("spans multiple FAT sectors for larger libraries", () => {
    const data = bytesOf(512 * 200, 9);
    const { streams } = readCompoundFile(writeCompoundFile([{ path: "Big", data }]));
    expect(streams.get("Big")).toEqual(data);
  });

  it.each([
    ["an empty name", "Part//Data"],
    ["a name longer than 31 characters", "A".repeat(32)],
    ["a reserved character", "Bad:Name"]
  ])("rejects %s", (_label, entryPath) => {
    expect(() => writeCompoundFile([{ path: entryPath, data: new Uint8Array(1) }])).toThrow(
      /Invalid compound file entry name/
    );
  });

  it("rejects duplicate and conflicting paths", () => {
    const data = new Uint8Array(1);
    expect(() =>
      writeCompoundFile([{ path: "Data", data }, { path: "DATA", data }])
    ).toThrow(/Duplicate compound file path/);
    expect(() =>
      writeCompoundFile([{ path: "Part/Data", data }, { path: "Part", data }])
    ).toThrow(/Duplicate compound file path/);
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
