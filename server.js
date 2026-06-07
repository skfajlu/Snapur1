const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { MongoClient, ObjectId } = require('mongodb');
const app = express();
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;

const CONFIG = {
  RATE_PER_1000_IN: 4.5,   // India
  RATE_PER_1000_US: 12,    // US/UK/AU
  RATE_PER_1000_OTHER: 2,  // Other countries
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
  const cookieCounted = req.headers.cookie && req.headers.cookie.includes(cookieKey);
  // Also check IP in DB (24 hour window)
  const visitorIP = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
  const ipCheck = await db.collection('ip_clicks').findOne({ 
    ip: visitorIP, 
    linkCode: link.code,
    createdAt: { $gte: new Date(Date.now() - 24*60*60*1000) }
  });
  const alreadyCounted = cookieCounted || !!ipCheck;
  
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


  const finalDest = link.original;
  const linkCode = link.code;
  const pg = parseInt(req.query.pg || '1');

  const ADSTERRA_SMART = 'https://www.effectivecpmnetwork.com/vfyqtz053?key=6ed7352ab0dae54ecdac81b78d85306b';
  const MONETAG_SMART = 'https://omg10.com/4/11112574';
  const baseUrl = req.protocol + '://' + req.get('host') + '/' + linkCode;

  // Page URLs
  const nextPage = pg < 5 ? baseUrl + '?pg=' + (pg+1) : finalDest;

  // All ad scripts
  const AD_SCRIPTS = `
    <!-- Google AdSense -->
    <script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-1308261075486301" crossorigin="anonymous"></script>
    <!-- Adsterra Popunder -->
    <script src="https://pl29650954.effectivecpmnetwork.com/45/f0/f0/45f0f0217d9b1d4c90020d41e0072759.js"></script>
    <!-- Adsterra Social Bar -->
    <script src="https://pl29650956.effectivecpmnetwork.com/ff/76/34/ff7634d987cf09fe00a2bb121e9b0759.js"></script>
    <!-- Monetag -->
    <script src="https://quge5.com/88/tag.min.js" data-zone="246854" async data-cfasync="false"></script>
    <!-- Hilltop -->
    <script async src="https://idealistic-revenue.com/bC3iVd0SP.3zphv-bwm/V/J/ZUDV0k3jM_ToErz/NeTLImxRLmTUcuxAM/TkMx1NMSjMUi"></script>
  `;

  const BANNER_300 = `
    <div style="text-align:center;margin:12px 0">
      <script>atOptions={'key':'b76e8b64701bb06eb8ba8f10895e4bb5','format':'iframe','height':250,'width':300,'params':{}}</script>
      <script src="https://www.highperformanceformat.com/b76e8b64701bb06eb8ba8f10895e4bb5/invoke.js"></script>
    </div>`;

  const BANNER_468 = `
    <div style="text-align:center;margin:12px 0">
      <script>atOptions={'key':'9f3e2abb4418d71c3c3e09109a24d27b','format':'iframe','height':60,'width':468,'params':{}}</script>
      <script src="https://www.highperformanceformat.com/9f3e2abb4418d71c3c3e09109a24d27b/invoke.js"></script>
    </div>`;

  const NATIVE = `
    <div style="text-align:center;margin:12px 0">
      <script async="async" data-cfasync="false" src="https://pl29650957.effectivecpmnetwork.com/e3a3360597029776287aab752f162417/invoke.js"></script>
      <div id="container-e3a3360597029776287aab752f162417"></div>
    </div>`;

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
    .btn{background:linear-gradient(135deg,#00e5ff,#00ff94);color:#000;border:none;padding:14px 28px;border-radius:10px;font-size:15px;font-weight:800;cursor:pointer;width:100%;margin:10px 0;letter-spacing:0.5px;transition:transform .2s}
    .btn:hover{transform:scale(1.02)}
    .btn:disabled{background:#333;color:#666;cursor:not-allowed;transform:none}
    .timer-box{background:#0d0d0d;border:2px solid #00e5ff;border-radius:12px;padding:20px;text-align:center;margin:16px 0}
    .timer-num{font-size:52px;font-weight:900;color:#00e5ff;font-family:monospace;line-height:1}
    .timer-label{color:#666;font-size:13px;margin-top:6px}
    .captcha-box{background:#111;border:2px solid #333;border-radius:8px;padding:16px;display:flex;align-items:center;gap:14px;margin:16px 0;cursor:pointer;transition:border-color .2s}
    .captcha-box:hover{border-color:#00e5ff}
    .captcha-check{width:24px;height:24px;border:2px solid #555;border-radius:4px;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:all .3s}
    .captcha-check.checked{background:#00e5ff;border-color:#00e5ff;color:#000;font-size:14px;font-weight:700}
    .captcha-text{font-size:14px;color:#ccc}
    .captcha-logo{margin-left:auto;text-align:right;font-size:10px;color:#555}
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
<style>${CSS}</style>
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
  </div>
</div>

<div class="content">
  <div class="card">
    <h1>🔗 Your Link is Almost Ready!</h1>
    <p class="blog-text">Welcome to <span class="highlight">SnapURL</span> — India's fastest free link shortener. You are just a few steps away from accessing your destination link. Please complete the verification below to continue.</p>
  </div>

  ${NATIVE}
  ${BANNER_300}

  <div class="card">
    <h2>📖 About Link Shorteners</h2>
    <p class="blog-text">Link shorteners help you share long URLs in a compact format. They are widely used in social media, messaging apps, and email campaigns. SnapURL provides <span class="highlight">free link shortening</span> with real-time analytics.</p>
    <p class="blog-text">Our service supports <span class="highlight">custom aliases</span>, click tracking, and earnings for registered users. Every click you make helps support our free service through advertisements.</p>
  </div>

  ${BANNER_468}

  <div class="card">
    <h2>📊 How Link Shorteners Work</h2>
    <p class="blog-text">When you click a short link, you are first directed to our server which records your visit and then redirects you to the final destination. This process takes milliseconds and is completely safe.</p>
    <p class="blog-text">SnapURL uses <span class="highlight">256-bit SSL encryption</span> to ensure your data is always safe. All redirects are logged for analytics purposes only.</p>
  </div>

  <div class="card">
    <h2>🛡️ Safe & Secure Browsing</h2>
    <p class="blog-text">All links on SnapURL are scanned for malware and phishing. We ensure your safety while browsing. Our system uses advanced AI to detect harmful links and block them automatically.</p>
    <p class="blog-text">Remember: <span class="highlight">Never share personal information</span> on unknown websites. SnapURL will never ask for your password or credit card details.</p>
  </div>

  ${BANNER_300}
  ${NATIVE}

  <div class="card">
    <h2>💡 Tips for Safe Internet Use</h2>
    <p class="blog-text">1. Always check the URL before clicking any link.</p>
    <p class="blog-text">2. Use strong passwords and enable two-factor authentication.</p>
    <p class="blog-text">3. Keep your browser and antivirus updated.</p>
    <p class="blog-text">4. Avoid downloading files from unknown sources.</p>
    <p class="blog-text">5. Use a VPN for extra privacy and security.</p>
  </div>

  ${BANNER_468}

  <div class="warning-box">
    ⚠️ Please complete the verification below to access your link. This helps us prevent bots and spam.
  </div>

  <div class="captcha-box" id="captchaBox" onclick="doCaptcha()">
    <div class="captcha-check" id="captchaCheck"></div>
    <div class="captcha-text">I am not a robot</div>
    <div class="captcha-logo">reCAPTCHA<br><span style="font-size:9px">Privacy · Terms</span></div>
  </div>

  <button class="btn" id="continueBtn" disabled onclick="goContinue()">
    ✓ Verify & Continue →
  </button>

  ${BANNER_300}
</div>

<script>
var captchaDone = false;
function doCaptcha() {
  if (captchaDone) return;
  // Open ad pages
  window.open('${ADSTERRA_SMART}', '_blank');
  window.open('${MONETAG_SMART}', '_blank');
  
  var check = document.getElementById('captchaCheck');
  var btn = document.getElementById('continueBtn');
  
  // Animate check
  setTimeout(function(){
    check.textContent = '✓';
    check.classList.add('checked');
    captchaDone = true;
    btn.disabled = false;
    btn.textContent = '✓ Verified! Click to Continue →';
  }, 1500);
}

function goContinue() {
  if (!captchaDone) return;
  window.location = '${nextPage}';
}
</script>
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
  </div>
</div>

<div class="content">
  <div class="timer-box">
    <div class="timer-num" id="timerNum">15</div>
    <div class="timer-label">Please wait...</div>
    <div class="progress-bar"><div class="progress-fill" id="progressFill" style="width:100%"></div></div>
  </div>

  ${NATIVE}
  ${BANNER_300}

  <div class="card">
    <h2>⏳ Why do we show ads?</h2>
    <p class="blog-text">SnapURL is a completely <span class="highlight">free service</span>. We rely on advertisements to keep this service running. By viewing ads, you help us maintain servers, development, and security.</p>
    <p class="blog-text">Thank you for your patience! Your link will be ready soon.</p>
  </div>

  ${BANNER_468}
  ${BANNER_300}

  <div class="scroll-hint" id="scrollHint">👇 Scroll down to continue</div>
  <button class="btn" id="continueBtn" onclick="goContinue()">Continue to Next Step →</button>

  ${NATIVE}
</div>

<script>
var t = 15;
var timerEl = document.getElementById('timerNum');
var progressEl = document.getElementById('progressFill');
var scrollHint = document.getElementById('scrollHint');
var btn = document.getElementById('continueBtn');
var scrollDone = false;

var iv = setInterval(function(){
  t--;
  timerEl.textContent = t;
  progressEl.style.width = (t/15*100) + '%';
  if(t <= 0){
    clearInterval(iv);
    timerEl.textContent = '✓';
    timerEl.style.color = '#00ff94';
    if(scrollDone){ btn.style.display='block'; scrollHint.style.display='none'; }
  }
}, 2000);

window.addEventListener('scroll', function(){
  if(!scrollDone && window.scrollY > 200 && t <= 0){
    scrollDone = true;
    scrollHint.style.display = 'none';
    btn.style.display = 'block';
  } else if(!scrollDone && window.scrollY > 200){
    scrollDone = true;
  }
  if(scrollDone && t <= 0){
    scrollHint.style.display = 'none';
    btn.style.display = 'block';
  }
});

function goContinue(){
  window.open('${ADSTERRA_SMART}', '_blank');
  window.open('${MONETAG_SMART}', '_blank');
  window.location = '${nextPage}';
}
</script>
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
<style>${CSS}</style>
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
  </div>
</div>

<div class="content">
  <div class="card">
    <h1>⚡ Almost There!</h1>
    <p class="blog-text">You are <span class="highlight">60% done</span>! Just a couple more steps and your link will be ready.</p>
  </div>

  <div class="timer-box">
    <div class="timer-num" id="timerNum">15</div>
    <div class="timer-label">Preparing your link...</div>
    <div class="progress-bar"><div class="progress-fill" id="progressFill" style="width:100%"></div></div>
  </div>

  ${BANNER_300}
  ${NATIVE}
  ${BANNER_468}

  <div class="card">
    <h2>🚀 Did you know?</h2>
    <p class="blog-text">SnapURL users earn real money by sharing short links! Register today and start earning <span class="highlight">$1 per 1000 clicks</span> on your links. Share with friends and family to maximize your earnings.</p>
  </div>

  ${BANNER_300}

  <button class="btn" id="continueBtn" disabled onclick="goContinue()">Continue →</button>
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
    btn.textContent = 'Continue →';
  }
}, 2000);

function goContinue(){
  window.open('${ADSTERRA_SMART}', '_blank');
  window.open('${MONETAG_SMART}', '_blank');
  window.location = '${nextPage}';
}
</script>
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
<style>${CSS}</style>
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
  </div>
</div>

<div class="content">
  ${NATIVE}
  ${BANNER_300}

  <div class="generate-box">
    <h2>🔗 Generate Your Link</h2>
    <p style="color:#8892aa;font-size:13px;margin-bottom:16px">Click the button below to generate your destination link</p>
    <div class="timer-box" style="margin:12px 0">
      <div class="timer-num" id="timerNum">7</div>
      <div class="timer-label">Generating link...</div>
    </div>
    <button class="btn" id="generateBtn" disabled onclick="goContinue()">
      🔗 Generate Link →
    </button>
  </div>

  ${BANNER_468}
  ${BANNER_300}
  ${NATIVE}
</div>

<script>
var t = 7;
var timerEl = document.getElementById('timerNum');
var btn = document.getElementById('generateBtn');

var iv = setInterval(function(){
  t--;
  timerEl.textContent = t;
  if(t <= 0){
    clearInterval(iv);
    timerEl.textContent = '✓';
    timerEl.style.color = '#00ff94';
    btn.disabled = false;
    btn.textContent = '🔗 Get Your Link →';
  }
}, 1500);

function goContinue(){
  window.open('${ADSTERRA_SMART}', '_blank');
  window.open('${MONETAG_SMART}', '_blank');
  window.location = '${nextPage}';
}
</script>
</body>
</html>`);

  // ═══════════════════════════════════════
  // PAGE 5 — Final Link
  // ═══════════════════════════════════════
  } else {
    res.send(`<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Your Link is Ready — SnapURL</title>
${AD_SCRIPTS}
<style>${CSS}</style>
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
  </div>
</div>

<div class="content">
  ${NATIVE}

  <div class="generate-box">
    <h2>🎉 Your Link is Ready!</h2>
    <p style="color:#8892aa;font-size:13px;margin-bottom:12px">Click below to visit your destination</p>
    <div class="timer-box" style="margin:12px 0">
      <div class="timer-num" id="timerNum">5</div>
      <div class="timer-label">Redirecting soon...</div>
    </div>
    <div class="final-link">
      <a href="${finalDest}" target="_blank">🔗 Click here to open your link</a>
    </div>
    <button class="btn" id="finalBtn" onclick="goFinal()">
      ✅ Open My Link →
    </button>
  </div>

  ${BANNER_300}
  ${BANNER_468}
  ${NATIVE}
  ${BANNER_300}
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
}, 1000);

function goFinal(){
  window.open('${ADSTERRA_SMART}', '_blank');
  window.location = '${finalDest}';
}
</script>
</body>
</html>`);
  }
});


