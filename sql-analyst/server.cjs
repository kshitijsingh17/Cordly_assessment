// Basic Express server setup for multi-agent chatbot backend
const express = require('express');
const multer = require('multer');
const mongoose = require('mongoose');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();

const app = express();
const upload = multer({ dest: 'uploads/' });
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();

app.use(cors());
app.use(express.json());

// --- API ROUTES ---
// Upload DB file endpoint
app.post('/upload', upload.single('dbfile'), (req, res) => {
  uploadedDbPath = path.join(__dirname, 'uploads', req.file.filename);
  console.log('[POST /upload] File uploaded:', req.file);
  console.log('[POST /upload] uploadedDbPath set to:', uploadedDbPath);
  res.json({ success: true, filename: req.file.filename });
});

// Gemini Flash API call (Google AI Studio endpoint)
async function callGeminiFlash({ schema, question }) {
  const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;
  try {
    // Use the prompt as provided by the agent (already includes schema DDL if needed)
    const prompt = question;
    const res = await axios.post(GEMINI_API_URL, {
      contents: [{ parts: [{ text: prompt }] }]
    }, {
      headers: {
        'Content-Type': 'application/json'
      }
    });
    const output = res.data.candidates?.[0]?.content?.parts?.[0]?.text || '-- No query generated';
    console.log('\x1b[36m[Gemini Output]\x1b[0m', output); // Cyan color for visibility
    return output;
  } catch (err) {
    console.log('[Gemini Error]', err.message);
    return '-- Gemini Flash API error: ' + err.message;
  }
}

const INSIGHT_DIR = path.join(__dirname, 'insights');
if (!fs.existsSync(INSIGHT_DIR)) fs.mkdirSync(INSIGHT_DIR);

// --- AGENT ENVIRONMENT (Schema Context) ---
let agentSchema = null;

// Utility to set schema from DB file
async function setAgentSchemaFromDb(dbPath) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath);
    db.all("SELECT name, sql FROM sqlite_master WHERE type='table'", (err, rows) => {
      db.close();
      if (err) reject(err);
      else {
        agentSchema = rows;
        console.log('[setAgentSchemaFromDb] agentSchema assigned:', agentSchema);
        resolve(rows);
      }
    });
  });
}

// Utility: Convert schema array to DDL string
function getSchemaDDL(schema) {
  if (!schema || !Array.isArray(schema)) return '';
  return schema.map(tbl => tbl.sql).filter(Boolean).join('\n\n');
}

// --- AGENT FUNCTIONS ---

// MainTriageAgent: Decides what to do (AI)
async function MainTriageAgent({ schema, historyText, message }) {
  const schemaDDL = getSchemaDDL(schema);
  const prompt = `Conversation history:\n${historyText}\n\nGiven the following SQLite schema:\n${schemaDDL}\nAnd the user question: "${message}"
Respond in JSON: { action: 'query'|'noquery', multi: true|false, subtask: string|array, visualization: true|false, reason: string|null }\n- If a query is needed, set action to 'query' and describe the subtask(s).\n- If not, set action to 'noquery'.\n- If visualization is needed, set visualization to true.`;
  let raw = await callGeminiFlash({ schema: schemaDDL, question: prompt });
  console.log('\x1b[35m[MainTriageAgent Gemini Raw]\x1b[0m', raw);
  try {
    return JSON.parse(raw.replace(/```json|```/g, '').trim());
  } catch {
    return { action: 'noquery', multi: false, subtask: '', visualization: false, reason: '' };
  }
}

// SQLQueryAgent: Generates SQL for a subtask (AI)
async function SQLQueryAgent({ schema, subtask, multi }) {
  const schemaDDL = getSchemaDDL(schema);
  if (multi) {
    const prompt = `Given the following SQLite schema:\n${schemaDDL}\nGenerate valid SQLite SELECT queries for each of these subtasks: ${JSON.stringify(subtask)}. Respond in JSON: { sqls: [ {sql: 'SQL QUERY', rationale: 'why this query'} ] }`;
    let raw = await callGeminiFlash({ schema: schemaDDL, question: prompt });
    console.log('\x1b[35m[SQLQueryAgent Gemini Multi Raw]\x1b[0m', raw);
    try {
      return JSON.parse(raw.replace(/```json|```/g, '').trim());
    } catch {
      return { sqls: [] };
    }
  } else {
    const prompt = `Given the following SQLite schema:\n${schemaDDL}\nGenerate a valid SQLite SELECT query for: ${subtask}. Respond in JSON: { sql: 'SQL QUERY', rationale: 'why this query' }`;
    let raw = await callGeminiFlash({ schema: schemaDDL, question: prompt });
    console.log('\x1b[35m[SQLQueryAgent Gemini Raw]\x1b[0m', raw);
    try {
      return JSON.parse(raw.replace(/```json|```/g, '').trim());
    } catch {
      return { sql: raw, rationale: '' };
    }
  }
}

