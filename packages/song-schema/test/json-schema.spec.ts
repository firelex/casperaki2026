import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import {
  fromEngineEnvelope,
  generateSongJsonSchema,
  canonicalStringifySong,
  parseSong,
} from '../src/index.js';
import { loadEngineWebTesterFixture } from './fixtures/index.js';

describe('generated JSON Schema', () => {
  const schema = generateSongJsonSchema();

  it('compiles under ajv strict-tuples mode disabled', () => {
    const ajv = new Ajv({ strict: false, allErrors: true });
    addFormats(ajv);
    const validate = ajv.compile(schema);
    expect(validate).toBeTypeOf('function');
  });

  it('validates a fixture round-tripped through canonical', () => {
    const ajv = new Ajv({ strict: false, allErrors: true });
    addFormats(ajv);
    const validate = ajv.compile(schema);

    const fixture = loadEngineWebTesterFixture();
    const { song } = fromEngineEnvelope({
      song: fixture.song as Record<string, unknown>,
      instruments: fixture.instruments as Record<string, unknown>[],
    });
    const canonical = JSON.parse(canonicalStringifySong(song));
    const reparsed = parseSong(canonical);
    const valid = validate(reparsed);
    if (!valid) {
      // Surface only the first error to keep the failure readable.
      // Brand-encoded scalars become plain strings in JSON, which ajv accepts.
      throw new Error(
        `JSON Schema validation failed: ${JSON.stringify(validate.errors?.[0])}`,
      );
    }
    expect(valid).toBe(true);
  });
});
