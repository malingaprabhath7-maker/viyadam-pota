// Reads a bill photo on the phone itself (no upload) with Tesseract.js, then pulls out the total,
// the date and the shop name. parseReceipt() is pure and unit-tested in tests/receipt.test.js.

const TESSERACT_URL = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js";

const TOTAL_WORDS = [
  [/\b(grand\s*total|net\s*total|net\s*amount|total\s*payable|amount\s*payable|bill\s*total|total\s*amount|total\s*due|amount\s*due|balance\s*due|to\s*pay)\b/i, 3],
  [/\b(total|tota1|t0tal|ttl|nett?)\b/i, 2],
  [/\b(amount|amt|payable)\b/i, 1],
];
const SKIP_WORDS = /\b(sub\s*-?\s*total|cash|change|tendered|tender|paid|discount|saving|savings|you\s*saved|vat|tax|ssc[l]?|nbt|service\s*charge|qty|quantity|items?\s*count|no\.?\s*of\s*items|points|card\s*no|tel|phone|invoice\s*no|bill\s*no)\b/i;

const MONEY_RE = /(?:rs\.?|lkr|රු\.?)?\s*(\d{1,3}(?:[,\s]\d{3})+|\d+)(?:[.,](\d{2}))?(?!\d)/gi;

/** Every money-looking number in a line, as numbers */
function amountsIn(line) {
  const out = [];
  for (const m of line.matchAll(MONEY_RE)) {
    const whole = m[1].replace(/[,\s]/g, "");
    if (whole.length > 8) continue;              // phone numbers, card numbers, barcodes
    const v = parseFloat(whole + (m[2] ? "." + m[2] : ""));
    if (v > 0 && v < 10_000_000) out.push({ v, decimals: !!m[2] });
  }
  return out;
}

const pad = (n) => String(n).padStart(2, "0");

function findDate(text, today) {
  const cands = [];
  for (const m of text.matchAll(/\b(\d{4})[./-](\d{1,2})[./-](\d{1,2})\b/g)) cands.push([+m[1], +m[2], +m[3]]);
  for (const m of text.matchAll(/\b(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})\b/g)) {
    let y = +m[3]; if (y < 100) y += 2000;
    let d = +m[1], mo = +m[2];
    if (mo > 12 && d <= 12) [d, mo] = [mo, d];   // US style month/day
    cands.push([y, mo, d]);
  }
  for (const [y, mo, d] of cands) {
    if (mo < 1 || mo > 12 || d < 1 || d > 31) continue;
    const dt = new Date(y, mo - 1, d);
    if (dt.getMonth() !== mo - 1) continue;
    if (dt > today || today - dt > 400 * 864e5) continue;
    return `${y}-${pad(mo)}-${pad(d)}`;
  }
  return null;
}

const CATEGORY_HINTS = [
  [/pharmac|osu|hospital|medical|clinic|channel|lab(?:oratory)?|healthguard|asiri|nawaloka|durdans|lanka hospital/i, "health"],
  [/fuel|filling|petrol|diesel|ceypetco|lanka\s*ioc|lioc|sinopec|pickme|uber|taxi|bus|railway|transport|parking/i, "transport"],
  [/dialog|mobitel|slt|hutch|airtel|electricity|ceb|leco|water\s*board|nwsdb|internet|broadband|insurance/i, "bills"],
  [/restaurant|hotel|cafe|caf[eé]|bakery|bakers|kfc|mcdonald|pizza|burger|kottu|food\s*court|tea|juice|dine|kitchen|curry|rice/i, "food"],
  [/book|stationer|sarasavi|vijitha|godage|tuition|school|university|institute|exam/i, "edu"],
  [/cinema|scope|film|movie|game|park|zoo|entertainment|club/i, "fun"],
  [/keells|cargills|food\s*city|arpico|glomark|laugfs|spar|supermarket|super\s*market|mart|store|stores|fashion|textile|nolimit|odel|cool\s*planet|hardware|traders/i, "shop"],
];

/**
 * @param {string} text OCR output
 * @param {Date} today
 * @returns {{ amount: number|null, date: string|null, merchant: string, category: string|null, confidence: "high"|"low"|"none" }}
 */
export function parseReceipt(text, today = new Date()) {
  const lines = String(text || "").split(/\r?\n/).map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);

  let best = null;
  lines.forEach((line, i) => {
    if (SKIP_WORDS.test(line)) return;
    for (const [re, score] of TOTAL_WORDS) {
      if (!re.test(line)) continue;
      // amount on the same line, or on the next line when the label stands alone
      let nums = amountsIn(line.replace(re, " "));
      if (!nums.length && lines[i + 1] && !SKIP_WORDS.test(lines[i + 1])) nums = amountsIn(lines[i + 1]);
      if (!nums.length) return;
      const v = Math.max(...nums.map((n) => n.v));
      const s = score * 10 + (nums.some((n) => n.decimals) ? 2 : 0) + i / lines.length; // later lines win ties
      if (!best || s > best.s) best = { v, s };
      return;
    }
  });

  let amount = best ? best.v : null;
  let confidence = best ? "high" : "none";
  if (amount === null) {
    // fall back to the largest amount written with cents in the lower half of the bill
    const lower = lines.slice(Math.floor(lines.length / 3)).filter((l) => !SKIP_WORDS.test(l));
    const nums = lower.flatMap(amountsIn).filter((n) => n.decimals);
    if (nums.length) { amount = Math.max(...nums.map((n) => n.v)); confidence = "low"; }
  }

  const merchant = (lines.find((l) => /[a-z]{3,}/i.test(l) && !/receipt|invoice|tax|tel|phone|welcome|www\.|@|\d{5,}/i.test(l)) || "")
    .replace(/[^\p{L}\p{N}&'. -]/gu, "").trim().slice(0, 40);

  // the shop name and header say what kind of place it is; item names further down would mislead
  const head = lines.slice(0, 4).join(" ");
  const category = (CATEGORY_HINTS.find(([re]) => re.test(head)) || [])[1] || null;

  return { amount, date: findDate(text, today), merchant, category, confidence };
}

/** Shrink and grey the photo before OCR: faster and usually more accurate on phones */
async function prepare(file) {
  const img = await createImageBitmap(file);
  const scale = Math.min(1, 1800 / Math.max(img.width, img.height));
  const cv = Object.assign(document.createElement("canvas"), { width: Math.round(img.width * scale), height: Math.round(img.height * scale) });
  const ctx = cv.getContext("2d");
  ctx.filter = "grayscale(1) contrast(1.35)";
  ctx.drawImage(img, 0, 0, cv.width, cv.height);
  return cv;
}

let loading = null;
function loadTesseract() {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  if (!loading) loading = new Promise((resolve, reject) => {
    const s = Object.assign(document.createElement("script"), { src: TESSERACT_URL, async: true });
    s.onload = () => resolve(window.Tesseract);
    s.onerror = () => { loading = null; reject(new Error("load")); };
    document.head.append(s);
  });
  return loading;
}

/** OCR a photo. onProgress receives 0..1. Returns { text, ...parseReceipt(text) } */
export async function scanReceipt(file, onProgress = () => {}) {
  const T = await loadTesseract();
  const canvas = await prepare(file);
  const worker = await T.createWorker("eng", 1, {
    logger: (m) => { if (m.status === "recognizing text") onProgress(m.progress); },
  });
  try {
    const { data } = await worker.recognize(canvas);
    return { text: data.text, ...parseReceipt(data.text) };
  } finally {
    worker.terminate();
  }
}
