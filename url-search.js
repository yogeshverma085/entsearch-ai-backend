import dotenv from "dotenv";
dotenv.config();

import express from "express";
import axios from "axios";
import { SearchClient, AzureKeyCredential } from "@azure/search-documents";
import { AzureOpenAI } from "openai";

const app = express();
app.use(express.json());

// 🔹 Azure Cognitive Search client
const searchClient = new SearchClient(
  process.env.AZURE_SEARCH_ENDPOINT,
  process.env.AZURE_SEARCH_INDEX,
  new AzureKeyCredential(process.env.AZURE_SEARCH_API_KEY)
);


const openaiClient = new AzureOpenAI({
  endpoint: process.env.AZURE_OPENAI_ENDPOINT,
  apiKey: process.env.AZURE_OPENAI_API_KEY,
  deployment: process.env.AZURE_OPENAI_DEPLOYMENT,
  apiVersion: "2023-07-01-preview", // add this line
});

// 🔹 Fetch content from URL
async function fetchContent(url) {
  const res = await axios.get(url);
  return res.data;
}

// 🔹 Upload documents to Azure Search index
async function ensureIndexed(urls) {
  for (const url of urls) {
    let content = await fetchContent(url);
    if (typeof content !== "string") content = JSON.stringify(content);
    try {
      await searchClient.uploadDocuments([
        {
          id: Buffer.from(url).toString("base64"),
          title: url,
          content: content.slice(0, 32000),
        },
      ]);
    } catch {
      // Ignore duplicate upload errors
    }
  }
}

// 🔹 Search API endpoint
app.post("/search", async (req, res) => {
  try {
    const { query, urls } = req.body;

    if (!query || !Array.isArray(urls) || urls.length === 0) {
      return res.status(400).json({ error: "Query and URLs array required." });
    }

    // 1️⃣ Index any new URLs
    await ensureIndexed(urls);

    // 2️⃣ Search relevant docs
    const docs = [];
    const results = await searchClient.search(query, { top: 3 });
    for await (const result of results.results) {
      docs.push(result.document.content);
    }

    // 3️⃣ Create prompt
    const prompt = `
You are an AI assistant. Use ONLY the following context to answer clearly:

${docs.join("\n---\n")}

Question: ${query}
Answer:
`;

    // 4️⃣ Get response from Azure AI Foundry model
    const completion = await openaiClient.chat.completions.create({
      model: process.env.AZURE_OPENAI_DEPLOYMENT,
      messages: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: prompt },
      ],
      max_tokens: 300,
      temperature: 0.2,
    });

    res.json({
      answer: completion.choices[0].message.content.trim(),
      grounded_context: docs,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

// 🔹 Start server
const PORT = 3000;
app.listen(PORT, () => {
  console.log(`✅ Server listening on port ${PORT}`);
});