const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { MongoClient, ObjectId } = require('mongodb');
const app = express();
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;

const CONFIG = {
  RATE_PER_1000_IN: 3.4,   // India
  RATE_PER_1000_US: 12,    // US/UK/AU
  RATE_PER_1000_OTHER: 2,  // Other countries
  RATE_PER_1000: 3.01,      // Default rate
  MIN_WITHDRAW: 5,
  ADMIN_USER: process.env.ADMIN_USER || 'admin',
  ADMIN_PASS: process.env.ADMIN_PASS || 'snapurl@admin123'
};

let db;
async function connectDB() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  db = client.db('snapurl');
  console.log('✅ MongoDB connected!');
}

app.use(express.json());
app.use(express.static(path.join(__dirname)));

function hash(str) { return crypto.createHash('sha256').update(str).digest('hex'); }
function randCode(len=6) { return Math.random().toString(36).slice(2, 2+len); }

app.post('/api/register', async (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password) return res.status(400).json({ error: 'All fields required' });
  const exists = await db.collection('users').findOne({ $or: [{ email }, { username }] });
  if (exists) return res.status(409).json({ error: exists.email === email ? 'Email already registered!' : 'Username taken!' });
  const user = { username, email, password: hash(password), token: randCode(32), balance: 0, totalEarned: 0, totalLinks: 0, totalClicks: 0, joined: new Date(), status: 'active' };
  await db.collection('users').insertOne(user);
  const { password: _, _id, ...safe } = user;
  res.setHeader('Set-Cookie', `snaptoken=${user.token}; Max-Age=2592000; Path=/; SameSite=Lax`);
  res.json({ success: true, token: user.token, user: safe });
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  const user = await db.collection('users').findOne({ email, password: hash(password) });
  if (!user) return res.status(401).json({ error: 'Invalid email or password!' });
  if (user.status === 'banned') return res.status(403).json({ error: 'Account banned!' });
  const { password: _, _id, ...safe } = user;
  res.setHeader('Set-Cookie', `snaptoken=${user.token}; Max-Age=2592000; Path=/; SameSite=Lax`);
  res.json({ success: true, token: user.token, user: safe });
});

app.get('/api/me', async (req, res) => {
  const user = await db.collection('users').findOne({ token: req.headers.authorization });
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const { password: _, _id, ...safe } = user;
  res.json(safe);
});

app.post('/api/shorten', async (req, res) => {
  const user = await db.collection('users').findOne({ token: req.headers.authorization });
  if (!user) return res.status(401).json({ error: 'Login required!' });
  const { url, alias } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });
  const code = alias || randCode(6);
  const exists = await db.collection('links').findOne({ code });
  if (exists) return res.status(409).json({ error: 'Alias taken!' });
  const link = { userId: user._id, username: user.username, ownerToken: user.token, original: url.startsWith('http') ? url : 'https://' + url, code, clicks: 0, weekData: [0,0,0,0,0,0,0], earnings: 0, created: new Date() };
  await db.collection('links').insertOne(link);
  await db.collection('users').updateOne({ _id: user._id }, { $inc: { totalLinks: 1 } });
  res.json({ short: `${req.protocol}://${req.get('host')}/${code}`, code });
});

app.get('/api/my-links', async (req, res) => {
  const user = await db.collection('users').findOne({ token: req.headers.authorization });
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const links = await db.collection('links').find({ userId: user._id }).sort({ created: -1 }).toArray();
  res.json(links);
});

app.post('/api/withdraw', async (req, res) => {
  const user = await db.collection('users').findOne({ token: req.headers.authorization });
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const { amount, method, details } = req.body;
  if (!amount || !method || !details) return res.status(400).json({ error: 'All fields required' });
  if (amount < CONFIG.MIN_WITHDRAW) return res.status(400).json({ error: `Minimum withdrawal is $${CONFIG.MIN_WITHDRAW}` });
  if (user.balance < amount) return res.status(400).json({ error: 'Insufficient balance!' });
  await db.collection('users').updateOne({ _id: user._id }, { $inc: { balance: -amount } });
  await db.collection('withdrawals').insertOne({ userId: user._id, username: user.username, amount, method, details, status: 'pending', created: new Date() });
  res.json({ success: true, message: 'Withdrawal request submitted!' });
});

app.get('/api/my-withdrawals', async (req, res) => {
  const user = await db.collection('users').findOne({ token: req.headers.authorization });
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const list = await db.collection('withdrawals').find({ userId: user._id }).sort({ created: -1 }).toArray();
  res.json(list);
});

function adminAuth(req, res, next) {
  if (req.headers.user === CONFIG.ADMIN_USER && req.headers.pass === CONFIG.ADMIN_PASS) return next();
  res.status(401).json({ error: 'Admin access denied' });
}

app.get('/api/admin/stats', adminAuth, async (req, res) => {
  const users = await db.collection('users').countDocuments();
  const links = await db.collection('links').countDocuments();
  const allLinks = await db.collection('links').find().toArray();
  const totalClicks = allLinks.reduce((a, l) => a + l.clicks, 0);
  const pending = await db.collection('withdrawals').find({ status: 'pending' }).toArray();
  const paid = await db.collection('withdrawals').find({ status: 'paid' }).toArray();
  res.json({ totalUsers: users, totalLinks: links, totalClicks, totalEarningsPaid: paid.reduce((a, w) => a + w.amount, 0), pendingWithdrawals: pending.length, pendingAmount: pending.reduce((a, w) => a + w.amount, 0) });
});

app.get('/api/admin/users', adminAuth, async (req, res) => {
  const users = await db.collection('users').find().sort({ joined: -1 }).toArray();
  res.json(users.map(({ password, ...u }) => u));
});

app.get('/api/admin/withdrawals', adminAuth, async (req, res) => {
  const list = await db.collection('withdrawals').find().sort({ created: -1 }).toArray();
  res.json(list);
});

app.post('/api/admin/withdraw/:id', adminAuth, async (req, res) => {
  const { status } = req.body;
  const w = await db.collection('withdrawals').findOne({ _id: new ObjectId(req.params.id) });
  if (!w) return res.status(404).json({ error: 'Not found' });
  if (status === 'rejected' && w.status === 'pending') {
    await db.collection('users').updateOne({ _id: w.userId }, { $inc: { balance: w.amount } });
  }
  await db.collection('withdrawals').updateOne({ _id: w._id }, { $set: { status, processedAt: new Date() } });
  res.json({ success: true });
});

app.post('/api/admin/user/:id/ban', adminAuth, async (req, res) => {
  const user = await db.collection('users').findOne({ _id: new ObjectId(req.params.id) });
  if (!user) return res.status(404).json({ error: 'Not found' });
  const newStatus = user.status === 'banned' ? 'active' : 'banned';
  await db.collection('users').updateOne({ _id: user._id }, { $set: { status: newStatus } });
  res.json({ success: true, status: newStatus });
});

// Hilltop verification
app.get('/74814d72e5abdf9a754e.txt', (req, res) => {
  res.setHeader('Content-Type', 'text/plain');
  res.send('38e1b491d1e083845022');
});

