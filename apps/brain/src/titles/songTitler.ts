// Song titles from the language model (the self-hosted DeepSeek the assistant
// uses, reasoning off). Generation itself stays deterministic: the songs router
// creates the project under a placeholder title ("Edm in C") and reports it
// here; the titler then asks the model for a title and renames the project —
// only if it still carries that placeholder (the user may have renamed it).
//
// A failed call leaves the placeholder in place and is logged as an error: the
// song is fully usable either way, and the user can rename it by hand.

import { genreLabel } from '@casperaki/song-schema';
import { writtenLyricsOf } from '@casperaki/arrangement';
import type { Song } from '@casperaki/song-schema';
import type { SongsStore } from '../store.js';
import { drawTitles, TITLE_EXAMPLES, titleBank } from './titleBank.js';

export interface TitleEndpoint {
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey?: string;
}

export interface UntitledSong {
  readonly ownerId: string;
  readonly songId: string;
  readonly song: Song;
  readonly placeholderTitle: string;
}

const TIMEOUT_MS = 30_000;
const MAX_TITLE_LENGTH = 60;
const RECENT_TITLES = 40;
/** Answers asked for before giving up when the model keeps copying an example title. */
const MAX_ATTEMPTS = 3;
const titleKey = (t: string) => t.toLowerCase().replace(/[^a-z' ]/gu, '').replace(/\s+/gu, ' ').trim();

export class SongTitler {
  private readonly pending = new Set<Promise<void>>();

  constructor(
    private readonly endpoint: TitleEndpoint,
    private readonly store: SongsStore,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  /** Start naming a new song in the background; settles when naming is over (named or not). */
  name(untitled: UntitledSong): Promise<void> {
    const job = this.run(untitled)
      .catch((err: unknown) => {
        console.error(`[titles] could not name song ${untitled.songId}: ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => this.pending.delete(job));
    this.pending.add(job);
    return job;
  }

  /** Resolves when every started naming job has finished (for tests and shutdown). */
  async idle(): Promise<void> {
    await Promise.all([...this.pending]);
  }

  private async run({ ownerId, songId, song, placeholderTitle }: UntitledSong): Promise<void> {
    const taken = this.store
      .listProjects(ownerId)
      .map((p) => p.title)
      .filter((t) => t !== placeholderTitle)
      .slice(0, RECENT_TITLES);
    // A title copied from the examples (or the bank) is asked for again, with other examples.
    let title: string | undefined;
    const bank = new Set(titleBank().map(titleKey));
    for (let attempt = 1; attempt <= MAX_ATTEMPTS && title === undefined; attempt++) {
      const answer = await this.ask(songPrompt(song, taken, drawTitles(titleBank(), TITLE_EXAMPLES, Math.random)));
      if (!bank.has(titleKey(answer))) title = answer;
    }
    if (title === undefined) throw new Error(`the title model copied an example title ${MAX_ATTEMPTS} times`);
    const project = this.store.getProject(ownerId, songId);
    if (!project) return; // deleted meanwhile
    if (project.title !== placeholderTitle) return; // renamed by the user meanwhile
    this.store.renameProject({ ownerId, songId, title, updatedAt: this.now() });
  }

  private async ask(prompt: string): Promise<string> {
    const ep = this.endpoint;
    const url = `${ep.baseUrl.replace(/\/+$/u, '')}/chat/completions`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(ep.apiKey ? { authorization: `Bearer ${ep.apiKey}` } : {}) },
      // Reasoning off (vLLM chat-template switch): a title needs no deliberation.
      body: JSON.stringify({
        model: ep.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.9,
        max_tokens: 60,
        chat_template_kwargs: { thinking: false },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`the title model (${ep.model}) answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const body = (await res.json()) as { choices?: { message?: { content?: string | null } }[] };
    const raw = body.choices?.[0]?.message?.content;
    if (typeof raw !== 'string') throw new Error('the title model answered without any text');
    return cleanTitle(raw);
  }
}

/** The model's answer as a title: first line, quotes and a trailing full stop removed. */
export function cleanTitle(raw: string): string {
  const line = raw.trim().split(/\r?\n/u)[0]!.trim();
  const unquoted = line.replace(/^(?:title\s*:\s*)/iu, '').replace(/^["'“”‘’«»*]+|["'“”‘’«»*]+$/gu, '').trim();
  const title = unquoted.replace(/\.$/u, '').trim();
  if (!title) throw new Error(`the title model's answer has no title in it: ${JSON.stringify(raw.slice(0, 100))}`);
  if (title.length > MAX_TITLE_LENGTH) throw new Error(`the title model's answer is too long for a title (${title.length} characters): ${JSON.stringify(title)}`);
  return title;
}

/** A plain-English request for one title, describing the song; `examples`: titles with the feel to aim for
 *  (titleBank.ts). */
export function songPrompt(song: Song, takenTitles: readonly string[], examples: readonly string[]): string {
  const genre = song.genre ? genreLabel(song.genre).toLowerCase() : 'pop';
  const sections = song.songStructure.map((s) => s.name.replace(/\d+$/u, '')).filter((n, i, all) => all.indexOf(n) === i);
  const instruments = song.instrumentDefinitions.map((d) => d.name).filter((n, i, all) => all.indexOf(n) === i);
  const lyrics = writtenLyricsOf((song.generator?.params as { params?: Record<string, unknown> } | undefined)?.params);
  const chorus = song.songStructure.map((s) => s.name).find((n) => n.startsWith('chorus') && lyrics[n]);
  const lines = [
    `You name songs. Write one original title for the ${chorus ? '' : 'instrumental '}song described below.`,
    '',
    `Style: ${genre}`,
    `Key: ${song.key}`,
    `Tempo: ${song.bpm} beats per minute`,
    `Sections: ${sections.join(', ')}`,
    `Instruments: ${instruments.join(', ')}`,
    ...(chorus ? ['', 'The words of its chorus:', ...lyrics[chorus]!.map((l) => `  ${l}`)] : []),
    '',
    'Rules:',
    ...(chorus ? ['- Take the title from the chorus words where a phrase in them makes a good title, as songs usually do.'] : []),
    '- A short chart-pop title, one to four words in English: a phrase someone would say or sing, like "Bad Idea", "Kiss Me Back" or "Not Your Girl".',
    '- Not a poetic image or a place name like "Cinnamon Boulevard": the chorus is built on the title, so it must sound like something people say.',
    '- Do not mention the style, the key, the tempo or any instrument.',
    '- Do not use the title of a well-known existing song.',
  ];
  if (examples.length > 0) {
    lines.push(`- Aim for the feel of these chart-pop titles (do not copy any of them): ${examples.join('; ')}.`);
  }
  if (takenTitles.length > 0) lines.push(`- Do not reuse or closely imitate any of these titles the user already has: ${takenTitles.join('; ')}.`);
  lines.push('', 'Answer with the title only: no quotation marks, no explanation.');
  return lines.join('\n');
}

