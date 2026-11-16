import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import AdmZip from 'adm-zip';
import { seedOfficeProductionFixture, inspectOfficeProductionArtifacts } from '../../../eval/model-eval/regression/office-production-fixtures';

import { describe, expect, it } from 'vitest';

const AGENT_ID = 'a19101ba698a';
const agentDir = path.join(process.cwd(), 'resources', 'builtin', 'marketplace', 'agents', AGENT_ID);
const excelSkillPath = path.join(
  process.cwd(),
  'resources',
  'builtin',
  'marketplace',
  'skills',
  '081c15ffbab4',
  'SKILL.md',
);

describe('OfficeWorker built-in agent evaluation', () => {
  it('requires one built-in creation route with native charts for a new workbook', () => {
    const agent = JSON.parse(fs.readFileSync(path.join(agentDir, 'agent.json'), 'utf8')) as {
      description_zh: string;
      description_en: string;
      workflow: string;
      standards: string[];
      skill_list: string[];
    };
    const excelSkill = fs.readFileSync(excelSkillPath, 'utf8');
    const standards = agent.standards.join('\n');
    const surface = [agent.workflow, standards, excelSkill].join('\n');

    expect(agent.skill_list).toContain('081c15ffbab4');
    expect(agent.workflow).toContain('Resolve attachments before asking for files');
    expect(agent.workflow).toContain('call `search_files` once');
    expect(agent.workflow).toContain('narrow literal extension `include_glob`');
    expect(agent.workflow).toContain('never search by semantic topic');
    expect(agent.workflow).toContain('publish an empty output set');
    expect(surface).toContain('literal extension');
    // a9ab42a49 dropped the examples and kept the prohibition, so bind the rule:
    // an unknown source is found by extension, never by what it is about.
    expect(surface).toMatch(/never search by semantic topic/i);
    expect(surface).toContain('`query:*` and a narrow literal extension `include_glob`');
    expect(surface).toContain('Calling `create_xlsx` is mandatory');
    expect(surface).toContain('must not construct, rewrite, or patch the final `.xlsx` package');
    expect(standards).toContain('one current final file per requested artifact');
    expect(surface).toContain('visible editable `假设与参数` block');
    expect(surface).toContain('native editable chart objects');
    expect(surface).toContain('does not satisfy a chart request');
    expect(excelSkill).toContain('Calling `create_xlsx` is mandatory');
    expect(excelSkill).toContain('must not construct, rewrite, or patch the final `.xlsx` package');
    expect(excelSkill).toContain('retry_available:true');
    expect(excelSkill).toContain('retry once');
    expect(excelSkill).toContain('deleted successful artifact');
    expect(excelSkill).toContain('do not change filenames');
    expect(excelSkill).toContain('Do not restart with a second `create_xlsx`');
    expect(excelSkill).toContain('visible editable `假设与参数` block or sheet');
    expect(excelSkill).toContain('never leave assumptions only in the chat handoff');
    expect(excelSkill).toContain('native editable chart objects');
    expect(excelSkill).toContain('does not satisfy a chart request');
    expect(excelSkill).toContain('Never plot measures with different units');
    expect(excelSkill).toContain('category/value source ranges');
    expect(excelSkill).toContain('`artifact_path` in the latest create/edit `<office-artifact>` receipt');
    expect(excelSkill).toContain('Do not repeat `office_review` for an unchanged `artifact_revision`');
    expect(excelSkill).toContain('concrete blocking defect and a targeted repair');
    expect(excelSkill).toContain('Pass `preview:false` when the required `office_review` will provide the visual evidence');
    expect(excelSkill).toContain('with one `targets` array to batch-check representative formulas');
    expect(excelSkill).toContain('`mode:"text"` exposes displayed values, not formula definitions');
    expect(excelSkill).toContain('For a new workbook, reuse the sheet order supplied to `create_xlsx`');
  });

  it('owns both single Word and single Excel deliverables after specialist retirement', () => {
    const agent = JSON.parse(fs.readFileSync(path.join(agentDir, 'agent.json'), 'utf8')) as {
      description_zh: string;
      description_en: string;
      workflow: string;
      skill_list: string[];
    };

    for (const description of [agent.description_zh, agent.description_en]) {
      expect(description).toContain('Word/DOCX');
      expect(description).toContain('Excel/XLSX');
    }
    expect(agent.description_zh).toContain('创建、读取、编辑、检查和批量处理');
    expect(agent.description_en).toContain('Creates, reads, edits, checks and batch-processes');
    expect(agent.description_en).not.toContain('specialist agent for a single Word, Excel');
    expect(agent.workflow).toContain('Single or multiple supported Office files stay here');
    expect(agent.workflow).toContain('`office-word`');
    expect(agent.workflow).toContain('`office-excel`');
    expect(agent.workflow).not.toContain('`office-formatting`');
    expect(agent.skill_list).toEqual(expect.arrayContaining(['c72c656eca12', '081c15ffbab4']));
  });
});


