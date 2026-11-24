// Edits of melody library entries (the Melodies page), kept in one JSON file outside the repo
// (BRAIN_MELODY_EDITS_PATH): { "<bank>/<id>": edit }, each edit in the arrangement's PrecedentEdit shape (melody and
// chords in the bank format and the bank register, an octave below sung pitch; useOriginal, useRemix, source;
// editedAt, editedBy). The brain hands the whole set to the arrangement's setPrecedentEdits, which checks it, so the
// generator uses the edits at once.
//
// The file does not exist until the first edit is saved (no edits yet). Writes go to a temporary file first, then
// replace the file, so a crash never leaves half a file.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { z } from 'zod';

export const StoredEditSchema = z
  .object({
    melody: z.record(z.array(z.object({ note: z.string(), midi: z.number().int(), duration: z.number().positive() }).strict())),
    chords: z.record(z.object({ chord: z.string().min(1) }).strict()),
    useOriginal: z.boolean(),
    useRemix: z.boolean(),
    source: z.object({ kind: z.enum(['song', 'melodySauce', 'casperaki']), title: z.string().optional(), artist: z.string().optional() }).strict(),
    editedAt: z.string().min(1),
    editedBy: z.string().min(1),
  })
  .strict();
const FileSchema = z.record(z.string().regex(/^[^/]+\/[^/]+$/u), StoredEditSchema);

export type StoredEdit = z.infer<typeof StoredEditSchema>;

export const editKey = (bank: string, id: string) => `${bank}/${id}`;

export class MelodyEdits {
  private edits: Map<string, StoredEdit>;

  /** Reads the file (none yet: no edits). `onChange` gets every edit after loading and after each change. */
  constructor(
    readonly path: string,
    private readonly onChange: (edits: ReadonlyMap<string, StoredEdit>) => void = () => {},
  ) {
    this.edits = new Map();
    if (existsSync(path)) {
      const parsed = FileSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new Error(`melody edits file ${path} is invalid: ${issue ? `${issue.path.join('.')}: ${issue.message}` : parsed.error.message}`);
      }
      this.edits = new Map(Object.entries(parsed.data));
    }
    this.onChange(this.edits);
  }

  get(bank: string, id: string): StoredEdit | undefined {
    return this.edits.get(editKey(bank, id));
  }

  all(): ReadonlyMap<string, StoredEdit> {
    return this.edits;
  }

  set(bank: string, id: string, edit: StoredEdit): void {
    const next = new Map(this.edits);
    next.set(editKey(bank, id), edit);
    this.write(next);
  }

  /** Back to the stored version. False when there was no edit. */
  remove(bank: string, id: string): boolean {
    if (!this.edits.has(editKey(bank, id))) return false;
    const next = new Map(this.edits);
    next.delete(editKey(bank, id));
    this.write(next);
    return true;
  }

  /** Hands the new set to `onChange` first (it may refuse it by throwing), then writes the file. */
  private write(next: Map<string, StoredEdit>): void {
    this.onChange(next);
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(Object.fromEntries([...next].sort(([a], [b]) => a.localeCompare(b))), null, 1)}\n`);
      renameSync(tmp, this.path);
    } catch (err) {
      // Not saved: the generator goes back to the saved edits, and the error goes on to the caller.
      this.onChange(this.edits);
      throw err;
    }
    this.edits = next;
  }
}
