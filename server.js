/*
 * server.js — رادار العروض
 * - يقرأ القنوات العامة على تليجرام كل بضع ثوانٍ
 * - يحلل كل رسالة جديدة إلى عرض
 * - يبث العروض فوراً لكل الصفحات المفتوحة عبر Server-Sent Events
 * - يستقبل رسائل من مصادر أخرى (واتساب عبر جسر خارجي) على POST /ingest
 * بدون أي مكتبات خارجية. يحتاج Node 18 أو أحدث.
 */
'use strict';

const __resolve = (function () {
'use strict';
/*
 * resolve.js
 * يتتبع الروابط المختصرة (مثل 3rrood.com) ليعرف المتجر النهائي.
 * حماية من SSRF: لا يتصل بأي عنوان داخلي أو خاص، ويتحقق من كل قفزة.
 * لا يرجع محتوى أي صفحة لأحد، يستخرج فقط عنوان التحويل.
 */
const dns = require('dns').promises;
const net = require('net');

const UA = 'Mozilla/5.0 (compatible; DealsRadar/1.0)';

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const p = ip.split('.').map(Number);
    const a = p[0], b = p[1];
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const x = ip.toLowerCase();
    if (x === '::1' || x === '::') return true;
    if (/^(fc|fd|fe8|fe9|fea|feb)/.test(x)) return true;
    const m = x.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (m) return isPrivateIp(m[1]);
    return false;
  }
  return true;
}

async function isPublicHost(host) {
  if (!host || host === 'localhost' || /\.(localhost|local|internal)$/.test(host)) return false;
  if (net.isIP(host)) return !isPrivateIp(host);
  try {
    const addrs = await dns.lookup(host, { all: true });
    return addrs.length > 0 && addrs.every((a) => !isPrivateIp(a.address));
  } catch (e) {
    return false;
  }
}

async function readLimited(res, limit) {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  while (size < limit) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
    size += value.length;
  }
  try { await reader.cancel(); } catch (e) { /* ignore */ }
  return Buffer.concat(chunks).toString('utf8').slice(0, limit);
}

async function discard(res) {
  try { if (res.body) await res.body.cancel(); } catch (e) { /* ignore */ }
}

