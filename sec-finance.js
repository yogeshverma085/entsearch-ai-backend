import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import cors from "cors";
import { AzureOpenAI } from "openai";

dotenv.config();
const companyCache = new Map(); // simple in-memory cache

const app = express();
app.use(express.json());
app.use(cors());

const {
    AZURE_OPENAI_ENDPOINT,
    AZURE_OPENAI_API_KEY,
    AZURE_OPENAI_DEPLOYMENT,
    ALPHA_VANTAGE_KEY,
} = process.env;

const aiClient = new AzureOpenAI({
    endpoint: AZURE_OPENAI_ENDPOINT,
    apiKey: AZURE_OPENAI_API_KEY,
    deployment: AZURE_OPENAI_DEPLOYMENT,
    apiVersion: "2024-02-15-preview",
});

// ---------------- Helpers ----------------

async function getCIKFromCompanyOrTicker(name, ticker) {
    try {
        // ✅ Use cache if available
        const key = (name || ticker || "").toLowerCase();
        if (companyCache.has(key)) return companyCache.get(key);

        const url = "https://www.sec.gov/files/company_tickers_exchange.json";
        const res = await axios.get(url, { headers: { "User-Agent": "finance-ai-app/1.0" } });
        const { fields, data } = res.data;
        const cikIndex = fields.indexOf("cik");
        const nameIndex = fields.indexOf("name");
        const tickerIndex = fields.indexOf("ticker");

        const searchName = name?.toLowerCase().trim();
        const searchTicker = ticker?.toLowerCase().trim();

        let bestMatch = null;

        for (const row of data) {
            const rowName = row[nameIndex]?.toLowerCase();
            const rowTicker = row[tickerIndex]?.toLowerCase();

            if (searchTicker && rowTicker === searchTicker) {
                const cik = row[cikIndex].toString().padStart(10, "0");
                companyCache.set(key, cik);
                return cik;
            }
            if (searchName && (rowName === searchName || rowName.includes(searchName))) bestMatch = row;
        }

        const cik = bestMatch ? bestMatch[cikIndex].toString().padStart(10, "0") : null;
        companyCache.set(key, cik);
        return cik;
    } catch (err) {
        console.error("Error fetching CIK:", err.message);
        return null;
    }
}


// async function getCIKFromCompanyOrTicker(name, ticker) {
//     try {
//         const url = "https://www.sec.gov/files/company_tickers_exchange.json";
//         const res = await axios.get(url, { headers: { "User-Agent": "finance-ai-app/1.0" } });
//         const { fields, data } = res.data;
//         const cikIndex = fields.indexOf("cik");
//         const nameIndex = fields.indexOf("name");
//         const tickerIndex = fields.indexOf("ticker");

//         const searchName = name?.toLowerCase().trim();
//         const searchTicker = ticker?.toLowerCase().trim();

//         let bestMatch = null;

//         for (const row of data) {
//             const rowName = row[nameIndex]?.toLowerCase();
//             const rowTicker = row[tickerIndex]?.toLowerCase();

//             if (searchTicker && rowTicker === searchTicker) return row[cikIndex].toString().padStart(10, "0");
//             if (searchName && (rowName === searchName || rowName.includes(searchName))) bestMatch = row;
//         }

//         return bestMatch ? bestMatch[cikIndex].toString().padStart(10, "0") : null;
//     } catch (err) {
//         console.error("Error fetching CIK:", err.message);
//         return null;
//     }
// }


async function fetchFilingsFromSECByCIK(cik, limit = 50, formFilter) {
    try {
        const url = `https://data.sec.gov/submissions/CIK${cik}.json`;
        const res = await axios.get(url, { headers: { "User-Agent": "yogeshverma@gmail.com" } });
        const recent = res.data?.filings?.recent;
        if (!recent || !recent.accessionNumber) return [];

        let ticker = "";
        try {
            const tickersUrl = "https://www.sec.gov/files/company_tickers_exchange.json";
            const tickersResp = await axios.get(tickersUrl, { headers: { "User-Agent": "yogesh.verma@gmail.com" } });
            const { fields, data } = tickersResp.data;
            const cikIndex = fields.indexOf("cik");
            const tickerIndex = fields.indexOf("ticker");
            const found = data.find((row) => String(row[cikIndex]).padStart(10, "0") === cik);
            if (found) ticker = found[tickerIndex];
        } catch (err) {
            console.error("Error fetching ticker for CIK:", err.message);
        }

        const filings = [];
        for (let i = 0; i < Math.min(recent.accessionNumber.length, limit); i++) {
            const form = recent.form[i];
            if (formFilter && !form.toUpperCase().includes(formFilter.toUpperCase())) continue;
            filings.push({
                cik,
                companyName: res.data?.name || "",
                ticker,
                accessionNumber: recent.accessionNumber[i],
                filingDate: recent.filingDate[i],
                form,
                primaryDocument: recent.primaryDocument[i],
            });
        }
        return filings;
    } catch (err) {
        console.error("Error fetching SEC data by CIK:", err.message);
        return [];
    }
}

