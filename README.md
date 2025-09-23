# ChatGPT Share → PDF

En superenkel tjänst som konverterar **ChatGPT delningslänkar** (t.ex. `https://chatgpt.com/share/<id>`) till **PDF**. Perfekt för att spara konversationer eller ladda upp till *ChatGPT Projects* och andra verktyg.

## ✨ Funktioner
- Klistra in valfri **publik** ChatGPT-share-länk → få en **nedladdningsbar PDF**.
  - **Text- PDF** (DOM-scrape) när det går → sökbar text.
- Minimal UI (statisk sida) + serverless backend (Puppeteer + serverless Chromium).

## 🧱 Arkitektur
- **Frontend:** statisk `index.html` (hostas på Vercel eller valfri statisk host).
- **Backend:** Vercel Serverless Functions:
  - `POST /api/convert` – tar emot `{ url, forceRaster? }`, returnerar PDF.
  - `GET  /api/diag` – snabb hälsokoll (startar Chromium, öppnar `example.com`).

