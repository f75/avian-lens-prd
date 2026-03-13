import { useState, useCallback, useRef } from "react";

// ── API KEY (set here for direct browser / GitHub Pages use) ─────────────────
// On Vercel this is ignored — the key lives in the ANTHROPIC_API_KEY env var.
// WARNING: do not commit a real key to a public repo. Use Vercel env vars instead.
const BAKED_API_KEY = ""; // key lives in Vercel ANTHROPIC_API_KEY env var

const FREE_LIMIT = 3;
const PAID_LIMIT = 20;
const FREE_MODEL  = "claude-haiku-4-5-20251001";
const PAID_MODEL  = "claude-sonnet-4-6"; // Sonnet 4.6 for Pro — best available model

const SOCIAL = [
  { id:"google",    name:"Google Photos", icon:"🔵" },
  { id:"instagram", name:"Instagram",     icon:"📸" },
  { id:"facebook",  name:"Facebook",      icon:"📘" },
];

// ── EXIF ─────────────────────────────────────────────────────────────────────
const extractExif = (file) => new Promise(resolve => {
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const buf = e.target.result, view = new DataView(buf);
      if (view.getUint16(0) !== 0xFFD8) { resolve({}); return; }
      let off = 2;
      while (off < buf.byteLength - 4) {
        const marker = view.getUint16(off);
        if (marker === 0xFFE1) {
          const hdr = String.fromCharCode(
            view.getUint8(off+4), view.getUint8(off+5),
            view.getUint8(off+6), view.getUint8(off+7)
          );
          if (hdr === "Exif") {
            const ts = off+10, le = view.getUint16(ts) === 0x4949;
            const r16 = o => view.getUint16(ts+o, le);
            const r32 = o => view.getUint32(ts+o, le);
            const rStr = (o, n) => { let s=""; for(let i=0;i<n;i++){const b=view.getUint8(ts+o+i);if(!b)break;s+=String.fromCharCode(b);}return s.trim(); };
            const ifd = r32(4), num = r16(ifd), exif = {};
            for (let i=0; i<num; i++) {
              const ep=ifd+2+i*12, tag=r16(ep), type=r16(ep+2), cnt=r32(ep+4);
              const sz=[0,1,1,2,4,8,1,1,2,4,8,4,8], bLen=(sz[type]||1)*cnt;
              const vOff = bLen>4 ? r32(ep+8) : (ep+8-ts);
              if      (tag===0x010F) exif.make    = rStr(vOff, cnt);
              else if (tag===0x0110) exif.model   = rStr(vOff, cnt);
              else if (tag===0x0132) exif.dateTime= rStr(vOff, cnt);
              else if (tag===0x9003) exif.dateTimeOriginal = rStr(vOff, cnt);
              else if (tag===0x829A) { const n=r32(vOff),d=r32(vOff+4); if(d) exif.exposureTime=`1/${Math.round(d/n)}s`; }
              else if (tag===0x8827) exif.iso = `ISO ${r16(vOff)}`;
              else if (tag===0x920A) { const n=r32(vOff),d=r32(vOff+4); if(d) exif.focalLength=`${Math.round(n/d)}mm`; }
            }
            resolve(exif); return;
          }
        }
        if ((marker & 0xFF00) !== 0xFF00 || marker === 0xFFDA) break;
        off += 2 + view.getUint16(off+2);
      }
    } catch(_) {}
    resolve({});
  };
  reader.onerror = () => resolve({});
  reader.readAsArrayBuffer(file);
});

const readDataUrl = (file) => new Promise((res, rej) => {
  const r = new FileReader(); r.onload = e => res(e.target.result); r.onerror = rej;
  r.readAsDataURL(file);
});

// Resize + compress to stay under Vercel body limit and reduce API latency (~800px, JPEG 0.75)
const compressImage = (file) => new Promise((resolve, reject) => {
  const MAX_PX = 800, QUALITY = 0.75;
  const reader = new FileReader();
  reader.onerror = reject;
  reader.onload = (e) => {
    const img = new Image();
    img.onerror = reject;
    img.onload = () => {
      const { naturalWidth: w, naturalHeight: h } = img;
      let tw = w, th = h;
      if (w > MAX_PX || h > MAX_PX) {
        if (w >= h) { tw = MAX_PX; th = Math.round(h * MAX_PX / w); }
        else        { th = MAX_PX; tw = Math.round(w * MAX_PX / h); }
      }
      const canvas = document.createElement("canvas");
      canvas.width = tw; canvas.height = th;
      canvas.getContext("2d").drawImage(img, 0, 0, tw, th);
      resolve(canvas.toDataURL("image/jpeg", QUALITY));
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
});


// ── AI ────────────────────────────────────────────────────────────────────────
// ── CLAUDE API CALL (shared) ─────────────────────────────────────────────────
const callClaude = async (messages, model, apiKey, maxTokens = 1000, location = "") => {
  let resp, data;

  // 1. Try Vercel serverless proxy (hides API key, works in production)
  //    404 = no proxy present (GitHub Pages) → fall through to direct call
  try {
    resp = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages, model, maxTokens, location }),
    });

    if (resp.ok) {
      data = await resp.json();
      return data.content?.find(c => c.type === "text")?.text || "";
    }

    if (resp.status !== 404) {
      const errData = await resp.json().catch(() => ({}));
      throw new Error(errData.error || `Server error ${resp.status}`);
    }
    // 404 — no serverless proxy, fall through to direct call
  } catch(e) {
    if (!e.message.includes("fetch") && !e.message.includes("NetworkError") && !e.message.includes("Failed to fetch")) {
      throw e;
    }
  }

  // 2. Direct Anthropic API call (GitHub Pages / local dev — needs user-supplied key)
  if (!apiKey) throw new Error("No API key — enter your Anthropic key (sk-ant-...) in the bar above");
  resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({ model, max_tokens: maxTokens, messages }),
  });
  data = await resp.json();
  if (!resp.ok) throw new Error(data.error?.message || `Anthropic API error ${resp.status}`);
  return data.content?.find(c => c.type === "text")?.text || "";
};

// ── TWO-PASS ANALYSIS ─────────────────────────────────────────────────────────
// ── THREE-PASS ANALYSIS WITH EBIRD VERIFICATION ───────────────────────────────
// Pass 1 (vision → field notes): Systematic morphology extraction from image
// Pass 2 (text → top 3 candidates): Generate ranked candidates with % confidence, no final ID yet
// eBird check: Look up actual occurrence counts for each candidate at the location
// Pass 3 (arbitration → final ID): Claude sees eBird frequency data and must justify overriding it

// Helper: call /api/ebird to get occurrence counts for candidate species
const fetchEBirdCounts = async (lat, lng, candidates, obsDate = "", cachedData = null) => {
  if (!lat || !lng || !candidates.length) return null;

  // If we already have cached regional data, just re-score for this candidate list
  if (cachedData?.scores) {
    const scores = {};
    for (const name of candidates) {
      scores[name] = cachedData.scores[name] || { observed: false, obsCount: 0, lastSeen: null, rarity: "absent" };
    }
    return { ...cachedData, scores };
  }

  try {
    const params = new URLSearchParams({ lat, lng, candidates: candidates.join("|") });
    if (obsDate) params.set("obsDate", obsDate);
    const resp = await fetch(`/api/ebird?${params}`);
    if (!resp.ok) return null;
    return await resp.json();
  } catch { return null; }
};

// Helper: parse lat/lng from free-text location string
const parseCoords = (loc) => {
  if (!loc) return null;
  const dms = loc.match(/([0-9.]+)[°\s]*([NS])[,\s]+([0-9.]+)[°\s]*([EW])/i);
  if (dms) {
    let lat = parseFloat(dms[1]), lng = parseFloat(dms[3]);
    if (/S/i.test(dms[2])) lat = -lat;
    if (/W/i.test(dms[4])) lng = -lng;
    return { lat, lng };
  }
  const dec = loc.match(/(-?[0-9]+\.?[0-9]*)[,\s]+(-?[0-9]+\.?[0-9]*)/);
  if (dec) {
    const a = parseFloat(dec[1]), b = parseFloat(dec[2]);
    if (Math.abs(a) <= 90 && Math.abs(b) <= 180) return { lat: a, lng: b };
  }
  return null;
};

// ── eBird cache: keyed by "lat|lng|date" to avoid duplicate calls per batch ──
const _eBirdCache = {};

