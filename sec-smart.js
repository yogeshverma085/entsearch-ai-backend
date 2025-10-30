import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import { AzureOpenAI } from "openai";
import cors from "cors";

dotenv.config();
const app = express();
app.use(express.json());
app.use(cors());

// ---------------- Azure Client ----------------
const openaiClient = new AzureOpenAI({
  endpoint: process.env.AZURE_OPENAI_ENDPOINT,
  apiKey: process.env.AZURE_OPENAI_API_KEY,
  deployment: process.env.AZURE_OPENAI_DEPLOYMENT,
  apiVersion: "2023-07-01-preview",
});

// ---------------- Helpers ----------------

async function getCIKFromCompanyOrTicker(name, ticker) {
  try {
    const url = "https://www.sec.gov/files/company_tickers_exchange.json";
    const response = await axios.get(url, { headers: { "User-Agent": "MyApp/1.0" } });
    const { fields, data } = response.data;
    const cikIndex = fields.indexOf("cik");
    const nameIndex = fields.indexOf("name");
    const tickerIndex = fields.indexOf("ticker");

    const searchName = name?.toLowerCase().trim();
    const searchTicker = ticker?.toLowerCase().trim();

    for (const row of data) {
      const rowName = row[nameIndex]?.toLowerCase();
      const rowTicker = row[tickerIndex]?.toLowerCase();
      if ((searchName && rowName.includes(searchName)) || (searchTicker && rowTicker === searchTicker)) {
        return row[cikIndex].toString().padStart(10, "0");
      }
    }
    return null;
  } catch (err) {
    console.error("Error fetching CIK:", err.message);
    return null;
  }
}

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

// AI summarization with structured JSON output

// async function askAIAboutFilings(filings, query) {
//   if (!filings || filings.length === 0) {
//     return [];
//   }

//   const BATCH_SIZE = 2; // small batch to avoid token overflow
//   const allSummaries = [];

//   for (let i = 0; i < filings.length; i += BATCH_SIZE) {
//     const batch = filings.slice(i, i + BATCH_SIZE);

//     // Prepare SEC filings text for this batch
//     const filingsText = batch
//       .map(
//         (f) =>
//           `Company: ${f.companyName}, Ticker: ${f.ticker}, Form: ${f.form}, Date: ${f.filingDate}, Accession: ${f.accessionNumber}`
//       )
//       .join("\n");

//     // Prompt AI to return structured JSON
//     const prompt = `
// You are a financial assistant AI.
// Use ONLY the following SEC filings data to answer the user's question.

// SEC Filings:
// ${filingsText}

// User Question: ${query}

// Return the answer as a JSON array. Each object should have the following structure:
// {
//   "companyName": "Company Name",
//   "ticker": "Ticker Symbol",
//   "form": "Form Type",
//   "filingDate": "YYYY-MM-DD",
//   "accessionNumber": "Accession Number",
//   "summary": "Brief summary of the filing",
//   "financials": {
//      "revenue": "$...",
//      "netIncome": "$..."
//   },
//   "keyInitiatives": ["Initiative 1", "Initiative 2", "..."]
// }

// Return ONLY valid JSON. Do NOT include markdown code blocks.
// Escape all quotes and special characters properly.
// Keep "summary" max 100 words, "keyInitiatives" max 5 items.
// `;

//     // Call Azure OpenAI
//     const completion = await openaiClient.chat.completions.create({
//       model: process.env.AZURE_OPENAI_DEPLOYMENT,
//       messages: [{ role: "user", content: prompt }],
//       max_tokens: 2000, // safely increased for batch
//       temperature: 0.2,
//     });

//     // Parse JSON response
//     let rawContent = completion.choices[0].message.content.trim();
//     rawContent = rawContent.replace(/^```json\s*/, "").replace(/^```\s*/, "").replace(/```$/, "");

//     try {
//       const parsed = JSON.parse(rawContent);
//       allSummaries.push(...parsed);
//     } catch (err) {
//       // fallback: remove trailing commas and try again
//       const cleaned = rawContent.replace(/,\s*]/g, "]").replace(/,\s*}/g, "}");
//       try {
//         const parsed = JSON.parse(cleaned);
//         allSummaries.push(...parsed);
//       } catch (err2) {
//         console.error("Failed to parse AI JSON for this batch:", err2.message);
//       }
//     }
//   }

