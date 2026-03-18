require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const https = require('https');
const Groq = require('groq-sdk');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const JWT_SECRET = process.env.JWT_SECRET;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);
const groq = new Groq({ apiKey: GROQ_API_KEY });
const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// === Config endpoint (exposes non-secret config to frontend) ===
app.get('/api/config', (req, res) => {
  res.json({ googleClientId: GOOGLE_CLIENT_ID });
});

// === MongoDB Connection ===
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('MongoDB connected'))
  .catch(err => {
    console.error('\n=== MongoDB Connection Failed ===');
    console.error('Make sure MongoDB is running: sudo systemctl start mongod');
    console.error('Or: mongod --dbpath /data/db');
    console.error('Error:', err.message);
    console.error('=================================\n');
  });

// === Models ===
const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true, trim: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  password_hash: { type: String, default: null },
  google_id: { type: String, default: null },
  profile_picture: { type: String, default: null },
  genres: { type: [String], default: [] },
  created_at: { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);

const wishlistSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  game_title: { type: String, required: true },
  added_at: { type: Date, default: Date.now }
});
wishlistSchema.index({ user_id: 1, game_title: 1 }, { unique: true });
const Wishlist = mongoose.model('Wishlist', wishlistSchema);

const priceHistorySchema = new mongoose.Schema({
  game_title: { type: String, required: true },
  normal_price: { type: Number, required: true },
  sale_price: { type: Number, required: true },
  savings_percent: { type: Number, required: true },
  store: { type: String, required: true },
  deal_rating: { type: Number, default: null },
  steam_rating: { type: Number, default: null },
  timestamp: { type: Date, default: Date.now }
});
priceHistorySchema.index({ game_title: 1, store: 1, timestamp: -1 });
const PriceHistory = mongoose.model('PriceHistory', priceHistorySchema);

const gameCacheSchema = new mongoose.Schema({
  game_title: { type: String, required: true },
  steam_app_id: { type: String, required: true, unique: true },
  genres: { type: [String], default: [] },
  tags: { type: [String], default: [] },
  cached_at: { type: Date, default: Date.now }
});
const GameCache = mongoose.model('GameCache', gameCacheSchema);

// Fetch Steam genres for deals, using cache
async function fetchSteamGenres(deals) {
  const CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days
  const now = Date.now();

  // Collect unique steamAppIDs
  const appIdMap = {}; // appId -> deal titles
  for (const d of deals) {
    if (d.steamAppID) {
      if (!appIdMap[d.steamAppID]) appIdMap[d.steamAppID] = [];
      appIdMap[d.steamAppID].push(d.title);
    }
  }
  const allAppIds = Object.keys(appIdMap);
  if (!allAppIds.length) return {};

  // Check cache for all
  const cached = await GameCache.find({ steam_app_id: { $in: allAppIds } }).lean();
  const cacheMap = {};
  const needFetch = [];
  for (const c of cached) {
    if (now - new Date(c.cached_at).getTime() < CACHE_TTL) {
      cacheMap[c.steam_app_id] = c.genres;
    } else {
      needFetch.push(c.steam_app_id);
    }
  }
  const cachedIds = new Set(cached.map(c => c.steam_app_id));
  for (const id of allAppIds) {
    if (!cachedIds.has(id)) needFetch.push(id);
  }

  // Fetch uncached from Steam with delays
  for (let i = 0; i < needFetch.length; i++) {
    const appId = needFetch[i];
    try {
      if (i > 0) await new Promise(r => setTimeout(r, 200));
      const data = await fetchJSON('https://store.steampowered.com/api/appdetails?appids=' + appId);
      const appData = data?.[appId];
      if (appData?.success && appData.data?.genres) {
        const genres = appData.data.genres.map(g => g.description);
        cacheMap[appId] = genres;
        await GameCache.findOneAndUpdate(
          { steam_app_id: appId },
          { steam_app_id: appId, game_title: appIdMap[appId][0], genres, cached_at: new Date() },
          { upsert: true }
        );
      } else {
        cacheMap[appId] = [];
        await GameCache.findOneAndUpdate(
          { steam_app_id: appId },
          { steam_app_id: appId, game_title: appIdMap[appId][0], genres: [], cached_at: new Date() },
          { upsert: true }
        );
      }
    } catch {
      // Skip failures silently
    }
  }

  // Build title -> genres map
  const result = {};
  for (const [appId, titles] of Object.entries(appIdMap)) {
    const genres = cacheMap[appId] || [];
    for (const title of titles) {
      result[title] = genres;
    }
  }
  return result;
}

