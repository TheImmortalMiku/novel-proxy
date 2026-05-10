const express = require("express");
const puppeteer = require("puppeteer");

const app = express();
const PORT = process.env.PORT || 3000;

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

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
        "--disable-blink-features=AutomationControlled",
      ],
    });
  }
  return browser;
}

const NOISE_SELECTORS = [
  "script", "style", "nav", "header", "footer", "aside",
  "[class*=comment]", "[class*=sidebar]", "[class*=ad]",
  "[id*=ad]", "[class*=menu]", "[class*=widget]",
  ".chapter-nav", ".navigation", "[class*=related]",
  ".rate-bar", ".report", ".chapter-warning",
];

const CONTENT_SELECTORS = [
  "#chapter-container",
  "#chapter-body",
  ".chapter-body",
  "#chr-content",
  ".chr-content",
  ".chapter-content",
  ".reading-content",
  ".entry-content",
  ".post-content",
  "#chapter-content",
  ".text-left",
  "article .content",
  "article",
  "main .content",
  "#content",
  ".prose",
  "main",
];

const TITLE_SELECTORS = [
  ".chapter-title", "#chapter-title", "h1.entry-title",
  ".entry-title", "h1.post-title", ".post-title", "h1", "h2",
];

async function fetchPage(url) {
  const b = await getBrowser();
  const page = await b.newPage();

  try {
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    });

    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );
    await page.setExtraHTTPHeaders({
      "Accept-Language": "en-US,en;q=0.9",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    });

    // Use networkidle0 to wait for ALL requests to finish (catches lazy-loaded content)
    await page.goto(url, { waitUntil: "networkidle0", timeout: 45000 });

    // Wait up to 15s for #chapter-container to have real text
    try {
      await page.waitForFunction(
        () => {
          const el = document.querySelector("#chapter-container");
          return el && (el.innerText || el.textContent || "").trim().length > 200;
        },
        { timeout: 15000 }
      );
    } catch (_) {
      // If #chapter-container never fills, try waiting for any content selector
      try {
        await page.waitForFunction(
          (sels) => sels.some((s) => {
            const el = document.querySelector(s);
            return el && (el.innerText || el.textContent || "").trim().length > 200;
          }),
          { timeout: 10000 },
          CONTENT_SELECTORS
        );
      } catch (_) {}
    }

    // Extra buffer for slow JS rendering
    await new Promise((r) => setTimeout(r, 3000));

    const result = await page.evaluate(
      ({ noiseSels, titleSels, contentSels }) => {
        // Snapshot all selectors and their text lengths BEFORE removing noise
        const selectorReport = contentSels.map(s => {
          const el = document.querySelector(s);
          const txt = el ? (el.innerText || el.textContent || "").trim() : "";
          return { sel: s, len: txt.length, preview: txt.slice(0, 100) };
        });

        noiseSels.forEach((sel) => {
          document.querySelectorAll(sel).forEach((el) => el.remove());
        });

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

        let content = "";
        let matchedSel = "";
        for (const sel of contentSels) {
          const el = document.querySelector(sel);
          const txt = el ? (el.innerText || el.textContent || "").trim() : "";
          if (txt.length > 200) { content = txt; matchedSel = sel; break; }
        }
        if (!content) {
          content = (document.body?.innerText || "").trim();
          matchedSel = "body";
        }

        content = content
          .replace(/\r\n/g, "\n")
          .replace(/\n{3,}/g, "\n\n")
          .replace(/[ \t]{2,}/g, " ")
          .trim();

        return {
          title: chapterTitle,
          content,
          matchedSel,
          bodyLength: document.body?.innerText?.length,
          selectorReport,
        };
      },
      { noiseSels: NOISE_SELECTORS, titleSels: TITLE_SELECTORS, contentSels: CONTENT_SELECTORS }
    );

    return result;
  } finally {
    await page.close().catch(() => {});
  }
}

app.get("/fetch", async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: "Missing ?url= parameter" });
  try {
    const result = await fetchPage(url);
    if (!result.content || result.content.length <= 200) {
      return res.status(422).json({
        error: "No content found on page",
        debug: { matchedSel: result.matchedSel, bodyLength: result.bodyLength, selectorReport: result.selectorReport }
      });
    }
    res.json({ title: result.title, content: result.content });
  } catch (err) {
    console.error("Fetch error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/debug", async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: "Missing ?url= parameter" });
  try {
    const result = await fetchPage(url);
    res.json({
      matchedSel: result.matchedSel,
      bodyLength: result.bodyLength,
      title: result.title,
      contentLength: result.content?.length,
      contentPreview: result.content?.slice(0, 500),
      selectorReport: result.selectorReport,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/", (req, res) => res.json({ status: "ok", message: "Novel proxy running v3" }));

app.listen(PORT, () => console.log(`Novel proxy listening on port ${PORT}`));
