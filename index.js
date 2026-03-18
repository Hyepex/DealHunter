// DealHunter v3 - AI-Powered Deal Analysis
require('dotenv').config();
const https = require('https');
const fs = require('fs');
const Groq = require('groq-sdk');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

function fetchData(url) {
    return new Promise(function(resolve, reject) {
        var parsed = new URL(url);
        var options = {
            hostname: parsed.hostname,
            path: parsed.pathname + parsed.search,
            headers: { 'User-Agent': 'DealHunter/1.0' }
        };
        https.get(options, function(response) {
            let data = '';
            response.on('data', function(chunk) { data += chunk; });
            response.on('end', function() {
                try { resolve(JSON.parse(data)); }
                catch (e) { reject(new Error('Failed to parse response from ' + parsed.hostname)); }
            });
        }).on('error', reject);
    });
}

async function analyzeDeals(deals) {
    // Build a summary of deals to send to the AI
    let dealSummary = deals.map(function(deal, index) {
        return `${index + 1}. "${deal.title}" - Was $${deal.normalPrice}, now $${deal.salePrice} (${deal.savings}% off) at ${deal.store} - Deal Rating: ${deal.dealRating}/10`;
    }).join('\n');

    const response = await groq.chat.completions.create({
        model: 'llama-3.3-70b-versatile',
        messages: [
            {
                role: 'system',
                content: 'You are a savvy PC gaming deal analyst. You help people find the best value for their money. Be concise, opinionated, and helpful. Use plain language, not marketing speak.'
            },
            {
                role: 'user',
                content: `Here are today's top PC game deals:\n\n${dealSummary}\n\nAnalyze these deals. Tell me:\n1. Which are the BEST deals and why (consider price, discount %, and if the game is well-known)\n2. Which deals to SKIP and why\n3. Any deals that are FREE - highlight those\n4. Your top 3 picks ranked\n\nKeep it short and punchy.`
            }
        ],
        temperature: 0.7,
        max_tokens: 800
    });

    return response.choices[0].message.content;
}

async function main() {
    // Step 1: Get store names
    console.log('Loading stores...');
    const stores = await fetchData('https://www.cheapshark.com/api/1.0/stores');
    const storeMap = {};
    stores.forEach(function(store) {
        storeMap[store.storeID] = store.storeName;
    });

    // Step 2: Fetch top deals
    console.log('Fetching deals...');
    const rawDeals = await fetchData('https://www.cheapshark.com/api/1.0/deals?pageSize=15&sortBy=Deal Rating');

    const deals = rawDeals.map(function(deal) {
        return {
            title: deal.title,
            normalPrice: deal.normalPrice,
            salePrice: deal.salePrice,
            savings: Math.round(parseFloat(deal.savings)),
            store: storeMap[deal.storeID] || 'Unknown',
            dealRating: deal.dealRating,
            dealID: deal.dealID
        };
    });

    // Step 3: Display the deals
    console.log('\n==========================================');
    console.log('  DEALHUNTER - AI-Powered Deal Tracker');
    console.log('  ' + new Date().toLocaleString());
    console.log('==========================================\n');

    deals.forEach(function(deal, index) {
        const tag = deal.salePrice === '0.00' ? ' [FREE]' : deal.savings >= 80 ? ' [INSANE]' : '';
        console.log(`  #${index + 1}  ${deal.title}${tag}`);
        console.log(`      $${deal.normalPrice} → $${deal.salePrice} (${deal.savings}% off) @ ${deal.store}`);
    });

    // Step 4: AI Analysis
    console.log('\n==========================================');
    console.log('  AI ANALYSIS (Llama 3.3 70B via Groq)');
    console.log('==========================================\n');
    console.log('  Thinking...\n');

    const analysis = await analyzeDeals(deals);
    console.log(analysis);

    // Step 5: Save everything
    const snapshot = {
        timestamp: new Date().toISOString(),
        deals: deals,
        aiAnalysis: analysis
    };

    let history = [];
    if (fs.existsSync('deal-history.json')) {
        history = JSON.parse(fs.readFileSync('deal-history.json', 'utf8'));
    }
    history.push(snapshot);
    fs.writeFileSync('deal-history.json', JSON.stringify(history, null, 2));

    console.log(`\nSnapshot #${history.length} saved with AI analysis.`);
}

main();