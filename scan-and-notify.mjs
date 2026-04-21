#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import process from 'node:process';
import yaml from 'js-yaml';
import { sendTelegramMessage } from './telegram-notify.mjs';

const execFileAsync = promisify(execFile);

const ROOT = process.cwd();
const DATA_DIR = resolve(ROOT, 'data');
const CACHE_DIR = resolve(ROOT, '.cache');
const SCAN_HISTORY_PATH = resolve(DATA_DIR, 'scan-history.tsv');
const PIPELINE_PATH = resolve(DATA_DIR, 'pipeline.md');
const PROFILE_PATH = resolve(ROOT, 'config/profile.yml');
const STATE_PATH = resolve(ROOT, process.env.SCAN_NOTIFY_STATE_PATH || '.cache/scan-notify-state.json');
const MAX_MESSAGE_OFFERS = Number(process.env.SCAN_NOTIFY_MAX_OFFERS || '8');
const MAX_TOP_MATCHES = Number(process.env.SCAN_NOTIFY_MAX_TOP_MATCHES || '5');
const MAX_WATCHLIST = Number(process.env.SCAN_NOTIFY_MAX_WATCHLIST || '3');
const TELEGRAM_NOTIFY_ON_EMPTY = process.env.TELEGRAM_NOTIFY_ON_EMPTY === 'true';
const EPHEMERAL_PREVIEW = process.env.SCAN_NOTIFY_EPHEMERAL === 'true';
const parseYaml = yaml.load;

function ensureParent(path) {
  mkdirSync(dirname(path), { recursive: true });
}

function loadState() {
  if (!existsSync(STATE_PATH)) {
    return { version: 1, offers: {} };
  }

  const raw = readFileSync(STATE_PATH, 'utf-8');
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || typeof parsed.offers !== 'object') {
    return { version: 1, offers: {} };
  }
  return parsed;
}

function writeState(state) {
  ensureParent(STATE_PATH);
  writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
}

function writeSyntheticScanHistory(state) {
  if (existsSync(SCAN_HISTORY_PATH)) {
    return;
  }

  mkdirSync(DATA_DIR, { recursive: true });
  const lines = ['url\tfirst_seen\tportal\ttitle\tcompany\tstatus'];
  for (const offer of Object.values(state.offers)) {
    lines.push([
      offer.url,
      offer.firstSeen,
      offer.source || 'cloud-cache',
      offer.title || '',
      offer.company || '',
      'added',
    ].join('\t'));
  }
  writeFileSync(SCAN_HISTORY_PATH, `${lines.join('\n')}\n`, 'utf-8');
}

function ensurePipelineFile() {
  if (existsSync(PIPELINE_PATH)) {
    return;
  }

  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(
    PIPELINE_PATH,
    '# Pipeline\n\n## Pendientes\n\n## Procesadas\n',
    'utf-8',
  );
}

function readScanHistory() {
  if (!existsSync(SCAN_HISTORY_PATH)) {
    return [];
  }

  return readFileSync(SCAN_HISTORY_PATH, 'utf-8')
    .split('\n')
    .slice(1)
    .filter(Boolean)
    .map((line) => {
      const [url, firstSeen, source, title, company] = line.split('\t');
      return {
        url,
        firstSeen,
        source,
        title,
        company,
      };
    })
    .filter((entry) => entry.url);
}

function parseArgs(argv) {
  const args = {
    noSend: false,
    company: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (current === '--no-send') {
      args.noSend = true;
      continue;
    }
    if (current === '--company') {
      args.company = argv[index + 1] || null;
      index += 1;
    }
  }

  return args;
}

function buildScanArgs(args) {
  const result = ['scan.mjs'];
  if (args.company) {
    result.push('--company', args.company);
  }
  return result;
}

function snapshotFile(path) {
  if (!existsSync(path)) {
    return { existed: false, content: null };
  }
  return { existed: true, content: readFileSync(path, 'utf-8') };
}

function restoreFile(path, snapshot) {
  if (snapshot.existed) {
    ensureParent(path);
    writeFileSync(path, snapshot.content, 'utf-8');
    return;
  }

  if (existsSync(path)) {
    unlinkSync(path);
  }
}

async function runScan(args) {
  const { stdout, stderr } = await execFileAsync('node', buildScanArgs(args), {
    cwd: ROOT,
    maxBuffer: 1024 * 1024 * 8,
  });

  if (stderr?.trim()) {
    process.stderr.write(stderr);
  }
  return stdout;
}

function extractMetric(output, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = output.match(new RegExp(`${escaped}:\\s+(\\d+)`, 'm'));
  return match ? Number(match[1]) : 0;
}

function extractErrors(output) {
  const lines = output.split('\n');
  return lines
    .filter((line) => line.trim().startsWith('✗'))
    .map((line) => line.trim().replace(/^✗\s*/, ''));
}

function normalizeText(value) {
  return (value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '');
}

