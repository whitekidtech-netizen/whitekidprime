/*
 * ╔══════════════════════════════════════════════════════╗
 * ║        WHITEKID PRIME - Entry Point (index.js)       ║
 * ║      Web pairing portal + bot router (v5.2.1)        ║
 * ╚══════════════════════════════════════════════════════╝
 */
'use strict';

// ─── AUTO-INSTALL MISSING MODULES ────────────────────────────────────────────
const { execSync, exec } = require('child_process');
const fs = require('fs');
const path = require('path');

// { name: what to require.resolve, spec: what to npm install }
const REQUIRED_MODULES = [
  ['@whiskeysockets/baileys'], ['@octokit/rest'], ['@distube/ytdl-core'],
  ['@vitalets/google-translate-api'], ['axios'], ['cheerio'], ['express'],
  ['fluent-ffmpeg'], ['form-data'], ['fs-extra'], ['megajs'], ['moment-timezone'],
  ['node-fetch'], ['node-telegram-bot-api'], ['openai'], ['pino'], ['qrcode'],
  ['sharp'], ['wa-sticker-formatter'], ['yt-search'], ['acrcloud'],
  ['chalk', 'chalk@4.1.2'] // v4 = CommonJS (v5 is ESM-only and breaks require)
];

function checkAndInstall() {
  const missing = [];
  for (const [name, spec] of REQUIRED_MODULES) {
    try { require.resolve(name); } catch { missing.push(spec || name); }
  }
  if (missing.length > 0) {
    console.log(`\n📦 Installing ${missing.length} missing module(s): ${missing.join(', ')}\n`);
    try {
      execSync(`npm install ${missing.join(' ')} --save --legacy-peer-deps`, { stdio: 'inherit' });
      console.log('\n✅ All modules installed successfully!\n');
    } catch (e) {
      console.error('❌ Auto-install failed. Please run: npm install');
      console.error(e.message);
    }
  } else {
    console.log('✅ All required modules are present.');
  }
}

checkAndInstall();

// ─── BOOTSTRAP EXPRESS APP ────────────────────────────────────────────────────
const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

app.set('trust proxy', 1);          // correct client IPs behind Render / Nginx / Cloudflare
app.disable('x-powered-by');
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Basic security headers
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
  });
  next();
});

// ─── WEB PAIRING PORTAL ───────────────────────────────────────────────────────
// "/" serves the pairing page. "/?number=..." still hits the raw bot API (backwards compatible).
app.get('/', (req, res, next) => {
  if (req.query.number) return next();
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'), err => { if (err) next(err); });
});
app.use(express.static(PUBLIC_DIR, { index: false, maxAge: '1h' }));

// ─── SAFE PAIRING API ─────────────────────────────────────────────────────────
// Validates the number, rate-limits, blocks duplicate requests and always answers
// with clean JSON: { code } | { status: 'already_connected' } | { error }
const hits = new Map();
const pending = new Set();

function rateLimit(key, max, windowMs) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter(t => now - t < windowMs);
  if (arr.length >= max) { hits.set(key, arr); return Math.ceil((windowMs - (now - arr[0])) / 1000); }
  arr.push(now);
  hits.set(key, arr);
  return 0;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, arr] of hits) { const f = arr.filter(t => now - t < 15 * 60 * 1000); f.length ? hits.set(k, f) : hits.delete(k); }
}, 5 * 60 * 1000).unref();

let botRouter;
try {
  botRouter = require('./pair');
  console.log('✅ pair.js loaded.');
} catch (err) {
  console.error('❌ Failed to load pair.js:', err.message);
  process.exit(1);
}

app.get('/api/pair', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  const number = String(req.query.number || '').replace(/\D/g, '');
  if (number.length < 8 || number.length > 15) {
    return res.status(400).json({ error: 'Enter a valid number with country code (8–15 digits).' });
  }
  if (pending.has(number)) {
    return res.status(409).json({ error: 'A code is already being generated for this number. Please wait a moment.' });
  }
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  let wait = rateLimit('ip:' + ip, 8, 10 * 60 * 1000);
  if (!wait) wait = rateLimit('num:' + number, 4, 10 * 60 * 1000);
  if (wait) {
    res.set('Retry-After', String(wait));
    return res.status(429).json({ error: `Too many attempts. Try again in ${Math.ceil(wait / 60)} min.`, retryAfter: wait });
  }

  pending.add(number);
  const timer = setTimeout(() => {
    if (!res.headersSent) res.status(504).json({ error: 'WhatsApp took too long to respond. Please try again.' });
  }, 60000);
  const done = () => { pending.delete(number); clearTimeout(timer); };
  res.on('finish', done);
  res.on('close', done);

  // Turn "{ code: undefined }" into a proper error instead of an empty reply
  const origSend = res.send.bind(res);
  res.send = body => {
    if (body && typeof body === 'object' && !Buffer.isBuffer(body) && 'code' in body && !body.code) {
      res.status(502);
      return origSend({ error: 'WhatsApp did not return a code. Check the number and try again.' });
    }
    return origSend(body);
  };

  req.url = '/?number=' + number;
  botRouter(req, res, next);
});

// ─── LOAD MAIN BOT ROUTER ─────────────────────────────────────────────────────
app.use('/', botRouter);

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'online',
    bot: 'whitekid-prime',
    version: '5.2.1',
    developer: 'WhiteKid Tech',
    timestamp: new Date().toISOString()
  });
});

// ─── 404 HANDLER ─────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found', bot: 'whitekid prime v5.2.1' });
});

// ─── GLOBAL ERROR HANDLER ────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('Express error:', err.message);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Internal server error' });
});

// ─── START SERVER ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 Whitekid Prime server running on port ${PORT}`);
  console.log(`🌐 Pairing portal: http://localhost:${PORT}/`);
  console.log(`❤️  Health:         http://localhost:${PORT}/health\n`);
});

// ─── PROCESS HANDLERS ────────────────────────────────────────────────────────
process.on('uncaughtException', (err) => {
  console.error('🔴 UncaughtException:', err.message);
  exec(`pm2 restart ${process.env.PM2_NAME || 'Prime'}`, () => {});
});

process.on('unhandledRejection', (reason) => {
  console.error('🔴 UnhandledRejection:', reason);
});

module.exports = app;