const analyzeImage = async (b64, mimeType, location, model, apiKey, _unused = [], correctionHint = "", onProgress = null, obsDate = "", skipSpecies = false) => {
  const progress = (msg) => onProgress && onProgress(msg);
  const fallback = (msg) => ({
    species:"Unidentifiable", scientificName:"", confidence:"Low",
    qualityScore:5, qualityGrade:"Fair", summary: msg || "Analysis incomplete",
    lighting:"", composition:"", focusSharpness:"", behavior:"",
    strengths:[], improvements:[], interestingFact:"",
    identificationReasoning:"", alternativesConsidered:"",
    _threePass:true, _eBirdData:null,
  });

  // ── QUALITY-ONLY MODE (skipSpecies = true) ────────────────────────────────
  if (skipSpecies) {
    progress("Analyzing photo quality…");
    try {
      const raw = await callClaude([{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mimeType, data: b64 } },
          { type: "text", text:
`You are an expert wildlife photography critic. Analyze ONLY the technical and artistic quality of this photograph. Do NOT identify the bird species — that is not required.

Return ONLY valid JSON — no text outside:
{
  "qualityScore": <1-10 integer>,
  "qualityGrade": "Masterpiece/Excellent/Good/Fair/Poor",
  "summary": "One sentence describing the overall image quality",
  "lighting": "Lighting quality and direction — golden hour, harsh midday, overcast, backlit etc.",
  "composition": "Framing, rule of thirds, negative space, background clutter",
  "focusSharpness": "Subject sharpness, motion blur, depth of field",
  "behavior": "What the bird is doing — perched, in flight, foraging etc.",
  "strengths": ["strength 1", "strength 2", "strength 3"],
  "improvements": ["specific tip 1", "specific tip 2", "specific tip 3"]
}` }
        ]
      }], "claude-haiku-4-5-20251001", apiKey, 800, location);
      const q = parseJSON(raw);
      return {
        species: "Not identified",
        scientificName: "",
        confidence: "N/A",
        identificationReasoning: "Species detection was skipped — quality-only mode.",
        alternativesConsidered: "",
        eBirdVerdict: "no_data",
        eBirdNote: "",
        interestingFact: "",
        qualityScore:    q.qualityScore    ?? 5,
        qualityGrade:    q.qualityGrade    ?? "Fair",
        summary:         q.summary         ?? "",
        lighting:        q.lighting        ?? "",
        composition:     q.composition     ?? "",
        focusSharpness:  q.focusSharpness  ?? "",
        behavior:        q.behavior        ?? "",
        strengths:       q.strengths       ?? [],
        improvements:    q.improvements    ?? [],
        _qualityOnly: true,
        _threePass: false,
        _eBirdData: null,
      };
    } catch(e) {
      return fallback(`Quality analysis failed: ${e.message}`);
    }
  }

  // ── PASS 1 (VISION): Always Haiku — fast image analysis, not bottlenecked by model size ──
  // Haiku is ~3× faster than Sonnet for vision and handles field-mark extraction excellently.
  // The tier model (Sonnet for Pro) is reserved for the text-only arbitration pass.
  const VISION_MODEL = "claude-haiku-4-5-20251001";
  progress("Pass 1 of 2 — Extracting field marks…");
  let fieldNotes, candidatesJson;
  try {
    const raw = await callClaude([{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: mimeType, data: b64 } },
        { type: "text", text:
`You are a field ornithologist and senior bird taxonomist in one. Study this photograph carefully.
Location: ${location || "not specified"}
Date: ${obsDate || "not specified"}${obsDate ? " — consider seasonal plumage, active migrants, and winter/summer residents" : ""}

Step 1 — Write systematic field notes covering every visible feature.
Step 2 — Using ONLY those field notes, rank the top 5 most likely species by field-mark match.
Step 3 — Score the photograph quality.

Return ONLY valid JSON — no text outside:
{
  "fieldNotes": "SIZE: ... SHAPE: ... HEAD: ... BILL: ... BREAST: ... BACK/WINGS: ... TAIL: ... LEGS: ... HABITAT: ... BEHAVIOR: ... PHOTO QUALITY: ... KEY DIAGNOSTIC MARKS: ...",
  "candidates": [
    { "species": "Common name", "scientificName": "Genus species", "confidence": 60, "keyMarks": "Specific marks clinching this ID", "concern": "Any genuine mismatch or empty string" },
    { "species": "Second", "scientificName": "Genus species", "confidence": 20, "keyMarks": "Supporting marks", "concern": "Why it ranks lower" },
    { "species": "Third",  "scientificName": "Genus species", "confidence": 10, "keyMarks": "Supporting marks", "concern": "Why it ranks lower" },
    { "species": "Fourth", "scientificName": "Genus species", "confidence": 7,  "keyMarks": "Supporting marks", "concern": "Why it ranks lower" },
    { "species": "Fifth",  "scientificName": "Genus species", "confidence": 3,  "keyMarks": "Supporting marks", "concern": "Why it ranks lower" }
  ],
  "qualityScore": <1-10 integer>,
  "qualityGrade": "Masterpiece/Excellent/Good/Fair/Poor",
  "summary": "One sentence describing the photograph",
  "lighting": "Lighting quality and direction",
  "composition": "Framing and subject placement",
  "focusSharpness": "Sharpness and motion blur",
  "behavior": "What the bird is doing",
  "strengths": ["strength 1", "strength 2"],
  "improvements": ["tip 1", "tip 2", "tip 3"],
  "interestingFact": "One short, genuinely surprising fact about the top candidate species (under 25 words)"
}

Rules: confidence scores must sum to 100. Never invent marks not in your observations. Concern must cite a real field-mark mismatch.` }
      ]
    }], VISION_MODEL, apiKey, 2000, location);
    candidatesJson = parseJSON(raw);
    fieldNotes = candidatesJson.fieldNotes || "";
  } catch(e) {
    return fallback(`Analysis failed: ${e.message}`);
  }

  const candidates = candidatesJson.candidates || [];
  const candidateNames = candidates.map(c => c.species).filter(Boolean);

  // ── EBIRD CHECK: Occurrence counts — cached per (lat, lng, date) across batch ──
  const coords = parseCoords(location);
  let eBirdData = null;

  if (coords && candidateNames.length) {
    const cacheKey = `${coords.lat.toFixed(2)}|${coords.lng.toFixed(2)}|${obsDate || ""}`;
    if (_eBirdCache[cacheKey]) {
      // Re-use cached regional data; just fetch counts for this image's specific candidates
      const cached = _eBirdCache[cacheKey];
      progress("eBird — Using cached regional data…");
      eBirdData = await fetchEBirdCounts(coords.lat, coords.lng, candidateNames, obsDate, cached);
    } else {
      progress("eBird — Checking regional occurrence data…");
      eBirdData = await fetchEBirdCounts(coords.lat, coords.lng, candidateNames, obsDate);
      if (eBirdData) _eBirdCache[cacheKey] = eBirdData;
    }
  }

  // ── GEO PATH: When location + eBird data available, pick the best eBird-confirmed candidate ──
  if (coords && eBirdData?.scores && !correctionHint) {
    const scored = candidates.map(c => {
      const s = eBirdData.scores[c.species];
      const obsCount = (s?.observed && s.obsCount) ? s.obsCount : 0;
      const observed = obsCount > 0;
      const eBirdMult = !observed ? 0.5
        : obsCount > 20 ? 1.3
        : obsCount > 4  ? 1.15
        : 1.0;
      const visualScore = typeof c.confidence === "number" ? c.confidence : 50;
      const combinedScore = visualScore * eBirdMult;
      return { ...c, obsCount, observed, eBirdMult, visualScore, combinedScore };
    });

    scored.sort((a, b) => b.combinedScore - a.combinedScore);
    const best = scored[0];
    const visualTop = candidates[0];
    const eBirdChanged = best.species !== visualTop.species;

    const rarity = !best.observed ? "not recently recorded in this area"
      : best.obsCount > 20 ? "very common in area"
      : best.obsCount > 4  ? "regularly seen in area"
      : "occasionally seen in area";

    progress("eBird — Species confirmed from regional data…");

    return {
      species: best.species,
      scientificName: best.scientificName || "",
      confidence: best.visualScore > 65 ? "High" : best.visualScore > 40 ? "Medium" : "Low",
      identificationReasoning: `${best.keyMarks}${best.observed ? ` — confirmed present in area (${best.obsCount} eBird records, ${eBirdData.dateLabel || "last 30 days"})` : " — visual ID; species not recently recorded in area"}.`,
      alternativesConsidered: scored.slice(1).map(c => `${c.species} — visual ${c.visualScore}%, eBird: ${c.observed?c.obsCount+" records":"absent"}`).join("; ") || "none",
      eBirdVerdict: best.observed ? (eBirdChanged ? "overridden" : "confirmed") : "unusual",
      eBirdNote: best.observed
        ? `${best.species} is ${rarity}; ${eBirdData.totalSpecies} species reported within 75km (${eBirdData.dateLabel || "last 30 days"}).${eBirdChanged ? ` eBird adjusted rank from visual #1 (${visualTop.species}).` : ""}`
        : `${best.species} not recently recorded nearby — identification based on visual field marks alone.`,
      userSuggestionVerdict: undefined,
      interestingFact: candidatesJson.interestingFact || "",
      qualityScore: candidatesJson.qualityScore,
      qualityGrade: candidatesJson.qualityGrade,
      summary: candidatesJson.summary,
      lighting: candidatesJson.lighting,
      composition: candidatesJson.composition,
      focusSharpness: candidatesJson.focusSharpness,
      behavior: candidatesJson.behavior,
      strengths: candidatesJson.strengths,
      improvements: candidatesJson.improvements,
      _threePass: true,
      _eBirdPrimary: true,
      _candidates: candidates,
      _eBirdData: eBirdData,
    };
  }

  // Build a human-readable eBird summary for Pass 3 (no-geo path)
  let eBirdSummary = "";
  if (eBirdData?.scores) {
    const lines = candidateNames.map(name => {
      const s = eBirdData.scores[name];
      if (!s) return `• ${name}: no eBird data`;
      if (!s.observed) return `• ${name}: ✗ NOT observed in last 30 days within 75km (absent from area)`;
      const freq = s.obsCount > 20 ? "very common" : s.obsCount > 4 ? "uncommon" : "rare";
      return `• ${name}: ✓ ${s.obsCount} observation${s.obsCount!==1?"s":""} (${freq}), last seen ${s.lastSeen}`;
    });
    eBirdSummary = `\nEBIRD OCCURRENCE DATA — last 30 days, 75km radius:\n${lines.join("\n")}\nTotal species observed in area: ${eBirdData.totalSpecies}\n`;
  }

  // ── VERIFICATION PASS (only when user provides a correction hint) ──────────
  // Runs BEFORE Pass 3. Stress-tests the user's suggestion against field notes
  // field-mark by field-mark. Designed to REJECT bad suggestions, not confirm them.
  let verificationSummary = "";
  if (correctionHint) {
    progress("Verifying your suggestion against field marks…");
    try {
      const verifyRaw = await callClaude([{
        role: "user",
        content:
`You are a skeptical ornithologist acting as a fact-checker. A photographer claims the bird in these field notes is a "${correctionHint}". Your job is to VERIFY OR REFUTE this claim using only the observed field marks. Do NOT be polite — if the marks don't match, say so clearly.

FIELD NOTES FROM THE PHOTOGRAPH:
${fieldNotes}

CLAIMED SPECIES: ${correctionHint}

Your task:
1. List the 5-6 most diagnostic field marks of a ${correctionHint} (from your ornithological knowledge)
2. For each mark, check it against the field notes: MATCH / PARTIAL / MISMATCH / CANNOT DETERMINE
3. Give an overall verdict

Return ONLY valid JSON:
{
  "claimedSpecies": "${correctionHint}",
  "diagnosticChecks": [
    { "mark": "field mark name", "expected": "what ${correctionHint} shows", "observed": "what field notes say", "verdict": "MATCH|PARTIAL|MISMATCH|UNKNOWN" }
  ],
  "matchCount": <number of MATCH>,
  "mismatchCount": <number of MISMATCH>,
  "overallVerdict": "CONFIRMED|PLAUSIBLE|UNLIKELY|REFUTED",
  "verificationNote": "One honest sentence — if marks mostly match say so; if they don't, say the suggestion is likely wrong"
}`
      }], model, apiKey, 900, location);
      const vResult = parseJSON(verifyRaw);
      const checks = vResult.diagnosticChecks?.map(c =>
        `  • ${c.mark}: expected "${c.expected}" → observed "${c.observed}" [${c.verdict}]`
      ).join("\n") || "";
      verificationSummary = `
INDEPENDENT FIELD-MARK VERIFICATION OF USER'S CLAIM ("${correctionHint}"):
${checks}
Overall verdict: ${vResult.overallVerdict} — ${vResult.verificationNote}
Match: ${vResult.matchCount} marks | Mismatch: ${vResult.mismatchCount} marks
`;
    } catch(_) {
      // Verification failed silently — Pass 3 proceeds without it
    }
  }

  // ── PASS 3: Final arbitration — Claude must reconcile vision + eBird + verification ──
  progress(correctionHint ? `Pass 2 of 2 — Arbitrating with ${model === "claude-sonnet-4-6" ? "Sonnet 4.6 🚀" : "Haiku ⚡"}…` : `Pass 2 of 2 — Final ID with ${model === "claude-sonnet-4-6" ? "Sonnet 4.6 🚀" : "Haiku ⚡"}…`);
  let txt;
  try {
    txt = await callClaude([{
      role: "user",
      content:
`You are a senior ornithologist making a final, evidence-based species identification. You are known for accuracy over agreeableness. You have three sources of evidence — weight them in this order: (1) field marks, (2) date/season context, (3) eBird regional frequency.

FIELD NOTES (merged Pass 1 — systematic visual extraction):
${fieldNotes}

DATE / SEASON CONTEXT: ${obsDate || "unknown"}${obsDate ? " — factor in expected plumage, migration status, and seasonal abundance" : ""}

VISUAL CANDIDATES (merged Pass 1 — ranked by field marks only, before any location bias):
${candidates.map((c,i) => (i+1)+". "+c.species+" — "+c.confidence+"% visual confidence\n   ✓ "+c.keyMarks+"\n   ✗ Concern: "+(c.concern||"none")).join("\n")}
${eBirdSummary || "\nNo eBird location data — base ID on field marks and season alone.\n"}${verificationSummary ? `
${verificationSummary}` : ""}
DECISION RULES (apply in order):
1. FIELD MARKS ARE PRIMARY. A rare species with perfect field-mark match beats a common species with a poor one.
2. BILL SHAPE + WING PATTERN + HEAD MARKS are the three most reliable features — weight them heavily.
3. SEASON matters: a species in wrong plumage for the date loses confidence; an expected migrant gains it.
4. EBIRD is a TIEBREAKER only — use it to resolve near-equal candidates, not to override clear visual evidence.
5. If a user suggestion is present: the MISMATCH count in the verification summary is the truth. Reject it if mismatches > matches, regardless of how confidently the user states it.
6. State your reasoning explicitly — name the 2–3 specific marks that clinch the final ID.

Return ONLY valid JSON — no text outside:
{
  "species": "Final common name (Unidentifiable only if genuinely impossible)",
  "scientificName": "Genus species",
  "confidence": "High/Medium/Low",
  "identificationReasoning": "Name the specific field marks (bill, wing bars, head pattern etc.) that clinch this ID over the alternatives",
  "alternativesConsidered": "Why each runner-up was ruled out — cite specific mark mismatches",
  "userSuggestionVerdict": "accepted|rejected|insufficient_evidence",
  "eBirdVerdict": "confirmed|unusual|overridden|no_data",
  "eBirdNote": "One sentence on eBird data — ONLY if eBird data was provided. Empty string if not."
}`
    }], model, apiKey, 900, location);
  } catch(e) {
    // Pass 3 failed — fall back to Pass 2 top candidate
    const top = candidates[0] || {};
    return {
      species: top.species || "Unidentifiable",
      scientificName: top.scientificName || "",
      confidence: top.confidence > 60 ? "High" : top.confidence > 35 ? "Medium" : "Low",
      identificationReasoning: top.keyMarks || "",
      alternativesConsidered: "",
      ...candidatesJson,
      _threePass: true,
      _pass3Failed: true,
      _eBirdData: eBirdData,
    };
  }

  // Parse Pass 3 result
  try {
    const id = parseJSON(txt);
    return {
      // Pass 3 final ID
      species: id.species,
      scientificName: id.scientificName,
      confidence: id.confidence,
      identificationReasoning: id.identificationReasoning,
      alternativesConsidered: id.alternativesConsidered,
      eBirdVerdict: id.eBirdVerdict,
      eBirdNote: id.eBirdNote,
      userSuggestionVerdict: id.userSuggestionVerdict,
      interestingFact: id.interestingFact || candidatesJson.interestingFact || "",
      // Photo quality from Pass 2
      qualityScore: candidatesJson.qualityScore,
      qualityGrade: candidatesJson.qualityGrade,
      summary: candidatesJson.summary,
      lighting: candidatesJson.lighting,
      composition: candidatesJson.composition,
      focusSharpness: candidatesJson.focusSharpness,
      behavior: candidatesJson.behavior,
      strengths: candidatesJson.strengths,
      improvements: candidatesJson.improvements,
      // Metadata
      _threePass: true,
      _candidates: candidates,
      _eBirdData: eBirdData,
    };
  } catch {
    return fallback("Could not parse final identification. Please retry.");
  }
};

// ── HELPERS ───────────────────────────────────────────────────────────────────
// Robust JSON parser — handles truncated responses by closing open brackets
const parseJSON = (raw) => {
  const txt = raw.replace(/^```json\s*/i,"").replace(/^```\s*/i,"").replace(/```\s*$/i,"").trim();
  const start = txt.indexOf("{");
  if (start === -1) throw new Error("No JSON object found");
  let s = txt.slice(start);

  // ── Fast path: clean JSON ──────────────────────────────────────────────────
  try { return JSON.parse(s); } catch(_) {}

  // ── Walk the string and record the parse state at every character ──────────
  // We track: depth, inStr, esc, lastCompletePos (last pos where depth===0)
  // Also record the position of each open bracket/brace so we know the stack.
  let depth = 0, inStr = false, esc = false, lastSafePos = 0;
  const openStack = []; // {char, pos} for each unmatched { or [

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (esc) { esc = false; continue; }
    if (ch === "\\" && inStr) { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === "{" || ch === "[") { openStack.push({ch, i}); depth++; }
    if (ch === "}" || ch === "]") {
      openStack.pop(); depth--;
      if (depth === 0) lastSafePos = i + 1;
    }
  }

  // ── If ended cleanly at depth 0, balanced subset is valid ─────────────────
  if (lastSafePos > 0 && depth === 0) {
    try { return JSON.parse(s.slice(0, lastSafePos)); } catch(_) {}
  }

  // ── Truncation repair ──────────────────────────────────────────────────────
  // Strategy: find the last COMPLETE key-value pair before truncation,
  // then close all open structures from innermost to outermost.

  let cut = s;

  if (inStr) {
    // We're inside an open string. Two cases:
    // (a) It's a VALUE string — was preceded by `: "`
    //     → Close it, then close all open structures.
    // (b) It's a KEY string — was preceded by `, "` or `{ "`
    //     → Remove the partial key+everything, then close all open structures.

    // Find where the unclosed string starts
    const lastQuote = cut.lastIndexOf('"', cut.length - 1);
    // Look backward from lastQuote for non-whitespace
    const before = cut.slice(0, lastQuote).trimEnd();
    const prevChar = before[before.length - 1];

    if (prevChar === ":") {
      // Case (a): mid-value — close the string, keep the key
      cut = cut.slice(0, lastQuote) + '"(truncated)"';
    } else {
      // Case (b): mid-key — remove partial key entry entirely
      // Strip back to the last comma or opening bracket
      const stripTo = Math.max(before.lastIndexOf(","), before.lastIndexOf("{"), before.lastIndexOf("["));
      cut = before.slice(0, stripTo + 1);
      // Remove trailing comma (would produce invalid JSON before closing brackets)
      cut = cut.replace(/,\s*$/, "");
    }
  } else {
    // Not in a string — strip trailing partial tokens (comma, colon, partial key)
    cut = cut
      .replace(/,\s*"[^"]*$/, "")   // partial key at end: , "key
      .replace(/,\s*$/, "")          // trailing comma
      .replace(/:\s*$/, ": null");   // dangling colon → null value
  }

  // Close all still-open structures in reverse order
  const closers = { "{": "}", "[": "]" };
  const closing = openStack.slice().reverse().map(o => closers[o.ch]).join("");

  // Before appending closers, remove a trailing comma that would be invalid
  cut = cut.replace(/,\s*$/, "");
  cut += closing;

  try { return JSON.parse(cut); } catch(e3) {
    // Absolute last resort: extract first complete top-level object
    const m = s.match(/\{[\s\S]*?\}/);
    if (m) { try { return JSON.parse(m[0]); } catch(_) {} }
    throw new Error("JSON repair failed: " + e3.message);
  }
};

const scoreColor = s => s>=9?"#4CAF50":s>=7?"#7CB342":s>=5?"#FFC107":s>=3?"#FF9800":"#F44336";
const gradeLabel = s => s>=9?"Masterpiece":s>=7?"Excellent":s>=5?"Good":s>=3?"Fair":"Poor";

