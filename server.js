import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { GoogleGenAI } from '@google/genai';

async function extractPdfText(buffer) {
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(buffer) });
  const pdf = await loadingTask.promise;
  let text = '';
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    text += content.items.map(item => item.str).join(' ') + '\n';
  }
  return text;
}

const app = express();
app.use(cors());
app.use(express.json());

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const upload = multer({ storage: multer.memoryStorage() });

async function parsePdfBuffer(buffer) {
  // Convert Node buffer to Uint8Array which pdfjs-dist expects
  const data = new Uint8Array(buffer);
  
  // Import pdfjs dynamically using the Node-safe legacy build
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  
  const loadingTask = pdfjs.getDocument({ data });
  const pdf = await loadingTask.promise;
  let extractedText = '';

  // Loop through every page and extract text items
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const textContent = await page.getTextContent();
    const pageText = textContent.items.map((item) => item.str).join(' ');
    extractedText += pageText + '\n';
  }

  return extractedText;
}

app.post('/api/analyze-stream', upload.single('file'), async (req, res) => {
  try {
    const question = req.body.question;
    let documentText = req.body.documentText || '';
    let apiContents = []; // This will hold what we send to Gemini

    if (!question) {
      return res.status(400).json({ error: 'A question is required.' });
    }

    // Check if a file was uploaded
    if (req.file) {
      const mimeType = req.file.mimetype;

      if (mimeType === 'application/pdf') {
        // Use your working pdfjs-dist logic here to extract text
        const extractedText = await parsePdfBuffer(req.file.buffer); // (Your PDF helper function)
        apiContents = [
          `Analyze this document: \n"${extractedText}"\n\nQuestion: ${question}. Answer based only on the text provided.`
        ];
      } 
      else if (mimeType.startsWith('image/')) {
        // IT'S AN IMAGE! Convert binary buffer to Base64
        const base64Data = req.file.buffer.toString('base64');
        
        const imagePart = {
          inlineData: {
            data: base64Data,
            mimeType: mimeType
          }
        };

        // Pass both the image data and the text question directly to Gemini!
        apiContents = [
          imagePart,
          `Analyze this image. Answer this question based on what you see: ${question}`
        ];
      } 
      else {
        return res.status(400).json({ error: 'Unsupported file type. Upload a PDF or an image.' });
      }
    } else {
      // If no file, fall back to pasted raw text
      apiContents = [
        `Analyze this document: \n"${documentText}"\n\nQuestion: ${question}. Answer based only on the text provided.`
      ];
    }

    // Set up standard HTTP SSE headers for streaming
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
    });

    // Call Gemini Stream with our dynamic contents (can be text OR image data!)
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
    res.write(`data: ${JSON.stringify({ error: 'Failed to generate AI stream.' })}\n\n`);
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
      config: {
        responseMimeType: 'application/json'
      }
    });

    const structuredData = JSON.parse(response.text);
    res.json(structuredData);
  } catch (error) {
    console.error('Metadata Extraction Error:', error);
    res.status(500).json({ error: 'Failed to extract structured data.' });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 Advanced Backend running on http://localhost:${PORT}`));