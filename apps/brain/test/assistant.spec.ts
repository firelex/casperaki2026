// The song assistant route with a scripted fake model: streaming, tool calls
// running on the song, refused edits as tool errors, page actions, the round cap.

import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseSong, type Song } from '@casperaki/song-schema';

import type { AssistantLlm, ChatMessage, ModelTurn } from '../src/assistant/llm.js';
import { runTool, toolSpecs, ToolError } from '../src/assistant/tools.js';
import { createApp } from '../src/bootstrap.js';
import { loadConfig } from '../src/config.js';
import { openSongsStore, type SongsStore } from '../src/store.js';
import { fakeLyricModel } from './fakeLyricModel.js';

type Script = (messages: readonly ChatMessage[], round: number) => ModelTurn;

class FakeLlm implements AssistantLlm {
  round = 0;
  seen: ChatMessage[][] = [];
  constructor(private readonly script: Script) {}
  async turn(messages: readonly ChatMessage[], _tools: readonly unknown[], onText: (t: string) => void): Promise<ModelTurn> {
    this.seen.push([...messages]);
    const turn = this.script(messages, this.round++);
    if (turn.content) for (const piece of turn.content.match(/.{1,5}/gsu) ?? []) onText(piece);
    return turn;
  }
}

const call = (id: string, name: string, args: unknown) => ({ id, type: 'function' as const, function: { name, arguments: JSON.stringify(args) } });

interface Harness { url: string; stop: () => Promise<void> }
async function boot(llm: AssistantLlm | undefined): Promise<Harness> {
  const store: SongsStore = openSongsStore({ path: ':memory:' });
  const app = createApp(loadConfig({} as NodeJS.ProcessEnv), { lyricModel: fakeLyricModel(), store, ...(llm ? { assistantLlm: llm } : {}) });
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    stop: () => new Promise<void>((resolve) => server.close(() => { store.close(); resolve(); })),
  };
}

const post = (url: string, body: unknown) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function events(res: Response): Promise<Record<string, unknown>[]> {
  const text = await res.text();
  return text.split('\n\n').filter((b) => b.startsWith('data: ')).map((b) => JSON.parse(b.slice(6)) as Record<string, unknown>);
}

async function newSong(h: Harness): Promise<{ id: string; song: Song }> {
  const res = await post(`${h.url}/api/songs/generate`, { genre: 'brightPop', key: 'C', bpm: 120, seed: 'assistant-1' });
  return (await res.json()) as { id: string; song: Song };
}

describe('POST /api/assistant/chat', () => {
  let h: Harness | undefined;
  afterEach(async () => { await h?.stop(); h = undefined; });

  it('answers 503 with a clear message when no model is configured', async () => {
    h = await boot(undefined);
    const { id, song } = await newSong(h);
    const res = await post(`${h.url}/api/assistant/chat`, { message: 'hi', history: [], songId: id, song, title: 't' });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { message: string }).message).toContain('ASSISTANT_LLM_URL');
  });

  it('runs edits on the song, streams text, reports refusals and page actions', async () => {
    const llm = new FakeLlm((messages, round) => {
      if (round === 0) {
        return {
          content: 'On it.',
          toolCalls: [
            call('a', 'add_section', { type: 'bridge', after: 'chorus1' }),
            call('b', 'delete_section', { name: 'nosuchsection' }),
            call('c', 'play', { fromSection: 'chorus1' }),
          ],
        };
      }
      // The second round sees the tool results and the song with the bridge.
      expect(messages[0]!.content).toMatch(/bridge/u);
      return { content: 'Added a bridge after chorus 1.', toolCalls: [] };
    });
    h = await boot(llm);
    const { id, song } = await newSong(h);
    const res = await post(`${h.url}/api/assistant/chat`, { message: 'Add a bridge after chorus 1 and play', chatId: 'x', history: [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'Hi!' }], songId: id, song, title: 'My song' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const ev = await events(res);

    const text = ev.filter((e) => e.type === 'chunk').map((e) => e.text).join('');
    expect(text).toBe('On it.Added a bridge after chorus 1.');
    expect(ev.at(-1)).toEqual({ type: 'done' });

    const added = ev.find((e) => e.type === 'tool_result' && e.id === 'a') as { result: { summary: string; song: Song } };
    const names = parseSong(added.result.song).songStructure.map((s) => s.name);
    expect(names[names.indexOf('chorus1') + 1]).toMatch(/^bridge/u);
    expect(ev.find((e) => e.type === 'tool_call' && e.id === 'a')).toMatchObject({ name: 'add_section', args: { type: 'bridge', after: 'chorus1' } });

    expect(ev.find((e) => e.id === 'b')).toBeDefined();
    expect(ev.find((e) => e.type === 'tool_error' && e.id === 'b')).toMatchObject({ error: expect.stringContaining('no section "nosuchsection"') });

    expect(ev.find((e) => e.type === 'tool_result' && e.id === 'c')).toMatchObject({ result: { action: { kind: 'play', fromSection: 'chorus1' } } });
    expect(llm.seen[0]!.slice(1).map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
  });

  it('stops after 10 rounds of tool calls with an error event', async () => {
    h = await boot(new FakeLlm(() => ({ content: '', toolCalls: [call('x', 'get_song', {})] })));
    const { id, song } = await newSong(h);
    const ev = await events(await post(`${h.url}/api/assistant/chat`, { message: 'loop', history: [], songId: id, song, title: '' }));
    expect(ev.filter((e) => e.type === 'tool_result')).toHaveLength(10);
    expect(ev.at(-1)).toMatchObject({ type: 'error', message: expect.stringContaining('10 rounds') });
  });

  it('refuses a song the user does not own and a broken song', async () => {
    h = await boot(new FakeLlm(() => ({ content: 'x', toolCalls: [] })));
    const { id, song } = await newSong(h);
    expect((await post(`${h.url}/api/assistant/chat`, { message: 'hi', songId: 'nope', song, title: '' })).status).toBe(404);
    expect((await post(`${h.url}/api/assistant/chat`, { message: 'hi', songId: id, song: { bpm: 'x' }, title: '' })).status).toBe(400);
  });
});

