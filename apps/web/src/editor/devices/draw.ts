/** Shared drawing for the device views: faceplate, screws, LED meters, knobs. */

/** Brushed dark-metal faceplate with screws in the corners. */
export function faceplate(g: CanvasRenderingContext2D, W: number, H: number): void {
  const plate = g.createLinearGradient(0, 0, 0, H);
  plate.addColorStop(0, '#2f3136');
  plate.addColorStop(1, '#1f2024');
  g.fillStyle = plate;
  g.fillRect(0, 0, W, H);
  g.globalAlpha = 0.05;
  for (let y = 0; y < H; y += 2) {
    g.fillStyle = y % 4 ? '#ffffff' : '#000000';
    g.fillRect(0, y, W, 1);
  }
  g.globalAlpha = 1;
  for (const [x, y] of [[10, 10], [W - 10, 10], [10, H - 10], [W - 10, H - 10]] as const) screw(g, x, y);
}

function screw(g: CanvasRenderingContext2D, x: number, y: number) {
  g.fillStyle = '#4a4c52';
  g.beginPath();
  g.arc(x, y, 3.5, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = '#1a1b1e';
  g.beginPath();
  g.moveTo(x - 2.5, y);
  g.lineTo(x + 2.5, y);
  g.stroke();
}


/** LED bar meter, −60..0 dBFS, RMS bar with a peak tick. */
export function ledMeter(g: CanvasRenderingContext2D, x: number, y: number, label: string, rmsDb: number, peakDb: number) {
  const h = 150;
  const segs = 30;
  for (let i = 0; i < segs; i++) {
    const d = -60 + (i + 1) * 2;
    const on = rmsDb >= d;
    const color = d > -3 ? '#ff4b3e' : d > -12 ? '#ffd23e' : '#38e07b';
    g.fillStyle = on ? color : 'rgba(255,255,255,0.06)';
    g.fillRect(x, y + h - (i + 1) * (h / segs) + 1, 16, h / segs - 2);
  }
  if (peakDb > -60) {
    g.fillStyle = '#ffffff';
    g.fillRect(x, y + h - ((peakDb + 60) / 60) * h, 16, 2);
  }
  g.fillStyle = '#a9aab1';
  g.font = '10px Archivo, system-ui, sans-serif';
  g.fillText(label, x, y + h + 14);
}

/** A knob at value 0..1 (read-only), with its label and value. */
export function knob(g: CanvasRenderingContext2D, cx: number, cy: number, v: number, label: string, text: string) {
  const r = 20;
  const grad = g.createRadialGradient(cx - 6, cy - 6, 2, cx, cy, r);
  grad.addColorStop(0, '#5b5e66');
  grad.addColorStop(1, '#25262a');
  g.fillStyle = grad;
  g.beginPath();
  g.arc(cx, cy, r, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = '#0c0d0f';
  g.lineWidth = 1.5;
  g.stroke();
  const a0 = Math.PI * 0.75;
  const a = a0 + Math.max(0, Math.min(1, v)) * Math.PI * 1.5;
  g.strokeStyle = 'rgba(125,255,176,0.35)';
  g.lineWidth = 3;
  g.beginPath();
  g.arc(cx, cy, r + 5, a0, a);
  g.stroke();
  g.strokeStyle = '#ffffff';
  g.lineWidth = 2.5;
  g.beginPath();
  g.moveTo(cx + Math.cos(a) * 6, cy + Math.sin(a) * 6);
  g.lineTo(cx + Math.cos(a) * (r - 3), cy + Math.sin(a) * (r - 3));
  g.stroke();
  g.textAlign = 'center';
  g.fillStyle = '#a9aab1';
  g.font = '10px Archivo, system-ui, sans-serif';
  g.fillText(label, cx, cy + r + 18);
  g.fillStyle = '#e6e7ea';
  g.font = '600 11px ui-monospace, monospace';
  g.fillText(text, cx, cy + r + 32);
  g.textAlign = 'left';
}
