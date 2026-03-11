# 🦅 Avian Lens

**AI-Powered Bird Photography Analysis & Species Identification**

A freemium web app that uses Claude AI to analyze bird photographs — identifying species, scoring image quality, extracting EXIF metadata, and enabling export to social platforms.

---

## ✨ Features

| Feature | Explorer (Free) | Ornithologist Pro ($10/mo) |
|---|---|---|
| Images per session | 3 | 20 |
| Species identification | ✅ | ✅ |
| Quality score (1–10) | ✅ | ✅ |
| EXIF metadata | ✅ | ✅ |
| Photographer tips | ✅ | ✅ |
| Quality gate filter | ✅ | ✅ |
| Per-species cap filter | ✅ | ✅ |
| Social media export | ❌ | ✅ |
| AI Model | claude-haiku-4-5 | claude-haiku-4-5 |

## 🔬 Analysis Output

For each uploaded bird photo, the AI provides:

- **Species ID** — Common name + scientific name + confidence level
- **Quality Score** — 1–10 rating with grade (Masterpiece → Poor)
- **Photo Analysis** — Lighting, composition, focus/sharpness, behavior
- **Improvement Tips** — Actionable photographer recommendations
- **Image Metadata** — File name, date, camera make/model, ISO, exposure, focal length

## 🚀 Getting Started

### Installation

```bash
git clone https://github.com/YOUR_USERNAME/avian-lens.git
cd avian-lens
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173)

## 🛠 Tech Stack

- **React 18** + **Vite**
- **Anthropic Claude API** (claude-haiku-4-5)
- Pure CSS custom design system
- EXIF parsing in pure JS

## 📄 License

MIT