// InsightAgent: Describes SQL results (if no error)
async function InsightAgent({ schema, message, sqlResult }) {
  const schemaDDL = getSchemaDDL(schema);
  // Only ask for a markdown summary/insight of the SQL result, do NOT mention the SQL/query itself
  const prompt = `Given the following SQLite schema:\n${schemaDDL}\nUser question: \"${message}\"\nSQL result: ${JSON.stringify(sqlResult)}\nGenerate a markdown summary and insight for the user, but do NOT mention the SQL query or show any SQL. Respond in JSON: {markdown: string, summary: string}`;
  let raw = await callGeminiFlash({ schema: schemaDDL, question: prompt });
  console.log('\x1b[35m[InsightAgent Gemini Raw]\x1b[0m', raw);
  try {
    return JSON.parse(raw.replace(/```json|```/g, '').trim());
  } catch {
    return { markdown: raw, summary: '' };
  }
}

// ClarificationAgent: Only called if SQL execution error
async function ClarificationAgent({ schema, message, error }) {
  const schemaDDL = getSchemaDDL(schema);
  const prompt = `Given the following SQLite schema:\n${schemaDDL}\nUser question: "${message}"\nSQL error: ${error}\nAsk a clarifying question to help the user fix the issue. Respond in JSON: { clarification: string }`;
  let raw = await callGeminiFlash({ schema: schemaDDL, question: prompt });
  console.log('\x1b[35m[ClarificationAgent Gemini Raw]\x1b[0m', raw);
  try {
    return JSON.parse(raw.replace(/```json|```/g, '').trim());
  } catch {
    return { clarification: raw };
  }
}

// VisualizerAgent: Only called if visualization is needed
async function VisualizerAgent({ schema, sqlResult, insight }) {
  const schemaDDL = getSchemaDDL(schema);
  // Force Gemini to always return a chart if visualization is requested, and set a reasonable scale
  const prompt = `Given the following SQLite schema:\n${schemaDDL}\nSQL result: ${JSON.stringify(sqlResult)}\nInsight: ${JSON.stringify(insight)}\nA chart or visualization is required. Always respond in JSON: { chartType: string, chartData: { x: string, y: string, data: array }, chartDescription: string, scale?: object }.\n- chartType should be 'bar', 'scatter', or another supported type.\n- chartData.x and chartData.y are the axis keys.\n- chartData.data is an array of objects for plotting.\n- chartDescription is a short description of the chart.\n- scale (optional) should be an object with min and max for axes if the data range is large, e.g. { x: { min: 0, max: 100 }, y: { min: 0, max: 1000 } }.`;
  let raw = await callGeminiFlash({ schema: schemaDDL, question: prompt });
  console.log('\x1b[35m[VisualizerAgent Gemini Raw]\x1b[0m', raw);
  try {
    return JSON.parse(raw.replace(/```json|```/g, '').trim());
  } catch {
    return { chartType: null };
  }
}

// ResponseFormatterAgent: formats the final response
function ResponseFormatterAgent({ insight, clarification, visualization, visualizationRequested }) {
  if (clarification) {
    return { type: 'clarification', content: clarification, chart: null };
  }
  if (visualizationRequested && visualization && visualization.chartType) {
    // If visualization was requested and a chart is available, render both markdown and chart
    return { type: 'markdown+chart', content: insight.markdown, chart: visualization };
  }
  if (visualization && visualization.chartType) {
    // Fallback: if chart exists but not explicitly requested, still show both
    return { type: 'markdown+chart', content: insight.markdown, chart: visualization };
  }
  return { type: 'text', content: insight.markdown, chart: null };
}

// SQLExecutor: Executes SQL and returns rows or error
async function SQLExecutor({ db, sql }) {
  return new Promise((resolve) => {
    db.all(sql, (err, rows) => {
      if (err) {
        resolve({ error: err.message, rows: [] });
      } else {
        resolve({ error: null, rows });
      }
    });
  });
}

// Utility: Clean up markdown before sending to frontend
function cleanMarkdownResponse(markdown) {
  if (!markdown || typeof markdown !== 'string') return markdown;
  let cleaned = markdown;
  // Remove fenced code blocks with SQL/DDL/schema
  cleaned = cleaned.replace(/```(sql|ddl|schema|json)?[\s\S]*?```/gi, '');
  // Remove markdown tables with more than 10 rows
  cleaned = cleaned.replace(/((?:\|.+\|\n)+)(?=\n\n|$)/g, (table) => {
    const rows = table.split('\n').filter(r => r.trim().startsWith('|'));
    return rows.length > 12 ? '' : table;
  });
  // Remove lines starting with technical headers
  cleaned = cleaned.replace(/^ *(Schema|Table|DDL|Columns|CREATE TABLE|--).*$/gim, '');
  // Remove excessive blank lines
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
  // Trim
  return cleaned.trim();
}

