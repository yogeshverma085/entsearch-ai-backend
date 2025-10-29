import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import cors from "cors";
import { AzureOpenAI } from "openai";

dotenv.config();

const app = express();
app.use(express.json());
app.use(cors());

const {
  AZURE_OPENAI_ENDPOINT,
  AZURE_OPENAI_API_KEY,
  AZURE_OPENAI_DEPLOYMENT,
  ALPHA_VANTAGE_KEY,
} = process.env;

// ---------------- Azure Client ----------------
const aiClient = new AzureOpenAI({
  endpoint: AZURE_OPENAI_ENDPOINT,
  apiKey: AZURE_OPENAI_API_KEY,
  deployment: AZURE_OPENAI_DEPLOYMENT,
  apiVersion: "2024-02-15-preview",
});

// ---------------- Helpers ----------------

// 🔹 Fetch company overview or key ratios from Alpha Vantage
async function fetchFinanceOverview(symbol) {
  try {
    if (!symbol) return null;
    const url = `https://www.alphavantage.co/query?function=OVERVIEW&symbol=${symbol}&apikey=${ALPHA_VANTAGE_KEY}`;
    const { data } = await axios.get(url);
    if (!data || !data.Symbol) return null;
    return data;
  } catch (err) {
    console.error("Error fetching finance data:", err.message);
    return null;
  }
}

// 🔹 AI prompt to classify and extract finance-related details
async function extractFinanceIntent(query) {
  const prompt = `
You are a classification AI that determines what type of financial data a user is requesting.

Decide only whether the query is about "finance" (company overview, stock, ratios, earnings, or financial metrics).

Also extract companyName or ticker if mentioned.

Return JSON ONLY:
{
  "source": "finance",
  "companyName": "string or null",
  "ticker": "string or null"
}

Be strict:
- If the query includes "finance", "details", "overview", "earnings", "stock", "share price", "market cap", "valuation", "P/E ratio", "financials" → classify as "finance".
- Always return "finance" as source.

Query: "${query}"
JSON:
`;

  const completion = await aiClient.chat.completions.create({
    messages: [{ role: "user", content: prompt }],
    max_tokens: 150,
    temperature: 0,
  });

  try {
    return JSON.parse(completion.choices[0].message.content.trim());
  } catch (err) {
    console.error("Failed parsing intent:", err.message);
    return { source: "finance", companyName: null, ticker: null };
  }
}

// 🔹 AI summarization for finance data
async function summarizeFinanceData(query, financeData) {
  const context = financeData
    ? `Finance Overview:\n${JSON.stringify(financeData, null, 2)}`
    : "No finance data found.";

  const prompt = `
You are a financial analyst AI.
Analyze the following financial context and answer the user query clearly.

User Query: ${query}

Context:
${context}

Provide a concise and clear summary including:
- Key financial metrics (Revenue, PE Ratio, Market Cap, etc.)
- Company performance insights
- Investment outlook or potential risks
`;

  const response = await aiClient.chat.completions.create({
    messages: [{ role: "user", content: prompt }],
    max_tokens: 400,
    temperature: 0.3,
  });

  return response.choices?.[0]?.message?.content || "No summary generated.";
}

// ---------------- API Endpoint ----------------
app.post("/api/ai-finance", async (req, res) => {
  try {
    const { query } = req.body;
    if (!query) return res.status(400).json({ error: "Query is required." });

    // 🧠 Step 1: Extract intent and company info
    const intent = await extractFinanceIntent(query);
    let { companyName, ticker } = intent;

    // 🧠 Step 2: Resolve ticker via Yahoo Finance if only name provided
    let resolvedTicker = ticker || null;
    if (companyName && !resolvedTicker) {
      try {
        const searchUrl = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(
          companyName
        )}`;
        const resp = await axios.get(searchUrl, {
          headers: { "User-Agent": "Mozilla/5.0" },
        });
        resolvedTicker = resp.data?.quotes?.[0]?.symbol || null;
      } catch (err) {
        console.error("Yahoo search failed:", err.message);
      }
    }

    // 🧠 Step 3: Fetch finance data
    let financeData = null;
    if (resolvedTicker) {
      financeData = await fetchFinanceOverview(resolvedTicker);
    }

    // 🧠 Step 4: AI summary
    const aiSummary = await summarizeFinanceData(query, financeData);

    res.json({
      sourceUsed: "finance",
      companyName: companyName || financeData?.Name || null,
      ticker: resolvedTicker,
      aiSummary,
      financeData: financeData || {},
    });
  } catch (err) {
    console.error("Error in /api/ai-finance:", err.message);
    res.status(500).json({ error: "Internal server error." });
  }
});

// ---------------- Start Server ----------------
const PORT = process.env.PORT || 3001;
app.listen(PORT, () =>
  console.log(`✅ AI Finance service running on http://localhost:${PORT}`)
);