// Serve static HTML pages directly
app.get('/dashboard.html', (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));
app.get('/login.html', (req, res) => res.sendFile(path.join(__dirname, 'login.html')));
app.get('/register.html', (req, res) => res.sendFile(path.join(__dirname, 'register.html')));
app.get('/admin.html', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/about.html', (req, res) => res.sendFile(path.join(__dirname, 'about.html')));
app.get('/terms.html', (req, res) => res.sendFile(path.join(__dirname, 'terms.html')));
app.get('/privacy.html', (req, res) => res.sendFile(path.join(__dirname, 'privacy.html')));

app.get('/:code', async (req, res) => {
  const reserved = ['about.html','terms.html','privacy.html','admin.html','dashboard.html','register.html','login.html'];
  if (reserved.includes(req.params.code)) return res.sendFile(path.join(__dirname, req.params.code));
  const link = await db.collection('links').findOne({ code: req.params.code });
  if (!link) return res.status(404).send('Link not found!');
  
  // Get page number - only count on pg=1
  const pg = parseInt(req.query.pg || '1');

  // Check if visitor is the link owner — owners never get counted
  const visitorToken = req.headers.cookie && req.headers.cookie.split(';').map(c=>c.trim()).find(c=>c.startsWith('snaptoken='));
  const visitorTokenValue = visitorToken ? visitorToken.split('=')[1] : null;
  const isOwner = visitorTokenValue && link.ownerToken && visitorTokenValue === link.ownerToken;

  const cookieKey = 'clicked_' + link.code;
  const cookieCounted = req.headers.cookie && req.headers.cookie.includes(cookieKey + '=1');
  const visitorIP = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || '';
  const ipCheck = await db.collection('ip_clicks').findOne({ 
    ip: visitorIP, 
    linkCode: link.code,
    createdAt: { $gte: new Date(Date.now() - 24*60*60*1000) }
  });

  // ONLY count on pg=1 — never count on pg 2,3,4,5 — never count owner
  if (pg === 1 && !isOwner && !cookieCounted && !ipCheck) {
    const day = new Date().getDay();
    const dayIdx = day === 0 ? 6 : day - 1;
    const cf_country = req.headers['cf-ipcountry'] || '';
    let rate;
    if (cf_country === 'IN') rate = CONFIG.RATE_PER_1000_IN / 1000;
    else if (['US','GB','AU','CA'].includes(cf_country)) rate = CONFIG.RATE_PER_1000_US / 1000;
    else rate = CONFIG.RATE_PER_1000_OTHER / 1000;
    const earned = rate;
    await db.collection('links').updateOne({ _id: link._id }, { $inc: { clicks: 1, earnings: earned, [`weekData.${dayIdx}`]: 1 } });
    await db.collection('users').updateOne({ _id: link.userId }, { $inc: { balance: earned, totalEarned: earned, totalClicks: 1 } });
    res.setHeader('Set-Cookie', cookieKey + '=1; Max-Age=86400; Path=/');
    await db.collection('ip_clicks').insertOne({ 
      ip: visitorIP, linkCode: link.code, country: cf_country, createdAt: new Date() 
    });
  }

  const finalDest = link.original;
  const linkCode = link.code;

  const MONETAG_SMART = 'https://omg10.com/4/11112574';
  const baseUrl = req.protocol + '://' + req.get('host') + '/' + linkCode;

  // Page URLs
  const nextPage = pg < 6 ? baseUrl + '?pg=' + (pg+1) : finalDest;

  // ── HEAD: gtag only ──
  const AD_SCRIPTS = `
    <!-- Google tag (gtag.js) -->
    <script async src="https://www.googletagmanager.com/gtag/js?id=AW-18221606970"></script>
    <script>
      window.dataLayer = window.dataLayer || [];
      function gtag(){dataLayer.push(arguments);}
      gtag('js', new Date());
      gtag('config', 'AW-18221606970');
    </script>
  `;

  // ── PAGE_ADS: Har page pe fire — sabhi unique zones ──
  const PAGE_ADS = `
    <script src="https://quge5.com/88/tag.min.js" data-zone="246854" async data-cfasync="false"></script>
    <script src="https://quge5.com/88/tag.min.js" data-zone="246895" async data-cfasync="false"></script>
    <script src="https://quge5.com/88/tag.min.js" data-zone="248162" async data-cfasync="false"></script>
    <script src="https://quge5.com/88/tag.min.js" data-zone="248564" async data-cfasync="false"></script>
    <script src="https://quge5.com/88/tag.min.js" data-zone="248565" async data-cfasync="false"></script>
    <script src="https://quge5.com/88/tag.min.js" data-zone="248566" async data-cfasync="false"></script>
    <script src="https://quge5.com/88/tag.min.js" data-zone="248567" async data-cfasync="false"></script>
    <script src="https://quge5.com/88/tag.min.js" data-zone="248568" async data-cfasync="false"></script>
    <script async data-cfasync="false" src="https://5gvci.com/act/files/tag.min.js?z=11114829"></script>
    <script async data-cfasync="false" src="https://5gvci.com/act/files/tag.min.js?z=11117663"></script>
    <script>(function(s){s.dataset.zone='11114819',s.src='https://al5sm.com/tag.min.js';document.body.appendChild(s)})(document.createElement('script'))</script>
    <script>(function(s){s.dataset.zone='11126180',s.src='https://al5sm.com/tag.min.js'})([document.documentElement, document.body].filter(Boolean).pop().appendChild(document.createElement('script')))</script>
    <script>(function(s){s.dataset.zone='11126190',s.src='https://al5sm.com/tag.min.js'})([document.documentElement, document.body].filter(Boolean).pop().appendChild(document.createElement('script')))</script>
  `;

  // ── In-Page Push — zone 247764 sirf yahan, PAGE_ADS mein nahi (duplicate avoid) ──
  const MONETAG_INPAGE = '<script src="https://quge5.com/88/tag.min.js" data-zone="247764" async data-cfasync="false"></script>';

  // ── Banner rotation — sab unique, koi repeat nahi ──
  const _MONETAG_BANNERS = [
    '<script src="https://quge5.com/88/tag.min.js" data-zone="246854" async data-cfasync="false"></script>',
    '<script src="https://quge5.com/88/tag.min.js" data-zone="246895" async data-cfasync="false"></script>',
    '<script src="https://quge5.com/88/tag.min.js" data-zone="247764" async data-cfasync="false"></script>',
    '<script src="https://quge5.com/88/tag.min.js" data-zone="248162" async data-cfasync="false"></script>',
    '<script src="https://quge5.com/88/tag.min.js" data-zone="248564" async data-cfasync="false"></script>',
    '<script src="https://quge5.com/88/tag.min.js" data-zone="248565" async data-cfasync="false"></script>',
    '<script src="https://quge5.com/88/tag.min.js" data-zone="248566" async data-cfasync="false"></script>',
    '<script src="https://quge5.com/88/tag.min.js" data-zone="248567" async data-cfasync="false"></script>',
    '<script src="https://quge5.com/88/tag.min.js" data-zone="248568" async data-cfasync="false"></script>',
    '<script async data-cfasync="false" src="https://5gvci.com/act/files/tag.min.js?z=11114829"></script>',
    '<script async data-cfasync="false" src="https://5gvci.com/act/files/tag.min.js?z=11117663"></script>',
    '<script>(function(s){s.dataset.zone="11114819",s.src="https://al5sm.com/tag.min.js";document.body.appendChild(s)})(document.createElement("script"))</script>',
    '<script>(function(s){s.dataset.zone="11126180",s.src="https://al5sm.com/tag.min.js"})([document.documentElement, document.body].filter(Boolean).pop().appendChild(document.createElement("script")))</script>',
    '<script>(function(s){s.dataset.zone="11126190",s.src="https://al5sm.com/tag.min.js"})([document.documentElement, document.body].filter(Boolean).pop().appendChild(document.createElement("script")))</script>',
  ];
  let _mi = 0;
  function nextAd() {
    return '<div style="margin:14px 0;text-align:center;min-height:60px">' + MONETAG_INPAGE + '</div>';
  }
  function exoAd() {
    const html = _MONETAG_BANNERS[_mi++ % _MONETAG_BANNERS.length];
    return '<div style="margin:14px 0;text-align:center;min-height:60px">' + html + '</div>';
  }

  const CSS = `
    *{margin:0;padding:0;box-sizing:border-box}
    body{background:#0a0a0a;color:#e8e8e8;font-family:'Segoe UI',Arial,sans-serif;font-size:15px;line-height:1.7}
    .header{background:#111;border-bottom:2px solid #00e5ff;padding:12px 20px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:100}
    .logo{font-size:20px;font-weight:900;color:#fff}.logo span{color:#00e5ff}
    .steps{display:flex;gap:6px;align-items:center}
    .step{width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;border:2px solid #333;color:#666}
    .step.done{background:#00ff94;border-color:#00ff94;color:#000}
    .step.active{background:#00e5ff;border-color:#00e5ff;color:#000}
    .step.todo{background:#1a1a1a}
    .content{max-width:700px;margin:0 auto;padding:20px}
    .card{background:#111;border:1px solid #222;border-radius:12px;padding:20px;margin-bottom:16px}
    h1{font-size:22px;font-weight:800;margin-bottom:10px;color:#fff}
    h2{font-size:18px;font-weight:700;margin-bottom:8px;color:#ddd}
    p{color:#aaa;margin-bottom:12px}
    .btn:hover{transform:scale(1.02)}
    .btn:disabled{background:#333;color:#666;cursor:not-allowed;transform:none}
    .timer-box{background:#0d0d0d;border:2px solid #00e5ff;border-radius:12px;padding:20px;text-align:center;margin:16px 0}
    .timer-num{font-size:52px;font-weight:900;color:#00e5ff;font-family:monospace;line-height:1}
    .timer-label{color:#666;font-size:13px;margin-top:6px}
    .captcha-box{background:#111;border:2px solid #333;border-radius:8px;padding:16px;display:flex;align-items:center;gap:14px;margin:16px 0;cursor:pointer;transition:border-color .2s;position:relative;z-index:9999}
    .captcha-box:hover{border-color:#00e5ff}
    .captcha-check{width:24px;height:24px;border:2px solid #555;border-radius:4px;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:all .3s}
    .captcha-check.checked{background:#00e5ff;border-color:#00e5ff;color:#000;font-size:14px;font-weight:700}
    .captcha-text{font-size:14px;color:#ccc}
    .captcha-logo{margin-left:auto;text-align:right;font-size:10px;color:#555}
    .btn{background:linear-gradient(135deg,#00e5ff,#00ff94);color:#000;border:none;padding:14px 28px;border-radius:10px;font-size:15px;font-weight:800;cursor:pointer;width:100%;margin:10px 0;letter-spacing:0.5px;transition:transform .2s;position:relative;z-index:9999}
    @keyframes spin{to{transform:rotate(360deg)}}
    .scroll-hint{text-align:center;color:#666;font-size:13px;padding:12px;animation:bounce 1s infinite}
    @keyframes bounce{0%,100%{transform:translateY(0)}50%{transform:translateY(-4px)}}
    .progress-bar{height:4px;background:#1a1a1a;border-radius:2px;margin:10px 0}
    .progress-fill{height:100%;background:linear-gradient(90deg,#00e5ff,#00ff94);border-radius:2px;transition:width 1s linear}
    .blog-text{color:#bbb;font-size:14px;line-height:1.8}
    .highlight{color:#00e5ff;font-weight:600}
    .warning-box{background:#1a1000;border:1px solid #ff6b00;border-radius:8px;padding:12px 16px;color:#ff9500;font-size:13px;margin:12px 0}
    .generate-box{background:linear-gradient(135deg,#0d1a2e,#0a2a1a);border:2px solid #00e5ff;border-radius:16px;padding:24px;text-align:center;margin:20px 0}
    .generate-box h2{font-size:20px;margin-bottom:8px}
    .final-link{background:#0a2a0a;border:2px solid #00ff94;border-radius:10px;padding:16px;text-align:center;margin:16px 0}
    .final-link a{color:#00ff94;font-size:14px;word-break:break-all;font-weight:600;text-decoration:none}
  `;

  // ═══════════════════════════════════════
  // PAGE 1 — Blog + Captcha
  // ═══════════════════════════════════════
  if (pg === 1) {
    res.send(`<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Continue to your link — SnapURL</title>
${AD_SCRIPTS}
<style>${CSS}
.faq-item{border-bottom:1px solid #1e1e1e;padding:12px 0}
.faq-q{color:#00e5ff;font-weight:700;margin-bottom:6px;font-size:14px}
.faq-a{color:#aaa;font-size:13px;line-height:1.7}
.stat-row{display:flex;gap:10px;margin:12px 0;flex-wrap:wrap}
.stat-box{flex:1;min-width:120px;background:#0d0d0d;border:1px solid #222;border-radius:10px;padding:14px;text-align:center}
.stat-num{font-size:24px;font-weight:900;color:#00e5ff}
.stat-label{font-size:11px;color:#666;margin-top:4px}
.steps-list{counter-reset:step}
.steps-list li{counter-increment:step;display:flex;align-items:flex-start;gap:12px;padding:10px 0;border-bottom:1px solid #1a1a1a;color:#bbb;font-size:13px;line-height:1.6;list-style:none}
.steps-list li::before{content:counter(step);background:#00e5ff;color:#000;width:22px;height:22px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:900;font-size:12px;flex-shrink:0;margin-top:2px}
</style>
</head>
<body>
<div class="header">
  <div class="logo">Snap<span>URL</span></div>
  <div class="steps">
    <div class="step active">1</div>
    <div class="step todo">2</div>
    <div class="step todo">3</div>
    <div class="step todo">4</div>
    <div class="step todo">5</div>
    <div class="step todo">6</div>
  </div>
</div>

<div class="content">
  <div class="card">
    <h1>🔗 Your Link is Almost Ready!</h1>
    <p class="blog-text">Welcome to <span class="highlight">SnapURL</span> — India's fastest and most trusted free link shortener. You are just a few steps away from accessing your destination link. Please scroll down, read the information, and complete the verification to continue safely.</p>
  ${exoAd()}
    <p class="blog-text">This process helps us verify you are a real human visitor and not an automated bot. It keeps our platform safe and secure for everyone.</p>
  ${nextAd()}
  </div>

  ${exoAd()}
  ${nextAd()}

  <div class="card">
    <h2>📊 SnapURL — By The Numbers</h2>
    <div class="stat-row">
      <div class="stat-box"><div class="stat-num">2M+</div><div class="stat-label">Links Created</div></div>
      <div class="stat-box"><div class="stat-num">50M+</div><div class="stat-label">Total Clicks</div></div>
      <div class="stat-box"><div class="stat-num">1.2L+</div><div class="stat-label">Happy Users</div></div>
      <div class="stat-box"><div class="stat-num">99.9%</div><div class="stat-label">Uptime</div></div>
    </div>
    <p class="blog-text" style="margin-top:8px">SnapURL has been serving users across India and the world since 2022. Our platform is built on enterprise-grade infrastructure to ensure fast, reliable redirects every single time.</p>
  </div>

  ${exoAd()}

  <div class="card">
    <h2>📖 What is a URL Shortener?</h2>
    <p class="blog-text">A URL shortener is a web service that converts a long web address into a shorter, more manageable link. For example, a link like <span class="highlight">https://www.example.com/very/long/path/to/article?id=12345</span> can become simply <span class="highlight">snapurl.in/abc123</span>.</p>
  ${nextAd()}
    <p class="blog-text">Short links are easier to share on social media, WhatsApp, SMS, and printed materials. They also provide valuable analytics — you can track how many people clicked your link, from which country, and at what time.</p>
  ${exoAd()}
    <p class="blog-text">SnapURL goes one step further — we let you <span class="highlight">earn money</span> from every click on your shortened links!</p>
  ${nextAd()}
  </div>

  ${exoAd()}
  ${nextAd()}

  <div class="card">
    <h2>🛡️ Is SnapURL Safe?</h2>
    <p class="blog-text">Absolutely! SnapURL uses <span class="highlight">256-bit SSL encryption</span> on all pages. All links submitted to our platform are automatically scanned using Google Safe Browsing API to detect phishing, malware, and scam links.</p>
  ${exoAd()}
  
    <p class="blog-text">We have a strict <span class="highlight">zero tolerance policy</span> for harmful content. Any link found to contain illegal, harmful, or misleading content is immediately blocked and the user account is permanently banned.</p>
  ${nextAd()}
  
    <p class="blog-text">Your privacy is important to us. We only collect anonymous click data (country, device type, browser) for analytics. We never store personally identifiable information of link visitors.</p>
  ${exoAd()}
  
  </div>

  ${nextAd()}

  <div class="card">
    <h2>💰 How to Earn Money with SnapURL</h2>
    <p class="blog-text">Earning with SnapURL is simple and completely free to start. Here's how it works:</p>
  ${exoAd()}
  
    <ol class="steps-list">
      <li>Create a free account on SnapURL — takes less than 1 minute</li>
      <li>Shorten any URL you want to share — YouTube videos, articles, anything</li>
      <li>Share your short link on WhatsApp groups, Facebook, Instagram, Telegram</li>
      <li>Earn money for every unique visitor who clicks your link</li>
      <li>Withdraw your earnings via UPI, PayPal, or Bank Transfer once you reach ₹500</li>
    </ol>
    <p class="blog-text" style="margin-top:12px">Top SnapURL earners make <span class="highlight">₹5,000–₹20,000 per month</span> just by sharing links in WhatsApp groups and social media pages!</p>
  </div>

  ${nextAd()}

  <div class="card">
    <h2>🌐 How Our Redirect System Works</h2>
    <p class="blog-text">When you click a SnapURL short link, here's what happens behind the scenes:</p>
  ${exoAd()}
  
    <p class="blog-text">1. Your request hits our nearest server (we have servers in Mumbai, Delhi, and Singapore) in milliseconds.</p>
  ${nextAd()}
  
    <p class="blog-text">2. Our system looks up the destination URL from our database and logs the click anonymously.</p>
  
  
    <p class="blog-text">3. You are shown a brief interstitial page (like this one) which helps fund our free service.</p>
  
  
    <p class="blog-text">4. After a short wait, you are automatically redirected to your destination — <span class="highlight">fast, safe, and free</span>.</p>
  
  
  </div>

  
  

  <div class="card">
    <h2>❓ Frequently Asked Questions</h2>
    <div class="faq-item">
      <div class="faq-q">Q. Is SnapURL completely free to use?</div>
      <div class="faq-a">Yes! Creating an account and shortening links is 100% free. We earn revenue from the ads shown during redirects, which also becomes your earnings when you share links.</div>
    </div>
    <div class="faq-item">
      <div class="faq-q">Q. How long do shortened links stay active?</div>
      <div class="faq-a">All links remain active permanently as long as your account is in good standing. We do not delete old links unless they violate our Terms of Service.</div>
    </div>
    <div class="faq-item">
      <div class="faq-q">Q. Can I use a custom alias for my link?</div>
      <div class="faq-a">Yes! Registered users can set a custom alias (e.g., snapurl.in/myname) for their links, making them easier to remember and share.</div>
    </div>
    <div class="faq-item">
      <div class="faq-q">Q. Why do I have to wait before accessing the link?</div>
      <div class="faq-a">The short wait and ads help us keep the platform free. The person who shared the link with you also earns a small amount from each visit. Thank you for your patience!</div>
    </div>
    <div class="faq-item">
      <div class="faq-q">Q. What payment methods are available for withdrawal?</div>
      <div class="faq-a">We support UPI (PhonePe, GPay, Paytm), Bank Transfer (NEFT/IMPS), PayPal, and USDT crypto withdrawals. Minimum withdrawal amount is ₹500 (approximately $5).</div>
    </div>
  </div>

  

  <div class="card">
    <h2>💡 Tips for Safe Internet Browsing</h2>
    <p class="blog-text">While you wait, here are some important internet safety tips to keep you protected online:</p>
  
  
    <p class="blog-text">🔒 <span class="highlight">Always check HTTPS</span> — look for the padlock icon in your browser before entering any sensitive information on a website.</p>
  
  
    <p class="blog-text">🔑 <span class="highlight">Use strong passwords</span> — combine uppercase, lowercase, numbers, and symbols. Never use the same password on multiple websites.</p>
  
  
    <p class="blog-text">📱 <span class="highlight">Enable 2FA</span> — two-factor authentication adds an extra layer of security to your accounts. Use Google Authenticator or SMS OTP wherever possible.</p>
  
  
    <p class="blog-text">🚫 <span class="highlight">Avoid public Wi-Fi</span> for banking or shopping. If you must use public Wi-Fi, use a reputable VPN service to encrypt your connection.</p>
  
  
    <p class="blog-text">🔄 <span class="highlight">Keep software updated</span> — always update your phone, browser, and apps. Updates often contain critical security patches that protect you from new threats.</p>
  
  
    <p class="blog-text">📧 <span class="highlight">Beware of phishing</span> — never click links in suspicious emails or messages. Always verify the sender before clicking any link.</p>
  
  
  </div>

  
  
  

  <div class="warning-box">
    ⚠️ Almost there! Please complete the human verification below to unlock your link. This is a one-time check to prevent automated bots from abusing our service.
  </div>

  <div class="captcha-box" id="captchaBox" onclick="doCaptcha()">
    <div class="captcha-check" id="captchaCheck"></div>
    <div class="captcha-text">I am not a robot</div>
    <div class="captcha-logo">reCAPTCHA<br><span style="font-size:9px">Privacy · Terms</span></div>
  </div>

  

  <button class="btn" id="continueBtn" disabled onclick="goContinue()" style="position:relative;z-index:9999">
    ✓ Verify & Continue →
  </button>
</div>

<script>
var captchaDone = false;
var verifying = false;

function doCaptcha() {
  if (captchaDone || verifying) return;
  verifying = true;
  var check = document.getElementById('captchaCheck');
  var btn = document.getElementById('continueBtn');
  var box = document.getElementById('captchaBox');
  
  // Spinner dikhao
  check.style.background = 'transparent';
  check.innerHTML = '<div style="width:14px;height:14px;border:2px solid #00e5ff;border-top-color:transparent;border-radius:50%;animation:spin .6s linear infinite"></div>';
  box.style.borderColor = '#00e5ff';
  box.style.cursor = 'default';
  
  setTimeout(function(){
    check.innerHTML = '✓';
    check.style.background = '#00e5ff';
    check.style.color = '#000';
    check.style.fontWeight = '700';
    check.style.fontSize = '14px';
    check.style.display = 'flex';
    check.style.alignItems = 'center';
    check.style.justifyContent = 'center';
    captchaDone = true;
    verifying = false;
    btn.disabled = false;
    btn.style.background = 'linear-gradient(135deg,#00e5ff,#00ff94)';
    btn.textContent = '✓ Verified! Continue →';
  }, 1800);
}

function goContinue() {
  if (!captchaDone) {
    document.getElementById('captchaBox').style.borderColor = '#ff3d71';
    setTimeout(function(){ document.getElementById('captchaBox').style.borderColor = '#333'; }, 1000);
    return;
  }
  try { window.open('${MONETAG_SMART}', '_blank'); } catch(e){}
  setTimeout(function(){ window.location = '${nextPage}'; }, 400);
}
</script>
${PAGE_ADS}
  
  
  
  
  
</body>
</html>`);

  // ═══════════════════════════════════════
  // PAGE 2 — Slow Countdown + Scroll
  // ═══════════════════════════════════════
  } else if (pg === 2) {
    res.send(`<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Please Wait — SnapURL</title>
${AD_SCRIPTS}
<style>${CSS}
#scrollHint{display:block}
#continueBtn{display:none}
@keyframes spin{to{transform:rotate(360deg)}}
.tip-card{background:#0d1a1a;border-left:3px solid #00e5ff;padding:12px 16px;border-radius:0 8px 8px 0;margin:10px 0}
.tip-card p{color:#bbb;font-size:13px;margin:0;line-height:1.7}
.earning-table{width:100%;border-collapse:collapse;margin-top:12px}
.earning-table th{background:#0d0d0d;color:#00e5ff;padding:10px;text-align:left;font-size:12px;border-bottom:1px solid #222}
.earning-table td{padding:10px;color:#bbb;font-size:13px;border-bottom:1px solid #1a1a1a}
.earning-table tr:last-child td{border-bottom:none}
</style>
</head>
<body>
<div class="header">
  <div class="logo">Snap<span>URL</span></div>
  <div class="steps">
    <div class="step done">✓</div>
    <div class="step active">2</div>
    <div class="step todo">3</div>
    <div class="step todo">4</div>
    <div class="step todo">5</div>
    <div class="step todo">6</div>
  </div>
</div>

<div class="content">
  <div class="timer-box">
    <div class="timer-num" id="timerNum">20</div>
    <div class="timer-label">Please wait while we prepare your link...</div>
    <div class="progress-bar"><div class="progress-fill" id="progressFill" style="width:100%"></div></div>
  </div>

  ${exoAd()}
  ${nextAd()}

  <div class="card">
    <h2>⏳ Why do we show ads?</h2>
    <p class="blog-text">SnapURL is a completely <span class="highlight">free service</span>. We rely on advertisements to keep this service running. By viewing ads, you help us maintain servers, pay our development team, and continue providing this free link shortening service to millions of users.</p>
  ${exoAd()}
    <p class="blog-text">Every time you view an ad page, the person who shared this link with you earns a small commission. So your patience is literally putting money in someone's pocket — maybe even your friend's!</p>
  ${nextAd()}
  </div>

  ${exoAd()}

  <div class="card">
    <h2>💰 SnapURL Earning Rates</h2>
    <p class="blog-text">Here are the current CPM rates for SnapURL publishers:</p>
  ${nextAd()}
    <table class="earning-table">
      <tr><th>Country</th><th>Rate per 1000 Clicks</th><th>Estimated Daily</th></tr>
      <tr><td>🇺🇸 USA / UK / AU</td><td style="color:#00ff94">$12.00</td><td>$2–$8</td></tr>
      <tr><td>🇮🇳 India</td><td style="color:#00e5ff">$4.50</td><td>₹80–₹400</td></tr>
      <tr><td>🌍 Other Countries</td><td style="color:#aaa">$2.00</td><td>$0.50–$2</td></tr>
    </table>
    <p class="blog-text" style="margin-top:12px">Rates may vary based on traffic quality, time of day, and advertiser demand. Indian traffic during evening hours (6 PM – 11 PM IST) typically earns 20–30% more.</p>
  </div>

  ${exoAd()}
  ${nextAd()}

  <div class="card">
    <h2>📱 Best Ways to Share SnapURL Links</h2>
    <div class="tip-card"><p>💬 <strong style="color:#00e5ff">WhatsApp Groups</strong> — Share in large WhatsApp groups related to news, jobs, cricket, movies. Groups with 100+ members can generate 50–200 clicks per post.</p></div>
    <div class="tip-card"><p>📘 <strong style="color:#00e5ff">Facebook Pages</strong> — Create a Facebook page around a popular topic and post shortened links to trending news or videos regularly.</p></div>
    <div class="tip-card"><p>📱 <strong style="color:#00e5ff">Instagram Bio</strong> — Put your SnapURL link in your Instagram bio and direct followers to click it for exclusive content or resources.</p></div>
    <div class="tip-card"><p>✈️ <strong style="color:#00e5ff">Telegram Channels</strong> — Telegram channels focused on deals, jobs, or entertainment can generate thousands of clicks per day.</p></div>
    <div class="tip-card"><p>🐦 <strong style="color:#00e5ff">Twitter/X</strong> — Tweet about trending topics and include your SnapURL link. Viral tweets can generate massive traffic in short time.</p></div>
  </div>

  ${exoAd()}
  ${nextAd()}

  <div class="card">
    <h2>🔥 What Topics Get the Most Clicks?</h2>
    <p class="blog-text">Based on our platform data, here are the content categories that generate the most clicks:</p>
  ${exoAd()}
  
    <p class="blog-text">🏏 <span class="highlight">Cricket & Sports</span> — IPL, World Cup, and match updates drive massive traffic especially during live matches.</p>
  ${nextAd()}
  
    <p class="blog-text">💼 <span class="highlight">Jobs & Government Results</span> — Sarkari naukri links, exam results (SSC, UPSC, Railway) are extremely high-traffic content.</p>
  ${exoAd()}
  
    <p class="blog-text">🎬 <span class="highlight">Movies & Web Series</span> — New movie releases, OTT updates, and trailer links get clicked heavily.</p>
  ${nextAd()}
  
    <p class="blog-text">📰 <span class="highlight">Breaking News</span> — Time-sensitive news content drives urgency clicks. People always want to read the latest.</p>
  ${exoAd()}
  
    <p class="blog-text">💰 <span class="highlight">Earn Money Online</span> — Content about earning money online always has high engagement, especially in tier 2 and tier 3 cities.</p>
  ${nextAd()}
  
    <p class="blog-text">🎁 <span class="highlight">Offers & Free Recharge</span> — Jio offers, discount deals, and cashback links generate thousands of clicks when posted in deal groups.</p>
  ${exoAd()}
  
  </div>

  
  ${nextAd()}

  <div class="card">
    <h2>📈 Growing Your SnapURL Income</h2>
    <p class="blog-text">Here are proven strategies used by our top earners:</p>
  
  
    <p class="blog-text"><span class="highlight">Build a Content Schedule</span> — Post links at consistent times when your audience is most active. For Indian users, 8–10 AM and 7–10 PM are peak hours.</p>
  
  
    <p class="blog-text"><span class="highlight">Join Multiple Groups</span> — The more groups and channels you share in, the more exposure your links get. Aim for at least 20–30 active groups.</p>
  
  
    <p class="blog-text"><span class="highlight">Write Catchy Descriptions</span> — A good description before your link increases click-through rate. Create curiosity or urgency in your message.</p>
  
  
    <p class="blog-text"><span class="highlight">Use Multiple Niches</span> — Don't limit yourself to one topic. Share cricket updates in sports groups, job alerts in career groups, and movie news in entertainment groups.</p>
  
  
    <p class="blog-text"><span class="highlight">Track Your Analytics</span> — Use SnapURL's built-in dashboard to see which links perform best and which time slots generate the most clicks.</p>
  
  
  </div>

  
  
  

  <div class="scroll-hint" id="scrollHint">👇 Scroll down — your link is being prepared</div>
  <button class="btn" id="continueBtn" onclick="goContinue()">Continue to Next Step →</button>
</div>

<script>
var t = 20;
var timerEl = document.getElementById('timerNum');
var progressEl = document.getElementById('progressFill');
var scrollHint = document.getElementById('scrollHint');
var btn = document.getElementById('continueBtn');
var scrollDone = true;

var iv = setInterval(function(){
  t--;
  timerEl.textContent = t;
  progressEl.style.width = (t/20*100) + '%';
  if(t <= 0){
    clearInterval(iv);
    timerEl.textContent = '✓';
    timerEl.style.color = '#00ff94';
    btn.style.display='block';
    scrollHint.style.display='none';
  }
}, 500);

window.addEventListener('scroll', function(){
  if(!scrollDone && window.scrollY > 300){ scrollDone = true; }
  if(scrollDone && t <= 0){
    scrollHint.style.display = 'none';
    btn.style.display = 'block';
  }
});

function goContinue(){
  try { window.open('${MONETAG_SMART}', '_blank'); } catch(e){}
  setTimeout(function(){ window.location = '${nextPage}'; }, 400);
}
</script>
${PAGE_ADS}
  
  
  
  
  
</body>
</html>`);

  // ═══════════════════════════════════════
  // PAGE 3 — Another countdown
  // ═══════════════════════════════════════
  } else if (pg === 3) {
    res.send(`<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Almost There — SnapURL</title>
${AD_SCRIPTS}
<style>${CSS}
.review-card{background:#0d1a0d;border:1px solid #1a3a1a;border-radius:10px;padding:14px;margin:10px 0}
.review-name{color:#00ff94;font-weight:700;font-size:13px;margin-bottom:4px}
.review-stars{color:#ffd700;font-size:14px;margin-bottom:6px}
.review-text{color:#aaa;font-size:13px;line-height:1.6}
.review-date{color:#555;font-size:11px;margin-top:6px}
</style>
</head>
<body>
<div class="header">
  <div class="logo">Snap<span>URL</span></div>
  <div class="steps">
    <div class="step done">✓</div>
    <div class="step done">✓</div>
    <div class="step active">3</div>
    <div class="step todo">4</div>
    <div class="step todo">5</div>
    <div class="step todo">6</div>
  </div>
</div>

<div class="content">
  <div class="card">
    <h1>⚡ You're 60% Done!</h1>
    <p class="blog-text">Great job! You have completed the first two steps. Just 2 more steps to go and your destination link will be ready. Please scroll down and wait for the timer to complete.</p>
  ${exoAd()}
  </div>

  <div class="timer-box">
    <div class="timer-num" id="timerNum">20</div>
    <div class="timer-label">Verifying your session...</div>
    <div class="progress-bar"><div class="progress-fill" id="progressFill" style="width:100%"></div></div>
  </div>

  ${nextAd()}
  ${exoAd()}

  <div class="card">
    <h2>🌟 User Reviews — What People Say About SnapURL</h2>

    <div class="review-card">
      <div class="review-name">Rahul Sharma, Delhi</div>
      <div class="review-stars">★★★★★</div>
      <div class="review-text">Maine SnapURL se pichle 3 mahino mein ₹18,000 kamaye hain! Sirf WhatsApp groups mein links share karke. Best earning platform for Indians. Withdrawal bhi bahut fast hai — UPI pe seedha aa jaata hai!</div>
      <div class="review-date">Posted 2 days ago</div>
    </div>

    <div class="review-card">
      <div class="review-name">Priya Patel, Ahmedabad</div>
      <div class="review-stars">★★★★★</div>
      <div class="review-text">I was skeptical at first but SnapURL is 100% legit. I share cricket match links during IPL season and earn ₹500-800 per day! The dashboard is very easy to use and payments are always on time.</div>
      <div class="review-date">Posted 5 days ago</div>
    </div>

    <div class="review-card">
      <div class="review-name">Mohammad Irfan, Hyderabad</div>
      <div class="review-stars">★★★★☆</div>
      <div class="review-text">Bahut acha platform hai. Main student hoon aur part time earning ke liye use karta hoon. Monthly ₹3000-5000 ho jaate hain. Withdrawal ka process thoda slow hai but reliable hai. Recommend karunga!</div>
      <div class="review-date">Posted 1 week ago</div>
    </div>

    <div class="review-card">
      <div class="review-name">Anita Kumari, Patna</div>
      <div class="review-stars">★★★★★</div>
      <div class="review-text">Ghar baithe earning ka sabse accha tarika! Main housewife hoon, free time mein links share karti hoon. ₹2000-4000 per month aasani se ho jaate hain. Bahut khush hoon is platform se!</div>
      <div class="review-date">Posted 2 weeks ago</div>
    </div>
  </div>

  ${nextAd()}
  ${exoAd()}

  <div class="card">
    <h2>🚀 SnapURL vs Other URL Shorteners</h2>
    <p class="blog-text">Not all link shorteners are created equal. Here's why SnapURL stands out from the competition:</p>
  ${nextAd()}
    <p class="blog-text">✅ <span class="highlight">Higher Rates</span> — SnapURL pays some of the highest CPM rates in the industry for Indian traffic. We pass 70% of our ad revenue directly to our publishers.</p>
  ${exoAd()}
    <p class="blog-text">✅ <span class="highlight">Instant Dashboard</span> — Real-time analytics so you can track every click as it happens. Know which links are performing and optimize your strategy.</p>
  ${nextAd()}
    <p class="blog-text">✅ <span class="highlight">Fast Withdrawal</span> — Unlike other platforms that hold your money for 30–60 days, SnapURL processes withdrawals within 24–48 hours on business days.</p>
  ${exoAd()}
    <p class="blog-text">✅ <span class="highlight">No Minimum Links</span> — You can start earning from your very first link. No minimum link requirement before you can withdraw.</p>
  ${nextAd()}
    <p class="blog-text">✅ <span class="highlight">24/7 Support</span> — Our support team is available around the clock via email and Telegram to help resolve any issues quickly.</p>
  ${exoAd()}
  
  </div>

  
  ${nextAd()}

  <div class="card">
    <h2>📚 Internet Trends in India 2024</h2>
    <p class="blog-text">India is now the world's second-largest internet market with over <span class="highlight">850 million active internet users</span>. Mobile internet usage has grown by 35% in the past 2 years alone.</p>
  ${exoAd()}
  
    <p class="blog-text">WhatsApp remains the dominant messaging platform with over <span class="highlight">530 million Indian users</span>. This makes it the most powerful channel for viral link sharing — and earning money through SnapURL.</p>
  ${nextAd()}
  
    <p class="blog-text">Short-form content and quick links are increasingly popular as attention spans shrink. <span class="highlight">Short URLs get 39% more clicks</span> than full-length URLs in messaging apps, according to marketing research.</p>
  ${exoAd()}
  
    <p class="blog-text">Video content links, especially cricket and Bollywood, consistently drive the highest traffic on our platform. During major cricket tournaments, our daily traffic increases by <span class="highlight">400–600%</span>.</p>
  ${nextAd()}
  
  </div>

  ${exoAd()}

  <div class="card">
    <h2>💡 Did You Know?</h2>
    <p class="blog-text">🔗 The first URL shortener was created in 2002. TinyURL was one of the pioneers that started the link shortening industry.</p>
  ${nextAd()}
  
    <p class="blog-text">📊 Over <span class="highlight">25 billion shortened links</span> are clicked every year worldwide. The industry is growing at 20% annually.</p>
  
  
    <p class="blog-text">💰 Top link shortener publishers worldwide earn <span class="highlight">$500–$5,000 per month</span> just from sharing links on social media.</p>
  
  
    <p class="blog-text">📱 <span class="highlight">78% of all clicks</span> on SnapURL come from mobile devices — mostly Android smartphones. This shows the massive opportunity in mobile-first India.</p>
  
  
    <p class="blog-text">⚡ SnapURL processes each redirect in under <span class="highlight">50 milliseconds</span> — faster than you can blink!</p>
  
  
  </div>

  
  
  
  

  <button class="btn" id="continueBtn" disabled onclick="goContinue()" style="position:relative;z-index:9999">Continue →</button>
</div>

<script>
var t = 20;
var timerEl = document.getElementById('timerNum');
var progressEl = document.getElementById('progressFill');
var btn = document.getElementById('continueBtn');

var iv = setInterval(function(){
  t--;
  timerEl.textContent = t;
  progressEl.style.width = (t/20*100) + '%';
  if(t <= 0){
    clearInterval(iv);
    timerEl.textContent = '✓';
    timerEl.style.color = '#00ff94';
    btn.disabled = false;
    btn.textContent = '✅ Continue to Step 4 →';
  }
}, 500);

function goContinue(){
  try { window.open('${MONETAG_SMART}', '_blank'); } catch(e){}
  setTimeout(function(){ window.location = '${nextPage}'; }, 400);
}
</script>
${PAGE_ADS}
  
  
  
  
  
</body>
</html>`);

  // ═══════════════════════════════════════
  // PAGE 4 — Generate Link
  // ═══════════════════════════════════════
  } else if (pg === 4) {
    res.send(`<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Generate Your Link — SnapURL</title>
${AD_SCRIPTS}
<style>${CSS}
.checklist{list-style:none;padding:0}
.checklist li{display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid #1a1a1a;color:#bbb;font-size:13px}
.checklist li:last-child{border-bottom:none}
.check-icon{color:#00ff94;font-size:16px;flex-shrink:0}
</style>
</head>
<body>
<div class="header">
  <div class="logo">Snap<span>URL</span></div>
  <div class="steps">
    <div class="step done">✓</div>
    <div class="step done">✓</div>
    <div class="step done">✓</div>
    <div class="step active">4</div>
    <div class="step todo">5</div>
    <div class="step todo">6</div>
  </div>
</div>

<div class="content">
  <div class="card">
    <h1>🔗 Almost Ready — Step 4 of 5</h1>
    <p class="blog-text">You're doing great! We are now generating your secure destination link. Please wait for the timer and scroll through while we complete the final checks.</p>
  ${exoAd()}
  </div>

  ${nextAd()}
  ${exoAd()}

  <div class="card">
    <h2>✅ Verification Progress</h2>
    <ul class="checklist">
      <li><span class="check-icon">✓</span> Human verification completed</li>
      <li><span class="check-icon">✓</span> Session authenticated</li>
      <li><span class="check-icon">✓</span> Link scanned for safety</li>
      <li><span class="check-icon">✓</span> Redirect server selected</li>
      <li><span class="check-icon">⏳</span> Generating secure link token...</li>
    </ul>
    <p class="blog-text" style="margin-top:10px">Your link is being prepared with end-to-end security. This process ensures the destination is safe and your visit is logged correctly.</p>
  </div>

  ${nextAd()}

  <div class="card">
    <h2>🔒 Your Privacy & Our Promise</h2>
    <p class="blog-text">At SnapURL, we take your privacy seriously. Here is what we <span class="highlight">never</span> do:</p>
  ${exoAd()}
    <p class="blog-text">🚫 We never sell your personal data to third parties</p>
  ${nextAd()}
    <p class="blog-text">🚫 We never store your browsing history or track you across websites</p>
  ${exoAd()}
    <p class="blog-text">🚫 We never ask for login credentials for other platforms</p>
  ${nextAd()}
    <p class="blog-text">🚫 We never inject malware or unwanted software</p>
  ${exoAd()}
    <p class="blog-text">🚫 We never redirect you to harmful or adult content sites</p>
  ${nextAd()}
    <p class="blog-text" style="margin-top:8px">We comply with GDPR, India's DPDP Act 2023, and all applicable data protection laws. Our privacy policy is available at snapurl.in/privacy</p>
  </div>

  
  ${exoAd()}

  <div class="card">
    <h2>🌍 SnapURL Global Network</h2>
    <p class="blog-text">SnapURL operates a global CDN (Content Delivery Network) with server locations in:</p>
  ${nextAd()}
  
    <p class="blog-text">🇮🇳 <span class="highlight">Mumbai</span> — Primary server for Indian traffic (sub-20ms latency)</p>
  ${exoAd()}
  
    <p class="blog-text">🇮🇳 <span class="highlight">Delhi</span> — Secondary server for North India</p>
  ${nextAd()}
  
    <p class="blog-text">🇸🇬 <span class="highlight">Singapore</span> — Southeast Asia and Pacific region</p>
  ${exoAd()}
  
    <p class="blog-text">🇩🇪 <span class="highlight">Frankfurt</span> — European traffic</p>
  ${nextAd()}
  
    <p class="blog-text">🇺🇸 <span class="highlight">Virginia</span> — North American traffic</p>
  ${exoAd()}
  
    <p class="blog-text" style="margin-top:8px">This global network ensures that no matter where your link visitors are located, they experience <span class="highlight">ultra-fast redirects</span> with minimal delay.</p>
  </div>

  
  ${nextAd()}

  <div class="card">
    <h2>📖 How to Maximize Your Earnings — Advanced Tips</h2>
    <p class="blog-text"><span class="highlight">Tip 1: Timing is Everything</span> — Post links during peak engagement hours. For India, the best times are 8-10 AM (morning commute), 1-2 PM (lunch break), and 8-11 PM (evening relaxation).</p>
  
  
    <p class="blog-text"><span class="highlight">Tip 2: Create Curiosity</span> — Use messages like "You won't believe this..." or "This is going viral right now..." to increase click rates dramatically.</p>
  
  
    <p class="blog-text"><span class="highlight">Tip 3: Ride Trends</span> — Share links about trending topics. Check Twitter/X India Trends and Google Trends daily to find what people are searching for.</p>
  
  
    <p class="blog-text"><span class="highlight">Tip 4: Cross-Platform Sharing</span> — Don't limit to one platform. Share the same link across WhatsApp, Telegram, Facebook, and Instagram for maximum reach.</p>
  
  
    <p class="blog-text"><span class="highlight">Tip 5: Build an Audience</span> — Create a Telegram channel or WhatsApp community focused on a specific niche. A loyal audience means consistent, recurring clicks every time you post.</p>
  
  
    <p class="blog-text"><span class="highlight">Tip 6: Collaborate</span> — Partner with other SnapURL users to cross-promote each other's links and grow your combined audience faster.</p>
  
  
  </div>

  
  

  <div class="generate-box">
    <h2>🔗 Generate Your Link</h2>
    <p style="color:#8892aa;font-size:13px;margin-bottom:16px">Click the button below to generate your secure destination link token</p>
    <div class="timer-box" style="margin:12px 0">
      <div class="timer-num" id="timerNum">10</div>
      <div class="timer-label">Generating secure token...</div>
      <div class="progress-bar"><div class="progress-fill" id="progressFill4" style="width:100%"></div></div>
    </div>
    <button class="btn" id="generateBtn" disabled onclick="goContinue()" style="position:relative;z-index:9999">
      🔗 Generate Link →
    </button>
  </div>

  
  
  
</div>

<script>
var t = 10;
var timerEl = document.getElementById('timerNum');
var progressEl = document.getElementById('progressFill4');
var btn = document.getElementById('generateBtn');

var iv = setInterval(function(){
  t--;
  timerEl.textContent = t;
  progressEl.style.width = (t/10*100) + '%';
  if(t <= 0){
    clearInterval(iv);
    timerEl.textContent = '✓';
    timerEl.style.color = '#00ff94';
    btn.disabled = false;
    btn.textContent = '🔗 Get Your Link →';
  }
}, 500);

function goContinue(){
  try { window.open('${MONETAG_SMART}', '_blank'); } catch(e){}
  setTimeout(function(){ window.location = '${nextPage}'; }, 400);
}
</script>
${PAGE_ADS}
  
  
  
  
  
</body>
</html>`);

  // ═══════════════════════════════════════
  // PAGE 5 — Final Link
  // ═══════════════════════════════════════
  } else if (pg === 5) {
    res.send(`<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Your Link is Ready — SnapURL</title>
${AD_SCRIPTS}
<style>${CSS}
.share-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:12px 0}
.share-btn{padding:12px;border-radius:8px;border:none;font-size:13px;font-weight:700;cursor:pointer;text-align:center}
.share-wa{background:#25D366;color:#fff}
.share-tg{background:#0088cc;color:#fff}
.share-fb{background:#1877F2;color:#fff}
.share-tw{background:#1da1f2;color:#fff}
</style>
</head>
<body>
<div class="header">
  <div class="logo">Snap<span>URL</span></div>
  <div class="steps">
    <div class="step done">✓</div>
    <div class="step done">✓</div>
    <div class="step done">✓</div>
    <div class="step done">✓</div>
    <div class="step active">5</div>
    <div class="step todo">6</div>
  </div>
</div>

<div class="content">
  ${exoAd()}

  <div class="generate-box">
    <h2>🎉 Your Link is Ready!</h2>
    <p style="color:#8892aa;font-size:13px;margin-bottom:12px">All steps completed! Your destination link is now ready. Click the button below to open it.</p>
    <div class="timer-box" style="margin:12px 0">
      <div class="timer-num" id="timerNum">5</div>
      <div class="timer-label">Auto-redirecting in a few seconds...</div>
    </div>
    <div class="final-link">
      <a href="${finalDest}" target="_blank">🔗 Click here to open your link</a>
    </div>
    <button class="btn" id="finalBtn" onclick="goFinal()" style="position:relative;z-index:9999">
      ✅ Open My Link Now →
    </button>
  </div>

  ${nextAd()}

  <div class="card">
    <h2>🙏 Thank You for Using SnapURL!</h2>
    <p class="blog-text">You have successfully completed all verification steps. We appreciate your patience! The advertisements you viewed help us keep this service completely free for everyone.</p>
  ${exoAd()}
    <p class="blog-text">If someone shared this link with you, they just earned a small commission from your visit. Isn't that cool? <span class="highlight">You can do the same!</span> Sign up for free and start earning money by sharing links with your friends and family.</p>
  ${nextAd()}
  </div>

  ${exoAd()}
  ${nextAd()}

  <div class="card">
    <h2>💰 Start Earning Today — It's Free!</h2>
    <p class="blog-text">Creating a SnapURL account takes less than 60 seconds. Here's what you get for free:</p>
  ${exoAd()}
    <p class="blog-text">🔗 Unlimited link shortening</p>
  ${nextAd()}
    <p class="blog-text">📊 Real-time click analytics dashboard</p>
  ${exoAd()}
    <p class="blog-text">💵 Earnings for every click on your links</p>
  ${nextAd()}
    <p class="blog-text">🎯 Custom link aliases (e.g. snapurl.in/yourname)</p>
  ${exoAd()}
  
    <p class="blog-text">📱 Works on mobile, tablet, and desktop</p>
  ${nextAd()}
  
    <p class="blog-text">💳 Fast withdrawals via UPI, PayPal, Bank Transfer</p>
  ${exoAd()}
  
    <p class="blog-text" style="margin-top:10px">Join over <span class="highlight">1.2 lakh users</span> already earning with SnapURL. No investment required, no hidden fees, no minimum traffic requirement!</p>
    <a href="/register.html" style="display:block;background:linear-gradient(135deg,#00e5ff,#00ff94);color:#000;border:none;padding:14px 28px;border-radius:10px;font-size:15px;font-weight:800;text-align:center;margin:12px 0;text-decoration:none;letter-spacing:0.5px">🚀 Create Free Account →</a>
  </div>

  ${nextAd()}

  <div class="card">
    <h2>📊 SnapURL vs Competitors</h2>
    <p class="blog-text">Here's how SnapURL stacks up against other popular link shorteners:</p>
  ${exoAd()}
  
    <p class="blog-text">🏆 <span class="highlight">SnapURL</span> — $4.50/1000 clicks (India), fast payouts, Hindi support, UPI withdrawal</p>
  ${nextAd()}
  
    <p class="blog-text">🥈 Shorte.st — $3.00/1000 clicks, PayPal only, English support</p>
  ${exoAd()}
  
    <p class="blog-text">🥉 Linkvertise — $2.50/1000 clicks, PayPal only, no Indian UPI</p>
  ${nextAd()}
  
    <p class="blog-text">4️⃣ Adf.ly — $1.50/1000 clicks, slow payouts, outdated interface</p>
  
  
    <p class="blog-text" style="margin-top:8px">SnapURL is the clear choice for Indian creators and social media users who want <span class="highlight">maximum earnings</span> with the most convenient withdrawal options.</p>
  </div>

  
  

  <div class="card">
    <h2>📱 Share SnapURL With Friends</h2>
    <p class="blog-text">Know someone who could benefit from earning with SnapURL? Share this platform with them!</p>
  
  
    <p class="blog-text">When you refer a friend, you earn <span class="highlight">10% of their earnings</span> for the first 3 months — completely passive income on top of your own link earnings!</p>
  
  
    <div class="share-grid">
      <button class="share-btn share-wa" onclick="window.open('https://wa.me/?text=SnapURL se paisa kamao! https://snapurl.in/register')">💬 WhatsApp</button>
      <button class="share-btn share-tg" onclick="window.open('https://t.me/share/url?url=https://snapurl.in&text=Earn money by sharing links!')">✈️ Telegram</button>
      <button class="share-btn share-fb" onclick="window.open('https://facebook.com/sharer/sharer.php?u=https://snapurl.in')">📘 Facebook</button>
      <button class="share-btn share-tw" onclick="window.open('https://twitter.com/intent/tweet?url=https://snapurl.in&text=Earning with SnapURL!')">🐦 Twitter</button>
    </div>
  </div>

  
  
  
  

<script>
var t = 5;
var timerEl = document.getElementById('timerNum');

var iv = setInterval(function(){
  t--;
  timerEl.textContent = t;
  if(t <= 0){
    clearInterval(iv);
    timerEl.textContent = '✓';
    timerEl.style.color = '#00ff94';
    goFinal();
  }
}, 500);

function goFinal(){
  window.open('${MONETAG_SMART}', '_blank');
  window.location = '${finalDest}';
}
</script>
${PAGE_ADS}
</body>
</html>`);

  // ═══════════════════════════════════════
  // PAGE 6 — Blog + Final Redirect
  // ═══════════════════════════════════════
  } else {
    res.send(`<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>One Last Step — SnapURL</title>
${AD_SCRIPTS}
<style>${CSS}
.tip-box{background:#0d1a0d;border-left:4px solid #00ff94;border-radius:0 10px 10px 0;padding:14px 16px;margin:10px 0}
.tip-box p{color:#bbb;font-size:13px;margin:0;line-height:1.8}
.tip-title{color:#00ff94;font-weight:700;font-size:14px;margin-bottom:6px}
.earn-card{background:#0a1a2a;border:1px solid #1a3a5a;border-radius:10px;padding:14px;margin:10px 0;display:flex;align-items:center;gap:14px}
.earn-icon{font-size:28px;flex-shrink:0}
.earn-info h3{color:#00e5ff;font-size:14px;font-weight:700;margin-bottom:4px}
.earn-info p{color:#888;font-size:12px;margin:0;line-height:1.6}
</style>
</head>
<body>
<div class="header">
  <div class="logo">Snap<span>URL</span></div>
  <div class="steps">
    <div class="step done">✓</div>
    <div class="step done">✓</div>
    <div class="step done">✓</div>
    <div class="step done">✓</div>
    <div class="step done">✓</div>
    <div class="step active">6</div>
  </div>
</div>

<div class="content">
  ${exoAd()}

  <div class="card">
    <h1>🎯 Final Step — Almost There!</h1>
    <p class="blog-text">You are on the last step! Your destination link is being unlocked right now. Please wait for the countdown to finish — your link will open automatically.</p>
  </div>

  <div class="timer-box">
    <div class="timer-num" id="timerNum">15</div>
    <div class="timer-label">Unlocking your link...</div>
    <div class="progress-bar"><div class="progress-fill" id="progressFill" style="width:100%"></div></div>
  </div>

  ${exoAd()}
  ${nextAd()}

  <div class="card">
    <h2>📱 How to Earn More with SnapURL in 2025</h2>
    <p class="blog-text">Thousands of Indians are quietly earning ₹500–₹5000 every month just by sharing links. Here are the top strategies that top earners use:</p>
    ${exoAd()}
    <div class="tip-box">
      <div class="tip-title">💬 WhatsApp Groups</div>
      <p>Share your SnapURLs in large WhatsApp groups — family groups, news groups, meme groups. Even 10 clicks per link from 20 groups = 200 daily clicks!</p>
    </div>
    ${nextAd()}
    <div class="tip-box">
      <div class="tip-title">📸 Instagram & Reels Bio</div>
      <p>Put your SnapURL link in your Instagram bio. Every time someone visits your profile and clicks your link, you earn. Creators with 5K+ followers earn ₹1000+ per month just from bio clicks.</p>
    </div>
    ${exoAd()}
    <div class="tip-box">
      <div class="tip-title">✈️ Telegram Channels</div>
      <p>Telegram channels are goldmines for link shorteners. Share movies, web series, software, and study material links — all shortened with SnapURL. Each member click = earning for you!</p>
    </div>
    ${nextAd()}
    <div class="tip-box">
      <div class="tip-title">🎓 Student Communities</div>
      <p>Share notes, question papers, and syllabus PDFs shortened with SnapURL in college groups. Students always need study material — give it to them and earn from every download click!</p>
    </div>
  </div>

  ${exoAd()}

  <div class="card">
    <h2>💡 Pro Tips for Maximum Revenue</h2>
    ${nextAd()}
    <div class="earn-card">
      <div class="earn-icon">🌍</div>
      <div class="earn-info">
        <h3>Target Tier-1 Traffic</h3>
        <p>US, UK, Canada clicks earn 4x more than Indian clicks. Share on international forums, Reddit, and English-language groups for higher CPM.</p>
      </div>
    </div>
    ${exoAd()}
    <div class="earn-card">
      <div class="earn-icon">⏰</div>
      <div class="earn-info">
        <h3>Post at Peak Hours</h3>
        <p>Share links between 7–10 PM IST when most people are active on their phones. Evening traffic converts 40% better than morning traffic.</p>
      </div>
    </div>
    ${nextAd()}
    <div class="earn-card">
      <div class="earn-icon">🔁</div>
      <div class="earn-info">
        <h3>Reshare Evergreen Content</h3>
        <p>Shorten links to evergreen content (old movies, classic songs, timeless guides) and reshare them every few weeks. Same link = recurring earnings!</p>
      </div>
    </div>
    ${exoAd()}
    <div class="earn-card">
      <div class="earn-icon">📊</div>
      <div class="earn-info">
        <h3>Track Your Analytics</h3>
        <p>Check your SnapURL dashboard daily. See which links get the most clicks and focus on sharing similar content. Data-driven sharing = 3x more earnings!</p>
      </div>
    </div>
  </div>

  ${nextAd()}
  ${exoAd()}

  <button class="btn" id="continueBtn" disabled onclick="goContinue()" style="position:relative;z-index:9999">
    🔗 Open My Link Now →
  </button>

</div>

<script>
var t = 15;
var timerEl = document.getElementById('timerNum');
var progressEl = document.getElementById('progressFill');
var btn = document.getElementById('continueBtn');

var iv = setInterval(function(){
  t--;
  timerEl.textContent = t;
  progressEl.style.width = (t/15*100) + '%';
  if(t <= 0){
    clearInterval(iv);
    timerEl.textContent = '✓';
    timerEl.style.color = '#00ff94';
    btn.disabled = false;
    btn.textContent = '✅ Open My Link Now →';
  }
}, 1000);

function goContinue(){
  try { window.open('${MONETAG_SMART}', '_blank'); } catch(e){}
  setTimeout(function(){ window.location = '${finalDest}'; }, 400);
}
</script>
${PAGE_ADS}
</body>
</html>`);
  }
});

connectDB().then(() => {
  app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
}).catch(err => {
  console.error('❌ MongoDB connection failed:', err);
  process.exit(1);
});
