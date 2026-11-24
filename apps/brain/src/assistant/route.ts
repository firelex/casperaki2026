// POST /api/assistant/chat — the song assistant beside the Song tab.
//
// Body (the @teamsuzie/ui ChatThread request plus the open song):
//   { message, chatId (unused), history: [{role, content}], songId, song, title }
// Answer: server-sent events, one `data: <json>` per event, of the ChatThread kinds
//   chunk {text} | tool_call {id,name,args} | tool_result {id,name,result} |
//   tool_error {id,name,error} | done | error {message}
// Tools run on a working copy of the song; an edit's result carries the whole
// new song, which the page applies as one undoable edit.

import { parseSong, type Song } from '@casperaki/song-schema';
import { Router, type Request } from 'express';
import { z } from 'zod';

import type { SongsStore } from '../store.js';
import type { AssistantLlm, ChatMessage } from './llm.js';
import { songSummary } from './summary.js';
import { MixSnapshotSchema } from './mixTools.js';
import { runTool, toolSpecs, ToolError, type ToolContext } from './tools.js';

const MAX_ROUNDS = 10;

const Body = z.object({
  message: z.string().min(1).max(4000),
  chatId: z.unknown().optional(),
  history: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string() })).max(60).default([]),
  songId: z.string().min(1),
  song: z.unknown(),
  title: z.string().default(''),
  /** Pro mode is on: the mix as the page shows it (the mix tools are offered only then). */
  mix: MixSnapshotSchema.optional(),
});

function systemPrompt(song: Song, title: string, pro: boolean): string {
  return [
    'You are the assistant inside Casperaki, an app that writes songs. The user has one song open in the song editor, and you help them change and play it.',
    'You change the song only through the tools you are given. Each tool does exactly one thing the user could also do by hand in the editor. Every change you make can be undone by the user.',
    'How to work:',
    '- Do what the user asks with as few tool calls as needed, then answer in one or two short, friendly sentences saying what you did. Do not list ids.',
    '- Use the exact section and track names shown below. Section names are like verse1, chorus1, bridge1.',
    '- To change a sound, first find one with search_sounds and use the id it gives you. For a track, search with useAs set to the track kind; for a drum part, search with the family of that part (see get_drum_kit). Prefer sounds in the song\'s style. Never make up an id.',
    '- If a tool refuses, read why, fix the arguments and try again, or tell the user plainly what is not possible.',
    '- If the request is unclear, ask one short question instead of guessing.',
    '- You cannot sing, write lyrics or make the music video here; say so if asked.',
    pro
      ? '- Pro mode is on: you can read the mix (get_mix, get_bus) and change it (set_track_mix, set_bus_setting, reset_mix). Levels, sends and buses are set per instrument type, so tracks of the same type change together; say so when it happens. Read the mix before changing it.'
      : '- Pro mode is off, so you cannot read or change the mix (levels, sends, buses, plugins). If asked, tell the user to press the Pro button above the mixer first.',
    '',
    'The song as it is right now:',
    songSummary(song, title),
  ].join('\n');
}

export function createAssistantRouter(deps: { store: SongsStore; ownerOf: (req: Request) => string; llm: AssistantLlm | undefined }): Router {
  const router = Router();
  const toolsFor = { pro: toolSpecs(true), plain: toolSpecs(false) };

  router.post('/api/assistant/chat', async (req, res) => {
    if (!deps.llm) {
      return res.status(503).json({ error: 'assistant_not_configured', message: 'The song assistant has no language model: set ASSISTANT_LLM_URL and ASSISTANT_LLM_MODEL in brain.env.' });
    }
    const body = Body.safeParse(req.body);
    if (!body.success) {
      const issue = body.error.issues[0];
      return res.status(400).json({ error: 'invalid_body', message: issue ? `${issue.path.join('.')}: ${issue.message}` : 'invalid body' });
    }
    if (!deps.store.getProject(deps.ownerOf(req), body.data.songId)) return res.status(404).json({ error: 'not_found', id: body.data.songId });
    let song: Song;
    try {
      song = parseSong(body.data.song);
    } catch (err) {
      return res.status(400).json({ error: 'invalid_song', message: err instanceof Error ? err.message : String(err) });
    }

    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const send = (event: Record<string, unknown>) => res.write(`data: ${JSON.stringify(event)}\n\n`);
    const abort = new AbortController();
    res.on('close', () => abort.abort());

    const ctx: ToolContext = { song, title: body.data.title, ...(body.data.mix ? { mix: body.data.mix } : {}) };
    const pro = Boolean(ctx.mix);
    const tools = pro ? toolsFor.pro : toolsFor.plain;
    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt(ctx.song, ctx.title, pro) },
      ...body.data.history.map((m) => ({ role: m.role, content: m.content })),
      { role: 'user', content: body.data.message },
    ];
    try {
      for (let round = 0; round < MAX_ROUNDS; round++) {
        const turn = await deps.llm.turn(messages, tools, (text) => send({ type: 'chunk', text }), abort.signal);
        if (turn.toolCalls.length === 0) {
          send({ type: 'done' });
          return res.end();
        }
        messages.push({ role: 'assistant', content: turn.content || null, tool_calls: turn.toolCalls });
        let changed = false;
        for (const call of turn.toolCalls) {
          const { id, function: fn } = call;
          let args: unknown;
          try {
            args = JSON.parse(fn.arguments);
          } catch {
            const error = `The arguments for ${fn.name} are not valid JSON.`;
            send({ type: 'tool_error', id, name: fn.name, error });
            messages.push({ role: 'tool', tool_call_id: id, content: `Error: ${error}` });
            continue;
          }
          send({ type: 'tool_call', id, name: fn.name, args });
          try {
            const result = runTool(fn.name, args, ctx);
            if (result.song) changed = true;
            send({ type: 'tool_result', id, name: fn.name, result });
            messages.push({ role: 'tool', tool_call_id: id, content: result.summary });
          } catch (err) {
            if (!(err instanceof ToolError)) throw err;
            send({ type: 'tool_error', id, name: fn.name, error: err.message });
            messages.push({ role: 'tool', tool_call_id: id, content: `Error: ${err.message}` });
          }
        }
        // The model always sees the song as it is now.
        if (changed) messages[0] = { role: 'system', content: systemPrompt(ctx.song, ctx.title, pro) };
      }
      send({ type: 'error', message: `The assistant stopped after ${MAX_ROUNDS} rounds of tool calls without finishing. The edits made so far are kept.` });
      res.end();
    } catch (err) {
      if (abort.signal.aborted) return res.end();
      console.error('[assistant]', err);
      send({ type: 'error', message: err instanceof Error ? err.message : String(err) });
      res.end();
    }
  });
  return router;
}

