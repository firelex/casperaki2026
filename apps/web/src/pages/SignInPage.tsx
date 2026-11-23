// The demo sign-in screen (brain BRAIN_DEMO_LOGIN=1): the landing page's neon
// studio photo behind a dark glass card. The brain's GET /api/auth/login
// redirects here with ?return_to=; a successful POST sets the session cookie
// and we reload at the return address.
import '@fontsource-variable/archivo/wdth.css';
import { useState, type FormEvent } from 'react';

import { auth } from '../api/auth';
import { BrainError } from '../api/client';

const DEMO = { email: 'demo@example.com', password: 'demo123' };

export function SignInPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await auth.demoLogin(email, password);
      const back = new URLSearchParams(window.location.search).get('return_to') ?? '/';
      // Only a same-site path (the brain sends one); anything else goes home.
      window.location.href = back.startsWith('/') && !back.startsWith('//') && !back.includes('\\') ? back : '/';
    } catch (err) {
      setError(err instanceof BrainError && err.status === 401 ? 'Wrong email or password.' : `Sign-in failed: ${err instanceof Error ? err.message : String(err)}`);
      setBusy(false);
    }
  }

  const field =
    'sign-in-field h-12 w-full rounded-[10px] border border-white/[0.14] bg-black/30 px-4 text-[15px] text-white outline-none placeholder:text-white/30';

  return (
    <div className="landing relative isolate flex min-h-full flex-col overflow-hidden">
      <picture>
        <source media="(max-width: 767px)" srcSet="/landing/studio-portrait-750.webp 750w, /landing/studio-portrait.webp 1122w" sizes="100vw" />
        <img
          src="/landing/studio-wide.webp"
          srcSet="/landing/studio-wide-1100.webp 1100w, /landing/studio-wide.webp 1774w"
          sizes="100vw"
          alt=""
          className="absolute inset-0 -z-10 h-full w-full object-cover"
        />
      </picture>
      <div className="sign-in-shade absolute inset-0 -z-10" aria-hidden="true" />

      <header>
        <div className="mx-auto flex h-16 w-full max-w-[1240px] items-center px-4 sm:px-8">
          <a href="/" aria-label="Casperaki home">
            <img src="/brand/casperaki-logo.svg" alt="Casperaki" width={162} height={19} className="block h-[19px] w-auto" />
          </a>
        </div>
      </header>

      <main className="flex flex-1 items-center justify-center px-4 py-12">
        <div className="sign-in-card w-full max-w-[420px] rounded-[20px] p-6 sm:p-8">
          <h1 className="landing-heading">Sign in</h1>
          <p className="mt-3 text-[15px] text-white/65">Write, arrange and mix your songs.</p>

          <form onSubmit={submit} className="mt-8 space-y-4">
            <label className="block">
              <span className="mb-1.5 block text-[13px] text-white/75">Email</span>
              <input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} className={field} />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-[13px] text-white/75">Password</span>
              <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} className={field} />
            </label>
            {error ? <p className="sign-in-accent text-[13px]" role="alert">{error}</p> : null}
            <button type="submit" disabled={busy} className="landing-btn sign-in-btn w-full disabled:opacity-60">
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
          </form>

          <div className="mt-6 rounded-[12px] border border-white/[0.1] bg-black/25 p-4 text-[13px]">
            <div className="font-semibold text-white">Demo access</div>
            <div className="mt-1 text-white/65">
              Email <span className="font-mono text-white">{DEMO.email}</span>, password <span className="font-mono text-white">{DEMO.password}</span>
            </div>
            <button
              type="button"
              className="sign-in-accent mt-2 hover:underline"
              onClick={() => {
                setEmail(DEMO.email);
                setPassword(DEMO.password);
              }}
            >
              Fill in for me
            </button>
          </div>
        </div>
      </main>
    </div>
  );
}