function tokenize(value) {
  return normalizeText(value)
    .split(/[^a-z0-9+#/.]+/)
    .filter(Boolean);
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function loadProfileSignals() {
  const fallback = {
    phrases: [],
    preferredTokens: [],
    discouragedTokens: ['manager', 'head', 'director', 'principal', 'staff', 'forward', 'deployed'],
  };

  if (!existsSync(PROFILE_PATH)) {
    return fallback;
  }

  const profile = parseYaml(readFileSync(PROFILE_PATH, 'utf-8')) || {};
  const primaryRoles = profile.target_roles?.primary || [];
  const archetypes = profile.target_roles?.archetypes || [];
  const superpowers = profile.narrative?.superpowers || [];
  const headline = profile.narrative?.headline ? [profile.narrative.headline] : [];

  const phrases = unique([
    ...primaryRoles,
    ...archetypes.map((item) => item.name),
    ...headline,
  ]);

  const ignoredTokens = new Set([
    'senior', 'mid', 'junior', 'lead', 'engineer', 'engineering', 'software',
    'architect', 'developer', 'specialise', 'specialized', 'specialisee',
    'specialise', 'cloud-native', 'cloud', 'native', 'fullstack', 'full', 'stack',
    'frontend', 'backend', 'and', 'or', 'de', 'et', 'des', 'the', 'a', 'an',
  ]);

  const preferredTokens = unique([
    ...phrases.flatMap(tokenize),
    ...superpowers.flatMap(tokenize),
    'angular',
    'nestjs',
    'kubernetes',
    'docker',
    'microservices',
    'ci',
    'cd',
    'frontend',
    'fullstack',
    'cloud',
    'devops',
  ]).filter((token) => token.length > 2 && !ignoredTokens.has(token));

  return {
    phrases: phrases.map(normalizeText),
    preferredTokens,
    discouragedTokens: fallback.discouragedTokens,
  };
}

function scoreOffer(offer, signals) {
  const title = normalizeText(offer.title);
  const company = normalizeText(offer.company);
  const reasons = [];
  let score = 0;

  for (const phrase of signals.phrases) {
    if (phrase && title.includes(phrase)) {
      score += 7;
      reasons.push(phrase);
    }
  }

  for (const token of signals.preferredTokens) {
    if (token && title.includes(token)) {
      score += 2;
      reasons.push(token);
    }
  }

  if (title.includes('senior')) {
    score += 2;
    reasons.push('senior');
  }
  if (title.includes('full stack') || title.includes('fullstack')) {
    score += 2;
    reasons.push('fullstack');
  }
  if (title.includes('cloud') || title.includes('platform')) {
    score += 2;
    reasons.push('cloud/platform');
  }
  if (title.includes('backend')) {
    score += 2;
    reasons.push('backend');
  }
  if (title.includes('frontend') || title.includes('angular')) {
    score += 2;
    reasons.push('frontend');
  }

  for (const token of signals.discouragedTokens) {
    if (title.includes(token)) {
      score -= 6;
      reasons.push(`not-${token}`);
    }
  }

  if (title.includes('product engineer')) {
    score -= 2;
    reasons.push('product-engineer');
  }
  if (title.includes('devops') && !title.includes('cloud')) {
    score -= 1;
  }
  if (company.includes('spotify') || company.includes('qonto') || company.includes('photoroom')) {
    score += 1;
  }

  let priority = 'low';
  if (score >= 9) priority = 'high';
  else if (score >= 4) priority = 'medium';

  return {
    ...offer,
    score,
    priority,
    reasons: unique(reasons).slice(0, 3),
  };
}

function prioritizeOffers(offers) {
  const signals = loadProfileSignals();
  return offers
    .map((offer) => scoreOffer(offer, signals))
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return left.title.localeCompare(right.title);
    });
}

function bucketOffers(offers) {
  return {
    high: offers.filter((offer) => offer.priority === 'high'),
    medium: offers.filter((offer) => offer.priority === 'medium'),
    low: offers.filter((offer) => offer.priority === 'low'),
  };
}

function summarizeCompanies(offers, limit = 3) {
  const counts = new Map();
  for (const offer of offers) {
    counts.set(offer.company, (counts.get(offer.company) || 0) + 1);
  }

  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, limit)
    .map(([company, count]) => `${company} (${count})`);
}

function buildSummary(output, prioritizedOffers) {
  const dateMatch = output.match(/Portal Scan — (\d{4}-\d{2}-\d{2})/);
  const date = dateMatch ? dateMatch[1] : new Date().toISOString().slice(0, 10);
  const errors = extractErrors(output);
  const buckets = bucketOffers(prioritizedOffers);

  return {
    date,
    companiesScanned: extractMetric(output, 'Companies scanned'),
    totalFound: extractMetric(output, 'Total jobs found'),
    filteredTitle: extractMetric(output, 'Filtered by title'),
    filteredLocation: extractMetric(output, 'Filtered by location'),
    duplicates: extractMetric(output, 'Duplicates'),
    newOffersCount: prioritizedOffers.length,
    highPriorityCount: buckets.high.length,
    mediumPriorityCount: buckets.medium.length,
    lowPriorityCount: buckets.low.length,
    topCompanies: summarizeCompanies(prioritizedOffers),
    errors,
  };
}