async function fetchLatestFilingsByForm(formFilter, limit = 10) {
    try {
        const tickersUrl = "https://www.sec.gov/files/company_tickers_exchange.json";
        const tickersResp = await axios.get(tickersUrl, { headers: { "User-Agent": "yogesh.verma@example.com" } });
        const { fields, data } = tickersResp.data;
        const cikIndex = fields.indexOf("cik");
        const ciks = data.map((row) => String(row[cikIndex]).padStart(10, "0"));

        const collected = [];
        const BATCH_SIZE = 5;
        const BATCH_DELAY_MS = 600;

        for (let i = 0; i < ciks.length && collected.length < limit; i += BATCH_SIZE) {
            const batch = ciks.slice(i, i + BATCH_SIZE);
            const results = await Promise.all(batch.map((cik) => fetchFilingsFromSECByCIK(cik, 10, formFilter)));
            for (const arr of results) {
                if (!arr || arr.length === 0) continue;
                for (const f of arr) {
                    const key = `${f.cik}-${f.accessionNumber}`;
                    if (!collected.find((x) => `${x.cik}-${x.accessionNumber}` === key)) {
                        collected.push(f);
                        if (collected.length >= limit) break;
                    }
                }
                if (collected.length >= limit) break;
            }
            await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
        }

        collected.sort((a, b) => new Date(b.filingDate) - new Date(a.filingDate));
        return collected.slice(0, limit);
    } catch (err) {
        console.error("Error in fetchLatestFilingsByForm:", err.message);
        return [];
    }
}

async function fetchFinanceOverview(symbol) {
    try {
        if (!symbol) return null;
        const url = `https://www.alphavantage.co/query?function=OVERVIEW&symbol=${symbol}&apikey=${process.env.ALPHA_VANTAGE_KEY}`;
        const { data } = await axios.get(url);
        if (!data || !data.Symbol) return null;
        return data;
    } catch (err) {
        console.error("Error fetching finance data:", err.message);
        return null;
    }
}

// ---------------- AI Helpers ----------------

async function extractQueryIntent(query) {
    const prompt = `
You are a classification AI that determines what type of financial data a user is requesting.

Decide whether to use:
- "finance" (for company overview, stock, ratios, earnings, financial metrics)
- "sec" (for filings, forms, disclosures, official reports like 10-K, 10-Q)
- "both" (if the query requests both reports/filings and finance details, or the intent is ambiguous)

Also extract companyName, ticker, or form if mentioned.

Return JSON ONLY:
{
  "source": "finance" | "sec" | "both",
  "companyName": "string or null",
  "ticker": "string or null",
  "form": "string or null"
}

Be strict:
- If query includes words like "report", "filing", "10-K", "10-Q", "SEC", "statement", "annual report" → prefer "sec".
- If query includes "finance", "details", "overview", "earnings", "stock", "share price" → prefer "finance".
- If both appear or query is ambiguous → return "both".

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
        return { source: "both", companyName: null, ticker: null, form: null };
    }
}

async function summarizeData(query, financeData, filings) {
    const contextParts = [];
    if (financeData) contextParts.push(`Finance Overview:\n${JSON.stringify(financeData, null, 2)}`);
    if (filings?.length) contextParts.push(`SEC Filings:\n${JSON.stringify(filings.slice(0, 5), null, 2)}`);
    const context = contextParts.join("\n\n") || "No additional context.";

    const prompt = `
You are a financial analyst AI.
Analyze the following context and answer the user query clearly.

User Query: ${query}

Context:
${context}

Provide a short structured summary including:
- Key financial metrics
- Important SEC disclosures
- Investment insights or risks
- Relevant company trends or events
`;

    const response = await aiClient.chat.completions.create({
        messages: [{ role: "user", content: prompt }],
        max_tokens: 500,
        temperature: 0.3,
    });

    return response.choices?.[0]?.message?.content || "No summary generated.";
}

// ✅ NEW: AI about Filings
async function askAIAboutFilings(filings, query) {
    if (!filings?.length) return [];
    const BATCH_SIZE = 2;
    const insights = [];

    for (let i = 0; i < filings.length; i += BATCH_SIZE) {
        const batch = filings.slice(i, i + BATCH_SIZE);
        const filingsText = batch
            .map(
                (f) =>
                    `Company: ${f.companyName}, Ticker: ${f.ticker}, Form: ${f.form}, Date: ${f.filingDate}, Accession: ${f.accessionNumber}`
            )
            .join("\n");

        const prompt = `
You are a financial insights AI.
Analyze these SEC filings and return structured JSON.

SEC Filings:
${filingsText}

User Query: ${query}

Return JSON only (no markdown):
[
  {
    "companyName": "string",
    "ticker": "string",
    "form": "string",
    "filingDate": "YYYY-MM-DD",
    "accessionNumber": "string",
    "summary": "short insight (max 100 words)",
    "financials": { "revenue": "string", "netIncome": "string" },
    "keyInitiatives": ["string"]
  }
]
`;

        const resp = await aiClient.chat.completions.create({
            messages: [{ role: "user", content: prompt }],
            max_tokens: 1500,
            temperature: 0.2,
        });

        let text = resp.choices[0].message.content.trim();
        text = text.replace(/^```json\s*/, "").replace(/```$/, "").replace(/^```\s*/, "");
        try {
            const parsed = JSON.parse(text);
            insights.push(...parsed);
        } catch {
            console.error("Failed parsing filing AI JSON batch");
        }
    }

    return insights;
}

