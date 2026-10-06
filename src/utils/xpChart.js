// XP-over-time chart helpers for /level check.
// XP history is stored on each level doc as `xpByDay`: a map of
// 'YYYY-MM-DD' (UTC) -> cumulative total XP at the end of that day.

const XP_HISTORY_DAYS = 30;

function dayKeyUTC(timestampMs) {
  return new Date(timestampMs).toISOString().slice(0, 10);
}

// Returns [{ day, xp }] sorted ascending, capped to the last XP_HISTORY_DAYS.
// Today's point is always (re)written with the current totalXP so the chart
// ends at the true value even before today's award writes back.
function buildXPChartPoints(data, totalXP, now = Date.now()) {
  const byDay = new Map();
  const xpByDay = data && typeof data.xpByDay === 'object' && data.xpByDay !== null
    ? data.xpByDay
    : {};
  for (const [day, xp] of Object.entries(xpByDay)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    if (!Number.isFinite(xp) || xp < 0) continue;
    byDay.set(day, xp);
  }
  byDay.set(dayKeyUTC(now), totalXP);
  return [...byDay.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .slice(-XP_HISTORY_DAYS)
    .map(([day, xp]) => ({ day, xp }));
}

// SVG with no <text> elements: the production image (node:20-slim) ships no
// fontconfig fonts, so librsvg text would render blank. Axis context lives in
// the embed footer instead.
function renderXPChartSVG(points, { width = 640, height = 240 } = {}) {
  const pad = { top: 16, right: 16, bottom: 16, left: 16 };
  const w = width - pad.left - pad.right;
  const h = height - pad.top - pad.bottom;

  const xps = points.map(p => p.xp);
  const min = Math.min(...xps);
  const max = Math.max(...xps);
  const span = max - min || 1;
  const lo = Math.max(0, min - span * 0.1);
  const hi = max + span * 0.1;

  const x = (i) => pad.left + (points.length === 1 ? w / 2 : (i / (points.length - 1)) * w);
  const y = (v) => pad.top + h - ((v - lo) / (hi - lo)) * h;

  const coords = points.map((p, i) => [x(i), y(p.xp)]);
  const line = coords.map(([cx, cy]) => `${cx.toFixed(1)},${cy.toFixed(1)}`).join(' ');
  const area = `${pad.left},${pad.top + h} ${line} ${pad.left + w},${pad.top + h}`;

  const gridLines = [];
  for (let i = 1; i <= 3; i++) {
    const gy = (pad.top + (h * i) / 4).toFixed(1);
    gridLines.push(
      `<line x1="${pad.left}" y1="${gy}" x2="${pad.left + w}" y2="${gy}" stroke="#3f4147" stroke-width="1"/>`,
    );
  }

  const dots = coords
    .map(([cx, cy]) => `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="3" fill="#5865f2"/>`)
    .join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`
    + `<rect width="${width}" height="${height}" rx="8" fill="#2b2d31"/>`
    + gridLines.join('')
    + `<polygon points="${area}" fill="#5865f2" opacity="0.18"/>`
    + `<polyline points="${line}" fill="none" stroke="#5865f2" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>`
    + dots
    + '</svg>';
}

// Lazy-required so tests and non-chart paths never load the sharp binary.
async function renderXPChartPNG(points) {
  const sharp = require('sharp');
  const svg = renderXPChartSVG(points);
  return sharp(Buffer.from(svg)).png().toBuffer();
}

module.exports = { XP_HISTORY_DAYS, dayKeyUTC, buildXPChartPoints, renderXPChartSVG, renderXPChartPNG };