// Save a price snapshot for all current deals (max once per day per game+store)
async function savePriceSnapshot(deals) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  for (const deal of deals) {
    try {
      const existing = await PriceHistory.findOne({
        game_title: deal.title,
        store: deal.store,
        timestamp: { $gte: today, $lt: tomorrow }
      });
      if (!existing) {
        await PriceHistory.create({
          game_title: deal.title,
          normal_price: parseFloat(deal.normalPrice),
          sale_price: parseFloat(deal.salePrice),
          savings_percent: deal.savings,
          store: deal.store,
          deal_rating: deal.dealRating,
          steam_rating: deal.steamRatingPercent || null,
          timestamp: new Date()
        });
      }
    } catch (e) {
      // skip duplicates silently
    }
  }
}

// Seed 30 days of realistic price history for the top 5 deals
async function seedPriceHistory(deals) {
  const top5 = deals.slice(0, 5);
  const existing = await PriceHistory.countDocuments();
  if (existing > 50) return; // already seeded

  for (const deal of top5) {
    const normalPrice = parseFloat(deal.normalPrice);
    const currentSale = parseFloat(deal.salePrice);
    const store = deal.store;

    for (let daysAgo = 30; daysAgo >= 1; daysAgo--) {
      const date = new Date();
      date.setDate(date.getDate() - daysAgo);
      date.setHours(12, 0, 0, 0);

      // Simulate realistic price patterns: mostly normal price with occasional sales
      let salePrice;
      const rand = Math.random();
      if (daysAgo <= 3) {
        // Last 3 days: trend toward current sale price
        salePrice = currentSale + (normalPrice - currentSale) * (daysAgo / 10) * Math.random();
      } else if (rand < 0.25) {
        // 25% chance: on sale (various depths)
        const saleDepth = 0.3 + Math.random() * 0.5; // 30-80% off
        salePrice = normalPrice * (1 - saleDepth);
      } else if (rand < 0.4) {
        // 15% chance: modest discount
        salePrice = normalPrice * (0.8 + Math.random() * 0.15);
      } else {
        // 60% chance: full price or near-full
        salePrice = normalPrice * (0.95 + Math.random() * 0.05);
      }

      salePrice = Math.max(0, parseFloat(salePrice.toFixed(2)));
      const savings = normalPrice > 0 ? Math.round(((normalPrice - salePrice) / normalPrice) * 100) : 0;

      try {
        await PriceHistory.create({
          game_title: deal.title,
          normal_price: normalPrice,
          sale_price: salePrice,
          savings_percent: savings,
          store: store,
          deal_rating: deal.dealRating,
          steam_rating: deal.steamRatingPercent || null,
          timestamp: date
        });
      } catch (e) {}
    }
  }
  console.log('Price history seeded for top 5 deals');
}

// === Auth Middleware ===
function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  try {
    const decoded = jwt.verify(header.split(' ')[1], JWT_SECRET);
    req.userId = decoded.id;
    req.username = decoded.username;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// Optional auth — sets req.userId if valid token present, but doesn't block
function optionalAuth(req, res, next) {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    try {
      const decoded = jwt.verify(header.split(' ')[1], JWT_SECRET);
      req.userId = decoded.id;
      req.username = decoded.username;
    } catch {}
  }
  next();
}

