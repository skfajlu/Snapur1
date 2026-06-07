const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { MongoClient, ObjectId } = require('mongodb');
const app = express();
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;

const CONFIG = {
  RATE_PER_1000: 1,
  MIN_WITHDRAW: 5,
  ADMIN_USER: 'admin',
  ADMIN_PASS: 'snapurl@admin123'
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
  res.json({ success: true, token: user.token, user: safe });
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  const user = await db.collection('users').findOne({ email, password: hash(password) });
  if (!user) return res.status(401).json({ error: 'Invalid email or password!' });
  if (user.status === 'banned') return res.status(403).json({ error: 'Account banned!' });
  const { password: _, _id, ...safe } = user;
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
  const link = { userId: user._id, username: user.username, original: url.startsWith('http') ? url : 'https://' + url, code, clicks: 0, weekData: [0,0,0,0,0,0,0], earnings: 0, created: new Date() };
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
  
  const step = parseInt(req.query.step || '1');
  
  // Only count click ONCE using cookie
  const cookieKey = 'clicked_' + link.code;
  const alreadyCounted = req.headers.cookie && req.headers.cookie.includes(cookieKey);
  
  if (!alreadyCounted) {
    const day = new Date().getDay();
    const dayIdx = day === 0 ? 6 : day - 1;
    const earned = CONFIG.RATE_PER_1000 / 1000;
    await db.collection('links').updateOne({ _id: link._id }, { $inc: { clicks: 1, earnings: earned, [`weekData.${dayIdx}`]: 1 } });
    await db.collection('users').updateOne({ _id: link.userId }, { $inc: { balance: earned, totalEarned: earned, totalClicks: 1 } });
    res.setHeader('Set-Cookie', cookieKey + '=1; Max-Age=86400; Path=/');
  }

  const smartlink = 'https://www.effectivecpmnetwork.com/vfyqtz053?key=6ed7352ab0dae54ecdac81b78d85306b';
  
  // After 3 ad pages, go to final destination
  const nextUrl = step < 3 
    ? (req.protocol + '://' + req.get('host') + '/' + link.code + '?step=' + (step+1))
    : link.original;

  res.send(`<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Please Wait — SnapURL</title>

<!-- Google AdSense -->
<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-1308261075486301" crossorigin="anonymous"></script>

<!-- Adsterra Popunder -->
<script src="https://pl29650954.effectivecpmnetwork.com/45/f0/f0/45f0f0217d9b1d4c90020d41e0072759.js"></script>

<!-- Monetag -->
<script src="https://quge5.com/88/tag.min.js" data-zone="246854" async data-cfasync="false"></script>

<!-- Hilltop -->
<script async src="https://idealistic-revenue.com/bC3iVd0SP.3zphv-bwm/V/J/ZUDV0k3jM_ToErz/NeTLImxRLmTUcuxAM/TkMx1NMSjMUi"></script>

<!-- Adsterra Social Bar -->
<script src="https://pl29650956.effectivecpmnetwork.com/ff/76/34/ff7634d987cf09fe00a2bb121e9b0759.js"></script>

<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#080b10;color:#e8edf5;font-family:'Segoe UI',sans-serif;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:16px;position:relative;overflow-x:hidden}

/* BG */
body::before{content:'';position:fixed;inset:0;background:radial-gradient(ellipse at 20% 50%,rgba(0,229,255,0.05),transparent 60%),radial-gradient(ellipse at 80% 20%,rgba(0,255,148,0.04),transparent 60%);pointer-events:none}

.logo{font-size:24px;font-weight:900;letter-spacing:-1px;margin-bottom:20px;color:#fff}
.logo span{color:#00e5ff}

/* MAIN BOX */
.box{background:#141820;border:1px solid #2a3347;border-radius:16px;padding:24px;width:100%;max-width:480px;text-align:center;position:relative;z-index:5}

.step-bar{display:flex;justify-content:center;gap:8px;margin-bottom:18px}
.step-dot{width:10px;height:10px;border-radius:50%;background:#1e2535;transition:all .3s}
.step-dot.active{background:#00e5ff;box-shadow:0 0 8px #00e5ff}
.step-dot.done{background:#00ff94}

h2{font-size:18px;font-weight:700;margin-bottom:6px}
.subtitle{color:#8892aa;font-size:13px;margin-bottom:20px}

/* TIMER */
.timer-wrap{position:relative;width:90px;height:90px;margin:0 auto 20px}
.timer-svg{transform:rotate(-90deg)}
.timer-track{fill:none;stroke:#1e2535;stroke-width:6}
.timer-fill{fill:none;stroke:#00e5ff;stroke-width:6;stroke-linecap:round;stroke-dasharray:251;stroke-dashoffset:0;transition:stroke-dashoffset 1s linear}
.timer-num{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:26px;font-weight:900;color:#00e5ff;font-family:monospace}

/* ADS AREA */
.ads-area{margin:16px 0;min-height:60px}

/* BANNER ADS */
.banner-ad{margin:10px 0;text-align:center;overflow:hidden;border-radius:8px}

/* BTN */
.continue-btn{display:none;background:linear-gradient(135deg,#00e5ff,#00ff94);color:#000;border:none;padding:14px 32px;border-radius:10px;font-size:15px;font-weight:800;cursor:pointer;width:100%;margin-top:12px;letter-spacing:0.5px;transition:transform .2s,box-shadow .2s}
.continue-btn:hover{transform:scale(1.02);box-shadow:0 8px 24px rgba(0,229,255,0.3)}

/* BOTTOM FULL ADS */
.bottom-ads{width:100%;max-width:480px;margin-top:16px;position:relative;z-index:5}

/* VISIT NOTE */
.visit-note{font-size:11px;color:#5a6480;margin-top:12px}

/* RESPONSIVE */
@media(max-width:500px){
  .box{padding:18px}
  h2{font-size:16px}
}
</style>
</head>
<body>

<div class="logo">Snap<span>URL</span></div>

<div class="box">
  <!-- Step indicators -->
  <div class="step-bar">
    <div class="step-dot active" id="d1"></div>
    <div class="step-dot" id="d2"></div>
    <div class="step-dot" id="d3"></div>
  </div>

  <h2 id="stepTitle">Step 1 of 3 — Loading your link</h2>
  <div class="subtitle" id="stepSub">Please wait while ads load...</div>

  <!-- Circular Timer -->
  <div class="timer-wrap">
    <svg class="timer-svg" width="90" height="90" viewBox="0 0 90 90">
      <circle class="timer-track" cx="45" cy="45" r="40"/>
      <circle class="timer-fill" id="timerCircle" cx="45" cy="45" r="40"/>
    </svg>
    <div class="timer-num" id="timerNum">15</div>
  </div>

  <!-- Native Banner Ad -->
  <div class="ads-area">
    <script async="async" data-cfasync="false" src="https://pl29650957.effectivecpmnetwork.com/e3a3360597029776287aab752f162417/invoke.js"></script>
    <div id="container-e3a3360597029776287aab752f162417"></div>
  </div>

  <!-- 300x250 Banner -->
  <div class="banner-ad">
    <script>atOptions={'key':'b76e8b64701bb06eb8ba8f10895e4bb5','format':'iframe','height':250,'width':300,'params':{}}</script>
    <script src="https://www.highperformanceformat.com/b76e8b64701bb06eb8ba8f10895e4bb5/invoke.js"></script>
  </div>

  <button class="continue-btn" id="continueBtn" onclick="goNext()">
    Continue ➜
  </button>

  <div class="visit-note">Ad-supported free service • SnapURL</div>
</div>

<!-- Bottom 468x60 Banner -->
<div class="bottom-ads">
  <div class="banner-ad">
    <script>atOptions={'key':'9f3e2abb4418d71c3c3e09109a24d27b','format':'iframe','height':60,'width':468,'params':{}}</script>
    <script src="https://www.highperformanceformat.com/9f3e2abb4418d71c3c3e09109a24d27b/invoke.js"></script>
  </div>
</div>

<script>
var step = ${step};
var nextUrl = '${nextUrl}';
var totalTime = 15;
var timeLeft = totalTime;
var circumference = 251;

var titles = ['Step 1 of 3 — Loading your link','Step 2 of 3 — Almost there!','Step 3 of 3 — Ready to go!'];
var subs = ['Please wait, ads are loading...','Just a few more seconds...','Your link is ready!'];

document.getElementById('stepTitle').textContent = titles[step-1];
document.getElementById('stepSub').textContent = subs[step-1];

// Mark dots
for(var i=1;i<=3;i++){
  var d = document.getElementById('d'+i);
  if(i < step){ d.classList.remove('active'); d.classList.add('done'); }
  else if(i === step){ d.classList.add('active'); }
}

var circle = document.getElementById('timerCircle');
var numEl = document.getElementById('timerNum');
var btn = document.getElementById('continueBtn');

var iv = setInterval(function(){
  timeLeft--;
  numEl.textContent = timeLeft;
  
  // Update circle
  var offset = circumference * (timeLeft / totalTime);
  circle.style.strokeDashoffset = circumference - offset;
  
  if(timeLeft <= 0){
    clearInterval(iv);
    numEl.textContent = '✓';
    circle.style.stroke = '#00ff94';
    btn.style.display = 'block';
    // Open smartlinks when timer ends
  window.open('https://www.effectivecpmnetwork.com/vfyqtz053?key=6ed7352ab0dae54ecdac81b78d85306b', '_blank');
  window.open('https://omg10.com/4/11112574', '_blank');
  setTimeout(function(){ window.location = nextUrl; }, 1000);
  }
}, 1000);

function goNext(){
  // Open smartlinks in new tabs for extra earning
  window.open('https://www.effectivecpmnetwork.com/vfyqtz053?key=6ed7352ab0dae54ecdac81b78d85306b', '_blank');
  window.open('https://omg10.com/4/11112574', '_blank');
  setTimeout(function(){ window.location = nextUrl; }, 300);
}
</script>
</body>
</html>`);
});

connectDB().then(() => {
  app.listen(PORT, () => console.log(`✅ SnapURL running on port ${PORT}`));
}).catch(err => {
  console.error('MongoDB connection failed:', err);
  process.exit(1);
});
