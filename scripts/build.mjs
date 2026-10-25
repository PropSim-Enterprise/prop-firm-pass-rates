// Fetches the PropSim Prop Trading Index feed and writes this dataset: the full
// JSON, tidy CSVs, SVG charts and the "latest week" table in README.md.
//   node scripts/build.mjs            (Node 20+, no dependencies)
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const FEED = "https://propsim.markets/prop-trading-index/data.json";
const ROOT = path.resolve(import.meta.dirname, "..");
const out = (file) => path.join(ROOT, file);

/* ── Fetch and check ────────────────────────────────────────────────── */

async function fetchFeed() {
  const res = await fetch(FEED, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${FEED} answered ${res.status}`);
  const feed = await res.json();
  if (!Array.isArray(feed.snapshots) || feed.snapshots.length === 0) {
    throw new Error("The feed has no snapshots; refusing to overwrite the dataset.");
  }
  return feed;
}

const byWeek = (a, b) => a.weekOf.localeCompare(b.weekOf);

/* ── Flatten ────────────────────────────────────────────────────────── */

/** Every numeric metric as [dotted.path, value]. Labels and nulls are skipped. */
function flatten(value, prefix = "") {
  if (typeof value === "number") return [[prefix, value]];
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([k, v]) => flatten(v, prefix ? `${prefix}.${k}` : k));
}

const at = (metrics, dotted) =>
  dotted.split(".").reduce((node, key) => (node == null ? undefined : node[key]), metrics);

/* ── CSV ────────────────────────────────────────────────────────────── */

const cell = (v) => (v == null ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));

function writeCsv(file, header, rows) {
  const text = [header, ...rows].map((r) => r.map(cell).join(",")).join("\n");
  writeFileSync(out(file), `${text}\n`);
}

const SUMMARY_COLUMNS = [
  ["phase1_clear_rate_pct", "phase1ClearRatePct"],
  ["phase2_clear_rate_pct", "phase2ClearRatePct"],
  ["days_to_clear_p25", "daysToClear.p25"],
  ["days_to_clear_median", "daysToClear.median"],
  ["days_to_clear_p75", "daysToClear.p75"],
  ["median_account_size", "challengeDesign.medianAccountSize"],
  ["median_profit_split_pct", "challengeDesign.medianProfitSplitPct"],
  ["median_max_duration_days", "challengeDesign.medianMaxDurationDays"],
  ["median_leverage", "challengeDesign.medianLeverage"],
  ["win_rate_all_pct", "tradingDiscipline.winRatePct.all"],
  ["win_rate_cleared_pct", "tradingDiscipline.winRatePct.cleared"],
  ["win_rate_failed_pct", "tradingDiscipline.winRatePct.failed"],
  ["payoff_ratio_cleared", "tradingDiscipline.payoffRatio.cleared"],
  ["payoff_ratio_failed", "tradingDiscipline.payoffRatio.failed"],
  ["median_lifespan_days", "survival.medianLifespanDays"],
  ["retry_rate_pct", "retry.retryRatePct"],
];

function writeCsvs(weeks) {
  writeCsv(
    "data/weekly-summary.csv",
    ["week_of", ...SUMMARY_COLUMNS.map(([name]) => name)],
    weeks.map((w) => [w.weekOf, ...SUMMARY_COLUMNS.map(([, p]) => at(w.metrics, p))]),
  );
  writeCsv(
    "data/metrics-long.csv",
    ["week_of", "metric", "value"],
    weeks.flatMap((w) => flatten(w.metrics).map(([metric, value]) => [w.weekOf, metric, value])),
  );
  writeCsv(
    "data/failure-causes.csv",
    ["week_of", "rule", "share_of_failed_accounts_pct"],
    weeks.flatMap((w) => Object.entries(w.metrics.terminalBreachMixPct ?? {}).map(([rule, pct]) => [w.weekOf, rule, pct])),
  );
  writeCsv(
    "data/survival.csv",
    ["week_of", "day", "still_open_pct"],
    weeks.flatMap((w) =>
      Object.entries(at(w.metrics, "survival.stillOpenPct") ?? {}).map(([day, pct]) => [w.weekOf, Number(day.replace("day", "")), pct]),
    ),
  );
}

/* ── Charts (plain SVG, white background so they read in dark mode too) ── */

const W = 760, H = 380, PAD = { l: 56, r: 24, t: 48, b: 56 };
const COLORS = ["#2547f4", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6"];
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");

function frame(title, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="Segoe UI, Helvetica, Arial, sans-serif">
<rect width="${W}" height="${H}" rx="12" fill="#ffffff"/>
<text x="${PAD.l}" y="30" font-size="17" font-weight="700" fill="#0e1324">${esc(title)}</text>
${body}
<text x="${W - PAD.r}" y="${H - 10}" font-size="11" fill="#8a93a8" text-anchor="end">Source: PropSim Prop Trading Index · CC BY 4.0</text>
</svg>
`;
}

function yAxis(max, unit) {
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => {
    const y = H - PAD.b - f * (H - PAD.t - PAD.b);
    return `<line x1="${PAD.l}" x2="${W - PAD.r}" y1="${y}" y2="${y}" stroke="#e8ebf2"/><text x="${PAD.l - 8}" y="${y + 4}" font-size="11" fill="#566079" text-anchor="end">${Math.round(f * max)}${unit}</text>`;
  });
  return ticks.join("\n");
}