// Calculate buy/wait signal from price history
async function calculateSignals(deals) {
  const titles = deals.map(d => d.title);
  const history = await PriceHistory.find({ game_title: { $in: titles } }).lean();

  // Group history by game title
  const histByTitle = {};
  for (const h of history) {
    if (!histByTitle[h.game_title]) histByTitle[h.game_title] = [];
    histByTitle[h.game_title].push(h);
  }

  const now = Date.now();
  const day90 = 90 * 24 * 60 * 60 * 1000;
  const day30 = 30 * 24 * 60 * 60 * 1000;

  const result = {};
  for (const deal of deals) {
    const records = histByTitle[deal.title];
    const currentPrice = parseFloat(deal.salePrice);

    if (!records || records.length < 3) {
      result[deal.title] = { signal: 'NEW', lowestEver: null };
      continue;
    }

    const allPrices = records.map(r => r.sale_price);
    const lowestEver = Math.min(...allPrices);

    // Check for downward trend over last 30 days
    const recent30 = records.filter(r => now - new Date(r.timestamp).getTime() < day30);
    let trending = false;
    if (recent30.length >= 3) {
      recent30.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
      const firstHalf = recent30.slice(0, Math.floor(recent30.length / 2));
      const secondHalf = recent30.slice(Math.floor(recent30.length / 2));
      const avgFirst = firstHalf.reduce((s, r) => s + r.sale_price, 0) / firstHalf.length;
      const avgSecond = secondHalf.reduce((s, r) => s + r.sale_price, 0) / secondHalf.length;
      if (avgSecond < avgFirst * 0.9) trending = true;
    }

    // Check if it was cheaper in last 90 days
    const recent90 = records.filter(r => now - new Date(r.timestamp).getTime() < day90);
    const wasCheaper = recent90.some(r => r.sale_price < currentPrice * 0.95);

    let signal;
    if (currentPrice <= lowestEver) {
      signal = 'ALL-TIME LOW';
    } else if (currentPrice <= lowestEver * 1.10) {
      signal = 'NEAR LOWEST';
    } else if (trending) {
      signal = 'PRICE DROPPING';
    } else if (wasCheaper) {
      signal = 'WAIT';
    } else {
      signal = 'GOOD DEAL';
    }

    result[deal.title] = { signal, lowestEver };
  }
  return result;
}

// === Auth Routes ===
app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;
    if (!username || !email || !password) {
      return res.status(400).json({ error: 'Username, email, and password are required' });
    }
    if (username.length < 3) {
      return res.status(400).json({ error: 'Username must be at least 3 characters' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }
    if (!/\S+@\S+\.\S+/.test(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }
    const existingEmail = await User.findOne({ email: email.toLowerCase() });
    if (existingEmail) {
      return res.status(400).json({ error: 'Email already registered' });
    }
    const existingUsername = await User.findOne({ username });
    if (existingUsername) {
      return res.status(400).json({ error: 'Username already taken' });
    }
    const password_hash = await bcrypt.hash(password, 10);
    const user = await User.create({ username, email: email.toLowerCase(), password_hash });
    const token = jwt.sign({ id: user._id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: user._id, username: user.username, email: user.email, profile_picture: null, genres: [] } });
  } catch (err) {
    res.status(500).json({ error: 'Registration failed. Please try again.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }
    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user || !user.password_hash) {
      return res.status(400).json({ error: !user ? 'Invalid email or password' : 'This account uses Google Sign-In' });
    }
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(400).json({ error: 'Invalid email or password' });
    }
    const token = jwt.sign({ id: user._id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: user._id, username: user.username, email: user.email, profile_picture: user.profile_picture, genres: user.genres || [] } });
  } catch (err) {
    res.status(500).json({ error: 'Login failed. Please try again.' });
  }
});

app.get('/api/auth/me', auth, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select('-password_hash');
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ id: user._id, username: user.username, email: user.email, profile_picture: user.profile_picture, genres: user.genres || [] });
  } catch {
    res.status(500).json({ error: 'Failed to get user info' });
  }
});

app.post('/api/auth/google', async (req, res) => {
  try {
    const { credential } = req.body;
    if (!credential) return res.status(400).json({ error: 'Google credential required' });

    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    const { sub: google_id, email, name, picture } = payload;

    let user = await User.findOne({ email: email.toLowerCase() });
    if (user) {
      if (!user.google_id) {
        user.google_id = google_id;
        user.profile_picture = picture;
        await user.save();
      }
    } else {
      let username = name.replace(/\s+/g, '').toLowerCase();
      const existing = await User.findOne({ username });
      if (existing) username = username + Math.floor(Math.random() * 9000 + 1000);
      user = await User.create({
        username,
        email: email.toLowerCase(),
        google_id,
        profile_picture: picture,
      });
    }

    const token = jwt.sign({ id: user._id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: user._id, username: user.username, email: user.email, profile_picture: user.profile_picture, genres: user.genres || [] } });
  } catch (err) {
    console.error('Google auth error:', err.message);
    res.status(400).json({ error: 'Google sign-in failed. Please try again.' });
  }
});

// === Preferences ===
const VALID_GENRES = ['Action', 'RPG', 'Strategy', 'FPS', 'Adventure', 'Puzzle', 'Simulation', 'Sports', 'Horror', 'Indie', 'Open World', 'Co-op', 'Story Rich'];

app.get('/api/preferences', auth, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select('genres');
    res.json({ genres: user?.genres || [] });
  } catch {
    res.status(500).json({ error: 'Failed to fetch preferences' });
  }
});

