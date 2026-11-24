// A chat language model that answers with JSON text (the self-hosted DeepSeek in production), used to write the
// artwork briefs.

export interface ChatMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

/** A chat model that answers with text; `thinking`: let it reason before it answers. */
export interface ChatModel {
  complete(messages: readonly ChatMessage[], options: { readonly thinking: boolean }): Promise<string>;
}

export interface ChatEndpoint {
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey?: string;
}

const TIMEOUT_MS = 300_000;

/** Any OpenAI-compatible chat endpoint (vLLM's DeepSeek in production), JSON answers. */
export class OpenAiChatModel implements ChatModel {
  constructor(private readonly ep: ChatEndpoint) {}

  async complete(messages: readonly ChatMessage[], options: { readonly thinking: boolean }): Promise<string> {
    const url = `${this.ep.baseUrl.replace(/\/+$/u, '')}/chat/completions`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(this.ep.apiKey ? { authorization: `Bearer ${this.ep.apiKey}` } : {}) },
      body: JSON.stringify({
        model: this.ep.model,
        messages,
        temperature: 0.9,
        max_tokens: options.thinking ? 32000 : 4000,
        response_format: { type: 'json_object' },
        chat_template_kwargs: { thinking: options.thinking },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`the language model (${this.ep.model}) answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const body = (await res.json()) as { choices?: { message?: { content?: string | null } }[] };
    const text = body.choices?.[0]?.message?.content;
    if (typeof text !== 'string') throw new Error('the language model answered without any text');
    return text;
  }
}
