// SPDX-License-Identifier: MIT
export const imageFormats = [
  { id: 'gpt-image', name: 'GPT Image' },
  { id: 'base64', name: 'Images API · base64 output' },
];
export const imagePresets = [
  {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-image-1.5',
    format: 'gpt-image',
  },
  {
    id: 'xai',
    name: 'xAI / Grok',
    baseUrl: 'https://api.x.ai/v1',
    model: 'grok-imagine-image-2.0',
    format: 'base64',
  },
  { id: 'custom', name: 'Custom or local service', baseUrl: '', model: '', format: 'base64' },
];
export const avatarStyles = [
  {
    id: 'anime',
    name: 'Anime',
    prompt:
      'Cute original anime companion, soft rounded shapes, expressive eyes, hand-painted shading.',
  },
  {
    id: 'soft',
    name: 'Soft toy',
    prompt:
      'Cute original soft toy character, tactile plush texture, rounded forms, friendly expression.',
  },
  {
    id: 'simple',
    name: 'Simple',
    prompt:
      'Original minimal illustrated character, playful rounded silhouette, clean readable shapes.',
  },
];
