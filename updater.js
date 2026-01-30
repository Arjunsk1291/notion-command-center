#!/usr/bin/env node
const https = require('https');
const fs = require('fs');
const path = require('path');
const { Client } = require('@notionhq/client');

/* ───────── Helpers ───────── */

function formatNotionId(id) {
  const hex = id.split('-').pop();
  if (hex && hex.length === 32) {
    return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
  }
  return id;
}

/* ───────── Config ───────── */

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

/* ───────── Logging ───────── */

const logsDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(path.join(logsDir, 'execution.log'), line + '\n');
}

/* ───────── GIF cache ───────── */

const gifCacheFile = path.join(logsDir, 'used_gifs.json');

function loadGifCache() {
  try { return JSON.parse(fs.readFileSync(gifCacheFile)); }
  catch { return []; }
}

function saveGifCache(c) {
  fs.writeFileSync(gifCacheFile, JSON.stringify(c.slice(-50), null, 2));
}

/* ───────── GIPHY (fixed) ───────── */

async function searchGiphyGif(query) {
  const used = loadGifCache();
  const offset = Math.floor((Date.now() / (5 * 60 * 1000)) % 50);

  const url =
    `https://api.giphy.com/v1/gifs/search` +
    `?api_key=${CONFIG.giphy.apiKey}` +
    `&q=${encodeURIComponent(query)}` +
    `&limit=25&offset=${offset}&rating=g` +
    `&random_id=command-center-${new Date().toDateString()}`;

  return new Promise((resolve) => {
    https.get(url, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try {
          const gifs = JSON.parse(body).data || [];
          const fresh = gifs.filter(g => !used.includes(g.id));
          const pool = fresh.length ? fresh : gifs;
          const chosen = pool[Math.floor(Math.random() * pool.length)];

          used.push(chosen.id);
          saveGifCache(used);

          log(`🎬 GIF selected: ${chosen.id}`);
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

/* ───────── Notion traversal (RESTORED) ───────── */

async function findCalloutRecursive(notion, blockId) {
  const children = await notion.blocks.children.list({ block_id: blockId, page_size: 100 });

  for (const block of children.results) {
    if (block.type === 'callout') {
      const text = block.callout.rich_text?.[0]?.plain_text || '';
      if (text.includes('COMMAND CENTER') || text.includes('ONLINE')) {
        return block.id;
      }
    }

    if (block.has_children) {
      const found = await findCalloutRecursive(notion, block.id);
      if (found) return found;
    }
  }
  return null;
}

async function findImageInsideCallout(notion, calloutId) {
  const children = await notion.blocks.children.list({ block_id: calloutId, page_size: 100 });
  return children.results.find(b => b.type === 'image')?.id || null;
}

/* ───────── Data fetch ───────── */

async function fetchTasksData(notion) {
  const res = await notion.databases.query({ database_id: CONFIG.notion.tasksDbId });
  let total = 0, incomplete = 0, overdue = 0;
  const today = new Date(); today.setHours(0,0,0,0);

  for (const t of res.results) {
    total++;
    const props = t.properties;
    const status = Object.values(props).find(p => p.name?.toLowerCase() === 'status')
      ?.select?.name?.toLowerCase() || '';

    if (status === 'done') continue;
    incomplete++;

    const due = Object.values(props).find(p => p.name?.toLowerCase() === 'due')
      ?.date?.start;
    if (due && new Date(due) < today) overdue++;
  }

  return { totalTasks: total, incompleteTasks: incomplete, overdueTasks: overdue };
}

async function fetchMeetingsData(notion) {
  const res = await notion.databases.query({ database_id: CONFIG.notion.meetingsDbId });
  return { upcomingMeetings: res.results.length };
}

/* ───────── Update Notion (FIXED) ───────── */

async function updateNotionPage(notion, data, message, gifUrl) {
  const calloutId = await findCalloutRecursive(notion, CONFIG.notion.pageId);
  if (!calloutId) throw new Error('❌ COMMAND CENTER callout not found');

  const imageId = await findImageInsideCallout(notion, calloutId);

  await notion.blocks.update({
    block_id: calloutId,
    callout: {
      rich_text: [{ type: 'text', text: { content: message } }],
      icon: { type: 'emoji', emoji: '🤖' },
      color: 'blue_background',
    },
  });

  if (imageId) {
    await notion.blocks.update({
      block_id: imageId,
      image: { external: { url: gifUrl } },
    });
  }

  log('✅ Notion updated');
}

/* ───────── Main ───────── */

async function main() {
  const notion = new Client({ auth: CONFIG.notion.apiKey });

  const tasks = await fetchTasksData(notion);
  const meetings = await fetchMeetingsData(notion);
  const data = { ...tasks, ...meetings };

  const msg = `🤖 COMMAND CENTER ONLINE\n\nPending: ${data.incompleteTasks}/${data.totalTasks}\nMeetings: ${data.upcomingMeetings}`;
  const gif = await searchGiphyGif('malayalam comedy reaction');

  await updateNotionPage(notion, data, msg, gif);
}

main().catch(e => {
  log(`❌ ${e.message}`);
  process.exit(1);
});
