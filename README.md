# 🦅 Avian Lens

**AI-powered bird photography analysis & species identification**

Upload bird photos and get instant species ID, quality scoring, and photographer tips — powered by Claude AI.

---

## Features

- 🔬 **Species Identification** — Common name, scientific name, confidence level
- 📊 **Quality Scoring** — 1–10 scale with Masterpiece → Poor grades
- 📷 **EXIF Metadata** — Camera make/model, date, focal length, ISO, exposure
- 📍 **Geo Context** — Location-aware analysis with eBird regional species data
- 🎚 **Smart Filters** — Quality gate slider + per-species cap
- 📤 **Social Export** — Upload filtered photos to Google Photos, Instagram, Facebook
- 🆓 **Freemium** — Explorer (3 free) / Ornithologist Pro ($10/mo, 20 images)

## Tech Stack

- **Frontend** — React 18 + Vite (singlefile build, no CDN dependencies)
- **AI** — Claude Haiku 4.5 (free tier) / Claude Haiku 4.5 (pro tier)
- **Backend** — Vercel serverless function (`/api/analyze.js`)
- **Bird Data** — eBird API for regional species context

## Deploy to Vercel

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/f75/avian-lens)

1. Click **Deploy with Vercel** above
2. Add environment variable: `ANTHROPIC_API_KEY` = your Anthropic API key
3. Optionally add: `EBIRD_API_KEY` for regional bird data
4. Deploy!

## Local Development

```bash
# Install deps
npm install

# Build (uses vite.config.js.local)
cp vite.config.js.local vite.config.js
npx vite build
rm vite.config.js

# For live dev server
npx vite --config vite.config.js.local
```

Set `ANTHROPIC_API_KEY` in Vercel environment variables — never commit API keys.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | ✅ Yes | Your Anthropic API key (`sk-ant-...`) |
| `EBIRD_API_KEY` | Optional | eBird API key for regional species context |

## Project Structure

```
avian-lens/
├── api/
│   └── analyze.js        # Vercel serverless function (proxies Anthropic API)
├── src/
│   └── AvianLens.jsx     # Main React app (single file)
├── dist/
│   └── index.html        # Pre-built singlefile bundle (committed)
├── vercel.json           # Vercel config
└── vite.config.js.local  # Vite build config (renamed to avoid Vercel detection)
```

## License

MIT