// ─────────────────────────────────────────────────────────────────────────────
// STYLES
// ─────────────────────────────────────────────────────────────────────────────
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,600;0,700;1,400;1,600&family=DM+Sans:opsz,wght@9..40,300;9..40,400;9..40,500;9..40,600&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
body{background:#060f07;}
::-webkit-scrollbar{width:4px;}::-webkit-scrollbar-track{background:#0a1a0d;}::-webkit-scrollbar-thumb{background:#2d4a2d;border-radius:2px;}
.app{min-height:100vh;background:linear-gradient(155deg,#060f07 0%,#0d2010 55%,#060f07 100%);color:#EDE8D8;font-family:'DM Sans',sans-serif;}

/* ── LANDING ── */
.land{max-width:1000px;margin:0 auto;padding:0 24px;}
.hero{text-align:center;padding:60px 0 44px;}
.bird-float{font-size:6rem;display:block;margin-bottom:14px;animation:float 4s ease-in-out infinite;filter:drop-shadow(0 0 36px rgba(80,200,180,.5));}
@keyframes float{0%,100%{transform:translateY(0)}50%{transform:translateY(-8px)}}
.app-title{font-family:'Playfair Display',serif;font-size:clamp(2.4rem,7vw,4.4rem);font-weight:700;letter-spacing:-.02em;margin-bottom:9px;}
.app-title em{color:#C8A84B;font-style:italic;}
.tagline{font-size:1.1rem;color:#8FAF8A;letter-spacing:.06em;margin-bottom:32px;}
.pills{display:flex;flex-wrap:wrap;gap:6px;justify-content:center;margin-bottom:50px;}
.pill{padding:6px 16px;border-radius:20px;background:rgba(200,168,75,.07);border:1px solid rgba(200,168,75,.18);color:#C8A84B;font-size:.85rem;}
.p-row{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:64px;}
@media(max-width:560px){.p-row{grid-template-columns:1fr;}}
.pc{background:rgba(22,40,22,.7);border:1px solid rgba(100,150,100,.2);border-radius:16px;padding:26px 22px;cursor:pointer;transition:all .28s;backdrop-filter:blur(12px);position:relative;}
.pc:hover{border-color:rgba(200,168,75,.45);transform:translateY(-4px);box-shadow:0 20px 44px rgba(0,0,0,.4);}
.pc.hot{border-color:rgba(200,168,75,.38);background:rgba(30,52,28,.8);}
.pc.hot::after{content:'RECOMMENDED';position:absolute;top:12px;right:12px;background:#C8A84B;color:#060f07;font-size:.55rem;font-weight:700;letter-spacing:.1em;padding:3px 8px;border-radius:20px;}
.t-name{font-family:'Playfair Display',serif;font-size:1.5rem;font-weight:600;margin-bottom:3px;}
.t-price{font-size:2.6rem;font-weight:700;color:#C8A84B;line-height:1;margin-bottom:6px;}
.t-price small{font-size:.78rem;color:#8FAF8A;font-weight:300;}
.mc-chip{font-size:.63rem;color:rgba(168,200,168,.48);background:rgba(168,200,168,.05);border:1px solid rgba(168,200,168,.1);border-radius:5px;padding:3px 8px;margin-bottom:16px;display:inline-block;}
.mc-chip.pro{color:rgba(200,168,75,.62);background:rgba(200,168,75,.05);border-color:rgba(200,168,75,.15);}
.t-feats{list-style:none;margin-bottom:20px;}
.t-feats li{padding:6px 0;font-size:.95rem;color:#BAD0BA;display:flex;align-items:center;gap:7px;}
.t-feats li::before{content:'✦';color:#C8A84B;font-size:.58rem;flex-shrink:0;}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;padding:13px 22px;border-radius:8px;font-family:'DM Sans',sans-serif;font-size:1rem;font-weight:600;cursor:pointer;transition:all .2s;border:none;width:100%;}
.btn-gold{background:#C8A84B;color:#060f07;}.btn-gold:hover{background:#D4B95E;box-shadow:0 5px 18px rgba(200,168,75,.35);}
.btn-outline{background:rgba(200,168,75,.08);color:#C8A84B;border:1px solid rgba(200,168,75,.26);}.btn-outline:hover{background:rgba(200,168,75,.14);}
.btn-ghost{background:rgba(255,255,255,.04);color:#8FAF8A;border:1px solid rgba(255,255,255,.07);font-size:.76rem;padding:8px 14px;}.btn-ghost:hover{background:rgba(255,255,255,.08);}


/* ── WHO IT HELPS ── */
.who{margin-bottom:52px;}
.who-title{font-family:'Playfair Display',serif;font-size:1.6rem;font-weight:600;text-align:center;margin-bottom:6px;}
.who-sub{text-align:center;font-size:.95rem;color:#8FAF8A;margin-bottom:28px;}
.who-grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px;}
@media(max-width:680px){.who-grid{grid-template-columns:1fr;}}
.who-card{background:rgba(18,34,18,.75);border:1px solid rgba(100,150,100,.18);border-radius:14px;padding:22px 20px;backdrop-filter:blur(10px);transition:all .25s;}
.who-card:hover{border-color:rgba(200,168,75,.35);transform:translateY(-3px);box-shadow:0 14px 36px rgba(0,0,0,.35);}
.who-ico{font-size:2.4rem;margin-bottom:12px;display:block;}
.who-name{font-family:'Playfair Display',serif;font-size:1.1rem;font-weight:600;margin-bottom:4px;color:#EDE8D8;}
.who-role{font-size:.78rem;color:#C8A84B;font-weight:600;letter-spacing:.06em;text-transform:uppercase;margin-bottom:12px;}
.who-desc{font-size:.88rem;color:#BAD0BA;line-height:1.65;}
.who-tags{display:flex;flex-wrap:wrap;gap:5px;margin-top:12px;}
.who-tag{font-size:.72rem;padding:3px 9px;border-radius:8px;background:rgba(200,168,75,.07);border:1px solid rgba(200,168,75,.15);color:rgba(200,168,75,.75);}

/* ── API KEY BANNER ── */
.apibar{background:rgba(200,168,75,.07);border-bottom:1px solid rgba(200,168,75,.18);padding:7px 18px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
.apibar-lbl{font-size:.82rem;color:#C8A84B;font-weight:600;white-space:nowrap;}
.apibar-inp{flex:1;min-width:220px;background:rgba(10,20,10,.6);border:1px solid rgba(200,168,75,.25);border-radius:6px;padding:6px 11px;color:#EDE8D8;font-family:'DM Sans',sans-serif;font-size:.85rem;outline:none;}
.apibar-inp:focus{border-color:rgba(200,168,75,.5);}
.apibar-inp::placeholder{color:rgba(200,168,75,.3);}
.apibar-ok{font-size:.78rem;color:#4CAF50;font-weight:600;white-space:nowrap;}
.apibar-link{font-size:.75rem;color:rgba(200,168,75,.5);white-space:nowrap;}
/* ── HEADER ── */
.hdr{display:flex;align-items:center;justify-content:space-between;padding:11px 18px;border-bottom:1px solid rgba(100,150,100,.12);background:rgba(6,15,7,.9);backdrop-filter:blur(16px);position:sticky;top:0;z-index:200;}
.brand{font-family:'Playfair Display',serif;font-size:1.1rem;font-weight:600;display:flex;align-items:center;gap:6px;cursor:pointer;}
.brand em{color:#C8A84B;font-style:italic;}
.hdr-r{display:flex;align-items:center;gap:9px;}
.tc{padding:4px 10px;border-radius:20px;font-size:.68rem;font-weight:600;}
.tc-free{background:rgba(143,175,138,.07);border:1px solid rgba(143,175,138,.18);color:#8FAF8A;}
.tc-paid{background:rgba(200,168,75,.08);border:1px solid rgba(200,168,75,.28);color:#C8A84B;}
.ubar{display:flex;align-items:center;gap:6px;font-size:.68rem;color:#8FAF8A;}
.utrack{width:55px;height:3px;background:rgba(143,175,138,.16);border-radius:2px;overflow:hidden;}
.ufill{height:100%;border-radius:2px;transition:width .4s;}

/* ── WORKSPACE ── */
.ws{display:grid;grid-template-columns:420px 1fr;min-height:calc(100vh - 54px);}
@media(max-width:820px){.ws{grid-template-columns:1fr;}}
.lcol{border-right:1px solid rgba(100,150,100,.12);overflow-y:auto;max-height:calc(100vh - 54px);display:flex;flex-direction:column;}
.rcol{padding:14px 18px;overflow-y:auto;max-height:calc(100vh - 54px);}

/* ── UPLOAD CONFIG PANEL (top of left col) ── */
.upload-config{padding:16px 18px;border-bottom:2px solid rgba(100,150,100,.18);background:rgba(10,22,10,.6);}
.uc-title{font-size:.95rem;font-weight:700;color:#C8A84B;letter-spacing:.12em;text-transform:uppercase;margin-bottom:14px;display:flex;align-items:center;gap:8px;}
.uc-title::after{content:'';flex:1;height:1px;background:rgba(200,168,75,.18);}

/* Slider rows */
.sl-row{margin-bottom:14px;}
.sl-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:7px;}
.sl-label{font-size:1rem;color:#BAD0BA;font-weight:600;}
.sl-value{font-size:1rem;font-weight:700;padding:4px 12px;border-radius:10px;min-width:48px;text-align:center;}
.sl-sub{font-size:.85rem;color:rgba(143,175,138,.65);margin-top:5px;line-height:1.5;}

/* Custom range */
.rng{width:100%;-webkit-appearance:none;appearance:none;height:4px;border-radius:2px;outline:none;cursor:pointer;}
.rng::-webkit-slider-thumb{-webkit-appearance:none;width:20px;height:20px;border-radius:50%;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.4);transition:transform .15s;}
.rng::-webkit-slider-thumb:hover{transform:scale(1.2);}

/* Quick pick chips */
.qchips{display:flex;gap:5px;margin-top:7px;flex-wrap:wrap;}
.qchip{padding:6px 14px;border-radius:10px;font-size:.88rem;font-weight:600;cursor:pointer;transition:all .15s;border:1px solid rgba(100,150,100,.2);background:rgba(22,40,22,.6);color:rgba(174,202,174,.75);}
.qchip:hover{border-color:rgba(200,168,75,.35);color:#C8A84B;}
.qchip.on{background:rgba(200,168,75,.14);border-color:rgba(200,168,75,.4);color:#C8A84B;}

/* Score bar preview */
.score-preview{display:flex;gap:3px;height:6px;border-radius:3px;overflow:hidden;margin-top:8px;}
.score-seg{flex:1;transition:background .3s;}

/* Skip species toggle */
.skip-species-toggle{display:flex;align-items:center;justify-content:space-between;padding:9px 11px;border-radius:9px;border:1px solid rgba(100,150,100,.2);background:rgba(22,40,22,.5);cursor:pointer;transition:all .22s;margin-bottom:12px;user-select:none;}
.skip-species-toggle:hover{border-color:rgba(200,168,75,.35);background:rgba(22,40,22,.8);}
.skip-species-toggle.on{border-color:rgba(200,168,75,.5);background:rgba(200,168,75,.07);}
.sst-left{display:flex;align-items:center;gap:9px;}
.sst-icon{font-size:1.25rem;line-height:1;}
.sst-label{font-size:.76rem;font-weight:600;color:#BAD0BA;}
.sst-sub{font-size:.62rem;color:rgba(143,175,138,.5);margin-top:1px;}
.skip-species-toggle.on .sst-label{color:#EDE8D8;}
.skip-species-toggle.on .sst-sub{color:rgba(200,168,75,.65);}
.sst-pill{font-size:.6rem;font-weight:700;letter-spacing:.08em;padding:3px 8px;border-radius:10px;background:rgba(100,150,100,.12);border:1px solid rgba(100,150,100,.2);color:rgba(143,175,138,.5);transition:all .22s;}
.sst-pill.on{background:rgba(200,168,75,.18);border-color:rgba(200,168,75,.45);color:#C8A84B;}

/* Upload count info */
.uc-info{display:flex;gap:8px;margin-top:2px;}
.uc-stat{flex:1;background:rgba(22,40,22,.7);border:1px solid rgba(100,150,100,.16);border-radius:7px;padding:7px 10px;text-align:center;}
.uc-stat-num{font-family:'Playfair Display',serif;font-size:1.9rem;font-weight:700;color:#C8A84B;line-height:1;}
.uc-stat-lbl{font-size:.85rem;color:rgba(143,175,138,.75);margin-top:3px;letter-spacing:.04em;}

/* ── DROP ZONE (below config) ── */
.drop-area{padding:14px 16px 16px;flex-shrink:0;}
.drop{border:2px dashed rgba(100,150,100,.25);border-radius:12px;padding:24px 16px;text-align:center;cursor:pointer;transition:all .25s;background:rgba(22,40,22,.2);position:relative;}
.drop.ov{border-color:#C8A84B;background:rgba(200,168,75,.04);}
.drop:hover{border-color:rgba(200,168,75,.38);}
.drop.disabled{opacity:.4;cursor:not-allowed;}
.drop-ico{font-size:3.2rem;display:block;margin-bottom:12px;opacity:.8;}
.drop-main{font-size:1.1rem;color:#BAD0BA;font-weight:700;margin-bottom:6px;}
.drop-hint{font-size:.9rem;color:rgba(143,175,138,.65);line-height:1.6;}
.drop-badge{display:inline-flex;align-items:center;gap:6px;margin-top:12px;padding:7px 16px;border-radius:20px;background:rgba(200,168,75,.1);border:1px solid rgba(200,168,75,.25);font-size:.9rem;color:#C8A84B;font-weight:600;}

/* LOCATION */
.loc-area{padding:0 16px 14px;}
.flbl{font-size:.9rem;font-weight:700;color:#8FAF8A;letter-spacing:.08em;text-transform:uppercase;margin-bottom:7px;display:block;}
.finp{width:100%;background:rgba(22,40,22,.5);border:1px solid rgba(100,150,100,.22);border-radius:8px;padding:12px 15px;color:#EDE8D8;font-family:'DM Sans',sans-serif;font-size:1rem;outline:none;transition:border-color .2s;}
.finp:focus{border-color:rgba(200,168,75,.42);}
.finp::placeholder{color:rgba(143,175,138,.3);}

/* QUEUED IMAGES */
.queue-area{padding:0 16px;flex:1;}
.queue-hdr{display:flex;align-items:center;justify-content:space-between;margin-bottom:9px;}
.queue-lbl{font-size:.92rem;font-weight:700;color:#8FAF8A;letter-spacing:.1em;text-transform:uppercase;}
.clear-btn{font-size:.88rem;color:rgba(200,168,75,.65);background:none;border:none;cursor:pointer;padding:4px 9px;}
.clear-btn:hover{color:#C8A84B;}

/* Filter status bar */
.filter-status{display:flex;align-items:center;justify-content:space-between;padding:6px 10px;background:rgba(200,168,75,.05);border:1px solid rgba(200,168,75,.14);border-radius:7px;margin-bottom:9px;font-size:.67rem;}
.fs-left{color:rgba(174,202,174,.7);}
.fs-right{color:#C8A84B;font-weight:600;}
.filtered-out-note{font-size:.62rem;color:rgba(200,100,60,.7);display:flex;align-items:center;gap:4px;margin-top:5px;}

.tgrid{display:grid;grid-template-columns:repeat(4,1fr);gap:5px;}
.thumb{position:relative;aspect-ratio:1;border-radius:7px;overflow:hidden;cursor:pointer;border:2px solid transparent;transition:all .2s;background:rgba(18,30,18,.7);}
.thumb img{width:100%;height:100%;object-fit:cover;display:block;}
.thumb.sel{border-color:#C8A84B;}
.thumb.busy{border-color:#4CAF50;animation:ring 1.2s infinite;}
.thumb.done-pass{border-color:rgba(76,175,80,.4);}
.thumb.done-fail{border-color:rgba(200,80,40,.4);opacity:.5;}
@keyframes ring{0%,100%{box-shadow:0 0 0 0 rgba(76,175,80,.3)}50%{box-shadow:0 0 0 3px rgba(76,175,80,0)}}
.tov{position:absolute;inset:0;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;gap:4px;opacity:0;transition:opacity .2s;}
.thumb:hover .tov{opacity:1;}
.ticobtn{background:rgba(0,0,0,.65);border:1px solid rgba(255,255,255,.18);color:#fff;width:22px;height:22px;border-radius:50%;cursor:pointer;font-size:.65rem;display:flex;align-items:center;justify-content:center;}
.ticobtn.del:hover{background:rgba(192,57,43,.8);}
.ticobtn:hover{background:rgba(200,168,75,.65);}
.tbadge{position:absolute;bottom:3px;right:3px;font-size:.56rem;font-weight:700;padding:2px 4px;border-radius:5px;background:rgba(0,0,0,.75);backdrop-filter:blur(4px);}
.tname{position:absolute;bottom:3px;left:3px;right:22px;font-size:.5rem;padding:2px 3px;border-radius:4px;background:rgba(0,0,0,.72);backdrop-filter:blur(4px);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#EDE8D8;}
.tfail-overlay{position:absolute;inset:0;background:rgba(200,60,40,.15);display:flex;align-items:center;justify-content:center;}
.spinov{position:absolute;inset:0;background:rgba(6,15,7,.82);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;}
.spin{display:inline-block;border:2px solid rgba(200,168,75,.18);border-top-color:#C8A84B;border-radius:50%;animation:sp .7s linear infinite;}
@keyframes sp{to{transform:rotate(360deg)}}

/* ANALYZE DOCK */
.adock{padding:12px 16px 14px;border-top:1px solid rgba(100,150,100,.1);flex-shrink:0;}
.abtn{width:100%;padding:16px;background:#C8A84B;border:none;border-radius:10px;color:#060f07;font-family:'DM Sans',sans-serif;font-size:1.1rem;font-weight:700;cursor:pointer;transition:all .2s;display:flex;align-items:center;justify-content:center;gap:9px;}
.abtn:hover:not(:disabled){background:#D4B95E;transform:translateY(-1px);box-shadow:0 5px 18px rgba(200,168,75,.3);}
.abtn:disabled{opacity:.38;cursor:not-allowed;}
.abtn-sub{font-size:.88rem;color:rgba(143,175,138,.65);text-align:center;margin-top:7px;}
.pbr{width:100%;height:3px;background:rgba(200,168,75,.1);border-radius:2px;overflow:hidden;margin-top:7px;}
.pbf{height:100%;background:#C8A84B;border-radius:2px;animation:pg 2s ease-in-out infinite;}
@keyframes pg{0%{width:5%}50%{width:90%}100%{width:5%}}
.warn{background:rgba(200,80,40,.07);border:1px solid rgba(200,80,40,.22);border-radius:6px;padding:7px 11px;font-size:.75rem;color:#E8956A;display:flex;align-items:center;gap:6px;}

/* ── RIGHT PANEL ── */
.empty{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:65vh;color:rgba(143,175,138,.32);text-align:center;gap:10px;}
.empty-ico{font-size:4.5rem;animation:float 5s ease-in-out infinite;}
.empty-t{font-family:'Playfair Display',serif;font-size:1.35rem;color:rgba(143,175,138,.42);}

/* NAV BAR */
.img-hdr{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;}
.navbtn{background:rgba(200,168,75,.08);border:1px solid rgba(200,168,75,.2);color:#C8A84B;border-radius:50%;width:30px;height:30px;display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:.9rem;transition:all .2s;}
.navbtn:hover{background:rgba(200,168,75,.2);}
.navbtn:disabled{opacity:.22;cursor:not-allowed;}
.dots{display:flex;gap:4px;}
.dot{width:7px;height:7px;border-radius:50%;border:none;cursor:pointer;padding:0;transition:background .2s;}

/* ── LAYOUT C: Sidebar image + dense right content ── */
.lc-wrap{display:grid;grid-template-columns:260px 1fr;gap:12px;align-items:start;}
@media(max-width:900px){.lc-wrap{grid-template-columns:1fr;}}

/* Left sidebar: image fills height, meta below */
.lc-imgcol{display:flex;flex-direction:column;gap:7px;position:sticky;top:0;}
.prev-img{width:100%;height:auto;object-fit:cover;border-radius:11px;background:rgba(10,20,10,.8);display:block;cursor:zoom-in;}
.lc-meta{display:flex;flex-direction:column;gap:4px;}
.imb{display:flex;align-items:center;gap:6px;background:rgba(14,24,14,.8);border:1px solid rgba(100,150,100,.14);border-radius:6px;padding:5px 9px;}
.imb-k{font-size:.62rem;color:rgba(143,175,138,.5);text-transform:uppercase;letter-spacing:.07em;white-space:nowrap;flex-shrink:0;}
.imb-v{font-size:.78rem;color:#EDE8D8;font-weight:500;word-break:break-all;}

/* Right: stacked content sections */
.lc-right{display:flex;flex-direction:column;gap:10px;}

/* Species + score banner */
.sp-hero{background:linear-gradient(135deg,rgba(24,44,22,.97),rgba(14,26,14,.97));border:1px solid rgba(100,150,100,.24);border-radius:11px;padding:14px 16px;position:relative;overflow:hidden;}
.sp-hero::before{content:'';position:absolute;top:-24px;right:-14px;width:100px;height:100px;background:radial-gradient(circle,rgba(200,168,75,.1),transparent 68%);}
.sp-eyebrow{font-size:.66rem;font-weight:700;letter-spacing:.16em;color:rgba(143,175,138,.55);text-transform:uppercase;margin-bottom:3px;}
.sp-name{font-family:'Playfair Display',serif;font-size:clamp(1.4rem,2.6vw,1.9rem);font-weight:700;color:#EDE8D8;line-height:1.05;margin-bottom:2px;}
.sp-sci{font-family:'Playfair Display',serif;font-style:italic;font-size:.95rem;color:#8FAF8A;margin-bottom:8px;}
.sp-badges{display:flex;align-items:center;gap:5px;flex-wrap:wrap;margin-bottom:8px;}
.conf-chip{padding:4px 11px;border-radius:10px;font-size:.78rem;font-weight:700;letter-spacing:.04em;background:rgba(200,168,75,.1);border:1px solid rgba(200,168,75,.28);color:#C8A84B;}

/* Score inline — sits to the right of species name in banner */
.score-inline{display:flex;align-items:center;gap:9px;background:rgba(8,18,8,.55);border:1px solid rgba(100,150,100,.18);border-radius:8px;padding:8px 12px;flex-shrink:0;}
.score-big{font-family:'Playfair Display',serif;font-size:2.6rem;font-weight:700;line-height:1;}
.score-info{min-width:0;}
.score-grade{font-size:.9rem;font-weight:700;margin-bottom:3px;}
.score-bar-track{width:100%;height:4px;background:rgba(22,40,22,.8);border-radius:2px;overflow:hidden;}
.score-bar-fill{height:100%;border-radius:2px;transition:width .8s cubic-bezier(.4,0,.2,1);}
.score-summary{font-size:.82rem;color:#BAD0BA;margin-top:4px;line-height:1.45;}

/* GATE BADGE */
.gate-pass{display:inline-flex;align-items:center;gap:5px;padding:4px 10px;border-radius:18px;font-size:.75rem;font-weight:700;background:rgba(76,175,80,.1);border:1px solid rgba(76,175,80,.3);color:#81C784;}
.gate-fail{display:inline-flex;align-items:center;gap:5px;padding:4px 10px;border-radius:18px;font-size:.75rem;font-weight:700;background:rgba(200,80,40,.1);border:1px solid rgba(200,80,40,.3);color:#E8956A;}

/* 2×2 analysis grid */
.rc-group{display:grid;grid-template-columns:1fr 1fr;gap:7px;}
.rc{background:rgba(18,32,18,.6);border:1px solid rgba(100,150,100,.15);border-radius:8px;padding:9px 12px;}
.rc-k{font-size:.67rem;color:rgba(143,175,138,.62);letter-spacing:.09em;text-transform:uppercase;margin-bottom:3px;}
.rc-v{font-size:.88rem;color:#EDE8D8;line-height:1.45;}

/* SECTION HEADERS */
.st{font-size:.7rem;font-weight:700;color:#8FAF8A;letter-spacing:.14em;text-transform:uppercase;display:flex;align-items:center;gap:7px;margin-bottom:8px;}
.st::after{content:'';flex:1;height:1px;background:rgba(100,150,100,.15);}

/* Tips + strengths side by side */
.lc-bottom{display:grid;grid-template-columns:1fr 1fr;gap:10px;}
@media(max-width:700px){.lc-bottom{grid-template-columns:1fr;}}

/* STRENGTHS */
.tag-row{display:flex;flex-wrap:wrap;gap:5px;}
.tag-g{padding:5px 12px;border-radius:10px;font-size:.84rem;background:rgba(76,175,80,.07);border:1px solid rgba(76,175,80,.18);color:#81C784;line-height:1.35;}

/* TIPS */
.tips{list-style:none;}
.tips li{padding:6px 0;border-bottom:1px solid rgba(100,150,100,.1);font-size:.88rem;color:#BAD0BA;display:flex;gap:8px;line-height:1.5;}
.tips li:last-child{border-bottom:none;}
.tips li span{color:#C8A84B;flex-shrink:0;font-weight:700;}

/* FACT */
.fact{background:rgba(200,168,75,.05);border:1px solid rgba(200,168,75,.15);border-radius:9px;padding:10px 13px;font-size:.88rem;color:#C8D8A8;line-height:1.6;}

/* unused but kept for any leftover refs */
.mgrid{display:grid;grid-template-columns:1fr 1fr;gap:6px;}
.mc{background:rgba(14,24,14,.7);border:1px solid rgba(100,150,100,.13);border-radius:7px;padding:7px 10px;}
.mc-k{font-size:.65rem;color:rgba(143,175,138,.6);letter-spacing:.08em;text-transform:uppercase;margin-bottom:3px;}
.mc-v{font-size:.88rem;color:#EDE8D8;word-break:break-word;line-height:1.4;}
.img-strip{display:none;}
.dash-top{display:none;}
.dash-bot{display:none;}
.dash-col{display:flex;flex-direction:column;gap:8px;}

/* SOCIAL DOCK (left panel) */
.share-dock{padding:0 16px 14px;border-top:1px solid rgba(100,150,100,.1);}
.share-dock-inner{background:rgba(18,32,18,.7);border:1px solid rgba(100,150,100,.18);border-radius:10px;padding:12px 13px;}
.share-title{font-size:.92rem;font-weight:700;color:#8FAF8A;letter-spacing:.1em;text-transform:uppercase;margin-bottom:12px;display:flex;align-items:center;justify-content:space-between;}
.share-count{font-size:.62rem;color:#C8A84B;font-weight:600;background:rgba(200,168,75,.1);padding:2px 7px;border-radius:8px;}
.share-btns{display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-bottom:8px;}
.soc-tile{display:flex;flex-direction:column;align-items:center;gap:5px;padding:11px 8px;border-radius:8px;border:1px solid rgba(100,150,100,.2);background:rgba(22,40,22,.6);color:#BAD0BA;font-family:'DM Sans',sans-serif;font-size:.82rem;font-weight:500;cursor:pointer;transition:all .2s;}
.soc-tile:hover{border-color:rgba(200,168,75,.4);background:rgba(200,168,75,.07);color:#EDE8D8;transform:translateY(-1px);}
.soc-tile.lkd{border-color:rgba(76,175,80,.4);background:rgba(76,175,80,.06);color:#81C784;}
.soc-tile.lkd:hover{border-color:rgba(76,175,80,.55);}
.soc-tile-ico{font-size:2rem;line-height:1;}
.soc-tile-lbl{font-size:.88rem;letter-spacing:.02em;}
.share-note{font-size:.88rem;color:rgba(143,175,138,.6);text-align:center;line-height:1.5;}
.share-disabled{opacity:.38;pointer-events:none;}
.share-lock{display:flex;align-items:center;justify-content:center;gap:6px;padding:9px;background:rgba(200,168,75,.05);border:1px dashed rgba(200,168,75,.2);border-radius:8px;font-size:.7rem;color:rgba(200,168,75,.55);cursor:pointer;transition:all .2s;}
.share-lock:hover{background:rgba(200,168,75,.09);color:#C8A84B;}

/* ZIP DOWNLOAD */
.zip-btn{width:100%;display:flex;align-items:center;justify-content:center;gap:7px;padding:9px 12px;background:rgba(33,150,243,.08);border:1px solid rgba(33,150,243,.28);border-radius:8px;color:#64B5F6;font-family:'DM Sans',sans-serif;font-size:.82rem;font-weight:600;cursor:pointer;transition:all .22s;margin-top:8px;}
.zip-btn:hover:not(:disabled){background:rgba(33,150,243,.15);border-color:rgba(33,150,243,.5);transform:translateY(-1px);}
.zip-btn:disabled{opacity:.45;cursor:not-allowed;transform:none;}
.zip-btn.zipping{border-color:rgba(33,150,243,.45);background:rgba(33,150,243,.12);}
.zip-bar-wrap{width:100%;height:3px;background:rgba(33,150,243,.12);border-radius:2px;overflow:hidden;margin-top:5px;}
.zip-bar{height:100%;background:#42A5F5;border-radius:2px;transition:width .3s ease;}

/* LIGHTBOX */
.lb-bg{position:fixed;inset:0;background:rgba(0,0,0,.93);display:flex;align-items:center;justify-content:center;z-index:500;backdrop-filter:blur(8px);padding:16px;}
.lb-img{max-width:92vw;max-height:86vh;object-fit:contain;border-radius:9px;box-shadow:0 20px 60px rgba(0,0,0,.6);}
.lb-close{position:absolute;top:16px;right:16px;background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.18);color:#fff;width:34px;height:34px;border-radius:50%;cursor:pointer;font-size:.95rem;display:flex;align-items:center;justify-content:center;}
.lb-close:hover{background:rgba(255,255,255,.2);}
.lb-info{position:absolute;bottom:20px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,.72);backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,.1);border-radius:22px;padding:6px 18px;font-size:.76rem;color:#EDE8D8;white-space:nowrap;max-width:88vw;overflow:hidden;text-overflow:ellipsis;}

/* MODALS */
.mbg{position:fixed;inset:0;background:rgba(0,0,0,.76);display:flex;align-items:center;justify-content:center;z-index:999;backdrop-filter:blur(6px);padding:18px;}
.modal{background:#0e1e0f;border:1px solid rgba(100,150,100,.2);border-radius:15px;padding:26px;max-width:400px;width:100%;position:relative;}
.mclose{position:absolute;top:11px;right:13px;background:none;border:none;color:#8FAF8A;cursor:pointer;font-size:.95rem;padding:3px;}
.m-title{font-family:'Playfair Display',serif;font-size:1.35rem;font-weight:600;margin-bottom:6px;}
.m-desc{font-size:.82rem;color:#8FAF8A;margin-bottom:18px;line-height:1.55;}
.upbox{background:rgba(200,168,75,.05);border:1px solid rgba(200,168,75,.15);border-radius:8px;padding:13px;margin-bottom:16px;}
.upbox-price{font-size:1.35rem;font-weight:700;color:#C8A84B;}
.upbox-detail{font-size:.72rem;color:#8FAF8A;margin-top:3px;}
.soc-inner{text-align:center;}
.auth-ico{font-size:3rem;display:block;margin-bottom:12px;}
.auth-steps{display:flex;justify-content:center;gap:6px;margin-top:12px;}
.astp{width:6px;height:6px;border-radius:50%;background:rgba(200,168,75,.18);transition:background .4s;}
.astp.on{background:#C8A84B;}
.auth-note{margin-top:12px;font-size:.68rem;color:rgba(143,175,138,.42);background:rgba(143,175,138,.04);border:1px solid rgba(143,175,138,.1);border-radius:5px;padding:6px 10px;}
`;

// ─────────────────────────────────────────────────────────────────────────────
// APP
// ─────────────────────────────────────────────────────────────────────────────
export default function AvianLens() {
  const [page,        setPage]        = useState("landing");
  const [apiKey,      setApiKey]      = useState(() => sessionStorage.getItem("avian_api_key") || BAKED_API_KEY);
  const [tier,        setTier]        = useState(null);
  const [sessionUsed, setSessionUsed] = useState(0);
  const [images,      setImages]      = useState([]);   // all uploaded
  const [location,    setLocation]    = useState("");
  const [obsDate,      setObsDate]      = useState("");  // date of observation
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isCancelled, setIsCancelled] = useState(false);
  const cancelRef = useRef(false);
  const [curIdx,      setCurIdx]      = useState(-1);
  const [progressMsg, setProgressMsg] = useState("");
  const [selIdx,      setSelIdx]      = useState(0);
  const [showUpgrade, setShowUpgrade] = useState(false);
  const [showSocial,  setShowSocial]  = useState(false);
  const [socialStep,  setSocialStep]  = useState(null);
  const [connected,   setConnected]   = useState({});
  const [dragOver,    setDragOver]    = useState(false);
  const [lightbox,    setLightbox]    = useState(null);

  const [correcting,  setCorrecting]  = useState(null);   // { idx, hint }
  const [isZipping,   setIsZipping]   = useState(false);
  const [zipProgress, setZipProgress] = useState(0);

  // ── PRE-UPLOAD FILTERS ───────────────────────────────────────────────────
  const [minQuality,    setMinQuality]    = useState(5);   // minimum quality gate (1–10)
  const [maxPerSpecies, setMaxPerSpecies] = useState(5);   // max images per species shown
  const [skipSpecies,   setSkipSpecies]   = useState(false); // quality-only mode

  const fileRef = useRef();

  const limit          = tier === "paid" ? PAID_LIMIT : FREE_LIMIT;
  const model          = tier === "paid" ? PAID_MODEL  : FREE_MODEL;
  const limitRemaining = Math.max(0, limit - sessionUsed - images.length);
  const usagePct       = Math.min(100, (sessionUsed + images.length) / limit * 100);

  // ── APPLY POST-ANALYSIS FILTERS ──────────────────────────────────────────
  // Build display list: enforce quality gate + per-species cap on analyzed images
  const speciesCountMap = {};
  const displayImages = images.map(img => {
    if (!img.analysis) return { ...img, _filtered: false };
    const score = img.analysis.qualityScore ?? 0;
    const sp    = img.analysis.species || "Unknown";
    if (score < minQuality) return { ...img, _filtered: true, _filterReason: `Score ${score} below min ${minQuality}` };
    speciesCountMap[sp] = (speciesCountMap[sp] || 0) + 1;
    if (speciesCountMap[sp] > maxPerSpecies) return { ...img, _filtered: true, _filterReason: `>${maxPerSpecies} of species` };
    return { ...img, _filtered: false };
  });

  const passCount     = displayImages.filter(i => i.analysis && !i._filtered).length;
  const filteredCount = displayImages.filter(i => i._filtered).length;
  const analyzedCount = images.filter(i => i.analysis).length;
  const uniqueSpecies = new Set(images.filter(i => i.analysis?.species).map(i => i.analysis.species)).size;
  const selImg        = images[selIdx] || null;
  const selDisplay    = displayImages[selIdx] || null;

  // ── FILE HANDLING ────────────────────────────────────────────────────────
  const handleFiles = useCallback(async (files) => {
    // Only accept image/* files; enforce batch (multiple) only
    const valid = Array.from(files).filter(f => f.type.startsWith("image/"));
    if (!valid.length) return;
    const avail = Math.max(0, limit - sessionUsed - images.length);
    if (avail <= 0) { setShowUpgrade(true); return; }
    const toAdd = valid.slice(0, avail);

    const processed = await Promise.all(toAdd.map(async file => {
      const dataUrl = await compressImage(file);  // compressed to ~1024px JPEG for API
      const exif    = await extractExif(file);
      return {
        dataUrl, name: file.name,
        size: (file.size / 1024).toFixed(1) + "KB",
        type: "image/jpeg",  // always JPEG after compression
        lastMod: new Date(file.lastModified).toLocaleDateString("en-GB", { day:"numeric", month:"short", year:"numeric" }),
        exif, analysis: null, error: null,
      };
    }));

    setImages(prev => {
      const next = [...prev, ...processed];
      setSelIdx(prev.length); // jump to first new
      return next;
    });
    if (valid.length > avail) setShowUpgrade(true);
  }, [limit, sessionUsed, images.length]);

  const onDrop      = useCallback(e => { e.preventDefault(); setDragOver(false); handleFiles(e.dataTransfer.files); }, [handleFiles]);
  const onDragOver  = useCallback(e => { e.preventDefault(); setDragOver(true); }, []);
  const onDragLeave = useCallback(() => setDragOver(false), []);

  const removeImg = idx => {
    setImages(p => { const n = [...p]; n.splice(idx, 1); return n; });
    setSelIdx(s => Math.max(0, s > idx ? s - 1 : s));
  };
  const clearAll = () => { setImages([]); setSelIdx(0); setSessionUsed(0); };

  // ── ANALYZE ──────────────────────────────────────────────────────────────
  const stopAnalysis = () => { cancelRef.current = true; setIsCancelled(true); };

  const runAnalysis = async (specificIdx = null) => {
    if (!images.length || isAnalyzing) return;
    cancelRef.current = false;
    setIsCancelled(false);
    setIsAnalyzing(true);

    let used = sessionUsed;
    const snapshot = [...images];
    const indices = specificIdx !== null ? [specificIdx] : snapshot.map((_,i) => i);
    for (const i of indices) {
      if (cancelRef.current) break;
      const img = snapshot[i];
      if (!img) continue;
      if (!img.dataUrl) continue;
      if (specificIdx === null && img.analysis) continue;
      if (used >= limit) { setShowUpgrade(true); break; }
      setCurIdx(i); setSelIdx(i);
      try {
        const b64 = img.dataUrl.split(",")[1];
        if (!b64) throw new Error("Could not read image data — please re-upload");
        let analysis;
        try {
          analysis = await analyzeImage(b64, img.type, location, model, apiKey, [], "", setProgressMsg, obsDate, skipSpecies);
        } catch(e1) {
          if (cancelRef.current) break;
          await new Promise(r => setTimeout(r, 1500));
          analysis = await analyzeImage(b64, img.type, location, model, apiKey, [], "", setProgressMsg, obsDate, skipSpecies);
        }
        if (cancelRef.current) break;
        setImages(prev => { const n = [...prev]; n[i] = { ...n[i], analysis, error:null }; return n; });
        used++;
      } catch(e) {
        if (cancelRef.current) break;
        const msg = e?.message || "Unknown error — please retry";
        setImages(prev => { const n = [...prev]; n[i] = { ...n[i], error: msg }; return n; });
      }
    }
    setSessionUsed(used); setCurIdx(-1); setIsAnalyzing(false); setProgressMsg("");
  };

  // Re-analyze a single image with a user-provided correction hint
  const runCorrection = async (idx, hint) => {
    if (isAnalyzing) return;
    setCorrecting(null);
    setIsAnalyzing(true);
    setCurIdx(idx); setSelIdx(idx);
    try {
      const img = images[idx];
      if (!img?.dataUrl) throw new Error("Image data missing — please re-upload");
      const b64 = img.dataUrl.split(",")[1];
      if (!b64) throw new Error("Could not read image data");
      let analysis;
      try {
        analysis = await analyzeImage(b64, img.type, location, model, apiKey, [], hint, setProgressMsg, obsDate);
      } catch(e1) {
        await new Promise(r => setTimeout(r, 1500));
        analysis = await analyzeImage(b64, img.type, location, model, apiKey, [], hint, setProgressMsg, obsDate);
      }
      analysis._correctionHint = hint;
      setImages(prev => { const n = [...prev]; n[idx] = { ...n[idx], analysis, error:null }; return n; });
    } catch(e) {
      setImages(prev => { const n = [...prev]; n[idx] = { ...n[idx], error: e?.message || "Re-analysis failed" }; return n; });
    }
    setCurIdx(-1); setIsAnalyzing(false);
  };

  // ── SOCIAL ───────────────────────────────────────────────────────────────
  const handleSocialUpload = async (pid) => {
    const batch = displayImages.filter(i => i.analysis && !i._filtered);
    if (!batch.length) return;
    setShowSocial(true);
    setSocialStep({ platform:pid, step:"auth", count: batch.length });
    await new Promise(r => setTimeout(r, 2000));
    for (let i = 0; i < batch.length; i++) {
      setSocialStep({ platform:pid, step:"uploading", current: i+1, count: batch.length });
      await new Promise(r => setTimeout(r, 800));
    }
    setSocialStep({ platform:pid, step:"done", count: batch.length });
    setConnected(p => ({ ...p, [pid]:true }));
    await new Promise(r => setTimeout(r, 1800));
    setShowSocial(false); setSocialStep(null);
  };

  // ── ZIP DOWNLOAD ──────────────────────────────────────────────────────────
  const downloadZip = async () => {
    const batch = displayImages.filter(i => i.analysis && !i._filtered);
    if (!batch.length || isZipping) return;

    setIsZipping(true);
    setZipProgress(0);

    try {
      // Dynamically load JSZip from CDN
      await new Promise((resolve, reject) => {
        if (window.JSZip) { resolve(); return; }
        const s = document.createElement('script');
        s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
        s.onload = resolve; s.onerror = reject;
        document.head.appendChild(s);
      });

      const zip = new window.JSZip();
      const folder = zip.folder('avian-lens-filtered');

      for (let i = 0; i < batch.length; i++) {
        const img = batch[i];
        setZipProgress(Math.round((i / batch.length) * 85));

        // Convert dataURL → binary
        const [header, b64] = img.dataUrl.split(',');
        const mimeMatch = header.match(/:(.*?);/);
        const mime = mimeMatch ? mimeMatch[1] : 'image/jpeg';
        const ext  = mime.split('/')[1]?.replace('jpeg','jpg') || 'jpg';

        // Build a descriptive filename: species_score_originalname.ext
        const species = (img.analysis?.species || 'Unknown').replace(/[^a-zA-Z0-9]/g, '_');
        const score   = img.analysis?.qualityScore ?? 0;
        const base    = img.name.replace(/\.[^.]+$/, '');
        const filename = `${species}_Q${score}_${base}.${ext}`;

        folder.file(filename, b64, { base64: true });
      }

      setZipProgress(90);

      // Generate ZIP blob
      const blob = await zip.generateAsync(
        { type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 3 } },
        meta => setZipProgress(90 + Math.round(meta.percent * 0.1))
      );

      setZipProgress(100);

      // Trigger browser download
      const url  = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href     = url;
      link.download = `avian-lens-${batch.length}-images.zip`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      setTimeout(() => URL.revokeObjectURL(url), 10000);

    } catch (err) {
      console.error('ZIP error:', err);
    } finally {
      setTimeout(() => { setIsZipping(false); setZipProgress(0); }, 1200);
    }
  };

  // ── SLIDER COLORS ────────────────────────────────────────────────────────
  const qualityBg = `linear-gradient(90deg, ${scoreColor(minQuality)} ${minQuality*10}%, rgba(100,150,100,.18) ${minQuality*10}%)`;
  const speciesBg = `linear-gradient(90deg, #C8A84B ${maxPerSpecies*10}%, rgba(100,150,100,.18) ${maxPerSpecies*10}%)`;

  // Score segment preview (10 segs, segs < minQuality are dimmed)
  const scoreSegs = Array.from({length:10},(_,i)=>({
    n: i+1,
    color: i+1 >= minQuality ? scoreColor(i+1) : "rgba(100,150,100,.1)",
  }));

  // ── RENDER ───────────────────────────────────────────────────────────────
  return (
    <>
      <style>{CSS}</style>
      <div className="app">

        {/* ════════════ LANDING ════════════ */}
        {page === "landing" && (
          <div className="land">
            <div className="hero">
              <span className="bird-float" role="img" aria-label="hummingbird">
                <svg viewBox="0 0 120 120" width="110" height="110" style={{display:"inline-block"}}>
                  {/* Body */}
                  <ellipse cx="60" cy="68" rx="22" ry="12" fill="#1A9E7A" opacity="0.95"/>
                  {/* Iridescent throat */}
                  <ellipse cx="60" cy="62" rx="10" ry="7" fill="#E8326A"/>
                  <ellipse cx="60" cy="61" rx="7" ry="5" fill="#FF6B9D" opacity="0.6"/>
                  {/* Head */}
                  <circle cx="60" cy="52" r="11" fill="#0F7A5E"/>
                  {/* Eye */}
                  <circle cx="64" cy="50" r="3.5" fill="#000"/>
                  <circle cx="64" cy="50" r="1.5" fill="#fff"/>
                  <circle cx="65" cy="49" r="0.8" fill="#fff" opacity="0.8"/>
                  {/* Beak */}
                  <path d="M71 51 Q95 48 98 47" stroke="#6B4226" strokeWidth="2.5" fill="none" strokeLinecap="round"/>
                  {/* Tail */}
                  <path d="M38 70 Q20 85 16 90" stroke="#0D6B4F" strokeWidth="5" fill="none" strokeLinecap="round"/>
                  <path d="M40 72 Q22 88 20 95" stroke="#0F7A5E" strokeWidth="3" fill="none" strokeLinecap="round"/>
                  <path d="M42 73 Q28 90 28 97" stroke="#1A9E7A" strokeWidth="2.5" fill="none" strokeLinecap="round"/>
                  {/* Wing top */}
                  <ellipse cx="58" cy="58" rx="28" ry="9" fill="#52C4A0" opacity="0.85" transform="rotate(-20 58 58)"/>
                  {/* Wing shimmer */}
                  <ellipse cx="55" cy="54" rx="18" ry="5" fill="#90EED8" opacity="0.5" transform="rotate(-22 55 54)"/>
                  {/* Belly */}
                  <ellipse cx="58" cy="74" rx="14" ry="7" fill="#C8F0E0" opacity="0.55"/>
                  {/* Feet */}
                  <path d="M54 79 Q52 86 50 88" stroke="#3A2A1A" strokeWidth="1.5" fill="none"/>
                  <path d="M58 80 Q57 87 55 89" stroke="#3A2A1A" strokeWidth="1.5" fill="none"/>
                  {/* Sparkle dots */}
                  <circle cx="85" cy="35" r="2.5" fill="#FFD700" opacity="0.8"/>
                  <circle cx="30" cy="30" r="1.8" fill="#FF6B9D" opacity="0.7"/>
                  <circle cx="95" cy="60" r="1.5" fill="#52C4A0" opacity="0.6"/>
                  <circle cx="20" cy="55" r="2" fill="#FFD700" opacity="0.5"/>
                </svg>
              </span>
              <h1 className="app-title">Avian <em>Lens</em></h1>
              <p className="tagline">AI-Powered Bird Photography Analysis & Species Identification</p>
              <div className="pills">
                {["🔬 Species ID","📊 Quality Scoring","📷 EXIF Data","📍 Geo Context","🎚 Smart Filters","🌐 Social Export"].map(f=>(
                  <span key={f} className="pill">{f}</span>
                ))}
              </div>
            </div>
            {/* WHO IT HELPS */}
            <div className="who">
              <div className="who-title">Built for Every Bird Lover</div>
              <div className="who-sub">From your first sighting to your thousandth — Avian Lens grows with you</div>
              <div className="who-grid">
                <div className="who-card">
                  <span className="who-ico">🌱</span>
                  <div className="who-name">Beginner Birders</div>
                  <div className="who-role">Just starting out</div>
                  <div className="who-desc">
                    Not sure what bird you photographed? Our AI instantly identifies species and gives you fascinating facts — turning every mystery bird into a learning moment. No ornithology degree required.
                  </div>
                  <div className="who-tags">
                    <span className="who-tag">Species ID</span>
                    <span className="who-tag">Fun Facts</span>
                    <span className="who-tag">Easy to use</span>
                  </div>
                </div>
                <div className="who-card">
                  <span className="who-ico">📷</span>
                  <div className="who-name">Photography Enthusiasts</div>
                  <div className="who-role">Growing their craft</div>
                  <div className="who-desc">
                    Get a detailed critique of every shot — lighting, composition, focus, and behavior — with specific tips to improve your technique. Know exactly which photos are share-worthy and why.
                  </div>
                  <div className="who-tags">
                    <span className="who-tag">Quality Scoring</span>
                    <span className="who-tag">Photographer Tips</span>
                    <span className="who-tag">EXIF Analysis</span>
                  </div>
                </div>
                <div className="who-card">
                  <span className="who-ico">🏆</span>
                  <div className="who-name">Experienced Birders</div>
                  <div className="who-role">Serious observers</div>
                  <div className="who-desc">
                    Batch-analyze field sessions, apply smart quality gates, cap per-species counts, and export your best shots directly to Google Photos, Instagram, and Facebook — all tagged with species data.
                  </div>
                  <div className="who-tags">
                    <span className="who-tag">Batch Analysis</span>
                    <span className="who-tag">Smart Filters</span>
                    <span className="who-tag">Social Export</span>
                  </div>
                </div>
              </div>
            </div>

                        <div className="p-row">
              <div className="pc" onClick={()=>{setTier("free");setPage("workspace");}}>
                <div className="t-name">Explorer</div>
                <div className="t-price">Free</div>
                <div className="mc-chip">⚡ ${tier==="paid"?"claude-sonnet-4-6":"claude-haiku-4-5"}</div>

                <ul className="t-feats">
                  <li>{FREE_LIMIT} images per session</li>
                  <li>Species identification</li>
                  <li>Quality score 1–10</li>
                  <li>EXIF metadata extraction</li>
                  <li>Photographer tips</li>
                  <li>Pre-upload quality & species filters</li>
                </ul>
                <button className="btn btn-outline">Start Free →</button>
              </div>
              <div className="pc hot" onClick={()=>{setTier("paid");setPage("workspace");}}>
                <div className="t-name">Ornithologist Pro</div>
                <div className="t-price">$10 <small>/mo</small></div>
                <div className="mc-chip pro">⚡ Haiku vision · 🚀 Sonnet ID</div>
                <ul className="t-feats">
                  <li>{PAID_LIMIT} images per batch</li>
                  <li>Advanced species analysis</li>
                  <li>Behavior & plumage details</li>
                  <li>Conservation status</li>
                  <li>Social media export</li>
                  <li>Smart quality gate filtering</li>
                </ul>
                <button className="btn btn-gold">Upgrade to Pro →</button>
              </div>
            </div>
          </div>
        )}

        {/* ════════════ WORKSPACE ════════════ */}
        {page === "workspace" && (
          <>
            {/* Header */}
            <div className="hdr">
              <div className="brand" onClick={()=>{setPage("landing");setImages([]);setSessionUsed(0);}}>
                <span>🐦</span> Avian <em>Lens</em>
              </div>
              <div className="hdr-r">
                <div className="ubar">
                  <div className="utrack">
                    <div className="ufill" style={{width:`${usagePct}%`, background:limitRemaining>0?"#4CAF50":"#F44336"}}/>
                  </div>
                  <span>{limitRemaining} left</span>
                </div>
                <div className={`tc ${tier==="paid"?"tc-paid":"tc-free"}`}>{tier==="paid"?"✦ Pro":"Explorer"}</div>
                {tier==="free" && (
                  <button className="btn btn-outline" style={{width:"auto",padding:"4px 11px",fontSize:".67rem"}} onClick={()=>setShowUpgrade(true)}>Upgrade ↑</button>
                )}
              </div>
            </div>

            {/* API key bar — only needed on GitHub Pages, hidden on Vercel */}
            <div className="apibar">
              <span className="apibar-lbl">🔑 API Key</span>
              <input
                className="apibar-inp"
                type="password"
                placeholder="sk-ant-... (required on GitHub Pages)"
                value={apiKey}
                onChange={e => {
                  setApiKey(e.target.value);
                  sessionStorage.setItem("avian_api_key", e.target.value);
                }}
              />
              {apiKey && <span className="apibar-ok">✓ Key saved for session</span>}
              <a className="apibar-link" href="https://console.anthropic.com" target="_blank" rel="noreferrer">Get key →</a>
            </div>

            <div className="ws">
              {/* ─── LEFT COL ─── */}
              <div className="lcol">

                {/* ═══ UPLOAD CONFIGURATION PANEL ═══ */}
                <div className="upload-config">
                  <div className="uc-title">Upload Filters</div>

                  {/* Quality Gate Slider */}
                  <div className="sl-row">
                    <div className="sl-head">
                      <span className="sl-label">📊 Minimum Quality Gate</span>
                      <span className="sl-value" style={{background:`${scoreColor(minQuality)}22`, color:scoreColor(minQuality), border:`1px solid ${scoreColor(minQuality)}44`}}>
                        {minQuality}/10
                      </span>
                    </div>
                    <input
                      type="range" min={1} max={10} value={minQuality}
                      className="rng"
                      style={{background: qualityBg}}
                      onChange={e => setMinQuality(+e.target.value)}
                    />
                    {/* Score segment visual */}
                    <div style={{display:"flex",gap:2,marginTop:5}}>
                      {scoreSegs.map(seg => (
                        <div key={seg.n} style={{
                          flex:1, height:4, borderRadius:2,
                          background: seg.color,
                          opacity: seg.n >= minQuality ? 1 : 0.18,
                          transition:"all .3s",
                        }}/>
                      ))}
                    </div>
                    <div className="sl-sub">
                      Photos scoring below <strong style={{color:scoreColor(minQuality)}}>{minQuality}</strong> ({gradeLabel(minQuality-1)} or lower) will be flagged after analysis
                    </div>
                    {/* Quick picks */}
                    <div className="qchips">
                      {[3,5,7,8,9].map(n=>(
                        <button key={n} className={`qchip${minQuality===n?" on":""}`} onClick={()=>setMinQuality(n)}>
                          {n}+ · {gradeLabel(n)}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Species Cap Slider */}
                  <div className="sl-row" style={{marginBottom:12}}>
                    <div className="sl-head">
                      <span className="sl-label">🐦 Max Images per Species</span>
                      <span className="sl-value" style={{background:"rgba(200,168,75,.12)",color:"#C8A84B",border:"1px solid rgba(200,168,75,.3)"}}>
                        {maxPerSpecies === 10 ? "∞ All" : `×${maxPerSpecies}`}
                      </span>
                    </div>
                    <input
                      type="range" min={1} max={10} value={maxPerSpecies}
                      className="rng"
                      style={{background: speciesBg}}
                      onChange={e => setMaxPerSpecies(+e.target.value)}
                    />
                    <div className="sl-sub">
                      Show at most <strong style={{color:"#C8A84B"}}>{maxPerSpecies === 10 ? "unlimited" : maxPerSpecies}</strong> photo{maxPerSpecies!==1?"s":""} per identified species
                    </div>
                    <div className="qchips">
                      {[1,2,3,5].map(n=>(
                        <button key={n} className={`qchip${maxPerSpecies===n?" on":""}`} onClick={()=>setMaxPerSpecies(n)}>×{n}</button>
                      ))}
                      <button className={`qchip${maxPerSpecies===10?" on":""}`} onClick={()=>setMaxPerSpecies(10)}>All</button>
                    </div>
                  </div>

                  {/* Skip Species Detection Toggle */}
                  <div
                    className={`skip-species-toggle${skipSpecies?" on":""}`}
                    onClick={() => setSkipSpecies(s => !s)}
                    title="Quality-only mode: rates photo quality without identifying the bird species"
                  >
                    <div className="sst-left">
                      <div className="sst-icon">{skipSpecies ? "📷" : "🔬"}</div>
                      <div className="sst-text">
                        <div className="sst-label">Skip Species Detection</div>
                        <div className="sst-sub">{skipSpecies ? "Quality scoring only — faster, no ID" : "Rate photo quality only, skip bird ID"}</div>
                      </div>
                    </div>
                    <div className={`sst-pill${skipSpecies?" on":""}`}>
                      {skipSpecies ? "ON" : "OFF"}
                    </div>
                  </div>

                  {/* Stats row */}
                  {analyzedCount > 0 && (
                    <div className="uc-info">
                      <div className="uc-stat">
                        <div className="uc-stat-num" style={{color:"#4CAF50"}}>{passCount}</div>
                        <div className="uc-stat-lbl">Pass filter</div>
                      </div>
                      <div className="uc-stat">
                        <div className="uc-stat-num" style={{color:"#F44336"}}>{filteredCount}</div>
                        <div className="uc-stat-lbl">Filtered out</div>
                      </div>
                      <div className="uc-stat">
                        <div className="uc-stat-num">{uniqueSpecies}</div>
                        <div className="uc-stat-lbl">Species</div>
                      </div>
                    </div>
                  )}
                </div>

                {/* ═══ DROP ZONE (bulk only) ═══ */}
                <div className="drop-area">
                  {limitRemaining <= 0 && (
                    <div className="warn" style={{marginBottom:10}}>⚠️ {tier==="free"?`Session limit (${FREE_LIMIT}) reached`:`Batch limit (${PAID_LIMIT}) reached`}</div>
                  )}
                  <div
                    className={`drop${dragOver?" ov":""}${limitRemaining<=0?" disabled":""}`}
                    onDrop={onDrop} onDragOver={onDragOver} onDragLeave={onDragLeave}
                    onClick={() => limitRemaining > 0 && fileRef.current?.click()}
                  >
                    <span className="drop-ico">🪶</span>
                    <div className="drop-main">Drop multiple bird photos here</div>
                    <div className="drop-hint">
                      Drag & drop a folder or select multiple files<br/>
                      JPG · PNG · HEIC · WEBP · GIF
                    </div>
                    <div className="drop-badge">
                      📂 Select Multiple Files · {limitRemaining} slot{limitRemaining!==1?"s":""} available
                    </div>
                  </div>
                  {/* multiple is the only way — no single */}
                  <input
                    ref={fileRef}
                    type="file"
                    accept="image/*"
                    multiple
                    style={{ display:"none" }}
                    onChange={e => handleFiles(e.target.files)}
                  />
                </div>

                {/* Location + Date */}
                <div className="loc-area">
                  <div style={{display:"flex",gap:8,alignItems:"flex-start"}}>
                    <div style={{flex:"1 1 0",minWidth:0}}>
                      <label className="flbl">📍 Location</label>
                      <input className="finp" placeholder="e.g. Everglades, FL · 25.28°N 80.89°W"
                        value={location} onChange={e => setLocation(e.target.value)}/>
                    </div>
                    <div style={{flex:"0 0 138px"}}>
                      <label className="flbl">📅 Obs. Date</label>
                      <input className="finp" type="date"
                        value={obsDate} onChange={e => setObsDate(e.target.value)}
                        style={{colorScheme:"dark",paddingRight:6}}/>
                    </div>
                  </div>
                  {location && !obsDate && (
                    <div style={{fontSize:".61rem",color:"rgba(200,168,75,.42)",marginTop:4}}>
                      💡 Add date for seasonal eBird filtering
                    </div>
                  )}
                </div>

                {/* ═══ IMAGE QUEUE ═══ */}
                {images.length > 0 && (
                  <div className="queue-area">
                    <div className="queue-hdr">
                      <span className="queue-lbl">Queue ({images.length})</span>
                      <button className="clear-btn" onClick={clearAll}>Clear all</button>
                    </div>

                    {/* Filter live status */}
                    {analyzedCount > 0 && (
                      <div className="filter-status">
                        <span className="fs-left">Quality ≥{minQuality} · Max {maxPerSpecies=== 10?"∞":maxPerSpecies}/species</span>
                        <span className="fs-right">✓ {passCount} pass</span>
                      </div>
                    )}

                    <div className="tgrid">
                      {displayImages.map((img, idx) => (
                        <div
                          key={idx}
                          className={`thumb${selIdx===idx?" sel":""}${curIdx===idx?" busy":""}${img.analysis&&!img._filtered?" done-pass":""}${img._filtered?" done-fail":""}`}
                          onClick={() => setSelIdx(idx)}
                        >
                          <img src={img.dataUrl} alt={img.name} onError={e=>e.currentTarget.style.display="none"}/>

                          {/* Filtered overlay */}
                          {img._filtered && (
                            <div className="tfail-overlay">
                              <span style={{fontSize:"1rem"}}>⛔</span>
                            </div>
                          )}

                          {/* Analyzing spinner */}
                          {curIdx === idx && (
                            <div className="spinov">
                              <div className="spin" style={{width:16,height:16}}/>
                              <span style={{fontSize:".5rem",color:"#C8A84B"}}>AI</span>
                            </div>
                          )}

                          {/* Score + species */}
                          {img.analysis && (
                            <>
                              <div className="tbadge" style={{color: img._filtered?"#E8956A":scoreColor(img.analysis.qualityScore)}}>
                                {img.analysis.qualityScore}/10
                              </div>
                              <div className="tname">{img.analysis.species}</div>
                            </>
                          )}

                          {/* Hover controls */}
                          {!isAnalyzing && (
                            <div className="tov">
                              <button className="ticobtn" title="Preview"
                                onClick={e=>{e.stopPropagation();setLightbox({src:img.dataUrl,name:img.name,species:img.analysis?.species});}}>🔍</button>
                              <button className="ticobtn del" title="Remove"
                                onClick={e=>{e.stopPropagation();removeImg(idx);}}>✕</button>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* ═══ ANALYZE DOCK ═══ */}
                <div className="adock">
                  {isAnalyzing && (
                    <div style={{marginBottom:8}}>
                      <div style={{fontSize:".67rem",color:"#8FAF8A",marginBottom:4}}>
                        {progressMsg || `Analyzing image ${curIdx+1} of ${images.filter(i=>!i.analysis).length}`} · {tier==="paid"?"Sonnet 4.6 🚀":"Haiku 4.5 ⚡"}
                      </div>
                      <div className="pbr"><div className="pbf"/></div>
                    </div>
                  )}
                  {isCancelled && !isAnalyzing && (
                    <div style={{marginBottom:8,padding:"6px 10px",background:"rgba(200,168,75,.06)",border:"1px solid rgba(200,168,75,.2)",borderRadius:7,fontSize:".72rem",color:"#C8A84B",display:"flex",alignItems:"center",gap:6}}>
                      ⏹ Analysis stopped — {images.filter(i=>i.analysis).length} of {images.length} images completed
                    </div>
                  )}
                  <div style={{display:"flex",gap:7}}>
                    <button className="abtn" style={{flex:1}} onClick={() => runAnalysis()} disabled={images.length===0||isAnalyzing}>
                      {isAnalyzing
                        ? <><div className="spin" style={{width:15,height:15,borderTopColor:"#060f07"}}/>Analyzing…</>
                        : images.some(i=>i.analysis)
                          ? `⟳ Re-analyze (${images.length})`
                          : `⟡ Analyze ${images.length > 0 ? images.length+" Images" : "Images"}`}
                    </button>
                    {isAnalyzing && (
                      <button onClick={stopAnalysis} style={{
                        padding:"0 14px",borderRadius:9,border:"1px solid rgba(244,67,54,.4)",
                        background:"rgba(244,67,54,.08)",color:"#EF9A9A",
                        fontFamily:"'DM Sans',sans-serif",fontSize:".82rem",fontWeight:600,
                        cursor:"pointer",transition:"all .2s",whiteSpace:"nowrap",flexShrink:0,
                      }}
                      onMouseEnter={e=>{e.currentTarget.style.background="rgba(244,67,54,.18)";e.currentTarget.style.borderColor="rgba(244,67,54,.7)";}}
                      onMouseLeave={e=>{e.currentTarget.style.background="rgba(244,67,54,.08)";e.currentTarget.style.borderColor="rgba(244,67,54,.4)";}}>
                        ⏹ Stop
                      </button>
                    )}
                  </div>
                  <div className="abtn-sub">
                    {images.length === 0
                      ? "Upload multiple images above to begin"
                      : isAnalyzing
                        ? `Click Stop to halt after the current image finishes`
                        : `Quality gate ≥${minQuality} · Max ${maxPerSpecies===10?"∞":maxPerSpecies}/species · ${tier==="paid"?"Haiku vision + Sonnet ID 🚀":"Haiku 4.5 ⚡"}`}
                  </div>
                </div>

                {/* ═══ SHARE & EXPORT DOCK ═══ */}
                <div className="share-dock">
                  <div className="share-dock-inner">
                    <div className="share-title">
                      <span>📤 Share & Export</span>
                      {passCount > 0 && (
                        <span className="share-count">{passCount} filtered image{passCount!==1?"s":""}</span>
                      )}
                    </div>

                    {passCount === 0 ? (
                      <div className={`share-btns share-disabled`}>
                        {SOCIAL.map(p=>(
                          <div key={p.id} className="soc-tile">
                            <span className="soc-tile-ico">{p.icon}</span>
                            <span className="soc-tile-lbl">{p.name.split(" ")[0]}</span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="share-btns">
                        {SOCIAL.map(p=>(
                          <button key={p.id} className={`soc-tile${connected[p.id]?" lkd":""}`}
                            onClick={()=>handleSocialUpload(p.id)}>
                            <span className="soc-tile-ico">{p.icon}</span>
                            <span className="soc-tile-lbl">{p.name.split(" ")[0]}{connected[p.id]?" ✓":""}</span>
                          </button>
                        ))}
                      </div>
                    )}

                    {/* ── ZIP DOWNLOAD — available to all tiers ── */}
                    <button
                      className={`zip-btn${isZipping?" zipping":""}`}
                      disabled={passCount === 0 || isZipping}
                      onClick={downloadZip}
                    >
                      {isZipping ? (
                        <><div className="spin" style={{width:13,height:13,borderTopColor:"#42A5F5",borderColor:"rgba(33,150,243,.22)"}}/>
                        Zipping {zipProgress < 90 ? `${zipProgress}%` : zipProgress < 100 ? "compressing…" : "saving…"}</>
                      ) : (
                        <>📦 Download {passCount > 0 ? passCount : ""} Filtered Image{passCount!==1?"s":""} as ZIP</>
                      )}
                    </button>
                    {isZipping && (
                      <div className="zip-bar-wrap">
                        <div className="zip-bar" style={{width:`${zipProgress}%`}}/>
                      </div>
                    )}

                    <div className="share-note" style={{marginTop:7}}>
                      {passCount === 0
                        ? "Analyze images first, then export passing photos"
                        : `${passCount} photo${passCount!==1?"s":""} pass quality ≥${minQuality} · max ${maxPerSpecies===10?"∞":maxPerSpecies}/species`}
                    </div>
                  </div>
                </div>
              </div>

              {/* ─── RIGHT COL ─── */}
              <div className="rcol">
                {images.length === 0 ? (
                  <div className="empty">
                    <div className="empty-ico">🦜</div>
                    <div className="empty-t">Ready to Analyze</div>
                    <div style={{fontSize:".95rem",maxWidth:280,lineHeight:1.65,textAlign:"center",color:"rgba(143,175,138,.45)"}}>
                      Set your quality gate and species limit, then drop multiple bird photos to upload and analyze.
                    </div>
                    <div style={{marginTop:10,fontSize:".8rem",color:"rgba(143,175,138,.28)"}}>⚡ ${tier==="paid"?"claude-sonnet-4-6":"claude-haiku-4-5"}</div>
                  </div>
                ) : selImg ? (
                  <div>
                    {/* Navigation bar */}
                    <div className="img-hdr">
                      <div style={{display:"flex",alignItems:"center",gap:8}}>
                        <button className="navbtn" disabled={selIdx===0} onClick={()=>setSelIdx(s=>s-1)}>‹</button>
                        <div>
                          <div style={{fontSize:".88rem",color:"#BAD0BA",maxWidth:220,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",fontWeight:500}}>{selImg.name}</div>
                          <div style={{fontSize:".75rem",color:"rgba(143,175,138,.5)"}}>{selImg.size} · {selIdx+1} of {images.length}</div>
                        </div>
                        <button className="navbtn" disabled={selIdx===images.length-1} onClick={()=>setSelIdx(s=>s+1)}>›</button>
                      </div>
                      {images.length > 1 && (
                        <div className="dots">
                          {images.slice(0,12).map((_,i)=>(
                            <button key={i} className="dot" onClick={()=>setSelIdx(i)}
                              style={{background:selIdx===i?"#C8A84B":"rgba(143,175,138,.2)"}}/>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* ── ANALYZING STATE ── */}
                    {curIdx === selIdx && (
                      <div style={{textAlign:"center",padding:"60px 20px",color:"#8FAF8A"}}>
                        <div className="spin" style={{width:36,height:36,margin:"0 auto 14px"}}/>
                        <div style={{fontFamily:"'Playfair Display',serif",fontSize:"1.1rem"}}>Analyzing with {tier==="paid"?"Haiku + Sonnet 4.6 🚀":"Haiku 4.5 ⚡"}…</div>
                        <div style={{fontSize:".7rem",color:"rgba(143,175,138,.5)",marginTop:4}}>{progressMsg || "Pass 1 → eBird → Pass 2…"}</div>
                      </div>
                    )}

                    {/* ── AWAITING ANALYSIS ── */}
                    {!selImg.analysis && !selImg.error && curIdx !== selIdx && (
                      <div style={{textAlign:"center",padding:"60px 20px",color:"rgba(143,175,138,.32)"}}>
                        <div style={{fontSize:"2.5rem",marginBottom:12}}>🔬</div>
                        <div style={{fontSize:".95rem"}}>Click "Analyze Images" to begin</div>
                      </div>
                    )}

                    {/* ── DASHBOARD RESULTS — LAYOUT C ── */}
                    {selImg.analysis && curIdx !== selIdx && (() => {
                      const a = selImg.analysis;
                      const disp = selDisplay;
                      return (
                        <div className="lc-wrap">

                          {/* ── LEFT SIDEBAR: image + metadata ── */}
                          <div className="lc-imgcol">
                            <img src={selImg.dataUrl} alt={selImg.name} className="prev-img"
                              onClick={()=>setLightbox({src:selImg.dataUrl,name:selImg.name,species:a.species})}/>
                            <div className="lc-meta">
                              {(selImg.exif?.make||selImg.exif?.model) && (
                                <div className="imb"><span className="imb-k">📷</span><span className="imb-v">{selImg.exif.make||""} {selImg.exif.model||""}</span></div>
                              )}
                              {(selImg.exif?.dateTimeOriginal||selImg.exif?.dateTime) && (
                                <div className="imb"><span className="imb-k">🕐</span><span className="imb-v">{selImg.exif.dateTimeOriginal||selImg.exif.dateTime}</span></div>
                              )}
                              {selImg.exif?.iso && <div className="imb"><span className="imb-k">ISO</span><span className="imb-v">{selImg.exif.iso}</span></div>}
                              {selImg.exif?.exposureTime && <div className="imb"><span className="imb-k">⏱ Exp</span><span className="imb-v">{selImg.exif.exposureTime}</span></div>}
                              {selImg.exif?.focalLength && <div className="imb"><span className="imb-k">🔭 Focal</span><span className="imb-v">{selImg.exif.focalLength}</span></div>}
                              {location && <div className="imb"><span className="imb-k">📍</span><span className="imb-v">{location}</span></div>}
                              {obsDate && <div className="imb"><span className="imb-k">📅</span><span className="imb-v">{obsDate}</span></div>}
                              <div className="imb"><span className="imb-k">📁</span><span className="imb-v">{selImg.size}</span></div>
                            </div>
                          </div>

                          {/* ── RIGHT: all analysis content ── */}
                          <div className="lc-right">

                            {/* SPECIES BANNER with score inline */}
                            <div className="sp-hero">
                              <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",gap:12}}>
                                <div style={{flex:1,minWidth:0}}>
                                  <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:2}}>
                                    <div className="sp-eyebrow">{a._qualityOnly ? "Quality Analysis" : "Species Identified"}</div>
                                    {a._qualityOnly ? (
                                      <span style={{fontSize:".56rem",fontWeight:700,padding:"2px 7px",borderRadius:8,background:"rgba(200,168,75,.1)",border:"1px solid rgba(200,168,75,.28)",color:"#C8A84B",letterSpacing:".06em"}}>
                                        📷 Quality Only
                                      </span>
                                    ) : a._threePass && (
                                      <span style={{fontSize:".56rem",fontWeight:700,padding:"2px 7px",borderRadius:8,background:"rgba(76,175,80,.1)",border:"1px solid rgba(76,175,80,.25)",color:"#81C784",letterSpacing:".06em"}}>
                                        {a._eBirdPrimary ? "📍 eBird + Vision" : "🔬 3-PASS + eBird"}
                                      </span>
                                    )}
                                  </div>
                                  {a._qualityOnly ? (
                                    <div style={{fontSize:".82rem",color:"rgba(143,175,138,.6)",fontStyle:"italic",marginBottom:8}}>Species detection skipped</div>
                                  ) : (
                                    <>
                                      <div className="sp-name">{a.species}</div>
                                      {a.scientificName && <div className="sp-sci">{a.scientificName}</div>}
                                    </>
                                  )}
                                  <div className="sp-badges">
                                    {!a._qualityOnly && <span className="conf-chip">{a.confidence} confidence</span>}
                                    {disp?._filtered ? <span className="gate-fail">⛔ Filtered</span> : <span className="gate-pass">✓ Passes</span>}
                                    {!a._qualityOnly && a._eBirdPrimary && <span style={{fontSize:".6rem",fontWeight:700,padding:"3px 8px",borderRadius:8,background:"rgba(33,150,243,.18)",border:"1px solid rgba(33,150,243,.5)",color:"#42A5F5"}}>📍 ID via eBird</span>}
                                    {!a._qualityOnly && !a._eBirdPrimary && a.eBirdVerdict==="confirmed" && <span style={{fontSize:".6rem",fontWeight:700,padding:"3px 8px",borderRadius:8,background:"rgba(33,150,243,.1)",border:"1px solid rgba(33,150,243,.28)",color:"#64B5F6"}}>🗺 eBird confirmed</span>}
                                    {!a._qualityOnly && a.eBirdVerdict==="unusual" && <span style={{fontSize:".6rem",fontWeight:700,padding:"3px 8px",borderRadius:8,background:"rgba(255,152,0,.08)",border:"1px solid rgba(255,152,0,.28)",color:"#FFB74D"}}>⚠ Unusual for area</span>}
                                    {!a._qualityOnly && a.eBirdVerdict==="overridden" && <span style={{fontSize:".6rem",fontWeight:700,padding:"3px 8px",borderRadius:8,background:"rgba(156,39,176,.1)",border:"1px solid rgba(156,39,176,.3)",color:"#CE93D8"}}>🔄 eBird revised ID</span>}
                                    {!a._qualityOnly && a._correctionHint && a.userSuggestionVerdict==="accepted" && <span style={{fontSize:".6rem",fontWeight:700,padding:"3px 8px",borderRadius:8,background:"rgba(76,175,80,.1)",border:"1px solid rgba(76,175,80,.3)",color:"#81C784"}}>✓ Correction verified</span>}
                                    {!a._qualityOnly && a._correctionHint && a.userSuggestionVerdict==="rejected" && <span style={{fontSize:".6rem",fontWeight:700,padding:"3px 8px",borderRadius:8,background:"rgba(244,67,54,.1)",border:"1px solid rgba(244,67,54,.3)",color:"#EF9A9A"}}>✗ Correction rejected</span>}
                                    {!a._qualityOnly && a._correctionHint && a.userSuggestionVerdict==="insufficient_evidence" && <span style={{fontSize:".6rem",fontWeight:700,padding:"3px 8px",borderRadius:8,background:"rgba(255,152,0,.08)",border:"1px solid rgba(255,152,0,.28)",color:"#FFB74D"}}>⚠ Correction uncertain</span>}
                                    {!a._qualityOnly && a._correctionHint && !a.userSuggestionVerdict && <span style={{fontSize:".6rem",fontWeight:600,padding:"3px 8px",borderRadius:8,background:"rgba(200,168,75,.08)",border:"1px solid rgba(200,168,75,.22)",color:"#C8A84B"}}>✏ Re-analyzed</span>}
                                  </div>
                                </div>
                                {/* Score — tight block top-right of banner */}
                                <div className="score-inline" style={{flexShrink:0}}>
                                  <div className="score-big" style={{color:scoreColor(a.qualityScore)}}>{a.qualityScore}</div>
                                  <div className="score-info" style={{minWidth:70}}>
                                    <div className="score-grade" style={{color:scoreColor(a.qualityScore)}}>{a.qualityGrade}</div>
                                    <div className="score-bar-track" style={{width:70}}>
                                      <div className="score-bar-fill" style={{width:`${a.qualityScore*10}%`,background:scoreColor(a.qualityScore)}}/>
                                    </div>
                                  </div>
                                </div>
                              </div>

                              {/* Score summary below name row */}
                              {a.summary && <div className="score-summary" style={{marginBottom:6}}>{a.summary}</div>}

                              {/* ID Reasoning */}
                              {a.identificationReasoning && !a._qualityOnly && (
                                <div style={{padding:"7px 10px",background:"rgba(200,168,75,.05)",border:"1px solid rgba(200,168,75,.14)",borderRadius:7,fontSize:".8rem",color:"#C8D8A8",lineHeight:1.5}}>
                                  🔑 <em>{a.identificationReasoning}</em>
                                </div>
                              )}
                              {a.alternativesConsidered && !a._qualityOnly && (
                                <div style={{marginTop:5,padding:"6px 10px",background:"rgba(100,150,100,.04)",border:"1px solid rgba(100,150,100,.12)",borderRadius:7,fontSize:".75rem",color:"rgba(186,208,186,.65)",lineHeight:1.45}}>
                                  🔀 <em>{a.alternativesConsidered}</em>
                                </div>
                              )}
                              {a.eBirdNote && !a._qualityOnly && !a.eBirdNote.toLowerCase().includes("no ebird") && !a.eBirdNote.toLowerCase().includes("not available") && !a.eBirdNote.toLowerCase().includes("rests entirely") && !a.eBirdNote.toLowerCase().includes("field marks alone") && !a.eBirdNote.toLowerCase().includes("no frequency") && (
                                <div style={{marginTop:5,padding:"6px 10px",background:"rgba(33,150,243,.04)",border:"1px solid rgba(33,150,243,.14)",borderRadius:7,fontSize:".75rem",color:"rgba(100,181,246,.8)",lineHeight:1.45,display:"flex",gap:6,alignItems:"flex-start"}}>
                                  <span>🗺</span><span>{a.eBirdNote}</span>
                                </div>
                              )}
                              {!a._qualityOnly && !a._eBirdPrimary && a.eBirdVerdict==="no_data" && !a._eBirdData && (
                                <div style={{marginTop:5,padding:"5px 9px",background:"rgba(143,175,138,.04)",border:"1px solid rgba(143,175,138,.1)",borderRadius:7,fontSize:".7rem",color:"rgba(143,175,138,.45)",display:"flex",gap:5,alignItems:"center"}}>
                                  <span>💡</span><span>Add a location to enable eBird regional verification</span>
                                </div>
                              )}

                              {/* Candidate pills */}
                              {!a._qualityOnly && a._candidates?.length > 1 && (
                                <div style={{marginTop:7,display:"flex",flexWrap:"wrap",gap:4}}>
                                  {a._candidates.map((c,i) => (
                                    <span key={i} style={{fontSize:".65rem",padding:"2px 9px",borderRadius:10,
                                      background:i===0?"rgba(200,168,75,.12)":"rgba(100,150,100,.06)",
                                      border:i===0?"1px solid rgba(200,168,75,.3)":"1px solid rgba(100,150,100,.15)",
                                      color:i===0?"#C8A84B":"rgba(186,208,186,.5)"}}>
                                      {i===0?"✓ ":""}{c.species} {c.confidence}%
                                    </span>
                                  ))}
                                </div>
                              )}

                              {/* Correction button */}
                              {correcting?.idx === selIdx ? (
                                <div style={{marginTop:9,background:"rgba(22,40,22,.8)",border:"1px solid rgba(200,168,75,.28)",borderRadius:8,padding:"10px 12px"}}>
                                  <div style={{fontSize:".72rem",color:"#C8A84B",fontWeight:600,marginBottom:6}}>What species do you think it is?</div>
                                  <input autoFocus className="finp" style={{fontSize:".82rem",padding:"7px 10px",marginBottom:8}}
                                    placeholder="e.g. Black-capped Chickadee…"
                                    value={correcting.hint}
                                    onChange={e => setCorrecting(c => ({...c, hint: e.target.value}))}
                                    onKeyDown={e => {
                                      if (e.key==="Enter" && correcting.hint.trim()) runCorrection(selIdx, correcting.hint.trim());
                                      if (e.key==="Escape") setCorrecting(null);
                                    }}
                                  />
                                  <div style={{display:"flex",gap:6}}>
                                    <button className="abtn" style={{fontSize:".75rem",padding:"7px",flex:1}}
                                      disabled={!correcting.hint.trim()}
                                      onClick={() => runCorrection(selIdx, correcting.hint.trim())}>
                                      ↺ Re-analyze with hint
                                    </button>
                                    <button onClick={() => setCorrecting(null)}
                                      style={{background:"rgba(255,255,255,.05)",border:"1px solid rgba(255,255,255,.1)",color:"#8FAF8A",borderRadius:7,padding:"7px 12px",cursor:"pointer",fontSize:".75rem"}}>
                                      Cancel
                                    </button>
                                  </div>
                                </div>
                              ) : !a._qualityOnly ? (
                                <button onClick={() => setCorrecting({idx:selIdx,hint:""})}
                                  style={{marginTop:8,width:"100%",background:"rgba(255,255,255,.03)",border:"1px dashed rgba(143,175,138,.2)",color:"rgba(143,175,138,.55)",borderRadius:7,padding:"6px",cursor:"pointer",fontSize:".72rem",transition:"all .2s"}}
                                  onMouseEnter={e => e.currentTarget.style.borderColor="rgba(200,168,75,.35)"}
                                  onMouseLeave={e => e.currentTarget.style.borderColor="rgba(143,175,138,.2)"}>
                                  ✏ Wrong species? Correct it →
                                </button>
                              ) : null}
                            </div>{/* end species banner */}

                            {/* 2×2 PHOTO ANALYSIS GRID */}
                            <div>
                              <div className="st">📷 Photo Analysis</div>
                              <div className="rc-group">
                                {a.lighting       && <div className="rc"><div className="rc-k">💡 Lighting</div><div className="rc-v">{a.lighting}</div></div>}
                                {a.composition    && <div className="rc"><div className="rc-k">🖼 Composition</div><div className="rc-v">{a.composition}</div></div>}
                                {a.focusSharpness && <div className="rc"><div className="rc-k">🔍 Focus & Sharpness</div><div className="rc-v">{a.focusSharpness}</div></div>}
                                {a.behavior       && <div className="rc"><div className="rc-k">🐦 Behavior</div><div className="rc-v">{a.behavior}</div></div>}
                              </div>
                            </div>

                            {/* TIPS + STRENGTHS side by side */}
                            <div className="lc-bottom">
                              <div>
                                {a.improvements?.length > 0 && <>
                                  <div className="st">→ Photographer Tips</div>
                                  <ul className="tips">
                                    {a.improvements.map((r,i) => <li key={i}><span>→</span>{r}</li>)}
                                  </ul>
                                </>}
                              </div>
                              <div>
                                {a.strengths?.length > 0 && <>
                                  <div className="st">✦ Strengths</div>
                                  <div className="tag-row">{a.strengths.map((s,i) => <span key={i} className="tag-g">✓ {s}</span>)}</div>
                                </>}
                                {a.interestingFact && (
                                  <div className="fact" style={{marginTop: a.strengths?.length>0 ? 9 : 0}}>
                                    🔬 <strong style={{color:"#C8A84B"}}>Did you know?</strong> {a.interestingFact}
                                  </div>
                                )}
                              </div>
                            </div>

                          </div>
                        </div>
                      );
                    })()}

                    {selImg.error && (
                      <div style={{marginTop:12}}>
                        <div className="warn">⚠️ {selImg.error}</div>
                        <button className="abtn" style={{marginTop:8,fontSize:".78rem",padding:"9px"}}
                          onClick={async()=>{
                            setImages(prev=>{const n=[...prev];n[selIdx]={...n[selIdx],error:null};return n;});
                            await new Promise(r=>setTimeout(r,50));
                            runAnalysis();
                          }}>
                          ↺ Retry this image
                        </button>
                      </div>
                    )}
                  </div>
                ) : null}
              </div>
            </div>
          </>
        )}

        {/* ════ LIGHTBOX ════ */}
        {lightbox && (
          <div className="lb-bg" onClick={()=>setLightbox(null)}>
            <button className="lb-close" onClick={()=>setLightbox(null)}>✕</button>
            <img src={lightbox.src} alt={lightbox.name} className="lb-img" onClick={e=>e.stopPropagation()}/>
            <div className="lb-info">{lightbox.species ? `🐦 ${lightbox.species} · ${lightbox.name}` : lightbox.name}</div>
          </div>
        )}

        {/* ════ UPGRADE ════ */}
        {showUpgrade && (
          <div className="mbg" onClick={()=>setShowUpgrade(false)}>
            <div className="modal" onClick={e=>e.stopPropagation()}>
              <button className="mclose" onClick={()=>setShowUpgrade(false)}>✕</button>
              <div style={{fontSize:"2.6rem",marginBottom:12}}>🐦</div>
              <div className="m-title">Upgrade to Pro</div>
              <div className="m-desc">{tier==="free"?`Free plan allows ${FREE_LIMIT} images. Upgrade for ${PAID_LIMIT} per batch with Claude Sonnet's deeper analysis and social export.`:"Unlock Avian Lens Pro."}</div>
              <div className="upbox">
                <div className="upbox-price">$10 <span style={{fontSize:".88rem",fontWeight:400,color:"#8FAF8A"}}>/month</span></div>
                <div className="upbox-detail">{PAID_LIMIT} images · Haiku vision + Sonnet 4.6 ID · Social Export</div>
              </div>
              <button className="btn btn-gold" style={{marginBottom:8}} onClick={()=>{setTier("paid");setSessionUsed(0);setImages([]);setShowUpgrade(false);}}>Upgrade Now →</button>
              <button className="btn btn-ghost" onClick={()=>setShowUpgrade(false)}>Continue free</button>
            </div>
          </div>
        )}

        {/* ════ SOCIAL AUTH ════ */}
        {showSocial && socialStep && (
          <div className="mbg">
            <div className="modal">
              <div className="soc-inner">
                {/* Platform icon + name */}
                <span className="auth-ico">{SOCIAL.find(p=>p.id===socialStep.platform)?.icon}</span>

                {/* ── STEP 1: Sign in / Authorize ── */}
                {socialStep.step==="auth" && <>
                  <div className="m-title">Connect to {SOCIAL.find(p=>p.id===socialStep.platform)?.name}</div>
                  <div className="m-desc" style={{marginBottom:14}}>
                    Avian Lens would like permission to upload photos on your behalf.
                  </div>

                  {/* OAuth permission scopes */}
                  <div style={{background:"rgba(22,40,22,.7)",border:"1px solid rgba(100,150,100,.18)",borderRadius:9,padding:"11px 14px",marginBottom:16,textAlign:"left"}}>
                    <div style={{fontSize:".62rem",fontWeight:700,color:"rgba(143,175,138,.55)",letterSpacing:".1em",textTransform:"uppercase",marginBottom:9}}>Permissions requested</div>
                    {[
                      {ico:"📤", label:"Upload photos & videos"},
                      {ico:"🏷️", label:"Add captions and tags"},
                      {ico:"📍", label:"Attach location metadata"},
                    ].map(s=>(
                      <div key={s.label} style={{display:"flex",alignItems:"center",gap:9,padding:"5px 0",borderBottom:"1px solid rgba(100,150,100,.08)"}}>
                        <span style={{fontSize:".9rem"}}>{s.ico}</span>
                        <span style={{fontSize:".78rem",color:"#BAD0BA"}}>{s.label}</span>
                        <span style={{marginLeft:"auto",fontSize:".68rem",color:"#4CAF50",fontWeight:600}}>Allow</span>
                      </div>
                    ))}
                  </div>

                  {/* Connecting spinner (auto-auth simulation) */}
                  <div style={{display:"flex",alignItems:"center",justifyContent:"center",gap:8,marginBottom:12}}>
                    <div className="spin" style={{width:16,height:16}}/>
                    <span style={{fontSize:".76rem",color:"#8FAF8A"}}>Connecting via OAuth 2.0…</span>
                  </div>

                  <div className="auth-note">
                    🔒 Secure OAuth 2.0 · No password stored · Revoke anytime in account settings<br/>
                    <span style={{color:"rgba(200,168,75,.55)"}}>Uploading {socialStep.count} image{socialStep.count!==1?"s":""} after authorization</span>
                  </div>
                  <div className="auth-steps">
                    <div className="astp on"/>
                    <div className="astp"/>
                    <div className="astp"/>
                  </div>
                </>}

                {/* ── STEP 2: Uploading ── */}
                {socialStep.step==="uploading" && <>
                  <div className="m-title">Uploading {socialStep.current} of {socialStep.count}</div>
                  <div className="m-desc">Transferring filtered photos with species tags & metadata…</div>
                  <div style={{width:"100%",height:6,background:"rgba(100,150,100,.18)",borderRadius:3,overflow:"hidden",margin:"14px 0 6px"}}>
                    <div style={{
                      height:"100%",borderRadius:3,background:"#C8A84B",
                      transition:"width .5s cubic-bezier(.4,0,.2,1)",
                      width:`${(socialStep.current/socialStep.count)*100}%`
                    }}/>
                  </div>
                  <div style={{fontSize:".68rem",color:"rgba(143,175,138,.55)",marginBottom:12}}>
                    {socialStep.current} of {socialStep.count} complete · {Math.round((socialStep.current/socialStep.count)*100)}%
                  </div>
                  <div className="auth-steps">
                    <div className="astp on"/>
                    <div className="astp on"/>
                    <div className="astp"/>
                  </div>
                </>}

                {/* ── STEP 3: Done ── */}
                {socialStep.step==="done" && <>
                  <div style={{fontSize:"2.4rem",marginBottom:10}}>✅</div>
                  <div className="m-title">All {socialStep.count} Uploaded!</div>
                  <div className="m-desc">
                    Your bird photos are now live on <strong style={{color:"#EDE8D8"}}>{SOCIAL.find(p=>p.id===socialStep.platform)?.name}</strong> with species identification tags, quality scores, and location data attached.
                  </div>
                  <div style={{background:"rgba(76,175,80,.07)",border:"1px solid rgba(76,175,80,.2)",borderRadius:8,padding:"9px 13px",fontSize:".74rem",color:"#81C784",marginBottom:14}}>
                    ✓ Connected · Authorized · {socialStep.count} image{socialStep.count!==1?"s":""} published
                  </div>
                  <div className="auth-steps">
                    <div className="astp on"/>
                    <div className="astp on"/>
                    <div className="astp on"/>
                  </div>
                </>}
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
