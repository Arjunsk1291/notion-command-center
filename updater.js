#!/usr/bin/env node
const https = require('https');
const fs = require('fs');
const path = require('path');
const { Client } = require('@notionhq/client');

// Format Notion ID
function formatNotionId(notionId) {
  const hexId = notionId.split('-').pop();
  if (hexId && hexId.length === 32) {
    return `${hexId.slice(0,8)}-${hexId.slice(8,12)}-${hexId.slice(12,16)}-${hexId.slice(16,20)}-${hexId.slice(20,32)}`;
  }
  return notionId;
}

const CONFIG = {
  notion: {
    apiKey: process.env.NOTION_API_KEY,
    pageId: formatNotionId(process.env.NOTION_PAGE_ID),
    tasksDbId: formatNotionId(process.env.TASKS_DATABASE_ID),
    meetingsDbId: formatNotionId(process.env.MEETINGS_DATABASE_ID),
  },
  giphy: {
    apiKey: process.env.GIPHY_API_KEY,
  },
};

function validateEnv() {
  const required = ['NOTION_API_KEY', 'NOTION_PAGE_ID', 'TASKS_DATABASE_ID', 'MEETINGS_DATABASE_ID', 'GIPHY_API_KEY'];
  const missing = required.filter(key => !process.env[key]);
  if (missing.length > 0) throw new Error(`Missing: ${missing.join(', ')}`);
  log('✓ Environment validated');
}

const logsDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

function log(message) {
  const timestamp = new Date().toISOString();
  const formatted = `[${timestamp}] ${message}`;
  console.log(formatted);
  fs.appendFileSync(path.join(logsDir, 'execution.log'), formatted + '\n');
}

function logError(message) {
  const timestamp = new Date().toISOString();
  const formatted = `[${timestamp}] ❌ ${message}`;
  console.error(formatted);
  fs.appendFileSync(path.join(logsDir, 'execution.log'), formatted + '\n');
}

// Search GIPHY for Malayalam joke GIFs
async function searchGiphyGif(query) {
  return new Promise((resolve) => {
    const url = `https://api.giphy.com/v1/gifs/search?api_key=${CONFIG.giphy.apiKey}&q=${encodeURIComponent(query)}&limit=20&rating=g`;
    
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const response = JSON.parse(data);
          if (response.data && response.data.length > 0) {
            const randomGif = response.data[Math.floor(Math.random() * response.data.length)];
            const gifUrl = randomGif.images.original.url;
            log(`  ✓ Found Malayalam GIF for "${query}"`);
            resolve(gifUrl);
          } else {
            resolve('https://media.giphy.com/media/3o7TKU2mVn0tDW89gI/giphy.gif'); // Fallback funny gif
          }
        } catch (e) {
          resolve('https://media.giphy.com/media/3o7TKU2mVn0tDW89gI/giphy.gif');
        }
      });
    }).on('error', () => {
      resolve('https://media.giphy.com/media/3o7TKU2mVn0tDW89gI/giphy.gif');
    });
  });
}

async function fetchTasksData(notion) {
  try {
    const query = await notion.databases.query({ database_id: CONFIG.notion.tasksDbId });
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    let totalTasks = 0, incompleteTasks = 0, overdueTasks = 0;
    const priorityBreakdown = { high: 0, medium: 0, low: 0 };
    
    for (const task of query.results) {
      totalTasks++;
      const properties = task.properties;
      
      // CHECK STATUS COLUMN - only count as incomplete if Status is NOT "Done"
      const statusProp = Object.values(properties).find(p => p.name && p.name.toLowerCase() === 'status');
      const status = statusProp?.select?.name || '';
      
      log(`  📋 Task: ${task.properties.title?.title?.[0]?.plain_text || 'Unknown'} | Status: ${status}`);
      
      const isComplete = status.toLowerCase() === 'done' || status.toLowerCase() === 'completed';
      
      if (!isComplete) {
        incompleteTasks++;
        
        // Check if overdue
        const dueProp = Object.values(properties).find(p => p.name && p.name.toLowerCase() === 'due');
        const dueDate = dueProp?.date?.start;
        if (dueDate) {
          const taskDate = new Date(dueDate);
          taskDate.setHours(0, 0, 0, 0);
          if (taskDate < today) overdueTasks++;
        }
        
        // Track priority
        const priorityProp = Object.values(properties).find(p => p.name && p.name.toLowerCase() === 'priority');
        const priority = priorityProp?.select?.name || '';
        if (priority) {
          const p = priority.toLowerCase();
          if (p.includes('high')) priorityBreakdown.high++;
          else if (p.includes('medium')) priorityBreakdown.medium++;
          else if (p.includes('low')) priorityBreakdown.low++;
        }
      }
    }
    return { totalTasks, incompleteTasks, overdueTasks, priorityBreakdown };
  } catch (error) {
    throw new Error(`Fetch tasks failed: ${error.message}`);
  }
}

