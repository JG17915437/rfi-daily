# RFI 每日法語新聞學習工具（最小可行骨架）

自動每天抓取 RFI「Journal en français facile」最新一集，把新聞改寫成 60 字內的
法文摘要 + 繁體中文翻譯，並提供瀏覽器朗讀功能（Web Speech API）練習聽力與發音。

## 專案結構

```
rfi-daily/
├── scripts/
│   ├── fetch-and-summarize.mjs   ← 抓取 + 呼叫 Claude API 摘要，核心邏輯
│   └── package.json
├── .github/workflows/
│   └── daily-update.yml          ← 每天定時自動執行、更新內容
├── docs/
│   ├── index.html                ← 前端頁面（GitHub Pages 會直接發布這個資料夾）
│   └── data/today.json           ← 每天被自動覆蓋的當日內容
└── README.md
```

## 部署步驟

1. **建立 GitHub repo**，把這個資料夾整個推上去（`git init` → `git add .` →
   `git commit` → `git remote add origin ...` → `git push`）。

2. **申請 Anthropic API 金鑰**（https://console.anthropic.com），
   在 repo 的 `Settings → Secrets and variables → Actions → New repository secret`
   新增一個名為 `ANTHROPIC_API_KEY` 的 secret，貼上金鑰。

3. **開啟 GitHub Pages**：
   `Settings → Pages → Source` 選擇 `Deploy from a branch`，
   Branch 選 `main`，資料夾選 `/docs`，儲存。
   幾分鐘後就會有一個公開網址，例如
   `https://你的帳號.github.io/你的repo名稱/`。

4. **手動測試排程腳本**：
   到 repo 的 `Actions` 分頁，選「每日更新 RFI 學習摘要」這個 workflow，
   點右上角 `Run workflow` 手動觸發一次，看執行紀錄有沒有成功。

5. 之後就會照 `.github/workflows/daily-update.yml` 裡設定的時間
   （目前是台灣時間每天中午 12:00）自動執行，把 `docs/data/today.json`
   更新並推回 repo，GitHub Pages 網頁打開時就會顯示當天內容。

## 目前的可靠程度

多虧你提供了兩天（7/22、7/23）實際下載的頁面原始碼，這一版已經用「真的看過、
比對過兩天結構是否一致的 HTML」重寫過，可靠度比第一版高很多：

- ✅ **不需要另外找「最新一集連結」了**：節目列表頁網址本身（不帶日期那個）
  就會直接顯示最新一集的完整內容，兩天的原始碼都證實了這件事。腳本直接抓
  這個固定網址即可，省掉一整個容易出錯的步驟。
- ✅ **逐字稿**：`.m-transcription .m-box-expand__content p`，兩天都驗證一致。
- ✅ **音檔網址**：從頁面裡的 JSON-LD（`<script type="application/ld+json">`）
  取 `audio.contentUrl`，這是 schema.org 標準格式，比較不容易因改版而失效。
- ✅ **章節時間軸**：RFI 官方本身就有幫每則新聞標記精準的開始秒數
  （`.m-chapters .a-chapter` 裡的 `v-bind:init-time`），已經直接拿來用，
  不再需要用逐字稿字數比例去估算時間點——這比第一版準確很多。

## 如果腳本執行失敗，怎麼修

1. 打開 Actions 執行紀錄，看錯誤訊息（腳本裡有寫清楚的中文錯誤提示）。
2. 最可能失效的情境：RFI 改版，換了 CSS class 名稱。用瀏覽器打開
   https://francaisfacile.rfi.fr/fr/podcasts/journal-en-fran%C3%A7ais-facile/，
   `F12` 開發者工具（Mac 上是 `Cmd+Option+I`）檢查對應的區塊現在叫什麼 class。
3. 把該段 HTML 貼給 Claude（或 Claude Code），請它把 `fetch-and-summarize.mjs`
   裡對應的 selector 改成正確的即可，其餘邏輯不用動。

## 每則摘要的則數

不再固定寫死 6 則——腳本會依照 RFI 官方當天實際標記的章節數量（通常
4~8 則，扣掉開場的「Les titres」提要）自動決定，這樣比較貼近每天新聞的
真實結構。

## 每則摘要的則數

不再固定寫死 6 則——腳本會依照 RFI 官方當天實際標記的章節數量（通常
4~6 則，扣掉開場的「Les titres」提要）自動決定，這樣比較貼近每天新聞的
真實結構。

## 其他可調整的地方

- **排程時間**：改 `.github/workflows/daily-update.yml` 裡的 `cron: "0 4 * * *"`
  （時間是 UTC，台灣時間 = UTC+8）。
- **摘要則數 / 字數**：改 `fetch-and-summarize.mjs` 裡呼叫 Claude API 的 prompt 文字。
- **朗讀語速選項**：改 `docs/index.html` 裡的 `<select id="rate">`。

## 著作權提醒

腳本的 prompt 已要求 Claude 做「改寫摘要」而非逐字轉載原文，這是刻意設計的，
請不要修改成「原文照抄」，以避免侵犯 RFI 的著作權。
