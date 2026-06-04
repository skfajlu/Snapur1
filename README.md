# SnapURL — Link Shortener 🔗

Ek full-stack link shortener with real analytics. Node.js backend + beautiful dark UI.

---

## 🚀 Local Setup (Apne Computer Pe)

### Requirements
- Node.js v18+ (https://nodejs.org se download karo)

### Steps

```bash
# 1. Folder mein jao
cd snapurl

# 2. Dependencies install karo
npm install

# 3. Server start karo
npm start

# 4. Browser mein kholo
# http://localhost:3000
```

---

## ☁️ Free Hosting — Railway.app (Recommended)

1. **railway.app** pe free account banao
2. "New Project" → "Deploy from GitHub" click karo
3. Apna snapurl folder GitHub pe push karo
4. Railway automatically deploy kar dega
5. Free domain milega jaise: `snapurl.up.railway.app`

### GitHub pe push karna:
```bash
git init
git add .
git commit -m "SnapURL launch"
# GitHub pe new repo banao, phir:
git remote add origin https://github.com/TERA_USERNAME/snapurl.git
git push -u origin main
```

---

## 💰 Earning Kaise Karein?

| Method | Kaise | Earning |
|--------|-------|---------|
| **Interstitial Ads** | Redirect se pehle ad dikhao (Adsterra/PropellerAds) | ₹1-5 per 1000 clicks |
| **Sponsored Links** | Businesses ke links shorten karo | Negotiate karo |
| **Premium Plan** | Custom domain + more stats = paid feature | ₹99/month charge karo |
| **API Access** | Developers ko API access becho | ₹199/month |

### Adsterra Setup:
1. adsterra.com pe signup karo
2. "Popunder" ad unit lo
3. `server.js` mein redirect se pehle ad page dikhao

---

## 📁 File Structure

```
snapurl/
├── server.js        ← Backend (Node.js + Express)
├── package.json     ← Dependencies
├── links.json       ← Database (auto-created)
└── public/
    └── index.html   ← Frontend UI
```

---

## 🔧 Customization

- **Domain change**: `index.html` mein `snpurl.in` replace karo apne domain se
- **Port change**: `server.js` mein `PORT = 3000` badlo
- **Ads lagao**: `server.js` ke redirect route mein ad page add karo

---

Made with ❤️ in India 🇮🇳
