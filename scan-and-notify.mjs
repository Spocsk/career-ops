#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import process from 'node:process';
import { sendTelegramMessage } from './telegram-notify.mjs';

const execFileAsync = promisify(execFile);

const ROOT = process.cwd();
const DATA_DIR = resolve(ROOT, 'data');
const CACHE_DIR = resolve(ROOT, '.cache');
const SCAN_HISTORY_PATH = resolve(DATA_DIR, 'scan-history.tsv');
const PIPELINE_PATH = resolve(DATA_DIR, 'pipeline.md');
const STATE_PATH = resolve(ROOT, process.env.SCAN_NOTIFY_STATE_PATH || '.cache/scan-notify-state.json');
const MAX_MESSAGE_OFFERS = Number(process.env.SCAN_NOTIFY_MAX_OFFERS || '8');
const TELEGRAM_NOTIFY_ON_EMPTY = process.env.TELEGRAM_NOTIFY_ON_EMPTY === 'true';
const EPHEMERAL_PREVIEW = process.env.SCAN_NOTIFY_EPHEMERAL === 'true';

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

function buildSummary(output, newOffers) {
  const dateMatch = output.match(/Portal Scan — (\d{4}-\d{2}-\d{2})/);
  const date = dateMatch ? dateMatch[1] : new Date().toISOString().slice(0, 10);
  const errors = extractErrors(output);

  return {
    date,
    companiesScanned: extractMetric(output, 'Companies scanned'),
    totalFound: extractMetric(output, 'Total jobs found'),
    filteredTitle: extractMetric(output, 'Filtered by title'),
    filteredLocation: extractMetric(output, 'Filtered by location'),
    duplicates: extractMetric(output, 'Duplicates'),
    newOffersCount: newOffers.length,
    errors,
  };
}

function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function formatTelegramMessage(summary, offers) {
  const visibleOffers = offers.slice(0, MAX_MESSAGE_OFFERS);
  const lines = [
    '<b>career-ops scan</b>',
    `${escapeHtml(summary.date)}`,
    '',
    `Companies scanned: <b>${summary.companiesScanned}</b>`,
    `Total jobs found: <b>${summary.totalFound}</b>`,
    `Filtered by title: <b>${summary.filteredTitle}</b>`,
    `Filtered by location: <b>${summary.filteredLocation}</b>`,
    `Duplicates skipped: <b>${summary.duplicates}</b>`,
    `New offers: <b>${summary.newOffersCount}</b>`,
  ];

  if (visibleOffers.length > 0) {
    lines.push('', '<b>New roles</b>');
    for (const offer of visibleOffers) {
      const title = escapeHtml(offer.title || 'Untitled role');
      const company = escapeHtml(offer.company || 'Unknown company');
      lines.push(`• <a href="${offer.url}">${title}</a> — ${company}`);
    }
  }

  if (offers.length > visibleOffers.length) {
    lines.push(`… and ${offers.length - visibleOffers.length} more`);
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
  const nextState = {
    version: 1,
    lastRunAt: new Date().toISOString(),
    offers: mergeOffers(historyEntries),
  };
  const summary = buildSummary(output, newOffers);
  const message = formatTelegramMessage(summary, newOffers);

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