/** A line chart: x labels, and series of { name, values } (null = gap). */
function lineChart(title, labels, series, max, unit) {
  const x = (i) => PAD.l + (labels.length === 1 ? 0.5 : i / (labels.length - 1)) * (W - PAD.l - PAD.r);
  const y = (v) => H - PAD.b - (v / max) * (H - PAD.t - PAD.b);
  const xLabels = labels.map((l, i) => `<text x="${x(i)}" y="${H - PAD.b + 18}" font-size="11" fill="#566079" text-anchor="middle">${esc(l)}</text>`);
  const lines = series.map((s, n) => {
    const pts = s.values.map((v, i) => (v == null ? null : [x(i), y(v)])).filter(Boolean);
    const color = COLORS[n % COLORS.length];
    const dots = pts.map(([px, py]) => `<circle cx="${px}" cy="${py}" r="3.5" fill="${color}"/>`).join("");
    const legend = `<rect x="${PAD.l + n * 150}" y="${H - 24}" width="10" height="10" rx="2" fill="${color}"/><text x="${PAD.l + n * 150 + 16}" y="${H - 15}" font-size="12" fill="#0e1324">${esc(s.name)}</text>`;
    return `<polyline points="${pts.map((p) => p.join(",")).join(" ")}" fill="none" stroke="${color}" stroke-width="2.5"/>${dots}${legend}`;
  });
  return frame(title, [yAxis(max, unit), ...xLabels, ...lines].join("\n"));
}

function barChart(title, entries) {
  const rowH = (H - PAD.t - 40) / Math.max(entries.length, 1);
  const left = 220, max = Math.max(...entries.map(([, v]) => v), 1);
  const bars = entries.map(([label, v], i) => {
    const y = PAD.t + i * rowH + 6, w = (v / max) * (W - left - 90);
    return `<text x="${left - 10}" y="${y + rowH / 2}" font-size="12" fill="#0e1324" text-anchor="end">${esc(label)}</text><rect x="${left}" y="${y + rowH / 2 - 11}" width="${w}" height="18" rx="4" fill="${COLORS[0]}"/><text x="${left + w + 8}" y="${y + rowH / 2 + 3}" font-size="12" fill="#566079">${v}%</text>`;
  });
  return frame(title, bars.join("\n"));
}

const RULE_LABELS = {
  MAX_DAILY_LOSS: "Daily loss limit",
  MAX_OVERALL_LOSS: "Maximum loss",
  TRAILING_DRAWDOWN: "Trailing drawdown",
  INACTIVITY_MAX_DAYS: "Time limit / inactivity",
  MAX_LOTS: "Maximum lot size",
};
const ruleLabel = (code) => RULE_LABELS[code] ?? code.toLowerCase().replace(/_/g, " ");

/** The smallest round scale above the data, so the four gridlines land on whole numbers. */
const scaleFor = (values) =>
  [20, 40, 60, 80, 100].find((s) => s >= Math.max(...values.filter((v) => v != null)) * 1.1) ?? 100;

