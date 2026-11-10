/*
 * These tests cover Altium output through the service worker: SamacSys ZIP
 * Altium extraction and EasyEDA conversion to native .SchLib/.PcbLib files in
 * loose and library download layouts.
 */

import { describe, expect, it, vi } from "vitest";

import { createCadData } from "./helpers/fixtures.js";
import { readCompoundFile } from "./helpers/compound_file_reader.js";
import {
  createSamacsysFetchImpl,
  createSamacsysPartContext,
  createServiceWorkerChrome,
  loadServiceWorker,
  sendRuntimeMessage
} from "./helpers/service_worker_harness.js";
import { buildAltiumLibraryPaths, loadSettings } from "../src/core/settings.js";

const ALL_OPTIONS = { symbol: true, footprint: true, model3d: true, datasheet: false };
const EASYEDA_PART_CONTEXT = {
  provider: "easyedaLcsc",
  sourcePartNumber: "C12345",
  lookup: { lcscId: "C12345" }
};

const encode = (text) => new TextEncoder().encode(text);

// Unique object URLs let tests read back each generated Blob by filename.
function createRecordingUrlApi() {
  const blobs = new Map();
  class MockURL extends URL {}
  MockURL.createObjectURL = vi.fn((blob) => {
    const url = `blob:${blobs.size + 1}`;
    blobs.set(url, blob);
    return url;
  });
  MockURL.revokeObjectURL = vi.fn();
  return { urlApi: MockURL, blobs };
}

function downloadedFilenames(chrome) {
  return chrome.downloads.download.mock.calls.map(([options]) => options.filename);
}

async function downloadedBytes(chrome, blobs, filename) {
  const call = chrome.downloads.download.mock.calls.find(([options]) => options.filename === filename);
  return new Uint8Array(await blobs.get(call[0].url).arrayBuffer());
}

function createSamacsysAltiumEntries() {
  return [
    { name: "LM358/Altium/LM358.SchLib", data: encode("schlib-bytes") },
    { name: "LM358/Altium/SOIC127P600X175-8N.PcbLib", data: encode("pcblib-bytes") },
    { name: "LM358/KiCad/LM358.kicad_sym", data: encode("(kicad_symbol_lib)") },
    { name: "LM358/3D/LM358.stp", data: encode("step") },
    { name: "LM358/3D/LM358.wrl", data: encode("#VRML V2.0") }
  ];
}

async function exportSamacsys({ storageState, entries, options = ALL_OPTIONS }) {
  const { chrome, listeners } = createServiceWorkerChrome({ storageState });
  const { urlApi, blobs } = createRecordingUrlApi();
  loadServiceWorker({
    chrome,
    fetchImpl: createSamacsysFetchImpl({ zipStatus: 200 }),
    readZipEntries: vi.fn(async () => entries),
    urlApi
  });
  const { response } = await sendRuntimeMessage(listeners.runtimeMessage[0], {
    type: "EXPORT_PART",
    partContext: createSamacsysPartContext("mouser"),
    options
  });
  return { chrome, blobs, response };
}

function createEasyedaFetchImpl({ stepStatus = 200 } = {}) {
  return vi.fn(async (url) => {
    if (String(url).includes("/components?")) {
      return { ok: true, json: async () => ({ result: createCadData() }) };
    }
    if (stepStatus !== 200) {
      return { ok: false, status: stepStatus };
    }
    return { ok: true, arrayBuffer: async () => encode("ISO-10303-21;").buffer };
  });
}

describe("settings output format", () => {
  it("defaults to Altium and keeps an explicit KiCad choice", async () => {
    const chromeFor = (stored) => ({
      runtime: { lastError: null },
      storage: { local: { get: (defaults, callback) => callback({ ...defaults, ...stored }) } }
    });
    expect((await loadSettings(chromeFor({}))).outputFormat).toBe("altium");
    expect((await loadSettings(chromeFor({ outputFormat: "eagle" }))).outputFormat).toBe("altium");
    expect((await loadSettings(chromeFor({ outputFormat: "kicad" }))).outputFormat).toBe("kicad");
  });

  it("groups Altium library files by type below the library root", () => {
    expect(buildAltiumLibraryPaths("Altium/Parts")).toEqual({
      symbolDir: "Altium/Parts/SchLib",
      footprintDir: "Altium/Parts/PcbLib",
      modelDir: "Altium/Parts/3D",
      datasheetDir: "Altium/Parts/datasheets"
    });
  });
});

