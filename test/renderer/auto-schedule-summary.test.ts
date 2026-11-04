import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { LOCALES } from '../../src/main/i18n';

const root = path.resolve(__dirname, '../../src/renderer');
const autoSource = readFileSync(path.join(root, 'modules/auto.js'), 'utf8');
const i18nSource = readFileSync(path.join(root, 'modules/i18n.js'), 'utf8');

// Reviewed display examples, independent of the production formatting rules.
const examples: Record<string, [string, string]> = {
  zh: ['每周一，二，四 09:00', '每月 1，2，4 日 09:00'],
  'zh-tw': ['每週一，二，四 09:00', '每月 1，2，4 日 09:00'],
  en: ['Every Mon, Tue, Thu at 09:00', 'Monthly · 1, 2, 4 · 09:00'],
  fr: ['Chaque lun., mar., jeu. à 09:00', 'Chaque mois · 1, 2, 4 à 09:00'],
  de: ['Jeden Mo., Di., Do. um 09:00', 'Monatlich · 1, 2, 4 um 09:00'],
  hi: ['हर सोम, मंगल, गुरु को 09:00 बजे', 'हर महीने 1, 2, 4 को 09:00 बजे'],
  id: ['Setiap Sen, Sel, Kam pukul 09:00', 'Bulanan · 1, 2, 4 · 09:00'],
  it: ['Ogni lun, mar, gio alle 09:00', 'Ogni mese · 1, 2, 4 alle 09:00'],
  ja: ['毎週 月、火、木 09:00', '毎月 1、2、4日 09:00'],
  ko: ['매주 월, 화, 목 09:00', '매월 1, 2, 4일 09:00'],
  pt: ['Semanal · seg., ter., qui. às 09:00', 'Mensal · 1, 2, 4 às 09:00'],
  'pt-pt': ['Semanal · seg., ter., qui. às 09:00', 'Mensal · 1, 2, 4 às 09:00'],
  ru: ['Еженедельно: пн, вт, чт, 09:00', 'Ежемесячно: 1, 2, 4, 09:00'],
  es: ['Cada lun, mar, jue a las 09:00', 'Cada mes · 1, 2, 4 a las 09:00'],
  'es-419': ['Cada lun, mar, jue a las 09:00', 'Cada mes · 1, 2, 4 a las 09:00'],
  th: ['ทุกจ., อ., พฤ. เวลา 09:00', 'ทุกเดือน วันที่ 1, 2, 4 เวลา 09:00'],
  tr: ['Her Pzt, Sal, Per 09:00', 'Her ay 1, 2, 4, 09:00'],
  vi: ['Mỗi T2, T3, T5 lúc 09:00', 'Hằng tháng ngày 1, 2, 4 lúc 09:00'],
  ar: ['كل الاثنين، الثلاثاء، الخميس في 09:00', 'شهريًا في 1، 2، 4 عند 09:00'],
};

function formatter(lang: string) {
  const table = JSON.parse(readFileSync(path.join(root, `locales/${lang}.json`), 'utf8'));
  const context = vm.createContext({
    window: { __orkasI18nBoot: { lang, tables: { [lang]: table } }, addEventListener() {} },
    document: {
      readyState: 'loading', addEventListener() {}, querySelectorAll: () => [], documentElement: { setAttribute() {} },
      createElement: () => ({
        innerHTML: '', dataset: {}, classList: { add() {} }, setAttribute() {}, addEventListener() {},
        querySelector: () => ({ addEventListener() {} }),
      }),
    },
    escapeHtml: (value: unknown) => String(value ?? ''),
    createLogger: () => ({ warn() {}, info() {}, error() {} }),
  });
  vm.runInContext(i18nSource, context);
  vm.runInContext(autoSource, context);
  return { table, format: (schedule: object, extra = {}) => {
    context.task = { schedule: { hour: 9, minute: 0, ...schedule }, ...extra };
    return vm.runInContext('_autoFormatSummary(task)', context) as string;
  }, renderCard: (extra: object) => {
    context.task = { id: 'history-card', title: 'Review', content: 'Review recent work', enabled: false,
      schedule: { type: 'daily', hour: 9, minute: 0 }, ...extra };
    return vm.runInContext('_autoRenderRow(task, {}).innerHTML', context) as string;
  } };
}

describe('readable automation schedules in every supported locale', () => {
  it('has reviewed examples for the complete locale registry', () => {
    expect(Object.keys(examples).sort()).toEqual(LOCALES.map(locale => locale.code).sort());
  });

  it.each(LOCALES.map(locale => locale.code))('%s keeps every selected day, time, and special month-end meaning', lang => {
    const { format, table } = formatter(lang);
    expect(format({ type: 'weekly', weekdays: [1, 2, 4] })).toBe(examples[lang][0]);
    expect(format({ type: 'monthly', days: [1, 2, 4] })).toBe(examples[lang][1]);
    const last = format({ type: 'monthly', day: 31 });
    const mixed = format({ type: 'monthly', days: [1, 2, 31] });
    expect(last).toContain(table['auto.day_last']);
    expect(mixed).toContain(table['auto.day_last']);
    expect(mixed).toContain('1');
    expect(mixed).toContain('2');
    expect(mixed).not.toContain('31');
    expect(format({ type: 'weekly', weekday: 'workdays' })).toContain(table['auto.workdays']);
    expect(format({ type: 'weekly', weekday: 0 })).toBe(format({ type: 'weekly', weekdays: [0] }));
    expect(format({ type: 'monthly', day: 4 })).toBe(format({ type: 'monthly', days: [4] }));
    expect(format({ type: 'weekly', weekdays: [0, 1, 2, 3, 4, 5, 6] })).not.toMatch(/auto\.|\{\w+\}/);
    const allDates = format({ type: 'monthly', days: Array.from({ length: 31 }, (_, index) => index + 1) });
    expect(allDates.match(/\d+/g)).toEqual([
      ...Array.from({ length: 30 }, (_, index) => String(index + 1)), '09', '00',
    ]);
    expect(allDates).toContain(table['auto.day_last']);
    expect(mixed).not.toMatch(/auto\.|\{\w+\}/);
  });

  it('preserves end conditions and keeps persisted selections unchanged while rendering', () => {
    const { format } = formatter('zh');
    const schedule = { type: 'monthly', days: [1, 2, 31] };
    expect(format(schedule, { end_condition: { type: 'count', max_runs: 4 }, scheduled_run_count: 2 }))
      .toBe('每月 1，2 日，月底 09:00 · 计划执行 2/4 次');
    expect(schedule.days).toEqual([1, 2, 31]);
    expect(format({ type: 'daily' })).toBe('每天 09:00');
    expect(format({ type: 'hourly', interval_hours: 3 })).toBe('每 3 小时');
  });

  it.each([
    ['a task that has never run', undefined],
    ['a task whose execution history was cleared', '2026-10-01T09:00:00.000Z'],
  ])('omits last-run metadata for %s without changing the stored run boundary', (_scenario, lastRunAt) => {
    const record = { last_run_at: lastRunAt };
    const html = formatter('zh').renderCard(record);
    expect(html).toContain('每天 09:00');
    expect(html).not.toContain('auto-row-lastrun');
    expect(html).not.toContain('尚未运行');
    expect(record.last_run_at).toBe(lastRunAt);
  });
});