describe("portable Office artifact fixture observations", () => {
  it("binds mixed-source judgment to frozen inputs and observed slide, table and indexed chart content", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "orkas-ppt-fact-observation-"));
    try {
      const fixture = await seedOfficeProductionFixture("ppt-mixed-source-executive-update", root);
      const source = fs.readFileSync(path.join(root, "metrics.csv"), "utf8");
      const deck = new AdmZip();
      deck.addFile("ppt/slides/slide1.xml", Buffer.from([
        '<p:sld><p:sp><p:txBody><a:p><a:r><a:t>2025 华东</a:t></a:r><a:r><a:t>实际营收42万元</a:t></a:r></a:p></p:txBody></p:sp>',
        '<a:tbl><a:tr><a:tc><a:p><a:r><a:t>华北</a:t></a:r></a:p></a:tc><a:tc><a:p><a:r><a:t>72</a:t></a:r></a:p></a:tc></a:tr></a:tbl>',
        '<c:chart r:id="rIdChart"/></p:sld>',
      ].join('')));
      deck.addFile("ppt/slides/_rels/slide1.xml.rels", Buffer.from('<Relationships><Relationship Id="rIdChart" Target="../charts/chart1.xml"/></Relationships>'));
      // The source supplies East=72 / North=42. Preserve the WRONG observed
      // associations for the independent judge; never replace them with truth.
      deck.addFile("ppt/charts/chart1.xml", Buffer.from('<c:chartSpace><c:chart><c:plotArea><c:barChart><c:ser><c:tx><c:v>2025 实际营收（万元）</c:v></c:tx><c:cat><c:strLit><c:pt idx="1"><c:v>华北</c:v></c:pt><c:pt idx="0"><c:v>华东</c:v></c:pt></c:strLit></c:cat><c:val><c:numLit><c:pt idx="0"><c:v>42</c:v></c:pt><c:pt idx="1"><c:v>72</c:v></c:pt></c:numLit></c:val></c:ser></c:barChart></c:plotArea></c:chart></c:chartSpace>'));
      deck.addFile("ppt/charts/orphan.xml", Buffer.from('<c:chartSpace><a:t>ORPHAN-NOT-ON-A-SLIDE</a:t></c:chartSpace>'));
      deck.writeZip(path.join(root, "result.pptx"));
      fs.writeFileSync(path.join(root, "metrics.csv"), source.replace('华东,72', '华东,42'));
      const observed = await inspectOfficeProductionArtifacts(root, ["result.pptx"], fixture);
      const reference = observed.evidence.find(line => line.startsWith('pptx_source_reference='))!;
      expect(JSON.parse(reference.split('=').slice(1).join('')).metrics).toBe(source);
      expect(observed.features).not.toContain('source-fixtures-preserved');
      expect(observed.features).toContain('pptx-source-grounding-evidence-complete');
      expect(observed.features).not.toContain('pptx-source-pack-facts-preserved');
      const units = observed.evidence.filter(line => line.startsWith('pptx_observed='))
        .map(line => JSON.parse(line.slice('pptx_observed='.length)));
      expect(units.some(unit => unit.kind === 'text' && unit.content.includes('2025 华东实际营收42万元'))).toBe(true);
      expect(units.some(unit => unit.kind === 'table' && unit.content[0].join(' ') === '华北 72')).toBe(true);
      const chart = units.find(unit => unit.kind === 'chart');
      expect(chart.part).toBe('ppt/charts/chart1.xml');
      expect(JSON.stringify(chart.content)).toContain('"@_idx":"0"');
      expect(JSON.stringify(chart.content)).toContain('"v":"42"');
      expect(observed.evidence.join('\n')).not.toContain('ORPHAN-NOT-ON-A-SLIDE');
      expect(new Set(units.map(unit => unit.sha256)).size).toBe(1);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("keeps oversized or unresolved PPT evidence incomplete instead of granting a facts pass", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "orkas-ppt-fact-unavailable-"));
    try {
      const fixture = await seedOfficeProductionFixture("ppt-mixed-source-executive-update", root);
      for (const [name, xml] of [
        ['oversized', '<p:sld>' + 'x'.repeat(128 * 1024) + '</p:sld>'],
        ['unresolved-chart', '<p:sld><c:chart r:id="missing"/></p:sld>'],
      ]) {
        const zip = new AdmZip(); zip.addFile('ppt/slides/slide1.xml', Buffer.from(xml));
        zip.writeZip(path.join(root, name + '.pptx'));
        const result = await inspectOfficeProductionArtifacts(root, [name + '.pptx'], fixture);
        expect(result.features).not.toContain('pptx-source-grounding-evidence-complete');
        expect(result.evidence.join(' ')).toContain('pptx_observation_incomplete');
      }
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("bounds source observations at the XML part limit without treating padding as content", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "orkas-ppt-fact-part-boundary-"));
    try {
      const fixture = await seedOfficeProductionFixture("ppt-mixed-source-executive-update", root);
      const head = '<p:sld><p:sp><a:p><a:r><a:t>Observed content</a:t></a:r></a:p></p:sp><!--';
      const tail = '--></p:sld>';
      for (const delta of [-1, 0, 1]) {
        const xml = head + 'x'.repeat(128 * 1024 + delta - head.length - tail.length) + tail;
        const zip = new AdmZip(); zip.addFile('ppt/slides/slide1.xml', Buffer.from(xml));
        zip.writeZip(path.join(root, 'boundary.pptx'));
        const result = await inspectOfficeProductionArtifacts(root, ['boundary.pptx'], fixture);
        expect(result.features.includes('pptx-source-grounding-evidence-complete')).toBe(delta <= 0);
      }
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it.each(['invalid-xml', 'entity-declaration', 'external-chart', 'oversized-observation'])
  ('does not certify unavailable %s source evidence', async kind => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "orkas-ppt-fact-invalid-"));
    try {
      const fixture = await seedOfficeProductionFixture("ppt-mixed-source-executive-update", root);
      const zip = new AdmZip();
      const xml = kind === 'invalid-xml' ? '<p:sld><p:sp></p:sld>'
        : kind === 'entity-declaration' ? '<!DOCTYPE sld [<!ENTITY x "expected fact">]><p:sld><p:sp><a:p><a:t>&x;</a:t></a:p></p:sp></p:sld>'
        : kind === 'external-chart' ? '<p:sld><c:chart r:id="external"/></p:sld>'
        : '<p:sld><p:sp><a:p><a:t>' + 'x'.repeat(14000) + '</a:t></a:p></p:sp></p:sld>';
      zip.addFile('ppt/slides/slide1.xml', Buffer.from(xml));
      if (kind === 'external-chart') zip.addFile('ppt/slides/_rels/slide1.xml.rels', Buffer.from('<Relationships><Relationship Id="external" Target="https://example.invalid/chart.xml" TargetMode="External"/></Relationships>'));
      zip.writeZip(path.join(root, 'invalid.pptx'));
      const result = await inspectOfficeProductionArtifacts(root, ['invalid.pptx'], fixture);
      expect(result.features).not.toContain('pptx-source-grounding-evidence-complete');
      expect(result.evidence.join(' ')).toContain('pptx_observation_incomplete');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

});


