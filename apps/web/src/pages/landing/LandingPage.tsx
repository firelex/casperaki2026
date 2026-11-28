import '@fontsource-variable/archivo/wdth.css';
import type { ReactNode } from 'react';

import { useAuth } from '../../auth/AuthContext';
import { ArrangementHero } from './ArrangementHero';
import { Placeholder } from './Placeholder';

/**
 * Public landing page, shown to every signed-out visitor.
 *
 * The point it makes: Casperaki writes songs the way producers do —
 * recorded instruments, arrangement rules, a mix — with AI limited to
 * suggestions, so the user controls every part and no other artist's
 * recording ends up in the song. Image slots are placeholders until the
 * artwork arrives (see Placeholder).
 */
export function LandingPage() {
  const { signIn } = useAuth();
  return (
    <div className="landing min-h-full">
      <Nav onSignIn={signIn} />
      <main>
        <Hero onStart={signIn} />
        <Difference />
        <HowItWorks />
        <Control />
        <Provenance />
        <Faq />
        <FinalCall onStart={signIn} />
      </main>
      <Footer />
    </div>
  );
}

function Wrap({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`mx-auto w-full max-w-[1240px] px-4 sm:px-8 ${className}`}>{children}</div>;
}

function PrimaryButton({ onClick, children }: { onClick(): void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="landing-btn landing-btn-primary">
      {children}
    </button>
  );
}

function Nav({ onSignIn }: { onSignIn(): void }) {
  return (
    <header className="sticky top-0 z-20 border-b border-white/[0.06] bg-bg/85 backdrop-blur">
      <Wrap className="flex h-16 items-center justify-between gap-6">
        <a href="#top" aria-label="Casperaki">
          <img src="/brand/casperaki-logo.svg" alt="Casperaki" width={162} height={19} className="block h-[19px] w-auto" />
        </a>
        <nav className="hidden md:flex items-center gap-8 text-[15px] text-white/70" aria-label="Page sections">
          <a href="#how" className="landing-link">How it works</a>
          <a href="#control" className="landing-link">What you control</a>
          <a href="#sounds" className="landing-link">Where the sound comes from</a>
          <a href="#faq" className="landing-link">Questions</a>
        </nav>
        <button type="button" onClick={onSignIn} className="landing-btn landing-btn-quiet">
          Sign in
        </button>
      </Wrap>
    </header>
  );
}

function Hero({ onStart }: { onStart(): void }) {
  return (
    <section id="top">
      <div className="relative isolate overflow-hidden">
        <picture>
          <source
            media="(max-width: 767px)"
            srcSet="/landing/studio-portrait-750.webp 750w, /landing/studio-portrait.webp 1122w"
            sizes="100vw"
          />
          <img
            src="/landing/studio-wide.webp"
            srcSet="/landing/studio-wide-1100.webp 1100w, /landing/studio-wide.webp 1774w"
            sizes="100vw"
            alt="A recording studio at night: mixing desk, monitors, keyboard and a gold record on the wall"
            fetchPriority="high"
            className="absolute inset-0 -z-10 h-full w-full object-cover object-[center_bottom] md:object-[left_center]"
          />
        </picture>
        <div className="landing-hero-shade absolute inset-0 -z-10" aria-hidden="true" />
        <Wrap className="flex min-h-[min(86vh,760px)] md:min-h-[min(82vh,52vw)] flex-col justify-start md:justify-center pt-20 pb-16 md:py-24">
          <h1 className="landing-display text-[clamp(42px,6vw,92px)] max-w-[12ch]">Pop deserves better.</h1>
          <p className="landing-tagline mt-3 text-[clamp(22px,2.4vw,36px)]">Let&rsquo;s make it so.</p>
          <div className="mt-10 flex flex-wrap items-center gap-4">
            <PrimaryButton onClick={onStart}>Start a song</PrimaryButton>
            <a href="#how" className="landing-btn landing-btn-quiet landing-btn-glass">See how it works</a>
          </div>
        </Wrap>
      </div>
      <Wrap className="pt-14 sm:pt-20 pb-20 sm:pb-28">
        <div className="grid gap-6 lg:grid-cols-2 lg:gap-16">
          <p className="max-w-[60ch] text-[clamp(21px,2vw,26px)] leading-[1.5] text-white/90">
            Casperaki isn&rsquo;t just another AI music generator. It&rsquo;s an AI-driven sequencer built around the
            sounds, rhythms, arrangements and production techniques that defined pop music before it fell off a cliff
            in the mid-2010s.
          </p>
          <p className="max-w-[60ch] text-[clamp(21px,2vw,26px)] leading-[1.5] text-white/90">
            Inspired by the producers behind that era&rsquo;s biggest hits, Casperaki puts their creative building
            blocks in your hands, giving you the freedom to make something entirely new.
          </p>
        </div>
        <div className="mt-16 sm:mt-20">
        <ArrangementHero />
        <p className="mt-5 text-[14px] text-white/45 max-w-[70ch]">
          A song in Casperaki: nine sections, five instruments. Each lane is a named sound from the library,
          and each block is something you can move, stretch, copy or replace.
        </p>
        </div>
      </Wrap>
    </section>
  );
}

