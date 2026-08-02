// track-views.js
// Fetches daily profile-repo view counts from the GitHub Traffic API AND
// daily commit counts from the GitHub commits list, appends both to a
// persistent history file (Traffic API only keeps 14 days), and renders a
// dual-axis SVG chart:
//   - LEFT axis / navy smooth line + area  = daily profile VIEWS ("Berapa tamu")
//   - RIGHT axis / green background bars   = daily owner COMMITS ("Berapa commit")
// Commits are drawn as bars behind the views line (not a second line) so the
// two differently-scaled series never visually compete with each other -
// the right-edge axis + matching bar color acts as the legend.
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

function ghHeaders() {
  return {
    Authorization: `Bearer ${TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

async function fetchTraffic() {
  const res = await fetch(`https://api.github.com/repos/${REPO}/traffic/views`, { headers: ghHeaders() });
  if (!res.ok) {
    throw new Error(`GitHub Traffic API error ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

// Match what GitHub's own profile contribution graph counts: a commit only
// counts if it's authored by the account owner (attributed via their linked
// GitHub login) on the repo's default branch - which the commits list
// endpoint already returns by default. This naturally excludes the bot
// (its login isn't yours) and anyone else's commits too, without needing a
// separate bot-name check.
const OWNER_LOGIN = REPO ? REPO.split('/')[0] : undefined;

async function fetchOwnerCommits() {
  const commits = [];
  let page = 1;
  while (page <= 20) { // safety cap: 20 pages * 100 = 2000 commits
    const res = await fetch(`https://api.github.com/repos/${REPO}/commits?per_page=100&page=${page}`, { headers: ghHeaders() });
    if (!res.ok) {
      console.warn(`Commits API error ${res.status}, skipping commit data this run.`);
      return [];
    }
    const batch = await res.json();
    if (batch.length === 0) break;
    commits.push(...batch);
    if (batch.length < 100) break;
    page++;
  }
  return commits;
}

// Bucket commits by author-date (UTC), keeping only ones attributed to the
// repo owner's own GitHub account - same rule the profile tile uses.
function commitsToDailyMap(commits) {
  const map = new Map();
  for (const c of commits) {
    if (c.author?.login !== OWNER_LOGIN) continue;
    const dateStr = (c.commit?.author?.date || c.commit?.committer?.date || '').slice(0, 10);
    if (!dateStr) continue;
    map.set(dateStr, (map.get(dateStr) || 0) + 1);
  }
  return map;
}

function loadHistory() {
  if (!fs.existsSync(HISTORY_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function mergeHistory(existing, incomingTraffic, commitDailyMap = new Map()) {
  const byDate = new Map(existing.map((d) => [d.date, d]));
  for (const v of incomingTraffic.views) {
    const date = v.timestamp.slice(0, 10); // YYYY-MM-DD
    const prev = byDate.get(date);
    if (!prev || v.count > prev.count) {
      byDate.set(date, { date, count: v.count, uniques: v.uniques, commits: prev?.commits ?? 0 });
    }
  }
  for (const [date, entry] of byDate) {
    if (commitDailyMap.has(date)) {
      entry.commits = commitDailyMap.get(date);
    } else if (entry.commits === undefined) {
      entry.commits = 0;
    }
  }
  return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
}

// ---- Smooth curve helper (Catmull-Rom -> cubic Bezier) ----
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
const BASE_PADDING = { top: 30, right: 70, bottom: 50, left: 60 };
const MIN_WIDTH = 800;
const MAX_WIDTH = 6000;
const PX_PER_POINT = 5;

const VIEWS_COLOR = '#1F3958';
const COMMITS_COLOR = '#216e39'; // GitHub's own contribution-graph green

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
  const fontScale = width / MIN_WIDTH;

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
  const maxCommits = Math.max(...history.map((d) => d.commits || 0), 1);
  const totalViews = history.reduce((s, d) => s + d.count, 0);
  const totalCommits = history.reduce((s, d) => s + (d.commits || 0), 0);

  const xFor = (i) => PADDING.left + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const yForScaled = (v, maxVal) => PADDING.top + plotH - (v / maxVal) * plotH;
  const yFor = (v) => yForScaled(v, maxCount);
  const yForCommits = (v) => yForScaled(v, maxCommits);
  const baselineY = PADDING.top + plotH;

  const slot = n > 1 ? plotW / (n - 1) : plotW;
  const commitBarWidth = Math.max(1, Math.min(slot * 0.5, 8 * fontScale));
  const commitBars = history
    .map((d, i) => {
      const val = d.commits || 0;
      if (val === 0) return '';
      const x = xFor(i);
      const yTop = yForCommits(val);
      const h = Math.max(0.5, baselineY - yTop);
      return `<rect x="${(x - commitBarWidth / 2).toFixed(1)}" y="${yTop.toFixed(1)}" width="${commitBarWidth.toFixed(1)}" height="${h.toFixed(1)}" fill="${COMMITS_COLOR}" fill-opacity="0.55"><title>${d.date}: ${val} commit${val === 1 ? '' : 's'}</title></rect>`;
    })
    .join('\n');

  const points = history.map((d, i) => ({ x: xFor(i), y: yFor(d.count), date: d.date, count: d.count }));
  const linePath = smoothPath(points, baselineY);
  const areaPath = n > 1
    ? `${linePath} L ${points[n - 1].x.toFixed(1)} ${baselineY.toFixed(1)} L ${points[0].x.toFixed(1)} ${baselineY.toFixed(1)} Z`
    : '';

  const showDots = n <= 120;
  const dotR = 2.5 * fontScale;
  const dots = showDots
    ? points.map((p) => `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${dotR.toFixed(1)}" fill="${VIEWS_COLOR}"><title>${p.date}: ${p.count} views</title></circle>`).join('\n')
    : '';

  const maxLabels = Math.max(4, Math.floor(width / (80 * fontScale)));
  const labelStep = Math.max(1, Math.ceil(n / maxLabels));
  const axisFont = (11 * fontScale).toFixed(1);
  const xLabels = history
    .map((d, i) => (i % labelStep === 0 || i === n - 1
      ? `<text x="${xFor(i).toFixed(1)}" y="${(svgHeight - PADDING.bottom + 20 * fontScale).toFixed(1)}" font-family="sans-serif" font-size="${axisFont}" fill="#666" text-anchor="middle">${d.date.slice(5)}</text>`
      : ''))
    .join('\n');

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

  const rightAxisX = (width - PADDING.right + 14 * fontScale).toFixed(1);
  const rightAxisTitle = `<text x="${rightAxisX}" y="${(PADDING.top + plotH / 2).toFixed(1)}" font-family="sans-serif" font-size="${axisFont}" fill="${COMMITS_COLOR}" text-anchor="middle" transform="rotate(-90 ${rightAxisX} ${(PADDING.top + plotH / 2).toFixed(1)})">Berapa commit</text>`;
  const rightAxisMaxTick = `<text x="${(width - PADDING.right + 6 * fontScale).toFixed(1)}" y="${(PADDING.top + 4 * fontScale).toFixed(1)}" font-family="sans-serif" font-size="${axisFont}" fill="${COMMITS_COLOR}" text-anchor="start">Max ${maxCommits}</text>`;

  const titleFont = (15 * fontScale).toFixed(1);
  const subtitleFont = (12 * fontScale).toFixed(1);
  const strokeWidth = (2.5 * fontScale).toFixed(2);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${svgHeight.toFixed(1)}" viewBox="0 0 ${width} ${svgHeight.toFixed(1)}">
  <text x="${PADDING.left.toFixed(1)}" y="${(18 * fontScale).toFixed(1)}" font-family="sans-serif" font-weight="600" font-size="${titleFont}" fill="${VIEWS_COLOR}">Berapa tamu</text>
  <text x="${(width - PADDING.right).toFixed(1)}" y="${(18 * fontScale).toFixed(1)}" font-family="sans-serif" font-size="${subtitleFont}" fill="#57606a" text-anchor="end">Views ${totalViews.toLocaleString()} · Commits ${totalCommits.toLocaleString()} · ${n} days</text>
  ${gridLines}
  ${commitBars}
  ${areaPath ? `<path d="${areaPath}" fill="${VIEWS_COLOR}" fill-opacity="0.08" stroke="none"/>` : ''}
  <path d="${linePath}" fill="none" stroke="${VIEWS_COLOR}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round"/>
  ${dots}
  ${xLabels}
  ${rightAxisMaxTick}
  ${rightAxisTitle}
</svg>`;
}

async function main() {
  if (!TOKEN || !REPO) {
    console.error('Missing GH_TOKEN or GH_REPOSITORY environment variable.');
    process.exit(1);
  }
  const [traffic, commits] = await Promise.all([fetchTraffic(), fetchOwnerCommits()]);
  console.log('DEBUG OWNER_LOGIN:', OWNER_LOGIN);
  console.log('DEBUG fetched commits count:', commits.length);
  console.log('DEBUG sample commit logins:', commits.slice(0, 5).map((c) => c.author?.login));
  
  const commitDailyMap = commitsToDailyMap(commits);
  const existing = loadHistory();
  const merged = mergeHistory(existing, traffic, commitDailyMap);

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(merged, null, 2));
  fs.writeFileSync(CHART_FILE, renderChart(merged));

  console.log(`History now has ${merged.length} daily entries.`);
  console.log(`Chart width: ${computeWidth(merged.length)}px`);
  console.log(`Total views recorded: ${merged.reduce((s, d) => s + d.count, 0)}`);
  console.log(`Total commits recorded: ${merged.reduce((s, d) => s + (d.commits || 0), 0)}`);
}

module.exports = {
  mergeHistory, loadHistory, renderChart, computeWidth, smoothPath, percentile, commitsToDailyMap,
};

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
