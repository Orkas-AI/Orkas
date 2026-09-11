import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import AdmZip from "adm-zip";
import {
  PDFDocument,
  StandardFonts,
  rgb,
} from "pdf-lib";

export interface OfficeProductionFixtureState {
  baselineFiles: string[];
  sourceHashes: Record<string, string>;
  pptxPreservation?: {
    sourceFile: string;
    expectedShapeRemovals: Array<{
      slide: number;
      text: string;
    }>;
  };
}

export interface OfficeProductionArtifactInspection {
  features: string[];
  evidence: string[];
}

const OFFICE_FIXTURE_SCENARIOS = new Set([
  "office-existing-contract-edit",
  "office-csv-to-workbook",
  "office-xlsm-macro-preservation",
  "office-existing-deck-cleanup",
  "office-mixed-delivery",
  "office-wps-proprietary-input",
  "office-pdf-page-edit",
  "ppt-existing-deck-safe-edit",
  "ppt-existing-deck-evidence-review",
  "ppt-mixed-source-executive-update",
  "ppt-existing-deck-bounded-redesign",
  "ppt-reference-template-six-slide-production",
]);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const OFFICECLI_ASSETS: Readonly<Record<string, string>> = {
  "darwin-arm64": "officecli-mac-arm64",
  "darwin-x64": "officecli-mac-x64",
  "win32-arm64": "officecli-win-arm64.exe",
  "win32-x64": "officecli-win-x64.exe",
};