const COMPARISON: ReadonlyArray<{ topic: string; prompt: string; casperaki: string }> = [
  {
    topic: 'Where the audio comes from',
    prompt: 'A model generates the waveform, learned from large collections of existing recordings.',
    casperaki: 'Recorded instruments from our sound library, played note by note and mixed like a studio session.',
  },
  {
    topic: 'What AI decides',
    prompt: 'Everything: melody, sound, structure and mix arrive as one finished file.',
    casperaki: 'Suggestions only, such as which sounds suit a genre. The audio is never generated by a model.',
  },
  {
    topic: 'Changing one part',
    prompt: 'Rewrite the prompt and generate again. The parts you liked may not survive.',
    casperaki: 'Edit that part. The rest of the song stays exactly as it was.',
  },
  {
    topic: 'Knowing what is in your song',
    prompt: 'Hard to say what the model drew on.',
    casperaki: 'Every sound is a named instrument from the library, listed in the song.',
  },
];

function Difference() {
  return (
    <section className="border-t border-white/[0.06] py-20 sm:py-28">
      <Wrap>
        <h2 className="landing-heading max-w-[22ch]">Not a prompt box. A production you can open up.</h2>
        <p className="mt-6 max-w-[62ch] text-[17px] leading-[1.65] text-white/70">
          Most AI music tools turn a sentence into a finished audio file. That is fast, but you can&rsquo;t reach
          inside it, and nobody can tell you what it was learned from. Casperaki works the other way round.
        </p>
        <div className="mt-12 overflow-x-auto">
          <table className="landing-table w-full min-w-[680px] text-left">
            <thead>
              <tr>
                <th scope="col" className="w-[22%]"><span className="sr-only">Topic</span></th>
                <th scope="col" className="w-[39%] text-white/50">Prompt-to-audio generators</th>
                <th scope="col" className="w-[39%] text-white">Casperaki</th>
              </tr>
            </thead>
            <tbody>
              {COMPARISON.map((row) => (
                <tr key={row.topic}>
                  <th scope="row" className="text-white/85">{row.topic}</th>
                  <td className="text-white/50">{row.prompt}</td>
                  <td className="text-white/90">{row.casperaki}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Wrap>
    </section>
  );
}

const STEPS: ReadonlyArray<{ title: string; body: string; slot: string; note: string }> = [
  {
    title: 'Pick a genre and a tempo',
    body: 'Ballad, bright pop, Casperaki pop, dance, Latin, organic, rock, Schlager or urban. Give it a title if you like.',
    slot: 'step-genre',
    note: 'The "Create a project" dialog with genre and tempo chosen',
  },
  {
    title: 'Get a first draft',
    body: 'Casperaki lays out sections, picks instruments that suit the genre and writes their parts. It takes a second.',
    slot: 'step-draft',
    note: 'A freshly generated song on the timeline',
  },
  {
    title: 'Make it yours',
    body: 'Reorder and resize sections, swap sounds, add or drop bars. Nothing changes unless you change it.',
    slot: 'step-edit',
    note: 'The structure view mid-edit, a section being dragged',
  },
  {
    title: 'Render and download',
    body: 'The song is mixed on our servers in under a minute. Listen in the browser, then download WAV or MP3.',
    slot: 'step-render',
    note: 'The player with a finished waveform and the download buttons',
  },
];

function HowItWorks() {
  return (
    <section id="how" className="border-t border-white/[0.06] py-20 sm:py-28">
      <Wrap>
        <h2 className="landing-heading">From idea to finished track in four steps</h2>
        <ol className="mt-14 grid gap-x-8 gap-y-14 sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map((step, i) => (
            <li key={step.slot} className="flex flex-col">
              <span className="landing-step-number" aria-hidden="true">{i + 1}</span>
              <h3 className="mt-4 text-[20px] font-semibold leading-snug text-white">{step.title}</h3>
              <p className="mt-3 text-[16px] leading-[1.6] text-white/65">{step.body}</p>
              <Placeholder slot={step.slot} note={step.note} ratio="4 / 3" className="mt-6" />
            </li>
          ))}
        </ol>
      </Wrap>
    </section>
  );
}

