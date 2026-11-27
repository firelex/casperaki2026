// The dressing room's 3D view: one avatar on a soft-lit stage, swaying gently and turning slowly; dragging turns
// it by hand (it carries on turning by itself a few seconds after). The camera glides to the framing of the group
// being dressed (the pack's per-group camera target). `portrait()` takes a head-and-shoulders PNG for the library.

import { Cache, DirectionalLight, HemisphereLight, PerspectiveCamera, Scene, Timer, Vector2, Vector3, WebGLRenderer } from 'three';
import { movePose, type Avatar } from '@casperaki/video/avatar';

// The same part files are loaded again on every change of the recipe: keep them in memory once fetched.
Cache.enabled = true;

/** A camera framing: how far from the avatar and at what height it looks, in metres. */
export interface Framing {
  readonly distance: number;
  readonly height: number;
}

const FULL_BODY: Framing = { distance: 3.2, height: 0.88 };
const PORTRAIT: Framing = { distance: 0.75, height: 1.32 };
const PORTRAIT_SIZE = 512;
/** Vertical field of view (degrees): with it, the packs' per-group camera distances frame their groups. */
const FOV = 40;
/** Radians a second the avatar turns by itself. */
const TURN_SPEED = 0.35;
/** Seconds after a drag before it turns by itself again. */
const RESUME_AFTER = 4;
const SWAY_BPM = 96;

export class AvatarStage {
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(FOV, 1, 0.05, 50);
  private readonly timer = new Timer();
  private readonly resize: ResizeObserver;
  private avatar: Avatar | null = null;
  private frame = 0;
  private turn = 0;
  private time = 0;
  private idleFor = RESUME_AFTER;
  private drag: { pointer: number; x: number; turn: number } | null = null;
  private eye = new Vector3(0, FULL_BODY.height, FULL_BODY.distance);
  private target: Framing = FULL_BODY;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x000000, 0);
    // Soft light for the toon (MToon) materials: a bright sky over a dim floor, a key light from the front and a
    // cooler rim from behind.
    this.scene.add(new HemisphereLight(0xffffff, 0x3a3a48, 1.7));
    const key = new DirectionalLight(0xffffff, 1.9);
    key.position.set(1.5, 3, 4);
    this.scene.add(key);
    const rim = new DirectionalLight(0xbfd4ff, 0.9);
    rim.position.set(-2, 2.5, -3);
    this.scene.add(rim);

    this.resize = new ResizeObserver(() => this.fit());
    this.resize.observe(canvas);
    this.fit();
    canvas.addEventListener('pointerdown', this.onDown);
    canvas.addEventListener('pointermove', this.onMove);
    canvas.addEventListener('pointerup', this.onUp);
    canvas.addEventListener('pointercancel', this.onUp);
    this.frame = requestAnimationFrame(this.tick);
  }

  /** Shows `avatar` instead of the one shown (which the caller disposes). */
  setAvatar(avatar: Avatar | null): void {
    if (this.avatar) this.scene.remove(this.avatar.root);
    this.avatar = avatar;
    if (avatar) {
      this.scene.add(avatar.root);
      avatar.resetSprings();
    }
  }

  /** Moves the camera (smoothly) to look at the avatar this way; undefined: the whole avatar. */
  frameOn(framing: Framing | undefined): void {
    this.target = framing ?? FULL_BODY;
  }

  /** A head-and-shoulders picture of the avatar facing the camera, as a PNG data URL. */
  portrait(): string {
    if (!this.avatar) throw new Error('There is no avatar to take a portrait of yet.');
    const size = this.renderer.getSize(new Vector2());
    const ratio = this.renderer.getPixelRatio();
    const turn = this.avatar.root.rotation.y;
    this.avatar.root.rotation.y = 0;
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(PORTRAIT_SIZE, PORTRAIT_SIZE, false);
    const cam = new PerspectiveCamera(FOV, 1, 0.05, 50);
    cam.position.set(0, PORTRAIT.height, PORTRAIT.distance);
    cam.lookAt(0, PORTRAIT.height - 0.05, 0);
    this.renderer.render(this.scene, cam);
    const png = this.canvas.toDataURL('image/png');
    this.avatar.root.rotation.y = turn;
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(size.x, size.y, false);
    this.renderer.render(this.scene, this.camera);
    return png;
  }

  dispose(): void {
    cancelAnimationFrame(this.frame);
    this.resize.disconnect();
    this.canvas.removeEventListener('pointerdown', this.onDown);
    this.canvas.removeEventListener('pointermove', this.onMove);
    this.canvas.removeEventListener('pointerup', this.onUp);
    this.canvas.removeEventListener('pointercancel', this.onUp);
    this.setAvatar(null);
    this.renderer.dispose();
  }

  private fit(): void {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (w === 0 || h === 0) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private readonly tick = (now: number) => {
    this.frame = requestAnimationFrame(this.tick);
    this.timer.update(now);
    const dt = Math.min(this.timer.getDelta(), 0.1);
    this.time += dt;
    if (!this.drag) {
      this.idleFor += dt;
      if (this.idleFor >= RESUME_AFTER) this.turn += TURN_SPEED * dt;
    }
    // Glide the camera to its framing.
    const goal = new Vector3(0, this.target.height, this.target.distance);
    this.eye.lerp(goal, 1 - Math.exp(-dt * 4));
    this.camera.position.copy(this.eye);
    this.camera.lookAt(0, this.eye.y, 0);
    if (this.avatar) {
      this.avatar.root.rotation.y = this.turn;
      this.avatar.setPose(movePose('sway', { beats: (this.time * SWAY_BPM) / 60, energy: 0.25 }));
      this.avatar.setExpressions({ happy: 0.2, blink: blink(this.time) });
      this.avatar.update(dt);
    }
    this.renderer.render(this.scene, this.camera);
  };

  private readonly onDown = (e: PointerEvent) => {
    this.canvas.setPointerCapture(e.pointerId);
    this.drag = { pointer: e.pointerId, x: e.clientX, turn: this.turn };
  };

  private readonly onMove = (e: PointerEvent) => {
    if (!this.drag || e.pointerId !== this.drag.pointer) return;
    this.turn = this.drag.turn + ((e.clientX - this.drag.x) / Math.max(1, this.canvas.clientWidth)) * Math.PI * 2;
  };

  private readonly onUp = (e: PointerEvent) => {
    if (!this.drag || e.pointerId !== this.drag.pointer) return;
    this.drag = null;
    this.idleFor = 0;
  };
}

/** A blink every four seconds or so (0..1). */
function blink(t: number): number {
  const p = t % 4.2;
  return p < 0.15 ? Math.sin((p / 0.15) * Math.PI) : 0;
}
