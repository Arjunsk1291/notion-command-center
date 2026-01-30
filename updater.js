#!/usr/bin/env node
const https = require('https');
const fs = require('fs');
const path = require('path');
const { Client } = require('@notionhq/client');

/* ───────── CONFIG (HARDCODED AS REQUESTED) ───────── */

const CONFIG = {
  notion: {
    apiKey: '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',
    pageId: 'bd748499-107c-4d3d-a98e-591d343fd0ca',
    tasksDbId: '2f6af4a2-4880-8039-8d2b-d3cdf3b4e506',
    meetingsDbId: '63ad18c2-0c91-4a1c-adc5-b029dcb62118',
  },
  giphy: {
    apiKey: 'eBINXKePSrc5VBI9XmK0mxIowozlbSZk',
  },
  openrouter: {
    apiKey: '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',
    model: 'tngtech/deepseek-r1t2-chimera:free',
  }
};

/* ───────── LOGGING ───────── */

const logsDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(path.join(logsDir, 'execution.log'), line + '\n');
}

/* ───────── GIPHY (NON-REPEATING) ───────── */

const gifCacheFile = path.join(logsDir, 'used_gifs.json');

function loadGifCache() {
  try { return JSON.parse(fs.readFileSync(gifCacheFile)); }
  catch { return []; }
}

function saveGifCache(c) {
  fs.writeFileSync(gifCacheFile, JSON.stringify(c.slice(-50), null, 2));
}

async function searchGiphyGif(query) {
  const used = loadGifCache();
  const offset = Math.floor((Date.now() / (5 * 60 * 1000)) % 50);

  const url =
    `https://api.giphy.com/v1/gifs/search?` +
    `api_key=${CONFIG.giphy.apiKey}` +
    `&q=${encodeURIComponent(query)}` +
    `&limit=25&offset=${offset}&rating=g`;

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

/* ───────── OPENROUTER → DEEPSEEK (AI DIALOGUE) ───────── */

async function generateUnhingedMalluDialogue(context) {
  const payload = JSON.stringify({
    model: CONFIG.openrouter.model,
    messages: [
      {
        role: 'system',
        content:
`You are an unhinged Kerala dude with zero filter.
You swear casually (myre, poda, patti, thendi etc — Malayalam + English mix).
You make Malayalam movie references (Mammootty, Mohanlal, Jagathy, Suresh Gopi).
You mock the user’s productivity like a drunk but intelligent friend.
No moral lessons. No politeness. No repetition.
Every response must feel new, chaotic, and funny.
Do NOT explain yourself. Just rant.`
      },
      {
        role: 'user',
        content:
`Current status:
- Total tasks: ${context.totalTasks}
- Incomplete tasks: ${context.incompleteTasks}
- Overdue tasks: ${context.overdueTasks}
- Upcoming meetings: ${context.upcomingMeetings}

Roast and roleplay based on this.`
      }
    ],
    temperature: 0.95,
    top_p: 0.95
  });

  return new Promise((resolve, reject) => {
    const req = https.request(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${CONFIG.openrouter.apiKey}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'HTTP-Referer': 'https://github.com',
          'X-Title': 'Notion Command Center'
        }
      },
      res => {
        let body = '';
        res.on('data', d => body += d);
        res.on('end', () => {
          try {
            const json = JSON.parse(body);
            resolve(json.choices[0].message.content.trim());
          } catch (e) {
            reject(new Error('DeepSeek response parse failed'));
          }
        });
      }
    );

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/* ───────── NOTION HELPERS ───────── */

async function findCalloutRecursive(notion, blockId) {
  const children = await notion.blocks.children.list({ block_id: blockId, page_size: 100 });
  for (const block of children.results) {
    if (block.type === 'callout') return block.id;
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

/* ───────── DATA FETCH ───────── */

async function fetchTasksData(notion) {
  const res = await notion.databases.query({ database_id: CONFIG.notion.tasksDbId });
  let total = 0, incomplete = 0, overdue = 0;
  const today = new Date(); today.setHours(0,0,0,0);

  for (const t of res.results) {
    total++;
    const status = Object.values(t.properties)
      .find(p => p.name?.toLowerCase() === 'status')
      ?.select?.name?.toLowerCase() || '';
    if (status === 'done') continue;
    incomplete++;
    const due = Object.values(t.properties)
      .find(p => p.name?.toLowerCase() === 'due')
      ?.date?.start;
    if (due && new Date(due) < today) overdue++;
  }

  return { totalTasks: total, incompleteTasks: incomplete, overdueTasks: overdue };
}

async function fetchMeetingsData(notion) {
  const res = await notion.databases.query({ database_id: CONFIG.notion.meetingsDbId });
  return { upcomingMeetings: res.results.length };
}

/* ───────── UPDATE NOTION ───────── */

async function updateNotionPage(notion, data, text, gifUrl) {
  const calloutId = await findCalloutRecursive(notion, CONFIG.notion.pageId);
  const imageId = await findImageInsideCallout(notion, calloutId);

  await notion.blocks.update({
    block_id: calloutId,
    callout: {
      rich_text: [{ type: 'text', text: { content: text } }],
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
}

/* ───────── MAIN ───────── */

async function main() {
  log('🚀 Running command center');
  const notion = new Client({ auth: CONFIG.notion.apiKey });

  const tasks = await fetchTasksData(notion);
  const meetings = await fetchMeetingsData(notion);
  const context = { ...tasks, ...meetings };

  const aiText = await generateUnhingedMalluDialogue(context);
  const gif = await searchGiphyGif('malayalam comedy reaction');

  await updateNotionPage(notion, context, aiText, gif);
  log('✅ Updated Notion');
}

main().catch(e => {
  log(`❌ ${e.message}`);
  process.exit(1);
});
