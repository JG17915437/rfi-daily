/**
 * fetch-and-summarize.mjs  v4 — 2026-07-27
 */
import fs from "node:fs/promises";
import Anthropic from "@anthropic-ai/sdk";

const TRANSCRIPT_PDF_URL = (guid) =>
  `https://francaisfacile.rfi.fr/fr/transcription/editions/${guid}/pdf`;

const AUDIO_URL_BY_DATE = (date) => {
  const ym = date.slice(0, 7).replace("-", "");
  const ymd = date.replace(/-/g, "");
  return `https://aod-fle.akamaized.net/rfi/francais/audio/jff/${ym}/journal_francais_facile_16h00_-_16h10_gmt_${ymd}.mp3?dl=1`;
};

const OUTPUT_PATH = new URL("../docs/data/today.json", import.meta.url);

const FETCH_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8",
};

async function getLatestEpisodeFromRSS() {
  const candidates = [
    "https://www.rfi.fr/rss/fr/podcasts/journal-fran%C3%A7ais-facile",
    "https://www.rfi.fr/fr/podcasts/journal-fran%C3%A7ais-facile/rss",
    "https://francaisfacile.rfi.fr/fr/podcasts/journal-en-fran%C3%A7ais-facile/rss",
  ];
  for (const url of candidates) {
    try {
      const res = await fetch(url, { headers: FETCH_HEADERS, redirect: "follow" });
      console.log(`   → ${url} → HTTP ${res.status}`);
      if (!res.ok) continue;
      const xml = await res.text();
      if (!xml.includes("<item") && !xml.includes("<entry")) continue;
      const episode = parseRSSFirstItem(xml);
      if (episode && episode.guid) {
        console.log(`   → RSS 成功！guid: ${episode.guid}`);
        return episode;
      }
    } catch (e) {
      console.log(`   → ${url} 失敗: ${e.message}`);
    }
  }
  return null;
}

function parseRSSFirstItem(xml) {
  const itemMatch = xml.match(/<item[\s>]([\s\S]*?)<\/item>/i);
  if (!itemMatch) return null;
  const item = itemMatch[1];
  const title = (item.match(/<title[^>]*>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/is) || [])[1]?.trim();
  const guid = (item.match(/<guid[^>]*>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/guid>/is) || [])[1]?.trim();
  const enclosureUrl = (item.match(/enclosure[^>]*url="([^"]+)"/i) || [])[1];
  const link = (item.match(/<link[^>]*>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/link>/is) || [])[1]?.trim();
  if (!guid) return null;
  const uuidMatch = guid.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return { title, guid: uuidMatch ? uuidMatch[0] : guid, audioUrl: enclosureUrl || null, link };
}

function extractTextFromPDF(buf) {
  const raw = Buffer.from(buf).toString("latin1");
  const chunks = [];
  for (const m of raw.matchAll(/\(([^\)]{2,})\)\s*Tj/g)) {
    const s = m[1].replace(/\\n/g, "\n").replace(/\\\(/g, "(").replace(/\\\)/g, ")");
    if (/[a-zA-ZÀ-ÿ]{3,}/.test(s)) chunks.push(s);
  }
  const joined = chunks.join(" ").replace(/\s+/g, " ").trim();
  if (joined.length > 200) return joined;
  const utf = Buffer.from(buf).toString("utf-8");
  return utf.length > 200 ? utf : null;
}

async function getTranscriptFromPDF(guid) {
  const url = TRANSCRIPT_PDF_URL(guid);
  console.log(`   → PDF: ${url}`);
  const res = await fetch(url, { headers: FETCH_HEADERS, redirect: "follow" });
  console.log(`   → HTTP ${res.status}, Content-Type: ${res.headers.get("content-type")}`);
  if (!res.ok) throw new Error(`PDF API HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  console.log(`   → ${buf.byteLength} bytes`);
  const text = extractTextFromPDF(buf);
  if (!text || text.length < 200) throw new Error("PDF 文字萃取失敗或內容太短");
  return text;
}

async function summarizeWithClaude(transcript, episodeTitle) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const prompt = `你會收到一份法文新聞節目「Journal en français facile」的逐字稿全文。
節目標題：${episodeTitle || "Journal en français facile"}

請完成以下任務：
1. 找出這一集裡的獨立新聞條目（通常 4 到 6 則，忽略開場白、片頭標題預告、結尾語）。
2. 針對每一則新聞，用法文寫一段約 60 個單字（不超過 70 字）的摘要，內容須為改寫，不可整段照抄原文語句。
3. 每段法文摘要附上對應的繁體中文翻譯。
4. 從該則新聞中挑出 4-6 個對學習者有幫助的法文詞彙或片語，附上繁體中文意思。
5. 幫每則新聞下一個簡短的繁體中文標題（10 字以內）。

請「只」輸出以下 JSON 格式（不要有任何額外文字、不要用 markdown code fence）：
{"items":[{"title_zh":"...","fr":"...","zh":"...","vocab":"詞彙1（翻譯）／詞彙2（翻譯）"}]}

逐字稿全文如下：
---
${transcript.slice(0, 12000)}
---`;

  const msg = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 4000,
    messages: [{ role: "user", content: prompt }],
  });
  const text = msg.content.filter(b => b.type === "text").map(b => b.text).join("\n").trim();
  const cleaned = text.replace(/^```json\s*/i, "").replace(/```$/, "").trim();
  return JSON.parse(cleaned);
}

async function main() {
  const today = new Date().toISOString().slice(0, 10);
  console.log(`\n===== RFI 每日更新 v4 — ${today} =====`);

  console.log("\n① 從 RSS 取得最新集資訊...");
  const episode = await getLatestEpisodeFromRSS();
  const guid = episode?.guid || null;
  const audioUrl = episode?.audioUrl || AUDIO_URL_BY_DATE(today);
  const episodeTitle = episode?.title || `Journal en français facile ${today}`;
  const sourceUrl = episode?.link || "https://francaisfacile.rfi.fr/fr/podcasts/journal-en-fran%C3%A7ais-facile/";

  console.log(`   → guid: ${guid}`);
  console.log(`   → 音檔: ${audioUrl}`);

  if (!guid) throw new Error("RSS 沒有取得有效 guid，請確認 RSS 網址是否正確");

  console.log("\n② 取得逐字稿 PDF...");
  const transcript = await getTranscriptFromPDF(guid);
  console.log(`   → 逐字稿長度: ${transcript.length} 字元`);

  console.log("\n③ 呼叫 Claude API...");
  const { items } = await summarizeWithClaude(transcript, episodeTitle);
  console.log(`   → 產出 ${items.length} 則`);

  const output = {
    date: today,
    source_url: sourceUrl,
    audio_url: audioUrl,
    page_title: episodeTitle,
    items: items.map(item => ({ ...item, time: null })),
    generated_at: new Date().toISOString(),
  };

  await fs.writeFile(OUTPUT_PATH, JSON.stringify(output, null, 2), "utf-8");
  console.log("\n④ 已寫入 docs/data/today.json ✓");
}

main().catch(err => { console.error("\n執行失敗：", err.message); process.exit(1); });
