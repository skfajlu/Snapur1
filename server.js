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

app.get('/:code', async (req, res) => {
  const reserved = ['about.html','terms.html','privacy.html','admin.html','dashboard.html','register.html','login.html'];
  if (reserved.includes(req.params.code)) return res.sendFile(path.join(__dirname, req.params.code));
  const link = await db.collection('links').findOne({ code: req.params.code });
  if (!link) return res.status(404).send('Link not found!');
  
  const step = parseInt(req.query.step || '1');
  
  // Only count click on first step
  if (step === 1) {
    const day = new Date().getDay();
    const dayIdx = day === 0 ? 6 : day - 1;
    const earned = CONFIG.RATE_PER_1000 / 1000;
    await db.collection('links').updateOne({ _id: link._id }, { $inc: { clicks: 1, earnings: earned, [`weekData.${dayIdx}`]: 1 } });
    await db.collection('users').updateOne({ _id: link.userId }, { $inc: { balance: earned, totalEarned: earned, totalClicks: 1 } });
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
<title>SnapURL — Please Wait (Step ${step}/3)</title>
<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-1308261075486301" crossorigin="anonymous"></script>
<script src="https://pl29650954.effectivecpmnetwork.com/45/f0/f0/45f0f0217d9b1d4c90020d41e0072759.js"></script>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#080b10;color:#e8edf5;font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;flex-direction:column;gap:16px;text-align:center;padding:24px}
.logo{font-size:28px;font-weight:900;letter-spacing:-1px}
.logo span{color:#00e5ff}
.box{background:#141820;border:1px solid #1e2535;border-radius:16px;padding:28px;max-width:420px;width:100%}
h2{font-size:18px;margin-bottom:6px}
p{color:#8892aa;font-size:13px;margin-bottom:12px}
.steps{display:flex;justify-content:center;gap:8px;margin-bottom:14px}
.step{width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700}
.step.done{background:#00ff94;color:#000}
.step.active{background:#00e5ff;color:#000}
.step.todo{background:#1e2535;color:#8892aa}
.timer{font-size:48px;font-weight:900;color:#00e5ff;font-family:monospace;margin-bottom:12px}
.btn{display:none;background:#00e5ff;color:#000;padding:14px 32px;border:none;border-radius:8px;font-size:15px;font-weight:700;cursor:pointer;width:100%;margin-top:12px}
.ad-box{margin:8px 0;text-align:center}
</style>
</head>
<body>
<div class="logo">Snap<span>URL</span></div>
<div class="box">
<div class="steps">
  <div class="step ${step>1?'done':'active'}">1</div>
  <div class="step ${step>2?'done':step===2?'active':'todo'}">2</div>
  <div class="step ${step===3?'active':'todo'}">3</div>
</div>
<h2>Step ${step} of 3 — Almost there!</h2>
<p>Please wait while we prepare your link</p>
<div class="timer" id="t">15</div>

<div class="ad-box">
<script async="async" data-cfasync="false" src="https://pl29650957.effectivecpmnetwork.com/e3a3360597029776287aab752f162417/invoke.js"></script>
<div id="container-e3a3360597029776287aab752f162417"></div>
</div>

<div class="ad-box">
<script>atOptions={'key':'9f3e2abb4418d71c3c3e09109a24d27b','format':'iframe','height':60,'width':468,'params':{}}</script>
<script src="https://www.highperformanceformat.com/9f3e2abb4418d71c3c3e09109a24d27b/invoke.js"></script>
</div>

<div class="ad-box">
<script>atOptions={'key':'b76e8b64701bb06eb8ba8f10895e4bb5','format':'iframe','height':250,'width':300,'params':{}}</script>
<script src="https://www.highperformanceformat.com/b76e8b64701bb06eb8ba8f10895e4bb5/invoke.js"></script>
</div>

<button class="btn" id="btn" onclick="goNext()">
  ${step < 3 ? 'Next Step &rarr;' : 'Go to Site &rarr;'}
</button>
</div>
<script src="https://pl29650956.effectivecpmnetwork.com/ff/76/34/ff7634d987cf09fe00a2bb121e9b0759.js"></script>
<script>
function goNext() { window.location = '${nextUrl}'; }
let t=15;
const ti=document.getElementById('t'),btn=document.getElementById('btn');
const iv=setInterval(()=>{
  t--;
  ti.textContent=t;
  if(t<=0){
    clearInterval(iv);
    ti.textContent='✓';
    btn.style.display='block';
    setTimeout(goNext, 500);
  }
},1000);
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