interface BoundedRedesignRun {
  text: string;
  size?: number;
  color?: string;
}

function boundedRedesignRun({ text, size, color }: BoundedRedesignRun): string {
  const sizeAttr = size ? ` sz="${size}"` : "";
  const fill = color
    ? `<a:solidFill><a:srgbClr val="${color}"/></a:solidFill>`
    : "";
  return `<a:r><a:rPr${sizeAttr}>${fill}</a:rPr><a:t>${text}</a:t></a:r>`;
}

function boundedRedesignShape(
  id: number,
  name: string,
  runs: readonly BoundedRedesignRun[],
  placeholderType?: "title" | "body",
): string {
  const placeholder = placeholderType ? `<p:ph type="${placeholderType}"/>` : "";
  return [
    "<p:sp>",
    `<p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr/><p:nvPr>${placeholder}</p:nvPr></p:nvSpPr>`,
    `<p:txBody><a:p>${runs.map(boundedRedesignRun).join("")}</a:p></p:txBody>`,
    "</p:sp>",
  ].join("");
}

function writeBoundedRedesignDeck(
  root: string,
  name: string,
  slide4TitleRuns: readonly BoundedRedesignRun[],
  companyLabelRun: BoundedRedesignRun = { text: "星河科技有限公司", size: 900, color: "777777" },
): void {
  const slides: Array<{
    title: readonly BoundedRedesignRun[];
    body: string;
    extra?: BoundedRedesignRun;
  }> = [
    { title: [{ text: "年度经营复盘" }], body: "管理层摘要" },
    {
      title: [{ text: "核心指标｜增长质量", size: 2800, color: "17365D" }],
      body: "收入与利润趋势",
    },
    { title: [{ text: "区域表现" }], body: "重点市场进展" },
    { title: slide4TitleRuns, body: "下一季度重点", extra: companyLabelRun },
    { title: [{ text: "风险与依赖" }], body: "待管理层决策" },
  ];
  const deck = new AdmZip();
  deck.addFile("ppt/slideMasters/slideMaster1.xml", Buffer.from("<p:sldMaster/>"));
  deck.addFile(
    "ppt/notesSlides/notesSlide1.xml",
    Buffer.from("<p:notes><a:t>保留备注</a:t></p:notes>"),
  );
  for (const [index, slide] of slides.entries()) {
    const shapes = [
      boundedRedesignShape(2, "Title", slide.title, "title"),
      boundedRedesignShape(3, "Content", [{ text: slide.body }], "body"),
      ...(slide.extra ? [boundedRedesignShape(100000, "Company", [slide.extra])] : []),
    ].join("");
    deck.addFile(
      `ppt/slides/slide${index + 1}.xml`,
      Buffer.from(`<p:sld><p:cSld><p:spTree>${shapes}</p:spTree></p:cSld></p:sld>`),
    );
  }
  deck.writeZip(path.join(root, name));
}


