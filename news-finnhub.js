import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import cors from "cors";
import { AzureOpenAI } from "openai";

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());

// 🔹 Environment variables
const {
  FINNHUB_API_KEY,
  AZURE_OPENAI_ENDPOINT,
  AZURE_OPENAI_API_KEY,
  AZURE_OPENAI_DEPLOYMENT
} = process.env;

// 🔹 Azure OpenAI client setup
const aiClient = new AzureOpenAI({
  endpoint: AZURE_OPENAI_ENDPOINT,
  apiKey: AZURE_OPENAI_API_KEY, 
  deployment: AZURE_OPENAI_DEPLOYMENT,
  apiVersion: "2024-05-01-preview",
});

// 🔹 Helper to extract company/ticker from user query
async function extractCompanyFromQuery(query) {
  const prompt = `
  Extract the company name or ticker symbol from this user query:
  "${query}"
  Respond ONLY with the company name or ticker (e.g., "Apple" or "AAPL").
  `;

  const aiRes = await aiClient.chat.completions.create({
    messages: [{ role: "user", content: prompt }],
    model: AZURE_OPENAI_DEPLOYMENT,
    max_tokens: 20,
    temperature: 0.3,
  });

  const company = aiRes.choices[0].message.content.trim();
  return company;
}

// 🔹 Helper to summarize news data
async function summarizeNews(company, news) {
  const newsText = news
    .slice(0, 5)
    .map((n) => `- ${n.headline}: ${n.summary}`)
    .join("\n");

  const prompt = `
  Summarize the top finance and company-related news for ${company}.
  Use the following data:
  ${newsText}
  Provide a short, clear summary (max 100 words).
  `;

  const aiRes = await aiClient.chat.completions.create({
    messages: [{ role: "user", content: prompt }],
    model: AZURE_OPENAI_DEPLOYMENT,
    max_tokens: 150,
    temperature: 0.5,
  });

  return aiRes.choices[0].message.content.trim();
}

// 🔹 Main route — user sends query
app.post("/ai-company-news", async (req, res) => {
  try {
    const { query } = req.body;
    if (!query) return res.status(400).json({ message: "Query is required" });

    // Step 1️⃣ Extract company/ticker from query
    const company = await extractCompanyFromQuery(query);
    if (!company) return res.status(404).json({ message: "Could not extract company name or ticker" });

    // Step 2️⃣ Resolve ticker
    const searchUrl = `https://finnhub.io/api/v1/search?q=${encodeURIComponent(company)}&token=${FINNHUB_API_KEY}`;
    const searchRes = await axios.get(searchUrl);
    if (!searchRes.data.result?.length) {
      return res.status(404).json({ message: `Ticker not found for "${company}"` });
    }

    const match = searchRes.data.result.find(
      (item) => item.exchange === "US" || item.type === "Common Stock"
    ) || searchRes.data.result[0];
    const ticker = match.symbol;

    // Step 3️⃣ Fetch company news (last 30 days)
    const to = new Date().toISOString().split("T")[0];
    const from = new Date();
    from.setDate(from.getDate() - 30);
    const fromDate = from.toISOString().split("T")[0];

    const newsUrl = `https://finnhub.io/api/v1/company-news?symbol=${ticker}&from=${fromDate}&to=${to}&token=${FINNHUB_API_KEY}`;
    const newsRes = await axios.get(newsUrl);

    const news = newsRes.data.slice(0, 10); // Top 10 news articles

    // Step 4️⃣ Summarize using Azure OpenAI
    const answer = await summarizeNews(company, news);

    res.json({
      company,
      ticker,
      answer,
      topNews: news.map((n) => ({
        headline: n.headline,
        source: n.source,
        url: n.url,
        datetime: n.datetime,
      })),
    });
  } catch (err) {
    console.error("❌ Error:", err.message);
    res.status(500).json({ message: "Failed to process company news query" });
  }
});

const PORT = 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));