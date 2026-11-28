// The casting video's cast (docs/superpowers/specs/2026-11-28-video-modes-casting-design.md, "The judges"): the four
// judges' characters (the owner's jury profiles, without the real people they were inspired by) and their approved
// speaking voices, the narrator, and how the outcome the user chose turns into each judge's vote.

import { hashString } from './hash.js';

export type JudgeId = 'ice' | 'nicky' | 'love' | 'bob';
export interface Judge {
  readonly id: JudgeId;
  readonly name: string;
  /** Who they are, for the writer (plain English). */
  readonly profile: string;
  /** The approved speaking voice: a description for the speech model and its seed. */
  readonly voice: { readonly description: string; readonly seed: number; readonly referenceText: string };
}

/** What each judge's reference says: the words of the take the owner approved (~/casperaki-data/voicetest: ice, nicky,
 *  love2-7, bob2-21), so the speech service's reference (the same description, seed and words) IS that take, and every
 *  line is copied from it. */
const APPROVED_TAKE_TEXT = {
  ice: "Right. Well. That was certainly a choice. I'm not saying it was the wrong choice, but it was a choice.",
  nicky: 'Okay, okay, hold on, Ice. Baby, that chorus? That chorus was everything. You owned that stage.',
  love: "Oh, don't listen to him, darling. He hasn't smiled since about nineteen ninety eight.",
  bob: 'Ah, would you stop. Sure, I thought it was lovely. A bit of nerves at the start, but you grew into it.',
} as const;

export const JUDGES: readonly Judge[] = [
  {
    id: 'ice',
    name: 'Ice',
    profile:
      'Ice, the ruthless music mogul. 58, British, head judge. Brutally honest, arrogant, dry, intimidating, occasionally hilarious. Decades in the industry; believes he can recognise a hit within fifteen seconds. No patience for mediocrity, long introductions, pretentious lyrics or songs without a memorable chorus. Rarely raises his voice: a quiet, devastating observation does more. Interrupts songs that take too long to get going. Genuinely loves finding great music, and his turn from bored cynic to enthusiastic supporter is dramatic. Signature: slowly takes off his sunglasses before a brutal verdict. Sample lines: "I\'ve heard better melodies from my microwave." "That was three minutes of my life I\'m not getting back." "Hang on. Stop. Stop. Who wrote that chorus?" "I hate to admit this, but that was absolutely brilliant." "Bob, please. We\'re judging music, not adopting puppies." With the others: constantly argues with Bob, dismisses Nicky\'s obsession with trends, secretly respects Love\'s musical instincts.',
    voice: { description: 'A man in his fifties with a dry, posh southern English accent, sardonic and unimpressed, speaking slowly', seed: 7, referenceText: APPROVED_TAKE_TEXT.ice },
  },
  {
    id: 'nicky',
    name: 'Nicky',
    profile:
      'Nicky, the pop diva. 35, American, the trendsetter. Outrageous, sharp-tongued, flamboyant, unpredictable, fiercely competitive. Obsessed with originality, charisma, hooks and commercial appeal; no patience for predictable arrangements, dated production or singers without personality. Fast, sarcastic, sometimes outrageous humour; delivers a one-liner, then bursts out laughing at it. Fiercely protective of singers she thinks have real star quality. Unlike Ice, who judges songs as products, she cares about cultural relevance: music people will dance to, share and remember. Inspects her nails while others talk; can show complete contempt with one raised eyebrow. Signature: turns away from the stage when unimpressed, swivels back when something catches her. Sample lines: "Baby, that chorus needs a personality transplant." "I\'m sorry, are we making a hit record or waiting for an elevator?" "That beat? Delicious. Those lyrics? Criminal." "Ice, darling, your musical taste expired in 2007." "Okay, superstar! NOW we\'re talking!" With the others: challenges Ice\'s authority, mercilessly teases Bob, competes with Love for most fashionable judge.',
    voice: { description: 'A Black American woman in her forties, warm, big laugh in her voice, expressive and energetic', seed: 7, referenceText: APPROVED_TAKE_TEXT.nicky },
  },
  {
    id: 'love',
    name: 'Love',
    profile:
      'Love, the glamorous pop perfectionist. 46, Australian, the musical mentor. Warm, sophisticated, emotionally intelligent, perfectionist, surprisingly formidable. The most musically thoughtful judge: melody, harmony, arrangement, vocal phrasing, emotional honesty. A great pop song must make people feel something; she is visibly moved when one does. Usually diplomatic, but sharp-tongued when another judge says something unfair or silly. Her criticism is specific and constructive (change a chord, simplify a chorus, drop a needless layer). Takes notes. Signature: closes her eyes in beautiful passages, sometimes tearful. Sample lines: "There\'s something genuinely beautiful about that melody." "I loved the verse, but you\'ve completely lost me in the chorus." "Bob, darling, not everything needs to be compared to Westlife." "Ice, you might have a bank account, but you clearly don\'t have a heart." "That final key change gave me goosebumps." With the others: mediates between Ice and Bob, enjoys Nicky\'s theatrics, the only judge Ice consistently listens to.',
    voice: { description: 'A woman in her forties with a bright Australian accent, very sassy and cheeky, confident, a knowing eye-roll in her voice, teasing with attitude', seed: 7, referenceText: APPROVED_TAKE_TEXT.love },
  },
  {
    id: 'bob',
    name: 'Bob',
    profile:
      'Bob, the lovable Irish optimist. 66, Irish, the people\'s judge. Cheerful, sentimental, excitable, mischievous, hilariously enthusiastic. Loves almost everything and sees potential nobody else can. Every competent performer reminds him of a legend; knows the pop groups of the 1980s and 1990s by heart and thinks nearly every promising contestant could be an international star. Easily offended when Ice attacks his favourites. Genuine enthusiasm, sometimes spectacularly questionable judgement. Signature: leaps up for standing ovations that barely deserve polite applause. Sample lines: "You\'re going to be absolutely massive!" "Ice, you wouldn\'t recognise a hit if it hit you in the face!" "I\'m telling you, this could be the next ABBA!" "You\'ve got the look, you\'ve got the sound, you\'ve got everything!" "I don\'t care what anyone says. Twelve points!" With the others: Ice\'s favourite target; Love often defends him; Nicky finds his references hopelessly dated.',
    voice: { description: 'An Irish man in his fifties with a soft Dublin accent, a light, fairly high-pitched tenor voice with a little rasp, kind, easygoing and charming', seed: 21, referenceText: APPROVED_TAKE_TEXT.bob },
  },
];

