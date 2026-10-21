// SPDX-License-Identifier: MIT
// Endpoint presets, not a bundled model catalog. Model IDs come from the provider or the owner.
export const localOllamaConnection = (record) =>
  record.protocol === 'chat' && record.baseUrl === 'http://127.0.0.1:11434/v1';

// Quick local inference benefits from loading capability schemas on demand.
// This changes prompt size only; it does not alter tool availability or authority.
export const compactToolCatalogRequested = (record) =>
  !!record && localOllamaConnection(record) && record.replyMode === 'quick';

export const modelProtocols = [
  { id: 'responses', name: 'OpenAI Responses' },
  { id: 'chat', name: 'OpenAI Chat Completions' },
  { id: 'anthropic', name: 'Anthropic Messages' },
  { id: 'gemini', name: 'Google Gemini' },
];
export const modelPresets = [
  { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', protocol: 'responses' },
  {
    id: 'anthropic',
    name: 'Anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    protocol: 'anthropic',
  },
  {
    id: 'google',
    name: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    protocol: 'gemini',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    protocol: 'chat',
  },
  { id: 'xai', name: 'xAI / Grok', baseUrl: 'https://api.x.ai/v1', protocol: 'chat' },
  { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', protocol: 'chat' },
  { id: 'groq', name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', protocol: 'chat' },
  { id: 'mistral', name: 'Mistral', baseUrl: 'https://api.mistral.ai/v1', protocol: 'chat' },
  { id: 'together', name: 'Together AI', baseUrl: 'https://api.together.xyz/v1', protocol: 'chat' },
  {
    id: 'ollama',
    name: 'Ollama · local',
    baseUrl: 'http://127.0.0.1:11434/v1',
    protocol: 'chat',
    local: true,
  },
  {
    id: 'lmstudio',
    name: 'LM Studio · local',
    baseUrl: 'http://127.0.0.1:1234/v1',
    protocol: 'chat',
    local: true,
  },
  { id: 'custom', name: 'Custom endpoint', baseUrl: '', protocol: 'chat', local: true },
];
