// How a written word is split over its sung syllables for display ("con-" "trol"), the owner's rule (2026-11-26):
//
// - The word is split into exactly as many parts as it has sung syllables (notes), each part holding one sung vowel.
// - A break goes after a vowel letter (or a vowel letter group such as "eau", "ea", "ou"); the consonant letters
//   between two vowels go to the NEXT part as far as they make a legal English syllable start ("tr", "pl", "st",
//   "th"...: the "maximal onset" rule), the rest stay with the part before: con-trol, pul-sing, e-ner-gy, car-ry.
// - Letters with no sounding vowel of their own stay with their syllable: rhy-thm (the "m" is sung with "th"), fi-re.
// - A word sung with fewer syllables than its full spelling shows the contracted spelling: the dropped vowel letter
//   disappears and its consonants join the next part (every on two notes: e-vry; everything on three: e-vry-thing).
//
// The sung syllables' phonemes (ARPAbet, from the pronunciation dictionary) say how many parts there are and which
// vowel sounds where; the code maps those vowel sounds onto the word's vowel letters (`nuclei`), then places the
// consonant letters between them.

const EPS_COST = 1e-9;

const VOWEL_LETTERS = new Set(['a', 'e', 'i', 'o', 'u']);
const isVowelPhone = (ph: string) => /\d$/u.test(ph);
const bare = (ph: string) => ph.replace(/\d$/u, '').toUpperCase();

/** Which letters of the word are vowel letters. "y" is a vowel except at the start of the word or between two vowels
 *  ("yes", "be-yond", "pla-yer" have a consonant y; "rhy-thm", "car-ry", "cry-ing" a vowel y); "u" after "q" is part of
 *  the consonant "qu". */
function vowelMask(w: string): boolean[] {
  const base = [...w].map((c) => VOWEL_LETTERS.has(c));
  return [...w].map((c, i) => {
    if (c === 'y') return i > 0 && !(base[i - 1] && i + 1 < w.length && base[i + 1]);
    if (c === 'u' && i > 0 && w[i - 1] === 'q') return false;
    return base[i]!;
  });
}

interface Group {
  readonly from: number;
  /** Inclusive. */
  readonly to: number;
}

function vowelGroups(mask: readonly boolean[]): Group[] {
  const out: Group[] = [];
  mask.forEach((v, i) => {
    if (!v) return;
    const last = out.at(-1);
    if (last && last.to === i - 1) out[out.length - 1] = { from: last.from, to: i };
    else out.push({ from: i, to: i });
  });
  return out;
}

/** Usual spellings of each vowel sound (ARPAbet without stress). */
const SPELLINGS: Readonly<Record<string, readonly string[]>> = {
  AA: ['a', 'o', 'au', 'aw', 'ea', 'ah'],
  AE: ['a', 'ai', 'au'],
  AH: ['u', 'o', 'a', 'e', 'i', 'y', 'ou', 'oo', 'io', 'ia', 'ea', 'ai', 'eo', 'oe'],
  AO: ['o', 'au', 'aw', 'ou', 'oa', 'a', 'oo'],
  AW: ['ou', 'ow', 'au'],
  AY: ['i', 'y', 'ie', 'ai', 'ei', 'ey', 'uy', 'ye', 'ui', 'eye'],
  EH: ['e', 'ea', 'a', 'ai', 'ie', 'ue', 'ei'],
  EY: ['a', 'ai', 'ay', 'ey', 'ei', 'ea', 'e'],
  IH: ['i', 'y', 'e', 'ee', 'ui', 'ie', 'a', 'u', 'o'],
  IY: ['e', 'ee', 'ea', 'y', 'i', 'ie', 'ei', 'ey', 'eo'],
  OW: ['o', 'oa', 'ow', 'oe', 'ou', 'ew', 'eau', 'oo'],
  OY: ['oi', 'oy'],
  UH: ['oo', 'u', 'ou', 'o'],
  UW: ['u', 'oo', 'ew', 'ue', 'ou', 'o', 'ui', 'eu', 'eau', 'ieu', 'oe'],
};

