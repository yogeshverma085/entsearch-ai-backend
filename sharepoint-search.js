import dotenv from "dotenv";
import express from "express";
import axios from "axios";
import { AzureOpenAI } from "openai";
import mammoth from "mammoth";
import XLSX from "xlsx";
import cors from "cors";

const pdfModule = await import("pdf-parse");
const pdf = pdfModule.default || pdfModule;

dotenv.config();
const app = express();
app.use(express.json());
app.use(cors());

const openaiClient = new AzureOpenAI({
  endpoint: process.env.AZURE_OPENAI_ENDPOINT,
  apiKey: process.env.AZURE_OPENAI_API_KEY,
  apiVersion: process.env.OPENAI_API_VERSION,
});

// -------------------- helpers --------------------

// improved keyword extractor (returns array of keywords)
function extractKeywordsArray(query) {
  const stopWords = new Set([
    "the","is","are","am","was","were","a","an","and","or","for","to","of","in","on","at","by","with",
    "from","that","this","it","as","be","been","being","if","then","else","what","which","who","when","where","how","why","please","give","some","details","here"
  ]);
  if (!query || typeof query !== "string") return [];
  const words = query
    .toLowerCase()
    .match(/\w{3,}/g)   // words with length >= 3
    ?.filter(w => !stopWords.has(w));
  return words || [];
}

// join keywords into OR-string for Graph search
function keywordsToSearchString(keywords, fallback) {
  if (!keywords || !keywords.length) return fallback || "";
  return keywords.join(" OR ");
}

// count presence (unique keywords matched) in a text
function countKeywordPresence(text, keywords) {
  if (!text || !keywords || !keywords.length) return 0;
  const lower = text.toLowerCase();
  let count = 0;
  for (const kw of keywords) {
    if (lower.includes(kw)) count++;
  }
  return count;
}

// -------------------- SharePoint helpers --------------------

async function searchSharePointFiles(query, token) {
  const res = await axios.post(
    `${process.env.GRAPH_API_URL}/search/query`,
    {
      requests: [
        {
          entityTypes: ["driveItem"],
          query: { queryString: query },
          from: 0,
          size: 15, // fetch up to 15 candidates for ranking
        },
      ],
    },
    { headers: { Authorization: `Bearer ${token}` } }
  );

  const hits = res.data.value[0]?.hitsContainers[0]?.hits || [];
  return hits.map((h) => ({
    id: h.resource.id,
    name: h.resource.name,
    driveId: h.resource.parentReference?.driveId,
    webUrl: h.resource.webUrl,
  }));
}

// get file content; optional maxChars to limit preview size
async function getFileTextContent(driveId, itemId, token, maxChars = null) {
  try {
    const res = await axios.get(
      `${process.env.GRAPH_API_URL}/drives/${driveId}/items/${itemId}/content`,
      { headers: { Authorization: `Bearer ${token}` }, responseType: "arraybuffer" }
    );

    const contentType = (res.headers["content-type"] || "").toLowerCase();
    const buffer = Buffer.from(res.data, "binary");
    let text = "";

    if (contentType.includes("wordprocessingml.document") || itemId.endsWith(".docx")) {
      const result = await mammoth.extractRawText({ buffer });
      text = result.value || "";

    } else if (contentType.includes("pdf") || itemId.endsWith(".pdf")) {
      const data = await pdf(buffer);
      text = data.text || "";

    } else if (contentType.includes("text") || itemId.endsWith(".txt")) {
      text = buffer.toString("utf-8");
      
    } else if (
      contentType.includes("spreadsheetml.sheet") || itemId.endswith(".xlsx")) {
      try {
        const workbook = XLSX.read(buffer, { type: "buffer" });
        text = workbook.SheetNames.map((name) => {
          const sheet = workbook.Sheets[name];
          const sheetData = XLSX.utils.sheet_to_csv(sheet);
          return `Sheet: ${name}\n${sheetData}`;
        }).join("\n\n");
      } catch (err) {
        console.warn("⚠️ Failed to parse XLSX:", err.message);
      }
    }

    else {
      console.warn("⚠️ Unknown file type:", contentType);
      text = "";
    }

    if (maxChars && text.length > maxChars) return text.slice(0, maxChars);
    return text;
  } catch (err) {
    console.warn("⚠️ Could not read content:", itemId, err.response?.status);
    return "";
  }
}

// -------------------- /query endpoint with ranking --------------------