const CONTROLS: ReadonlyArray<{ title: string; body: string; slot: string; note: string }> = [
  {
    title: 'The structure',
    body:
      'Intro, verse, chorus, bridge, outro: every section is a block you can drag into a new order, duplicate, delete or lengthen by a bar at a time. A three-minute song can become a ninety-second edit in a few clicks.',
    slot: 'control-structure',
    note: 'Structure view: the row of coloured section blocks',
  },
  {
    title: 'The sounds',
    body:
      'Each instrument is one of more than 12,000 recorded sounds, filed by family and style. Swap the bass, try a different drum kit, and only that lane changes.',
    slot: 'control-sounds',
    note: 'Sound design view: instrument cards with their sound names',
  },
  {
    title: 'The result',
    body:
      'Renders are mixed with the same effects chain every time, so the same song always sounds the same. Save a version, keep editing, render again and compare.',
    slot: 'control-render',
    note: 'Timeline with the rendered waveform under the sections',
  },
];

function Control() {
  return (
    <section id="control" className="border-t border-white/[0.06] py-20 sm:py-28">
      <Wrap>
        <h2 className="landing-heading max-w-[20ch]">You hold the controls. All of them.</h2>
        <div className="mt-16 flex flex-col gap-20 sm:gap-28">
          {CONTROLS.map((c, i) => (
            <div
              key={c.slot}
              className={`grid items-center gap-8 md:gap-14 md:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] ${
                i % 2 === 1 ? 'md:[&>*:first-child]:order-2' : ''
              }`}
            >
              <div>
                <h3 className="landing-subheading">{c.title}</h3>
                <p className="mt-4 max-w-[48ch] text-[17px] leading-[1.65] text-white/70">{c.body}</p>
              </div>
              <Placeholder slot={c.slot} note={c.note} ratio="16 / 10" />
            </div>
          ))}
        </div>
      </Wrap>
    </section>
  );
}

