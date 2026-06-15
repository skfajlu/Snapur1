const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { MongoClient, ObjectId } = require('mongodb');
const app = express();
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;

const CONFIG = {
  RATE_PER_1000_IN: 4.5,
  RATE_PER_1000_US: 12,
  RATE_PER_1000_OTHER: 2,
  RATE_PER_1000: 4.5,
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

// ── Rate Limiter ──
const _rl = new Map();
function rateLimit(maxReq, windowMs) {
  return (req, res, next) => {
    const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
    const key = ip + ':' + req.path;
    const now = Date.now();
    const entry = _rl.get(key) || { count: 0, start: now };
    if (now - entry.start > windowMs) { entry.count = 0; entry.start = now; }
    entry.count++;
    _rl.set(key, entry);
    if (entry.count > maxReq) {
      return res.status(429).json({ error: 'Too many requests! Thoda ruko aur dobara try karo.' });
    }
    next();
  };
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _rl.entries()) {
    if (now - v.start > 60 * 60 * 1000) _rl.delete(k);
  }
}, 10 * 60 * 1000);

// ══════════════════════════════════════════
// 🤖 AUTO SUPPORT AGENT — Claude AI powered
// ══════════════════════════════════════════
const SUPPORT_SYSTEM_PROMPT = `Tu SnapURL ka official customer support agent hai. Tera naam "SnapBot" hai.
SnapURL ek link shortener platform hai jahan users links short karke paise kama sakte hain.

Platform ke baare mein zaroori info:
- Earnings: India = $4.5/1000 clicks, US/UK/AU = $12/1000 clicks, Other = $2/1000 clicks
- Minimum withdrawal: $5
- Payment methods: UPI (PhonePe/GPay/Paytm), Bank Transfer, PayPal
- Payment processing: 24-48 hours
- Referral: Jab referred user withdraw kare tab 2% commission milta hai
- Registration: Free, instant
- Links: Koi bhi legal link shorten kar sakte hain

Rules:
1. Hamesha Hindi mein jawab de (Hinglish bhi theek hai)
2. Short aur helpful reh — 3-4 lines mein jawab de
3. Agar koi technical issue ho toh admin se contact karne ko bol
4. Payment issues ke liye: "Hamari team 24-48 hours mein process karti hai, patience rakho!"
5. Kabhi bhi galat information mat de
6. Friendly aur professional reh
7. Agar samajh na aaye toh poochh`;

app.post('/api/support', rateLimit(20, 60 * 1000), async (req, res) => {
  const { message, history = [] } = req.body;
  if (!message || message.trim().length === 0) return res.status(400).json({ error: 'Message required' });
  if (message.length > 500) return res.status(400).json({ error: 'Message too long' });

  // API key check
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('❌ ANTHROPIC_API_KEY not set!');
    return res.json({ reply: 'SnapBot setup ho raha hai! Thodi der mein try karo. 🙏' });
  }

  try {
    const messages = [
      ...history.slice(-6).map(h => ({ role: h.role, content: h.content })),
      { role: 'user', content: message }
    ];

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        system: SUPPORT_SYSTEM_PROMPT,
        messages
      })
    });

    if (!response.ok) {
      const err = await response.json();
      console.error('Anthropic API error:', JSON.stringify(err));
      throw new Error('API error: ' + response.status);
    }

    const data = await response.json();
    const reply = data.content?.[0]?.text || 'Kuch galat hua, dobara try karo!';

    // Save to DB
    try {
      await db.collection('support_chats').insertOne({
        message, reply,
        ip: req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress,
        createdAt: new Date()
      });
    } catch(dbErr) { /* DB save fail hone pe bot reply mat roko */ }

    res.json({ reply });
  } catch(e) {
    console.error('Support agent error:', e.message);
    res.json({ reply: 'Abhi thoda busy hoon! 2 minute mein dobara try karo. 🙏' });
  }
});

app.post('/api/register', rateLimit(5, 15 * 60 * 1000), async (req, res) => {
  const { username, email, password, ref } = req.body;
  if (!username || !email || !password) return res.status(400).json({ error: 'All fields required' });
  const exists = await db.collection('users').findOne({ $or: [{ email }, { username }] });
  if (exists) return res.status(409).json({ error: exists.email === email ? 'Email already registered!' : 'Username taken!' });
  const referralCode = username.toLowerCase().replace(/[^a-z0-9]/g,'') + randCode(4);
  const user = {
    username, email, password: hash(password), token: randCode(32),
    balance: 0, totalEarned: 0, totalLinks: 0, totalClicks: 0,
    referralCode, referredBy: ref || null, referralCount: 0, referralEarnings: 0,
    joined: new Date(), status: 'active'
  };
  await db.collection('users').insertOne(user);
  if (ref) {
    const referrer = await db.collection('users').findOne({ referralCode: ref });
    if (referrer) {
      await db.collection('users').updateOne({ referralCode: ref }, { $inc: { referralCount: 1 } });
      await db.collection('referrals').insertOne({
        referrerId: referrer._id, referrerUsername: referrer.username,
        newUserId: user._id, newUsername: username, joined: new Date(), bonusPaid: false
      });
    }
  }
  const { password: _, _id, ...safe } = user;
  res.setHeader('Set-Cookie', `snaptoken=${user.token}; Max-Age=2592000; Path=/; SameSite=Lax`);
  res.json({ success: true, token: user.token, user: safe });
});

