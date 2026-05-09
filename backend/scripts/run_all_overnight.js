// scripts/run_all_overnight.js
//
// Run the full evaluation matrix overnight:
//   3 extraction modes (two_shot, one_shot, zero_shot)
//   x 4 Path A providers (openai, anthropic, gemini, deepseek)
//   = 12 batches of 18 papers each
//
// Each batch is saved as its own JSON file. If a batch fails, the script logs
// it and moves to the next combination - no data loss.
//
// Usage:  node scripts/run_all_overnight.js
//
// Expected runtime: ~5-7 hours (perfect for an overnight run).

import fs from "node:fs";
import path from "node:path";

// =========================================================================
// CONFIG
// =========================================================================

const API_BASE = "https://wajahathssn-github-io.vercel.app/api";
const PIPELINE_TIMEOUT_MS = 240_000;          // 4 min per paper
const DELAY_BETWEEN_BATCHES_MS = 20_000;      // 20s breather between batches

const MODES = ["two_shot", "one_shot", "zero_shot"];
const PATH_A_PROVIDERS = ["openai", "anthropic", "gemini", "deepseek"];

// =========================================================================
// PAPERS & ABSTRACTS - same as run_qa_batch.js
// =========================================================================

const PAPERS = [
  { id: "P01" }, { id: "P02" }, { id: "P03" }, { id: "P04" },
  { id: "P06" }, { id: "P07" }, { id: "P08" }, { id: "P09" },
  { id: "P10" }, { id: "P11" }, { id: "P12" }, { id: "P13" },
  { id: "P14" }, { id: "P15" }, { id: "P17" }, { id: "P18" },
  { id: "P19" }, { id: "P20" },
];

