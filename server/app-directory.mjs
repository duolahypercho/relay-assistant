// SPDX-License-Identifier: MIT
// Official, hosted endpoints. Listing does not contact a provider or grant access.
// Sources and unauthenticated protocol checks are recorded in APP_DIRECTORY.md.
export const appDirectory = Object.freeze(
  [
    {
      id: 'notion',
      name: 'Notion',
      description: 'Find notes and keep your pages up to date.',
      keywords: 'notes documents wiki pages knowledge',
      endpoint: 'https://mcp.notion.com/mcp',
      guide: 'https://developers.notion.com/guides/mcp/get-started-with-mcp',
    },
    {
      id: 'todoist',
      name: 'Todoist',
      description: 'Plan your day and manage tasks and projects.',
      keywords: 'tasks reminders todo lists projects planning',
      endpoint: 'https://ai.todoist.net/mcp',
      guide: 'https://developer.todoist.com/',
    },
    {
      id: 'linear',
      name: 'Linear',
      description: 'Follow projects, find issues and update your team’s work.',
      keywords: 'issues tickets projects teams development',
      endpoint: 'https://mcp.linear.app/mcp',
      guide: 'https://linear.app/docs/mcp',
    },
    {
      id: 'sentry',
      name: 'Sentry',
      description: 'Investigate errors and keep an eye on your app’s health.',
      keywords: 'errors bugs performance monitoring software',
      endpoint: 'https://mcp.sentry.dev/mcp',
      guide: 'https://mcp.sentry.dev/',
    },
  ].map(Object.freeze),
);
