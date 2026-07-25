/**
 * fetch-and-summarize.mjs
 * ------------------------------------------------------------
 * 每天由 GitHub Actions 自動執行：
 *  1. 直接抓取 francaisfacile.rfi.fr 的節目列表頁網址
 *     （這個網址本身就會直接顯示「最新一集」的完整內容——
 *      已用兩天的實際頁面原始碼驗證過，不需要另外找「最新一集連結」）
 *  2. 取得逐字稿、音檔網址、以及 RFI 官方提供的「章節時間軸」（每個主題的精準開始秒數）
 *  3. 呼叫 Claude API，依照官方章節切分，把每個主題改寫成 60 字內摘要 + 繁中翻譯 + 關鍵詞彙
 *  4. 輸出成 docs/data/today.json，給前端網頁讀取顯示
 *
 * 這一版的 selector 是根據實際下載的兩份頁面原始碼寫的
 * （2026-07-22 與 2026-07-23 兩集，結構一致），相對可靠。
 * ------------------------------------------------------------
 */

import * as cheerio from "cheerio";
import fs from "node:fs/promises";
import Anthropic from "@anthropic-ai/sdk";

const PODCAST_LIST_URL =
  "https://francaisfacile.rfi.fr/fr/podcasts/journal-en-fran%C3%A7ais-facile/";

const OUTPUT_PATH = new URL("../docs/data/today.json", import.meta.url);

// ------------------------------------------------------------
// 1+2. 抓取「節目列表頁」（＝目前最新一集），取出逐字稿、音檔網址、章節時間軸
// ------------------------------------------------------------
async function getEpisodeData() {
  const res = await fetch(PODCAST_LIST_URL, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; RFI-daily-bot/1.0)" },
  });
  if (!res.ok) throw new Error(`無法讀取節目頁面：HTTP ${res.status}`);
  const html = await res.text();
  const $ = cheerio.load(html);

  // --- 這一集真正的網址（供記錄用）：從 canonical 連結拿 ---
  const episodeUrl =
    $('link[rel="canonical"]').attr("href") || PODCAST_LIST_URL;

  // --- 逐字稿：每一段新聞是一個 <p>，位於 .m-transcription .m-box-expand__content ---
  const transcript = $(".m-transcription .m-box-expand__content p")
    .map((_, el) => $(el).text().replace(/\s+/g, " ").trim())
    .get()
    .filter(Boolean)
    .join("\n\n");

  if (!transcript || transcript.length < 200) {
    throw new Error(
      "抓到的逐字稿內容太短或是空的，請檢查 .m-transcription .m-box-expand__content 這個 selector 是否還適用，" +
        "或確認節目列表頁是否還是直接顯示最新一集內容（RFI 有可能改版）。"
    );
  }

  // --- 頁面標題 ---
  const pageTitle = $("h1.a-page-title").first().text().trim() || "Journal en français facile";

  // --- 音檔網址：從 JSON-LD 區塊拿（比較穩定，不受版面調整影響）---
  let audioUrl = null;
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const data = JSON.parse($(el).contents().text());
      if (data && data.audio && data.audio.contentUrl) {
        audioUrl = data.audio.contentUrl;
      }
    } catch {
      // 忽略無法解析的區塊
    }
  });
  if (!audioUrl) {
    // 備援：直接找 <audio>/<source> 標籤
    audioUrl =
      $("audio source").attr("src") ||
      $("audio").attr("src") ||
      null;
  }

  // --- 官方章節時間軸：每個 .a-chapter 裡有 v-bind:init-time=秒數 + 標題文字 ---
  const chapters = [];
  $(".m-chapters .a-chapter").each((_, el) => {
    const raw = $.html(el);
    const timeMatch = raw.match(/v-bind:init-time=(\d+)/);
    const label = $(el).find(".a-chapter__label").text().replace(/\s+/g, " ").trim();
    if (timeMatch && label) {
      chapters.push({ time: parseInt(timeMatch[1], 10), label });
    }
  });

  // 第一個章節通常是「Les titres」(開場提要)，不是獨立新聞，跳過它
  const newsChapters = chapters.length > 1 ? chapters.slice(1) : chapters;

  if (newsChapters.length === 0) {
    throw new Error(
      "找不到章節時間軸，請檢查 .m-chapters .a-chapter 這個 selector 是否還適用；" +
        "如果 RFI 改版拿掉了章節功能，需要改回用逐字稿字數比例估算時間點。"
    );
  }

  return { episodeUrl, transcript, audioUrl, pageTitle, newsChapters };
}

