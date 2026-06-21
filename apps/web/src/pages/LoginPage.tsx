import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';

/**
 * Login screen — visual mock of `rory-fe/src/views/LoginView.vue`.
 *
 * 50/50 split: left panel carries the brand boxes / play glyph and
 * staggered entrance animations; right panel is the dark form. No
 * backend auth — the form posts nowhere, hitting "Log in" sends the
 * user to `/` (Projects). Two sub-panels (Sign-up / Log in) toggle
 * inside the form, mirroring rory-fe's `<LoginForm>` switchTo flow.
 */
export function LoginPage() {
  const navigate = useNavigate();
  const [hidden, setHidden] = useState(false);
  const [panel, setPanel] = useState<'home' | 'form'>('home');
  const [animBoxes, setAnimBoxes] = useState(false);
  const [animPlay, setAnimPlay] = useState(false);
  const [animForm, setAnimForm] = useState(false);

  useEffect(() => {
    const timers = [
      setTimeout(() => setAnimBoxes(true), 100),
      setTimeout(() => setAnimForm(true), 400),
      setTimeout(() => setAnimPlay(true), 800),
    ];
    return () => timers.forEach(clearTimeout);
  }, []);

  const nextPage = () => {
    setHidden(true);
    setTimeout(() => navigate('/'), 400);
  };

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    nextPage();
  };

  return (
    <div
      className={`fixed inset-0 bg-[#e2e2e2] transition-opacity duration-400 ${
        hidden ? 'opacity-0 pointer-events-none' : 'opacity-100'
      }`}
    >
      {/* Left — brand surface */}
      <div className="absolute inset-0 overflow-hidden">
        <div
          className={`absolute bg-accent transition-all duration-300 ease-[cubic-bezier(0.18,0.89,0.32,1.28)] origin-left ${
            animBoxes ? 'scale-x-100' : 'scale-x-0'
          }`}
          style={{ width: '26vw', height: '11vh', left: '12vw', top: '25vh' }}
          aria-hidden="true"
        />
        <div
          className={`absolute bg-accent transition-all duration-300 delay-200 ease-[cubic-bezier(0.18,0.89,0.32,1.28)] origin-left ${
            animBoxes ? 'scale-x-100' : 'scale-x-0'
          }`}
          style={{ width: '26vw', height: '11vh', left: '12vw', bottom: '15vh' }}
          aria-hidden="true"
        />

        {/* "casperaki" oversized headline — stands in for rory's login-text.svg */}
        <div
          className={`absolute left-[5vw] top-[6vh] right-0 text-[#111] font-black tracking-tighter leading-none transition-all duration-500 ${
            animBoxes ? 'opacity-100' : 'opacity-0'
          }`}
          style={{ fontSize: 'clamp(80px, 16vw, 280px)' }}
          aria-hidden="true"
        >
          casper<span className="text-accent">aki</span>
        </div>

        {/* play glyph */}
        <div
          className={`absolute flex items-center justify-center transition-all duration-500 ${
            animPlay ? 'opacity-100 scale-100' : 'opacity-0 scale-0'
          }`}
          style={{
            left: '20vw',
            bottom: '34vh',
            width: '14vw',
            height: '14vw',
          }}
          aria-hidden="true"
        >
          <div className="w-full h-full rounded-full bg-black/85 flex items-center justify-center shadow-2xl">
            <svg viewBox="0 0 24 24" className="w-1/2 h-1/2 fill-white">
              <path d="M8 5v14l11-7z" />
            </svg>
          </div>
        </div>

        {/* footer wordmark */}
        <div className="absolute left-[5vw] bottom-[3vh] text-[12px] uppercase tracking-[0.32em] text-black/40">
          casperaki · workbench
        </div>
      </div>

      {/* Right — form */}
      <div
        className={`absolute right-0 top-0 bottom-0 w-1/2 bg-black z-10 transition-all duration-600 ease-[cubic-bezier(0,0,0,1.08)] ${
          animForm ? 'translate-x-0 opacity-100' : 'translate-x-[5%] opacity-0'
        }`}
      >
        <div className="h-full w-full flex items-center justify-center px-10">
          <div className="w-full max-w-[360px] flex flex-col">
            {panel === 'home' ? (
              <SignUpPanel onSwitch={() => setPanel('form')} onContinue={nextPage} />
            ) : (
              <LoginPanel onBack={() => setPanel('home')} onSubmit={onSubmit} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function SignUpPanel({
  onSwitch,
  onContinue,
}: {
  onSwitch(): void;
  onContinue(): void;
}) {
  return (
    <>
      <h2 className="text-[30px] text-white text-center font-semibold leading-tight">
        Sign up for <span className="text-accent">Casperaki</span>
      </h2>
      <p className="text-center text-white/60 text-[14px] mt-3 mb-10 leading-relaxed">
        Sign up to create royalty-free music and videos, follow users, and
        explore content.
      </p>
      <button
        type="button"
        onClick={onContinue}
        className="h-14 rounded-full bg-accent text-white text-[16px] font-semibold mb-3 hover:bg-accent/90 transition-colors"
      >
        Use phone or email
      </button>
      <button
        type="button"
        onClick={onContinue}
        className="h-14 rounded-full border-2 border-white/10 text-white text-[16px] font-semibold mb-3 hover:border-white/30 transition-colors"
      >
        Continue with Google
      </button>
      <button
        type="button"
        onClick={onContinue}
        className="h-14 rounded-full border-2 border-white/10 text-white text-[16px] font-semibold mb-3 hover:border-white/30 transition-colors"
      >
        Continue with Apple
      </button>
      <p className="text-center text-white/70 text-[14px] mt-8">
        Already signed up?{' '}
        <button
          type="button"
          onClick={onSwitch}
          className="text-accent font-semibold hover:underline"
        >
          Log in here →
        </button>
      </p>
      <p className="text-center text-white/30 text-[11px] mt-6 leading-relaxed max-w-[280px] mx-auto">
        Visual mock — no auth backend. By continuing, the workbench just
        opens. The brain has no users.
      </p>
    </>
  );
}

function LoginPanel({
  onBack,
  onSubmit,
}: {
  onBack(): void;
  onSubmit(e: FormEvent<HTMLFormElement>): void;
}) {
  return (
    <>
      <div className="w-full flex items-center justify-between mb-8">
        <button
          type="button"
          onClick={onBack}
          className="h-9 w-9 rounded-full bg-white/5 text-white/70 hover:text-white hover:bg-white/10 transition-colors text-[18px]"
          aria-label="Back"
        >
          ←
        </button>
        <span className="text-[11px] uppercase tracking-[0.18em] text-white/40">
          Log in
        </span>
        <div className="w-9" />
      </div>
      <h2 className="text-[30px] text-white text-center font-semibold mb-8">Log in</h2>
      <form onSubmit={onSubmit} className="flex flex-col">
        <input
          type="email"
          placeholder="Email address"
          className="h-14 rounded-2xl bg-[#252a31] text-white/80 text-[16px] px-7 mb-3 outline-none focus:bg-[#2c323b] placeholder:text-white/40"
        />
        <input
          type="password"
          placeholder="Password"
          className="h-14 rounded-2xl bg-[#252a31] text-white/80 text-[16px] px-7 mb-5 outline-none focus:bg-[#2c323b] placeholder:text-white/40"
        />
        <button
          type="submit"
          className="h-14 rounded-full bg-accent text-white text-[16px] font-semibold hover:bg-accent/90 transition-colors"
        >
          Log in
        </button>
      </form>
      <p className="text-center text-white/70 text-[13px] mt-6">
        Forgotten password?{' '}
        <a className="text-accent font-semibold cursor-pointer hover:underline">
          Reset it here →
        </a>
      </p>
    </>
  );
}
