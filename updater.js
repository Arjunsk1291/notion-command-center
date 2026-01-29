#!/usr/bin/env node
const https = require('https');
const fs = require('fs');
const path = require('path');
const { Client } = require('@notionhq/client');

/* ────────────────────────────────
   Helpers
──────────────────────────────── */

function formatNotionId(notionId) {
  const hexId = notionId.split('-').pop();
  if (hexId && hexId.length === 32) {
    return `${hexId.slice(0,8)}-${hexId.slice(8,12)}-${hexId.slice(12,16)}-${hexId.slice(16,20)}-${hexId.slice(20,32)}`;
  }
  return notionId;
}

/* ────────────────────────────────
   Config
──────────────────────────────── */

const CONFIG = {
  notion: {
    apiKey: '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',
    pageId: formatNotionId('COMMAND-CENTER-bd748499107c4d3da98e591d343fd0ca'),
    tasksDbId: formatNotionId('2f6af4a2488080398d2bd3cdf3b4e506'),
    meetingsDbId: formatNotionId('63ad18c20c914a1cadc5b029dcb62118'),
  },
  giphy: {
    apiKey: 'eBINXKePSrc5VBI9XmK0mxIowozlbSZk',
  },
};

/* ────────────────────────────────
   Logging + storage
──────────────────────────────── */

const logsDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

const gifCacheFile = path.join(logsDir, 'used_gifs.json');

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(path.join(logsDir, 'execution.log'), line + '\n');
}

function logError(msg) {
  log(`❌ ${msg}`);
}

function loadGifCache() {
  try {
    return JSON.parse(fs.readFileSync(gifCacheFile, 'utf8'));
  } catch {
    return [];
  }
}

function saveGifCache(cache) {
  fs.writeFileSync(gifCacheFile, JSON.stringify(cache.slice(-50), null, 2));
}

/* ────────────────────────────────
   GIPHY — non-repeating retrieval
──────────────────────────────── */

async function searchGiphyGif(query) {
  const used = loadGifCache();

  // rotate search window every 5 minutes
  const offset = Math.floor((Date.now() / (5 * 60 * 1000)) % 50);

  const url =
    `https://api.giphy.com/v1/gifs/search` +
    `?api_key=${CONFIG.giphy.apiKey}` +
    `&q=${encodeURIComponent(query)}` +
    `&limit=25` +
    `&offset=${offset}` +
    `&rating=g` +
    `&lang=en` +
    `&random_id=command-center-${new Date().toDateString()}`;

  return new Promise((resolve) => {
    https.get(url, res => {
      let body = '';
      res.on('data', c => (body += c));
      res.on('end', () => {
        try {
          const gifs = JSON.parse(body).data || [];
          if (!gifs.length) throw new Error('Empty');

          const fresh = gifs.filter(g => !used.includes(g.id));
          const pool = fresh.length ? fresh : gifs;
          const chosen = pool[Math.floor(Math.random() * pool.length)];

          used.push(chosen.id);
          saveGifCache(used);

          log(`✓ GIF chosen: ${chosen.id} (offset=${offset})`);
          resolve(chosen.images.original.url);
        } catch {
          resolve('https://media.giphy.com/media/3o7TKU2mVn0tDW89gI/giphy.gif');
        }
      });
    }).on('error', () =>
      resolve('https://media.giphy.com/media/3o7TKU2mVn0tDW89gI/giphy.gif')
    );
  });
}

/* ────────────────────────────────
   Notion data fetch
──────────────────────────────── */

async function fetchTasksData(notion) {
  const res = await notion.databases.query({ database_id: CONFIG.notion.tasksDbId });
  const today = new Date(); today.setHours(0,0,0,0);

  let total = 0, incomplete = 0, overdue = 0;
  const priority = { high: 0, medium: 0, low: 0 };

  for (const task of res.results) {
    total++;
    const props = task.properties;

    const status =
      Object.values(props).find(p => p.name?.toLowerCase() === 'status')
        ?.select?.name?.toLowerCase() || '';

    if (status === 'done' || status === 'completed') continue;
    incomplete++;

    const due =
      Object.values(props).find(p => p.name?.toLowerCase() === 'due')
        ?.date?.start;

    if (due && new Date(due) < today) overdue++;

    const pr =
      Object.values(props).find(p => p.name?.toLowerCase() === 'priority')
        ?.select?.name?.toLowerCase() || '';

    if (pr.includes('high')) priority.high++;
    else if (pr.includes('medium')) priority.medium++;
    else if (pr.includes('low')) priority.low++;
  }

  return { totalTasks: total, incompleteTasks: incomplete, overdueTasks: overdue, priorityBreakdown: priority };
}

async function fetchMeetingsData(notion) {
  const now = new Date();
  const nextWeek = new Date(now.getTime() + 7 * 86400000);

  const res = await notion.databases.query({
    database_id: CONFIG.notion.meetingsDbId,
    filter: {
      and: [
        { property: 'Date', date: { on_or_after: now.toISOString().split('T')[0] } },
        { property: 'Date', date: { before: nextWeek.toISOString().split('T')[0] } },
      ],
    },
  });

  return { upcomingMeetings: res.results.length };
}

/* ────────────────────────────────
   Messaging
──────────────────────────────── */

function getGifSearchQuery(d) {
  if (d.incompleteTasks === 0 && d.overdueTasks === 0)
    return 'malayalam comedy celebration funny dance';
  if (d.overdueTasks > 0)
    return 'malayalam panic shock funny reaction';
  if (d.incompleteTasks > 10 || d.priorityBreakdown.high > 3)
    return 'malayalam work stress funny';
  if (d.incompleteTasks > 5)
    return 'malayalam busy schedule comedy';
  return 'malayalam chill relax funny';
}

function generateMessage(d) {
  if (d.incompleteTasks === 0 && d.overdueTasks === 0)
    return `All clear. Collector-level efficiency. Rare sight.`;
  if (d.overdueTasks > 0)
    return `Overdue tasks detected. This is not a drill.`;
  if (d.incompleteTasks > 5)
    return `Tasks piling up. Plot thickens.`;
  return `Manageable chaos. Don't escalate it.`;
}

/* ────────────────────────────────
   Notion update
──────────────────────────────── */

async function updateNotionPage(notion, data, msg, gif) {
  const blocks = await notion.blocks.children.list({ block_id: CONFIG.notion.pageId });
  const callout = blocks.results.find(b => b.type === 'callout');
  if (!callout) throw new Error('Callout not found');

  await notion.blocks.update({
    block_id: callout.id,
    callout: {
      rich_text: [{ type: 'text', text: { content: msg } }],
      icon: { type: 'emoji', emoji: '🤖' },
      color: 'blue_background',
    },
  });

  const img = blocks.results.find(b => b.type === 'image');
  if (img) {
    await notion.blocks.update({
      block_id: img.id,
      image: { external: { url: gif } },
    });
  }
}

/* ────────────────────────────────
   Main
──────────────────────────────── */

async function main() {
  try {
    log('🚀 Running command center update');
    const notion = new Client({ auth: CONFIG.notion.apiKey });

    const tasks = await fetchTasksData(notion);
    const meetings = await fetchMeetingsData(notion);
    const data = { ...tasks, ...meetings };

    const msg = generateMessage(data);
    const gif = await searchGiphyGif(getGifSearchQuery(data));

    await updateNotionPage(notion, data, msg, gif);

    log('✅ Update complete');
    process.exit(0);
  } catch (e) {
    logError(e.message);
    process.exit(1);
  }
}

main();
