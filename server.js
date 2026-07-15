import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { GoogleGenAI } from '@google/genai';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const PDFParser = require('pdf2json');

async function extractPdfText(buffer) {
  return new Promise((resolve, reject) => {
    const parser = new PDFParser(null, 1);
    parser.on('pdfParser_dataReady', () => {
      resolve(parser.getRawTextContent());
    });
    parser.on('pdfParser_dataError', (err) => {
      reject(err.parserError);
    });
    parser.parseBuffer(buffer);
  });
}

const app = express();
app.use(cors());
app.use(express.json());

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const upload = multer({ storage: multer.memoryStorage() });

app.post('/api/analyze-stream', upload.single('file'), async (req, res) => {
  try {
    const question = req.body.question;
    let documentText = req.body.documentText || '';
    let apiContents = [];

    if (!question) {
      return res.status(400).json({ error: 'A question is required.' });
    }

    if (req.file) {
      const mimeType = req.file.mimetype;

      if (mimeType === 'application/pdf') {
        const extractedText = await extractPdfText(req.file.buffer);
        apiContents = [
          `Analyze this document: \n"${extractedText}"\n\nQuestion: ${question}. Answer based only on the text provided.`
        ];
      } else if (mimeType.startsWith('image/')) {
        const base64Data = req.file.buffer.toString('base64');
        apiContents = [
          { inlineData: { data: base64Data, mimeType } },
          `Analyze this image. Answer this question based on what you see: ${question}`
        ];
      } else {
        return res.status(400).json({ error: 'Unsupported file type.' });
      }
    } else {
      apiContents = [
        `Analyze this document: \n"${documentText}"\n\nQuestion: ${question}. Answer based only on the text provided.`
      ];
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
    });

    const responseStream = await ai.models.generateContentStream({
      model: 'gemini-2.5-flash',
      contents: apiContents,
    });

    for await (const chunk of responseStream) {
      if (chunk.text) {
        res.write(`data: ${JSON.stringify({ text: chunk.text })}\n\n`);
      }
    }

    res.write('data: [DONE]\n\n');
    res.end();
  } catch (error) {
    console.error('Streaming Error:', error);
    res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
    res.end();
  }
});

app.post('/api/extract-metadata', upload.single('file'), async (req, res) => {
  try {
    let documentText = req.body.documentText || '';

    if (req.file) {
      documentText = await extractPdfText(req.file.buffer);
    }

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: `
        Extract the key parameters from this document. Return a JSON object with these exact keys:
        - "contractorName" (String or "Unknown")
        - "deadlineDate" (String or "Unknown")
        - "penaltyFeeAmount" (Number or 0)
        - "keyRisks" (Array of strings)

        DOCUMENT:
        "${documentText}"
      `,
      config: { responseMimeType: 'application/json' }
    });

    const structuredData = JSON.parse(response.text);
    res.json(structuredData);
  } catch (error) {
    console.error('Metadata Extraction Error:', error);
    res.status(500).json({ error: 'Failed to extract structured data.' });
  }
});
app.get('/debug', (req, res) => {
  res.json({
    hasKey: !!process.env.GEMINI_API_KEY,
    keyStart: process.env.GEMINI_API_KEY?.slice(0, 8) || 'NOT FOUND',
    allEnvKeys: Object.keys(process.env).filter(k => k.includes('GEMINI'))
  });
});
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));