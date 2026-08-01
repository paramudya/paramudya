// track-views.js
// Fetches daily profile-repo view counts from the GitHub Traffic API,
// appends them to a persistent history file (since GitHub only keeps 14 days),
// and renders a smooth, transparent-background SVG line chart of daily
// views over time.
//
// The chart WIDTH grows as history grows (instead of squeezing points
// together), so individual days stay distinguishable even after hundreds
// of days. Because a wide chart gets scaled DOWN by the browser to fit a
// README's column width, font/stroke sizes are pre-scaled UP in proportion
// to the width so they land back at a consistent apparent size on screen
// no matter how long the history gets.
//
// Requires: Node.js 18+ (built-in fetch), a GH_TOKEN env var with repo scope,
// and a GH_REPOSITORY env var in "owner/repo" form.

const fs = require('fs');
const path = require('path');

const TOKEN = process.env.GH_TOKEN;
const REPO = process.env.GH_REPOSITORY; // e.g. "octocat/octocat"
const DATA_DIR = path.join(__dirname, '..', 'data');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const CHART_FILE = path.join(DATA_DIR, 'chart.svg');

async function fetchTraffic() {
  const res = await fetch(`https://api.github.com/repos/${REPO}/traffic/views`, {
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub API error ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

function loadHistory() {
  if (!fs.existsSync(HISTORY_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function mergeHistory(existing, incoming) {
  const byDate = new Map(existing.map((d) => [d.date, d]));
  for (const v of incoming.views) {
    const date = v.timestamp.slice(0, 10); // YYYY-MM-DD
    const prev = byDate.get(date);
    if (!prev || v.count > prev.count) {
      byDate.set(date, { date, count: v.count, uniques: v.uniques });
    }
  }
  return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
}

// ---- Smooth curve helper (Catmull-Rom -> cubic Bezier) ----
// `floorY` is the y-coordinate of value 0 (the baseline). Since a cubic
// Bezier curve always stays within the convex hull of its 4 control points,
// clamping both control points to never exceed the baseline guarantees the
// rendered curve can approach zero smoothly but never overshoots past it
// into visually "negative" territory - even though the underlying spline
// math would otherwise dip below zero right around low points near a spike.
function smoothPath(points, floorY = Infinity) {
  if (points.length === 0) return '';
  if (points.length === 1) return `M ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`;

  let d = `M ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] || points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] || p2;

    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = Math.min(p1.y + (p2.y - p0.y) / 6, floorY);
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = Math.min(p2.y - (p3.y - p1.y) / 6, floorY);

    d += ` C ${cp1x.toFixed(1)} ${cp1y.toFixed(1)}, ${cp2x.toFixed(1)} ${cp2y.toFixed(1)}, ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
  }
  return d;
}

function percentile(sortedArr, p) {
  if (sortedArr.length === 0) return 0;
  const idx = (p / 100) * (sortedArr.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedArr[lo];
  const frac = idx - lo;
  return sortedArr[lo] + (sortedArr[hi] - sortedArr[lo]) * frac;
}

// ---- Chart sizing ----
const HEIGHT = 300;
const BASE_PADDING = { top: 30, right: 30, bottom: 50, left: 60 };
const MIN_WIDTH = 800;   // also the "baseline" width font-scaling is relative to
const MAX_WIDTH = 6000;
const PX_PER_POINT = 5;

function computeWidth(n) {
  const target = BASE_PADDING.left + BASE_PADDING.right + n * PX_PER_POINT;
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, target));
}

function renderChart(history) {
  if (history.length === 0) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${MIN_WIDTH}" height="120">
      <text x="20" y="60" font-family="sans-serif" font-size="16" fill="#666">No data yet — check back after the next run.</text>
    </svg>`;
  }

  const n = history.length;
  const width = computeWidth(n);

  const fontScale = width / MIN_WIDTH; // always >= 1

  const PADDING = {
    top: BASE_PADDING.top * fontScale,
    right: BASE_PADDING.right * fontScale,
    bottom: BASE_PADDING.bottom * fontScale,
    left: BASE_PADDING.left * fontScale,
  };
  const plotW = width - PADDING.left - PADDING.right;
  const plotH = HEIGHT * fontScale - PADDING.top - PADDING.bottom;
  const svgHeight = HEIGHT * fontScale;

  const maxCount = Math.max(...history.map((d) => d.count), 1);
  const totalViews = history.reduce((s, d) => s + d.count, 0);

  const xFor = (i) => PADDING.left + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const yFor = (v) => PADDING.top + plotH - (v / maxCount) * plotH;

  const points = history.map((d, i) => ({ x: xFor(i), y: yFor(d.count), date: d.date, count: d.count }));

  const baselineY = PADDING.top + plotH; // y-coordinate of value 0
  const linePath = smoothPath(points, baselineY);
  const areaPath = n > 1
    ? `${linePath} L ${points[n - 1].x.toFixed(1)} ${(PADDING.top + plotH).toFixed(1)} L ${points[0].x.toFixed(1)} ${(PADDING.top + plotH).toFixed(1)} Z`
    : '';

  const showDots = n <= 120;
  const dotR = 2.5 * fontScale;
  const dots = showDots
    ? points.map((p) => `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${dotR.toFixed(1)}" fill="#1F3958"><title>${p.date}: ${p.count} views</title></circle>`).join('\n')
    : '';

  const maxLabels = Math.max(4, Math.floor(width / (80 * fontScale)));
  const labelStep = Math.max(1, Math.ceil(n / maxLabels));
  const axisFont = (11 * fontScale).toFixed(1);
  const xLabels = history
    .map((d, i) => (i % labelStep === 0 || i === n - 1
      ? `<text x="${xFor(i).toFixed(1)}" y="${(svgHeight - PADDING.bottom + 20 * fontScale).toFixed(1)}" font-family="sans-serif" font-size="${axisFont}" fill="#666" text-anchor="middle">${d.date.slice(5)}</text>`
      : ''))
    .join('\n');

  // Only three reference lines: median, 75th percentile, and the top (max).
  // If two of them round to the same value, their lines/labels would sit on
  // top of each other - keep just one in priority order: Max > Median > P75.
  const sortedCounts = [...history.map((d) => d.count)].sort((a, b) => a - b);
  const median = percentile(sortedCounts, 50);
  const p75 = percentile(sortedCounts, 75);
  const candidates = [
    { label: 'Max', value: maxCount },
    { label: 'Median', value: median },
    { label: 'P75', value: p75 },
  ];
  const seenValues = new Set();
  const refLines = candidates.filter((c) => {
    const key = Math.round(c.value);
    if (seenValues.has(key)) return false;
    seenValues.add(key);
    return true;
  });
  const gridLines = refLines
    .map((r) => {
      const y = yFor(r.value);
      return `<line x1="${PADDING.left}" y1="${y.toFixed(1)}" x2="${width - PADDING.right}" y2="${y.toFixed(1)}" stroke="#cfd6dc" stroke-width="${(1 * fontScale).toFixed(2)}" stroke-dasharray="${(4 * fontScale).toFixed(1)} ${(3 * fontScale).toFixed(1)}"/>` +
        `<text x="${(PADDING.left - 10 * fontScale).toFixed(1)}" y="${(y + 4 * fontScale).toFixed(1)}" font-family="sans-serif" font-size="${axisFont}" fill="#666" text-anchor="end">${r.label} ${Math.round(r.value)}</text>`;
    })
    .join('\n');

  const titleFont = (15 * fontScale).toFixed(1);
  const subtitleFont = (12 * fontScale).toFixed(1);
  const strokeWidth = (2.5 * fontScale).toFixed(2);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${svgHeight.toFixed(1)}" viewBox="0 0 ${width} ${svgHeight.toFixed(1)}">
  <text x="${PADDING.left.toFixed(1)}" y="${(18 * fontScale).toFixed(1)}" font-family="sans-serif" font-weight="600" font-size="${titleFont}" fill="#24292f">Berapa tamu</text>
  <text x="${(width - PADDING.right).toFixed(1)}" y="${(18 * fontScale).toFixed(1)}" font-family="sans-serif" font-size="${subtitleFont}" fill="#57606a" text-anchor="end">Total: ${totalViews.toLocaleString()} · ${n} days tracked</text>
  ${gridLines}
  ${areaPath ? `<path d="${areaPath}" fill="#1F3958" fill-opacity="0.08" stroke="none"/>` : ''}
  <path d="${linePath}" fill="none" stroke="#1F3958" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round"/>
  ${dots}
  ${xLabels}
</svg>`;
}

async function main() {
  if (!TOKEN || !REPO) {
    console.error('Missing GH_TOKEN or GH_REPOSITORY environment variable.');
    process.exit(1);
  }
  const traffic = await fetchTraffic();
  const existing = loadHistory();
  const merged = mergeHistory(existing, traffic);

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(merged, null, 2));
  fs.writeFileSync(CHART_FILE, renderChart(merged));

  console.log(`History now has ${merged.length} daily entries.`);
  console.log(`Chart width: ${computeWidth(merged.length)}px`);
  console.log(`Total views recorded: ${merged.reduce((s, d) => s + d.count, 0)}`);
}

module.exports = { mergeHistory, loadHistory, renderChart, computeWidth, smoothPath, percentile };

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