async function fetchMeetingsData(notion) {
  try {
    const now = new Date();
    const nextWeek = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const query = await notion.databases.query({
      database_id: CONFIG.notion.meetingsDbId,
      filter: {
        and: [
          { property: 'Date', date: { on_or_after: now.toISOString().split('T')[0] } },
          { property: 'Date', date: { before: nextWeek.toISOString().split('T')[0] } },
        ],
      },
    });
    return { upcomingMeetings: query.results.length };
  } catch (error) {
    throw new Error(`Fetch meetings failed: ${error.message}`);
  }
}

function getGifSearchQuery(data) {
  const incomplete = data.incompleteTasks;
  const overdue = data.overdueTasks;
  const highPriority = data.priorityBreakdown.high;
  
  if (incomplete === 0 && overdue === 0) {
    return 'malayalam comedy celebration funny dance';
  } else if (overdue > 0) {
    return 'malayalam panic shock funny reaction';
  } else if (incomplete > 10 || highPriority > 3) {
    return 'malayalam work tired stress funny';
  } else if (incomplete > 5) {
    return 'malayalam busy schedule comedy';
  } else {
    return 'malayalam cool chill relax funny';
  }
}

function generateMessage(data) {
  const incomplete = data.incompleteTasks;
  const total = data.totalTasks;
  const meetings = data.upcomingMeetings;
  const overdue = data.overdueTasks;
  const highPriority = data.priorityBreakdown.high;
  
  // Malayalam movie dialogue references + English with Mallu humor
  const messages = {
    clear: [
      `All ${total} tasks done? Poli! Even Pavithran's double-crossing scheme wasn't this smooth. You're officially a legend today. 🎬`,
      `Wait, ZERO pending? Did you actually turn into a Suresh Gopi hero or something? Fine, I'll admit it - you're productive. Don't spoil it.`,
      `${total} tasks finished? "Thamara vittukodi!" - as they say. You've officially leveled up from "Manavalan" to "Mammootty." Keep going!`,
      `All pending gone? This is what I call "Collector-level efficiency." Even Jayaram would salute you. Well done, serious person.`,
    ],
    light: [
      `${incomplete} tasks pending. Look, this is what I call a "Dasan & Vijayan joke" - manageable but hilarious if you procrastinate. Don't.`,
      `${incomplete} items left. Stop acting like CID Moosa investigating a crime scene. This is breakfast-level work.`,
      `${incomplete} tasks? That's lighter than a "Nadan & Velichappan" punchline. But knowing you, you'll turn it into a full comedy sketch.`,
      `Just ${incomplete} pending. Unless you're planning to pull a "Shaji Pappan" and delay it by a month, you'll be fine.`,
    ],
    moderate: [
      `${incomplete} incomplete, ${highPriority} high-priority ones glaring at you. This plot is more twisted than a Suresh Gopi 90s thriller.`,
      `${incomplete} tasks, ${meetings} meetings - your calendar looks like a "Aniruddhan" comedy gone wrong. Time to organize, myre.`,
      `${incomplete} pending with ${highPriority} screaming "URGENT"? This isn't a to-do list, it's a "CID Moosa mystery" waiting to happen.`,
      `${incomplete} items and you're just checking NOW? Even "Prem Kishan" could organize better than this chaos.`,
    ],
    critical: [
      `${overdue} OVERDUE?! Did you channel your inner "Manavalan" and give up? Or are you stuck in "Dasan & Vijayan" mode? FIX THIS NOW!`,
      `Ayyo! ${incomplete} pending, ${overdue} overdue, ${meetings} meetings. Your schedule is a "Jayaram-level disaster comedy." Get serious!`,
      `${overdue} overdue tasks? What's next, you'll tell me traffic delayed you? This is pure "CID Moosa investigation gone wrong." Act NOW.`,
      `${incomplete} incomplete, ${overdue} overdue - your command center looks like a "Shaji Pappan betrayal scene." Chaos! Get moving!`,
    ],
  };
  
  let vibe = 'light';
  if (incomplete === 0 && overdue === 0) vibe = 'clear';
  else if (incomplete > 10 || overdue > 0) vibe = 'critical';
  else if (incomplete > 5 || highPriority > 2) vibe = 'moderate';
  
  const vibeMessages = messages[vibe];
  return vibeMessages[Math.floor(Math.random() * vibeMessages.length)];
}