//   return allSummaries;
// }

async function askAIAboutFilings(filings, query) {
  if (!filings || filings.length === 0) return [];

  const BATCH_SIZE = 2;
  let allSummaries = [];

  for (let i = 0; i < filings.length; i += BATCH_SIZE) {
    const batch = filings.slice(i, i + BATCH_SIZE);

    const filingsText = batch
      .map(
        (f) =>
          `Company: ${f.companyName}, Ticker: ${f.ticker}, Form: ${f.form}, Date: ${f.filingDate}, Accession: ${f.accessionNumber}`
      )
      .join("\n");

    // ✨ Updated Prompt for Structured, Readable Format
    const prompt = `
You are a financial assistant AI. 
Use the following SEC filings data to provide a **well-formatted summary** for the user's question.

SEC Filings:
${filingsText}

User Question: ${query}

Format the response as **structured readable text** with headings and bullet/numbered lists where suitable, like:

**Company:** Intel Corporation  
**Ticker:** INTC  
**Form:** 8-K  
**Filing Date:** 2025-09-05  
**Summary:**  
- Intel reported strong quarterly performance...  

**Financial Summary:**  
1. Revenue: $95.3 billion  
2. Net Income: $14.8 billion  

**Key Initiatives:**  
- Expansion into AI and machine learning  
- Partnership with major cloud providers  

If multiple filings exist, separate each company’s section clearly using a line like:
---
Keep text concise and readable. Return plain text only (no JSON, no markdown code block markers like \`\`\`).
`;

    const completion = await openaiClient.chat.completions.create({
      model: process.env.AZURE_OPENAI_DEPLOYMENT,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 2000,
      temperature: 0.3,
    });

    let rawContent = completion.choices[0].message.content.trim();
    rawContent = rawContent
      .replace(/^```(json|text)?\s*/i, "")
      .replace(/```$/, "")
      .trim();

    allSummaries.push(rawContent);
  }

  // Combine batches with spacing for better readability
  return allSummaries.join("\n\n---\n\n");
}


// Smart Query Parser
async function extractEntitiesFromQuery(query) {
  const prompt = `
You are an AI assistant that extracts structured data from natural language queries.
Given a user's question about SEC filings, extract the following fields:
1. companyName
2. ticker
3. cik
4. form (e.g., 10-K, 8-K, 4, etc.)

Return a JSON object with keys: companyName, ticker, cik, form.
If a field is not mentioned, return null for that field.

Query: "${query}"
JSON:
`;
  const completion = await openaiClient.chat.completions.create({
    model: process.env.AZURE_OPENAI_DEPLOYMENT,
    messages: [{ role: "user", content: prompt }],
    max_tokens: 150,
    temperature: 0,
  });
  try {
    const text = completion.choices[0].message.content.trim();
    return JSON.parse(text);
  } catch (err) {
    console.error("Error parsing entities:", err.message);
    return { companyName: null, ticker: null, cik: null, form: null };
  }
}

// ---------------- Main endpoint ----------------
app.post("/sec-query", async (req, res) => {
  try {
    const { query } = req.body;
    if (!query) return res.status(400).json({ error: "Query is required." });

    // 1️ Extract entities from natural query
    const entities = await extractEntitiesFromQuery(query);
    let { cik, companyName, ticker, form } = entities;

    // 2️ Resolve CIK if not provided
    if (!cik && (companyName || ticker)) {
      cik = await getCIKFromCompanyOrTicker(companyName, ticker);
    }

    // 3️ Fetch filings
    let filings = [];
    if (cik) {
      filings = await fetchFilingsFromSECByCIK(cik, 10, form);
    } else if (form) {
      filings = await fetchLatestFilingsByForm(form, 10);
    } else {
      return res.json({ answer: "CIK not found. Provide valid company name, ticker, or form.", grounded_context: [] });
    }

    // 4️ Summarize via AI
    const answer = await askAIAboutFilings(filings, query);
    res.json({ answer, grounded_context: filings || [] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error." });
  }
});

// ---------------- Start server ----------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
