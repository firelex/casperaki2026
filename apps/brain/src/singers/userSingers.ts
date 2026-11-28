// The singers users add from their own recordings (Add a singer), kept outside git in BRAIN_SINGERS_DATA_DIR:
//
//   <dir>/<owner>/singers.json            the owner's finished singers (UserSinger[]), newest last
//   <dir>/<owner>/<singer id>/original.*  the recording as uploaded (kept from the start, so a failed task can retry)
//   <dir>/<owner>/<singer id>/voice.wav   the voice reference SoulX-Singer sings in (about 10 s)
//   <dir>/<owner>/<singer id>/voice.json  its description in SoulX-Singer's prompt format
//   <dir>/<owner>/<singer id>/test_line.wav  a short line sung in the new voice
//   <dir>/<owner>/hidden.json             the built-in singers the owner deleted (ids): gone for them only
//
// A singer is visible only to the owner who added it (the built-in singers, src/routes/singers.ts, to everyone).

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { z } from 'zod';

/** How the voice reference was chosen (the vocals service's pipeline/voice_cut.py). */
export const REFERENCE_CHOICES = ['beginning', 'best'] as const;
export type ReferenceChoice = (typeof REFERENCE_CHOICES)[number];

export const UserSingerSchema = z
  .object({
    id: z.string().regex(/^u-[0-9a-f]{12}$/u),
    name: z.string().min(1),
    description: z.string().min(1),
    source: z.string().min(1),
    audio: z.literal('voice.wav'),
    meta: z.literal('voice.json'),
    testLine: z.literal('test_line.wav'),
    original: z.string().regex(/^original\.[a-z0-9]{1,8}$/u),
    reference: z
      .object({
        choice: z.enum(REFERENCE_CHOICES),
        startSeconds: z.number(),
        endSeconds: z.number(),
        recordingStartSeconds: z.number(),
        recordingEndSeconds: z.number(),
        seconds: z.number().positive(),
      })
      .strict(),
    /** How the voice reference was transcribed: its words, or "la la la" (every note an "la"). */
    transcription: z.enum(['words', 'la']),
    /** The words heard in the voice reference. */
    heard: z.string(),
    createdAt: z.string().min(1),
  })
  .strict();
export type UserSinger = z.infer<typeof UserSingerSchema>;

/** The folder name of an owner (their id, which must be a plain name: an error otherwise). */
export function ownerFolder(ownerId: string): string {
  if (!/^[A-Za-z0-9_-]+$/u.test(ownerId)) throw new Error(`singers: the owner id "${ownerId}" cannot be a folder name`);
  return ownerId;
}

/** A new uploaded singer's id ("u-" and 12 hex digits: never one of the built-in singers' ids). */
export function newSingerId(): string {
  return `u-${randomBytes(6).toString('hex')}`;
}

export class UserSingers {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private listFile(ownerId: string): string {
    return join(this.root, ownerFolder(ownerId), 'singers.json');
  }

  /** A singer's folder (made by `keepUpload`). */
  dir(ownerId: string, singerId: string): string {
    if (!/^u-[0-9a-f]{12}$/u.test(singerId)) throw new Error(`singers: "${singerId}" is not an uploaded singer's id`);
    return join(this.root, ownerFolder(ownerId), singerId);
  }

  /** The owner's singers (none before their first); every listed file must be present (an error naming it). */
  list(ownerId: string): UserSinger[] {
    const file = this.listFile(ownerId);
    if (!existsSync(file)) return [];
    const singers = z.array(UserSingerSchema).parse(JSON.parse(readFileSync(file, 'utf8')));
    for (const s of singers) {
      for (const f of [s.audio, s.meta, s.testLine, s.original]) {
        if (!existsSync(join(this.dir(ownerId, s.id), f))) throw new Error(`singers: ${s.name} (${s.id}) names ${f}, which is not in ${this.dir(ownerId, s.id)}`);
      }
    }
    return singers;
  }

  get(ownerId: string, singerId: string): UserSinger | undefined {
    return this.list(ownerId).find((s) => s.id === singerId);
  }

  /** Keeps an uploaded recording as <singer folder>/original.<ext>: its name. */
  keepUpload(ownerId: string, singerId: string, recording: Buffer, ext: string): string {
    if (!/^[a-z0-9]{1,8}$/u.test(ext)) throw new Error(`singers: "${ext}" is not a file extension`);
    const dir = this.dir(ownerId, singerId);
    if (existsSync(dir)) throw new Error(`singers: ${dir} exists already`);
    mkdirSync(dir, { recursive: true });
    const name = `original.${ext}`;
    writeFileSync(join(dir, name), recording);
    return name;
  }

