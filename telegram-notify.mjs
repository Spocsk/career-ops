#!/usr/bin/env node

import process from 'node:process';

function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

export async function sendTelegramMessage({
  text,
  token = process.env.TELEGRAM_BOT_TOKEN,
  chatId = process.env.TELEGRAM_CHAT_ID,
  parseMode = 'HTML',
  disableWebPagePreview = true,
}) {
  if (!token) {
    throw new Error('TELEGRAM_BOT_TOKEN is required');
  }
  if (!chatId) {
    throw new Error('TELEGRAM_CHAT_ID is required');
  }
  if (!text || !text.trim()) {
    throw new Error('Telegram message is empty');
  }

  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: parseMode,
      disable_web_page_preview: disableWebPagePreview,
    }),
  });

  const payload = await response.json();
  if (!response.ok || payload.ok !== true) {
    throw new Error(payload.description || `Telegram API error (${response.status})`);
  }

  return payload.result;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf-8').trim();
}

function parseArgs(argv) {
  const args = { message: null };
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (current === '--message') {
      args.message = argv[index + 1] || '';
      index += 1;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const text = args.message ?? await readStdin();
  const result = await sendTelegramMessage({ text: escapeHtml(text) });
  console.log(`Telegram message sent (${result.message_id})`);
}

const entrypoint = process.argv[1] ? new URL(`file://${process.argv[1]}`).href : '';
if (import.meta.url === entrypoint) {
  main().catch((error) => {
    console.error(`Fatal: ${error.message}`);
    process.exit(1);
  });
}
