// The music video's scene plan, written by a language model (DeepSeek) from
// the engine's own planner prompt, validated by the engine's ScenePlanSchema.

import { assertPlanFitsSong, plannerPrompt, ScenePlanSchema, type ScenePlan, type VideoInput } from '@casperaki/video';

export interface Planner {
  plan(input: VideoInput): Promise<ScenePlan>;
}

const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';
const MODEL = 'deepseek-chat';
const TIMEOUT_MS = 180_000;

export class MissingPlannerKeyError extends Error {
  constructor() {
    super('DEEPSEEK_API_KEY is not set on the brain (~/.config/casperaki/brain.env): music videos need it for the scene plan.');
  }
}

/** Plans with DeepSeek: one retry that sends the validation errors back, then a loud failure. */
export class DeepSeekPlanner implements Planner {
  constructor(private readonly apiKey: string | undefined) {}

  async plan(input: VideoInput): Promise<ScenePlan> {
    if (!this.apiKey) throw new MissingPlannerKeyError();
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
    const res = await fetch(DEEPSEEK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ model: MODEL, messages, response_format: { type: 'json_object' }, temperature: 0.7 }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`DeepSeek answered ${res.status}: ${text.slice(0, 500)}`);
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
