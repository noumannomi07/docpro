import "dotenv/config";
import express from "express";
import cors from "cors";
import { GoogleGenAI } from "@google/genai";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const PDFParser = require("pdf2json");

async function extractPdfText(buffer) {
  return new Promise((resolve, reject) => {
    const parser = new PDFParser(null, 1);
    parser.on("pdfParser_dataReady", () => resolve(parser.getRawTextContent()));
    parser.on("pdfParser_dataError", (err) => reject(err.parserError));
    parser.parseBuffer(buffer);
  });
}

const app = express();
app.use(cors());
app.use(express.json());

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

app.post("/api/analyze-stream", async (req, res) => {
  try {
    const { pdfUrl, question, documentText } = req.body;

    if (!question)
      return res.status(400).json({ error: "A question is required." });

    let apiContents = [];

    if (pdfUrl) {
      // Download PDF from Supabase
      const response = await fetch(pdfUrl);
      if (!response.ok) throw new Error("Failed to download PDF from Supabase");
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      const extractedText = await extractPdfText(buffer);
      apiContents = [
        `Analyze this document:\n"${extractedText}"\n\nQuestion: ${question}. Answer based only on the text provided.`,
      ];
    } else {
      apiContents = [
        `Analyze this document:\n"${documentText || ""}"\n\nQuestion: ${question}. Answer based only on the text provided.`,
      ];
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });

    const responseStream = await ai.models.generateContentStream({
      model: "gemini-2.5-flash",
      contents: apiContents,
    });

    for await (const chunk of responseStream) {
      if (chunk.text)
        res.write(`data: ${JSON.stringify({ text: chunk.text })}\n\n`);
    }

    res.write("data: [DONE]\n\n");
    res.end();
  } catch (error) {
    console.error("Streaming Error:", error);
    res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
    res.end();
  }
});

app.post("/api/extract-metadata", async (req, res) => {
  try {
    const { pdfUrl, documentText } = req.body;
    let text = documentText || "";

    if (pdfUrl) {
      const response = await fetch(pdfUrl);
      if (!response.ok) throw new Error("Failed to download PDF from Supabase");
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      text = await extractPdfText(buffer);
    }

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: `Extract key parameters from this document. Return JSON with exactly these keys:
        - "contractorName" (String or "Unknown")
        - "deadlineDate" (String or "Unknown")
        - "penaltyFeeAmount" (Number or 0)
        - "keyRisks" (Array of strings)

        DOCUMENT: "${text}"`,
      config: { responseMimeType: "application/json" },
    });

    res.json(JSON.parse(response.text));
  } catch (error) {
    console.error("Metadata Extraction Error:", error);
    res.status(500).json({ error: "Failed to extract structured data." });
  }
});
// --- NEW ROUTE: RESUME TAILOR ---
app.post("/api/tailor-resume", async (req, res) => {
  try {
    const { pdfUrl, jobDescription } = req.body;

    if (!pdfUrl || !jobDescription) {
      return res
        .status(400)
        .json({ error: "Missing pdfUrl or jobDescription" });
    }
    if (!pdfUrl.toLowerCase().endsWith(".pdf")) {
      return res.status(400).json({ error: "Only PDF files are supported." });
    }

    const response = await fetch(pdfUrl);
    if (!response.ok) throw new Error("Failed to download CV from Supabase");
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const originalResumeText = await extractPdfText(buffer);

    const resumeSchema = {
      type: "object",
      properties: {
        personalInfo: {
          type: "object",
          properties: {
            fullName: { type: "string" },
            title: { type: "string" }, // e.g., "Frontend Web Developer"
            email: { type: "string" },
            phone: { type: "string" },
            github: { type: "string" },
            linkedin: { type: "string" },
          },
          required: ["fullName", "title"],
        },
        summary: { type: "string" }, // 3-4 sentence professional summary tailored to the JD
        skills: {
          type: "array",
          items: { type: "string" }, // List of ATS-relevant skills matching the JD
        },
        experience: {
          type: "array",
          items: {
            type: "object",
            properties: {
              company: { type: "string" },
              role: { type: "string" },
              duration: { type: "string" }, // e.g., "Jan 2024 - Present"
              bulletPoints: {
                type: "array",
                items: { type: "string" }, // 3-4 action-oriented, metric-driven bullet points
              },
            },
            required: ["company", "role", "duration", "bulletPoints"],
          },
        },
        education: {
          type: "array",
          items: {
            type: "object",
            properties: {
              institution: { type: "string" },
              degree: { type: "string" },
              graduationYear: { type: "string" },
            },
            required: ["institution", "degree", "graduationYear"],
          },
        },
      },
      required: [
        "personalInfo",
        "summary",
        "skills",
        "experience",
        "education",
      ],
    };

    const prompt = `
  You are an expert ATS resume writer and recruiter. 
  Your task is to analyze the user's Original Resume and the Target Job Description provided below.
  Rewrite and optimize the resume so it is highly relevant to the Target Job Description.
  
  CRITICAL INSTRUCTIONS:
  - Naturally integrate high-impact keywords and technical skills from the Job Description.
  - Rewrite professional experience bullet points using the Google X-Y-Z formula (Accomplished [X], as measured by [Y], by doing [Z]).
  - Keep all contact details (email, phone, etc.) from the original resume.
  - Ensure the output fits a clean, single-page format. Do not inflate achievements.
  - The "summary" field MUST be exactly 3-4 sentences maximum. No longer.
  
  Original Resume:
  ${originalResumeText}
  
  Target Job Description:
  ${jobDescription}
`;

    // 5. Call Gemini expecting a structured JSON response
    const aiResponse = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: resumeSchema,
      },
    });

    // 6. Parse and send the clean JSON directly back to your React frontend!
    const tailoredResumeData = JSON.parse(aiResponse.text);
    res.json(tailoredResumeData);
  } catch (error) {
    console.error("Tailor Resume Error:", error);
    res.status(500).json({ error: "Failed to optimize and tailor resume." });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () =>
  console.log(`🚀 Server running on port ${PORT}`),
);
