/** The credit for the model that sings the vocals (CC BY-NC 4.0): on the home page, never the song page. */
export const VOCALS_CREDIT = 'Vocals sung with YuE2 (m-a-p/YuE2-3B, https://huggingface.co/m-a-p/YuE2-3B), CC BY-NC 4.0';

const MODEL_URL = 'https://huggingface.co/m-a-p/YuE2-3B';

export function VocalsCredit() {
  return (
    <p className="text-[12px] text-white/40">
      Vocals sung with YuE2 (m-a-p/YuE2-3B,{' '}
      <a className="underline hover:text-white/70" href={MODEL_URL} target="_blank" rel="noreferrer">
        {MODEL_URL}
      </a>
      ), CC BY-NC 4.0
    </p>
  );
}
