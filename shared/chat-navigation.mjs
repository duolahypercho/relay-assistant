// SPDX-License-Identifier: MIT
// Navigation is deliberately narrow: only an explicit request to open a named page.
// Questions, instructions, attachments and quoted text still belong to the assistant.
const destinations = [
  ['files', undefined, ['files', 'documents', 'file library']],
  ['activity', undefined, ['tasks', 'task list']],
  ['ideas', undefined, ['ideas']],
  ['calendar', undefined, ['calendar']],
  ['inbox', undefined, ['mail', 'inbox']],
  ['routines', undefined, ['routines', 'reminders']],
  ['goals', undefined, ['goals']],
  ['finance', undefined, ['spending']],
  ['computer', undefined, ['computer', 'virtual computer']],
  ['skills', undefined, ['skills']],
  ['assistants', undefined, ['assistants']],
  ['apps', undefined, ['apps', 'connected apps']],
  ['settings', undefined, ['settings', 'preferences']],
  ['settings', 'personal', ['appearance settings', 'theme settings']],
  ['settings', 'voice', ['voice settings']],
  ['settings', 'models', ['model settings', 'ai models']],
  ['settings', 'notifications', ['notification settings']],
  ['settings', 'memory', ['memory settings']],
  ['settings', 'archive', ['archived chats']],
  ['settings', 'usage', ['model usage']],
];

export function chatNavigation(text, context = {}) {
  if (
    typeof text !== 'string' ||
    text.length > 120 ||
    /[\r\n]/.test(text) ||
    context.hasContext ||
    context.busy
  )
    return null;
  const request = text.trim().toLowerCase().replace(/\s+/g, ' ');
  const chinese = request.match(
    /^(?:请|請)?(?:打开|打開|查看|前往)(?:我的|我们的|我們的)?([^，。！？,!?]+)[。！!]?$/,
  );
  if (chinese) {
    const names = [
      ['files', undefined, ['文件', '檔案']],
      ['activity', undefined, ['任务', '任務']],
      ['ideas', undefined, ['灵感', '靈感']],
      ['calendar', undefined, ['日历', '行事曆']],
      ['inbox', undefined, ['邮件', '郵件']],
      ['routines', undefined, ['例行事项', '例行事項']],
      ['computer', undefined, ['电脑', '電腦']],
      ['settings', undefined, ['设置', '設定']],
      ['settings', 'personal', ['外观设置', '外觀設定', '语言设置', '語言設定']],
    ];
    const destination = names.find(([, , aliases]) => aliases.includes(chinese[1]));
    return destination ? { page: destination[0], section: destination[1] } : null;
  }
  const match = request.match(
    /^(?:please )?(?:open|show(?: me)?|go to|take me to) (?:(?:my|the|our) )?(.+?)(?:,? please)?[.!?]?$/,
  );
  if (!match) return null;
  const destination = destinations.find(([, , names]) => names.includes(match[1]));
  return destination ? { page: destination[0], section: destination[1] } : null;
}
