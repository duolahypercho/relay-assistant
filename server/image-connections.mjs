// SPDX-License-Identifier: MIT
import { imageSize } from 'image-size';
import { encrypt, decrypt } from './google.mjs';
import { modelEndpoint } from './model-connections.mjs';
import { modelJSON } from './model-stream.mjs';
import { avatarStyles, imageFormats } from '../shared/image-catalog.mjs';

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
function clean(value, label, max, optional = false) {
  if (
    typeof value !== 'string' ||
    value.length > max ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    (!optional && !value.trim())
  )
    throw fail(`Enter a valid ${label}.`);
  return value.trim();
}
function safe(record) {
  if (!record?.baseUrl || !record?.model) return null;
  return {
    baseUrl: record.baseUrl,
    model: record.model,
    format: record.format,
    hasKey: !!record.apiKey,
  };
}

// This capability is owner-invoked. It never borrows a chat key or reads chat/role/memory context.
export class ImageConnections {
  constructor(store, { key, environment = {}, fetcher = fetch, timeoutMs = 180000 }) {
    this.store = store;
    this.key = key;
    this.environment = { ...environment, format: environment.format || 'gpt-image' };
    if (safe(this.environment)) {
      this.environment.baseUrl = modelEndpoint(this.environment.baseUrl);
      this.environment.model = clean(this.environment.model, 'image model ID', 200);
      if (!imageFormats.some((format) => format.id === this.environment.format))
        throw fail('Choose a supported image API format.');
    }
    this.fetcher = fetcher;
    this.timeoutMs = timeoutMs;
    this.pending = false;
    this.read();
  }
  read() {
    const raw = this.store.secret('image-connections');
    if (!raw)
      return { revision: 0, mode: safe(this.environment) ? 'environment' : 'off', saved: null };
    try {
      return decrypt(raw, this.key);
    } catch {
      throw fail('Saved image connection could not be unlocked. Restore the model vault key.', 503);
    }
  }
  record(state = this.read()) {
    return state.mode === 'environment'
      ? this.environment
      : state.mode === 'saved'
        ? state.saved
        : null;
  }
  publicState() {
    const state = this.read();
    return {
      revision: state.revision,
      mode: state.mode,
      configured: !!safe(this.record(state)),
      saved: safe(state.saved),
      environment: safe(this.environment),
    };
  }
  fresh(input) {
    const state = this.read();
    if (input?.revision !== state.revision)
      throw fail(
        'Image settings changed in another window. Reload the image settings and try again.',
        409,
      );
    return state;
  }
  update(input) {
    const state = this.fresh(input);
    if (this.pending)
      throw fail('Finish or stop image generation before changing its connection.', 409);
    let next;
    if (input.action === 'save') {
      const baseUrl = modelEndpoint(input.baseUrl);
      if (!imageFormats.some((f) => f.id === input.format))
        throw fail('Choose a supported image API format.');
      const saved = {
        baseUrl,
        format: input.format,
        model: clean(input.model, 'image model ID', 200),
        apiKey:
          input.apiKey === undefined
            ? state.saved?.baseUrl === baseUrl && state.saved?.format === input.format
              ? state.saved.apiKey
              : ''
            : clean(input.apiKey, 'API key', 8192, true),
      };
      next = { mode: 'saved', saved };
    } else if (input.action === 'remove') next = { mode: 'off', saved: null };
    else if (input.action === 'select' && ['off', 'saved', 'environment'].includes(input.mode)) {
      if (input.mode !== 'off' && !safe(input.mode === 'saved' ? state.saved : this.environment))
        throw fail('Save an image connection first.');
      next = { ...state, mode: input.mode };
    } else throw fail('Choose a supported image settings action.');
    this.store.secret(
      'image-connections',
      encrypt({ ...next, revision: state.revision + 1 }, this.key),
    );
    return this.publicState();
  }
  async generate(input, cancellation) {
    const state = this.fresh(input);
    const record = this.record(state);
    if (!safe(record)) throw fail('Connect an image service before generating a character.');
    if (this.pending)
      throw fail('An image is already being generated. Wait for it to finish.', 429);
    if (
      typeof input.prompt !== 'string' ||
      !input.prompt.trim() ||
      input.prompt.length > 2000 ||
      /[\u0000\u007f]/.test(input.prompt)
    )
      throw fail('Describe your character in 2,000 characters or fewer.');
    const style = avatarStyles.find((entry) => entry.id === input.style);
    if (!style) throw fail('Choose a character style.');
    const endpoint = modelEndpoint(record.baseUrl);
    const signal = AbortSignal.any([
      AbortSignal.timeout(this.timeoutMs),
      ...(cancellation ? [cancellation] : []),
    ]);
    signal.throwIfAborted();
    const body = {
      model: record.model,
      prompt: `Create one original friendly assistant character for a small square avatar. A single centered subject, clear silhouette, generous space around the subject, simple background, no lettering or logos. ${style.prompt}\nCharacter description: ${input.prompt.trim()}`,
      n: 1,
      ...(record.format === 'gpt-image'
        ? { size: '1024x1024', output_format: 'png', quality: 'medium' }
        : { response_format: 'b64_json' }),
    };
    this.pending = true;
    try {
      let response;
      try {
        response = await this.fetcher(`${endpoint}/images/generations`, {
          method: 'POST',
          redirect: 'error',
          signal,
          headers: {
            'Content-Type': 'application/json',
            ...(record.apiKey ? { Authorization: `Bearer ${record.apiKey}` } : {}),
          },
          body: JSON.stringify(body),
        });
      } catch {
        if (signal.aborted) throw signal.reason;
        throw fail('The image service could not be reached. Check the connection and try again.');
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw fail(
          `The image service returned HTTP ${response.status}. Check the model, key and provider account.`,
        );
      }
      const result = await modelJSON(response, 14_000_000);
      signal.throwIfAborted();
      const encoded = result?.data?.[0]?.b64_json;
      if (
        result?.error ||
        !Array.isArray(result?.data) ||
        result.data.length !== 1 ||
        typeof encoded !== 'string' ||
        encoded.length > 13_333_336 ||
        encoded.length % 4 ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)
      )
        throw fail('The image service did not return one base64 picture. Check its API format.');
      const bytes = Buffer.from(encoded, 'base64');
      let dimensions;
      try {
        dimensions = imageSize(bytes);
      } catch {
        throw fail('The image service returned an unreadable picture.');
      }
      const mime = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' }[dimensions.type];
      if (
        !mime ||
        !dimensions.width ||
        !dimensions.height ||
        dimensions.width * dimensions.height > 24_000_000 ||
        dimensions.width > 8192 ||
        dimensions.height > 8192 ||
        bytes.length > 10_000_000
      )
        throw fail('Use a PNG, JPEG or WebP result under 10 MB and 24 megapixels.');
      // Never fetch a provider-returned URL or retain full output in workspace history.
      return { mime, data: bytes.toString('base64') };
    } catch (error) {
      if (signal.aborted)
        throw fail(
          cancellation?.aborted
            ? 'Image generation stopped.'
            : 'Image generation timed out. Try again when ready.',
        );
      throw error;
    } finally {
      this.pending = false;
    }
  }
}
