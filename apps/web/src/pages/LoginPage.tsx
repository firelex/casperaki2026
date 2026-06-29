import { useEffect, useState } from 'react';
import { useAuth } from '../auth/AuthContext';

/**
 * Landing screen — shown to every signed-out visitor.
 *
 * 50/50 split: left panel carries the brand boxes / play glyph and
 * staggered entrance animations; right panel offers OIDC sign-in CTAs.
 * All three buttons trigger the same OIDC redirect via useAuth().signIn().
 */
export function LoginPage() {
  const { signIn } = useAuth();
  const [hidden, setHidden] = useState(false);
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

  const go = () => {
    setHidden(true);
    setTimeout(signIn, 300);
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

      {/* Right — sign-in CTAs */}
      <div
        className={`absolute right-0 top-0 bottom-0 w-1/2 bg-black z-10 transition-all duration-600 ease-[cubic-bezier(0,0,0,1.08)] ${
          animForm ? 'translate-x-0 opacity-100' : 'translate-x-[5%] opacity-0'
        }`}
      >
        <div className="h-full w-full flex items-center justify-center px-10">
          <div className="w-full max-w-[360px] flex flex-col">
            <SignUpPanel onContinue={go} />
          </div>
        </div>
      </div>
    </div>
  );
}

function SignUpPanel({ onContinue }: { onContinue(): void }) {
  return (
    <>
      <h2 className="text-[30px] text-white text-center font-semibold leading-tight">
        Welcome to <span className="text-accent">Casperaki</span>
      </h2>
      <p className="text-center text-white/60 text-[14px] mt-3 mb-10 leading-relaxed">
        Sign in or create an account to make royalty-free music and videos,
        follow users, and explore content.
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
      <p className="text-center text-white/30 text-[11px] mt-6 leading-relaxed max-w-[280px] mx-auto">
        By continuing you agree to our terms of service and privacy policy.
      </p>
    </>
  );
}
