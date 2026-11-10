// SamacSys/relay work in this file: JoeShade and Josh Webster
/*
 * Shared provider adapter for SamacSys-backed distributor pages. Distributor-
 * specific detection happens in the content script, while this adapter owns the
 * common preview and export path for Mouser, Farnell, and similar partners.
 */

import {
  loadSettings,
  OUTPUT_FORMAT_ALTIUM,
  resolveSamacsysAuthorizationHeader
} from "../core/settings.js";
import {
  createExportContext,
  getLibraryName,
  resolveExportOptions,
  writeBinaryArtifact,
  writeSymbolArtifact,
  writeTextArtifact
} from "../core/export_artifacts.js";
import {
  buildSamacsysPreviewResponse,
  createSamacsysFetchImpl,
  extractSamacsysAltiumAssets,
  extractSamacsysKiCadAssets,
  fetchSamacsysPageMetadata,
  fetchSamacsysZipArchive,
  rewriteSamacsysFootprintModelPath,
  rewriteSamacsysSymbolFootprintReference,
  stripKicadFootprintModels
} from "./samacsys_common.js";
import { isFirefoxRuntime } from "../core/part_context.js";

function addMissingAssetWarnings(warnings, options, assets) {
  const missingSelectedAssets = [
    [
      options.symbol && !assets.symbols.length,
      "Symbol not available in the SamacSys ZIP."
    ],
    [
      options.footprint && !assets.footprints.length,
      "Footprint not available in the SamacSys ZIP."
    ],
    [
      options.model3d && !assets.stepModels.length && !assets.wrlModels.length,
      "3D model not available in the SamacSys ZIP."
    ]
  ];

  for (const [isMissing, message] of missingSelectedAssets) {
      if (isMissing) {
        warnings.push(message);
      }
  }
}

// Altium files need no reference rewriting: each upstream binary is written
// as-is into its type folder (library mode) or beside the others (loose mode).
async function writeSamacsysAltiumAssets({ downloads, exportContext, options, assets }) {
  const { symbolDir, footprintDir, modelDir } = exportContext.libraryPaths;
  const groups = [
    [options.symbol, assets.symbols, symbolDir],
    [options.footprint, assets.footprints, footprintDir],
    [options.model3d, assets.stepModels, modelDir]
  ];
  let downloadCount = 0;
  for (const [isSelected, files, directory] of groups) {
    if (!isSelected) continue;
    for (const file of files) {
      downloadCount += await writeBinaryArtifact({
        downloads,
        exportContext,
        data: file.data,
        individualFilename: file.filename,
        libraryPath: `${directory}/${file.filename}`
      });
    }
  }
  return downloadCount;
}