// ---------------- Unified Endpoint ----------------
app.post("/api/ai-finance-sec", async (req, res) => {
    try {
        const { query } = req.body;
        if (!query) return res.status(400).json({ error: "Query is required." });

        const intent = await extractQueryIntent(query);
        let { source, companyName, ticker, form } = intent;
        source = source || "both";

        let resolvedTicker = ticker || null;
        let cik = null;

        // 🔧 FIXED SECTION: Better name→ticker resolution
        if (companyName && !resolvedTicker) {
            // Try CIK lookup
            cik = await getCIKFromCompanyOrTicker(companyName, null);

            // Try to get ticker from CIK mapping
            if (cik) {
                try {
                    const tickersResp = await axios.get("https://www.sec.gov/files/company_tickers_exchange.json", {
                        headers: { "User-Agent": "finance-ai-app/1.0" },
                    });
                    const { fields, data } = tickersResp.data;
                    const cikIndex = fields.indexOf("cik");
                    const tickerIndex = fields.indexOf("ticker");
                    const found = data.find((row) => String(row[cikIndex]).padStart(10, "0") === cik);
                    if (found) resolvedTicker = found[tickerIndex];
                } catch (err) {
                    console.error("Error getting ticker from mapping:", err.message);
                }
            }

            // If still unresolved, fallback to Yahoo
            if (!resolvedTicker) {
                try {
                    const searchUrl = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(companyName)}`;
                    const resp = await axios.get(searchUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
                    resolvedTicker = resp.data?.quotes?.[0]?.symbol || null;
                } catch (err) {
                    console.error("Yahoo search failed:", err.message);
                }
            }
        }

        // If ticker known, resolve CIK again (ensures both values filled)
        if (!cik && (resolvedTicker || companyName)) {
            cik = await getCIKFromCompanyOrTicker(companyName, resolvedTicker);
        }

        let financeData = null;
        let filings = [];

        if (source === "finance" || source === "both") {
            if (resolvedTicker) {
                financeData = await fetchFinanceOverview(resolvedTicker);
                if (!companyName && financeData?.Name) companyName = financeData.Name;
            }
        }

        if (source === "sec" || source === "both") {
            if (cik) {
                if (form) {
                    filings = await fetchFilingsFromSECByCIK(cik, 50, form);
                    if (!filings.length) filings = await fetchLatestFilingsByForm(form, 10);
                } else {
                    filings = await fetchFilingsFromSECByCIK(cik, 10, null);
                }
            } else if (form) {
                filings = await fetchLatestFilingsByForm(form, 10);
            }
        }

        const aiSummary = await summarizeData(query, financeData, filings);

        let answer = [];
        if ((source === "sec" || source === "both") && filings.length > 0) {
            answer = await askAIAboutFilings(filings, query);
        }

        res.json({
            sourceUsed: source,
            companyName: companyName || financeData?.Name || filings[0]?.companyName || null,
            ticker: resolvedTicker || null,
            cik: cik || null,
            aiSummary,
            financeData: financeData || {},
            secFilings: filings || [],
            answer,
        });
    } catch (err) {
        console.error("Error in /api/ai-finance-sec:", err.message);
        res.status(500).json({ error: "Internal server error." });
    }
});

// ---------------- Start Server ----------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
    console.log(`✅ Unified AI Finance+SEC running on http://localhost:${PORT}`)
);