const ABSTRACTS = {
  "P01": `Li-CO2 battery has attracted extensive attention and research due to its super high theoretical energy density and its ability to fix greenhouse gas CO2. However, the slow reaction kinetics during discharge/charge seriously limits its development. Hence, a simple cation exchange strategy is developed to introduce Ru atoms onto a Co3O4 nanosheet array grown on carbon cloth (SA Ru-Co3O4/CC) to prepare a single atom site catalyst (SASC) and successfully used in Li-CO2 battery. Li-CO2 batteries based on SA Ru-Co3O4/CC cathode exhibit enhanced electrochemical performances including low overpotential, ultra high capacity, and long cycle life. Density functional theory calculations reveal that single atom Ru as the driving force center can significantly enhance the intrinsic affinity for key intermediates, thus enhancing the reaction kinetics of CO2 reduction reaction in Li-CO2 batteries, and ultimately optimizing the growth pathway of discharge products. In addition, the Bader charge analysis indicates that Ru atoms as electron-deficient centers can enhance the catalytic activity of SA Ru-Co3O4/CC cathode for the CO2 evolution reaction. It is believed that this work has important implications for the development of new SASCs and the design of efficient catalyst for Li-CO2 batteries.`,

  "P02": `The rapid development of organic-inorganic hybrid perovskite solar cells has resulted in laboratory-scale devices having power conversion efficiencies that are competitive with commercialised technologies. However, hybrid perovskite solar cells are yet to make an impact beyond the research community, with translation to large-area devices fabricated by industry-relevant manufacturing methods remaining a critical challenge. Here we report the first demonstration of hybrid perovskite solar cell modules, comprising serially-interconnected cells, produced entirely using industrial roll-to-roll printing tools under ambient room conditions. As part of this development, costly vacuum-deposited metal electrodes are replaced with printed carbon electrodes. A high-throughput experiment involving the analysis of batches of 1600 cells produced using 20 parameter combinations enabled rapid optimisation over a large parameter space. The optimised roll-to-roll fabricated hybrid perovskite solar cells show power conversion efficiencies of up to 15.5% for individual small-area cells and 11.0% for serially-interconnected cells in large-area modules. Based on the devices produced in this work, a cost of ~0.7 USD W-1 is predicted for a production rate of 1,000,000 m2 per year in Australia, with potential for further significant cost reductions.`,

  "P03": `Solid-state lithium-metal (Li0) batteries are gaining traction for electric vehicle applications because they replace flammable liquid electrolytes with a safer, solid-form electrolyte that also offers higher energy density and better resistance against Li dendrite formation. Solid polymer electrolytes (SPEs) are highly promising candidates because of their tunable mechanical properties and easy manufacturability; however, their electrochemical instability against lithium metal (Li0), mediocre conductivity, and poorly understood Li0/SPE interphases have prevented extensive application in real batteries. In particular, the origin of the low Coulombic efficiency (CE) associated with SPEs remains elusive, as the debate continues as to whether it originates from unfavored interfacial reactions or lithium dendritic growth and dead lithium formation. In this work, we use state-of-the-art cryo-electromicroscopy (cryoEM) imaging and spectroscopic techniques to characterize the structure and chemistry of the interface between Li0 and a polyacrylate-based SPE. Contradicting the conventional knowledge, we find that no protective interphase forms, owing to the sustained reactions between deposited Li dendrites and polyacrylic backbones and succinonitrile plasticizer. Due to the reaction-induced volume change, large amounts of cracks form inside the Li dendrites with a stress-corrosion-cracking behavior, indicating that Li0 cannot be passivated in this SPE system. Based on this observation, we then introduce additive engineering leveraging on the knowledge of liquid electrolytes, and demonstrate that the Li0 surface can be effectively protected against corrosion using fluoroethylene carbonate (FEC), leading to densely packed Li0 domes with conformal and stable solid-electrolyte interphases (SEIs) films. Owing to the high room temperature ionic conductivity of 1.01 mS/cm, the high transference number of 0.57 and the stabilized lithium-electrolyte interface, this improved new SPE delivers an excellent lithium plating/stripping CE of 99% and 1800 hours of stable cycling in Li||Li symmetric cells (0.2 mA/cm2, 1mAh/cm2). This improved cathodic stability along with the high anodic stability enables record high cycle life of >2000 cycles for Li||LiFePO4 and >400 cycles for Li||LiCoO2 full cells.`,

  "P04": `Oxidized sodium alginate (OSA) is selected as an appropriate material to be extensively applied in regenerative medicine, 3D-printed/composite scaffolds, and tissue engineering for its excellent physicochemical properties and biodegradability. However, few literatures have systematically investigated the structure and properties of the resultant OSA and the effect of the oxidation degree (OD) of alginate on its biodegradability and gelation ability. Herein, we used NaIO4 as the oxidant to oxidize adjacent hydroxyl groups at the C-2 and C-3 positions on alginate uronic acid monomer to obtain OSA with various ODs. The structure and physicochemical properties of OSA were evaluated by Fourier transform infrared spectroscopy (FT-IR), 1H nuclear magnetic resonance (1H NMR), X-ray Photoelectron Spectroscopy (XPS), X-ray Diffraction (XRD), and thermogravimetric analysis (TGA). At the same time, gel permeation chromatography (GPC) and a rheometer were used to determine the hydrogel-forming ability and biodegradation performance of OSA. The results showed that the two adjacent hydroxyl groups of alginate uronic acid units were successfully oxidized to form the aldehyde groups; as the amount of NaIO4 increased, the OD of OSA gradually increased, the molecular weight decreased, the gelation ability continued to weaken, and degradation performance obviously rose. It is shown that OSA with various ODs could be prepared by regulating the molar ratio of NaIO4 and sodium alginate (SA), which could greatly broaden the application of OSA-based hydrogel in tissue engineering, controlled drug release, 3D printing, and the biomedical field.`,

  "P06": `Nanotechnology is an embryonic field that grips countless impacts on the drug delivery system. Nanoparticles as haulers increase the capability of target-specific drug delivery to many folds hence are used in the treatment of dreadful diseases such as cancer, diabetes, etc. This boom has aimed at, to synthesize Copper oxide nanoparticles (CuO-NPs) using Acalypha Indica leaf extract and then incorporated with graphene oxide (GO) to form GO-CuO nanocomposites. Secondly, to sightsee the photocatalytic activity of CuO-NPs and GO-CuO nanocomposites towards the decolorization of methylene blue-dye and to test its activity against HCT-116 Human colon cancer cell lines. Synthesized nanocomposites were characterized using FTIR, UV-vis, X-ray powder diffraction (XRD), scanning electron microscopy (SEM), energy dispersive X-ray analysis (EDAX), X-ray Photoelectron Spectroscopy (XPS) and transmission electron microscopy (TEM) analysis. The photocatalytic studies revealed that synthesized nanocomposites have the efficiency to degrade methylene blue dye by 83.20% and cytotoxic activity was found to be 70% against HCT-116 Human colon cancer cell lines at 100 ug/ml. GO-CuO nanocomposites have appreciable activity towards cancer cell lines and photocatalytic activity when compared to nanoparticles as such.`,

  "P07": `Aqueous zinc-ion batteries, in terms of integration with high safety, environmental benignity, and low cost, have attracted much attention for powering electronic devices and storage systems. However, the interface instability issues at the Zn anode caused by detrimental side reactions such as dendrite growth, hydrogen evolution, and metal corrosion at the solid (anode)/liquid (electrolyte) interface impede their practical applications in the fields requiring long-term performance persistence. Despite the rapid progress in suppressing the side reactions at the materials interface, the mechanism of ion storage and dendrite formation in practical aqueous zinc-ion batteries with dual-cation aqueous electrolytes is still unclear. Herein, we design an interface material consisting of forest-like three-dimensional zinc-copper alloy with engineered surfaces to explore the Zn plating/stripping mode in dual-cation electrolytes. The three-dimensional nanostructured surface of zinc-copper alloy is demonstrated to be in favor of effectively regulating the reaction kinetics of Zn plating/stripping processes. The developed interface materials suppress the dendrite growth on the anode surface towards high-performance persistent aqueous zinc-ion batteries in the aqueous electrolytes containing single and dual cations. This work remarkably enhances the fundamental understanding of dual-cation intercalation chemistry in aqueous electrochemical systems and provides a guide for exploring high-performance aqueous zinc-ion batteries and beyond.`,

  "P08": `Aryl-ether-free anion-exchange ionomers (AEIs) and membranes (AEMs) have become an important benchmark to address the insufficient durability and power-density issues associated with AEM fuel cells (AEMFCs). Here, we present aliphatic chain-containing poly(diphenyl-terphenyl piperidinium) (PDTP) copolymers to reduce the phenyl content and adsorption of AEIs and to increase the mechanical properties of AEMs. Specifically, PDTP AEMs possess excellent mechanical properties (storage modulus>1800 MPa, tensile strength>70 MPa), H2 fuel-barrier properties (<10 Barrer), good ion conductivity, and ex-situ stability. Meanwhile, PDTP AEIs with low phenyl content and high-water permeability display excellent peak power densities (PPDs). The present AEMFCs reach outstanding PPDs of 2.58 W cm-2 (>7.6 A cm-2 current density) and 1.38 W cm-2 at 80 C in H2/O2 and H2/air, respectively, along with a specific power (PPD/catalyst loading) over 8 W mg-1, which is the highest record for Pt-based AEMFCs so far.`,

  "P09": `In situ formation of a stable interphase layer on zinc surface is an effective solution to suppress dendrite growth. However, the fast transport of bivalent Zn-ions within the solid interlayer remains very challenging. Herein, we engineer the SEI components and enable superior kinetics of Zn metal batteries under harsh conditions through regulating the sequence of interfacial chemical reaction. With the differences in chemical reactivity of trimethyl phosphate co-solvent and trifluoromethanesulfonate anions in the Zn2+-solvation shell, Zn3(PO4)2 and ZnF2 are successively generated on Zn metal surface to form a gradient ZnF2-Zn3(PO4)2 interphase. Mechanistic studies reveal the outer ZnF2 facilitates Zn2+ desolvation and inner Zn3(PO4)2 serves as channels for fast Zn2+ transport, contributing to long-term cycling at subzero temperatures. Impressively, the gradient SEI enables a high lifespan over 7000 hours in Zn symmetric cell and a capacity retention of 86.1% after 12000 cycles in Zn-KVOH full cell at -50 C.`,

  "P10": `Among various advanced oxidation processes, coupled photocatalysis and heterogeneous Fenton-like catalysis (known as photo-Fenton-like catalysis) to generate highly reactive species for environmental remediation has attracted wide interests. As an emerging metal-free photocatalyst, graphitic carbon nitride (g-C3N4, CN) has been recently recognized as a promising candidate to catalyze robustly heterogeneous photo-Fenton-like reactions for wastewater remediation. This review summarizes recent progress in fabricating various types of CN-based catalysts for the photo-Fenton-like reaction process. Innovative engineering strategies on the CN matrix are outlined, ranging from morphology control, defect engineering, nonmetal atom doping, organic molecule doping to modification by metal-containing species. The photo-Fenton-like catalytic activities of CN loaded with auxiliary sub-nanoscale (e.g., quantum dots, organometallic molecules, metal cations, and single atom metals) and nanoscale metal-based materials are critically evaluated. Hybridization of CN with bandgap-matching semiconductors for the construction of type-II and Z-scheme heterojunctions are also examined. The critical factors (e.g., morphology, dimensionality, light absorption, charge excitation/migration, catalytic sites, H2O2 generation and activation) that determine the performance of CN-based photocatalysts in Fenton-like catalysis are systematically discussed. After examining the structure-activity relationship, research perspectives are proposed for further development of CN-based photocatalysts toward more efficient photo-Fenton-like reactions and their application in practical water treatment.`,

  "P11": `A pure phase BaCo0.5Fe0.5O3-d (BCF), which cannot be obtained before, is successfully prepared in this study by using the calcination method with a rapid cooling procedure. The successful preparation of BCF allows the evaluation of this material as a cathode for proton-conducting solid oxide fuel cells (H-SOFCs) for the first time. An H-SOFC using the BCF cathode achieves an encouraging fuel cell performance of 2012 mW cm-2 at 700 C, two-fold higher than that of a similar cell using the classical high-performance Ba0.5Sr0.5Co0.8Fe0.2O3-d (BSCF) cathode. First-principles calculations reveal the mechanism for the performance enhancement, indicating that the new BCF cathode significantly lowers the energy barriers in the oxygen reduction reaction (ORR) compared with the BSCF cathode. Therefore, improved cathode performance and fuel cell output are obtained for the BCF cell. The fuel cell using the BCF cathode also shows excellent long-term stability that can work stably for nearly 900 h without noticeable degradations. The fuel cell performance and long-term stability of the current BCF cell are superior to most of the H-SOFCs reported in previous reports, suggesting that BCF is a promising cathode for H-SOFCs.`,

  "P12": `Efficient and direct conversion of methane to value-added products has been a long-term challenge in shale gas applications. Here, we show that atomically thin nanolayers of Pt with a single or double atomic layer thickness, supported on a two-dimensional molybdenum titanium carbide (MXene), catalyse non-oxidative coupling of methane to ethane/ethylene (C2). Kinetic and theoretical studies, combined with in-situ spectroscopic and microscopic characterizations, demonstrate that Pt nanolayers anchored at the hexagonal close-packed sites of the MXene support can activate the first C-H bond of methane to form methyl radicals that favour desorption over further dehydrogenation and thus suppress coke deposition. At 750 C and 7% methane conversion, the catalyst runs for 72 hours of continuous operation without deactivation and exhibits >98% selectivity towards C2 products, with a turnover frequency of 0.2-0.6 s-1. Our findings provide insights into the design of highly active and stable catalysts for methane activation and create a platform for developing atomically thin supported metal catalysts.`,

  "P13": `In the last decade, biochar (BC) has attracted significant attention for the removal of pollutants from aqueous solutions. Biochar exhibits many distinctive characteristics that make it an attractive adsorbent due to its availability, low manufacturing cost and compelling surface properties. This review presents a comprehensive summary of BC's application in phosphate remediation. Adsorption isotherm, kinetics, experimental conditions and the effect of different adsorption parameters on phosphate removal are outlined. The adsorption mechanisms, effect of coexisting ions, desorption studies and reuse of exhausted BCs are also considered. The results demonstrate that unmodified BCs possess low phosphate sorption capacity with the exception of BCs with high minerals content. As such, engineered BCs by decoration with different elements have been shown to alter the surface characteristics of the adsorbents such as surface charge, surface area, pore diameter, pore volume and the surface functional groups. Therefore, the phosphate sorption capacity of modified BCs has been significantly improved compared to unmodified adsorbents. Magnesium, aluminum, calcium and lanthanum were of significant interests for BC decoration due to their high affinity toward phosphate ions. Iron has been also widely used in BC composites for increasing the adsorption capacity of phosphate, in addition to providing an opportunity for magnetic recovery of the adsorbent. Based on this review, future research for BC applications in terms of phosphate removal is also discussed.`,

  "P14": `A heterogeneous catalyst is a backbone of modern sustainable green industries; and understanding the relationship between its structure and properties is the key for its advancement. Recently, many upscaling synthesis strategies for the development of a variety of respectable control atomically precise heterogeneous catalysts are reported and explored for various important applications in catalysis for energy and environmental remediation. Precise atomic-scale control of catalysts has allowed to significantly increase activity, selectivity, and in some cases stability. This approach has proved to be relevant in various energy and environmental related technologies such as fuel cell, chemical reactors for organic synthesis, and environmental remediation. Therefore, this review aims to critically analyze the recent progress on single-atom catalysts (SACs) application in oxygen reduction reaction, oxygen evolution reaction, hydrogen evolution reaction, and chemical and/or electrochemical organic transformations. Finally, opportunities that may open up in the future are summarized, along with suggesting new applications for possible exploitation of SACs.`,

  "P15": `Designing electrocatalysts with high-performance for both reduction and oxidation reactions faces severe challenges. Here, the uniform and ultrasmall (~3.4 nm) high-entropy alloys (HEAs) Pt18Ni26Fe15Co14Cu27 nanoparticles are synthesized by a simple low-temperature oil phase strategy at atmospheric pressure. The Pt18Ni26Fe15Co14Cu27/C catalyst exhibits excellent electrocatalytic performance for hydrogen evolution reaction (HER) and methanol oxidation reaction (MOR). The catalyst shows ultrasmall overpotential of 11 mV at the current density of 10 mA cm-2, excellent activity (10.96 A mg-1Pt at -0.07 V vs. reversible hydrogen electrode) and stability in the alkaline medium. Furthermore, it is also the efficient catalyst (15.04 A mg-1Pt) ever reported for MOR in alkaline solution. Periodic DFT calculations confirm the multi-active sites for both HER and MOR on the HEA surface as the key factor for both proton and intermediate transformation. Meanwhile, the construction of HEA surfaces supplies the fast site-to-site electron transfer for both reduction and oxidation processes.`,

  "P17": `Selective laser sintering (SLS) is a powder bed fusion technology that uses a laser source to melt selected regions of a polymer powder bed based on 3D model data. Components with complex geometry are then obtained using a layer-by-layer strategy. This additive manufacturing technology is a very complex process in which various multiphysical phenomena and different mechanisms occur and greatly influence both the quality and performance of printed parts. This review describes the physical phenomena involved in the SLS process such as powder spreading, the interaction between laser beam and powder bed, polymer melting, coalescence of fused powder and its densification, and polymer crystallization. Moreover, the main characterization approaches that can be useful to investigate the starting material properties are reported and discussed.`,

  "P18": `Improving the intrinsic film quality of metal halide perovskites is very critical to increase the power conversion efficiency and long-term stability of perovskite solar cells. Here we report a multifunctional, non-volatile additive that can be used to modulate the kinetics of perovskite film growth through a hydrogen-bond-bridged intermediate phase. The additive enables the formation of large perovskite grains and coherent grain growth from bottom to the surface of the film. The enhanced film morphology results in significantly reduced non-radiative recombinations, thus boosting the power conversion efficiency of inverted (p-i-n) solar cells to 24.8% (24.5% certified) with a low energy loss of 0.36 eV. The unencapsulated devices exhibit improved thermal stability with a T98 lifetime beyond 1,000 h under continuous heating at 65 +/- 5 C in a nitrogen-filled glovebox. This effective approach can also be applied to wide-bandgap perovskites and large-area devices to show reduced voltage loss and high efficiency.`,

  "P19": `Carbon nanotubes (CNTs), the one-dimensional allotropes of carbon, have attracted noteworthy research interest since their discovery in 1991 owing to their large aspect ratio, low mass density, and unique chemical, physical, and electronic properties that provide exciting possibilities for nanoscale applications. Nonetheless, two major issues should be considered when working with this sort of nanomaterial: their strong agglomerating tendency, since they are typically present as bundles or ropes of nanotubes, and the metallic impurities and carbonaceous fragments that go along with the CNTs. The successful utilization of CNTs in a wide variety of applications - in particular, in the field of polymer composites - depends on their uniform dispersion and the development of a strong chemical interaction with the polymeric matrix. To achieve these aims, chemical functionalization of their sidewalls and tips is required. In this article, a brief overview of the different approaches for CNT modification using polymers is provided, focusing on the covalent functionalization via "grafting to" or "grafting from" strategies. The characteristics and advantages of each approach are thoroughly discussed, including a few typical and recent examples. Moreover, applications of polymer-grafted CNTs as biosensors, membranes, energy storage substances, and EMI shielding are briefly described. Finally, future viewpoints in this vibrant research area are proposed.`,

  "P20": `Perovskites with exsolved nanoparticles (P-eNs) have immense potentials for carbon dioxide (CO2) reduction in solid oxide electrolysis cell. Despite the recent achievements in promoting the B-site cation exsolution for enhanced catalytic activities, the unsatisfactory stability of P-eNs at high voltages greatly impedes their practical applications and this issue has not been elucidated. In this study, we reveal that the formation of B-site vacancies in perovskite scaffold is the major contributor to the degradation of P-eNs; we then address this issue by fine-regulating the B-site supplement of the reduced Sr2Fe1.3Ni0.2Mo0.5O6-d using foreign Fe sources, achieving a robust perovskite scaffold and prolonged stability performance. Furthermore, the degradation mechanism from the perspective of structure stability of perovskite has also been proposed to understand the origins of performance deterioration. The B-site supplement endows P-eNs with the capability to become appealing electrocatalysts for CO2 reduction and more broadly, for other energy storage and conversion systems.`,
};

