const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;
const DB = path.join(__dirname, 'links.json');

// ── Init DB ──
if (!fs.existsSync(DB)) fs.writeFileSync(DB, JSON.stringify([]));
const getLinks = () => JSON.parse(fs.readFileSync(DB));
const saveLinks = (data) => fs.writeFileSync(DB, JSON.stringify(data, null, 2));

app.use(express.json());
app.use(express.static('public'));

// ── Shorten API ──
app.post('/api/shorten', (req, res) => {
  const { url, alias } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });

  const links = getLinks();
  const code = alias || Math.random().toString(36).slice(2, 8);

  if (links.find(l => l.code === code))
    return res.status(409).json({ error: 'Alias already taken!' });

  const entry = {
    id: Date.now(),
    original: url.startsWith('http') ? url : 'https://' + url,
    code,
    clicks: 0,
    weekData: [0,0,0,0,0,0,0],
    created: new Date().toISOString()
  };

  links.unshift(entry);
  saveLinks(links);

  res.json({ short: `${req.protocol}://${req.get('host')}/${code}`, code });
});

// ── Stats API ──
app.get('/api/links', (req, res) => res.json(getLinks()));

// ── Redirect ──
app.get('/:code', (req, res) => {
  const links = getLinks();
  const link = links.find(l => l.code === req.params.code);
  if (!link) return res.status(404).send('Link not found!');

  // Track click
  link.clicks++;
  const day = new Date().getDay();
  link.weekData[day === 0 ? 6 : day - 1]++;
  saveLinks(links);

  res.redirect(link.original);
});

app.listen(PORT, () => console.log(`✅ SnapURL running at http://localhost:${PORT}`));
