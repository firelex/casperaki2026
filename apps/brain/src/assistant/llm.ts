// The song assistant's language model: any OpenAI-compatible chat endpoint
// with tool calling (the self-hosted DeepSeek on the B200 in production).
// One call = one model turn, streamed: text pieces go to onText as they come,
// tool calls are gathered and returned whole at the end.

export interface ChatMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: string | null;
  readonly tool_calls?: readonly ModelToolCall[];
  readonly tool_call_id?: string;
}

export interface ModelToolCall {
  readonly id: string;
  readonly type: 'function';
  readonly function: { readonly name: string; readonly arguments: string };
}

export interface ModelTurn {
  readonly content: string;
  readonly toolCalls: readonly ModelToolCall[];
}

export interface AssistantLlm {
  turn(messages: readonly ChatMessage[], tools: readonly unknown[], onText: (text: string) => void, signal: AbortSignal): Promise<ModelTurn>;
}

const TIMEOUT_MS = 120_000;

export class OpenAiCompatibleLlm implements AssistantLlm {
  constructor(private readonly endpoint: { baseUrl: string; model: string; apiKey?: string }) {}

  async turn(messages: readonly ChatMessage[], tools: readonly unknown[], onText: (text: string) => void, signal: AbortSignal): Promise<ModelTurn> {
    const ep = this.endpoint;
    const url = `${ep.baseUrl.replace(/\/+$/u, '')}/chat/completions`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(ep.apiKey ? { authorization: `Bearer ${ep.apiKey}` } : {}) },
        // Reasoning off: the self-hosted DeepSeek reasons by default (vLLM chat-template switch),
        // which makes every turn many seconds slower for no gain on these edits.
        body: JSON.stringify({
          model: ep.model,
          messages,
          tools,
          tool_choice: 'auto',
          temperature: 0.3,
          chat_template_kwargs: { thinking: false },
          stream: true,
        }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
      });
    } catch (err) {
      throw new Error(`The assistant model at ${url} could not be reached (is the B200 tunnel up?): ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!res.ok) throw new Error(`The assistant model (${ep.model}) answered ${res.status}: ${(await res.text()).slice(0, 500)}`);
    if (!res.body) throw new Error('The assistant model answered without a body.');

    // Server-sent events: "data: {json}" lines, "data: [DONE]" at the end. Tool
    // calls arrive in pieces keyed by index (id and name first, arguments in parts).
    const decoder = new TextDecoder();
    let buffered = '';
    let content = '';
    const calls: { id: string; name: string; args: string }[] = [];
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buffered += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, nl).trim();
        buffered = buffered.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        const event = JSON.parse(data) as {
          choices?: { delta?: { content?: string | null; tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[] } }[];
        };
        const delta = event.choices?.[0]?.delta;
        if (!delta) continue;
        if (typeof delta.content === 'string' && delta.content) {
          content += delta.content;
          onText(delta.content);
        }
        for (const part of delta.tool_calls ?? []) {
          const call = (calls[part.index] ??= { id: '', name: '', args: '' });
          if (part.id) call.id = part.id;
          if (part.function?.name) call.name += part.function.name;
          if (part.function?.arguments) call.args += part.function.arguments;
        }
      }
    }
    const toolCalls = calls.map((c, i) => {
      if (!c.name) throw new Error(`The assistant model sent tool call ${i} without a name.`);
      return { id: c.id || `call_${i}`, type: 'function' as const, function: { name: c.name, arguments: c.args || '{}' } };
    });
    return { content, toolCalls };
  }
}