/** How the four play together, for every scene with judges. */
export const JURY_DYNAMIC =
  'The dynamic. An ensemble, not four separate reviews. Ice vs Bob is the central comedy: Ice thinks Bob has terrible taste, Bob thinks Ice has forgotten how to enjoy music. Ice vs Nicky is generational: timeless songwriting against cultural relevance. Nicky vs Love is a friendly rivalry: attitude and originality against melody and feeling. Love vs Ice is the heart of the panel: Love sometimes persuades Ice to reconsider.';

/** The rules every judges' scene is written to. */
export const JURY_RULES =
  'Rules for the writer. Never four generic reviews in a row. They interrupt each other, react to unexpected comments, laugh, disagree and sometimes change their minds. Humour comes from their personalities and from specific musical details of the song. They must sometimes be genuinely surprised: now and then Ice gives twelve points to a song everyone expects him to hate, Bob delivers a devastating criticism, Nicky is moved to tears, Love loses her temper. The sample lines show the voice; the writer does not reuse them word for word in every video.';

/** The narrator's voice. PROVISIONAL: take "a", seed 7, of ~/casperaki-data/casting/narrator until the owner picks one. */
export const NARRATOR_VOICE = {
  description: 'A man in his forties with a warm, rich mid-Atlantic accent, a confident television announcer, building excitement',
  seed: 7,
  /** The words of the narrator takes (~/casperaki-data/casting/narrator): the reference reproduces the chosen take. */
  referenceText: "That's Kesha. In a few seconds, she faces all four judges, with a song nobody in that room has ever heard. Here she goes, and the whole room holds its breath.",
} as const;

/** The narrator: heard, never seen. */
export const NARRATOR_PROFILE =
  'The narrator of a television talent show: a warm, confident announcer heard over pictures of the contestant backstage, never seen. Builds excitement and sympathy, tells the audience who the singer is and what is at stake, short punchy sentences, a little drama, never sarcastic.';

export type Outcome = 'fourYes' | 'threeOne' | 'notThisTime';
export const OUTCOMES: readonly Outcome[] = ['fourYes', 'threeOne', 'notThisTime'];
export type Vote = 'yes' | 'no';

/** Each judge's vote for the outcome; with three to one, the judge saying no is picked from the song id (the same on a
 *  re-run). */
export function verdictVotes(outcome: Outcome, songId: string): Record<JudgeId, Vote> {
  const all = (v: Vote) => Object.fromEntries(JUDGES.map((j) => [j.id, v])) as Record<JudgeId, Vote>;
  if (outcome === 'fourYes') return all('yes');
  if (outcome === 'notThisTime') return all('no');
  const no = JUDGES[hashString(`casting-no:${songId}`) % JUDGES.length]!.id;
  return Object.fromEntries(JUDGES.map((j) => [j.id, j.id === no ? 'no' : 'yes'])) as Record<JudgeId, Vote>;
}

/** The names of the cast besides the singer (lower case): a singer called one of these cannot be cast. */
export function castNames(): string[] {
  return ['narrator', ...JUDGES.map((j) => j.name.toLowerCase())];
}
