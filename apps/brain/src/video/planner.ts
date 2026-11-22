// The music video's scene plan, written by a language model (DeepSeek) from
// the engine's own planner prompt, validated by the engine's ScenePlanSchema.

import { assertPlanFitsSong, plannerPrompt, ScenePlanSchema, type ScenePlan, type VideoInput } from '@casperaki/video';

export interface Planner {
  plan(input: VideoInput): Promise<ScenePlan>;
}

const TIMEOUT_MS = 300_000;

/** Where the scene planner runs: an OpenAI-compatible chat endpoint (the
 *  self-hosted DeepSeek on the B200 needs no key; a key is sent only if set). */
export interface PlannerEndpoint {
  /** Base URL up to /v1, e.g. http://127.0.0.1:18022/v1. */
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey?: string | undefined;
}

export class MissingPlannerConfigError extends Error {
  constructor() {
    super(
      'The scene planner is not set up on the brain: set VIDEO_PLANNER_URL (e.g. http://127.0.0.1:18022/v1, the B200 DeepSeek tunnel) and VIDEO_PLANNER_MODEL in ~/.config/casperaki/brain.env.',
    );
  }
}

/** Plans with DeepSeek: one retry that sends the validation errors back, then a loud failure. */
export class DeepSeekPlanner implements Planner {
  constructor(private readonly endpoint: PlannerEndpoint | undefined) {}

  async plan(input: VideoInput): Promise<ScenePlan> {
    if (!this.endpoint) throw new MissingPlannerConfigError();
    const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
      { role: 'system', content: 'You plan music videos. Answer with one JSON object only: the scene plan, nothing else.' },
      { role: 'user', content: plannerPrompt(input) },
    ];
    let lastErrors = '';
    for (let attempt = 1; attempt <= 2; attempt++) {
      const answer = await this.complete(messages);
      const problems = validate(answer, input);
      if (problems.plan) return problems.plan;
      lastErrors = problems.errors;
      messages.push({ role: 'assistant', content: answer });
      messages.push({
        role: 'user',
        content: `That plan is not valid. Fix these problems and answer with the whole corrected plan as one JSON object:\n${problems.errors}`,
      });
    }
    throw new Error(`The scene planner returned an invalid plan twice:\n${lastErrors}`);
  }

  private async complete(messages: { role: string; content: string }[]): Promise<string> {
    const ep = this.endpoint!;
    const url = `${ep.baseUrl.replace(/\/+$/u, '')}/chat/completions`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(ep.apiKey ? { authorization: `Bearer ${ep.apiKey}` } : {}) },
        // Reasoning off: the plan is a structured fill-in, and the self-hosted
        // DeepSeek reasons by default (vLLM chat-template switch).
        body: JSON.stringify({
          model: ep.model,
          messages,
          response_format: { type: 'json_object' },
          temperature: 0.7,
          chat_template_kwargs: { thinking: false },
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new Error(`The scene planner at ${url} could not be reached (is the B200 tunnel up?): ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`The scene planner (${ep.model}) answered ${res.status}: ${text.slice(0, 500)}`);
    }
    const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) throw new Error('DeepSeek returned no plan text.');
    return content;
  }
}

/** The plan in a model answer, or the problems with it in plain words. */
export function validate(answer: string, input: VideoInput): { plan?: ScenePlan; errors: string } {
  let json: unknown;
  try {
    json = JSON.parse(answer);
  } catch (err) {
    return { errors: `The answer is not JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  const parsed = ScenePlanSchema.safeParse(json);
  if (!parsed.success) {
    return { errors: parsed.error.issues.slice(0, 20).map((i) => `- ${i.path.join('.') || '(plan)'}: ${i.message}`).join('\n') };
  }
  try {
    assertPlanFitsSong(parsed.data, input);
  } catch (err) {
    return { errors: `- ${err instanceof Error ? err.message : String(err)}` };
  }
  return { plan: parsed.data, errors: '' };
}