function serializeOfficeBatch(operations: readonly unknown[]): string {
  return JSON.stringify(operations).replace(
    /[\u007f-\uffff]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

function officeCliBinary(): string {
  const asset = OFFICECLI_ASSETS[`${process.platform}-${process.arch}`];
  if (!asset) throw new Error(`Office production fixtures do not support ${process.platform}-${process.arch}`);
  const binary = path.resolve(HERE, "../../../resources/officecli", asset);
  if (!fs.existsSync(binary)) throw new Error(`OfficeCLI fixture binary is missing: ${binary}`);
  return binary;
}

function sha256(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

async function checkedOfficeCli(
  args: string[],
  cwd: string,
  stdin?: string,
): Promise<void> {
  const binary = officeCliBinary();
  const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd,
      windowsHide: true,
      env: { ...process.env, OFFICECLI_SKIP_UPDATE: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Office fixture command timed out: ${args.join(" ")}`));
    }, 60_000);
    timer.unref?.();
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        code: code ?? -1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
    child.stdin.end(stdin);
  });
  if (result.code !== 0) {
    throw new Error(
      `Office fixture command failed (${result.code}): ${args.join(" ")}\n`
      + `${result.stderr || result.stdout}`,
    );
  }
}

async function closeFixtureOfficeFile(file: string, cwd: string): Promise<void> {
  try {
    await checkedOfficeCli(["close", file], cwd);
  } catch {
    // Fixture seeding uses standalone commands; no resident is expected, but
    // close remains a best-effort guard if OfficeCLI changed that behavior.
  }
}

async function batchOffice(
  file: string,
  cwd: string,
  operations: readonly unknown[],
): Promise<void> {
  await checkedOfficeCli(
    ["batch", file, "--stop-on-error", "--json"],
    cwd,
    serializeOfficeBatch(operations),
  );
}

async function seedReviewedContract(root: string): Promise<string> {
  const file = path.join(root, "contract-reviewed.docx");
  await checkedOfficeCli(["create", file, "--locale", "zh-CN", "--force", "--json"], root);
  await batchOffice(file, root, [
    {
      command: "add",
      parent: "/body",
      type: "p",
      props: { text: "采购服务合同（审阅稿）", style: "Heading1" },
    },
    {
      command: "add",
      parent: "/body",
      type: "p",
      props: { text: "乙方公司：旧辰科技有限公司" },
    },
    {
      command: "add",
      parent: "/body",
      type: "p",
      props: { text: "付款周期为30天。" },
    },
  ]);
  await checkedOfficeCli([
    "add",
    file,
    "/body/p[2]",
    "--type",
    "comment",
    "--prop",
    "text=请核对乙方工商登记名称",
    "--prop",
    "author=法务审阅",
    "--prop",
    "initials=FW",
    "--json",
  ], root);
  await checkedOfficeCli([
    "set",
    file,
    "/body/p[3]",
    "--prop",
    "find=30",
    "--prop",
    "replace=45",
    "--prop",
    "revision.author=审阅人",
    "--json",
  ], root);
  await closeFixtureOfficeFile(file, root);
  return file;
}

async function seedReviewedDeck(root: string): Promise<string> {
  const file = path.join(root, "annual-review.pptx");
  await checkedOfficeCli(["create", file, "--force", "--json"], root);
  await batchOffice(file, root, [
    { command: "add", parent: "/", type: "slide", props: { title: "年度经营复盘", text: "管理层摘要" } },
    { command: "add", parent: "/", type: "slide", props: { title: "核心指标", text: "收入与利润趋势" } },
    { command: "add", parent: "/", type: "slide", props: { title: "区域表现", text: "重点市场进展" } },
    { command: "add", parent: "/", type: "slide", props: { title: "行动计划", text: "下一季度重点" } },
    { command: "add", parent: "/", type: "slide", props: { title: "风险与依赖", text: "待管理层决策" } },
    {
      command: "add",
      parent: "/slide[4]",
      type: "shape",
      props: {
        text: "旧公司名称",
        x: "8.2in",
        y: "6.7in",
        width: "1.4in",
        height: "0.3in",
        fontSize: "9",
        color: "777777",
      },
    },
    {
      command: "add",
      parent: "/slide[4]",
      type: "notes",
      props: { text: "演讲者备注：行动计划需与财务负责人确认。" },
    },
  ]);
  await closeFixtureOfficeFile(file, root);
  // Carry one real, package-level motion property through the cleanup case.
  // This gives the evaluator an independent animation/transition preservation
  // oracle instead of rewarding a final-message claim that cannot prove it.
  const zip = new AdmZip(file);
  const slide4 = zip.getEntry("ppt/slides/slide4.xml")?.getData().toString("utf8") || "";
  if (!slide4.includes("</p:sld>")) {
    throw new Error("Office PPTX fixture slide 4 is missing its closing element");
  }
  zip.updateFile(
    "ppt/slides/slide4.xml",
    Buffer.from(slide4.replace(
      "</p:sld>",
      '<p:transition spd="slow"><p:fade/></p:transition></p:sld>',
    )),
  );
  zip.writeZip(file);
  return file;
}

async function seedBoundedRedesignDeck(root: string): Promise<string> {
  const file = await seedReviewedDeck(root);
  await batchOffice(file, root, [
    {
      command: "add",
      parent: "/slide[2]",
      type: "shape",
      props: {
        text: "TEMPLATE_PLACEHOLDER",
        x: "9.2in",
        y: "6.55in",
        width: "2.8in",
        height: "0.35in",
        fontSize: "10",
        color: "C00000",
      },
    },
  ]);
  await closeFixtureOfficeFile(file, root);
  return file;
}

async function seedConferenceTemplate(root: string): Promise<string> {
  const file = path.join(root, "conference-template.pptx");
  await checkedOfficeCli(["create", file, "--force", "--json"], root);
  const roles = [
    "OPENING",
    "CHALLENGE",
    "FRAMEWORK",
    "PROCESS",
    "DATA",
    "SECTION",
    "QUOTE",
    "CLOSE",
  ];
  const operations: unknown[] = [];
  for (const [index, role] of roles.entries()) {
    const slideNumber = index + 1;
    const dark = slideNumber === 1 || slideNumber === 6 || slideNumber === 8;
    const background = dark ? "#17324D" : "#F4F0E8";
    const titleColor = dark ? "#FFFFFF" : "#17324D";
    const bodyColor = dark ? "#E8EEF3" : "#40566B";
    operations.push({
      command: "add",
      parent: "/",
      type: "slide",
      props: { background },
    });
    operations.push({
      command: "add",
      parent: `/slide[${slideNumber}]`,
      type: "shape",
      props: {
        text: `TEMPLATE_${role}`,
        x: "0.72in",
        y: "0.48in",
        width: "3.4in",
        height: "0.34in",
        fontSize: "11",
        bold: "true",
        color: dark ? "#F2C14E" : "#E76F51",
      },
    });
    operations.push({
      command: "add",
      parent: `/slide[${slideNumber}]`,
      type: "shape",
      props: {
        text: `TEMPLATE_TITLE_${slideNumber}`,
        x: slideNumber % 3 === 0 ? "4.5in" : "0.72in",
        y: slideNumber % 3 === 0 ? "1.25in" : "1.08in",
        width: slideNumber % 3 === 0 ? "7.9in" : "8.5in",
        height: "1.25in",
        fontSize: slideNumber === 1 || slideNumber === 8 ? "36" : "30",
        bold: "true",
        color: titleColor,
      },
    });
    operations.push({
      command: "add",
      parent: `/slide[${slideNumber}]`,
      type: "shape",
      props: {
        text: `TEMPLATE_BODY_${slideNumber}`,
        x: slideNumber % 3 === 0 ? "4.5in" : "0.72in",
        y: "2.65in",
        width: slideNumber % 3 === 0 ? "7.4in" : "6.8in",
        height: "2.3in",
        fontSize: "18",
        color: bodyColor,
      },
    });
    operations.push({
      command: "add",
      parent: `/slide[${slideNumber}]`,
      type: "shape",
      props: {
        text: slideNumber % 2 === 0 ? "" : String(slideNumber).padStart(2, "0"),
        x: slideNumber % 2 === 0 ? "9.65in" : "10.9in",
        y: slideNumber % 2 === 0 ? "0in" : "5.55in",
        width: slideNumber % 2 === 0 ? "3.68in" : "1.5in",
        height: slideNumber % 2 === 0 ? "7.5in" : "1.1in",
        fill: slideNumber % 2 === 0 ? "#E76F51" : "#F2C14E",
        color: "#17324D",
        fontSize: "24",
        bold: "true",
        align: "center",
      },
    });
  }
  await batchOffice(file, root, operations);
  await closeFixtureOfficeFile(file, root);
  return file;
}

function seedPptMixedSourcePack(root: string): string[] {
  // Source material only. A colleague's brief carries audience, conclusions,
  // risks and next steps — every one of those belongs on a slide. It does not
  // carry instructions addressed to whoever builds the deck. The 2026-08-09 run
  // rendered "证据边界：只能使用本文件与 metrics.csv，不补充外部事实" onto the cover,
  // which was the correct reading of a bullet sitting among five that do belong
  // there. Task constraints go in the user's request; keep them out of here.
  const brief = path.join(root, "project-update.md");
  fs.writeFileSync(
    brief,
    [
      "# 华东智能办公试点管理层更新",
      "",
      "- 受众：管理委员会",
      "- 目标动作：决定是否批准华东区域试点",
      "- 已核验结论：2025 年四个季度营收稳步上升，但区域差异明显",
      "- 风险：安全评审待完成；CRM 集成能力尚未核验",
      "- 下一步：若批准试点，先完成安全评审，再启动 30 天验证",
      "",
    ].join("\n"),
    "utf8",
  );
  const metrics = seedCsv(
    root,
    "metrics.csv",
    [
      "属性,周期,区域,数值,单位,状态",
      "实际,2025-Q1,全部,120,万元,已核验",
      "实际,2025-Q2,全部,138,万元,已核验",
      "实际,2025-Q3,全部,151,万元,已核验",
      "实际,2025-Q4,全部,169,万元,已核验",
      "目标,2026,全年,210,万元,未实现",
      "实际,2025,华东,72,万元,已核验",
      "实际,2025,华南,55,万元,已核验",
      "实际,2025,华北,42,万元,已核验",
    ].join("\n"),
  );
  return [brief, metrics];
}

async function seedMacroWorkbook(root: string): Promise<string> {
  const xlsx = path.join(root, "finance-review-seed.xlsx");
  const xlsm = path.join(root, "finance-review.xlsm");
  await checkedOfficeCli(["create", xlsx, "--force", "--json"], root);
  await batchOffice(xlsx, root, [
    { command: "set", path: "/Sheet1/A1", props: { value: "2025 年度经营复盘" } },
    { command: "set", path: "/Sheet1/A2", props: { value: "签名宏工作簿测试夹具" } },
  ]);
  await closeFixtureOfficeFile(xlsx, root);
  const zip = new AdmZip(xlsx);
  zip.addFile("xl/vbaProject.bin", Buffer.from("ORKAS-EVAL-VBA-FIXTURE"));
  const contentTypes = zip.getEntry("[Content_Types].xml")?.getData().toString("utf8") || "";
  zip.updateFile(
    "[Content_Types].xml",
    Buffer.from(contentTypes.replace(
      "</Types>",
      '<Override PartName="/xl/vbaProject.bin" ContentType="application/vnd.ms-office.vbaProject"/></Types>',
    )),
  );
  zip.writeZip(xlsm);
  fs.rmSync(xlsx);
  return xlsm;
}

async function seedBoardPack(root: string): Promise<string> {
  const file = path.join(root, "board-pack.pdf");
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (let index = 0; index < 4; index += 1) {
    const page = document.addPage([595, 842]);
    page.drawText(`Board pack page ${index + 1}`, {
      x: 72,
      y: 760,
      size: 20,
      font,
      color: rgb(0.15, 0.2, 0.3),
    });
    page.drawText("Confidential management material", {
      x: 72,
      y: 720,
      size: 12,
      font,
      color: rgb(0.35, 0.4, 0.5),
    });
  }
  fs.writeFileSync(file, await document.save());
  return file;
}

function seedCsv(root: string, name: string, body: string): string {
  const file = path.join(root, name);
  fs.writeFileSync(file, body, "utf8");
  return file;
}

function seedWps(root: string): string {
  const file = path.join(root, "notice.wps");
  fs.writeFileSync(
    file,
    Buffer.concat([
      Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
      Buffer.from("ORKAS proprietary WPS evaluation fixture", "utf8"),
    ]),
  );
  return file;
}

export async function seedOfficeProductionFixture(
  scenarioId: string,
  root: string,
): Promise<OfficeProductionFixtureState> {
  if (!OFFICE_FIXTURE_SCENARIOS.has(scenarioId)) {
    return { baselineFiles: [], sourceHashes: {} };
  }
  const sources: string[] = [];
  if (scenarioId === "office-existing-contract-edit") {
    sources.push(await seedReviewedContract(root));
  } else if (scenarioId === "office-csv-to-workbook") {
    sources.push(seedCsv(
      root,
      "customers.csv",
      [
        "客户编号,客户名称,金额",
        "00123,星海商贸,1200.50",
        "90071992547409931,远山零售,3400.00",
      ].join("\n"),
    ));
  } else if (scenarioId === "office-xlsm-macro-preservation") {
    sources.push(await seedMacroWorkbook(root));
  } else if (
    scenarioId === "office-existing-deck-cleanup"
    || scenarioId === "ppt-existing-deck-safe-edit"
    || scenarioId === "ppt-existing-deck-evidence-review"
  ) {
    sources.push(await seedReviewedDeck(root));
  } else if (scenarioId === "ppt-existing-deck-bounded-redesign") {
    sources.push(await seedBoundedRedesignDeck(root));
  } else if (scenarioId === "office-mixed-delivery") {
    sources.push(seedCsv(
      root,
      "business-data.csv",
      [
        "月份,收入,成本,订单数",
        "2026-01,120000,78000,860",
        "2026-02,132000,82500,910",
        "2026-03,145000,87000,980",
      ].join("\n"),
    ));
  } else if (scenarioId === "office-wps-proprietary-input") {
    sources.push(seedWps(root));
  } else if (scenarioId === "office-pdf-page-edit") {
    sources.push(await seedBoardPack(root));
  } else if (scenarioId === "ppt-mixed-source-executive-update") {
    sources.push(...seedPptMixedSourcePack(root));
  } else if (scenarioId === "ppt-reference-template-six-slide-production") {
    sources.push(await seedConferenceTemplate(root));
  }
  const baselineFiles = sources.map((file) => path.relative(root, file).split(path.sep).join("/"));
  return {
    baselineFiles,
    sourceHashes: Object.fromEntries(
      baselineFiles.map((file) => [file, sha256(path.join(root, ...file.split("/")))]),
    ),
    ...(scenarioId === "office-existing-deck-cleanup" ? {
      pptxPreservation: {
        sourceFile: "annual-review.pptx",
        expectedShapeRemovals: [{ slide: 4, text: "旧公司名称" }],
      },
    } : {}),
  };
}

function decodeXmlText(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function xmlText(zip: AdmZip, prefix: string): string {
  return zip.getEntries()
    .filter((entry) => entry.entryName.startsWith(prefix) && entry.entryName.endsWith(".xml"))
    .flatMap((entry) => {
      const xml = entry.getData().toString("utf8");
      return [...xml.matchAll(/<(?:[A-Za-z_][\w.-]*:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?t>/g)]
        .map((match) => decodeXmlText(match[1]));
    })
    .join("\n");
}

function inspectXlsx(file: string, features: Set<string>, evidence: string[]): void {
  const zip = new AdmZip(file);
  const worksheetXml = zip.getEntries()
    .filter((entry) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(entry.entryName))
    .map((entry) => entry.getData().toString("utf8"))
    .join("\n");
  const formulas = [...worksheetXml.matchAll(
    /<(?:[A-Za-z_][\w.-]*:)?f(?:\s[^>]*)?>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?f>/g,
  )].map((match) => decodeXmlText(match[1]));
  const text = `${xmlText(zip, "xl/")} ${worksheetXml}`;
  features.add("xlsx-valid-package");
  if (formulas.length) features.add("xlsx-live-formulas");
  if (text.includes("00123") && text.includes("90071992547409931")) {
    features.add("xlsx-identifiers-preserved");
  }
  evidence.push(
    `xlsx=${JSON.stringify(path.basename(file))} formulas=${formulas.length}`
    + ` identifiersPreserved=${text.includes("00123") && text.includes("90071992547409931")}`,
  );
}

function inspectDocx(file: string, features: Set<string>, evidence: string[]): void {
  const zip = new AdmZip(file);
  const documentXml = zip.getEntry("word/document.xml")?.getData().toString("utf8") || "";
  const text = xmlText(zip, "word/");
  const comments = [...(zip.getEntry("word/comments.xml")?.getData().toString("utf8") || "")
    .matchAll(/<(?:\w+:)?comment\b/g)].length;
  const revisions = [...documentXml.matchAll(/<(?:\w+:)?(?:ins|del|moveFrom|moveTo)\b/g)].length;
  features.add("docx-valid-package");
  if (text.includes("星河科技有限公司") && !text.includes("旧辰科技有限公司")) {
    features.add("docx-target-updated");
  }
  if (comments > 0) features.add("docx-comments-preserved");
  if (revisions > 0) features.add("docx-revisions-preserved");
  evidence.push(
    `docx=${JSON.stringify(path.basename(file))} targetUpdated=${text.includes("星河科技有限公司")}`
    + ` comments=${comments} revisions=${revisions}`,
  );
}

function pptxLayoutSignature(xml: string): string {
  const count = (name: string) => [
    ...xml.matchAll(new RegExp(`<(?:[A-Za-z_][\\w.-]*:)?${name}\\b`, "gi")),
  ].length;
  const positions = [...xml.matchAll(/<(?:[A-Za-z_][\w.-]*:)?off\b([^>]*)>/gi)]
    .slice(0, 12)
    .map((match) => {
      const attrs = match[1];
      const x = Number(attrs.match(/\bx="(\d+)"/i)?.[1] ?? 0);
      const y = Number(attrs.match(/\by="(\d+)"/i)?.[1] ?? 0);
      // Quantize to roughly half an inch so insignificant nudges do not fake a
      // different layout while genuine split/hero/process geometry does.
      return `${Math.round(x / 457_200)},${Math.round(y / 457_200)}`;
    });
  return `${count("sp")}:${count("pic")}:${count("graphicFrame")}:${positions.join("|")}`;
}

function pptxExplicitFontSizes(xml: string): Set<number> {
  const sizes = new Set<number>();
  for (const match of xml.matchAll(
    /<(?:[A-Za-z_][\w.-]*:)?(?:rPr|defRPr|endParaRPr)\b[^>]*\bsz="(\d+)"/gi,
  )) {
    const size = Number(match[1]);
    if (Number.isFinite(size) && size > 0) sizes.add(size);
  }
  return sizes;
}

/** Delimiters a pasted record row is joined with. Full-width first: the deck
 *  that exposed this used `｜`. */
const PPTX_RECORD_DELIMITERS = ["｜", "|", "\t"];
/** Fields per row before a line reads as a record rather than a styled label.
 *  A footer like `内部 | 2026` has one delimiter; a record has several. */
const PPTX_RECORD_DELIMITERS_PER_ROW = 2;
/** Sibling record lines on one slide before it reads as a source dump. Two can
 *  be a deliberate pair; three in a column is a table someone pasted as text. */
const PPTX_RECORD_ROWS_PER_DUMP = 3;

/** Visual lines of a slide: one per paragraph, split again at soft breaks, with
 *  each paragraph's runs joined so a delimiter that is its own run still lands
 *  inside its row. Table cells come back as their own short lines, which is why
 *  a real `<a:tbl>` cannot look like a dump. */
function pptxTextLines(xml: string): string[] {
  const lines: string[] = [];
  for (const paragraph of xml.split(/<(?:[A-Za-z_][\w.-]*:)?p\b[^>]*>/i).slice(1)) {
    for (const piece of paragraph.split(/<(?:[A-Za-z_][\w.-]*:)?br\b[^>]*\/?>/i)) {
      const runs = [...piece.matchAll(/<(?:[A-Za-z_][\w.-]*:)?t\b[^>]*>([\s\S]*?)<\//gi)]
        .map((match) => match[1]);
      if (runs.length) lines.push(runs.join("").trim());
    }
  }
  return lines.filter(Boolean);
}

function pptxElementText(xml: string): string {
  return [...xml.matchAll(
    /<(?:[A-Za-z_][\w.-]*:)?t\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?t>/gi,
  )]
    .map((match) => decodeXmlText(match[1]))
    .join("")
    .replace(/\s+/g, "");
}

function pptxTitleHasExplicitStyle(
  slideXml: string,
  expectedText: string,
  expectedSize: number,
  expectedColor: string,
): boolean {
  const normalizedExpectedText = expectedText.replace(/\s+/g, "");
  const shapes = [...slideXml.matchAll(
    /<(?:[A-Za-z_][\w.-]*:)?sp\b[^>]*>[\s\S]*?<\/(?:[A-Za-z_][\w.-]*:)?sp>/gi,
  )].map((match) => match[0]);
  const titleShape = shapes.find((shape) => (
    /<(?:[A-Za-z_][\w.-]*:)?ph\b[^>]*\btype=["'](?:title|ctrTitle)["']/i.test(shape)
    && pptxElementText(shape) === normalizedExpectedText
  ));
  if (!titleShape) return false;

  const textRuns = [...titleShape.matchAll(
    /<(?:[A-Za-z_][\w.-]*:)?r\b[^>]*>[\s\S]*?<\/(?:[A-Za-z_][\w.-]*:)?r>/gi,
  )]
    .map((match) => match[0])
    .filter((run) => pptxElementText(run).length > 0);
  if (!textRuns.length) return false;

  const sizePattern = new RegExp(
    `<(?:[A-Za-z_][\\w.-]*:)?rPr\\b[^>]*\\bsz=["']${expectedSize}["']`,
    "i",
  );
  const colorPattern = new RegExp(
    `<(?:[A-Za-z_][\\w.-]*:)?srgbClr\\b[^>]*\\bval=["']#?${expectedColor}["']`,
    "i",
  );
  return textRuns.every((run) => sizePattern.test(run) && colorPattern.test(run));
}

/** How many lines of this slide read as raw record rows, counted per delimiter
 *  so a deck mixing `|` captions with tab-joined rows is judged on the worse. */
function pptxRawRecordRows(xml: string): number {
  const lines = pptxTextLines(xml);
  let worst = 0;
  for (const delimiter of PPTX_RECORD_DELIMITERS) {
    const rows = lines.filter(
      (line) => line.split(delimiter).length - 1 >= PPTX_RECORD_DELIMITERS_PER_ROW,
    ).length;
    if (rows > worst) worst = rows;
  }
  return worst;
}

function inspectPptx(file: string, features: Set<string>, evidence: string[]): void {
  const zip = new AdmZip(file);
  const slideEntries = zip.getEntries()
    .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/i.test(entry.entryName))
    .sort((left, right) => left.entryName.localeCompare(right.entryName, undefined, { numeric: true }));
  const slideXml = slideEntries.map((entry) => entry.getData().toString("utf8"));
  const packageXml = zip.getEntries()
    .filter((entry) => entry.entryName.endsWith(".xml"))
    .map((entry) => entry.getData().toString("utf8"))
    .join("\n");
  const slideCount = slideEntries.length;
  const notesCount = zip.getEntries().filter((entry) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/i.test(entry.entryName)).length;
  const masterCount = zip.getEntries().filter((entry) => /^ppt\/slideMasters\/slideMaster\d+\.xml$/i.test(entry.entryName)).length;
  const text = xmlText(zip, "ppt/");
  const normalizedText = text.replace(/\s+/g, "");
  const editableTextSlides = slideXml.filter((xml) => /<a:t(?:\s|\/?>)/i.test(xml)).length;
  const nativeShapeSlides = slideXml.filter((xml) => /<p:sp(?:\s|\/?>)/i.test(xml)).length;
  const layoutSignatures = new Set(slideXml.map(pptxLayoutSignature));
  const hierarchySlides = slideXml.filter((xml) => pptxExplicitFontSizes(xml).size >= 2).length;
  const imageOnlySlides = slideXml.filter((xml) => (
    /<p:pic(?:\s|\/?>)/i.test(xml)
    && !/<a:t(?:\s|\/?>)|<p:sp(?:\s|\/?>)|<p:graphicFrame(?:\s|\/?>)/i.test(xml)
  )).length;
  features.add("pptx-valid-package");
  if (slideCount === 5) features.add("pptx-five-slides");
  if (slideCount === 4) features.add("pptx-four-slides");
  if (slideCount === 6) features.add("pptx-six-slides");
  if (slideCount === 8) features.add("pptx-eight-slides");
  if (
    slideCount > 0
    && editableTextSlides === slideCount
    && nativeShapeSlides === slideCount
  ) {
    features.add("pptx-native-editable-content");
  }
  if (slideCount > 0 && imageOnlySlides === 0) features.add("pptx-no-image-only-slides");
  // Preserving the facts and presenting them are different properties, and the
  // text check below cannot tell them apart: on 2026-08-09 the cover of
  // ppt-mixed-source-executive-update carried eight rows shaped
  // `实际｜2025-Q1｜全部｜120 万元｜已核验`, which satisfied every value and label
  // it asks for while the rendered-aesthetic judge scored 73. Pasting the source
  // pack was the cheapest way to pass. This is the separate signal, so the
  // facts check stays exactly as strict as before and no longer rewards a dump.
  const rawRecordDumpSlides = slideXml.filter(
    (xml) => pptxRawRecordRows(xml) >= PPTX_RECORD_ROWS_PER_DUMP,
  ).length;
  if (slideCount > 0 && rawRecordDumpSlides === 0) features.add("pptx-no-raw-record-dump");
  if (slideCount >= 6 && layoutSignatures.size >= 4) features.add("pptx-layout-variety");
  if (slideCount >= 6 && hierarchySlides >= Math.ceil(slideCount * 0.75)) {
    features.add("pptx-explicit-type-hierarchy");
  }
  const mixedSourceLabels = [
    "2025",
    "2026",
    "万元",
    "目标",
    "华东",
    "华南",
    "华北",
    "安全评审",
    "CRM",
  ];
  const mixedSourceValues = ["120", "138", "151", "169", "210", "72", "55", "42"];
  const hasMixedSourceValue = (value: string): boolean => (
    new RegExp(`>\\s*${value}(?:\\.0+)?\\s*<`).test(packageXml)
    || new RegExp(`(?<!\\d)${value}(?:\\.0+)?(?!\\d)`).test(text)
  );
  if (
    mixedSourceLabels.every((value) => text.includes(value))
    && mixedSourceValues.every(hasMixedSourceValue)
  ) {
    features.add("pptx-source-pack-facts-preserved");
  }
  if (notesCount > 0) features.add("pptx-notes-preserved");
  if (!text.includes("旧公司名称")) features.add("pptx-old-label-removed");
  if (!text.includes("旧公司名称") && text.includes("星河科技有限公司")) {
    features.add("pptx-company-label-updated");
  }
  if (
    ["公开", "内部", "机密", "公共网盘", "24小时"].every(
      (value) => normalizedText.includes(value),
    )
  ) {
    features.add("pptx-review-gate-facts-preserved");
  }
  const kickoffFacts = ["北辰计划", "9月15日", "30万元"];
  if (
    kickoffFacts.every((value) => normalizedText.includes(value))
    && normalizedText.includes("产品运营组")
  ) {
    features.add("pptx-initial-owner-label");
  }
  if (
    kickoffFacts.every((value) => normalizedText.includes(value))
    && normalizedText.includes("客户成功组")
    && !normalizedText.includes("产品运营组")
  ) {
    features.add("pptx-follow-up-owner-updated");
  }
  const boundedRedesignFacts = [
    "年度经营复盘",
    "管理层摘要",
    "收入与利润趋势",
    "区域表现",
    "重点市场进展",
    "行动计划",
    "下一季度重点",
    "风险与依赖",
    "待管理层决策",
  ];
  if (boundedRedesignFacts.every((value) => normalizedText.includes(value))) {
    features.add("pptx-bounded-redesign-facts-preserved");
  }
  const redesignedSlide2 = slideXml[1] || "";
  const redesignedSlide4 = slideXml[3] || "";
  if (
    normalizedText.includes("核心指标｜增长质量")
    && normalizedText.includes("星河科技有限公司")
    && !normalizedText.includes("TEMPLATE_PLACEHOLDER")
    && !normalizedText.includes("旧公司名称")
  ) {
    features.add("pptx-bounded-redesign-content-updated");
  }
  if (
    pptxTitleHasExplicitStyle(
      redesignedSlide2,
      "核心指标｜增长质量",
      2800,
      "17365D",
    )
    && pptxTitleHasExplicitStyle(
      redesignedSlide4,
      "行动计划",
      2800,
      "17365D",
    )
  ) {
    features.add("pptx-bounded-redesign-style-updated");
  }
  const referenceTemplateFacts = [
    "启明计划",
    "客户挑战",
    "流程分散",
    "信息重复录入",
    "决策链路长",
    "方案框架",
    "统一入口",
    "智能协同",
    "过程可追踪",
    "实施路径",
    "准备",
    "试点",
    "推广",
    "成功指标",
    "采用率",
    "处理时长",
    "满意度",
    "确认试点范围",
  ];
  if (
    referenceTemplateFacts.every((value) => normalizedText.includes(value))
    && !normalizedText.includes("TEMPLATE_")
  ) {
    features.add("pptx-reference-template-facts-preserved");
  }
  if (masterCount > 0) features.add("pptx-master-preserved");
  evidence.push(
    `pptx=${JSON.stringify(path.basename(file))} slides=${slideCount} notes=${notesCount}`
    + ` masters=${masterCount} editableTextSlides=${editableTextSlides}`
    + ` nativeShapeSlides=${nativeShapeSlides} imageOnlySlides=${imageOnlySlides}`
    + ` rawRecordDumpSlides=${rawRecordDumpSlides}`
    + ` layoutSignatures=${layoutSignatures.size} hierarchySlides=${hierarchySlides}`
    + ` oldLabelPresent=${text.includes("旧公司名称")}`,
  );
}

function pptxZipPartMap(
  zip: AdmZip,
  predicate: (entryName: string) => boolean,
): Map<string, string> {
  return new Map(zip.getEntries()
    .filter((entry) => !entry.isDirectory && predicate(entry.entryName))
    .map((entry) => [
      entry.entryName,
      createHash("sha256").update(
        /\.(?:xml|rels)$/i.test(entry.entryName)
          ? normalizePptxXml(entry.getData().toString("utf8"))
          : entry.getData(),
      ).digest("hex"),
    ]));
}

function pptxPartMapsEqual(left: Map<string, string>, right: Map<string, string>): boolean {
  return left.size === right.size
    && [...left].every(([entryName, hash]) => right.get(entryName) === hash);
}

function pptxMotionMarkup(xml: string): string[] {
  const blocks: string[] = [];
  for (const tag of ["transition", "timing"]) {
    const pattern = new RegExp(
      `<(?:[A-Za-z_][\\w.-]*:)?${tag}\\b[^>]*(?:\\/\\s*>|>[\\s\\S]*?<\\/(?:[A-Za-z_][\\w.-]*:)?${tag}\\s*>)`,
      "gi",
    );
    blocks.push(...xml.match(pattern) ?? []);
  }
  return blocks.map(normalizePptxXml).sort();
}

function normalizePptxXml(xml: string): string {
  const tokens = xml.match(/<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<[^>]*>|[^<]+/g) ?? [];
  const frames: Array<{ expandedName: string; namespaces: Map<string, string> }> = [];
  const output: string[] = [];
  const expandName = (
    name: string,
    namespaces: ReadonlyMap<string, string>,
    attribute = false,
  ): string => {
    const separator = name.indexOf(":");
    if (separator >= 0) {
      const prefix = name.slice(0, separator);
      const local = name.slice(separator + 1);
      return `{${namespaces.get(prefix) ?? `prefix:${prefix}`}}${local}`;
    }
    return attribute ? `{}` + name : `{${namespaces.get("") ?? ""}}${name}`;
  };
  for (const token of tokens) {
    if (/^<\?/.test(token) || /^<!--/.test(token)) continue;
    if (!token.startsWith("<")) {
      if (token.trim()) output.push(`T:${token}`);
      continue;
    }
    if (/^<!/.test(token)) {
      output.push(`D:${token.replace(/\s+/g, " ")}`);
      continue;
    }
    if (/^<\//.test(token)) {
      const rawName = token.match(/^<\/\s*([^\s>]+)/)?.[1] ?? "";
      const frame = frames.pop();
      const expandedName = expandName(rawName, frame?.namespaces ?? new Map());
      output.push(`E:${expandedName}`);
      if (!frame || frame.expandedName !== expandedName) output.push(`MISMATCH:${rawName}`);
      continue;
    }

    const selfClosing = /\/\s*>$/.test(token);
    const body = token.slice(1, selfClosing ? token.search(/\/\s*>$/) : -1).trim();
    const rawName = body.match(/^[^\s/>]+/)?.[0] ?? "";
    const rawAttributes = body.slice(rawName.length);
    const attributes: Array<{ name: string; value: string }> = [];
    const attributePattern = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    for (const match of rawAttributes.matchAll(attributePattern)) {
      attributes.push({ name: match[1], value: match[2] ?? match[3] ?? "" });
    }
    const unparsed = rawAttributes.replace(attributePattern, "").trim();
    if (!rawName || unparsed) {
      output.push(`RAW:${token}`);
      continue;
    }
    const namespaces = new Map(frames.at(-1)?.namespaces ?? []);
    for (const attribute of attributes) {
      if (attribute.name === "xmlns") namespaces.set("", attribute.value);
      else if (attribute.name.startsWith("xmlns:")) {
        namespaces.set(attribute.name.slice("xmlns:".length), attribute.value);
      }
    }
    const expandedName = expandName(rawName, namespaces);
    const expandedAttributes = attributes
      .filter((attribute) => attribute.name !== "xmlns" && !attribute.name.startsWith("xmlns:"))
      .map((attribute) => ({
        name: expandName(attribute.name, namespaces, true),
        value: attribute.value,
      }))
      .sort((left, right) => left.name.localeCompare(right.name) || left.value.localeCompare(right.value));
    output.push(`S:${expandedName}${expandedAttributes.map(({ name, value }) => `|${name}=${value}`).join("")}`);
    if (selfClosing) output.push(`E:${expandedName}`);
    else frames.push({ expandedName, namespaces });
  }
  if (frames.length) output.push(`UNCLOSED:${frames.map((frame) => frame.expandedName).join(",")}`);
  return output.join("\n");
}

function removeExpectedPptxShapes(
  xml: string,
  expectedTexts: readonly string[],
): { xml: string; removed: number } {
  const remaining = new Map<string, number>();
  for (const text of expectedTexts) remaining.set(text, (remaining.get(text) ?? 0) + 1);
  let removed = 0;
  const next = xml.replace(/<p:sp\b[^>]*>[\s\S]*?<\/p:sp>/gi, (shape) => {
    const text = [...shape.matchAll(/<(?:[A-Za-z_][\w.-]*:)?t\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?t>/gi)]
      .map((match) => decodeXmlText(match[1]))
      .join("");
    const count = remaining.get(text) ?? 0;
    if (count <= 0) return shape;
    remaining.set(text, count - 1);
    removed += 1;
    return "";
  });
  const complete = [...remaining.values()].every((count) => count === 0);
  return { xml: complete ? next : xml, removed: complete ? removed : 0 };
}

function inspectPptxPreservation(
  sourceFile: string,
  outputFile: string,
  expectedShapeRemovals: ReadonlyArray<{ slide: number; text: string }>,
  features: Set<string>,
  evidence: string[],
): void {
  const source = new AdmZip(sourceFile);
  const output = new AdmZip(outputFile);
  const changed = new Set(expectedShapeRemovals.map(({ slide }) => slide));
  const unchangedSlides = (entryName: string): boolean => {
    const match = entryName.match(/^ppt\/slides\/slide(\d+)\.xml$/i);
    return !!match && !changed.has(Number(match[1]));
  };
  const exactGroups = [
    {
      feature: "pptx-unrelated-slides-preserved",
      predicate: unchangedSlides,
    },
    {
      feature: "pptx-notes-content-preserved",
      predicate: (entryName: string) => /^ppt\/notesSlides\//i.test(entryName),
    },
    {
      feature: "pptx-master-layout-theme-preserved",
      predicate: (entryName: string) => /^ppt\/(?:slideMasters|slideLayouts|notesMasters|handoutMasters|theme)\//i.test(entryName),
    },
    {
      feature: "pptx-relationships-preserved",
      predicate: (entryName: string) => /^ppt\/.+\.rels$/i.test(entryName),
    },
    {
      feature: "pptx-media-embeddings-preserved",
      predicate: (entryName: string) => /^ppt\/(?:media|embeddings)\//i.test(entryName),
    },
    {
      feature: "pptx-presentation-structure-preserved",
      predicate: (entryName: string) => /^ppt\/(?:presentation|presProps|viewProps|tableStyles)\.xml$/i.test(entryName),
    },
  ];
  const groupResults = exactGroups.map(({ feature, predicate }) => {
    const pass = pptxPartMapsEqual(
      pptxZipPartMap(source, predicate),
      pptxZipPartMap(output, predicate),
    );
    if (pass) features.add(feature);
    return { feature, pass };
  });
  const targetDeltaResults = [...changed].map((slide) => {
    const entryName = `ppt/slides/slide${slide}.xml`;
    const sourceXml = source.getEntry(entryName)?.getData().toString("utf8") || "";
    const outputXml = output.getEntry(entryName)?.getData().toString("utf8") || "";
    const expectedTexts = expectedShapeRemovals
      .filter((removal) => removal.slide === slide)
      .map((removal) => removal.text);
    const expected = removeExpectedPptxShapes(sourceXml, expectedTexts);
    return expected.removed === expectedTexts.length
      && normalizePptxXml(expected.xml) === normalizePptxXml(outputXml);
  });
  const targetDeltaExact = targetDeltaResults.length > 0 && targetDeltaResults.every(Boolean);
  if (targetDeltaExact) features.add("pptx-requested-slide-delta-exact");
  const motionResults = [...changed].map((slide) => {
    const entryName = `ppt/slides/slide${slide}.xml`;
    const sourceXml = source.getEntry(entryName)?.getData().toString("utf8") || "";
    const outputXml = output.getEntry(entryName)?.getData().toString("utf8") || "";
    const expected = pptxMotionMarkup(sourceXml);
    return expected.length > 0
      && JSON.stringify(expected) === JSON.stringify(pptxMotionMarkup(outputXml));
  });
  const motionPreserved = motionResults.length > 0 && motionResults.every(Boolean);
  if (motionPreserved) features.add("pptx-motion-markup-preserved");
  if (groupResults.every(({ pass }) => pass) && targetDeltaExact && motionPreserved) {
    features.add("pptx-protected-package-parts-preserved");
  }
  evidence.push(
    `pptx_preservation=${JSON.stringify(path.basename(outputFile))}`
    + ` source=${JSON.stringify(path.basename(sourceFile))}`
    + ` expectedShapeRemovals=${expectedShapeRemovals.map(({ slide, text }) => `${slide}:${text}`).join(",") || "none"}`
    + ` ${groupResults.map(({ feature, pass }) => `${feature}=${pass}`).join(" ")}`
    + ` pptx-requested-slide-delta-exact=${targetDeltaExact}`
    + ` pptx-motion-markup-preserved=${motionPreserved}`,
  );
}

async function inspectPdf(
  file: string,
  sourceBytes: number,
  features: Set<string>,
  evidence: string[],
): Promise<void> {
  const bytes = fs.readFileSync(file);
  const document = await PDFDocument.load(bytes, { updateMetadata: false });
  const pageCount = document.getPageCount();
  const page2Rotation = pageCount >= 2 ? document.getPage(1).getRotation().angle : -1;
  features.add("pdf-valid-package");
  if (pageCount === 4) features.add("pdf-four-pages");
  if (((page2Rotation % 360) + 360) % 360 === 90) features.add("pdf-page2-rotated-90");
  if (bytes.length > sourceBytes + 2_000) features.add("pdf-visible-overlay-added");
  evidence.push(
    `pdf=${JSON.stringify(path.basename(file))} pages=${pageCount}`
    + ` page2Rotation=${page2Rotation} bytes=${bytes.length}`,
  );
}

export async function inspectOfficeProductionArtifacts(
  root: string,
  producedFiles: readonly string[],
  fixture: OfficeProductionFixtureState,
): Promise<OfficeProductionArtifactInspection> {
  const features = new Set<string>();
  const evidence: string[] = [];
  const preserved = Object.entries(fixture.sourceHashes).map(([relative, expected]) => {
    const absolute = path.join(root, ...relative.split("/"));
    const pass = fs.existsSync(absolute) && sha256(absolute) === expected;
    if (pass) features.add(`source-preserved:${relative}`);
    evidence.push(`source=${JSON.stringify(relative)} preserved=${pass}`);
    return pass;
  });
  if (preserved.length && preserved.every(Boolean)) features.add("source-fixtures-preserved");

  const sourcePdf = Object.keys(fixture.sourceHashes).find((file) => file.endsWith(".pdf"));
  const sourcePdfBytes = sourcePdf
    ? fs.statSync(path.join(root, ...sourcePdf.split("/"))).size
    : 0;
  for (const relative of producedFiles) {
    if (relative.startsWith("artifacts/")) continue;
    const absolute = path.join(root, ...relative.split("/"));
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) continue;
    try {
      const extension = path.extname(relative).toLowerCase();
      if (extension === ".xlsx") inspectXlsx(absolute, features, evidence);
      else if (extension === ".docx") inspectDocx(absolute, features, evidence);
      else if (extension === ".pptx") inspectPptx(absolute, features, evidence);
      else if (extension === ".pdf") await inspectPdf(absolute, sourcePdfBytes, features, evidence);
    } catch (error) {
      evidence.push(
        `artifact=${JSON.stringify(relative)} inspectionError=${JSON.stringify((error as Error).message)}`,
      );
    }
  }
  const preservation = fixture.pptxPreservation;
  const preservedOutput = preservation
    ? producedFiles.find((file) => file.toLowerCase().endsWith(".pptx"))
    : undefined;
  if (preservation && preservedOutput) {
    const sourceFile = path.join(root, ...preservation.sourceFile.split("/"));
    const outputFile = path.join(root, ...preservedOutput.split("/"));
    try {
      inspectPptxPreservation(
        sourceFile,
        outputFile,
        preservation.expectedShapeRemovals,
        features,
        evidence,
      );
    } catch (error) {
      evidence.push(
        `pptx_preservation=${JSON.stringify(preservedOutput)}`
        + ` inspectionError=${JSON.stringify((error as Error).message)}`,
      );
    }
  }
  return { features: [...features].sort(), evidence };
}