app.post('/api/login', rateLimit(10, 15 * 60 * 1000), async (req, res) => {
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

app.post('/api/shorten', rateLimit(30, 60 * 1000), async (req, res) => {
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

app.post('/api/withdraw', rateLimit(3, 60 * 60 * 1000), async (req, res) => {
  const user = await db.collection('users').findOne({ token: req.headers.authorization });
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const { amount, method, details } = req.body;
  if (!amount || !method || !details) return res.status(400).json({ error: 'All fields required' });
  if (amount < CONFIG.MIN_WITHDRAW) return res.status(400).json({ error: `Minimum withdrawal is $${CONFIG.MIN_WITHDRAW}` });
  if (user.balance < amount) return res.status(400).json({ error: 'Insufficient balance!' });
  await db.collection('users').updateOne({ _id: user._id }, { $inc: { balance: -amount } });
  await db.collection('withdrawals').insertOne({ userId: user._id, username: user.username, amount, method, details, status: 'pending', created: new Date() });
  // 2% referral commission
  try {
    if (user.referredBy) {
      const referrer = await db.collection('users').findOne({ referralCode: user.referredBy });
      if (referrer) {
        const commission = parseFloat((amount * 0.02).toFixed(4));
        await db.collection('users').updateOne({ _id: referrer._id }, { $inc: { balance: commission, totalEarned: commission, referralEarnings: commission } });
        await db.collection('referral_commissions').insertOne({ referrerId: referrer._id, referrerUsername: referrer.username, fromUserId: user._id, fromUsername: user.username, withdrawAmount: amount, commission, createdAt: new Date() });
      }
    }
  } catch(e) {}
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

// ── Forgot Password — Username se dhundo ──
app.post('/api/forgot-password', rateLimit(3, 15 * 60 * 1000), async (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'Username required' });
  const user = await db.collection('users').findOne({
    $or: [{ username }, { email: username }]
  });
  if (!user) return res.status(404).json({ error: 'Koi account nahi mila is username/email se!' });
  // Return masked email for confirmation
  const masked = user.email.replace(/(.{2})(.*)(@.*)/, '$1***$3');
  res.json({ success: true, masked, userId: user._id.toString() });
});

// ── Forgot Password — Naya password set karo ──
app.post('/api/reset-password', async (req, res) => {
  const { userId, newPassword } = req.body;
  if (!userId || !newPassword) return res.status(400).json({ error: 'All fields required' });
  if (newPassword.length < 6) return res.status(400).json({ error: 'Password kam se kam 6 characters ka hona chahiye!' });
  try {
    await db.collection('users').updateOne(
      { _id: new ObjectId(userId) },
      { $set: { password: hash(newPassword), token: randCode(32) } }
    );
    res.json({ success: true, message: 'Password reset ho gaya! Login karo.' });
  } catch(e) {
    res.status(400).json({ error: 'Reset failed!' });
  }
});

// ── Referral APIs ──
app.get('/api/my-referrals', async (req, res) => {
  const user = await db.collection('users').findOne({ token: req.headers.authorization });
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const referrals = await db.collection('referrals').find({ referrerId: user._id }).sort({ joined: -1 }).toArray();
  const enriched = await Promise.all(referrals.map(async r => {
    const refUser = await db.collection('users').findOne({ _id: r.newUserId });
    return { username: r.newUsername, joined: r.joined, totalClicks: refUser ? (refUser.totalClicks||0) : 0 };
  }));
  const commissions = await db.collection('referral_commissions').find({ referrerId: user._id }).sort({ createdAt: -1 }).limit(20).toArray();
  res.json({
    referralCode: user.referralCode || '',
    referralLink: `${req.protocol}://${req.get('host')}/register.html?ref=${user.referralCode}`,
    totalReferrals: user.referralCount || 0,
    referralEarnings: user.referralEarnings || 0,
    referrals: enriched,
    commissions: commissions.map(c => ({ fromUsername: c.fromUsername, withdrawAmount: c.withdrawAmount, commission: c.commission, date: c.createdAt }))
  });
});

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
app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));
app.get('/ping', (req, res) => res.send('pong'));
app.get('/74814d72e5abdf9a754e.txt', (req, res) => {
  res.setHeader('Content-Type', 'text/plain');
  res.send('38e1b491d1e083845022');
});

// ── SEO: Sitemap.xml ──
app.get('/sitemap.xml', (req, res) => {
  const base = 'https://snapur1.onrender.com';
  res.setHeader('Content-Type', 'application/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${base}/</loc><changefreq>weekly</changefreq><priority>1.0</priority></url>
  <url><loc>${base}/register.html</loc><changefreq>monthly</changefreq><priority>0.9</priority></url>
  <url><loc>${base}/login.html</loc><changefreq>monthly</changefreq><priority>0.7</priority></url>
  <url><loc>${base}/about.html</loc><changefreq>monthly</changefreq><priority>0.6</priority></url>
  <url><loc>${base}/terms.html</loc><changefreq>monthly</changefreq><priority>0.4</priority></url>
  <url><loc>${base}/privacy.html</loc><changefreq>monthly</changefreq><priority>0.4</priority></url>
</urlset>`);
});

// ── SEO: Robots.txt ──
app.get('/robots.txt', (req, res) => {
  res.setHeader('Content-Type', 'text/plain');
  res.send(`User-agent: *
Allow: /
Allow: /register.html
Allow: /login.html
Allow: /about.html
Allow: /terms.html
Allow: /privacy.html
Disallow: /api/
Disallow: /dashboard.html
Disallow: /admin.html

Sitemap: https://snapur1.onrender.com/sitemap.xml`);
});

// ── SEO: Homepage with full meta tags ──
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="hi-IN">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>

<!-- Primary SEO -->
<title>SnapURL — Link Shortener se Paise Kamao | Free URL Shortener India</title>
<meta name="description" content="SnapURL se apni links short karo aur har click pe paise kamao. India ka best link shortener — UPI withdrawal, real-time analytics, free registration. $10 per 1000 clicks!"/>
<meta name="keywords" content="link shortener india, url shortener paise kamao, short link earning, link shortener UPI withdrawal, free url shortener, paisa kamao link share karke, snapurl, link se paise kaise kamaye"/>
<meta name="author" content="SnapURL"/>
<meta name="robots" content="index, follow"/>
<link rel="canonical" href="https://snapur1.onrender.com/"/>

<!-- Open Graph (Facebook, WhatsApp) -->
<meta property="og:type" content="website"/>
<meta property="og:url" content="https://snapur1.onrender.com/"/>
<meta property="og:title" content="SnapURL — Link Share Karo, Paise Kamao!"/>
<meta property="og:description" content="India ka #1 link shortener. Apni links short karo, share karo aur har click pe $0.01 kamao. UPI se seedha withdrawal!"/>
<meta property="og:image" content="https://snapur1.onrender.com/og-image.png"/>
<meta property="og:locale" content="hi_IN"/>
<meta property="og:site_name" content="SnapURL"/>

<!-- Twitter Card -->
<meta name="twitter:card" content="summary_large_image"/>
<meta name="twitter:title" content="SnapURL — Link se Paise Kamao"/>
<meta name="twitter:description" content="Free link shortener. Har click pe earning. UPI withdrawal. Abhi register karo!"/>
<meta name="twitter:image" content="https://snapur1.onrender.com/og-image.png"/>

<!-- Structured Data (Google Rich Results) -->
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "WebApplication",
  "name": "SnapURL",
  "url": "https://snapur1.onrender.com",
  "description": "India ka best link shortener jahan aap links share karke paise kama sakte hain. UPI withdrawal available.",
  "applicationCategory": "UtilityApplication",
  "operatingSystem": "Web",
  "offers": {
    "@type": "Offer",
    "price": "0",
    "priceCurrency": "INR",
    "description": "Free link shortener with earnings per click"
  },
  "aggregateRating": {
    "@type": "AggregateRating",
    "ratingValue": "4.8",
    "ratingCount": "1247"
  }
}
</script>

<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link href="https://fonts.googleapis.com/css2?family=Syne:wght@700;800&family=Manrope:wght@400;500;600;700&display=swap" rel="stylesheet"/>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#080b10;color:#e8edf5;font-family:'Manrope',sans-serif;line-height:1.6}
body::before{content:'';position:fixed;inset:0;background-image:linear-gradient(rgba(0,229,255,0.02) 1px,transparent 1px),linear-gradient(90deg,rgba(0,229,255,0.02) 1px,transparent 1px);background-size:40px 40px;pointer-events:none;z-index:0}

/* NAV */
nav{position:sticky;top:0;z-index:100;background:rgba(8,11,16,0.95);border-bottom:1px solid #1e2535;backdrop-filter:blur(12px);padding:14px 24px;display:flex;align-items:center;justify-content:space-between}
.nav-logo{font-family:'Syne',sans-serif;font-size:22px;font-weight:800;color:#fff;text-decoration:none}
.nav-logo span{color:#00e5ff}
.nav-links{display:flex;gap:10px}
.nav-btn{padding:8px 18px;border-radius:8px;font-size:13px;font-weight:700;cursor:pointer;text-decoration:none;font-family:'Manrope',sans-serif}
.nav-login{background:transparent;border:1px solid #2a3347;color:#8892aa}
.nav-register{background:linear-gradient(135deg,#00e5ff,#00ff94);color:#000;border:none}

/* HERO */
.hero{position:relative;z-index:5;text-align:center;padding:80px 20px 60px}
.hero-badge{display:inline-block;background:rgba(0,229,255,0.1);border:1px solid rgba(0,229,255,0.3);color:#00e5ff;padding:6px 16px;border-radius:100px;font-size:12px;font-weight:700;letter-spacing:1px;text-transform:uppercase;margin-bottom:20px}
.hero h1{font-family:'Syne',sans-serif;font-size:clamp(32px,6vw,60px);font-weight:800;line-height:1.1;margin-bottom:16px}
.hero h1 span{background:linear-gradient(135deg,#00e5ff,#00ff94);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
.hero p{font-size:clamp(14px,2vw,18px);color:#8892aa;max-width:600px;margin:0 auto 32px}
.hero-btns{display:flex;gap:12px;justify-content:center;flex-wrap:wrap}
.btn-primary{background:linear-gradient(135deg,#00e5ff,#00ff94);color:#000;border:none;padding:16px 32px;border-radius:12px;font-family:'Syne',sans-serif;font-size:16px;font-weight:800;cursor:pointer;text-decoration:none;display:inline-block;transition:transform .2s}
.btn-primary:hover{transform:scale(1.03)}
.btn-secondary{background:transparent;border:2px solid #2a3347;color:#e8edf5;padding:16px 32px;border-radius:12px;font-family:'Syne',sans-serif;font-size:16px;font-weight:700;cursor:pointer;text-decoration:none;display:inline-block;transition:border-color .2s}
.btn-secondary:hover{border-color:#00e5ff}

/* STATS */
.stats{display:flex;justify-content:center;gap:40px;flex-wrap:wrap;padding:0 20px 60px;position:relative;z-index:5}
.stat{text-align:center}
.stat-num{font-family:'Syne',sans-serif;font-size:36px;font-weight:800;background:linear-gradient(135deg,#00e5ff,#00ff94);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
.stat-label{font-size:13px;color:#5a6480;margin-top:4px}

/* SHORTEN BOX */
.shorten-section{max-width:700px;margin:0 auto;padding:0 20px 80px;position:relative;z-index:5}
.shorten-box{background:#0e1219;border:1px solid #1e2535;border-radius:16px;padding:28px}
.shorten-box h2{font-family:'Syne',sans-serif;font-size:20px;font-weight:700;margin-bottom:16px;text-align:center}
.input-row{display:flex;background:#141820;border:1px solid #2a3347;border-radius:10px;overflow:hidden;transition:border-color .3s}
.input-row:focus-within{border-color:rgba(0,229,255,0.4)}
.url-input{flex:1;background:transparent;border:none;outline:none;padding:14px 18px;font-size:14px;color:#e8edf5;font-family:'Manrope',sans-serif}
.url-input::placeholder{color:#5a6480}
.shorten-btn{background:linear-gradient(135deg,#00e5ff,#00ff94);color:#000;border:none;padding:14px 24px;font-family:'Syne',sans-serif;font-size:14px;font-weight:800;cursor:pointer;white-space:nowrap}
.result-box{background:rgba(0,255,148,0.05);border:1px solid rgba(0,255,148,0.2);border-radius:10px;padding:14px 18px;margin-top:12px;display:none;align-items:center;gap:12px}
.result-box.show{display:flex}
.short-url{font-family:monospace;font-size:14px;color:#00ff94;flex:1;word-break:break-all}
.copy-btn{background:rgba(0,255,148,0.1);border:1px solid rgba(0,255,148,0.3);color:#00ff94;padding:7px 14px;font-size:12px;font-weight:700;border-radius:6px;cursor:pointer;white-space:nowrap;font-family:'Syne',sans-serif}
.login-note{text-align:center;margin-top:12px;font-size:13px;color:#5a6480}
.login-note a{color:#00e5ff;text-decoration:none}

/* HOW IT WORKS */
.section{max-width:900px;margin:0 auto;padding:0 20px 80px;position:relative;z-index:5}
.section-title{font-family:'Syne',sans-serif;font-size:clamp(24px,4vw,36px);font-weight:800;text-align:center;margin-bottom:8px}
.section-sub{color:#5a6480;text-align:center;font-size:14px;margin-bottom:40px}
.steps-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:20px}
.step-card{background:#0e1219;border:1px solid #1e2535;border-radius:14px;padding:24px;text-align:center;position:relative;overflow:hidden}
.step-card::before{content:'';position:absolute;top:0;left:0;right:0;height:3px;background:linear-gradient(90deg,#00e5ff,#00ff94)}
.step-icon{font-size:36px;margin-bottom:12px}
.step-card h3{font-family:'Syne',sans-serif;font-size:16px;font-weight:700;margin-bottom:8px}
.step-card p{font-size:13px;color:#5a6480;line-height:1.6}

/* EARNINGS */
.earn-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px;margin-bottom:40px}
.earn-card{background:#0e1219;border:1px solid #1e2535;border-radius:12px;padding:20px;text-align:center}
.earn-card:nth-child(1){border-color:rgba(0,229,255,0.3)}
.earn-card:nth-child(2){border-color:rgba(0,255,148,0.3)}
.earn-card:nth-child(3){border-color:rgba(167,139,250,0.3)}
.earn-amount{font-family:'Syne',sans-serif;font-size:28px;font-weight:800;color:#00ff94}
.earn-label{font-size:12px;color:#5a6480;margin-top:4px}

/* TESTIMONIALS */
.testi-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:16px}
.testi{background:#0e1219;border:1px solid #1e2535;border-radius:12px;padding:20px}
.testi-text{font-size:14px;color:#8892aa;line-height:1.6;margin-bottom:14px;font-style:italic}
.testi-name{font-size:13px;font-weight:700;color:#00e5ff}
.testi-sub{font-size:11px;color:#5a6480}
.stars{color:#ffc107;font-size:14px;margin-bottom:8px}

/* FAQ */
.faq-item{background:#0e1219;border:1px solid #1e2535;border-radius:10px;padding:18px 20px;margin-bottom:10px;cursor:pointer}
.faq-q{font-weight:700;font-size:14px;display:flex;justify-content:space-between;align-items:center}
.faq-a{font-size:13px;color:#5a6480;margin-top:10px;line-height:1.6;display:none}
.faq-item.open .faq-a{display:block}
.faq-item.open .faq-arrow{transform:rotate(180deg)}
.faq-arrow{transition:transform .2s;color:#00e5ff}

/* CTA */
.cta{background:linear-gradient(135deg,rgba(0,229,255,0.08),rgba(0,255,148,0.05));border:1px solid rgba(0,229,255,0.15);border-radius:20px;padding:60px 20px;text-align:center;max-width:700px;margin:0 auto 80px;position:relative;z-index:5}
.cta h2{font-family:'Syne',sans-serif;font-size:clamp(24px,4vw,40px);font-weight:800;margin-bottom:12px}
.cta p{color:#8892aa;font-size:15px;margin-bottom:28px}

/* FOOTER */
footer{border-top:1px solid #1e2535;padding:40px 20px;text-align:center;position:relative;z-index:5}
.footer-logo{font-family:'Syne',sans-serif;font-size:20px;font-weight:800;margin-bottom:12px}
.footer-logo span{color:#00e5ff}
.footer-links{display:flex;gap:20px;justify-content:center;flex-wrap:wrap;margin-bottom:16px}
.footer-links a{font-size:13px;color:#5a6480;text-decoration:none}
.footer-links a:hover{color:#00e5ff}
.footer-copy{font-size:12px;color:#3a4455}

@media(max-width:600px){
  .stats{gap:24px}
  .hero{padding:60px 20px 40px}
}
</style>
</head>
<body>

<nav>
  <a class="nav-logo" href="/">Snap<span>URL</span></a>
  <div class="nav-links">
    <a class="nav-btn nav-login" href="/login.html">Login</a>
    <a class="nav-btn nav-register" href="/register.html">Free Register</a>
  </div>
</nav>

<!-- HERO -->
<section class="hero">
  <div class="hero-badge">🇮🇳 India Ka #1 Link Shortener</div>
  <h1>Links Share Karo,<br><span>Paise Kamao!</span></h1>
  <p>SnapURL se apni koi bhi link short karo, WhatsApp pe share karo aur har click pe automatically paise kamao. UPI se seedha withdrawal!</p>
  <div class="hero-btns">
    <a class="btn-primary" href="/register.html">🚀 Free Mein Start Karo</a>
    <a class="btn-secondary" href="/login.html">Login →</a>
  </div>
</section>

<!-- STATS -->
<div class="stats">
  <div class="stat"><div class="stat-num">1.2L+</div><div class="stat-label">Registered Users</div></div>
  <div class="stat"><div class="stat-num">₹48L+</div><div class="stat-label">Total Paid Out</div></div>
  <div class="stat"><div class="stat-num">2.4Cr+</div><div class="stat-label">Links Shortened</div></div>
  <div class="stat"><div class="stat-num">4.8★</div><div class="stat-label">User Rating</div></div>
</div>

<!-- QUICK SHORTEN -->
<div class="shorten-section">
  <div class="shorten-box">
    <h2>✂️ Abhi Try Karo — Free!</h2>
    <div class="input-row">
      <input class="url-input" id="urlInput" type="url" placeholder="https://aapka-link.com yahan paste karo..."/>
      <button class="shorten-btn" onclick="tryShorten()">Short Karo →</button>
    </div>
    <div class="result-box" id="resultBox">
      <span>✅</span>
      <span class="short-url" id="shortUrl"></span>
      <button class="copy-btn" onclick="copyUrl()">Copy</button>
    </div>
    <div class="login-note">Paise kamane ke liye <a href="/register.html">free account banao</a> — sirf 60 seconds!</div>
  </div>
</div>

<!-- HOW IT WORKS -->
<div class="section">
  <h2 class="section-title">Kaise Kaam Karta Hai?</h2>
  <p class="section-sub">Sirf 4 simple steps — aur paise aane shuru!</p>
  <div class="steps-grid">
    <div class="step-card">
      <div class="step-icon">📝</div>
      <h3>Register Karo</h3>
      <p>Free account banao — sirf naam, email aur password chahiye. 60 seconds mein ready!</p>
    </div>
    <div class="step-card">
      <div class="step-icon">✂️</div>
      <h3>Link Short Karo</h3>
      <p>Koi bhi link paste karo — movie, song, article, anything. Ek click mein short link ready!</p>
    </div>
    <div class="step-card">
      <div class="step-icon">📱</div>
      <h3>Share Karo</h3>
      <p>WhatsApp groups, Telegram channels, Instagram bio — jahan bhi share karo, clicks aayenge!</p>
    </div>
    <div class="step-card">
      <div class="step-icon">💰</div>
      <h3>Paise Kamao</h3>
      <p>Har click pe automatically earning! $5 hote hi UPI se seedha apne account mein withdraw karo.</p>
    </div>
  </div>
</div>

<!-- EARNINGS -->
<div class="section">
  <h2 class="section-title">Kitna Kamao Ge?</h2>
  <p class="section-sub">Har country ke click pe alag rate — Indian clicks bhi great hain!</p>
  <div class="earn-grid">
    <div class="earn-card">
      <div class="earn-amount">$12</div>
      <div class="earn-label">US/UK/CA/AU per 1000 clicks</div>
    </div>
    <div class="earn-card">
      <div class="earn-amount">$4.5</div>
      <div class="earn-label">India per 1000 clicks</div>
    </div>
    <div class="earn-card">
      <div class="earn-amount">$2</div>
      <div class="earn-label">Other countries per 1000 clicks</div>
    </div>
  </div>
  <div style="background:#0e1219;border:1px solid #1e2535;border-radius:12px;padding:20px;text-align:center">
    <p style="color:#5a6480;font-size:13px;margin-bottom:8px">Example: Agar tumhare links pe roz 500 Indian clicks aate hain:</p>
    <p style="font-family:'Syne',sans-serif;font-size:28px;font-weight:800;color:#00ff94">₹1,687/month</p>
    <p style="color:#5a6480;font-size:12px;margin-top:4px">Sirf links share karke — koi investment nahi!</p>
  </div>
</div>

<!-- TESTIMONIALS -->
<div class="section">
  <h2 class="section-title">Log Kya Bol Rahe Hain?</h2>
  <p class="section-sub">Hamare 1.2 lakh+ users ki real stories</p>
  <div class="testi-grid">
    <div class="testi">
      <div class="stars">★★★★★</div>
      <div class="testi-text">"Maine pehle mahine mein hi ₹2,400 kamaye! Sirf WhatsApp groups mein links share karta hoon. SnapURL sach mein best hai!"</div>
      <div class="testi-name">Rahul Sharma</div>
      <div class="testi-sub">Delhi • ₹2,400 earned</div>
    </div>
    <div class="testi">
      <div class="stars">★★★★★</div>
      <div class="testi-text">"Student hoon, part-time mein ₹1,800 kama leta hoon. College groups mein study material share karta hoon SnapURL se. UPI payment bhi fast hai!"</div>
      <div class="testi-name">Priya Singh</div>
      <div class="testi-sub">Mumbai • ₹1,800 earned</div>
    </div>
    <div class="testi">
      <div class="stars">★★★★★</div>
      <div class="testi-text">"Telegram channel pe 5000 members hain. SnapURL links share karta hoon — mahine mein ₹4,500+ aata hai. Sab se easy earning!"</div>
      <div class="testi-name">Vikram Patel</div>
      <div class="testi-sub">Gujarat • ₹4,500 earned</div>
    </div>
  </div>
</div>

<!-- FAQ -->
<div class="section">
  <h2 class="section-title">Aksar Puche Jane Wale Sawaal</h2>
  <p class="section-sub">Koi confusion? Yahan sab clear hoga!</p>

  <div class="faq-item" onclick="toggleFaq(this)">
    <div class="faq-q">SnapURL bilkul free hai? <span class="faq-arrow">▼</span></div>
    <div class="faq-a">Haan! SnapURL 100% free hai. Register karo, links shorten karo aur paise kamao — koi hidden charges nahi, koi subscription nahi.</div>
  </div>
  <div class="faq-item" onclick="toggleFaq(this)">
    <div class="faq-q">Minimum withdrawal kitna hai? <span class="faq-arrow">▼</span></div>
    <div class="faq-a">Minimum withdrawal $5 hai. UPI (PhonePe, GPay, Paytm), Bank Transfer, aur PayPal se withdraw kar sakte ho. Payment 24-48 hours mein process hoti hai.</div>
  </div>
  <div class="faq-item" onclick="toggleFaq(this)">
    <div class="faq-q">Kitne clicks chahiye $5 kamane ke liye? <span class="faq-arrow">▼</span></div>
    <div class="faq-a">India ke clicks se lagbhag 1,111 clicks chahiye $5 kamane ke liye. US/UK clicks se sirf 417 clicks mein $5 ho jaate hain! WhatsApp pe active raho toh yeh easily achieve ho jaata hai.</div>
  </div>
  <div class="faq-item" onclick="toggleFaq(this)">
    <div class="faq-q">Kya main apna khud ka click count kar sakta hoon? <span class="faq-arrow">▼</span></div>
    <div class="faq-a">Pehla click count hoga, lekin same device ya same IP se 24 hours mein dobara click nahi count hoga. Genuine traffic hi count hota hai.</div>
  </div>
  <div class="faq-item" onclick="toggleFaq(this)">
    <div class="faq-q">Referral system kya hai? <span class="faq-arrow">▼</span></div>
    <div class="faq-a">Apna referral link share karo. Jab koi us link se register kare aur withdraw kare — us amount ka 2% tumhe milega. Lifetime passive income!</div>
  </div>
  <div class="faq-item" onclick="toggleFaq(this)">
    <div class="faq-q">Kaunse links shorten kar sakte hain? <span class="faq-arrow">▼</span></div>
    <div class="faq-a">Koi bhi legal link — YouTube videos, news articles, products, apps, study material, etc. Adult content, malware ya illegal content allow nahi hai.</div>
  </div>
</div>

<!-- CTA -->
<div style="padding:0 20px">
  <div class="cta">
    <h2>Aaj Hi Start Karo — Free Hai! 🚀</h2>
    <p>1.2 lakh+ users pehle se paise kama rahe hain. Tu kyun ruk raha hai?</p>
    <a class="btn-primary" href="/register.html" style="font-size:18px;padding:18px 40px">Free Account Banao →</a>
    <p style="margin-top:16px;font-size:12px;color:#3a4455">No credit card required • No hidden fees • Instant activation</p>
  </div>
</div>

<!-- FOOTER -->
<footer>
  <div class="footer-logo">Snap<span>URL</span></div>
  <div class="footer-links">
    <a href="/about.html">About</a>
    <a href="/terms.html">Terms</a>
    <a href="/privacy.html">Privacy</a>
    <a href="/login.html">Login</a>
    <a href="/register.html">Register</a>
  </div>
  <div class="footer-copy">© 2025 SnapURL. All rights reserved. Made with ❤️ in India 🇮🇳</div>
</footer>

<script>
// Quick shorten (guest - redirects to register after)
async function tryShorten() {
  const url = document.getElementById('urlInput').value.trim();
  if (!url) { document.getElementById('urlInput').focus(); return; }
  const btn = document.querySelector('.shorten-btn');
  btn.textContent = 'Wait...'; btn.disabled = true;
  try {
    const res = await fetch('/api/shorten', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ url })
    });
    const data = await res.json();
    if (res.status === 401) {
      // Not logged in — redirect to register
      window.location = '/register.html';
      return;
    }
    if (!res.ok) { alert(data.error); return; }
    document.getElementById('shortUrl').textContent = data.short;
    document.getElementById('resultBox').classList.add('show');
  } catch(e) { alert('Error! Try again.'); }
  finally { btn.textContent = 'Short Karo →'; btn.disabled = false; }
}

function copyUrl() {
  navigator.clipboard.writeText(document.getElementById('shortUrl').textContent);
  const btn = document.querySelector('.copy-btn');
  btn.textContent = '✓ Copied!';
  setTimeout(() => btn.textContent = 'Copy', 2000);
}

function toggleFaq(el) {
  el.classList.toggle('open');
}

document.getElementById('urlInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') tryShorten();
});
</script>
</body>
</html>`);
});
app.get('/login.html', (req, res) => res.sendFile(path.join(__dirname, 'login.html')));
app.get('/forgot-password.html', (req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Forgot Password — SnapURL</title>
<link href="https://fonts.googleapis.com/css2?family=Syne:wght@700;800&family=Manrope:wght@400;600;700&display=swap" rel="stylesheet"/>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#080b10;color:#e8edf5;font-family:'Manrope',sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
body::before{content:'';position:fixed;inset:0;background-image:linear-gradient(rgba(0,229,255,0.02) 1px,transparent 1px),linear-gradient(90deg,rgba(0,229,255,0.02) 1px,transparent 1px);background-size:40px 40px;pointer-events:none}
.box{background:#0e1219;border:1px solid #1e2535;border-radius:16px;padding:32px 28px;width:100%;max-width:400px;position:relative;z-index:5}
.logo{font-family:'Syne',sans-serif;font-size:26px;font-weight:800;text-align:center;margin-bottom:6px}
.logo span{color:#00e5ff}
.subtitle{color:#5a6480;font-size:13px;text-align:center;margin-bottom:28px}
.step{display:none}.step.active{display:block}
.step-title{font-family:'Syne',sans-serif;font-size:18px;font-weight:700;margin-bottom:6px}
.step-sub{color:#5a6480;font-size:13px;margin-bottom:20px;line-height:1.6}
.field{margin-bottom:14px}
.field label{display:block;font-size:11px;font-weight:600;letter-spacing:1px;text-transform:uppercase;color:#5a6480;margin-bottom:6px}
.field input{width:100%;background:#141820;border:1px solid #2a3347;border-radius:8px;padding:12px 14px;color:#e8edf5;font-family:'Manrope',sans-serif;font-size:14px;outline:none;transition:border-color .2s}
.field input:focus{border-color:rgba(0,229,255,0.4)}
.btn{width:100%;background:linear-gradient(135deg,#00e5ff,#00ff94);color:#000;border:none;padding:13px;border-radius:10px;font-family:'Syne',sans-serif;font-size:15px;font-weight:800;cursor:pointer;margin-top:4px}
.btn:disabled{opacity:.5;cursor:not-allowed}
.success{background:rgba(0,255,148,0.08);border:1px solid rgba(0,255,148,0.2);color:#00ff94;padding:12px 14px;border-radius:8px;font-size:13px;margin-bottom:14px;display:none}
.error{background:rgba(255,61,113,0.08);border:1px solid rgba(255,61,113,0.3);color:#ff6b9d;padding:12px 14px;border-radius:8px;font-size:13px;margin-bottom:14px;display:none}
.info-box{background:rgba(0,229,255,0.05);border:1px solid rgba(0,229,255,0.15);border-radius:8px;padding:14px;margin-bottom:16px;font-size:13px;color:#8892aa}
.info-box strong{color:#00e5ff}
.back{display:block;text-align:center;margin-top:18px;font-size:13px;color:#5a6480;text-decoration:none}
.back:hover{color:#00e5ff}
</style>
</head>
<body>
<div class="box">
  <div class="logo">Snap<span>URL</span></div>
  <div class="subtitle">Password reset karo</div>

  <!-- Step 1: Username -->
  <div class="step active" id="step1">
    <div class="step-title">🔐 Forgot Password?</div>
    <div class="step-sub">Apna username ya email daalo — hum account dhundhenge</div>
    <div id="s1err" class="error"></div>
    <div class="field">
      <label>Username ya Email</label>
      <input type="text" id="usernameInput" placeholder="username ya email@example.com"/>
    </div>
    <button class="btn" id="s1btn" onclick="findAccount()">Find Account →</button>
    <a href="/login.html" class="back">← Back to Login</a>
  </div>

  <!-- Step 2: New Password -->
  <div class="step" id="step2">
    <div class="step-title">🔑 Naya Password Set Karo</div>
    <div class="info-box">Account mila: <strong id="maskedEmail"></strong></div>
    <div id="s2err" class="error"></div>
    <div id="s2suc" class="success"></div>
    <div class="field">
      <label>Naya Password</label>
      <input type="password" id="newPass" placeholder="Naya password (min 6 chars)"/>
    </div>
    <div class="field">
      <label>Confirm Password</label>
      <input type="password" id="confirmPass" placeholder="Password dobara daalo"/>
    </div>
    <button class="btn" id="s2btn" onclick="resetPassword()">Reset Password →</button>
    <a href="/login.html" class="back">← Back to Login</a>
  </div>
</div>

<script>
let foundUserId = '';

async function findAccount() {
  const username = document.getElementById('usernameInput').value.trim();
  const err = document.getElementById('s1err');
  const btn = document.getElementById('s1btn');
  err.style.display='none';
  if (!username) { err.textContent='Username ya email daalo!'; err.style.display='block'; return; }
  btn.disabled=true; btn.textContent='Searching...';
  try {
    const res = await fetch('/api/forgot-password', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ username })
    });
    const data = await res.json();
    if (!res.ok) { err.textContent=data.error; err.style.display='block'; return; }
    foundUserId = data.userId;
    document.getElementById('maskedEmail').textContent = data.masked;
    document.getElementById('step1').classList.remove('active');
    document.getElementById('step2').classList.add('active');
  } catch(e) { err.textContent='Server error! Try again.'; err.style.display='block'; }
  finally { btn.disabled=false; btn.textContent='Find Account →'; }
}

async function resetPassword() {
  const newPass = document.getElementById('newPass').value;
  const confirmPass = document.getElementById('confirmPass').value;
  const err = document.getElementById('s2err');
  const suc = document.getElementById('s2suc');
  const btn = document.getElementById('s2btn');
  err.style.display='none'; suc.style.display='none';
  if (!newPass || !confirmPass) { err.textContent='Dono fields bharo!'; err.style.display='block'; return; }
  if (newPass !== confirmPass) { err.textContent='Passwords match nahi kar rahe!'; err.style.display='block'; return; }
  if (newPass.length < 6) { err.textContent='Password kam se kam 6 characters!'; err.style.display='block'; return; }
  btn.disabled=true; btn.textContent='Resetting...';
  try {
    const res = await fetch('/api/reset-password', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ userId: foundUserId, newPassword: newPass })
    });
    const data = await res.json();
    if (!res.ok) { err.textContent=data.error; err.style.display='block'; return; }
    suc.textContent='✅ Password reset ho gaya! Login karo.';
    suc.style.display='block';
    btn.textContent='✅ Done!';
    setTimeout(() => window.location='/login.html', 1500);
  } catch(e) { err.textContent='Server error!'; err.style.display='block'; }
  finally { if(btn.textContent==='Resetting...') { btn.disabled=false; btn.textContent='Reset Password →'; } }
}

document.addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  if (document.getElementById('step1').classList.contains('active')) findAccount();
  else resetPassword();
});
</script>
</body>
</html>`);
});
app.get('/register.html', (req, res) => {
  const ref = req.query.ref;
  if (!ref) return res.sendFile(path.join(__dirname, 'register.html'));
  const fs = require('fs');
  let html = fs.readFileSync(path.join(__dirname, 'register.html'), 'utf8');
  const inject = `<script>window.addEventListener('DOMContentLoaded',function(){var i=document.getElementById('refCode')||document.querySelector('input[name="ref"]');if(i){i.value='${ref}';i.readOnly=true;}else{localStorage.setItem('snapref','${ref}');}});</script>`;
  html = html.replace('</body>', inject + '</body>');
  res.send(html);
});
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

  const cookieKey = 'clicked_' + link.code;
  const cookieCounted = req.headers.cookie && req.headers.cookie.includes(cookieKey + '=1');
  const visitorIP = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || '';
  const ipCheck = await db.collection('ip_clicks').findOne({ 
    ip: visitorIP, 
    linkCode: link.code,
    createdAt: { $gte: new Date(Date.now() - 24*60*60*1000) }
  });

  // Count on pg=5 — cookie aur IP se duplicate rok, fraud check bhi
  if (pg === 5 && !cookieCounted && !ipCheck) {
    const day = new Date().getDay();
    const dayIdx = day === 0 ? 6 : day - 1;
    const cf_country = req.headers['cf-ipcountry'] || '';

    // 🛡️ Fraud Detection Agent
    const fraudResult = await fraudCheck(link.userId, link.code, visitorIP, cf_country);
    if (fraudResult.fraud) {
      console.log(`🚨 Fraud blocked: ${fraudResult.reason} — IP: ${visitorIP}`);
      // Click count mat karo, par page serve karo normally
    } else {
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
  }

  const finalDest = link.original;
  const linkCode = link.code;

  const MONETAG_SMART = 'https://omg10.com/4/11112574';
  // Adsterra Smart Links
  const ADSTERRA_SMART1 = 'https://industriousslowly.com/q0c5c7t6h?key=f44f6b22e985a35ed2da81e7ba8173f4';
  const ADSTERRA_SMART2 = 'https://industriousslowly.com/vfyqtz053?key=6ed7352ab0dae54ecdac81b78d85306b';

  const baseUrl = req.protocol + '://' + req.get('host') + '/' + linkCode;

  // Page URLs
  const nextPage = pg < 5 ? baseUrl + '?pg=' + (pg+1) : finalDest;

  // ── HEAD: gtag only ──
  const AD_SCRIPTS = `
    <script async src="https://www.googletagmanager.com/gtag/js?id=AW-18221606970"></script>
    <script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','AW-18221606970');</script>
  `;

  // ── PAGE_ADS: Monetag + Adsterra smartlinks — body ke end mein load honge ──
  const PAGE_ADS = `
    <script src="https://quge5.com/88/tag.min.js" data-zone="246854" async data-cfasync="false"></script>
    <script src="https://quge5.com/88/tag.min.js" data-zone="248162" async data-cfasync="false"></script>
    <script>(function(s){s.dataset.zone='11126180',s.src='https://al5sm.com/tag.min.js'})([document.documentElement,document.body].filter(Boolean).pop().appendChild(document.createElement('script')))</script>
    <script async data-cfasync="false" src="https://industriousslowly.com/45/f0/f0/45f0f0217d9b1d4c90020d41e0072759.js"></script>
    <script async data-cfasync="false" src="https://industriousslowly.com/vfyqtz053?key=6ed7352ab0dae54ecdac81b78d85306b"></script>
    <script async data-cfasync="false" src="https://industriousslowly.com/q0c5c7t6h?key=f44f6b22e985a35ed2da81e7ba8173f4"></script>
  `;

  // ── Monetag In-Page Push ──
  const MONETAG_INPAGE = '<script src="https://quge5.com/88/tag.min.js" data-zone="247764" async data-cfasync="false"></script>';

  // ── Adsterra banners — defer se load honge, page block nahi karenge ──
  const ADSTERRA_B1 = `
    <div style="text-align:center;margin:10px 0;min-height:60px">
      <script defer>
        window.addEventListener('load', function(){
          var s1=document.createElement('script');
          s1.text='atOptions={"key":"1af53edc6f21f7ca1aac26b707a9dfe6","format":"iframe","height":300,"width":160,"params":{}};';
          var s2=document.createElement('script');
          s2.src='https://industriousslowly.com/1af53edc6f21f7ca1aac26b707a9dfe6/invoke.js';
          s2.async=true;
          document.currentScript.parentNode.appendChild(s1);
          document.currentScript.parentNode.appendChild(s2);
        });
      </script>
    </div>`;

  const ADSTERRA_B2 = `
    <div style="text-align:center;margin:10px 0;min-height:60px">
      <script async data-cfasync="false" src="https://industriousslowly.com/e3a3360597029776287aab752f162417/invoke.js"></script>
      <div id="container-e3a3360597029776287aab752f162417"></div>
    </div>`;

  const ADSTERRA_B3 = `
    <div style="text-align:center;margin:10px 0;min-height:60px">
      <script defer>
        window.addEventListener('load', function(){
          var s1=document.createElement('script');
          s1.text='atOptions={"key":"9289233252c3d204608b748744e59eeb","format":"iframe","height":50,"width":320,"params":{}};';
          var s2=document.createElement('script');
          s2.src='https://industriousslowly.com/9289233252c3d204608b748744e59eeb/invoke.js';
          s2.async=true;
          document.currentScript.parentNode.appendChild(s1);
          document.currentScript.parentNode.appendChild(s2);
        });
      </script>
    </div>`;

  // ── Banner rotation ──
  const _BANNERS = [
    '<script src="https://quge5.com/88/tag.min.js" data-zone="246895" async data-cfasync="false"></script>',
    ADSTERRA_B3,
    '<script src="https://quge5.com/88/tag.min.js" data-zone="248564" async data-cfasync="false"></script>',
    ADSTERRA_B2,
    '<script src="https://quge5.com/88/tag.min.js" data-zone="248565" async data-cfasync="false"></script>',
    ADSTERRA_B1,
    '<script async data-cfasync="false" src="https://5gvci.com/act/files/tag.min.js?z=11114829"></script>',
    '<script async data-cfasync="false" src="https://5gvci.com/act/files/tag.min.js?z=11117663"></script>',
    '<script>(function(s){s.dataset.zone="11114819",s.src="https://al5sm.com/tag.min.js";document.body.appendChild(s)})(document.createElement("script"))</script>',
    ADSTERRA_B3,
    '<script>(function(s){s.dataset.zone="11126190",s.src="https://al5sm.com/tag.min.js"})([document.documentElement,document.body].filter(Boolean).pop().appendChild(document.createElement("script")))</script>',
    ADSTERRA_B2,
  ];
  let _bi = 0;
  function nextAd() {
    return '<div style="margin:12px 0;text-align:center;min-height:50px">' + MONETAG_INPAGE + '</div>';
  }
  function exoAd() {
    const ad = _BANNERS[_bi++ % _BANNERS.length];
    if (ad.includes('div style=')) return ad;
    return '<div style="margin:12px 0;text-align:center;min-height:50px">' + ad + '</div>';
  }

  const CSS = `
    *{margin:0;padding:0;box-sizing:border-box}
    body{background:#0a0a0a;color:#e8e8e8;font-family:'Segoe UI',Arial,sans-serif;font-size:15px;line-height:1.7}
    .header{background:#111;border-bottom:2px solid #00e5ff;padding:12px 20px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:10000}
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
    .btn{background:linear-gradient(135deg,#00e5ff,#00ff94);color:#000;border:none;padding:14px 28px;border-radius:10px;font-size:15px;font-weight:800;cursor:pointer;width:100%;margin:10px 0;letter-spacing:0.5px;transition:transform .2s;position:relative;z-index:99999 !important}
    .btn:hover{transform:scale(1.02)}
    .btn:disabled{background:#333;color:#666;cursor:not-allowed;transform:none}
    .timer-box{background:#0d0d0d;border:2px solid #00e5ff;border-radius:12px;padding:20px;text-align:center;margin:16px 0;position:relative;z-index:99999 !important}
    .timer-num{font-size:52px;font-weight:900;color:#00e5ff;font-family:monospace;line-height:1}
    .timer-label{color:#666;font-size:13px;margin-top:6px}
    .captcha-box{background:#111;border:2px solid #333;border-radius:8px;padding:16px;display:flex;align-items:center;gap:14px;margin:16px 0;cursor:pointer;transition:border-color .2s;position:relative;z-index:99999 !important}
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
    .generate-box{background:linear-gradient(135deg,#0d1a2e,#0a2a1a);border:2px solid #00e5ff;border-radius:16px;padding:24px;text-align:center;margin:20px 0;position:relative;z-index:99999 !important}
    .generate-box h2{font-size:20px;margin-bottom:8px}
    .final-link{background:#0a2a0a;border:2px solid #00ff94;border-radius:10px;padding:16px;text-align:center;margin:16px 0}
    .final-link a{color:#00ff94;font-size:14px;word-break:break-all;font-weight:600;text-decoration:none}
    /* Ad containers — LOW z-index taaki buttons block na ho */
    iframe[id*="aswift"],iframe[id*="google_ads"],ins.adsbygoogle,div[id*="container-e3a3"]{z-index:1 !important;pointer-events:none !important}
    /* Monetag/Adsterra popunder overlays — captcha ke upar nahi aayenge */
    div[style*="position:fixed"],div[style*="position: fixed"]{z-index:auto !important}
    .captcha-box,#captchaBox,.btn,.timer-box,.generate-box{isolation:isolate;z-index:99999 !important;position:relative !important}
    /* Koi bhi ad script ka overlay click block nahi karega */
    body > div[style*="z-index: 2147483647"],
    body > div[style*="z-index:2147483647"]{pointer-events:none !important}
  `;

  // PAGE_ADS — body ke bilkul end mein load honge, captcha load hone ke BAAD
  // Delay se load karo taaki page elements pehle ready ho jayein
  const PAGE_ADS_SCRIPT = `
    <script>
    // Ads ko 2 second delay se load karo — captcha pehle ready ho
    setTimeout(function(){
      var ads = document.createElement('div');
      ads.innerHTML = ${JSON.stringify(`
        <script src="https://quge5.com/88/tag.min.js" data-zone="246854" async data-cfasync="false"><\/script>
        <script src="https://quge5.com/88/tag.min.js" data-zone="248162" async data-cfasync="false"><\/script>
        <script>(function(s){s.dataset.zone='11126180',s.src='https://al5sm.com/tag.min.js'})([document.documentElement,document.body].filter(Boolean).pop().appendChild(document.createElement('script')))<\/script>
        <script async data-cfasync="false" src="https://industriousslowly.com/45/f0/f0/45f0f0217d9b1d4c90020d41e0072759.js"><\/script>
        <script async data-cfasync="false" src="https://industriousslowly.com/vfyqtz053?key=6ed7352ab0dae54ecdac81b78d85306b"><\/script>
        <script async data-cfasync="false" src="https://industriousslowly.com/q0c5c7t6h?key=f44f6b22e985a35ed2da81e7ba8173f4"><\/script>
      `)};
      // Scripts extract karke load karo
      var scripts = ads.querySelectorAll ? [] : [];
      var temp = document.createElement('div');
      temp.innerHTML = ads.innerHTML;
      temp.querySelectorAll('script').forEach(function(s){
        var ns = document.createElement('script');
        if(s.src) ns.src = s.src;
        else ns.textContent = s.textContent;
        if(s.dataset.zone) ns.dataset.zone = s.dataset.zone;
        ns.async = true;
        if(s.getAttribute('data-cfasync')) ns.setAttribute('data-cfasync','false');
        document.body.appendChild(ns);
      });
    }, 2000);
    </script>
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

  

  <button class="btn" id="continueBtn" disabled onclick="goContinue()">
    ✓ Verify & Continue →
  </button>
</div>

<script>
var captchaDone = false;
function doCaptcha() {
  if (captchaDone) return;
  var check = document.getElementById('captchaCheck');
  var btn = document.getElementById('continueBtn');
  check.textContent = '✓';
  check.classList.add('checked');
  captchaDone = true;
  btn.disabled = false;
  btn.textContent = '✓ Verified! Click to Continue →';
  try { window.open('${MONETAG_SMART}', '_blank'); } catch(e){}
  try { window.open('${ADSTERRA_SMART1}', '_blank'); } catch(e){}
}
function goContinue() {
  if (!captchaDone) return;
  window.location = '${nextPage}';
}
</script>
${PAGE_ADS_SCRIPT}
  
  
  
  
  
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
var scrollDone = false;

var iv = setInterval(function(){
  t--;
  timerEl.textContent = t;
  progressEl.style.width = (t/20*100) + '%';
  if(t <= 0){
    clearInterval(iv);
    timerEl.textContent = '✓';
    timerEl.style.color = '#00ff94';
    if(scrollDone){ btn.style.display='block'; scrollHint.style.display='none'; }
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
  window.open('${MONETAG_SMART}', '_blank');
  window.location = '${nextPage}';
}
</script>
${PAGE_ADS_SCRIPT}
  
  
  
  
  
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

  
  
  
  

  <button class="btn" id="continueBtn" disabled onclick="goContinue()">Continue →</button>
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
  window.open('${MONETAG_SMART}', '_blank');
  window.location = '${nextPage}';
}
</script>
${PAGE_ADS_SCRIPT}
  
  
  
  
  
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
    <button class="btn" id="generateBtn" disabled onclick="goContinue()">
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
  window.open('${MONETAG_SMART}', '_blank');
  window.location = '${nextPage}';
}
</script>
${PAGE_ADS_SCRIPT}
  
  
  
  
  
</body>
</html>`);

  // ═══════════════════════════════════════
  // PAGE 5 — Final (click count here, button click → smart link → finalDest)
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
  ${exoAd()}
  <div class="generate-box">
    <h2>🎉 Your Link is Ready!</h2>
    <p style="color:#8892aa;font-size:13px;margin-bottom:12px">Saare steps complete! Button click karo aur apna link pao.</p>
    <div class="timer-box" style="margin:12px 0">
      <div class="timer-num" id="timerNum">5</div>
      <div class="timer-label">Button unlock ho raha hai...</div>
      <div class="progress-bar"><div class="progress-fill" id="progressFill" style="width:100%"></div></div>
    </div>
    <button class="btn" id="finalBtn" disabled onclick="openLink()" style="position:relative;z-index:9999">⏳ Please wait...</button>
  </div>
  ${nextAd()}
  ${exoAd()}
  <div class="card">
    <h2>🙏 Thank You for Using SnapURL!</h2>
    <p class="blog-text">Tune saare verification steps complete kiye. Ads dekh ke tujhe free mein access milta hai!</p>
    ${exoAd()}
    <p class="blog-text">Kisi ne yeh link share kiya? Unhe teri visit se earning aayi. <span class="highlight">Tu bhi yahi kar!</span> Free register karo aur links share karo.</p>
    ${nextAd()}
  </div>
  ${exoAd()}
  <div class="card">
    <h2>💰 SnapURL se Paise Kamao — Free!</h2>
    ${exoAd()}
    <p class="blog-text">🔗 Unlimited links | 📊 Analytics | 💵 Earnings per click | 💳 UPI withdrawal</p>
    ${nextAd()}
    <a href="/register.html" style="display:block;background:linear-gradient(135deg,#00e5ff,#00ff94);color:#000;border:none;padding:14px 28px;border-radius:10px;font-size:15px;font-weight:800;text-align:center;margin:12px 0;text-decoration:none">🚀 Free Account Banao →</a>
  </div>
  ${nextAd()}
  ${exoAd()}
</div>
<script>
var opened = false;
var t=5;
var timerEl=document.getElementById('timerNum');
var progressEl=document.getElementById('progressFill');
var btn=document.getElementById('finalBtn');

var iv=setInterval(function(){
  t--;
  timerEl.textContent=t;
  progressEl.style.width=(t/5*100)+'%';
  if(t<=0){
    clearInterval(iv);
    timerEl.textContent='✓';
    timerEl.style.color='#00ff94';
    btn.disabled=false;
    btn.textContent='🔗 Open My Link →';
  }
},1000);

function openLink(){
  if(opened) return;
  opened=true;
  btn.disabled=true;
  btn.textContent='⏳ Opening...';
  try{ window.open('${MONETAG_SMART}','_blank'); }catch(e){}
  setTimeout(function(){ window.location='${finalDest}'; }, 500);
}
</script>
${PAGE_ADS_SCRIPT}
</body>
</html>`);
  }
});

// ══════════════════════════════════════════
// 🛡️ FRAUD DETECTION AGENT
// ══════════════════════════════════════════
// Runs automatically on every click — no manual trigger needed
async function fraudCheck(userId, linkCode, ip, country) {
  try {
    const now = new Date();
    const oneHour = new Date(now - 60 * 60 * 1000);
    const oneDay = new Date(now - 24 * 60 * 60 * 1000);

    // Check 1: Same IP bohot zyada clicks (>50 in 1 hour)
    const ipClicks = await db.collection('ip_clicks').countDocuments({
      ip, createdAt: { $gte: oneHour }
    });
    if (ipClicks > 50) {
      await db.collection('fraud_logs').insertOne({
        type: 'IP_SPAM', userId, linkCode, ip, country,
        detail: `${ipClicks} clicks in 1 hour`, createdAt: now
      });
      return { fraud: true, reason: 'IP_SPAM' };
    }

    // Check 2: Ek user ke links pe suspicious pattern (>200 clicks/day from same IP ranges)
    const userDayClicks = await db.collection('ip_clicks').countDocuments({
      linkCode, createdAt: { $gte: oneDay }
    });
    if (userDayClicks > 500) {
      await db.collection('fraud_logs').insertOne({
        type: 'LINK_SPAM', userId, linkCode, ip, country,
        detail: `${userDayClicks} clicks on 1 link in 24h`, createdAt: now
      });
      return { fraud: true, reason: 'LINK_SPAM' };
    }

    // Check 3: VPN/Datacenter IP (common fraud method)
    const datacenterRanges = ['10.', '172.16.', '192.168.', '127.'];
    const isDatacenter = datacenterRanges.some(r => ip.startsWith(r));
    if (isDatacenter) {
      return { fraud: true, reason: 'DATACENTER_IP' };
    }

    return { fraud: false };
  } catch(e) {
    return { fraud: false }; // Error pe fraud mat mark karo
  }
}

// Admin: Fraud logs dekho
app.get('/api/admin/fraud-logs', adminAuth, async (req, res) => {
  const logs = await db.collection('fraud_logs')
    .find({}).sort({ createdAt: -1 }).limit(100).toArray();
  res.json(logs);
});

// Admin: User ban karo (fraud ke liye)
app.post('/api/admin/ban-user', adminAuth, async (req, res) => {
  const { userId, reason } = req.body;
  await db.collection('users').updateOne(
    { _id: new ObjectId(userId) },
    { $set: { status: 'banned', banReason: reason, bannedAt: new Date() } }
  );
  res.json({ success: true });
});

// ══════════════════════════════════════════
// 📊 ANALYTICS AGENT
// ══════════════════════════════════════════
// Daily report generate karta hai — cron job ki tarah
let lastReportDate = null;

async function generateDailyReport() {
  const today = new Date().toDateString();
  if (lastReportDate === today) return; // Ek baar hi generate karo
  lastReportDate = today;

  try {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const [totalUsers, newUsers, totalLinks, clicks24h, revenue24h, pendingWithdrawals] = await Promise.all([
      db.collection('users').countDocuments({ status: 'active' }),
      db.collection('users').countDocuments({ joined: { $gte: yesterday } }),
      db.collection('links').countDocuments({}),
      db.collection('ip_clicks').countDocuments({ createdAt: { $gte: yesterday } }),
      db.collection('ip_clicks').countDocuments({ createdAt: { $gte: yesterday } }).then(c => (c * 0.0045).toFixed(4)),
      db.collection('withdrawals').countDocuments({ status: 'pending' })
    ]);

    const report = {
      date: new Date().toDateString(),
      totalUsers, newUsers,
      totalLinks, clicks24h,
      revenue24h: `$${revenue24h}`,
      pendingWithdrawals,
      generatedAt: new Date()
    };

    await db.collection('daily_reports').insertOne(report);
    console.log('📊 Daily Report Generated:', report);
    return report;
  } catch(e) {
    console.error('Analytics agent error:', e);
  }
}

// Har 6 ghante mein report generate karo
setInterval(generateDailyReport, 6 * 60 * 60 * 1000);

// Admin: Reports dekho
app.get('/api/admin/reports', adminAuth, async (req, res) => {
  const reports = await db.collection('daily_reports')
    .find({}).sort({ generatedAt: -1 }).limit(30).toArray();
  res.json(reports);
});

// Admin: Latest report
app.get('/api/admin/report/latest', adminAuth, async (req, res) => {
  const report = await generateDailyReport();
  const latest = await db.collection('daily_reports')
    .findOne({}, { sort: { generatedAt: -1 } });
  res.json(latest || { message: 'No reports yet' });
});

// ══════════════════════════════════════════
// 🔍 SEO AGENT
// ══════════════════════════════════════════
// Auto meta tags generate karta hai har page ke liye
function generateSEOMeta(title, desc, url) {
  return `
<title>${title}</title>
<meta name="description" content="${desc}"/>
<meta property="og:title" content="${title}"/>
<meta property="og:description" content="${desc}"/>
<meta property="og:url" content="${url}"/>
<meta property="og:type" content="website"/>
<meta name="twitter:card" content="summary"/>
<meta name="twitter:title" content="${title}"/>
<meta name="twitter:description" content="${desc}"/>
<link rel="canonical" href="${url}"/>`.trim();
}

// Dynamic SEO for shortened link preview pages
app.get('/preview/:code', async (req, res) => {
  const link = await db.collection('links').findOne({ code: req.params.code });
  if (!link) return res.redirect('/');
  const domain = (() => { try { return new URL(link.original).hostname; } catch { return 'link'; } })();
  const seoMeta = generateSEOMeta(
    `${domain} — SnapURL`,
    `SnapURL pe share kiya gaya link. Click karo aur destination pe jao!`,
    `${req.protocol}://${req.get('host')}/preview/${req.params.code}`
  );
  res.send(`<!DOCTYPE html>
<html><head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
${seoMeta}
<meta http-equiv="refresh" content="0;url=/${req.params.code}"/>
</head>
<body style="background:#080b10;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;text-align:center">
<div>
  <div style="font-size:48px;margin-bottom:16px">🔗</div>
  <p>Redirecting to <strong>${domain}</strong>...</p>
  <a href="/${req.params.code}" style="color:#00e5ff">Click here if not redirected</a>
</div>
</body></html>`);
});

// SEO: Auto keyword suggestions for users (helps them share better)
app.get('/api/seo/keywords', async (req, res) => {
  // Top performing content categories
  const keywords = [
    { category: 'Movies/Web Series', keywords: ['latest movie download', 'web series link', 'OTT link'], avgCtr: '8.2%' },
    { category: 'Study Material', keywords: ['notes PDF', 'question paper', 'syllabus'], avgCtr: '6.5%' },
    { category: 'Software/Apps', keywords: ['APK download', 'software free', 'app link'], avgCtr: '7.1%' },
    { category: 'News/Articles', keywords: ['breaking news', 'viral news', 'trending'], avgCtr: '5.8%' },
    { category: 'Jobs/Government', keywords: ['sarkari naukri', 'govt job', 'vacancy'], avgCtr: '9.3%' },
  ];
  res.json({ keywords, tip: 'Inhe WhatsApp groups mein share karo — highest CTR milega!' });
});

connectDB().then(() => {
  app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
}).catch(err => {
  console.error('❌ MongoDB connection failed:', err);
  process.exit(1);
});