describe("portable PPTX structure and preservation fixtures", () => {
  it("derives PptMaker editability from PPTX slide XML instead of delivery prose", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "orkas-e2e-pptx-feature-"));
    try {
      const editable = new AdmZip();
      editable.addFile("ppt/slideMasters/slideMaster1.xml", Buffer.from("<p:sldMaster/>"));
      for (let index = 1; index <= 8; index += 1) {
        const shapeCount = 2 + (index % 4);
        const shapes = Array.from({ length: shapeCount }, (_, shapeIndex) => {
          const x = (index % 4) * 1_000_000 + shapeIndex * 500_000;
          const y = Math.floor((index - 1) / 4) * 1_000_000 + shapeIndex * 350_000;
          const size = shapeIndex === 0 ? 3200 : 1800;
          return `<p:sp><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="2000000" cy="500000"/></a:xfrm></p:spPr><p:txBody><a:p><a:r><a:rPr sz="${size}"/><a:t>Slide ${index} item ${shapeIndex + 1}</a:t></a:r></a:p></p:txBody></p:sp>`;
        }).join("");
        editable.addFile(
          `ppt/slides/slide${index}.xml`,
          Buffer.from(
            `<p:sld><p:cSld><p:spTree>${shapes}</p:spTree></p:cSld></p:sld>`,
          ),
        );
      }
      editable.writeZip(path.join(root, "editable.pptx"));

      const flattened = new AdmZip();
      for (let index = 1; index <= 8; index += 1) {
        flattened.addFile(
          `ppt/slides/slide${index}.xml`,
          Buffer.from("<p:sld><p:cSld><p:spTree><p:pic/></p:spTree></p:cSld></p:sld>"),
        );
      }
      flattened.writeZip(path.join(root, "flattened.pptx"));

      const editableInspection = await inspectOfficeProductionArtifacts(
        root,
        ["editable.pptx"],
        { baselineFiles: [], sourceHashes: {} },
      );
      expect(editableInspection.features).toEqual(expect.arrayContaining([
        "pptx-valid-package",
        "pptx-eight-slides",
        "pptx-native-editable-content",
        "pptx-no-image-only-slides",
        "pptx-layout-variety",
        "pptx-explicit-type-hierarchy",
      ]));
      expect(editableInspection.evidence.join("\n"))
        .toContain("slides=8 notes=0 masters=1 editableTextSlides=8 nativeShapeSlides=8 imageOnlySlides=0 rawRecordDumpSlides=0 layoutSignatures=8 hierarchySlides=8");

      const flattenedInspection = await inspectOfficeProductionArtifacts(
        root,
        ["flattened.pptx"],
        { baselineFiles: [], sourceHashes: {} },
      );
      expect(flattenedInspection.features).toContain("pptx-eight-slides");
      expect(flattenedInspection.features).not.toContain("pptx-native-editable-content");
      expect(flattenedInspection.features).not.toContain("pptx-no-image-only-slides");

      const groundedSixSlides = new AdmZip();
      const labels = "2025 2026 目标 210 万元 华东 华南 华北 安全评审 CRM";
      for (let index = 1; index <= 6; index += 1) {
        const x = (index % 4) * 900_000;
        groundedSixSlides.addFile(
          `ppt/slides/slide${index}.xml`,
          Buffer.from([
            "<p:sld><p:cSld><p:spTree>",
            `<p:sp><p:spPr><a:xfrm><a:off x="${x}" y="${index * 100_000}"/></a:xfrm></p:spPr><p:txBody><a:p><a:r><a:rPr sz="3200"/><a:t>${labels}</a:t></a:r><a:r><a:rPr sz="1800"/><a:t>slide ${index}</a:t></a:r></a:p></p:txBody></p:sp>`,
            "</p:spTree></p:cSld></p:sld>",
          ].join("")),
        );
      }
      groundedSixSlides.addFile(
        "ppt/charts/chart1.xml",
        Buffer.from("<c:chart>" + [120, 138, 151, 169, 72, 55, 42]
          .map((value) => `<c:v>${value}</c:v>`).join("") + "</c:chart>"),
      );
      groundedSixSlides.writeZip(path.join(root, "grounded-six-slides.pptx"));
      const groundedInspection = await inspectOfficeProductionArtifacts(
        root,
        ["grounded-six-slides.pptx"],
        { baselineFiles: [], sourceHashes: {} },
      );
      expect(groundedInspection.features).toEqual(expect.arrayContaining([
        "pptx-six-slides",
        "pptx-native-editable-content",
        "pptx-layout-variety",
        "pptx-explicit-type-hierarchy",
        "pptx-source-pack-terms-present",
      ]));
      // Negative control for the dump check below: the same facts, carried as
      // labels and chart values, must not read as a source dump.
      expect(groundedInspection.features).toContain("pptx-no-raw-record-dump");

      // 2026-08-09 ppt-mixed-source-executive-update: the deck passed every
      // artifact feature while its cover held the source pack verbatim — eight
      // rows shaped `实际｜2025-Q1｜全部｜120 万元｜已核验` — and the aesthetic
      // judge scored it 73. Preserving the facts and presenting them are
      // different properties; the facts check cannot see the difference, so a
      // deck that satisfies it by pasting must fail on its own signal.
      const dumpedSourcePack = new AdmZip();
      const dumpRows = [
        "实际｜2025-Q1｜全部｜120 万元｜已核验",
        "实际｜2025-Q2｜全部｜138 万元｜已核验",
        "实际｜2025-Q3｜全部｜151 万元｜已核验",
        "实际｜2025-Q4｜全部｜169 万元｜已核验",
        "目标｜2026｜全部｜210 万元｜已核验",
        "实际｜2025｜华东｜72 万元｜已核验",
        "实际｜2025｜华南｜55 万元｜已核验",
        "实际｜2025｜华北｜42 万元｜已核验",
      ];
      for (let index = 1; index <= 6; index += 1) {
        const x = (index % 4) * 900_000;
        const body = index === 1
          ? dumpRows
            .map((row) => `<a:p><a:r><a:rPr sz="1200"/><a:t>${row}</a:t></a:r></a:p>`)
            .join("")
          : `<a:p><a:r><a:rPr sz="3200"/><a:t>${labels}</a:t></a:r><a:r><a:rPr sz="1800"/><a:t>slide ${index}</a:t></a:r></a:p>`;
        dumpedSourcePack.addFile(
          `ppt/slides/slide${index}.xml`,
          Buffer.from([
            "<p:sld><p:cSld><p:spTree>",
            `<p:sp><p:spPr><a:xfrm><a:off x="${x}" y="${index * 100_000}"/></a:xfrm></p:spPr><p:txBody>${body}</p:txBody></p:sp>`,
            "</p:spTree></p:cSld></p:sld>",
          ].join("")),
        );
      }
      dumpedSourcePack.writeZip(path.join(root, "dumped-source-pack.pptx"));
      const dumpedInspection = await inspectOfficeProductionArtifacts(
        root,
        ["dumped-source-pack.pptx"],
        { baselineFiles: [], sourceHashes: {} },
      );
      // Lexical presence still detects missing terms. Relationship judgment
      // and source-dump presentation remain independent acceptance signals.
      expect(dumpedInspection.features).toContain("pptx-source-pack-terms-present");
      expect(dumpedInspection.features).not.toContain("pptx-no-raw-record-dump");
      expect(dumpedInspection.evidence.join(" ")).toContain("rawRecordDumpSlides=1");

      // A real table carrying the same rows is presentation, not a dump: its
      // cells are separate paragraphs, so no line looks like a record.
      const tabulatedSourcePack = new AdmZip();
      for (let index = 1; index <= 6; index += 1) {
        const x = (index % 4) * 900_000;
        const body = index === 1
          ? `<p:graphicFrame><a:tbl>${dumpRows.map((row) => `<a:tr>${row
            .split("｜")
            .map((cell) => `<a:tc><a:txBody><a:p><a:r><a:rPr sz="1200"/><a:t>${cell}</a:t></a:r></a:p></a:txBody></a:tc>`)
            .join("")}</a:tr>`).join("")}</a:tbl></p:graphicFrame>`
          : `<p:sp><p:spPr><a:xfrm><a:off x="${x}" y="${index * 100_000}"/></a:xfrm></p:spPr><p:txBody><a:p><a:r><a:rPr sz="3200"/><a:t>${labels}</a:t></a:r><a:r><a:rPr sz="1800"/><a:t>slide ${index}</a:t></a:r></a:p></p:txBody></p:sp>`;
        tabulatedSourcePack.addFile(
          `ppt/slides/slide${index}.xml`,
          Buffer.from(`<p:sld><p:cSld><p:spTree>${body}</p:spTree></p:cSld></p:sld>`),
        );
      }
      tabulatedSourcePack.writeZip(path.join(root, "tabulated-source-pack.pptx"));
      const tabulatedInspection = await inspectOfficeProductionArtifacts(
        root,
        ["tabulated-source-pack.pptx"],
        { baselineFiles: [], sourceHashes: {} },
      );
      expect(tabulatedInspection.features).toContain("pptx-source-pack-terms-present");
      expect(tabulatedInspection.features).toContain("pptx-no-raw-record-dump");

      const updatedCopy = new AdmZip();
      updatedCopy.addFile("ppt/slideMasters/slideMaster1.xml", Buffer.from("<p:sldMaster/>"));
      updatedCopy.addFile("ppt/notesSlides/notesSlide1.xml", Buffer.from("<p:notes><a:t>保留备注</a:t></p:notes>"));
      for (let index = 1; index <= 5; index += 1) {
        updatedCopy.addFile(
          `ppt/slides/slide${index}.xml`,
          Buffer.from(`<p:sld><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${index === 4 ? "星河科技有限公司" : `页面 ${index}`}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`),
        );
      }
      updatedCopy.writeZip(path.join(root, "updated-copy.pptx"));
      const updatedInspection = await inspectOfficeProductionArtifacts(
        root,
        ["updated-copy.pptx"],
        { baselineFiles: [], sourceHashes: {} },
      );
      expect(updatedInspection.features).toEqual(expect.arrayContaining([
        "pptx-five-slides",
        "pptx-notes-preserved",
        "pptx-master-preserved",
        "pptx-old-label-removed",
        "pptx-company-label-updated",
      ]));

      const iterationDeck = (owner: string, name: string): string => {
        const zip = new AdmZip();
        for (let index = 1; index <= 4; index += 1) {
          zip.addFile(
            `ppt/slides/slide${index}.xml`,
            Buffer.from(`<p:sld><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:rPr sz="2800"/><a:t>北辰计划 9 月 15 日 预算不超过 30 万元 ${owner}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`),
          );
        }
        const file = path.join(root, name);
        zip.writeZip(file);
        return file;
      };
      iterationDeck("负责人：产品运营组", "iteration-initial.pptx");
      const initialIterationInspection = await inspectOfficeProductionArtifacts(
        root,
        ["iteration-initial.pptx"],
        { baselineFiles: [], sourceHashes: {} },
      );
      expect(initialIterationInspection.features).toEqual(expect.arrayContaining([
        "pptx-four-slides",
        "pptx-native-editable-content",
        "pptx-initial-owner-label",
      ]));

      iterationDeck("负责人：客户成功组", "iteration-revised.pptx");
      const revisedIterationInspection = await inspectOfficeProductionArtifacts(
        root,
        ["iteration-revised.pptx"],
        { baselineFiles: [], sourceHashes: {} },
      );
      expect(revisedIterationInspection.features).toEqual(expect.arrayContaining([
        "pptx-four-slides",
        "pptx-follow-up-owner-updated",
      ]));
      expect(revisedIterationInspection.features).not.toContain("pptx-initial-owner-label");

      writeBoundedRedesignDeck(
        root,
        "bounded-redesign.pptx",
        [{ text: "行动计划", size: 2800, color: "17365D" }],
      );
      const redesignInspection = await inspectOfficeProductionArtifacts(
        root,
        ["bounded-redesign.pptx"],
        { baselineFiles: [], sourceHashes: {} },
      );
      expect(redesignInspection.features).toEqual(expect.arrayContaining([
        "pptx-five-slides",
        "pptx-notes-preserved",
        "pptx-master-preserved",
        "pptx-bounded-redesign-facts-preserved",
        "pptx-bounded-redesign-content-updated",
        "pptx-bounded-redesign-style-updated",
      ]));

      const strictTemplateOutput = new AdmZip();
      strictTemplateOutput.addFile("ppt/slideMasters/slideMaster1.xml", Buffer.from("<p:sldMaster/>"));
      const templateFacts = [
        "启明计划 客户挑战 流程分散 信息重复录入 决策链路长",
        "方案框架 统一入口 智能协同 过程可追踪 实施路径 准备 试点 推广",
        "成功指标 采用率 处理时长 满意度 下一步 确认试点范围",
      ].join(" ");
      for (let index = 1; index <= 6; index += 1) {
        strictTemplateOutput.addFile(
          `ppt/slides/slide${index}.xml`,
          Buffer.from(`<p:sld><p:cSld><p:spTree><p:sp><p:spPr><a:xfrm><a:off x="${index * 100000}" y="${index * 120000}"/></a:xfrm></p:spPr><p:txBody><a:p><a:r><a:rPr sz="3200"/><a:t>${templateFacts}</a:t></a:r><a:r><a:rPr sz="1800"/><a:t>Page ${index}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`),
        );
      }
      strictTemplateOutput.writeZip(path.join(root, "strict-template-output.pptx"));
      const strictTemplateInspection = await inspectOfficeProductionArtifacts(
        root,
        ["strict-template-output.pptx"],
        { baselineFiles: [], sourceHashes: {} },
      );
      expect(strictTemplateInspection.features).toEqual(expect.arrayContaining([
        "pptx-six-slides",
        "pptx-master-preserved",
        "pptx-reference-template-facts-preserved",
      ]));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("binds bounded-redesign style evidence to every run of the requested title", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "orkas-e2e-ppt-title-style-"));
    try {
      writeBoundedRedesignDeck(
        root,
        "wrong-object.pptx",
        [{ text: "行动计划", size: 4400, color: "000000" }],
        { text: "星河科技有限公司", size: 2800, color: "17365D" },
      );
      const wrongObject = await inspectOfficeProductionArtifacts(
        root,
        ["wrong-object.pptx"],
        { baselineFiles: [], sourceHashes: {} },
      );
      expect(wrongObject.features).toContain("pptx-bounded-redesign-content-updated");
      expect(wrongObject.features).not.toContain("pptx-bounded-redesign-style-updated");

      writeBoundedRedesignDeck(
        root,
        "mixed-title-runs.pptx",
        [
          { text: "行动", size: 2800, color: "17365D" },
          { text: "计划", size: 2800, color: "000000" },
        ],
      );
      const mixedRuns = await inspectOfficeProductionArtifacts(
        root,
        ["mixed-title-runs.pptx"],
        { baselineFiles: [], sourceHashes: {} },
      );
      expect(mixedRuns.features).toContain("pptx-bounded-redesign-content-updated");
      expect(mixedRuns.features).not.toContain("pptx-bounded-redesign-style-updated");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("compares protected PPTX package parts instead of trusting preservation prose", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "orkas-e2e-ppt-preservation-"));
    try {
      const writeDeck = (
        name: string,
        options: {
          keepTarget?: boolean;
          keepMotion?: boolean;
          master?: string;
          slide2?: string;
          slide4?: string;
          notes?: string;
          presentation?: string;
          relationship?: string;
          media?: string;
          hoistDrawingNamespace?: boolean;
          wrongDrawingNamespace?: boolean;
          includeUnmarkedExtraShape?: boolean;
        } = {},
      ): void => {
        const zip = new AdmZip();
        zip.addFile(
          "ppt/slideMasters/slideMaster1.xml",
          Buffer.from(options.master ?? "<p:sldMaster><p:cSld/></p:sldMaster>"),
        );
        zip.addFile("ppt/slideLayouts/slideLayout1.xml", Buffer.from("<p:sldLayout/>"));
        zip.addFile("ppt/theme/theme1.xml", Buffer.from("<a:theme/>"));
        zip.addFile(
          "ppt/notesSlides/notesSlide1.xml",
          Buffer.from(options.notes ?? "<p:notes><a:t>保留备注</a:t></p:notes>"),
        );
        zip.addFile(
          "ppt/presentation.xml",
          Buffer.from(options.presentation ?? "<p:presentation><p:sldIdLst/></p:presentation>"),
        );
        zip.addFile("ppt/_rels/presentation.xml.rels", Buffer.from("<Relationships/>"));
        zip.addFile(
          "ppt/slides/_rels/slide4.xml.rels",
          Buffer.from(options.relationship ?? '<Relationships><Relationship Id="rId1" Target="../slideLayouts/slideLayout1.xml"/></Relationships>'),
        );
        zip.addFile("ppt/media/logo.bin", Buffer.from(options.media ?? "preserved-media"));
        zip.addFile("ppt/embeddings/data.bin", Buffer.from("preserved-embedding"));
        for (let slide = 1; slide <= 5; slide += 1) {
          const text = slide === 2
            ? options.slide2 ?? "页面 2"
            : slide === 4
              ? options.slide4 ?? "行动计划"
              : `页面 ${slide}`;
          const target = slide === 4 && options.keepTarget
            ? "<p:sp><p:txBody><a:p><a:r><a:t>旧公司名称</a:t></a:r></a:p></p:txBody></p:sp>"
            : "";
          const unmarkedExtraShape = options.includeUnmarkedExtraShape && slide === 2
            ? '<p:sp><p:txBody><a:p><a:r><a:t>unexpected shape</a:t></a:r></a:p></p:txBody></p:sp>'
            : "";
          const motion = slide === 4 && options.keepMotion !== false
            ? `<p:transition spd="slow"><p:fade${options.hoistDrawingNamespace ? " /" : "/"}></p:transition>`
            : "";
          const rootNamespace = options.hoistDrawingNamespace
            ? ` xmlns:a="${options.wrongDrawingNamespace ? "urn:wrong-drawingml" : "http://schemas.openxmlformats.org/drawingml/2006/main"}"`
            : "";
          const rootAttributes = options.hoistDrawingNamespace
            ? ' showMasterPhAnim="1" showMasterSp="1"'
            : ' showMasterSp="1" showMasterPhAnim="1"';
          const textNamespace = options.hoistDrawingNamespace
            ? ""
            : ' xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';
          zip.addFile(
            `ppt/slides/slide${slide}.xml`,
            Buffer.from(`<p:sld${rootNamespace}${rootAttributes}><p:cSld><p:spTree><p:sp><p:txBody><a:p${textNamespace}><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>${target}${unmarkedExtraShape}</p:spTree></p:cSld>${motion}</p:sld>`),
          );
        }
        zip.writeZip(path.join(root, name));
      };
      writeDeck("source.pptx", { keepTarget: true });
      writeDeck("clean.pptx", {
        hoistDrawingNamespace: true,
      });
      const fixture = {
        baselineFiles: ["source.pptx"],
        sourceHashes: {},
        pptxPreservation: {
          sourceFile: "source.pptx",
          expectedShapeRemovals: [{ slide: 4, text: "旧公司名称" }],
        },
      };
      const preserved = await inspectOfficeProductionArtifacts(root, ["clean.pptx"], fixture);
      expect(preserved.features).toEqual(expect.arrayContaining([
        "pptx-unrelated-slides-preserved",
        "pptx-notes-content-preserved",
        "pptx-master-layout-theme-preserved",
        "pptx-relationships-preserved",
        "pptx-media-embeddings-preserved",
        "pptx-presentation-structure-preserved",
        "pptx-requested-slide-delta-exact",
        "pptx-motion-markup-preserved",
        "pptx-protected-package-parts-preserved",
      ]));

      writeDeck("lost-motion.pptx", { keepMotion: false });
      const lostMotion = await inspectOfficeProductionArtifacts(root, ["lost-motion.pptx"], fixture);
      expect(lostMotion.features).not.toContain("pptx-motion-markup-preserved");
      expect(lostMotion.features).not.toContain("pptx-protected-package-parts-preserved");

      writeDeck("changed-master.pptx", { master: "<p:sldMaster><changed/></p:sldMaster>" });
      const changedMaster = await inspectOfficeProductionArtifacts(root, ["changed-master.pptx"], fixture);
      expect(changedMaster.features).not.toContain("pptx-master-layout-theme-preserved");
      expect(changedMaster.features).not.toContain("pptx-protected-package-parts-preserved");

      writeDeck("changed-unrelated-slide.pptx", { slide2: "意外改动" });
      const changedSlide = await inspectOfficeProductionArtifacts(
        root,
        ["changed-unrelated-slide.pptx"],
        fixture,
      );
      expect(changedSlide.features).not.toContain("pptx-unrelated-slides-preserved");
      expect(changedSlide.features).not.toContain("pptx-protected-package-parts-preserved");

      writeDeck("changed-target-slide.pptx", { slide4: "意外改动" });
      const changedTarget = await inspectOfficeProductionArtifacts(root, ["changed-target-slide.pptx"], fixture);
      expect(changedTarget.features).not.toContain("pptx-requested-slide-delta-exact");
      expect(changedTarget.features).not.toContain("pptx-protected-package-parts-preserved");

      writeDeck("changed-notes.pptx", { notes: "<p:notes><a:t>意外备注</a:t></p:notes>" });
      const changedNotes = await inspectOfficeProductionArtifacts(root, ["changed-notes.pptx"], fixture);
      expect(changedNotes.features).not.toContain("pptx-notes-content-preserved");

      writeDeck("changed-presentation.pptx", {
        presentation: "<p:presentation><p:sldIdLst><p:sldId id=\"99\"/></p:sldIdLst></p:presentation>",
      });
      const changedPresentation = await inspectOfficeProductionArtifacts(root, ["changed-presentation.pptx"], fixture);
      expect(changedPresentation.features).not.toContain("pptx-presentation-structure-preserved");

      writeDeck("changed-relationship.pptx", { relationship: "<Relationships><changed/></Relationships>" });
      const changedRelationship = await inspectOfficeProductionArtifacts(root, ["changed-relationship.pptx"], fixture);
      expect(changedRelationship.features).not.toContain("pptx-relationships-preserved");

      writeDeck("changed-media.pptx", { media: "changed-media" });
      const changedMedia = await inspectOfficeProductionArtifacts(root, ["changed-media.pptx"], fixture);
      expect(changedMedia.features).not.toContain("pptx-media-embeddings-preserved");

      writeDeck("unmarked-extra-shape.pptx", { includeUnmarkedExtraShape: true });
      const unmarkedShape = await inspectOfficeProductionArtifacts(
        root,
        ["unmarked-extra-shape.pptx"],
        fixture,
      );
      expect(unmarkedShape.features).not.toContain("pptx-unrelated-slides-preserved");
      expect(unmarkedShape.features).not.toContain("pptx-protected-package-parts-preserved");

      writeDeck("wrong-namespace.pptx", {
        hoistDrawingNamespace: true,
        wrongDrawingNamespace: true,
      });
      const wrongNamespace = await inspectOfficeProductionArtifacts(root, ["wrong-namespace.pptx"], fixture);
      expect(wrongNamespace.features).not.toContain("pptx-unrelated-slides-preserved");
      expect(wrongNamespace.features).not.toContain("pptx-protected-package-parts-preserved");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("seeds existing-deck cleanup with an objective motion-preservation boundary", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "orkas-e2e-ppt-cleanup-"));
    try {
      const fixture = await seedOfficeProductionFixture(
        "office-existing-deck-cleanup",
        root,
      );
      expect(fixture).toMatchObject({
        baselineFiles: ["annual-review.pptx"],
        pptxPreservation: {
          sourceFile: "annual-review.pptx",
          expectedShapeRemovals: [{ slide: 4, text: "旧公司名称" }],
        },
      });
      const zip = new AdmZip(path.join(root, "annual-review.pptx"));
      const slide4 = zip.getEntry("ppt/slides/slide4.xml")?.getData().toString("utf8") || "";
      expect(slide4).toContain("旧公司名称");
      expect(slide4).toContain('<p:transition spd="slow"><p:fade/></p:transition>');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("seeds the PptMaker bounded-redesign deck with both targeted residues", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "orkas-e2e-ppt-redesign-"));
    try {
      const fixture = await seedOfficeProductionFixture(
        "ppt-existing-deck-bounded-redesign",
        root,
      );
      expect(fixture.baselineFiles).toEqual(["annual-review.pptx"]);
      const zip = new AdmZip(path.join(root, "annual-review.pptx"));
      const text = zip.getEntries()
        .filter((entry) => entry.entryName.startsWith("ppt/"))
        .map((entry) => entry.getData().toString("utf8"))
        .join("\n");
      expect(text).toContain("TEMPLATE_PLACEHOLDER");
      expect(text).toContain("旧公司名称");

      const inspection = await inspectOfficeProductionArtifacts(root, [], fixture);
      expect(inspection.features).toContain("source-fixtures-preserved");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("seeds an eight-slide editable strict-template reference deck", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "orkas-e2e-ppt-template-"));
    try {
      const fixture = await seedOfficeProductionFixture(
        "ppt-reference-template-six-slide-production",
        root,
      );
      expect(fixture.baselineFiles).toEqual(["conference-template.pptx"]);
      const zip = new AdmZip(path.join(root, "conference-template.pptx"));
      const slides = zip.getEntries().filter(
        (entry) => /^ppt\/slides\/slide\d+\.xml$/i.test(entry.entryName),
      );
      const text = slides.map((entry) => entry.getData().toString("utf8")).join("\n");
      expect(slides).toHaveLength(8);
      expect(text).toContain("TEMPLATE_OPENING");
      expect(text).toContain("TEMPLATE_CLOSE");
      const inspection = await inspectOfficeProductionArtifacts(root, [], fixture);
      expect(inspection.features).toContain("source-fixtures-preserved");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("seeds both PptMaker source-pack files and detects source mutation", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "orkas-e2e-ppt-source-pack-"));
    try {
      const fixture = await seedOfficeProductionFixture(
        "ppt-mixed-source-executive-update",
        root,
      );
      expect(fixture.baselineFiles).toEqual(["project-update.md", "metrics.csv"]);
      expect(fs.readFileSync(path.join(root, "project-update.md"), "utf8"))
        .toContain("CRM 集成能力尚未核验");
      expect(fs.readFileSync(path.join(root, "metrics.csv"), "utf8"))
        .toContain("目标,2026,全年,210,万元,未实现");

      const preserved = await inspectOfficeProductionArtifacts(root, [], fixture);
      expect(preserved.features).toContain("source-fixtures-preserved");

      fs.appendFileSync(path.join(root, "metrics.csv"), "\n意外改动", "utf8");
      const mutated = await inspectOfficeProductionArtifacts(root, [], fixture);
      expect(mutated.features).not.toContain("source-fixtures-preserved");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

});
