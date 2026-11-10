/*
 * Public EasyEDA-to-Altium converter facade. It reuses the EasyEDA parsers and
 * the shared millimetre geometry normalization, then hands the results to the
 * native .SchLib and .PcbLib emitters under src/altium/.
 */

import { exportAltiumPcbLib } from "./altium/pcblib_emitter.js";
import { exportAltiumSchLib } from "./altium/schlib_emitter.js";
import { parseEasyedaFootprint } from "./kicad/easyeda_footprint_parser.js";
import { parseEasyedaSymbol } from "./kicad/easyeda_symbol_parser.js";
import { convertFootprintToKiCad } from "./kicad/kicad_footprint_emitter.js";
import { convertSymbolToKiCad } from "./kicad/kicad_symbol_emitter.js";

// The symbol links to the footprint by its package name, so that name is the
// PcbLib component name even when only the symbol is requested.
function convertEasyedaCadToAltium(cadData, options = {}) {
  const result = {};
  const footprintName =
    String(cadData?.packageDetail?.dataStr?.head?.c_para?.package || "").trim();

  if (options.symbol) {
    const eeSymbol = parseEasyedaSymbol(cadData);
    const name = String(eeSymbol.info.name || "").trim() || "symbol";
    result.symbol = {
      name,
      data: exportAltiumSchLib(convertSymbolToKiCad(eeSymbol), {
        libReference: name,
        footprintName: footprintName || undefined
      })
    };
  }

  if (options.footprint) {
    const eeFootprint = parseEasyedaFootprint(cadData);
    const name = footprintName || "footprint";
    result.footprint = {
      name,
      data: exportAltiumPcbLib(convertFootprintToKiCad(eeFootprint), { footprintName: name })
    };
  }

  return result;
}

export { convertEasyedaCadToAltium };

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