async function resolveFinalUrl(startUrl, opts) {
  const maxHops = (opts && opts.maxHops) || 5;
  const timeoutMs = (opts && opts.timeoutMs) || 3500;
  let url = startUrl;
  const hosts = [];
  for (let i = 0; i < maxHops; i++) {
    let u;
    try { u = new URL(url); } catch (e) { break; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') break;
    if (!(await isPublicHost(u.hostname))) break;
    hosts.push(u.hostname);
    let res;
    try {
      res = await fetch(u.href, {
        method: 'GET',
        redirect: 'manual',
        headers: { 'user-agent': UA, accept: 'text/html,*/*;q=0.8' },
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (e) { break; }
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) {
      await discard(res);
      try { url = new URL(loc, u).href; } catch (e) { break; }
      continue;
    }
    if (res.status === 200 && /html/i.test(res.headers.get('content-type') || '')) {
      const body = await readLimited(res, 30000);
      const m = body.match(/http-equiv=["']refresh["'][^>]*content=["'][^"']*url=([^"']+)/i) ||
        body.match(/location(?:\.href)?\s*=\s*["']([^"']+)["']/i) ||
        body.match(/location\.replace\(\s*["']([^"']+)["']\s*\)/i);
      if (m) {
        try { url = new URL(m[1].replace(/&amp;/g, '&'), u).href; continue; } catch (e) { /* fall through */ }
      }
    } else {
      await discard(res);
    }
    break;
  }
  let finalHost = '';
  try { finalHost = new URL(url).hostname; } catch (e) { /* ignore */ }
  return { finalUrl: url, hosts: hosts.concat(finalHost ? [finalHost] : []) };
}

return { resolveFinalUrl, isPublicHost, isPrivateIp };

})();

const __telegram = (function () {
'use strict';
/*
 * telegram.js
 * يقرأ الصفحة العامة للقناة (https://t.me/s/<channel>) التي يعرضها تليجرام نفسه
 * لأي شخص بدون حساب، ويحوّل الرسائل إلى كائنات.
 * يعمل مع القنوات العامة التي تسمح بمعاينة الويب فقط.
 */

const UA = 'Mozilla/5.0 (compatible; DealsRadar/1.0; +https://t.me)';

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (m, e) => {
    const k = e.toLowerCase();
    if (k === 'amp') return '&';
    if (k === 'lt') return '<';
    if (k === 'gt') return '>';
    if (k === 'quot') return '"';
    if (k === 'apos') return "'";
    if (k === 'nbsp') return ' ';
    const code = k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
    try { return String.fromCodePoint(code); } catch (err) { return ''; }
  });
}

function stripTags(s) { return s.replace(/<[^>]+>/g, ''); }

function htmlToText(html) {
  let s = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div)>/gi, '\n')
    .replace(/<(s|strike|del)\b[^>]*>([\s\S]*?)<\/\1>/gi, (m, tag, inner) => '~~' + stripTags(inner) + '~~');
  s = decodeEntities(stripTags(s));
  return s.split('\n').map((l) => l.replace(new RegExp('[ \\t\\u00a0]+', 'g'), ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function extractLinks(html) {
  const out = [];
  const re = /<a\b[^>]*\bhref="([^"]+)"/gi;
  let m;
  while ((m = re.exec(html))) {
    let href = decodeEntities(m[1]);
    if (href.startsWith('//')) href = 'https:' + href;
    if (/^https?:\/\//i.test(href)) out.push(href);
  }
  return out;
}

function parseChannelHtml(html, channel) {
  const blocks = html.split(/<div class="tgme_widget_message_wrap/).slice(1);
  const out = [];
  for (const b of blocks) {
    const post = /data-post="([^"]+)"/.exec(b);
    if (!post) continue;
    const idMatch = /\/(\d+)$/.exec(post[1]);
    if (!idMatch) continue;
    const textDiv = /<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/.exec(b);
    const photo = /tgme_widget_message_(?:photo_wrap|video_thumb)[^>]*style="[^"]*background-image:url\('([^']+)'\)/.exec(b);
    if (!textDiv && !photo) continue;
    const dt = /<time[^>]*datetime="([^"]+)"/.exec(b);
    const ts = dt ? Date.parse(dt[1]) : NaN;
    out.push({
      channel,
      id: parseInt(idMatch[1], 10),
      text: textDiv ? htmlToText(textDiv[1]) : '',
      links: textDiv ? extractLinks(textDiv[1]) : [],
      image: photo ? decodeEntities(photo[1]) : null,
      ts: isNaN(ts) ? null : ts
    });
  }
  out.sort((a, b) => a.id - b.id);
  return out;
}

async function fetchChannel(channel, base) {
  const res = await fetch((base || 'https://t.me/s/') + encodeURIComponent(channel), {
    headers: { 'user-agent': UA, 'accept-language': 'ar,en;q=0.8' },
    signal: AbortSignal.timeout(10000)
  });
  if (res.status === 429) {
    const err = new Error('rate limited');
    err.code = 429;
    err.retryAfter = parseInt(res.headers.get('retry-after') || '30', 10);
    throw err;
  }
  if (!res.ok) {
    const err = new Error('HTTP ' + res.status);
    err.code = res.status;
    throw err;
  }
  const html = await res.text();
  return { messages: parseChannelHtml(html, channel), previewable: html.includes('tgme_widget_message') };
}

return { fetchChannel, parseChannelHtml, htmlToText };

})();


const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parseMessage, hostStore, hostOf } = require('./parser');
const telegram = __telegram;
const { resolveFinalUrl } = __resolve;

const CFG = {
  port: parseInt(process.env.PORT, 10) || 3000,
  channels: (process.env.CHANNELS || 'deals_me').split(',')
    .map((s) => s.trim().replace(/^@/, '').replace(/^https?:\/\/t\.me\/(s\/)?/i, '').replace(/\/.*$/, ''))
    .filter(Boolean),
  minPollMs: parseInt(process.env.MIN_POLL_MS, 10) || 3000,
  pollMs: parseInt(process.env.POLL_MS, 10) || 6000,
  backlog: parseInt(process.env.BACKLOG, 10) || 24,
  maxDeals: 200,
  base: process.env.TELEGRAM_BASE || 'https://t.me/s/',
  ingestToken: process.env.INGEST_TOKEN || '',
  shorteners: (process.env.SHORTENERS || '3rrood.com,ad.waff.me,amzn.to,bit.ly,cutt.ly,tinyurl.com,rb.gy,is.gd,t.ly')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
};
CFG.pollMs = Math.max(CFG.pollMs, CFG.minPollMs);

