const express = require('express');
const fetch = require('node-fetch');
const xml2js = require('xml2js');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Data Storage ──────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function loadJSON(file, def = {}) {
  const p = path.join(DATA_DIR, file);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf-8')) : def;
}
function saveJSON(file, data) {
  fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(data, null, 2));
}

// ─── Middleware ─────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// CORS headers (for external access)
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ─── Proxy Endpoint (kills CORS) ──────────────────────────────
app.get('/api/proxy', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).json({ error: 'Missing url' });

  try {
    const headers = {
      'User-Agent': 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3',
    };
    if (req.headers.range) headers['Range'] = req.headers.range;

    const response = await fetch(targetUrl, {
      headers,
      redirect: 'follow',
      timeout: 30000,
    });

    res.status(response.status);
    ['content-type', 'content-length', 'accept-ranges', 'content-range'].forEach(h => {
      const v = response.headers.get(h);
      if (v) res.set(h, v);
    });

    response.body.pipe(res);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ─── Fetch Remote M3U ──────────────────────────────────────────
app.post('/api/fetch-m3u', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'Missing url' });

  try {
    const response = await fetch(url, {
      timeout: 15000,
      headers: { 'User-Agent': 'IPTV-Player/2.0' },
    });
    const text = await response.text();
    res.json({ content: text });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ─── EPG Fetch & Parse ────────────────────────────────────────
const epgCache = { data: null, ts: 0 };
const CACHE_TTL = 3600000; // 1 hour

app.post('/api/epg', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'Missing EPG URL' });

  // Use cache if fresh
  if (epgCache.data && Date.now() - epgCache.ts < CACHE_TTL) {
    return res.json(epgCache.data);
  }

  try {
    const response = await fetch(url, {
      timeout: 30000,
      headers: { 'User-Agent': 'IPTV-Player/2.0' },
    });
    const xml = await response.text();

    const parser = new xml2js.Parser();
    const result = await parser.parseStringPromise(xml);

    const programs = {};
    if (result.tv && result.tv.programme) {
      for (const p of result.tv.programme) {
        const channelId = p.$.channel;
        if (!programs[channelId]) programs[channelId] = [];

        const title = p.title && p.title[0] ? (p.title[0]._ || p.title[0]) : 'Sin título';
        const desc = p.desc && p.desc[0] ? (p.desc[0]._ || p.desc[0]) : '';
        const start = p.$.start || '';
        const stop = p.$.stop || '';

        programs[channelId].push({ title, desc, start, stop });
      }
    }

    // Sort by start time
    for (const ch in programs) {
      programs[ch].sort((a, b) => a.start.localeCompare(b.start));
    }

    epgCache.data = { programs };
    epgCache.ts = Date.now();

    res.json({ programs });
  } catch (err) {
    res.status(502).json({ error: 'EPG fetch error: ' + err.message });
  }
});

// ─── Recordings ───────────────────────────────────────────────
const RECORDINGS_DIR = path.join(DATA_DIR, 'recordings');
if (!fs.existsSync(RECORDINGS_DIR)) fs.mkdirSync(RECORDINGS_DIR, { recursive: true });

let activeRecordings = {};

app.post('/api/record/start', (req, res) => {
  const { url, name } = req.body;
  if (!url) return res.status(400).json({ error: 'Missing url' });

  const id = Date.now().toString(36);
  const filename = `${id}_${(name || 'recording').replace(/[^a-z0-9]/gi, '_')}.ts`;
  const filepath = path.join(RECORDINGS_DIR, filename);

  // Start recording in background
  fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3',
    },
  }).then(response => {
    const ws = fs.createWriteStream(filepath);
    response.body.pipe(ws);
    activeRecordings[id] = { name, filepath, filename, started: Date.now(), ws, body: response.body };

    response.body.on('end', () => {
      ws.end();
      delete activeRecordings[id];
    });
    response.body.on('error', () => {
      ws.end();
      delete activeRecordings[id];
    });
  }).catch(err => {
    delete activeRecordings[id];
  });

  res.json({ id, filename, message: 'Recording started' });
});

app.post('/api/record/stop', (req, res) => {
  const { id } = req.body;
  if (activeRecordings[id]) {
    activeRecordings[id].body.destroy();
    activeRecordings[id].ws.end();
    delete activeRecordings[id];
    res.json({ message: 'Recording stopped' });
  } else {
    res.status(404).json({ error: 'Recording not found' });
  }
});

app.get('/api/record/list', (req, res) => {
  const files = fs.readdirSync(RECORDINGS_DIR)
    .filter(f => f.endsWith('.ts'))
    .map(f => {
      const stat = fs.statSync(path.join(RECORDINGS_DIR, f));
      return { name: f, size: stat.size, created: stat.mtime };
    });
  res.json({ files, active: Object.keys(activeRecordings).length });
});

// ─── Settings (server-side backup) ────────────────────────────
app.get('/api/settings', (req, res) => {
  res.json(loadJSON('settings.json'));
});

app.post('/api/settings', (req, res) => {
  saveJSON('settings.json', req.body);
  res.json({ ok: true });
});

// ─── Multi-playlist Management ─────────────────────────────────
app.get('/api/playlists', (req, res) => {
  res.json(loadJSON('playlists.json', { lists: [] }));
});

app.post('/api/playlists', (req, res) => {
  saveJSON('playlists.json', req.body);
  res.json({ ok: true });
});

// ─── Kids Mode PIN ─────────────────────────────────────────────
app.post('/api/kids/verify', (req, res) => {
  const settings = loadJSON('settings.json');
  const { pin } = req.body;
  if (!settings.kidsPin) return res.json({ ok: true, configured: false });
  res.json({ ok: pin === settings.kidsPin, configured: true });
});

// ─── Fallback to SPA ──────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Start ─────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  📺 IPTV Player running!`);
  console.log(`  ───────────────────────────────`);
  console.log(`  Local:   http://localhost:${PORT}`);
  console.log(`  Network: http://0.0.0.0:${PORT}\n`);
  console.log(`  Open the URL in any device on your network.`);
  console.log(`  Press Ctrl+C to stop.\n`);
});