// Find callout block recursively
async function findCalloutBlockRecursive(notion, blockId, depth = 0) {
  const indent = '  '.repeat(depth);
  try {
    const children = await notion.blocks.children.list({ block_id: blockId, page_size: 100 });
    
    for (const block of children.results) {
      if (block.type === 'callout') {
        const text = block.callout?.rich_text?.[0]?.plain_text || '';
        if (text.includes('SYSTEM ASSISTANT') || text.includes('COMMAND CENTER') || text.includes('ONLINE')) {
          log(`${indent}✓ Found callout block`);
          return block.id;
        }
      }
      
      if (block.has_children && (block.type === 'column_list' || block.type === 'column')) {
        const found = await findCalloutBlockRecursive(notion, block.id, depth + 1);
        if (found) return found;
      }
    }
    
    return null;
  } catch (error) {
    log(`${indent}⚠ Error searching: ${error.message}`);
    return null;
  }
}

// Find image block inside the callout
async function findImageInsideCallout(notion, calloutId) {
  try {
    const children = await notion.blocks.children.list({ block_id: calloutId, page_size: 100 });
    
    for (const block of children.results) {
      if (block.type === 'image') {
        log(`  ✓ Found image block inside callout`);
        return block.id;
      }
    }
    
    log(`  ⚠ No image block found inside callout`);
    return null;
  } catch (error) {
    log(`  ⚠ Error finding image: ${error.message}`);
    return null;
  }
}

async function findBlocks(notion) {
  try {
    log('  ℹ Scanning for command center callout...');
    const calloutId = await findCalloutBlockRecursive(notion, CONFIG.notion.pageId);
    
    if (!calloutId) {
      throw new Error('Command center callout not found');
    }
    
    log('  ℹ Scanning inside callout for image...');
    const imageId = await findImageInsideCallout(notion, calloutId);
    
    return { callout: calloutId, image: imageId };
  } catch (error) {
    throw new Error(`Find blocks failed: ${error.message}`);
  }
}

async function updateNotionPage(notion, data, aiMessage, gifUrl) {
  try {
    const blocks = await findBlocks(notion);
    const calloutId = formatNotionId(blocks.callout);
    
    const updateMessage = `🤖 COMMAND CENTER ONLINE\n\n${aiMessage}\n\n📊 Status: ${data.incompleteTasks}/${data.totalTasks} tasks | ${data.upcomingMeetings} meetings`;
    
    log(`  ℹ Updating callout text...`);
    await notion.blocks.update({
      block_id: calloutId,
      callout: {
        rich_text: [{ type: 'text', text: { content: updateMessage } }],
        icon: { type: 'emoji', emoji: '🤖' },
        color: 'blue_background',
      },
    });
    log(`  ✓ Callout text updated`);
    
    if (blocks.image) {
      const imageId = formatNotionId(blocks.image);
      log(`  ℹ Updating image inside callout...`);
      await notion.blocks.update({
        block_id: imageId,
        image: {
          external: { url: gifUrl }
        },
      });
      log(`  ✓ Image updated with Malayalam GIF`);
    }
  } catch (error) {
    throw new Error(`Update failed: ${error.message}`);
  }
}

async function main() {
  try {
    log('🚀 Alright, let\'s see what mess you\'ve made of your schedule today...');
    validateEnv();
    const notion = new Client({ auth: CONFIG.notion.apiKey });
    
    log('📊 Loading your tasks and meetings...');
    const tasksData = await fetchTasksData(notion);
    const meetingsData = await fetchMeetingsData(notion);
    const data = { ...tasksData, ...meetingsData, currentTime: new Date() };
    
    log(`  ✓ Total: ${data.totalTasks} tasks`);
    log(`  ✓ Incomplete (Status != Done): ${data.incompleteTasks}`);
    log(`  ✓ Overdue: ${data.overdueTasks}`);
    log(`  ✓ Meetings: ${data.upcomingMeetings}`);
    
    log('🎭 Analyzing your situation with Malayalam wit...');
    const aiMessage = generateMessage(data);
    log(`  ✓ Generated sarcastic assessment`);
    
    log('🎬 Finding the perfect Malayalam joke GIF...');
    const gifQuery = getGifSearchQuery(data);
    const gifUrl = await searchGiphyGif(gifQuery);
    
    log('📝 Updating command center...');
    await updateNotionPage(notion, data, aiMessage, gifUrl);
    
    log('═════════════════════════════════════════');
    log('✨ There. Now stop wasting time and GET TO WORK!');
    log('═════════════════════════════════════════');
    process.exit(0);
  } catch (error) {
    logError(error.message);
    process.exit(1);
  }
}

main();