// =========================================================================
// SCHEMAS
// =========================================================================

const ONE_SHOT_INSTRUCTION =
  "Extract mentions of materials and the properties they have which are mentioned in the abstract.";
const TWO_SHOT_INSTRUCTION =
  "Extract mentions of materials and the properties they have which are mentioned in the abstract. Preserve conditions/qualifiers (e.g., under what conditions, in what device/cell, and with what measured values) when present.";
const ZERO_SHOT_INSTRUCTION =
  "Extract ONLY material names and their properties from the abstract. Do NOT include evidence.";

const BASIC_SCHEMA = {
  type: "object",
  properties: {
    items: { type: "array", items: { type: "object",
      properties: {
        material: { type: "string" },
        properties: { type: "array", items: { type: "string" } },
        evidence: { type: "array", items: { type: "string" } }
      },
      required: ["material", "properties"]
    }}
  },
  required: ["items"]
};

const CONTEXTUAL_SCHEMA = {
  type: "object",
  properties: {
    items: { type: "array", items: { type: "object",
      properties: {
        material: { type: "string" },
        entity_role: { type: "string" },
        properties: { type: "array", items: { type: "object",
          properties: {
            property: { type: "string" }, value: { type: "string" },
            unit: { type: "string" }, qualifier: { type: "string" },
            conditions: { type: "string" }, applies_to: { type: "string" },
            evidence: { type: "string" }
          },
          required: ["property"]
        }},
        evidence: { type: "array", items: { type: "string" } }
      },
      required: ["material", "properties"]
    }}
  },
  required: ["items"]
};