app.post("/sharepoint-query", async (req, res) => {
  try {
    const { query } = req.body;
    const token = req.headers.authorization?.split(" ")[1];

    if (!query || !token) return res.status(400).json({ error: "Query and Bearer token required" });

    // 1) prepare keywords and search string
    const keywords = extractKeywordsArray(query); // array of keywords
    const searchString = keywordsToSearchString(keywords, query); // OR-string or fallback to query

    console.log("Query:", query);
    console.log("Keywords:", keywords);
    console.log("Graph search string:", searchString);

    // 2) search SharePoint (up to 15 candidates)
    let candidates = await searchSharePointFiles(searchString, token);
    if (!candidates.length) return res.status(404).json({ error: "No files found in SharePoint" });

    // 3) quick filename scoring
    candidates = candidates.map((file) => {
      const nameLower = (file.name || "").toLowerCase();
      const nameMatches = countKeywordPresence(nameLower, keywords);
      return { ...file, nameMatches, contentMatches: 0, score: nameMatches * 3 }; // name weight 3
    });

    const anyNameMatch = candidates.some(c => c.nameMatches > 0);

    // 4) If no filename matches, fetch a content preview (small) for each candidate and score by content matches
    if (!anyNameMatch) {
      console.log("No filename matches — checking content previews for better ranking (preview size 20KB).");
      const previewMaxChars = 20_000; // preview size 20k chars
      const previews = await Promise.all(
        candidates.map(c => getFileTextContent(c.driveId, c.id, token, previewMaxChars))
      );

      candidates = candidates.map((c, idx) => {
        const previewText = previews[idx] || "";
        const contentMatches = countKeywordPresence(previewText, keywords);
        // combine scores: name weighted 3x, content weighted 1x
        const score = (c.nameMatches * 3) + (contentMatches * 1);
        return { ...c, contentMatches, score };
      });
    } else {
      // even if name matches exist, also optionally check content for more precise scoring (cheap preview)
      // you can enable this block if you want to boost results that also contain keywords in content
      console.log("Some files matched by filename; doing optional quick content preview to refine ordering.");
      const previewMaxChars = 8_000; // smaller preview
      const previews = await Promise.all(
        candidates.map(c => getFileTextContent(c.driveId, c.id, token, previewMaxChars))
      );

      candidates = candidates.map((c, idx) => {
        const previewText = previews[idx] || "";
        const contentMatches = countKeywordPresence(previewText, keywords);
        const score = (c.nameMatches * 3) + (contentMatches * 1);
        return { ...c, contentMatches, score };
      });
    }

    // 5) sort by score desc, then fallback to original order for ties
    candidates.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return 0;
    });

    // debug log top few candidates
    console.log("Ranked candidates (top 10):");
    candidates.slice(0, 10).forEach((c, i) => {
      console.log(`${i + 1}. ${c.name} — score:${c.score} (name:${c.nameMatches}, content:${c.contentMatches})`);
    });

    // 6) choose top N to download fully and send to OpenAI
    const TOP_N = Math.min(3, candidates.length); // change N as needed (1..5)
    const topFiles = candidates.slice(0, TOP_N);

    // download full text for top files in parallel
    const topFullContents = await Promise.all(
      topFiles.map(f => getFileTextContent(f.driveId, f.id, token, null)) // null => full content
    );

    // combine full contents for OpenAI prompt
    const combinedText = topFiles.map((f, idx) => `\n---\nFile: ${f.name}\n${topFullContents[idx] || ""}`).join("\n");

    if (!combinedText.trim()) return res.status(404).json({ error: "No readable content found in top files" });

    // 7) ask OpenAI
    const prompt = `
You are an expert assistant that answers the user's question based ONLY on the SharePoint documents below.
Summarize and answer accurately. If information is not found, reply: "No relevant information found in the documents."

Context:
${combinedText}

Question: ${query}
Answer:
`;

    const completion = await openaiClient.chat.completions.create({
      model: process.env.AZURE_OPENAI_DEPLOYMENT,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
      max_tokens: 500,
    });

    // 8) respond with answer and ranked sources
    res.json({
      answer: completion.choices[0].message.content,
      sources: candidates.map((r) => ({
        name: r.name,
        url: r.webUrl,
        score: r.score,
        nameMatches: r.nameMatches,
        contentMatches: r.contentMatches
      })),
    });

  } catch (err) {
    console.error("ERROR:", err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