function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function formatOfferLine(offer, withReasons = false) {
  const title = escapeHtml(offer.title || 'Untitled role');
  const company = escapeHtml(offer.company || 'Unknown company');
  const reasons = withReasons && offer.reasons.length > 0
    ? ` <i>(${escapeHtml(offer.reasons.join(', '))})</i>`
    : '';
  return `• <a href="${offer.url}">${title}</a> — ${company}${reasons}`;
}

function formatTelegramMessage(summary, offers) {
  const buckets = bucketOffers(offers);
  const topMatches = buckets.high.slice(0, MAX_TOP_MATCHES);
  const watchlistPool = buckets.medium.concat(buckets.low);
  const watchlist = watchlistPool.slice(0, Math.max(0, Math.min(MAX_WATCHLIST, MAX_MESSAGE_OFFERS - topMatches.length)));
  const lines = [
    '<b>career-ops scan</b>',
    `${escapeHtml(summary.date)}`,
    '',
    `New offers: <b>${summary.newOffersCount}</b>`,
    `Priority split: <b>${summary.highPriorityCount}</b> high / <b>${summary.mediumPriorityCount}</b> medium / <b>${summary.lowPriorityCount}</b> low`,
    `Companies scanned: <b>${summary.companiesScanned}</b>`,
    `Filtered out: <b>${summary.filteredTitle + summary.filteredLocation + summary.duplicates}</b>`,
  ];

  if (summary.topCompanies.length > 0) {
    lines.push(`Top companies: <b>${escapeHtml(summary.topCompanies.join(', '))}</b>`);
  }

  if (topMatches.length > 0) {
    lines.push('', `<b>Top matches</b>`);
    for (const offer of topMatches) {
      lines.push(formatOfferLine(offer, true));
    }
  }

  if (watchlist.length > 0) {
    lines.push('', '<b>Watchlist</b>');
    for (const offer of watchlist) {
      lines.push(formatOfferLine(offer, false));
    }
  }

  const shownCount = topMatches.length + watchlist.length;
  if (offers.length > shownCount) {
    lines.push(`… and ${offers.length - shownCount} more`);
  }

  if (summary.errors.length > 0) {
    lines.push('', '<b>Errors</b>');
    for (const error of summary.errors.slice(0, 5)) {
      lines.push(`• ${escapeHtml(error)}`);
    }
  }

  return lines.join('\n').slice(0, 3900);
}

function mergeOffers(historyEntries) {
  const offers = {};
  for (const entry of historyEntries) {
    offers[entry.url] = {
      url: entry.url,
      firstSeen: entry.firstSeen,
      source: entry.source,
      title: entry.title,
      company: entry.company,
    };
  }
  return offers;
}

async function main() {
  mkdirSync(CACHE_DIR, { recursive: true });

  const args = parseArgs(process.argv.slice(2));
  const previousState = loadState();
  const shouldRestoreLocalFiles = args.noSend || EPHEMERAL_PREVIEW;
  const managedFiles = shouldRestoreLocalFiles
    ? {
        scanHistory: snapshotFile(SCAN_HISTORY_PATH),
        pipeline: snapshotFile(PIPELINE_PATH),
      }
    : null;

  ensurePipelineFile();
  writeSyntheticScanHistory(previousState);
  const baselineEntries = readScanHistory();
  const baselineUrls = new Set(baselineEntries.map((entry) => entry.url));

  const output = await runScan(args);
  process.stdout.write(output);

  const historyEntries = readScanHistory();
  const newOffers = historyEntries.filter((entry) => !baselineUrls.has(entry.url));
  const prioritizedOffers = prioritizeOffers(newOffers);
  const nextState = {
    version: 1,
    lastRunAt: new Date().toISOString(),
    offers: mergeOffers(historyEntries),
  };
  const summary = buildSummary(output, prioritizedOffers);
  const message = formatTelegramMessage(summary, prioritizedOffers);

  try {
    if (newOffers.length === 0 && !TELEGRAM_NOTIFY_ON_EMPTY) {
      writeState(nextState);
      console.log('\nNo Telegram message sent (no new offers).');
      return;
    }

    if (args.noSend) {
      console.log('\nTelegram preview:\n');
      console.log(message);
      writeState(nextState);
      return;
    }

    await sendTelegramMessage({ text: message });
    writeState(nextState);
    console.log(`\nTelegram notification sent (${newOffers.length} new offers).`);
  } finally {
    if (managedFiles) {
      restoreFile(SCAN_HISTORY_PATH, managedFiles.scanHistory);
      restoreFile(PIPELINE_PATH, managedFiles.pipeline);
    }
  }
}

main().catch((error) => {
  console.error(`Fatal: ${error.message}`);
  process.exit(1);
});
