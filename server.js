const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const app = express();
const PORT = process.env.PORT || 3000;

// ── DB Files ──
const USERS_DB = path.join(__dirname, 'users.json');
const LINKS_DB = path.join(__dirname, 'links.json');
const WITHDRAW_DB = path.join(__dirname, 'withdrawals.json');

const readDB = (file, def=[]) => { try { return JSON.parse(fs.readFileSync(file)); } catch { return def; } };
const writeDB = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2));

if (!fs.existsSync(USERS_DB)) writeDB(USERS_DB, []);
if (!fs.existsSync(LINKS_DB)) writeDB(LINKS_DB, []);
if (!fs.existsSync(WITHDRAW_DB)) writeDB(WITHDRAW_DB, []);

// ── Config ──
const CONFIG = {
  RATE_PER_1000: 1, // $10 per 1000 clicks
  MIN_WITHDRAW: 5,   // Minimum $5 withdrawal
  ADMIN_USER: 'admin',
  ADMIN_PASS: 'snapurl@admin123'
};

app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ── Helper ──
function hash(str) { return crypto.createHash('sha256').update(str).digest('hex'); }
function randCode(len=6) { return Math.random().toString(36).slice(2, 2+len); }
function getUser(token) { return readDB(USERS_DB).find(u => u.token === token); }

// ══════════════════════════════════════
// AUTH ROUTES
// ══════════════════════════════════════

// Register
app.post('/api/register', (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password) return res.status(400).json({ error: 'All fields required' });
  
  const users = readDB(USERS_DB);
  if (users.find(u => u.email === email)) return res.status(409).json({ error: 'Email already registered!' });
  if (users.find(u => u.username === username)) return res.status(409).json({ error: 'Username taken!' });
  
  const user = {
    id: Date.now(),
    username, email,
    password: hash(password),
    token: randCode(32),
    balance: 0,
    totalEarned: 0,
    totalLinks: 0,
    totalClicks: 0,
    joined: new Date().toISOString(),
    status: 'active'
  };
  users.push(user);
  writeDB(USERS_DB, users);
  
  const { password: _, ...safeUser } = user;
  res.json({ success: true, token: user.token, user: safeUser });
});

// Login
app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  const users = readDB(USERS_DB);
  const user = users.find(u => u.email === email && u.password === hash(password));
  if (!user) return res.status(401).json({ error: 'Invalid email or password!' });
  if (user.status === 'banned') return res.status(403).json({ error: 'Account banned!' });
  
  const { password: _, ...safeUser } = user;
  res.json({ success: true, token: user.token, user: safeUser });
});

// Get profile
app.get('/api/me', (req, res) => {
  const token = req.headers.authorization;
  const user = getUser(token);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const { password: _, ...safeUser } = user;
  res.json(safeUser);
});

// ══════════════════════════════════════
// LINK ROUTES
// ══════════════════════════════════════

// Shorten
app.post('/api/shorten', (req, res) => {
  const token = req.headers.authorization;
  const user = getUser(token);
  if (!user) return res.status(401).json({ error: 'Login required to shorten links!' });
  
  const { url, alias } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });
  
  const links = readDB(LINKS_DB);
  const code = alias || randCode(6);
  if (links.find(l => l.code === code)) return res.status(409).json({ error: 'Alias taken!' });
  
  const link = {
    id: Date.now(),
    userId: user.id,
    username: user.username,
    original: url.startsWith('http') ? url : 'https://' + url,
    code, clicks: 0,
    weekData: [0,0,0,0,0,0,0],
    earnings: 0,
    created: new Date().toISOString()
  };
  links.unshift(link);
  writeDB(LINKS_DB, links);
  
  // Update user link count
  const users = readDB(USERS_DB);
  const idx = users.findIndex(u => u.id === user.id);
  users[idx].totalLinks++;
  writeDB(USERS_DB, users);
  
  res.json({ short: `${req.protocol}://${req.get('host')}/${code}`, code });
});

