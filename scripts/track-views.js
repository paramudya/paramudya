// track-views.js
// Fetches daily profile-repo view counts from the GitHub Traffic API,
// appends them to a persistent history file (since GitHub only keeps 14 days),
// and renders an SVG line chart of total views over time.
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

if (!TOKEN || !REPO) {
  console.error('Missing GH_TOKEN or GH_REPOSITORY environment variable.');
  process.exit(1);
}

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
  // incoming.views: [{ timestamp: '2026-07-20T00:00:00Z', count, uniques }, ...]
  const byDate = new Map(existing.map((d) => [d.date, d]));
  for (const v of incoming.views) {
    const date = v.timestamp.slice(0, 10); // YYYY-MM-DD
    // Only overwrite if we don't already have this date, OR the API's count
    // for it is higher (in case the same day gets refreshed with more views).
    const prev = byDate.get(date);
    if (!prev || v.count > prev.count) {
      byDate.set(date, { date, count: v.count, uniques: v.uniques });
    }
  }
  return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
}

function renderChart(history) {
  const width = 800;
  const height = 300;
  const padding = { top: 30, right: 30, bottom: 50, left: 60 };
  const plotW = width - padding.left - padding.right;
  const plotH = height - padding.top - padding.bottom;

  if (history.length === 0) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="120">
      <text x="20" y="60" font-family="sans-serif" font-size="16" fill="#666">No data yet — check back after the next run.</text>
    </svg>`;
  }

  // Running cumulative total, since Traffic API gives per-day counts.
  let cumulative = 0;
  const points = history.map((d) => {
    cumulative += d.count;
    return { date: d.date, daily: d.count, total: cumulative };
  });

  const maxTotal = Math.max(...points.map((p) => p.total), 1);
  const n = points.length;

  const xFor = (i) => padding.left + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const yFor = (v) => padding.top + plotH - (v / maxTotal) * plotH;

  const linePath = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${xFor(i).toFixed(1)} ${yFor(p.total).toFixed(1)}`)
    .join(' ');

  const areaPath = `${linePath} L ${xFor(n - 1).toFixed(1)} ${(padding.top + plotH).toFixed(1)} L ${xFor(0).toFixed(1)} ${(padding.top + plotH).toFixed(1)} Z`;

  // X-axis labels: show at most ~6 evenly spaced dates.
  const labelStep = Math.max(1, Math.ceil(n / 6));
  const xLabels = points
    .map((p, i) => (i % labelStep === 0 || i === n - 1 ? `<text x="${xFor(i).toFixed(1)}" y="${height - padding.bottom + 20}" font-family="sans-serif" font-size="11" fill="#666" text-anchor="middle">${p.date.slice(5)}</text>` : ''))
    .join('\n');

  // Y-axis gridlines/labels (4 bands)
  const bands = 4;
  let gridLines = '';
  for (let i = 0; i <= bands; i++) {
    const val = Math.round((maxTotal / bands) * i);
    const y = yFor(val);
    gridLines += `<line x1="${padding.left}" y1="${y.toFixed(1)}" x2="${width - padding.right}" y2="${y.toFixed(1)}" stroke="#e5e5e5" stroke-width="1"/>`;
    gridLines += `<text x="${padding.left - 10}" y="${(y + 4).toFixed(1)}" font-family="sans-serif" font-size="11" fill="#666" text-anchor="end">${val}</text>`;
  }

  const latestTotal = points[points.length - 1].total;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <style>
    .title { font: 600 15px sans-serif; fill: #24292f; }
    .subtitle { font: 400 12px sans-serif; fill: #57606a; }
  </style>
  <rect width="${width}" height="${height}" fill="#ffffff"/>
  <text x="${padding.left}" y="18" class="title">Profile Views Over Time</text>
  <text x="${width - padding.right}" y="18" class="subtitle" text-anchor="end">Total: ${latestTotal.toLocaleString()}</text>
  ${gridLines}
  <path d="${areaPath}" fill="#0969da" fill-opacity="0.08" stroke="none"/>
  <path d="${linePath}" fill="none" stroke="#0969da" stroke-width="2.5"/>
  ${points.map((p, i) => `<circle cx="${xFor(i).toFixed(1)}" cy="${yFor(p.total).toFixed(1)}" r="2.5" fill="#0969da"/>`).join('\n')}
  ${xLabels}
</svg>`;
}

async function main() {
  const traffic = await fetchTraffic();
  const existing = loadHistory();
  const merged = mergeHistory(existing, traffic);

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(merged, null, 2));
  fs.writeFileSync(CHART_FILE, renderChart(merged));

  console.log(`History now has ${merged.length} daily entries.`);
  console.log(`Latest cumulative total: ${merged.reduce((s, d) => s + d.count, 0)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