describe("service worker SamacSys Altium export", () => {
  it("writes the upstream Altium libraries and STEP model into the library folders", async () => {
    const { chrome, blobs, response } = await exportSamacsys({
      storageState: { outputFormat: "altium", libraryDownloadRoot: "Altium/Parts" },
      entries: createSamacsysAltiumEntries()
    });

    expect(response).toEqual({ ok: true, warnings: [], downloadCount: 3 });
    expect(downloadedFilenames(chrome)).toEqual([
      "Altium/Parts/SchLib/LM358.SchLib",
      "Altium/Parts/PcbLib/SOIC127P600X175-8N.PcbLib",
      "Altium/Parts/3D/LM358.stp"
    ]);
    const bytes = await downloadedBytes(chrome, blobs, "Altium/Parts/SchLib/LM358.SchLib");
    expect(new TextDecoder().decode(bytes)).toBe("schlib-bytes");
  });

  it("uses Altium output by default and saves loose files under their upstream names", async () => {
    const { chrome, response } = await exportSamacsys({
      storageState: { outputFormat: undefined, downloadIndividually: true },
      entries: createSamacsysAltiumEntries(),
      options: { symbol: true, footprint: true, model3d: false, datasheet: false }
    });

    expect(response).toEqual({ ok: true, warnings: [], downloadCount: 2 });
    expect(downloadedFilenames(chrome)).toEqual(["LM358.SchLib", "SOIC127P600X175-8N.PcbLib"]);
  });

  it("warns for selected Altium files missing from the ZIP and still exports the model", async () => {
    const { chrome, response } = await exportSamacsys({
      storageState: { outputFormat: "altium", downloadIndividually: true },
      entries: createSamacsysAltiumEntries().filter((entry) => !entry.name.includes("/Altium/"))
    });

    expect(response).toEqual({
      ok: true,
      warnings: [
        "Symbol not available in the SamacSys ZIP.",
        "Footprint not available in the SamacSys ZIP."
      ],
      downloadCount: 1
    });
    expect(downloadedFilenames(chrome)).toEqual(["LM358.stp"]);
  });

  it("fails when the ZIP has neither Altium libraries nor 3D models", async () => {
    const { chrome, response } = await exportSamacsys({
      storageState: { outputFormat: "altium" },
      entries: [{ name: "LM358/KiCad/LM358.kicad_sym", data: encode("(kicad_symbol_lib)") }]
    });

    expect(response).toEqual({ ok: false, error: "SamacSys ZIP did not contain Altium assets." });
    expect(chrome.downloads.download).not.toHaveBeenCalled();
  });
});

describe("service worker EasyEDA Altium export", () => {
  it("converts EasyEDA parts to SchLib and PcbLib files beside the STEP model", async () => {
    const { chrome, listeners, storage } = createServiceWorkerChrome({
      storageState: { outputFormat: "altium", libraryDownloadRoot: "Altium/Parts" }
    });
    const { urlApi, blobs } = createRecordingUrlApi();
    const fetchImpl = createEasyedaFetchImpl();
    const convertObjToWrlString = vi.fn(() => "#VRML");
    loadServiceWorker({ chrome, fetchImpl, convertObjToWrlString, urlApi });

    const { response } = await sendRuntimeMessage(listeners.runtimeMessage[0], {
      type: "EXPORT_PART",
      partContext: EASYEDA_PART_CONTEXT,
      options: { ...ALL_OPTIONS, datasheet: true }
    });

    expect(response).toEqual({ ok: true, warnings: [], downloadCount: 4 });
    expect(downloadedFilenames(chrome)).toEqual([
      "Altium/Parts/SchLib/C12345-Logic_Buffer.SchLib",
      "Altium/Parts/PcbLib/QFN-16_Example.PcbLib",
      "Altium/Parts/3D/Model_QFN.step",
      "Altium/Parts/datasheets/QFN-16_Example-datasheet.pdf"
    ]);
    expect(fetchImpl.mock.calls.some(([url]) => url.includes("modules.easyeda.com/3dmodel/"))).toBe(false);
    expect(convertObjToWrlString).not.toHaveBeenCalled();
    expect(Object.keys(storage).some((key) => key.startsWith("symbolLibrary:"))).toBe(false);

    const schLib = readCompoundFile(
      await downloadedBytes(chrome, blobs, "Altium/Parts/SchLib/C12345-Logic_Buffer.SchLib")
    );
    expect(new TextDecoder("latin1").decode(schLib.streams.get("FileHeader"))).toContain(
      "Schematic Library Editor Binary File"
    );
    const pcbLib = readCompoundFile(
      await downloadedBytes(chrome, blobs, "Altium/Parts/PcbLib/QFN-16_Example.PcbLib")
    );
    expect(new TextDecoder("latin1").decode(pcbLib.streams.get("FileHeader"))).toContain(
      "PCB 6.0 Binary Library File"
    );
  });

  it("keeps the libraries when the optional STEP download fails", async () => {
    const { chrome, listeners } = createServiceWorkerChrome({
      storageState: { outputFormat: "altium", downloadIndividually: true }
    });
    const convertEasyedaCadToAltium = vi.fn(() => ({
      symbol: { name: "Logic / Buffer", data: encode("schlib") },
      footprint: { name: "QFN-16/Example", data: encode("pcblib") }
    }));
    loadServiceWorker({
      chrome,
      fetchImpl: createEasyedaFetchImpl({ stepStatus: 404 }),
      convertEasyedaCadToAltium
    });

    const { response } = await sendRuntimeMessage(listeners.runtimeMessage[0], {
      type: "EXPORT_PART",
      partContext: EASYEDA_PART_CONTEXT,
      options: ALL_OPTIONS
    });

    expect(convertEasyedaCadToAltium).toHaveBeenCalledWith(expect.any(Object), {
      symbol: true,
      footprint: true
    });
    expect(response).toEqual({
      ok: true,
      warnings: ["3D STEP model download failed (HTTP 404)."],
      downloadCount: 2
    });
    expect(downloadedFilenames(chrome)).toEqual([
      "C12345-Logic_Buffer.SchLib",
      "QFN-16_Example.PcbLib"
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