// ------------------------------------------------------------
// 3. 呼叫 Claude API：依照官方章節切分做摘要 + 翻譯
// ------------------------------------------------------------
async function summarizeWithClaude(transcript, newsChapters) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const chapterList = newsChapters
    .map((c, i) => `${i + 1}. ${c.label}`)
    .join("\n");

  const prompt = `你會收到一份法文新聞節目「Journal en français facile」的逐字稿全文，
以及 RFI 官方提供的章節標題列表（依照節目播出順序排列，每個標題對應一則獨立新聞）。

官方章節標題（依序）：
${chapterList}

請針對「每一個」上述章節標題，依序完成：
1. 用法文寫一段約 60 個單字（不超過 70 字）的摘要，內容須為改寫，不可整段照抄原文語句。
2. 附上對應的繁體中文翻譯。
3. 從該則新聞中挑出 4-6 個對學習者有幫助的法文詞彙或片語，附上繁體中文意思。
4. 幫這則新聞下一個簡短的繁體中文標題（10 字以內）。

輸出順序必須跟上面章節標題列表的順序完全一致，數量也要完全一致（共 ${newsChapters.length} 則）。

請「只」輸出以下 JSON 格式（不要有任何額外文字、不要用 markdown code fence）：

{
  "items": [
    {
      "title_zh": "...",
      "fr": "...",
      "zh": "...",
      "vocab": "詞彙1（翻譯）／詞彙2（翻譯）／..."
    }
  ]
}

逐字稿全文如下：
---
${transcript}
---`;

  const msg = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 4000,
    messages: [{ role: "user", content: prompt }],
  });

  const text = msg.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

  const cleaned = text.replace(/^```json\s*/i, "").replace(/```$/, "").trim();
  const parsed = JSON.parse(cleaned);

  if (!parsed.items || parsed.items.length !== newsChapters.length) {
    throw new Error(
      `Claude 回傳的則數（${parsed.items?.length}）跟官方章節數（${newsChapters.length}）不一致，請檢查 prompt 或重試。`
    );
  }

  return parsed.items;
}

// ------------------------------------------------------------
// 主流程
// ------------------------------------------------------------
async function main() {
  console.log("① 抓取節目頁面（＝最新一集）...");
  const { episodeUrl, transcript, audioUrl, pageTitle, newsChapters } = await getEpisodeData();
  console.log("   → 這一集的網址：", episodeUrl);
  console.log(`   → 逐字稿長度：${transcript.length} 字元`);
  console.log(`   → 音檔：${audioUrl}`);
  console.log(`   → 找到 ${newsChapters.length} 個新聞章節：`);
  newsChapters.forEach((c) => console.log(`      ${c.time}s - ${c.label}`));

  console.log("② 呼叫 Claude API 摘要 + 翻譯...");
  const items = await summarizeWithClaude(transcript, newsChapters);

  // 把官方章節的精準時間點（time）合併進每一則摘要，前端可以直接用來跳轉播放
  const itemsWithTime = items.map((item, i) => ({
    ...item,
    time: newsChapters[i].time,
  }));

  const today = new Date().toISOString().slice(0, 10);
  const output = {
    date: today,
    source_url: episodeUrl,
    audio_url: audioUrl,
    page_title: pageTitle,
    items: itemsWithTime,
    generated_at: new Date().toISOString(),
  };

  await fs.writeFile(OUTPUT_PATH, JSON.stringify(output, null, 2), "utf-8");
  console.log("③ 已寫入 docs/data/today.json");
}

main().catch((err) => {
  console.error("執行失敗：", err.message);
  process.exit(1);
});
