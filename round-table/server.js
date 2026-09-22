'use strict';
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { startDebate } = require('./orchestrator');

const app = express();
app.use(cors());
app.use(express.json());

// In-memory session store
const sessions = new Map();

// ----- Session API -----

app.post('/api/session/start', (req, res) => {
  const id = uuidv4();
  sessions.set(id, {
    id,
    status: 'starting',
    rounds: [],
    snapshot: null,
    consensus: null,
    error: null,
    createdAt: new Date().toISOString(),
    _listeners: [],
  });

  res.json({ sessionId: id });

  startDebate(id, sessions).catch(err => {
    console.error(`[${id}] debate error:`, err.message);
  });
});

app.get('/api/sessions', (req, res) => {
  const list = Array.from(sessions.values())
    .map(({ _listeners, ...s }) => s)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(list);
});

app.get('/api/session/:id', (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Session not found' });
  const { _listeners, ...safe } = s;
  res.json(safe);
});

// ----- SSE stream -----

app.get('/api/session/:id/stream', (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Session not found' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Hydrate with current state immediately
  const { _listeners, ...safe } = s;
  res.write(`data: ${JSON.stringify({ type: 'hydrate', session: safe })}\n\n`);

  s._listeners.push(res);

  req.on('close', () => {
    s._listeners = s._listeners.filter(l => l !== res);
  });
});

// ----- Static dashboard -----

app.use(express.static(path.join(__dirname)));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Round Table running → http://localhost:${PORT}/dashboard.html`);
  console.log(`Models: Claude=${process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6'}, GPT=${process.env.OPENAI_MODEL || 'gpt-4o'}, Gemini=${process.env.GOOGLE_MODEL || 'gemini-1.5-pro'}`);
});