const ZERO_SHOT_SCHEMA = {
  type: "object",
  properties: {
    items: { type: "array", items: { type: "object",
      properties: {
        material: { type: "string" },
        properties: { type: "array", items: { type: "string" } }
      },
      required: ["material", "properties"]
    }}
  },
  required: ["items"]
};

function schemaForMode(mode) {
  if (mode === "two_shot") return CONTEXTUAL_SCHEMA;
  if (mode === "one_shot") return BASIC_SCHEMA;
  return ZERO_SHOT_SCHEMA;
}
function instructionForMode(mode) {
  if (mode === "two_shot") return TWO_SHOT_INSTRUCTION;
  if (mode === "one_shot") return ONE_SHOT_INSTRUCTION;
  return ZERO_SHOT_INSTRUCTION;
}

// =========================================================================
// HTTP helpers
// =========================================================================

async function postWithTimeout(url, body, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: controller.signal
    });
    const text = await r.text();
    clearTimeout(timer);
    try { return { ok: r.ok, status: r.status, data: JSON.parse(text) }; }
    catch { return { ok: r.ok, status: r.status, data: { raw: text } }; }
  } catch (err) {
    clearTimeout(timer);
    return { ok: false, status: 0, data: { error: String(err?.message || err) } };
  }
}

async function extractOne(paper, mode) {
  const abstract = ABSTRACTS[paper.id];
  if (!abstract) throw new Error(`No abstract supplied for ${paper.id}`);
  const prompt = `DOCUMENT TEXT:\n${abstract}\n\nTASK:\n${instructionForMode(mode)}`;
  const r = await postWithTimeout(`${API_BASE}/extract_json`, {
    provider: "openai",
    mode, retrieval_mode: "abstract_only", prompt,
    schema: schemaForMode(mode)
  }, PIPELINE_TIMEOUT_MS);
  return { extraction: r.data, paper_text: abstract };
}