  /** Adds a finished singer to the owner's list (its files already in its folder). */
  add(ownerId: string, singer: UserSinger): void {
    const parsed = UserSingerSchema.parse(singer);
    const singers = this.list(ownerId);
    if (singers.some((s) => s.id === parsed.id)) throw new Error(`singers: ${parsed.id} is listed already`);
    for (const f of [parsed.audio, parsed.meta, parsed.testLine, parsed.original]) {
      if (!existsSync(join(this.dir(ownerId, parsed.id), f))) throw new Error(`singers: ${parsed.name} has no ${f} in its folder`);
    }
    this.write(ownerId, [...singers, parsed]);
  }

  /** Deletes one of the owner's singers and its folder: false when the owner has no such singer. */
  remove(ownerId: string, singerId: string): boolean {
    const singers = this.list(ownerId);
    if (!singers.some((s) => s.id === singerId)) return false;
    this.write(ownerId, singers.filter((s) => s.id !== singerId));
    rmSync(this.dir(ownerId, singerId), { recursive: true, force: true });
    return true;
  }

  /** The ids of the built-in singers the owner deleted (their files stay: other owners still see them). */
  hiddenBuiltIns(ownerId: string): Set<string> {
    const file = join(this.root, ownerFolder(ownerId), 'hidden.json');
    if (!existsSync(file)) return new Set();
    return new Set(z.array(z.string().min(1)).parse(JSON.parse(readFileSync(file, 'utf8'))));
  }

  /** Deletes a built-in singer for the owner only. */
  hideBuiltIn(ownerId: string, singerId: string): void {
    const ids = [...this.hiddenBuiltIns(ownerId), singerId];
    const file = join(this.root, ownerFolder(ownerId), 'hidden.json');
    mkdirSync(join(file, '..'), { recursive: true });
    const tmp = `${file}.part-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify([...new Set(ids)], null, 1)}\n`);
    renameSync(tmp, file);
  }

  /** Renames one of the owner's singers: false when the owner has no such singer. */
  rename(ownerId: string, singerId: string, name: string): boolean {
    const singers = this.list(ownerId);
    if (!singers.some((s) => s.id === singerId)) return false;
    this.write(ownerId, singers.map((s) => (s.id === singerId ? UserSingerSchema.parse({ ...s, name }) : s)));
    return true;
  }

  /** Describes one of the owner's singers anew: false when the owner has no such singer. */
  describe(ownerId: string, singerId: string, description: string): boolean {
    const singers = this.list(ownerId);
    if (!singers.some((s) => s.id === singerId)) return false;
    this.write(ownerId, singers.map((s) => (s.id === singerId ? UserSingerSchema.parse({ ...s, description }) : s)));
    return true;
  }

  /** The names the owner gave built-in singers (id -> name; a built-in not listed keeps its own). */
  builtInNames(ownerId: string): Record<string, string> {
    const file = join(this.root, ownerFolder(ownerId), 'names.json');
    if (!existsSync(file)) return {};
    return z.record(z.string().min(1), z.string().min(1)).parse(JSON.parse(readFileSync(file, 'utf8')));
  }

  /** Renames a built-in singer for the owner only (its files and its name for everyone else stay). */
  nameBuiltIn(ownerId: string, singerId: string, name: string): void {
    const names = { ...this.builtInNames(ownerId), [singerId]: name };
    const file = join(this.root, ownerFolder(ownerId), 'names.json');
    mkdirSync(join(file, '..'), { recursive: true });
    const tmp = `${file}.part-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(names, null, 1)}\n`);
    renameSync(tmp, file);
  }

  /** Deletes the folder of a singer that never joined the list (its recording refused before the task started). */
  discard(ownerId: string, singerId: string): void {
    if (this.list(ownerId).some((s) => s.id === singerId)) throw new Error(`singers: ${singerId} is listed: delete it with remove`);
    rmSync(this.dir(ownerId, singerId), { recursive: true, force: true });
  }

  private write(ownerId: string, singers: UserSinger[]): void {
    const file = this.listFile(ownerId);
    mkdirSync(join(file, '..'), { recursive: true });
    const tmp = `${file}.part-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(singers, null, 1)}\n`);
    renameSync(tmp, file);
  }
}
