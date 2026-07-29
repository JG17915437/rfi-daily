/**
 * fetch-and-summarize.mjs  v5b — 2026-07-28
 */
import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = path.join(__dirname, "../docs/data/today.json");
const TMP_DIR = path.join(__dirname, "../tmp");
const TMP_AUDIO = path.join(TMP_DIR, "audio.mp3");

const AUDIO_URL_BY_DATE = (date) => {
  const ym = date.slice(0, 7).replace("-", "");
  const ymd = date.replace(/-/g, "");
  return `https://aod-fle.akamaized.net/rfi/francais/audio/jff/${ym}/journal_francais_facile_16h00_-_16h10_gmt_${ymd}.mp3?dl=1`;
};

const FETCH_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  Accept: "*/*",
  "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8",
};

async function getLatestEpisodeFromRSS() {
  const candidates = [
    "https://www.rfi.fr/fr/podcasts/journal-fran%C3%A7ais-facile/rss",
    "https://francaisfacile.rfi.fr/fr/podcasts/journal-en-fran%C3%A7ais-facile/rss",
  ];
  for (const url of candidates) {
    try {
      const res = await fetch(url, { headers: FETCH_HEADERS, redirect: "follow" });
      console.log(`   → ${url} → HTTP ${res.status}`);
      if (!res.ok) continue;
      const xml = await res.text();
      if (!xml.includes("<item")) continue;
      const episode = parseRSSFirstItem(xml);
      if (episode) { console.log(`   → RSS 成功！`); return episode; }
    } catch (e) { console.log(`   → 失敗: ${e.message}`); }
  }
  return null;
}

function parseRSSFirstItem(xml) {
  const itemMatch = xml.match(/<item[\s>]([\s\S]*?)<\/item>/i);
  if (!itemMatch) return null;
  const item = itemMatch[1];
  const title = (item.match(/<title[^>]*>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/is) || [])[1]?.trim();
  const enclosureUrl = (item.match(/enclosure[^>]*url="([^"]+)"/i) || [])[1];
  const link = (item.match(/<link[^>]*>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/link>/is) || [])[1]?.trim();
  if (!enclosureUrl) return null;
  return { title, audioUrl: enclosureUrl, link };
}

async function downloadAudio(audioUrl, destPath) {
  console.log(`   → 下載: ${audioUrl}`);
  const res = await fetch(audioUrl, { headers: FETCH_HEADERS, redirect: "follow" });
  console.log(`   → HTTP ${res.status}`);
  if (!res.ok) throw new Error(`音檔下載失敗 HTTP ${res.status}`);
  await pipeline(res.body, createWriteStream(destPath));
  const stat = await fs.stat(destPath);
  console.log(`   → ${(stat.size/1024/1024).toFixed(1)} MB 已下載`);
}

async function transcribeWithLocalWhisper(audioPath, outputDir) {
  console.log(`   → 執行 Whisper（small 模型，法文）...`);
  const cmd = `whisper "${audioPath}" --model small --language fr --output_format txt --output_dir "${outputDir}"`;
  execSync(cmd, { stdio: "inherit", timeout: 20 * 60 * 1000 });
  const txtPath = path.join(outputDir, "audio.txt");
  const transcript = await fs.readFile(txtPath, "utf-8");
  console.log(`   → 轉錄完成：${transcript.length} 字元`);
  return transcript.trim();
}

async function summarizeWithClaude(transcript, episodeTitle) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const prompt = `你會收到一份法文新聞節目「Journal en français facile」的逐字稿全文。
節目標題：${episodeTitle || "Journal en français facile"}

請完成：
1. 找出 4-6 則獨立新聞（忽略開場白與結尾）。
2. 每則用法文寫約 60 字摘要（改寫，不照抄）。
3. 每則附繁體中文翻譯。
4. 每則挑 4-6 個法文詞彙附繁中意思。
5. 每則下 10 字以內繁體中文標題。

只輸出 JSON，不要任何其他文字：
{"items":[{"title_zh":"...","fr":"...","zh":"...","vocab":"詞1（譯）／詞2（譯）"}]}

逐字稿：
---
${transcript.slice(0, 12000)}
---`;

  const msg = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 4000,
    messages: [{ role: "user", content: prompt }],
  });
  const text = msg.content.filter(b => b.type === "text").map(b => b.text).join("\n").trim();
  return JSON.parse(text.replace(/^```json\s*/i, "").replace(/```$/, "").trim());
}

async function main() {
  const today = new Date().toISOString().slice(0, 10);
  console.log(`\n===== RFI 每日更新 v5b — ${today} =====`);

  await fs.mkdir(TMP_DIR, { recursive: true });

  console.log("\n① RSS 取得音檔網址...");
  const episode = await getLatestEpisodeFromRSS();
  const audioUrl = episode?.audioUrl || AUDIO_URL_BY_DATE(today);
  const episodeTitle = episode?.title || `Journal en français facile ${today}`;
  const sourceUrl = episode?.link || "https://francaisfacile.rfi.fr/fr/podcasts/journal-en-fran%C3%A7ais-facile/";
  console.log(`   → 音檔: ${audioUrl}`);

  console.log("\n② 下載音檔...");
  await downloadAudio(audioUrl, TMP_AUDIO);

  console.log("\n③ Whisper 語音轉文字...");
  const transcript = await transcribeWithLocalWhisper(TMP_AUDIO, TMP_DIR);
  await fs.rm(TMP_DIR, { recursive: true, force: true }).catch(() => {});

  if (!transcript || transcript.length < 100)
    throw new Error("Whisper 轉錄結果太短，請確認音檔正常");

  console.log("\n④ Claude API 摘要...");
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

  await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await fs.writeFile(OUTPUT_PATH, JSON.stringify(output, null, 2), "utf-8");
  console.log("\n⑤ 已寫入 docs/data/today.json ✓");
}

main().catch(err => { console.error("\n執行失敗：", err.message); process.exit(1); });