const deals = [];
const seen = new Set();
const clients = new Set();
const status = { channels: {} };
const resolved = new Map();

function log() { console.log.apply(console, [new Date().toISOString().slice(11, 19)].concat([].slice.call(arguments))); }

/* ---------- البث ---------- */
function sse(res, event, data) {
  res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n');
}
function broadcast(event, data) {
  clients.forEach((res) => { try { sse(res, event, data); } catch (e) { clients.delete(res); } });
}
function publicStatus() {
  return { channels: status.channels, serverTime: Date.now() };
}

/* ---------- إدارة العروض ---------- */
function addDeal(d, announce) {
  if (seen.has(d.id)) return false;
  seen.add(d.id);
  deals.push(d);
  deals.sort((a, b) => b.ts - a.ts);
  while (deals.length > CFG.maxDeals) deals.pop();
  if (announce) broadcast('deal', d);
  queueResolve(d);
  return true;
}

function dealFromTelegram(channel, m) {
  const p = parseMessage({ text: m.text, links: m.links });
  if (!p) return null;
  return Object.assign({
    id: channel + '/' + m.id,
    src: 'telegram',
    channel,
    postUrl: 'https://t.me/' + channel + '/' + m.id,
    ts: m.ts || Date.now(),
    image: m.image || null
  }, p);
}

/* ---------- تتبع الروابط المختصرة لمعرفة المتجر ---------- */
const queue = [];
let active = 0;
function queueResolve(d) {
  if (d.store !== 'other' || d.storeLabel || !d.url) return;
  const host = hostOf(d.url);
  if (!CFG.shorteners.some((s) => host === s || host.endsWith('.' + s))) return;
  queue.push(d);
  pump();
}
function pump() {
  while (active < 3 && queue.length) {
    const d = queue.shift();
    active++;
    resolveDeal(d).catch(() => {}).finally(() => { active--; pump(); });
  }
}
async function resolveDeal(d) {
  let info = resolved.get(d.url);
  if (!info) {
    const r = await resolveFinalUrl(d.url);
    info = { hosts: r.hosts };
    resolved.set(d.url, info);
    if (resolved.size > 500) resolved.delete(resolved.keys().next().value);
  }
  let found = null;
  for (let i = info.hosts.length - 1; i >= 0 && !found; i--) found = hostStore(info.hosts[i]);
  if (!found) return;
  d.store = found.key;
  d.storeLabel = found.label;
  broadcast('update', d);
}

/* ---------- قراءة تليجرام ---------- */
const firstRun = {};
const backoff = {};

async function pollChannel(channel) {
  const st = status.channels[channel] || (status.channels[channel] = {});
  try {
    const r = await telegram.fetchChannel(channel, CFG.base);
    st.lastPollAt = Date.now();
    st.ok = true;
    st.error = null;
    backoff[channel] = 0;
    if (!r.previewable) {
      st.ok = false;
      st.error = 'القناة لا تعرض معاينة الويب. تأكد أنها عامة.';
      return;
    }
    const msgs = r.messages;
    if (!firstRun[channel]) {
      firstRun[channel] = true;
      msgs.slice(-CFG.backlog).forEach((m) => {
        const d = dealFromTelegram(channel, m);
        if (d) { d.backlog = true; addDeal(d, false); }
      });
      log('[' + channel + '] تم تحميل', msgs.slice(-CFG.backlog).length, 'رسالة سابقة');
    } else {
      msgs.forEach((m) => {
        if (seen.has(channel + '/' + m.id)) return;
        const d = dealFromTelegram(channel, m);
        if (d) {
          addDeal(d, true);
          st.lastNewAt = Date.now();
          log('[' + channel + '] عرض جديد:', d.title, d.now != null ? d.now + ' ج.م' : '');
        } else {
          seen.add(channel + '/' + m.id);
        }
      });
    }
  } catch (e) {
    st.lastPollAt = Date.now();
    st.ok = false;
    st.error = e.message;
    if (e.code === 429) backoff[channel] = Math.min(120000, (e.retryAfter || 30) * 1000);
    else backoff[channel] = Math.min(60000, (backoff[channel] || 5000) * 2);
    log('[' + channel + '] خطأ في القراءة:', e.message, '— إعادة المحاولة بعد', Math.round(backoff[channel] / 1000), 'ث');
  }
  broadcast('status', publicStatus());
}