/** How badly a vowel letter group spells a vowel sound: 0 a usual spelling, 0.4 a usual first letter, 0.8 neither. */
function spellingCost(vowel: string, w: string, g: Group): number {
  const letters = w.slice(g.from, g.to + 1);
  if (vowel === 'ER') {
    // An r-coloured vowel: a vowel letter group followed by "r" ("her", "fur", "word"), or "re" ending a word ("fi-re").
    if (w[g.to + 1] === 'r') return 0;
    if (letters === 'e' && w[g.from - 1] === 'r' && g.to === w.length - 1) return 0;
    // An r-coloured vowel is never written without an "r": a syllable sung on it rather takes the "r" alone.
    return 2;
  }
  const s = SPELLINGS[vowel];
  if (!s) throw new Error(`word-split: unknown vowel sound ${vowel}`);
  if (s.includes(letters)) return 0;
  if (s.some((x) => x[0] === letters[0])) return 0.4;
  return 0.8;
}

/** Two-letter consonant spellings that are one sound and are never split. "ng" only when the word is sung with the
 *  "ng" sound (sing-ing, but dan-ger). */
const DIGRAPHS = ['th', 'sh', 'ch', 'ph', 'wh', 'gh', 'ck', 'qu'];

/** The consonant letters as sound units: digraphs one unit, other letters one each. */
function units(letters: string, ngSound: boolean): string[] {
  const out: string[] = [];
  for (let i = 0; i < letters.length; i++) {
    const two = letters.slice(i, i + 2);
    if (DIGRAPHS.includes(two) || (ngSound && two === 'ng')) {
      out.push(two);
      i++;
    } else out.push(letters[i]!);
  }
  return out;
}

/** Letter groups an English syllable may start with. */
const ONSETS = new Set([
  ...'bcdfghjklmnpqrstvwyz'.split(''),
  'th', 'sh', 'ch', 'ph', 'wh', 'qu', 'kn', 'wr',
  'bl', 'br', 'cl', 'cr', 'dr', 'dw', 'fl', 'fr', 'gl', 'gr', 'pl', 'pr', 'sc', 'sk', 'sl', 'sm', 'sn', 'sp', 'st', 'sw', 'tr', 'tw',
  'thr', 'shr', 'str', 'spr', 'spl', 'scr', 'squ', 'sch', 'chr', 'phr',
]);

/** How many of the consonant letters between two vowels go to the next part: the longest legal syllable start. */
function onsetLength(letters: string, ngSound: boolean): number {
  const u = units(letters, ngSound);
  for (let k = u.length; k > 0; k--) {
    const tail = u.slice(u.length - k).join('');
    if (ONSETS.has(tail)) return tail.length;
  }
  return 0;
}

/** Consonant sounds the letters spell, roughly: a double letter or digraph is one, "x" two (K S). */
function consonantSoundCount(letters: string, ngSound: boolean): number {
  let n = 0;
  const u = units(letters, ngSound);
  u.forEach((x, i) => {
    if (i > 0 && x.length === 1 && x === u[i - 1]) return;
    n += x === 'x' ? 2 : 1;
  });
  return n;
}

// ---- mapping the sung vowels onto the vowel letters ---------------------------------------------------------------

/** Where a sung syllable's vowel is written: a letter span, or none (a syllable sung on consonants: the "thm" of
 *  "rhythm"). */
type Nucleus = Group | null;

const COST = {
  /** A vowel letter group with no sung vowel: a silent "e" ending the word ("come", "time", "times") … */
  silentFinalE: 0.2,
  /** … any other. */
  silentOther: 1,
  /** One vowel group sung as two syllables ("ne-on", "be-ing", "cry-ing") … */
  splitGroup: 0.3,
  /** … more when the whole group is a usual spelling of the first vowel alone ("ou" in "hour" is one sound, so the
   *  second syllable is sung on the "r": "hou-r"). */
  splitSpelledGroup: 1,
  /** A sung syllable without a vowel letter: on "m", "n", "l" or an r-coloured vowel … */
  noLetterSyllabic: 1.5,
  /** … on anything else. */
  noLetterOther: 3,
  /** Per consonant sound more or fewer between two vowels than the letters between them spell. */
  consonantMismatch: 0.25,
};

