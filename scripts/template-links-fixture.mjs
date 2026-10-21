// SPDX-License-Identifier: MIT
import { command } from '../shared/domain.mjs';
import { prepareTemplate } from '../shared/assistant-templates.mjs';
import { AssistantTemplates, templateReview } from '../server/assistant-templates.mjs';
import { templateAppLink } from '../shared/assistant-template-links.mjs';
export function publishAcceptanceTemplate(fixture, name = 'Aster travel kit') {
  const act = (action, payload) => fixture.store.mutate((s) => command(s, action, payload));
  const assistant = act('assistant.create', {
    name,
    description: 'Plan calm trips with room to rest.',
    tone: 'Brief',
    avatarColor: '#decfa0',
  });
  act('routine.create', {
    title: 'Travel check',
    instructions: 'Check travel weather.',
    threadId: assistant.threadId,
    schedule: { kind: 'daily', time: '09:00', timeZone: 'UTC' },
  });
  const template = prepareTemplate(fixture.store.read(), assistant.id).template;
  const manager = new AssistantTemplates(fixture.store);
  const record = manager.save({
    assistantId: assistant.id,
    template,
    access: 'public',
    reviewedDigest: templateReview(template, 'public').digest,
  });
  const source = fixture.url + '/share/assistant/' + record.token;
  return { source, link: templateAppLink(source), template, record, manager };
}