function loop(channel) {
  pollChannel(channel).finally(() => {
    const wait = (backoff[channel] || CFG.pollMs) + Math.random() * 800;
    setTimeout(() => loop(channel), wait);
  });
}

/* ---------- استقبال رسائل خارجية (واتساب وغيره) ---------- */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
function json(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function tokenOk(header) {
  const want = Buffer.from('Bearer ' + CFG.ingestToken);
  const got = Buffer.from(header || '');
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}
async function handleIngest(req, res) {
  if (!CFG.ingestToken) return json(res, 403, { error: 'ingest is disabled: set INGEST_TOKEN' });
  if (!tokenOk(req.headers.authorization)) return json(res, 401, { error: 'bad token' });
  let data;
  try { data = JSON.parse(await readBody(req, 20000)); } catch (e) { return json(res, 400, { error: 'bad json' }); }
  const text = String((data && data.text) || '').slice(0, 4000);
  const links = Array.isArray(data.links) ? data.links.slice(0, 10).map(String) : [];
  const p = parseMessage({ text, links });
  if (!p) return json(res, 422, { error: 'no price or link found' });
  const src = data.source === 'whatsapp' ? 'whatsapp' : 'bridge';
  const hash = crypto.createHash('sha1').update(text).digest('hex').slice(0, 12);
  const id = String(data.id || src + '/' + hash).slice(0, 120);
  const channel = String(data.channel || '').slice(0, 80);
  const d = Object.assign({ id, src, channel, postUrl: null, ts: Number(data.ts) || Date.now(), image: null }, p);
  const added = addDeal(d, true);
  if (added) log('[' + src + '] عرض جديد:', d.title);
  return json(res, 200, { ok: true, duplicate: !added, deal: d });
}

/* ---------- الملفات الثابتة ---------- */
const FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/parser.js': ['parser.js', 'application/javascript; charset=utf-8']
};
const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
  "font-src https://fonts.gstatic.com; img-src 'self' https: data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'";

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (req.method === 'GET' && url === '/events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no'
    });
    res.write('retry: 3000\n\n');
    sse(res, 'init', { deals: deals.slice(0, 40), channels: CFG.channels, status: publicStatus() });
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (req.method === 'GET' && url === '/api/deals') return json(res, 200, { deals, status: publicStatus() });
  if (req.method === 'GET' && url === '/health') return json(res, 200, { ok: true, clients: clients.size, deals: deals.length });
  if (req.method === 'POST' && url === '/ingest') return handleIngest(req, res).catch(() => json(res, 500, { error: 'server error' }));
  if (req.method === 'GET' && FILES[url]) {
    const f = FILES[url];
    return fs.readFile(path.join(__dirname, f[0]), (err, buf) => {
      if (err) return json(res, 500, { error: 'file missing' });
      res.writeHead(200, { 'content-type': f[1], 'cache-control': 'no-cache', 'content-security-policy': CSP, 'x-content-type-options': 'nosniff' });
      res.end(buf);
    });
  }
  json(res, 404, { error: 'not found' });
});

setInterval(() => { clients.forEach((res) => { try { res.write(': ping\n\n'); } catch (e) { clients.delete(res); } }); }, 15000);

server.listen(CFG.port, '0.0.0.0', () => {
  log('رادار العروض يعمل على المنفذ', CFG.port);
  log('القنوات:', CFG.channels.join(', '), '| الفحص كل', Math.round(CFG.pollMs / 1000), 'ثوانٍ');
  log('استقبال واتساب /ingest:', CFG.ingestToken ? 'مفعّل' : 'متوقف (لم يُضبط INGEST_TOKEN)');
  CFG.channels.forEach((ch, i) => setTimeout(() => loop(ch), i * 700));
});