// --- MAIN CHAT ENDPOINT (refactored to use new pipeline) ---
app.post('/chat', async (req, res) => {
  console.log('[POST /chat] Incoming:', req.body);
  const { user, message } = req.body;
  let response = 'Sorry, no database uploaded.';
  let downloadUrl = null;
  let responseType = 'text';
  // Fetch last 10 chat messages for this user for context
  let history = await Chat.find({ user }).sort({ createdAt: -1 }).limit(10);
  history = history.reverse(); // oldest first
  const historyText = history.map(h => `User: ${h.message}\nAI: ${h.response}`).join('\n');
  if (uploadedDbPath && fs.existsSync(uploadedDbPath)) {
    try {
      // 1. Set agent schema ONCE if not set or if DB changed
      if (!agentSchema || agentSchema.__dbPath !== uploadedDbPath) {
        await setAgentSchemaFromDb(uploadedDbPath);
        if (agentSchema) agentSchema.__dbPath = uploadedDbPath;
        console.log('[SCHEMA LOADED]', agentSchema);
      }
      if (!agentSchema) {
        response = 'Error: No schema could be loaded from the uploaded database. Please check your file.';
        res.json({ response });
        const chat = new Chat({ user, message, response });
        await chat.save();
        return;
      }
      console.log('[SCHEMA PASSED TO TRIAGE]', agentSchema);
      // 2. MainTriageAgent: decide what to do
      const triage = await MainTriageAgent({ schema: agentSchema, historyText, message });
      let insight = null;
      let clarification = null;
      let visualization = null;
      let sqlResult = null;
      if (triage.action === 'noquery') {
        // No query needed, just generate insight from the message
        insight = await InsightAgent({ schema: agentSchema, message, sqlResult: null });
      } else if (triage.action === 'query') {
        // Generate SQL (single or multi)
        const sqlGen = await SQLQueryAgent({ schema: agentSchema, subtask: triage.subtask, multi: triage.multi });
        // Execute SQL(s)
        let results = [];
        let error = null;
        if (triage.multi && sqlGen.sqls) {
          for (const sqlObj of sqlGen.sqls) {
            const db = new sqlite3.Database(uploadedDbPath);
            const exec = await SQLExecutor({ db, sql: sqlObj.sql });
            db.close();
            if (exec.error) {
              error = exec.error;
              break;
            }
            results.push(exec.rows);
          }
          sqlResult = results;
        } else {
          const db = new sqlite3.Database(uploadedDbPath);
          const exec = await SQLExecutor({ db, sql: sqlGen.sql });
          db.close();
          if (exec.error) {
            error = exec.error;
          } else {
            sqlResult = exec.rows;
          }
        }
        if (error) {
          // Error: go to ClarificationAgent
          const clar = await ClarificationAgent({ schema: agentSchema, message, error });
          clarification = clar.clarification;
        } else {
          // No error: go to InsightAgent
          insight = await InsightAgent({ schema: agentSchema, message, sqlResult });
        }
      }
      // Visualization if needed and no clarification
      if (triage.visualization && !clarification && insight) {
        visualization = await VisualizerAgent({ schema: agentSchema, sqlResult, insight });
      }
      // Format final response
      let formatted = ResponseFormatterAgent({ insight, clarification, visualization, visualizationRequested: triage.visualization });
      response = formatted.content;
      responseType = formatted.type;
      // If the response is markdown (from insight), set responseType to 'markdown' or 'markdown+chart'
      if ((formatted.type === 'text' || formatted.type === 'markdown+chart') && insight && insight.markdown) {
        responseType = formatted.type;
      }
      // Clean up markdown if needed
      if (responseType && (responseType === 'markdown' || responseType === 'markdown+chart')) {
        response = cleanMarkdownResponse(response);
      }
      const finalJson = { response, chart: formatted.chart, downloadUrl, responseType };
      console.log('[POST /chat] Sending final JSON to frontend:', JSON.stringify(finalJson, null, 2));
      res.json(finalJson);
      const chat = new Chat({ user, message, response });
      await chat.save();
      return;
    } catch (err) {
      response = 'Error processing database: ' + err.message;
      console.log('[POST /chat] Error:', err);
    }
  } else {
    console.log('[POST /chat] No DB uploaded or file missing.');
  }
  // Save chat to MongoDB
  const chat = new Chat({ user, message, response });
  await chat.save();
  console.log('[POST /chat] Sending response:', { response });
  res.json({ response });
});

// Serve static files from the frontend build
app.use(express.static(path.join(__dirname, 'dist')));

// SPA fallback for client-side routing
app.get('/{*any}', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

// Connect to MongoDB and start server
mongoose.connect(MONGODB_URL, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
  })
  .catch(err => console.error('MongoDB connection error:', err));