function writeCharts(weeks) {
  const latest = weeks.at(-1);
  const labels = weeks.map((w) => w.weekOf.slice(5));
  const phase1 = weeks.map((w) => w.metrics.phase1ClearRatePct ?? null);
  const phase2 = weeks.map((w) => w.metrics.phase2ClearRatePct ?? null);
  writeFileSync(
    out("charts/pass-rates.svg"),
    lineChart("Prop firm challenge pass rates by week (%)", labels, [
      { name: "Phase 1 cleared", values: phase1 },
      { name: "Phase 2 cleared", values: phase2 },
    ], scaleFor([...phase1, ...phase2]), "%"),
  );
  const causes = Object.entries(latest.metrics.terminalBreachMixPct ?? {}).sort((a, b) => b[1] - a[1]);
  writeFileSync(
    out("charts/failure-causes.svg"),
    barChart(`Why challenges fail: share of failed accounts, week of ${latest.weekOf}`, causes.map(([c, v]) => [ruleLabel(c), v])),
  );
  const open = Object.entries(at(latest.metrics, "survival.stillOpenPct") ?? {});
  writeFileSync(
    out("charts/survival.svg"),
    lineChart(`Challenge accounts still open after N days (%), week of ${latest.weekOf}`, open.map(([d]) => `day ${d.replace("day", "")}`), [
      { name: "Still open", values: open.map(([, v]) => v) },
    ], 100, "%"),
  );
}

/* ── README latest-week table ───────────────────────────────────────── */

const pct = (v) => (v == null ? "not published" : `${v}%`);
const num = (v, unit = "") => (v == null ? "not published" : `${v.toLocaleString("en-US")}${unit}`);
const money = (v) => (v == null ? "not published" : `$${v.toLocaleString("en-US")}`);

function latestRows(m) {
  const causes = Object.entries(m.terminalBreachMixPct ?? {}).sort((a, b) => b[1] - a[1]);
  const top = causes[0];
  return [
    ["Phase 1 pass rate", pct(m.phase1ClearRatePct)],
    ["Phase 2 pass rate (of those who reached it)", pct(m.phase2ClearRatePct)],
    ["Median days to clear a phase", num(at(m, "daysToClear.median"), " days")],
    ["Most common reason a challenge fails", top ? `${ruleLabel(top[0])} (${top[1]}% of failed accounts)` : "not published"],
    ["Accounts still open after 30 days", pct(at(m, "survival.stillOpenPct.day30"))],
    ["Traders who buy another attempt", pct(at(m, "retry.retryRatePct"))],
    ["Win rate: cleared vs failed accounts", `${pct(at(m, "tradingDiscipline.winRatePct.cleared"))} vs ${pct(at(m, "tradingDiscipline.winRatePct.failed"))}`],
    ["Median account size", money(at(m, "challengeDesign.medianAccountSize"))],
    ["Median profit split", pct(at(m, "challengeDesign.medianProfitSplitPct"))],
  ];
}

function updateReadme(latest) {
  const file = out("README.md");
  const table = [
    `**Week of ${latest.weekOf}**`,
    "",
    "| Metric | Value |",
    "|---|---|",
    ...latestRows(latest.metrics).map(([k, v]) => `| ${k} | ${v} |`),
  ].join("\n");
  // A replacer function, so "$" in the table (prices) is never read as a back-reference.
  const readme = readFileSync(file, "utf8").replace(
    /(<!-- latest:start -->)[\s\S]*?(<!-- latest:end -->)/,
    (_, start, end) => `${start}\n${table}\n${end}`,
  );
  writeFileSync(file, readme);
}

/* ── Run ────────────────────────────────────────────────────────────── */

const feed = await fetchFeed();
const weeks = [...feed.snapshots].sort(byWeek);
writeFileSync(out("data/prop-trading-index.json"), `${JSON.stringify(feed, null, 2)}\n`);
writeCsvs(weeks);
writeCharts(weeks);
updateReadme(weeks.at(-1));
console.log(`Dataset updated: ${weeks.length} weeks, latest ${weeks.at(-1).weekOf}.`);