// Get user links
app.get('/api/my-links', (req, res) => {
  const token = req.headers.authorization;
  const user = getUser(token);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const links = readDB(LINKS_DB).filter(l => l.userId === user.id);
  res.json(links);
});

// ══════════════════════════════════════
// WITHDRAW ROUTES
// ══════════════════════════════════════

app.post('/api/withdraw', (req, res) => {
  const token = req.headers.authorization;
  const user = getUser(token);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  
  const { amount, method, details } = req.body;
  if (!amount || !method || !details) return res.status(400).json({ error: 'All fields required' });
  if (amount < CONFIG.MIN_WITHDRAW) return res.status(400).json({ error: `Minimum withdrawal is $${CONFIG.MIN_WITHDRAW}` });
  if (user.balance < amount) return res.status(400).json({ error: 'Insufficient balance!' });
  
  // Deduct balance
  const users = readDB(USERS_DB);
  const idx = users.findIndex(u => u.id === user.id);
  users[idx].balance -= amount;
  writeDB(USERS_DB, users);
  
  // Create withdrawal request
  const withdrawals = readDB(WITHDRAW_DB);
  withdrawals.unshift({
    id: Date.now(),
    userId: user.id,
    username: user.username,
    amount, method, details,
    status: 'pending',
    created: new Date().toISOString()
  });
  writeDB(WITHDRAW_DB, withdrawals);
  
  res.json({ success: true, message: 'Withdrawal request submitted! Admin will process in 24-48 hours.' });
});

app.get('/api/my-withdrawals', (req, res) => {
  const token = req.headers.authorization;
  const user = getUser(token);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const w = readDB(WITHDRAW_DB).filter(w => w.userId === user.id);
  res.json(w);
});

// ══════════════════════════════════════
// ADMIN ROUTES
// ══════════════════════════════════════

function adminAuth(req, res, next) {
  const { user, pass } = req.headers;
  if (user === CONFIG.ADMIN_USER && pass === CONFIG.ADMIN_PASS) return next();
  res.status(401).json({ error: 'Admin access denied' });
}

app.get('/api/admin/stats', adminAuth, (req, res) => {
  const users = readDB(USERS_DB);
  const links = readDB(LINKS_DB);
  const withdrawals = readDB(WITHDRAW_DB);
  res.json({
    totalUsers: users.length,
    totalLinks: links.length,
    totalClicks: links.reduce((a,l)=>a+l.clicks,0),
    totalEarningsPaid: withdrawals.filter(w=>w.status==='paid').reduce((a,w)=>a+w.amount,0),
    pendingWithdrawals: withdrawals.filter(w=>w.status==='pending').length,
    pendingAmount: withdrawals.filter(w=>w.status==='pending').reduce((a,w)=>a+w.amount,0)
  });
});

app.get('/api/admin/users', adminAuth, (req, res) => {
  const users = readDB(USERS_DB).map(({password,...u})=>u);
  res.json(users);
});

app.get('/api/admin/withdrawals', adminAuth, (req, res) => {
  res.json(readDB(WITHDRAW_DB));
});