describe('assistant tools', () => {
  let song: Song;
  beforeEach(async () => {
    const { orchestrate } = await import('@casperaki/arrangement');
    song = orchestrate({ genre: 'brightPop', key: 'C', bpm: 120, seed: 'assistant-tools' });
  });

  it('every tool has a JSON schema the model can read', () => {
    for (const t of toolSpecs(true)) {
      expect(t.function.parameters).toMatchObject({ type: 'object' });
      expect(t.function.description.length).toBeGreaterThan(5);
    }
  });

  it('offers the mix tools only in Pro mode', () => {
    const names = (pro: boolean) => toolSpecs(pro).map((t) => t.function.name);
    expect(names(false)).not.toContain('set_track_mix');
    expect(names(true)).toEqual(expect.arrayContaining(['get_mix', 'get_bus', 'set_track_mix', 'set_bus_setting', 'reset_mix']));
    expect(() => runTool('get_mix', {}, { song, title: 't' })).toThrow(/Pro mode is off/u);
  });

  it('changes the mix per instrument type, checked against the mix', () => {
    const mix = {
      tracks: [
        { track: 'Synths', types: ['leadSynthsSoft'], bus: 'leadSynths', standardBus: 'leadSynths', levelDb: -3, trimDb: 0, sends: { reverb: -10, delay: 0, chorus: null }, linkedWith: ['Synths 2'] },
        { track: 'Synths 2', types: ['leadSynthsSoft'], bus: 'leadSynths', standardBus: 'leadSynths', levelDb: -3, trimDb: 0, sends: { reverb: -10, delay: 0, chorus: null }, linkedWith: ['Synths'] },
      ],
      buses: [
        { bus: 'leadSynths', kind: 'group' as const, plugins: [{ slot: 1, name: 'Logical4', params: [{ index: 0, name: 'Threshold', value: 0.3, shown: '-18 dB', standard: 0.3 }] }] },
        { bus: 'synths', kind: 'group' as const, plugins: [] },
        { bus: 'fxPlateReverb', kind: 'return' as const, plugins: [] },
      ],
    };
    const ctx = { song, title: 't', mix };
    expect(runTool('get_mix', {}, ctx).summary).toMatch(/Synths \(leadSynthsSoft\) → leadSynths bus; level −3 dB;.*same type as Synths 2/u);
    const r = runTool('set_track_mix', { track: 'Synths', changeLevelDb: -2, reverb: 'off', bus: 'synths' }, ctx);
    expect(r.action).toEqual({ kind: 'mixTrack', track: 'Synths', levelDb: -2, reverb: -100, bus: 'synths' });
    expect(r.summary).toMatch(/level now −5 dB \(standard −3 dB\)/u);
    expect(r.summary).toMatch(/Synths, Synths 2 \(same type\)/u);
    // The snapshot follows, on both tracks of the type.
    expect(runTool('get_mix', {}, ctx).summary).toMatch(/Synths 2 \(leadSynthsSoft\) → synths bus \(standard leadSynths\); level −5 dB \(standard −3 dB, Pro −2 dB\); sends reverb off/u);
    expect(() => runTool('set_track_mix', { track: 'Synths', bus: 'fxPlateReverb' }, ctx)).toThrow(ToolError);
    expect(() => runTool('set_track_mix', { track: 'Nope', changeLevelDb: 1 }, ctx)).toThrow(/no track "Nope"/u);
    // Changes add up from where the level is now (the snapshot followed the first change); standard puts it back.
    expect(runTool('set_track_mix', { track: 'Synths 2', changeLevelDb: -1 }, ctx).action).toMatchObject({ levelDb: -3 });
    expect(runTool('set_track_mix', { track: 'Synths', standardLevel: true }, ctx).action).toMatchObject({ levelDb: 0 });
    expect(() => runTool('set_track_mix', { track: 'Synths' }, ctx)).toThrow(/Say what to change/u);
    expect(runTool('set_bus_setting', { bus: 'leadSynths', slot: 1, param: 0, value: 0.5 }, ctx).action).toEqual({ kind: 'busSetting', bus: 'leadSynths', slot: 1, param: 0, value: 0.5 });
    expect(() => runTool('set_bus_setting', { bus: 'leadSynths', slot: 2, param: 0, value: 0.5 }, ctx)).toThrow(/no plugin in slot 2/u);
    expect(runTool('reset_mix', {}, ctx).action).toEqual({ kind: 'resetMix' });
  });

  it('moves the playhead, reverts, and writes a new song within the style\'s tempo range', () => {
    const ctx = { song, title: 't' };
    expect(runTool('go_to', { bar: 9 }, ctx).action).toEqual({ kind: 'goTo', bar: 9 });
    expect(() => runTool('go_to', {}, ctx)).toThrow(/either a section or a bar/u);
    expect(runTool('revert_to_original', {}, ctx).action).toEqual({ kind: 'revert' });
    expect(runTool('new_song', { genre: 'rock', key: 'E', bpm: 120 }, ctx).action).toEqual({ kind: 'newSong', genre: 'rock', key: 'E', bpm: 120 });
    expect(() => runTool('new_song', { genre: 'ballad', key: 'E', bpm: 200 }, ctx)).toThrow(/ballad songs are/u);
  });

  it('changes a drum sound, edits sections and drum hits, and validates arguments', async () => {
    const ctx = { song, title: 't' };
    const kit = runTool('get_drum_kit', {}, ctx).summary;
    expect(kit).toMatch(/snareDrum1/u);
    const found = runTool('search_sounds', { family: 'snareDrums', limit: 5 }, ctx).summary;
    const ids = [...found.matchAll(/\[([^\]]+)\]/gu)].map((m) => m[1]!);
    const current = /snareDrum1 [^\n]*\[([^\]]+)\]/u.exec(kit)?.[1];
    const other = ids.find((x) => x !== current)!;
    const r = runTool('set_drum_sound', { role: 'snareDrum1', soundId: other }, ctx);
    expect(r.song).toBeDefined();
    expect(runTool('get_drum_kit', {}, ctx).summary).toContain(other);

    const first = ctx.song.songStructure[0]!.name;
    runTool('set_section_bars', { name: first, bars: 2 }, ctx);
    expect(ctx.song.songStructure[0]!.bars).toHaveLength(2);
    runTool('rename_section', { name: first, newName: 'opening' }, ctx);
    expect(ctx.song.songStructure[0]!.name).toBe('opening');
    runTool('set_drum_hits', { sections: ['opening'], drum: 'clap', steps: [8, 24], on: true }, ctx);

    expect(() => runTool('set_section_bars', { name: 'opening', bars: 'many' }, ctx)).toThrow(ToolError);
    await expect(Promise.resolve().then(() => runTool('add_section', { type: 'bridge' }, ctx))).rejects.toThrow(/exactly one of after, before or index/u);
    expect(() => runTool('no_such_tool', {}, ctx)).toThrow(ToolError);
  });
});
