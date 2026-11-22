/**
 * Score → PDF: engrave the ABC off-screen with one SVG per system (abcjs
 * oneSvgPerLine), place the systems on A4 pages as vector graphics (jsPDF +
 * svg2pdf.js) with a header and page numbers, and download the file. The
 * PDF libraries load only when a PDF is made.
 */

import abcjs from 'abcjs';

const PAGE_W = 595.28; // A4, points
const PAGE_H = 841.89;
const MARGIN = 42;
const SYSTEM_GAP = 6;

export async function downloadScorePdf(abc: string, opts: { fileName: string; heading: string; subheading: string }): Promise<void> {
  const [{ jsPDF }] = await Promise.all([import('jspdf'), import('svg2pdf.js')]);
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-10000px;top:0;width:820px;background:#fff';
  document.body.appendChild(host);
  try {
    abcjs.renderAbc(host, abc, {
      oneSvgPerLine: true,
      staffwidth: 760,
      wrap: { minSpacing: 1.6, maxSpacing: 2.6, preferredMeasuresPerLine: 4 },
      format: { stretchlast: 1 },
      paddingtop: 6,
      paddingbottom: 6,
      paddingleft: 6,
      paddingright: 6,
      foregroundColor: '#000000',
    });
    const systems = [...host.querySelectorAll('svg')];
    if (systems.length === 0) throw new Error('abcjs drew no score to print');

    const doc = new jsPDF({ unit: 'pt', format: 'a4' });
    const contentW = PAGE_W - MARGIN * 2;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(15);
    doc.text(opts.heading, MARGIN, MARGIN + 4);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.setTextColor(90);
    doc.text(opts.subheading, MARGIN, MARGIN + 20);
    doc.setTextColor(0);
    let y = MARGIN + 34;
    for (const svg of systems) {
      const box = svg.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      const h = (box.height * contentW) / box.width;
      if (y + h > PAGE_H - MARGIN - 14) {
        doc.addPage();
        y = MARGIN;
      }
      await doc.svg(svg, { x: MARGIN, y, width: contentW, height: h });
      y += h + SYSTEM_GAP;
    }
    const pages = doc.getNumberOfPages();
    for (let i = 1; i <= pages; i++) {
      doc.setPage(i);
      doc.setFontSize(8);
      doc.setTextColor(120);
      doc.text(`${opts.heading} · page ${i} of ${pages} · casperaki`, PAGE_W / 2, PAGE_H - MARGIN / 2, { align: 'center' });
    }
    doc.save(opts.fileName);
  } finally {
    host.remove();
  }
}