function silentCost(w: string, g: Group, groups: readonly Group[]): number {
  const last = g === groups.at(-1);
  const letters = w.slice(g.from, g.to + 1);
  const after = w.slice(g.to + 1);
  return last && letters === 'e' && g.from > 0 && /^(?:s|d|'?s)?$/u.test(after) ? COST.silentFinalE : COST.silentOther;
}

/**
 * The cheapest assignment of the sung vowels to vowel letter groups, in order: each sung vowel takes a whole group,
 * or two sung vowels share a group of two or more letters (split between them), or a sung vowel takes no letters; a
 * group no sung vowel takes is silent.
 */
function nuclei(w: string, sung: readonly (readonly string[])[], ngSound: boolean): Nucleus[] {
  const mask = vowelMask(w);
  const groups = vowelGroups(mask);
  const vowels = sung.map((ps) => {
    const v = ps.find(isVowelPhone);
    if (!v) throw new Error(`word-split: a sung syllable of "${w}" without a vowel sound`);
    return bare(v);
  });
  // Consonant sounds between sung vowel i-1 and i.
  const between = sung.map((ps, i) => {
    if (i === 0) return 0;
    const prev = sung[i - 1]!;
    return prev.slice(prev.findIndex(isVowelPhone) + 1).length + ps.slice(0, ps.findIndex(isVowelPhone)).length;
  });
  const syllabic = sung.map((ps, i) => vowels[i] === 'ER' || ps.some((p) => ['M', 'N', 'L'].includes(bare(p))));
  const n = sung.length;
  const memo = new Map<string, { cost: number; plan: Nucleus[] }>();
  // Consonant letters between two letter positions, vowel letters left out.
  const consonantsBetween = (from: number, to: number) => [...w.slice(from, to)].filter((_, k) => !mask[from + k]).join('');
  const best = (i: number, j: number, prevEnd: number): { cost: number; plan: Nucleus[] } => {
    const key = `${i}|${j}|${prevEnd}`;
    const hit = memo.get(key);
    if (hit) return hit;
    let out: { cost: number; plan: Nucleus[] } = { cost: Infinity, plan: [] };
    const consider = (cost: number, head: Nucleus[], rest: { cost: number; plan: Nucleus[] }) => {
      if (cost + rest.cost < out.cost - EPS_COST) out = { cost: cost + rest.cost, plan: [...head, ...rest.plan] };
    };
    // The consonant mismatch between sung vowel k-1 (written ending at letter `end`; -2: it has no letters) and k.
    const gapCost = (k: number, from: number, end = prevEnd) =>
      end < -1 || k === 0 ? 0 : COST.consonantMismatch * Math.abs(between[k]! - consonantSoundCount(consonantsBetween(end + 1, from), ngSound));
    if (i === n) {
      let cost = 0;
      for (let g = j; g < groups.length; g++) cost += silentCost(w, groups[g]!, groups);
      out = { cost, plan: [] };
    } else {
      if (j < groups.length) {
        const g = groups[j]!;
        consider(silentCost(w, g, groups), [], best(i, j + 1, prevEnd));
        consider(spellingCost(vowels[i]!, w, g) + gapCost(i, g.from), [g], best(i + 1, j + 1, g.to));
        if (i + 1 < n) {
          for (let cut = g.from; cut < g.to; cut++) {
            const a = { from: g.from, to: cut };
            const b = { from: cut + 1, to: g.to };
            const whole = spellingCost(vowels[i]!, w, g) === 0 ? COST.splitSpelledGroup : 0;
            consider(COST.splitGroup + whole + spellingCost(vowels[i]!, w, a) + spellingCost(vowels[i + 1]!, w, b) + gapCost(i, a.from) + gapCost(i + 1, b.from, a.to), [a, b], best(i + 2, j + 1, b.to));
          }
        }
      }
      // A syllable without a vowel letter needs letters of its own before the next vowel group: an "r" for an
      // r-coloured vowel, a consonant letter otherwise.
      const from = prevEnd + 1;
      const to = j < groups.length ? groups[j]!.from : w.length;
      const room = w.slice(Math.max(0, from), to);
      const feasible = prevEnd < -1 || (vowels[i] === 'ER' ? room.includes('r') : [...room].some((_, x) => !mask[from + x]));
      if (feasible) consider(syllabic[i] ? COST.noLetterSyllabic : COST.noLetterOther, [null], best(i + 1, j, -2));
    }
    memo.set(key, out);
    return out;
  };
  return best(0, 0, -1).plan;
}

// ---- placing the letters ------------------------------------------------------------------------------------------

export interface WordSplit {
  /** The written parts, one per sung syllable, in order; together they spell the word (less any vowel letters a
   *  contraction drops). */
  readonly parts: readonly string[];
  /** Per part, the span of its vowel letters within the part (from, to inclusive), or null for a part sung without
   *  a vowel letter. */
  readonly vowels: readonly (Group | null)[];
}

/**
 * The word split over its sung syllables (phonemes per syllable, as the pronunciation dictionary writes them), or
 * undefined when its letters cannot be shared out so that every syllable gets some (the caller names the word).
 */
export function splitWord(word: string, sung: readonly (readonly string[])[]): WordSplit | undefined {
  const w = word.toLowerCase();
  if (sung.length === 0) throw new Error(`splitWord: "${word}" has no sung syllables`);
  if (sung.length === 1) {
    const g = vowelGroups(vowelMask(w));
    return { parts: [w], vowels: [g.length > 0 ? { from: g[0]!.from, to: g.at(-1)!.to } : null] };
  }
  const compound = splitCompound(w, sung);
  if (compound) return compound;
  const ngSound = sung.flat().some((p) => bare(p) === 'NG');
  const mask = vowelMask(w);
  const plan = nuclei(w, sung, ngSound);
  // Syllables without a vowel letter take the consonant letters for their consonant sounds from the end of the
  // letters before the next syllable's vowel ("rhy-thm"); an r-coloured vowel takes an "r" ("hou-r").
  const spans: (Group | null)[] = [...plan];
  for (let k = 0; k < spans.length; k++) {
    if (spans[k]) continue;
    const start = k === 0 ? 0 : spans[k - 1]!.to + 1;
    const next = spans.slice(k + 1).find((s) => s);
    const end = next ? next.from - 1 : w.length - 1;
    if (bare(sung[k]!.find(isVowelPhone)!) === 'ER') {
      // An r-coloured vowel is sung on the first "r" ("hou-r", "our-selves").
      const r = w.indexOf('r', start);
      if (r < 0 || r > end) return undefined;
      spans[k] = { from: r, to: r };
      continue;
    }
    const sounds = Math.max(1, sung[k]!.filter((p) => !isVowelPhone(p)).length);
    let from = end + 1;
    let got = 0;
    while (from - 1 >= start && got < sounds) {
      from--;
      if (!mask[from]) got++;
    }
    // Digraphs stay whole ("th" of "rhythm").
    if (from - 1 >= start && DIGRAPHS.includes(w.slice(from - 1, from + 1))) from--;
    if (got === 0) return undefined;
    spans[k] = { from, to: end };
  }
  const full = spans as Group[];
  const silentVowel = (i: number) => mask[i] && !full.some((s, k) => plan[k] && i >= s.from && i <= s.to);
  // Between two syllables the letters are consonant runs and silent vowel groups: C0 V1 C1 … Vm Cm. Each silent
  // group is first treated as a syllable of its own, so every consonant run is shared out by the onset rule between
  // its neighbours (the next syllable gets the longest legal start, none when it has no vowel letter of its own: its
  // letters are already chosen). Then each silent group either stays with the part before, its consonants with it (a
  // silent "e" after a consonant: "love-ly", "eve-ning", "busi-ness"), or, when an "r" follows it (a vowel dropped in
  // speech: "ev(e)ry", "int(e)resting"), loses its vowel letters and gives its consonants to the next part
  // ("e-vry-thing", "in-tres-ting").
  const parts: string[] = [];
  const vowels: (Group | null)[] = [];
  let prefix = w.slice(0, full[0]!.from);
  for (let k = 0; k < full.length; k++) {
    const s = full[k]!;
    parts.push(prefix + w.slice(s.from, s.to + 1));
    vowels.push(plan[k] ? { from: prefix.length, to: prefix.length + s.to - s.from } : null);
    if (k + 1 === full.length) {
      parts[k] += w.slice(s.to + 1);
      break;
    }
    const nextStart = full[k + 1]!.from;
    const runs: string[] = [''];
    const silent: string[] = [];
    for (let i = s.to + 1; i < nextStart; i++) {
      if (silentVowel(i)) {
        // A silent letter right after another one belongs to the same silent group.
        if (i > s.to + 1 && silentVowel(i - 1)) silent[silent.length - 1] += w[i];
        else {
          silent.push(w[i]!);
          runs.push('');
        }
      } else runs[runs.length - 1] += w[i];
    }
    const nextHasVowel = plan[k + 1] !== null;
    // A word ending in a consonant and "le" sung as its last syllable takes that consonant with it ("lit-tle",
    // "can-dle"; the onset rule alone would give "litt-le").
    const endsInLe = k + 2 === full.length && nextStart === w.length - 1 && w.endsWith('le') && w.slice(s.to + 1, nextStart).length >= 2;
    const split = runs.map((c, j) => {
      const last = j === runs.length - 1;
      const on = last && !nextHasVowel ? 0 : last && endsInLe && c.length >= 2 && !mask[nextStart - 2] && !DIGRAPHS.includes(w.slice(nextStart - 3, nextStart - 1)) ? 2 : onsetLength(c, ngSound);
      return { coda: c.slice(0, c.length - on), onset: c.slice(c.length - on) };
    });
    parts[k] += split[0]!.coda;
    let carry = '';
    silent.forEach((v, j) => {
      const before = split[j]!.onset;
      const after = split[j + 1]!;
      const dropped = runs[j + 1]!.startsWith('r') || (runs[j + 1] === '' && j + 1 === silent.length && w[nextStart] === 'r');
      if (dropped) carry += before + after.coda;
      else {
        parts[k] += carry + before + v + after.coda;
        carry = '';
      }
    });
    prefix = carry + split.at(-1)!.onset;
  }
  if (parts.some((p) => !p)) return undefined;
  return { parts, vowels };
}

/** A word ending in "one" sung "wun" (someone, anyone, everyone: its last sung syllable is W AH N, or W AH N Z for
 *  "ones"): the word before "one" is split on its own and "one" is the last part ("some-one", "e-vry-one"); without
 *  this the "o" of "one" would be taken for a vowel of the word before it. */
function splitCompound(w: string, sung: readonly (readonly string[])[]): WordSplit | undefined {
  const m = /^(.+?)(ones?)$/u.exec(w);
  if (!m || m[1]!.length < 2) return undefined;
  // The dictionary may put consonants before the W into the last syllable ("some-one": S AH1 | M W AH2 N): they
  // belong to the word before.
  const last = sung.at(-1)!;
  const w0 = last.findIndex((p) => bare(p) === 'W');
  const tail = last.slice(w0).map(bare).join(' ');
  if (w0 < 0 || !(tail === 'W AH N' || tail === 'W AH N Z') || last.slice(0, w0).some(isVowelPhone)) return undefined;
  const headSung = [...sung.slice(0, -2), [...sung.at(-2)!, ...last.slice(0, w0)]];
  if (headSung.length === 0) return undefined;
  const head = splitWord(m[1]!, headSung);
  if (!head) return undefined;
  return { parts: [...head.parts, m[2]!], vowels: [...head.vowels, { from: 0, to: 0 }] };
}

/** The split of a sung contraction, from the split of the full word: `merge-last` runs the last two parts into one
 *  ("fi-re" → "fire"); `drop` removes the vowel letters of part `index` and puts its other letters at the start of the
 *  next part ("e-ve-ry" → "e-vry"). */
export function contractSplit(full: WordSplit, how: { kind: 'merge-last' } | { kind: 'drop'; index: number }): WordSplit {
  const n = full.parts.length;
  if (how.kind === 'merge-last') {
    if (n < 2) throw new Error('contractSplit: a one-part word cannot merge its last parts');
    return { parts: [...full.parts.slice(0, n - 2), full.parts[n - 2]! + full.parts[n - 1]!], vowels: [...full.vowels.slice(0, n - 2), full.vowels[n - 2]!] };
  }
  const i = how.index;
  if (i <= 0 || i >= n - 1) throw new Error(`contractSplit: part ${i} of ${n} is not an inner part`);
  const v = full.vowels[i];
  const p = full.parts[i]!;
  const rest = v ? p.slice(0, v.from) + p.slice(v.to + 1) : p;
  const nv = full.vowels[i + 1];
  const parts = [...full.parts.slice(0, i), rest + full.parts[i + 1]!, ...full.parts.slice(i + 2)];
  const vowels = [...full.vowels.slice(0, i), nv ? { from: nv.from + rest.length, to: nv.to + rest.length } : null, ...full.vowels.slice(i + 2)];
  return { parts, vowels };
}