async function runPipelineOne(kb, paper_text, answerProvider) {
  const r = await postWithTimeout(`${API_BASE}/compare_paths`, {
    kb, paper_text, answer_provider: answerProvider
  }, PIPELINE_TIMEOUT_MS);
  return r.data;
}

// =========================================================================
// One full batch (mode + provider)
// =========================================================================

async function runOneBatch(mode, answerProvider) {
  const t0 = Date.now();
  const results = [];

  for (let i = 0; i < PAPERS.length; i++) {
    const paper = PAPERS[i];
    const tag = `[${mode}/${answerProvider}] [${i + 1}/${PAPERS.length}] ${paper.id}`;

    let extractRes, kb, paper_text;
    try {
      const out = await extractOne(paper, mode);
      extractRes = out.extraction;
      paper_text = out.paper_text;
      kb = extractRes?.result;
      if (!kb || !Array.isArray(kb.items)) throw new Error("Extraction returned no items");
      console.log(`${tag} - extracted ${kb.items.length} items`);
    } catch (err) {
      console.error(`${tag} - extraction FAILED: ${err.message}`);
      results.push({ paper, stage: "extraction", ok: false, error: String(err?.message || err) });
      continue;
    }

    let pipelineRes;
    try {
      pipelineRes = await runPipelineOne(kb, paper_text, answerProvider);
      if (!pipelineRes?.ok) throw new Error(pipelineRes?.error || "pipeline returned not ok");
    } catch (err) {
      console.error(`${tag} - pipeline FAILED: ${err.message}`);
      results.push({ paper, kb, stage: "pipeline", ok: false, error: String(err?.message || err) });
      continue;
    }

    const c = pipelineRes.counts || {};
    console.log(`${tag} - done. agree=${c.agree || 0}  disagree=${c.disagree || 0}  kb_silent=${c.kb_silent || 0}  error=${c.error || 0}`);
    results.push({ paper, ok: true, extraction: extractRes, pipeline: pipelineRes });
  }

  // Save batch
  const outDir = "results";
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = path.join(outDir, `qa_batch_${mode}_${answerProvider}_${stamp}.json`);
  fs.writeFileSync(outPath, JSON.stringify({
    config: { EXTRACTION_MODE: mode, ANSWER_PROVIDER: answerProvider, INPUT_MODE: "abstracts", n_papers: PAPERS.length },
    elapsed_seconds: Math.round((Date.now() - t0) / 1000),
    results
  }, null, 2));
  console.log(`>>> Saved ${outPath} (elapsed ${Math.round((Date.now() - t0) / 1000)}s)\n`);
  return outPath;
}

