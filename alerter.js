const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const https = require('https');
const fs = require('fs');
const path = require('path');

// === Config ===
const MY_NUMBER = '919167664916@c.us';
const CHECK_INTERVAL = 30; // minutes

// === Paths ===
const WISHLIST_FILE = path.join(__dirname, 'wishlist.json');
const ALERTS_FILE = path.join(__dirname, 'alerts-sent.json');

// === WhatsApp Client ===
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  },
});

console.log('Starting WhatsApp connection...');
console.log('Scan the QR code below with your phone:\n');

client.on('qr', (qr) => {
  qrcode.generate(qr, { small: true });
});

client.on('authenticated', () => {
  console.log('\nSession authenticated. Loading WhatsApp...');
});

client.on('auth_failure', (msg) => {
  console.error('Authentication failed:', msg);
  process.exit(1);
});

client.on('ready', async () => {
  const info = client.info;
  console.log('\nWhatsApp connected successfully!');
  console.log('Account:', info.pushname);
  console.log('Number:', info.wid.user);
  console.log('Platform:', info.platform);
  console.log('\nSession saved — you won\'t need to scan again.');
  console.log('Deal alerts will be sent to:', MY_NUMBER);
  console.log('Check interval:', CHECK_INTERVAL, 'minutes\n');

  // Run immediately, then on interval
  await checkDeals();
  setInterval(checkDeals, CHECK_INTERVAL * 60 * 1000);
});

client.on('disconnected', (reason) => {
  console.log('Disconnected:', reason);
  process.exit(0);
});

// === Helpers ===

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error('Failed to parse response')); }
      });
    }).on('error', reject);
  });
}

function readJSON(filepath) {
  try { return JSON.parse(fs.readFileSync(filepath, 'utf8')); }
  catch { return []; }
}

function writeJSON(filepath, data) {
  fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
}

function normalize(s) {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function todayKey() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function readAlertsSent() {
  const data = readJSON(ALERTS_FILE);
  if (data && data.date === todayKey()) {
    return data;
  }
  // New day — reset
  return { date: todayKey(), sent: [] };
}

function saveAlertsSent(data) {
  writeJSON(ALERTS_FILE, data);
}

function timestamp() {
  return new Date().toLocaleTimeString('en-US', { hour12: false });
}

// === Deal Checking ===

async function checkDeals() {
  console.log(`[${timestamp()}] Checking for wishlist deals...`);

  const wishlist = readJSON(WISHLIST_FILE);
  if (!wishlist.length) {
    console.log(`[${timestamp()}] Wishlist is empty. Nothing to check.`);
    logNextCheck();
    return;
  }
  console.log(`[${timestamp()}] Wishlist: ${wishlist.join(', ')}`);

  let rawDeals, stores;
  try {
    [rawDeals, stores] = await Promise.all([
      fetchJSON('https://www.cheapshark.com/api/1.0/deals?pageSize=20&sortBy=Deal%20Rating'),
      fetchJSON('https://www.cheapshark.com/api/1.0/stores'),
    ]);
  } catch (err) {
    console.error(`[${timestamp()}] Failed to fetch deals:`, err.message);
    logNextCheck();
    return;
  }

  const storeMap = {};
  stores.forEach((s) => { storeMap[s.storeID] = s.storeName; });

  const deals = rawDeals.map((d) => ({
    title: d.title,
    normalPrice: d.normalPrice,
    salePrice: d.salePrice,
    savings: Math.round(parseFloat(d.savings)),
    store: storeMap[d.storeID] || 'Unknown',
    dealID: d.dealID,
  }));

  // Find matches
  const matches = [];
  const alerts = readAlertsSent();

  for (const deal of deals) {
    const dn = normalize(deal.title);
    for (const wish of wishlist) {
      const wn = normalize(wish);
      if (dn === wn || dn.includes(wn) || wn.includes(dn)) {
        // Check if already alerted today
        const alertKey = normalize(deal.title) + '|' + deal.store;
        if (!alerts.sent.includes(alertKey)) {
          matches.push(deal);
          alerts.sent.push(alertKey);
        }
        break;
      }
    }
  }

  if (!matches.length) {
    console.log(`[${timestamp()}] No new wishlist matches found.`);
    logNextCheck();
    return;
  }

  console.log(`[${timestamp()}] Found ${matches.length} match(es):`);
  matches.forEach((m) => console.log(`  - ${m.title} at ${m.store} for $${m.salePrice}`));

  // Build message
  const blocks = matches.map((m) => {
    return [
      m.title,
      `Was $${m.normalPrice} - Now $${m.salePrice} (${m.savings}% off)`,
      `Store: ${m.store}`,
      `Link: https://www.cheapshark.com/redirect?dealID=${m.dealID}`,
    ].join('\n');
  });

  const message = 'DealHunter Alert\n\n' + blocks.join('\n\n');

  // Send
  try {
    await client.sendMessage(MY_NUMBER, message);
    console.log(`[${timestamp()}] Alert sent to ${MY_NUMBER}`);
    saveAlertsSent(alerts);
  } catch (err) {
    console.error(`[${timestamp()}] Failed to send message:`, err.message);
  }

  logNextCheck();
}

function logNextCheck() {
  const next = new Date(Date.now() + CHECK_INTERVAL * 60 * 1000);
  console.log(`[${timestamp()}] Next check at ${next.toLocaleTimeString('en-US', { hour12: false })}\n`);
}

client.initialize();
