const express = require("express");
const puppeteer = require("puppeteer");

const app = express();
const PORT = process.env.PORT || 3000;

// Allow your Firebase app to call this server
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// Reuse a single browser instance for speed
let browser = null;
async function getBrowser() {
  if (!browser || !browser.connected) {
    browser = await puppeteer.launch({
      headless: "new",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--no-first-run",
        "--no-zygote",
        "--single-process",
      ],
    });
  }
  return browser;
}

// ── CONTENT SELECTORS (ordered by specificity) ────────────────────────────
const CONTENT_SELECTORS = [
  ".chapter-content",
  ".entry-content",
  ".post-content",
  "#chapter-content",
  ".text-left",
  "[class*=chapter]",
  "article",
  "main .content",
  ".reading-content",
  "#content",
  ".prose",
  "main",
];

const TITLE_SELECTORS = [
  ".chapter-title",
  "#chapter-title",
  "h1.entry-title",
  ".entry-title",
  "h1.post-title",
  ".post-title",
  "h1",
  "h2",
];

const NOISE_SELECTORS = [
  "script", "style", "nav", "header", "footer", "aside",
  "[class*=comment]", "[class*=sidebar]", "[class*=ad]",
  "[id*=ad]", "[class*=menu]", "[class*=widget]",
  ".chapter-nav", ".navigation", "[class*=related]",
];

// ── MAIN FETCH ENDPOINT ───────────────────────────────────────────────────
// GET /fetch?url=https://novelfire.net/book/.../chapter-5
app.get("/fetch", async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: "Missing ?url= parameter" });

  let page = null;
  try {
    const b = await getBrowser();
    page = await b.newPage();

    // Look like a real browser
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );
    await page.setExtraHTTPHeaders({
      "Accept-Language": "en-US,en;q=0.9",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    });

    // Navigate and wait for the page to settle
    await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });

    // Wait a beat for any JS-rendered content
    await new Promise((r) => setTimeout(r, 1500));

    // Extract title + content inside the page context
    const result = await page.evaluate(
      ({ noiseSels, titleSels, contentSels }) => {
        // Remove noise
        noiseSels.forEach((sel) => {
          document.querySelectorAll(sel).forEach((el) => el.remove());
        });

        // Extract title
        let chapterTitle = null;
        for (const sel of titleSels) {
          const el = document.querySelector(sel);
          const txt = el ? (el.innerText || el.textContent || "").trim() : "";
          if (txt && txt.length > 2 && txt.length < 200) {
            const cleaned = txt.replace(/\s*[-|]\s*\S+\.\S+\s*$/, "").trim();
            if (!/^\d+$/.test(cleaned) && !/^chapter\s*\d+$/i.test(cleaned)) {
              chapterTitle = cleaned || txt;
            }
            break;
          }
        }

        // Extract content
        let content = "";
        for (const sel of contentSels) {
          const el = document.querySelector(sel);
          const txt = el ? (el.innerText || el.textContent || "").trim() : "";
          if (txt.length > 200) {
            content = txt;
            break;
          }
        }
        if (!content) {
          content = (document.body?.innerText || "").trim();
        }

        // Clean up whitespace
        content = content
          .replace(/\r\n/g, "\n")
          .replace(/\n{3,}/g, "\n\n")
          .replace(/[ \t]{2,}/g, " ")
          .trim();

        return { title: chapterTitle, content };
      },
      {
        noiseSels: NOISE_SELECTORS,
        titleSels: TITLE_SELECTORS,
        contentSels: CONTENT_SELECTORS,
      }
    );

    if (!result.content || result.content.length <= 200) {
      return res.status(422).json({ error: "No content found on page" });
    }

    res.json({ title: result.title, content: result.content });
  } catch (err) {
    console.error("Fetch error:", err.message);
    res.status(500).json({ error: err.message });
  } finally {
    if (page) await page.close().catch(() => {});
  }
});

// Health check
app.get("/", (req, res) => res.json({ status: "ok", message: "Novel proxy running" }));

app.listen(PORT, () => console.log(`Novel proxy listening on port ${PORT}`));
