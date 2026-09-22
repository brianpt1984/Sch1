'use strict';
require('dotenv').config();

const Anthropic = require('@anthropic-ai/sdk');
const OpenAI = require('openai');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { fetchSnapshot, snapshotToText } = require('./snapshot');
const { checkConvergence } = require('./convergence');

const MAX_ROUNDS = 4;
const MODEL_IDS = {
  claude: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
  gpt: process.env.OPENAI_MODEL || 'gpt-4o',
  gemini: process.env.GOOGLE_MODEL || 'gemini-1.5-pro',
};
const MODEL_LABELS = { claude: 'Claude', gpt: 'GPT-4o', gemini: 'Gemini' };

// ---------- Prompting ----------

function systemPrompt(label) {
  return `You are ${label}, a sharp quantitative analyst in a live three-way market debate.

Rules:
1. Identify ONE specific trade opportunity — name the exact asset and direction (bullish or bearish).
2. Critically engage with what the other analysts said. Challenge weak logic, reinforce strong points with new evidence, or pivot if convinced. Never just restate without engaging.
3. Keep your analysis to 150–220 words. Direct, precise, no filler.

At the END of your response, append exactly this block (no code fences, fill in the values):
<POSITION>
{"asset":"BTC","direction":"bullish","confidence":"high","thesis":"one sentence max"}
</POSITION>

Valid directions: bullish, bearish. Valid confidence: high, medium.`;
}

function buildUserMessage(snapshotText, completedRounds, currentRoundTurns, roundNum) {
  const historyParts = [];

  for (const r of completedRounds) {
    for (const t of r.turns) {
      historyParts.push(`[${MODEL_LABELS[t.model].toUpperCase()} — Round ${r.roundNumber}]\n${t.content}`);
    }
  }
  for (const t of currentRoundTurns) {
    historyParts.push(`[${MODEL_LABELS[t.model].toUpperCase()} — Round ${roundNum}]\n${t.content}`);
  }

  if (historyParts.length === 0) {
    return `${snapshotText}\n\nRound 1 — Opening. Give your first take.`;
  }

  const history = historyParts.join('\n\n---\n\n');
  return `${snapshotText}\n\n--- DEBATE SO FAR ---\n\n${history}\n\n--- YOUR TURN (Round ${roundNum}) ---\nEngage with the arguments above. Be direct.`;
}

// ---------- Model callers ----------

async function callClaude(userMessage) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const msg = await client.messages.create({
    model: MODEL_IDS.claude,
    max_tokens: 700,
    system: systemPrompt('Claude'),
    messages: [{ role: 'user', content: userMessage }],
  });
  return msg.content[0].text;
}

async function callGPT(userMessage) {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const res = await client.chat.completions.create({
    model: MODEL_IDS.gpt,
    max_tokens: 700,
    messages: [
      { role: 'system', content: systemPrompt('GPT-4o') },
      { role: 'user', content: userMessage },
    ],
  });
  return res.choices[0].message.content;
}

async function callGemini(userMessage) {
  const genai = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
  const model = genai.getGenerativeModel({
    model: MODEL_IDS.gemini,
    systemInstruction: systemPrompt('Gemini'),
  });
  const result = await model.generateContent({
    contents: [{ role: 'user', parts: [{ text: userMessage }] }],
  });
  return result.response.text();
}

const callers = { claude: callClaude, gpt: callGPT, gemini: callGemini };

// ---------- Position extraction ----------

function extractPosition(text) {
  const m = text.match(/<POSITION>\s*([\s\S]*?)\s*<\/POSITION>/i);
  if (!m) return null;
  try {
    return JSON.parse(m[1].trim());
  } catch {
    const asset = m[1].match(/"asset"\s*:\s*"([^"]+)"/i)?.[1];
    const dir = m[1].match(/"direction"\s*:\s*"([^"]+)"/i)?.[1];
    const thesis = m[1].match(/"thesis"\s*:\s*"([^"]+)"/i)?.[1];
    return asset && dir ? { asset, direction: dir, thesis: thesis || '' } : null;
  }
}

// ---------- SSE helpers ----------

function notify(session, event) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of session._listeners || []) {
    try { res.write(data); } catch {}
  }
}

// ---------- Main orchestrator ----------

async function startDebate(sessionId, sessions) {
  const session = sessions.get(sessionId);

  try {
    // Phase 1: fetch data
    session.status = 'fetching';
    notify(session, { type: 'status', status: 'fetching' });

    const snapshot = await fetchSnapshot();
    session.snapshot = snapshot;
    const snapshotText = snapshotToText(snapshot);

    session.status = 'debating';
    notify(session, { type: 'snapshot', snapshot, snapshotText, status: 'debating' });

    // Phase 2: debate rounds
    for (let roundNum = 1; roundNum <= MAX_ROUNDS; roundNum++) {
      const round = { roundNumber: roundNum, turns: [] };
      session.rounds.push(round);
      notify(session, { type: 'round-start', roundNumber: roundNum });

      for (const model of ['claude', 'gpt', 'gemini']) {
        notify(session, { type: 'turn-start', model, roundNumber: roundNum });

        const userMessage = buildUserMessage(
          snapshotText,
          session.rounds.slice(0, -1),
          round.turns,
          roundNum,
        );

        const content = await callers[model](userMessage);
        const position = extractPosition(content);
        const turn = { model, content, position, timestamp: new Date().toISOString() };
        round.turns.push(turn);

        notify(session, { type: 'turn', model, roundNumber: roundNum, content, position, timestamp: turn.timestamp });
      }

      // Phase 3: convergence check after full round
      const conv = checkConvergence(round.turns);
      round.converged = conv.converged;
      notify(session, { type: 'round-end', roundNumber: roundNum, convergence: conv });

      if (conv.converged) {
        session.status = 'converged';
        session.consensus = conv;
        notify(session, { type: 'done', status: 'converged', consensus: conv });
        return;
      }
    }

    // Phase 4: max rounds hit — derive best-effort conclusion
    const lastPositions = {};
    for (const r of session.rounds)
      for (const t of r.turns)
        if (t.position) lastPositions[t.model] = t.position;

    const assetVotes = {};
    for (const pos of Object.values(lastPositions)) {
      const key = `${(pos.asset || '').toUpperCase()}:${(pos.direction || '').toLowerCase()}`;
      assetVotes[key] = (assetVotes[key] || 0) + 1;
    }
    const top = Object.entries(assetVotes).sort((a, b) => b[1] - a[1])[0];
    const [topAsset, topDir] = (top?.[0] || ':').split(':');

    session.status = 'timeout';
    session.consensus = {
      converged: false,
      asset: topAsset || null,
      direction: topDir || null,
      supportCount: top?.[1] || 0,
      summary: `No convergence after ${MAX_ROUNDS} rounds. Most supported view: ${topAsset || 'unclear'} ${topDir || ''} (${top?.[1] || 0}/3 models).`,
      positions: lastPositions,
    };
    notify(session, { type: 'done', status: 'timeout', consensus: session.consensus });

  } catch (err) {
    session.status = 'error';
    session.error = err.message;
    notify(session, { type: 'error', message: err.message });
    throw err;
  }
}

module.exports = { startDebate };
