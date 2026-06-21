import { zodToJsonSchema } from 'zod-to-json-schema';
import { SongSchema } from '../schemas/song.js';
import { SCHEMA_ID, SCHEMA_VERSION } from '../version.js';

export function generateSongJsonSchema(): Record<string, unknown> {
  const schema = zodToJsonSchema(SongSchema, {
    name: 'CasperakiSong',
    $refStrategy: 'root',
  }) as Record<string, unknown>;
  return {
    $id: SCHEMA_ID,
    title: `Casperaki Song (v${SCHEMA_VERSION})`,
    ...schema,
  };
}
