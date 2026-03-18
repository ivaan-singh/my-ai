const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const PORT = process.env.PORT || 3000;

// ============================
// Chat + Budget Helpers
// ============================
let chatHistory = [];
let totalSpent = 0;

const MAX_TOKENS = 1000;
const HISTORY_TOKENS = 15000;
const TOKEN_COST_INPUT = 0.003;
const TOKEN_COST_OUTPUT = 0.006;
const BUDGET = 30;

// Estimate tokens
function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

// Calculate cost
function calcMessageCost(inputTokens, outputTokens) {
  return (inputTokens / 1000) * TOKEN_COST_INPUT +
         (outputTokens / 1000) * TOKEN_COST_OUTPUT;
}

// Trim chat history
function trimChatHistory() {
  let sum = 0;
  const trimmed = [];
  for (let i = chatHistory.length - 1; i >= 0; i--) {
    sum += chatHistory[i].tokens;
    if (sum > HISTORY_TOKENS) break;
    trimmed.unshift(chatHistory[i]);
  }
  chatHistory = trimmed;
}

// Decide if web search is needed
function needsWebSearch(message) {
  const keywords = ["today", "score", "live", "current", "matches", "weather"];
  const msgLower = message.toLowerCase();
  return keywords.some(k => msgLower.includes(k));
}

// Send message to Claude
async function sendMessage(userPrompt) {
  const inputTokens = estimateTokens(userPrompt);

  trimChatHistory();

  const messages = chatHistory.map(m => ({ role: m.role, content: m.content }));
  messages.push({ role: "user", content: userPrompt });

  const useWebSearch = needsWebSearch(userPrompt);
  const tools = useWebSearch ? [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }] : [];

  const body = JSON.stringify({
    model: "claude-sonnet-4-5",
    messages: messages,
    tools: tools,
    max_tokens: MAX_TOKENS
  });

  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'web-search-2025-03-05',
        'Content-Length': Buffer.byteLength(body)
      }
    };

    const proxyReq = https.request(options, proxyRes => {
      let responseData = '';
      proxyRes.on('data', chunk => responseData += chunk);
      proxyRes.on('end', () => {
        try {
          const data = JSON.parse(responseData);
          const output = data?.completion || data?.message?.content || "";
          const outputTokens = estimateTokens(output);

          // Update chat history & cost
          chatHistory.push({ role: "user", content: userPrompt, tokens: inputTokens });
          chatHistory.push({ role: "assistant", content: output, tokens: outputTokens });
          const cost = calcMessageCost(inputTokens, outputTokens);
          totalSpent += cost;
          const remaining = Math.floor((BUDGET - totalSpent) / cost);

          resolve({ output, cost, totalSpent, remaining, usedWebSearch: useWebSearch });
        } catch (err) {
          reject(err);
        }
      });
    });

    proxyReq.on('error', err => reject(err));
    proxyReq.write(body);
    proxyReq.end();
  });
}

// ============================
// MIME types
// ============================
const MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
};

// ============================
// Server
// ============================
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204); res.end(); return;
  }

  // API endpoint
  if (req.method === 'POST' && req.url === '/api/chat') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { prompt } = JSON.parse(body);
        const result = await sendMessage(prompt);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        console.error('Error handling chat:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // Serve static files
  let filePath = req.url === '/' ? '/index.html' : req.url;
  filePath = path.join(__dirname, filePath);

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
});
