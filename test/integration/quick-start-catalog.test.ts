import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { DEFAULT_QUICK_START_CONFIG } from "../../src/main/features/client_config";

const COMMANDER_QUICK_START_CASES = [
  { key: "data", localeKey: "new_chat.quick.tmpl.data", agentId: "78900d8758bc", intent: "调研适合普通用户的 AI 桌面应用，比较主要用途、系统支持、安装与上手难度、模型能力、隐私、本地运行和价格，并根据不同需求给出选择建议。" },
  { key: "office", localeKey: "new_chat.quick.tmpl.office", agentId: "a19101ba698a", intent: "为一家电商店铺制作可编辑的销售月报，使用示例数据，包含核心指标和趋势、渠道图表。" },
  { key: "ppt", localeKey: "new_chat.quick.tmpl.ppt", agentId: "7e91cb9ec9e9", intent: "为一款 AI 办公助手制作一份 8 页可编辑产品介绍 PPT，面向企业客户，包含痛点、产品方案、核心能力、使用场景、价值和下一步行动。" },
  { key: "creation", localeKey: "new_chat.quick.tmpl.creation", agentId: "173d4235a431", intent: "写一篇面向职场人的 AI 办公助手社媒文章。" },
  { key: "image", localeKey: "new_chat.quick.tmpl.image", agentId: "814b61b027f0", intent: "设计一张城市夏日咖啡节海报：8 月 16 日 14:00–20:00，城市中央广场，包含手冲体验、咖啡市集和限定特调。" },
  { key: "video", localeKey: "new_chat.quick.tmpl.video", agentId: "79df9cc89f5f", intent: "制作一条面向普通用户、时长约 45 秒的 AI 发展趋势科普视频。" },
  { key: "ui_design", localeKey: "new_chat.quick.tmpl.ui_design", agentId: "bcfcb4921dce", intent: "设计一套响应式的个人记账应用登录、注册和找回密码 UI，覆盖校验、加载及成功失败状态。" },
  { key: "rnd", localeKey: "new_chat.quick.tmpl.rnd", agentId: "a316881746f9", intent: "用可编辑示例内容，为正在转行的产品设计师制作响应式作品集网站，包含项目、经历、联系方式和简历下载。" },
  { key: "seo_geo", localeKey: "new_chat.quick.tmpl.seo_geo", agentId: "e064dca9e1bd", intent: "为 orkas.ai 官网制定 SEO 与 GEO 方案，覆盖关键词、核心页面、内容和优先级。" },
] as const;

function locale(language: string): Record<string, string> {
  return JSON.parse(
    fs.readFileSync(path.resolve(process.cwd(), `src/renderer/locales/${language}.json`), "utf8"),
  ) as Record<string, string>;
}

describe("Commander quick-start cross-layer catalog", () => {
  it("keeps the runtime order and owner ids aligned with the model regression catalog", () => {
    expect(DEFAULT_QUICK_START_CONFIG).toEqual(
      COMMANDER_QUICK_START_CASES.map((item) => ({
        id: item.key,
        agent_id: item.agentId,
      })),
    );
  });

  it("keeps the Chinese product prompt identical to the model regression intent", () => {
    const zh = locale("zh");
    for (const item of COMMANDER_QUICK_START_CASES) {
      expect(zh[item.localeKey], item.key).toBe(item.intent);
    }
  });

  it("ships a non-empty localized product prompt for every supported UI language", () => {
    for (const language of ["en", "zh", "ja", "pt"]) {
      const messages = locale(language);
      for (const item of COMMANDER_QUICK_START_CASES) {
        expect(messages[item.localeKey]?.trim().length, `${language}/${item.key}`).toBeGreaterThan(10);
      }
    }
  });
});