app.post('/api/admin/withdraw/:id', adminAuth, (req, res) => {
  const { status } = req.body;
  const withdrawals = readDB(WITHDRAW_DB);
  const idx = withdrawals.findIndex(w => w.id == req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  
  // If rejecting, refund balance
  if (status === 'rejected' && withdrawals[idx].status === 'pending') {
    const users = readDB(USERS_DB);
    const uidx = users.findIndex(u => u.id === withdrawals[idx].userId);
    if (uidx !== -1) { users[uidx].balance += withdrawals[idx].amount; writeDB(USERS_DB, users); }
  }
  withdrawals[idx].status = status;
  withdrawals[idx].processedAt = new Date().toISOString();
  writeDB(WITHDRAW_DB, withdrawals);
  res.json({ success: true });
});

app.post('/api/admin/user/:id/ban', adminAuth, (req, res) => {
  const users = readDB(USERS_DB);
  const idx = users.findIndex(u => u.id == req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  users[idx].status = users[idx].status === 'banned' ? 'active' : 'banned';
  writeDB(USERS_DB, users);
  res.json({ success: true, status: users[idx].status });
});

// ══════════════════════════════════════
// REDIRECT (with earnings)
// ══════════════════════════════════════

app.get('/:code', (req, res) => {
  const reserved = ['about.html','terms.html','privacy.html','admin.html','dashboard.html','register.html','login.html'];
  if (reserved.includes(req.params.code)) return res.sendFile(path.join(__dirname, req.params.code));
  
  const links = readDB(LINKS_DB);
  const link = links.find(l => l.code === req.params.code);
  if (!link) return res.status(404).send('Link not found!');
  
  // Track click + add earnings
  link.clicks++;
  const day = new Date().getDay();
  link.weekData[day === 0 ? 6 : day - 1]++;
  const earned = CONFIG.RATE_PER_1000 / 1000;
  link.earnings = (link.earnings || 0) + earned;
  writeDB(LINKS_DB, links);
  
  // Update user balance
  const users = readDB(USERS_DB);
  const uidx = users.findIndex(u => u.id === link.userId);
  if (uidx !== -1) {
    users[uidx].balance = (users[uidx].balance || 0) + earned;
    users[uidx].totalEarned = (users[uidx].totalEarned || 0) + earned;
    users[uidx].totalClicks = (users[uidx].totalClicks || 0) + 1;
    writeDB(USERS_DB, users);
  }
  
  // Show interstitial ad page then redirect
  res.send(`<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>SnapURL — Please Wait</title>
<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-1308261075486301" crossorigin="anonymous"></script>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:#080b10;color:#e8edf5;font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;flex-direction:column;gap:20px;text-align:center;padding:24px}
  .logo{font-size:28px;font-weight:900;letter-spacing:-1px}
  .logo span{color:#00e5ff}
  .box{background:#141820;border:1px solid #1e2535;border-radius:16px;padding:32px;max-width:400px;width:100%}
  h2{font-size:20px;margin-bottom:8px}
  p{color:#8892aa;font-size:14px;margin-bottom:20px}
  .timer{font-size:48px;font-weight:900;color:#00e5ff;font-family:monospace}
  .btn{display:none;background:#00e5ff;color:#000;padding:14px 32px;border:none;border-radius:8px;font-size:15px;font-weight:700;cursor:pointer;width:100%;margin-top:16px}
  .btn:hover{background:#33ecff}
  .ad-area{margin:16px 0;min-height:60px}
</style>
</head>
<body>
<div class="logo">Snap<span>URL</span></div>
<div class="box">
  <h2>You are being redirected</h2>
  <p>Please wait while we redirect you to your destination</p>
  <div class="timer" id="timer">5</div>
  <div class="ad-area">
    <ins class="adsbygoogle" style="display:block" data-ad-client="ca-pub-1308261075486301" data-ad-slot="auto" data-ad-format="auto" data-full-width-responsive="true"></ins>
    <script>(adsbygoogle=window.adsbygoogle||[]).push({})</script>
  </div>
  <button class="btn" id="btn" onclick="window.location='${link.original}'">Continue to Site →</button>
</div>
<script>
  let t=5;
  const ti=document.getElementById('timer');
  const btn=document.getElementById('btn');
  const iv=setInterval(()=>{
    t--;
    ti.textContent=t;
    if(t<=0){
      clearInterval(iv);
      ti.textContent='✓';
      btn.style.display='block';
      setTimeout(()=>window.location='${link.original}',500);
    }
  },1000);
</script>
</body>
</html>`);
});

app.listen(PORT, () => console.log(`✅ SnapURL Full System running at http://localhost:${PORT}`));