function createSamacsysDistributorAdapter(deps) {
  const { chromeApi, fetchImpl, downloads, readZipEntries, userAgent } = deps;

  return {
    async getPreviews(partContext) {
      const settings = await loadSettings(chromeApi);
      const samacsysFetchImpl = createSamacsysFetchImpl(fetchImpl, {
        chromeApi,
        userAgent,
        proxyBaseUrl: settings.samacsysFirefoxProxyBaseUrl,
        proxyAuthorizationHeader:
          settings.samacsysFirefoxProxyAuthorizationHeader,
        authorizationHeader: resolveSamacsysAuthorizationHeader(settings)
      });
      return buildSamacsysPreviewResponse(samacsysFetchImpl, partContext);
    },

    async exportPart(partContext, options = {}) {
      const exportContext = await createExportContext(chromeApi);
      const resolvedOptions = resolveExportOptions(options);
      const upstreamAuthorizationHeader = resolveSamacsysAuthorizationHeader(
        exportContext.settings
      );
      const samacsysFetchImpl = createSamacsysFetchImpl(fetchImpl, {
        chromeApi,
        userAgent,
        proxyBaseUrl: exportContext.settings.samacsysFirefoxProxyBaseUrl,
        proxyAuthorizationHeader:
          exportContext.settings.samacsysFirefoxProxyAuthorizationHeader,
        authorizationHeader: upstreamAuthorizationHeader
      });

      let downloadCount = 0;
      const warnings = [];

      if (resolvedOptions.datasheet) {
        warnings.push("Datasheet export is not available for SamacSys distributor parts.");
      }

      const shouldFetchZip =
        resolvedOptions.symbol || resolvedOptions.footprint || resolvedOptions.model3d;
      if (!shouldFetchZip) {
        return { warnings, downloadCount };
      }

      const metadata = await fetchSamacsysPageMetadata(samacsysFetchImpl, partContext);
      const zipBuffer = await fetchSamacsysZipArchive(samacsysFetchImpl, metadata, {
        retryAuthorizationHeader: isFirefoxRuntime(userAgent)
          ? ""
          : upstreamAuthorizationHeader
      });
      if (exportContext.settings.outputFormat === OUTPUT_FORMAT_ALTIUM) {
        const altiumAssets = await extractSamacsysAltiumAssets(zipBuffer, readZipEntries);
        addMissingAssetWarnings(warnings, resolvedOptions, { ...altiumAssets, wrlModels: [] });
        downloadCount += await writeSamacsysAltiumAssets({
          downloads,
          exportContext,
          options: resolvedOptions,
          assets: altiumAssets
        });
        return { warnings, downloadCount };
      }
      const assets = await extractSamacsysKiCadAssets(zipBuffer, readZipEntries);
      const libraryName = getLibraryName(exportContext.libraryPaths);
      const primaryFootprintName = assets.footprints[0]?.name || null;
      const primaryModelFilename =
        assets.stepModels[0]?.filename || assets.wrlModels[0]?.filename || null;
      const shouldIncludeModelReferences =
        resolvedOptions.model3d && primaryModelFilename;

      addMissingAssetWarnings(warnings, resolvedOptions, assets);

      if (resolvedOptions.symbol) {
        for (const symbol of assets.symbols) {
          const rewrittenSymbol = exportContext.settings.downloadIndividually
            ? symbol.content
            : rewriteSamacsysSymbolFootprintReference(
                symbol.content,
                primaryFootprintName,
                libraryName
              );

          downloadCount += await writeSymbolArtifact({
            chromeApi,
            downloads,
            exportContext,
            symbolContent: rewrittenSymbol,
            individualFilename: symbol.filename
          });
        }
      }

      if (resolvedOptions.footprint) {
        for (const footprint of assets.footprints) {
          let footprintContent = stripKicadFootprintModels(footprint.content);
          if (shouldIncludeModelReferences) {
            footprintContent = exportContext.settings.downloadIndividually
              ? footprint.content
              : rewriteSamacsysFootprintModelPath(
                  footprint.content,
                  primaryModelFilename,
                  libraryName
                );
          }

          downloadCount += await writeTextArtifact({
            downloads,
            exportContext,
            content: footprintContent,
            individualFilename: footprint.filename,
            libraryPath: `${exportContext.libraryPaths.footprintDir}/${footprint.filename}`
          });
        }
      }

      if (resolvedOptions.model3d) {
        for (const stepModel of assets.stepModels) {
          downloadCount += await writeBinaryArtifact({
            downloads,
            exportContext,
            data: stepModel.data,
            individualFilename: stepModel.filename,
            libraryPath: `${exportContext.libraryPaths.modelDir}/${stepModel.filename}`
          });
        }

        for (const wrlModel of assets.wrlModels) {
          downloadCount += await writeTextArtifact({
            downloads,
            exportContext,
            content: wrlModel.content,
            individualFilename: wrlModel.filename,
            libraryPath: `${exportContext.libraryPaths.modelDir}/${wrlModel.filename}`
          });
        }
      }

      return { warnings, downloadCount };
    }
  };
}

export { createSamacsysDistributorAdapter };

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