// =========================================================================
// Main: loop through every combination
// =========================================================================

async function main() {
  console.log(`Overnight run: ${MODES.length} modes x ${PATH_A_PROVIDERS.length} providers = ${MODES.length * PATH_A_PROVIDERS.length} batches`);
  console.log(`Papers per batch: ${PAPERS.length}`);
  console.log(`Total questions per batch: ${PAPERS.length * 8}`);
  console.log(`Started at: ${new Date().toLocaleString()}`);

  const grandStart = Date.now();
  const summary = [];

  for (const mode of MODES) {
    for (const provider of PATH_A_PROVIDERS) {
      console.log(`\n${"=".repeat(60)}`);
      console.log(`STARTING BATCH: mode=${mode}  provider=${provider}`);
      console.log(`Started at: ${new Date().toLocaleString()}`);
      console.log("=".repeat(60));

      try {
        const outPath = await runOneBatch(mode, provider);
        summary.push({ mode, provider, ok: true, path: outPath });
      } catch (err) {
        console.error(`!!! BATCH CRASHED: mode=${mode} provider=${provider}: ${err.message}`);
        summary.push({ mode, provider, ok: false, error: String(err?.message || err) });
      }

      // Polite pause between batches
      if (DELAY_BETWEEN_BATCHES_MS > 0) {
        console.log(`(pausing ${DELAY_BETWEEN_BATCHES_MS / 1000}s before next batch...)`);
        await new Promise(r => setTimeout(r, DELAY_BETWEEN_BATCHES_MS));
      }
    }
  }

  const totalSec = Math.round((Date.now() - grandStart) / 1000);
  const summaryPath = path.join("results", `overnight_summary_${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(summaryPath, JSON.stringify({
    started: new Date(grandStart).toISOString(),
    finished: new Date().toISOString(),
    total_elapsed_seconds: totalSec,
    n_batches: summary.length,
    n_succeeded: summary.filter(x => x.ok).length,
    summary
  }, null, 2));

  console.log(`\n${"=".repeat(60)}`);
  console.log(`ALL DONE. Total elapsed: ${Math.round(totalSec / 60)} min (${totalSec}s)`);
  console.log(`Successful batches: ${summary.filter(x => x.ok).length}/${summary.length}`);
  console.log(`Summary written to ${summaryPath}`);
  console.log("=".repeat(60));
}

main().catch(err => { console.error(err); process.exit(1); });
