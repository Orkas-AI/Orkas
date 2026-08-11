import { expect, test } from './fixtures/orkas';

test.describe('localized context process status', () => {
  test('renders every semantic context phase in all supported languages', async ({
    appPage,
  }) => {
    const locales = [
      {
        code: 'en',
        expected: [
          'Organize conversation history',
          'Conversation history organized',
          'Could not organize conversation history',
          'Organize current task progress',
          'Current task progress organized',
          'Could not organize current task progress',
        ],
      },
      {
        code: 'zh',
        expected: [
          '整理历史对话',
          '历史对话已整理',
          '历史对话整理失败',
          '整理当前任务进展',
          '当前任务进展已整理',
          '当前任务进展整理失败',
        ],
      },
      {
        code: 'ja',
        expected: [
          '会話履歴を整理',
          '会話履歴の整理完了',
          '会話履歴の整理に失敗',
          '現在のタスク進捗を整理',
          '現在のタスク進捗を整理しました',
          '現在のタスク進捗を整理できませんでした',
        ],
      },
      {
        code: 'pt',
        expected: [
          'Organizar histórico da conversa',
          'Histórico da conversa organizado',
          'Falha ao organizar o histórico da conversa',
          'Organizar o progresso da tarefa atual',
          'Progresso da tarefa atual organizado',
          'Não foi possível organizar o progresso da tarefa atual',
        ],
      },
    ];
    const phases = [
      'history_summary_start',
      'history_summary_done',
      'history_summary_failed',
      'active_process_compaction_start',
      'active_process_compaction_done',
      'active_process_compaction_failed',
    ];

    for (const locale of locales) {
      const rendered = await appPage.evaluate(async ({ language, contextPhases }) => {
        await (window as any).setLang(language);
        return contextPhases.map((phase) => (window as any)._formatEventLine({
          stream: 'context',
          data: {
            phase,
            message: 'RAW_CONTEXT_MESSAGE_MUST_NOT_RENDER',
          },
        }));
      }, { language: locale.code, contextPhases: phases });

      expect(rendered).toEqual(locale.expected);
      expect(rendered.join(' ')).not.toContain('RAW_CONTEXT_MESSAGE_MUST_NOT_RENDER');
    }
  });
});