app.put('/api/preferences', auth, async (req, res) => {
  try {
    const { genres } = req.body;
    if (!Array.isArray(genres)) return res.status(400).json({ error: 'genres must be an array' });
    const filtered = genres.filter(g => VALID_GENRES.includes(g));
    await User.findByIdAndUpdate(req.userId, { genres: filtered });
    res.json({ genres: filtered });
  } catch {
    res.status(500).json({ error: 'Failed to save preferences' });
  }
});

// === Wishlist (user-specific, requires auth) ===
function normalize(s) {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

app.get('/api/wishlist', auth, async (req, res) => {
  try {
    const items = await Wishlist.find({ user_id: req.userId }).sort({ added_at: -1 });
    res.json(items.map(w => w.game_title));
  } catch {
    res.json([]);
  }
});

app.post('/api/wishlist', auth, async (req, res) => {
  try {
    const { gameTitle } = req.body;
    if (!gameTitle) return res.status(400).json({ error: 'gameTitle required' });
    await Wishlist.findOneAndUpdate(
      { user_id: req.userId, game_title: gameTitle },
      { user_id: req.userId, game_title: gameTitle, added_at: new Date() },
      { upsert: true }
    );
    const items = await Wishlist.find({ user_id: req.userId }).sort({ added_at: -1 });
    res.json(items.map(w => w.game_title));
  } catch {
    res.status(500).json({ error: 'Failed to add to wishlist' });
  }
});

app.delete('/api/wishlist', auth, async (req, res) => {
  try {
    const { gameTitle } = req.body;
    if (!gameTitle) return res.status(400).json({ error: 'gameTitle required' });
    await Wishlist.deleteOne({ user_id: req.userId, game_title: gameTitle });
    const items = await Wishlist.find({ user_id: req.userId }).sort({ added_at: -1 });
    res.json(items.map(w => w.game_title));
  } catch {
    res.status(500).json({ error: 'Failed to remove from wishlist' });
  }
});

// === Price History ===
app.get('/api/price-history/:gameTitle', async (req, res) => {
  try {
    const gameTitle = decodeURIComponent(req.params.gameTitle);
    const history = await PriceHistory.find({ game_title: gameTitle })
      .sort({ timestamp: 1 })
      .lean();
    res.json(history);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch price history' });
  }
});

// === Deals (public) ===
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

app.get('/api/deals', optionalAuth, async (req, res) => {
  try {
    const [stores, rawDeals] = await Promise.all([
      fetchJSON('https://www.cheapshark.com/api/1.0/stores'),
      fetchJSON('https://www.cheapshark.com/api/1.0/deals?pageSize=20&sortBy=Deal%20Rating'),
    ]);

    const storeMap = {};
    stores.forEach((s) => { storeMap[s.storeID] = s.storeName; });

    const deals = rawDeals.map((d) => ({
      title: d.title,
      normalPrice: d.normalPrice,
      salePrice: d.salePrice,
      savings: Math.round(parseFloat(d.savings)),
      store: storeMap[d.storeID] || 'Unknown',
      dealRating: parseFloat(d.dealRating),
      thumb: d.thumb,
      dealID: d.dealID,
      steamAppID: d.steamAppID || null,
      steamRatingPercent: d.steamRatingPercent ? parseInt(d.steamRatingPercent) : null,
      steamRatingText: d.steamRatingText || null,
      steamRatingCount: d.steamRatingCount ? parseInt(d.steamRatingCount) : 0,
    }));

    // Fetch Steam genres (cached, non-blocking for individual failures)
    let genreMap = {};
    try {
      genreMap = await fetchSteamGenres(deals);
    } catch { /* skip if entire genre fetch fails */ }

    const groups = {};
    deals.forEach(d => {
      const key = normalize(d.title);
      if (!groups[key]) groups[key] = [];
      groups[key].push(d);
    });
    const groupedDeals = Object.values(groups).map(group => {
      group.sort((a, b) => parseFloat(a.salePrice) - parseFloat(b.salePrice));
      const primary = { ...group[0] };
      primary.otherDeals = group.slice(1).map(d => ({
        store: d.store,
        salePrice: d.salePrice,
        normalPrice: d.normalPrice,
        savings: d.savings,
        dealID: d.dealID,
        dealRating: d.dealRating,
      }));
      primary.genres = genreMap[primary.title] || [];
      return primary;
    });

    // Calculate buy/wait signals from price history
    let signalMap = {};
    try {
      signalMap = await calculateSignals(groupedDeals);
    } catch {}
    for (const deal of groupedDeals) {
      const sig = signalMap[deal.title];
      deal.signal = sig ? sig.signal : 'NEW';
      deal.lowestEver = sig ? sig.lowestEver : null;
    }

    // Build deal list for AI prompt
    const dealList = groupedDeals
      .map((d, i) => {
        const steam = d.steamRatingPercent != null
          ? `Steam: ${d.steamRatingPercent}% "${d.steamRatingText}" (${d.steamRatingCount} reviews)`
          : 'Steam: No reviews';
        const genres = d.genres.length > 0 ? `Genres: ${d.genres.join(', ')}` : '';
        const signal = d.signal !== 'NEW' ? `Signal: ${d.signal}` : '';
        let line = `${i + 1}. "${d.title}" - $${d.salePrice} at ${d.store} (was $${d.normalPrice}, ${d.savings}% off) - Deal Rating: ${d.dealRating}/10 - ${steam}`;
        if (genres) line += ` - ${genres}`;
        if (signal) line += ` - ${signal}`;
        if (d.otherDeals.length > 0) {
          line += ' [Also at: ' + d.otherDeals.map(od => od.store + ' ($' + od.salePrice + ')').join(', ') + ']';
        }
        return line;
      })
      .join('\n');

    // Check if user has genre preferences for personalized analysis
    let userGenres = [];
    let personalized = false;
    if (req.userId) {
      try {
        const user = await User.findById(req.userId).select('genres').lean();
        if (user?.genres?.length) {
          userGenres = user.genres;
          personalized = true;
        }
      } catch {}
    }

    const systemPrompt = 'You are a savvy PC gaming deal analyst. You have Steam review scores, genre data, and buy/wait price signals for each game. FACTOR GAME QUALITY INTO YOUR ANALYSIS. A 95% off game with "Overwhelmingly Negative" reviews is NOT a good deal. Price alone does not make a deal good — quality matters. Use buy/wait signals: ALL-TIME LOW means buy now urgently, WAIT means it was cheaper recently. Respond using ONLY these HTML tags: <h3>, <p>, <strong>, <em>, <ul>, <li>. Do NOT use markdown. Do NOT use code blocks. Do NOT wrap output in ```.';

    let userPrompt;
    if (personalized) {
      userPrompt = `This user prefers these game genres: ${userGenres.join(', ')}. Personalize your analysis:
1. Prioritize recommending deals that match their preferred genres
2. For matching games, explain why it fits their taste
3. Factor in buy/wait signals — if a game is at its all-time low, emphasize urgency. If it was cheaper recently, suggest waiting.
4. Call out any free games that match their preferences
5. Keep it concise and actionable

Analyze these PC game deals:\n\n${dealList}\n\nRespond with:\n1. <h3>Picks For You</h3> - top 3 deals matching user's preferred genres with buy/wait advice. Mention the signal.\n2. <h3>Other Top Deals</h3> - 2-3 other good deals outside their genres\n3. <h3>Skip These</h3> - deals not worth it\n4. <h3>Market Summary</h3> - 2-3 sentence personalized overview`;
    } else {
      userPrompt = `Analyze these PC game deals:\n\n${dealList}\n\nRespond with:\n1. <h3>Top Picks</h3> - top 3 value deals considering BOTH price AND Steam reviews. Mention the Steam rating and buy/wait signal.\n2. <h3>Skip These</h3> - deals not worth it. Call out poorly reviewed games even if heavily discounted.\n3. <h3>Free Games</h3> - any free games highlighted, with review quality noted\n4. <h3>Market Summary</h3> - 2-3 sentence overview factoring in game quality`;
    }

    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.7,
      max_tokens: 1000,
    });

    let analysis = completion.choices[0].message.content;
    analysis = analysis.replace(/```html?\n?/g, '').replace(/```\n?/g, '').trim();

    // Save price snapshot & seed if needed (non-blocking)
    savePriceSnapshot(groupedDeals).catch(() => {});
    seedPriceHistory(groupedDeals).catch(() => {});

    res.json({ deals: groupedDeals, analysis, personalized, timestamp: new Date().toISOString() });
  } catch (err) {
    console.error('API Error:', err.message);
    res.status(500).json({ error: 'Failed to fetch and analyze deals. Please try again.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', function() {
    console.log('DealHunter running on port ' + PORT);
});