function Provenance() {
  return (
    <section id="sounds" className="landing-provenance border-t border-white/[0.06] py-20 sm:py-28">
      <Wrap className="grid gap-12 lg:grid-cols-[minmax(0,6fr)_minmax(0,5fr)] lg:items-start">
        <div>
          <h2 className="landing-heading max-w-[18ch]">Made from sounds we can account for</h2>
          <div className="mt-8 flex flex-col gap-5 max-w-[60ch] text-[17px] leading-[1.7] text-white/75">
            <p>
              Copyright trouble with AI music usually starts with training: a model learns from recordings it had
              no permission to use, and traces of them can surface in what it makes. Casperaki stays out of that.
            </p>
            <p>
              Your song is played on recorded instruments from our own library, using the arrangement and mixing
              techniques producers have always used. The AI in Casperaki helps choose and suggest. It does not
              generate audio, and it does not imitate any artist.
            </p>
            <p>
              Because every sound in a song is a named entry in the library, we can tell you exactly what went into
              it.
            </p>
          </div>
        </div>
        <dl className="landing-facts grid grid-cols-2 gap-px rounded-[6px] overflow-hidden">
          <Fact term="Recorded sounds" value="12,199" />
          <Fact term="Instrument families" value="22" />
          <Fact term="Genres" value="8" />
          <Fact term="Audio generated by a model" value="None" />
        </dl>
      </Wrap>
    </section>
  );
}

function Fact({ term, value }: { term: string; value: string }) {
  return (
    <div className="bg-panel px-6 py-7">
      <dt className="text-[14px] text-white/55">{term}</dt>
      <dd className="landing-display mt-2 text-[36px]">{value}</dd>
    </div>
  );
}

const FAQ: ReadonlyArray<{ q: string; a: string }> = [
  {
    q: 'Do I need to know music production?',
    a: 'No. The first draft is a complete song. Every change after that is a click or a drag, and you can always render to hear it.',
  },
  {
    q: 'Can I use the songs commercially?',
    a: '[Licence terms to be confirmed. This answer will set out what you may do with rendered songs.]',
  },
  {
    q: 'What does the AI actually do?',
    a: 'It helps with choices: which sounds suit a genre, how sections can follow each other, what a part could play. The audio itself always comes from recorded instruments.',
  },
  {
    q: 'Which formats can I download?',
    a: 'WAV for full quality and MP3 for sharing. Both come from the same render.',
  },
  {
    q: 'How do I get an account?',
    a: 'Casperaki is invite-only for now. Accounts are set up by our team.',
  },
];

function Faq() {
  return (
    <section id="faq" className="border-t border-white/[0.06] py-20 sm:py-28">
      <Wrap className="grid gap-10 lg:grid-cols-[minmax(0,4fr)_minmax(0,7fr)]">
        <h2 className="landing-heading">Questions</h2>
        <div className="flex flex-col">
          {FAQ.map((item) => (
            <details key={item.q} className="landing-faq group">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-6 py-5 text-[18px] text-white">
                {item.q}
                <span className="landing-faq-mark" aria-hidden="true" />
              </summary>
              <p className="pb-6 max-w-[62ch] text-[16px] leading-[1.65] text-white/65">{item.a}</p>
            </details>
          ))}
        </div>
      </Wrap>
    </section>
  );
}

function FinalCall({ onStart }: { onStart(): void }) {
  return (
    <section className="border-t border-white/[0.06] py-24 sm:py-32">
      <Wrap className="flex flex-col items-start gap-8">
        <h2 className="landing-display text-[clamp(34px,4.4vw,64px)] max-w-[16ch]">
          Your next song is a draft away.
        </h2>
        <div className="flex flex-wrap items-center gap-5">
          <PrimaryButton onClick={onStart}>Start a song</PrimaryButton>
          <span className="text-[15px] text-white/50">Invite-only for now: sign in with the account our team set up for you.</span>
        </div>
      </Wrap>
    </section>
  );
}

function Footer() {
  return (
    <footer className="border-t border-white/[0.06] py-10">
      <Wrap className="flex flex-wrap items-center justify-between gap-4 text-[14px] text-white/45">
        <img src="/brand/casperaki-logo.svg" alt="Casperaki" width={136} height={16} className="block h-[16px] w-auto opacity-80" />
        <span>© {new Date().getFullYear()} Casperaki</span>
      </Wrap>
    </footer>
  );
}
