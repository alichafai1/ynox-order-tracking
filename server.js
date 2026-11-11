/*
 * Dynox Order Tracking
 * A tiny Shopify app (no dependencies, Node 18+) that adds a "Track your order" page to the store:
 *   https://dynoxhome.com/apps/track          -> the page (rendered inside the store's theme)
 *   https://dynoxhome.com/apps/track/status   -> JSON status for order number + email
 * It reads the order and its metafields with the Admin API and turns them into production steps.
 *
 * Environment variables (set them on your host, e.g. Render):
 *   SHOPIFY_SHOP           your store's myshopify subdomain, e.g. "dynox-home" (without .myshopify.com)
 *   SHOPIFY_CLIENT_ID      from Dev Dashboard > your app > Settings
 *   SHOPIFY_CLIENT_SECRET  from Dev Dashboard > your app > Settings
 *   DEBUG_KEY              any long random text; lets you open /debug to see an order's metafields
 *   APP_URL                this app's public address, e.g. https://dynox-order-tracking.onrender.com
 *   SHOPIFY_ACCESS_TOKEN   only for "install link" setup (app made in your own Dev Dashboard):
 *                          shown once after install at /auth/callback; paste it here.
 *   API_VERSION            optional, default 2026-04
 *   PORT                   set automatically by most hosts
 */
'use strict';
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SHOP = (process.env.SHOPIFY_SHOP || '').replace(/\.myshopify\.com$/, '');
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID || '';
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET || '';
const DEBUG_KEY = process.env.DEBUG_KEY || '';
const API_VERSION = process.env.API_VERSION || '2026-04';
const SHOP_BASE = process.env.SHOP_API_BASE || `https://${SHOP}.myshopify.com`; // override only for tests
const PORT = process.env.PORT || 3000;
const APP_URL = (process.env.APP_URL || '').replace(/\/+$/, '');
const STATIC_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN || '';
const SCOPES = 'read_orders,read_all_orders';

// Files can sit in their folders (config/, views/) or next to server.js
function findFile(folder, name) {
  const a = path.join(__dirname, folder, name);
  return fs.existsSync(a) ? a : path.join(__dirname, name);
}
function loadConfig() {
  return JSON.parse(fs.readFileSync(findFile('config', 'steps.json'), 'utf8'));
}

/* ---------------- Admin API token (client credentials, cached ~23h) ---------------- */
let token = null, tokenExpires = 0;
async function getToken() {
  if (STATIC_TOKEN) return STATIC_TOKEN;                 // install-link setup
  if (token && Date.now() < tokenExpires) return token;  // same-organization setup
  const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: CLIENT_ID, client_secret: CLIENT_SECRET });
  const r = await fetch(`${SHOP_BASE}/admin/oauth/access_token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
  });
  if (!r.ok) throw new Error(`token ${r.status}: ${await r.text()}`);
  const j = await r.json();
  token = j.access_token;
  tokenExpires = Date.now() + Math.max(60, (j.expires_in || 86399) - 3600) * 1000;
  return token;
}

async function adminGraphQL(query, variables) {
  const r = await fetch(`${SHOP_BASE}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': await getToken() },
    body: JSON.stringify({ query, variables }),
  });
  if (!r.ok) throw new Error(`graphql ${r.status}: ${await r.text()}`);
  const j = await r.json();
  if (j.errors && !j.data) throw new Error('graphql: ' + JSON.stringify(j.errors));
  return j;
}

const ORDER_QUERY = `query($q: String!) {
  orders(first: 1, query: $q) {
    nodes {
      name email createdAt cancelledAt displayFulfillmentStatus
      metafields(first: 100) { nodes { namespace key value type } }
    }
  }
}`;

async function findOrder(orderNumber) {
  const n = String(orderNumber).replace(/[^0-9A-Za-z-]/g, '');
  if (!n) return null;
  const j = await adminGraphQL(ORDER_QUERY, { q: `name:"#${n}" OR name:"${n}"` });
  return (j.data && j.data.orders && j.data.orders.nodes[0]) || null;
}

/* ---------------- Steps from metafields ---------------- */
function fmtDate(v) {
  if (!v) return '';
  const s = String(v).trim();
  if (/^(true|false)$/i.test(s)) return '';
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? s + 'T12:00:00Z' : s);
  if (isNaN(d)) return s.slice(0, 40);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}
function isSet(v) { return v != null && String(v).trim() !== '' && !/^false$/i.test(String(v).trim()); }

function buildStatus(order, cfg) {
  const mf = {};
  ((order.metafields && order.metafields.nodes) || []).forEach(m => { mf[`${m.namespace}.${m.key}`] = m.value; });
  const fulfilled = /FULFILLED/.test(order.displayFulfillmentStatus || '') && !/UNFULFILLED|PARTIALLY/.test(order.displayFulfillmentStatus || '');

  const steps = cfg.steps.map(s => {
    let val = s.metafield ? mf[s.metafield] : undefined;
    if (!isSet(val) && s.useOrderDate) val = order.createdAt;
    let done = isSet(val);
    if (s.doneWhenFulfilled && fulfilled) done = true;
    return { name: s.name, date: done ? fmtDate(val) : '', done };
  });

  // Optional single "current status" metafield (value = step name or step number)
  let currentIdx = -1;
  const sv = cfg.statusMetafield ? mf[cfg.statusMetafield] : '';
  if (isSet(sv)) {
    const num = parseInt(sv, 10);
    if (!isNaN(num) && String(num) === String(sv).trim()) currentIdx = Math.min(Math.max(num - 1, 0), steps.length - 1);
    else currentIdx = steps.findIndex(s => s.name.toLowerCase().replace(/[^a-z]/g, '') === String(sv).toLowerCase().replace(/[^a-z]/g, ''));
  }
  if (currentIdx >= 0) {
    steps.forEach((s, i) => { s.done = i < currentIdx || (i === currentIdx && i === steps.length - 1 && fulfilled); });
  } else {
    // A step with a date has been REACHED. The latest reached step is the current one;
    // once only the order is confirmed, production is the current step (same as the dynox-mto admin block).
    let last = -1; steps.forEach((s, i) => { if (s.done) last = i; });
    if (last === steps.length - 1) { steps.forEach(s => { s.done = true; }); currentIdx = -1; }
    else {
      currentIdx = last <= 0 ? Math.min(1, steps.length - 1) : last;
      steps.forEach((s, i) => { s.done = i < currentIdx; });
    }
  }
  return {
    order: order.name,
    cancelled: !!order.cancelledAt,
    eta: cfg.etaMetafield ? fmtDate(mf[cfg.etaMetafield]) || (mf[cfg.etaMetafield] || '') : '',
    steps: steps.map((s, i) => ({ name: s.name, date: s.date, status: s.done ? 'done' : (i === currentIdx ? 'current' : 'upcoming') })),
  };
}

/* ---------------- App proxy signature ---------------- */
function verifyProxy(searchParams) {
  const sig = searchParams.get('signature') || '';
  const pairs = {};
  for (const [k, v] of searchParams) { if (k === 'signature') continue; (pairs[k] = pairs[k] || []).push(v); }
  const msg = Object.keys(pairs).map(k => `${k}=${pairs[k].join(',')}`).sort().join('');
  const calc = crypto.createHmac('sha256', CLIENT_SECRET).update(msg).digest('hex');
  if (sig.length !== calc.length) return false;
  const ts = parseInt(searchParams.get('timestamp') || '0', 10);
  const fresh = Math.abs(Date.now() / 1000 - ts) < 600;
  return fresh && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(calc));
}

/* ---------------- Install (OAuth) for apps made outside the store's organization ---------------- */
function verifyOAuthHmac(searchParams) {
  const h = searchParams.get('hmac') || '';
  const msg = [...searchParams].filter(([k]) => k !== 'hmac' && k !== 'signature')
    .map(([k, v]) => `${k}=${v}`).sort().join('&');
  const calc = crypto.createHmac('sha256', CLIENT_SECRET).update(msg).digest('hex');
  return h.length === calc.length && crypto.timingSafeEqual(Buffer.from(h), Buffer.from(calc));
}
const validShop = s => /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(s || '');
const states = new Map();

/* ---------------- Simple rate limit (per visitor IP) ---------------- */
const hits = new Map();
function limited(ip) {
  const now = Date.now(), win = 10 * 60 * 1000, max = 20;
  const arr = (hits.get(ip) || []).filter(t => now - t < win);
  arr.push(now); hits.set(ip, arr);
  if (hits.size > 5000) hits.clear();
  return arr.length > max;
}

/* ---------------- Page (Liquid, rendered inside the theme) ---------------- */
function pageLiquid(prefix) {
  return fs.readFileSync(findFile('views', 'track.liquid'), 'utf8').replace(/__PREFIX__/g, prefix);
}

function send(res, status, type, body) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}
const json = (res, status, obj) => send(res, status, 'application/json; charset=utf-8', JSON.stringify(obj));

/* ---------------- Router ---------------- */
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname.replace(/\/+$/, '') || '/';

    // Install start: Shopify opens the App URL with ?shop=...&hmac=... after the install link is used
    if ((p === '/' || p === '/auth') && url.searchParams.get('shop')) {
      const shop = url.searchParams.get('shop');
      if (!validShop(shop)) return send(res, 400, 'text/plain', 'Bad shop');
      if (url.searchParams.get('hmac') && !verifyOAuthHmac(url.searchParams)) return send(res, 401, 'text/plain', 'Unauthorized');
      if (STATIC_TOKEN && p === '/') return send(res, 200, 'text/html; charset=utf-8', '<p style="font:16px system-ui;padding:40px">Dynox Order Tracking is installed and running. Customers use <b>/apps/track</b> on your store.</p>');
      const state = crypto.randomBytes(16).toString('hex'); states.set(state, Date.now());
      const redirect = `${APP_URL}/auth/callback`;
      res.writeHead(302, { Location: `https://${shop}/admin/oauth/authorize?client_id=${encodeURIComponent(CLIENT_ID)}&scope=${SCOPES}&redirect_uri=${encodeURIComponent(redirect)}&state=${state}` });
      return res.end();
    }
    if (p === '/auth/callback') {
      const q = url.searchParams, shop = q.get('shop'), state = q.get('state');
      if (!validShop(shop) || !verifyOAuthHmac(q) || !states.has(state)) return send(res, 401, 'text/plain', 'Unauthorized');
      states.delete(state);
      const r = await fetch(`${process.env.SHOP_API_BASE || 'https://' + shop}/admin/oauth/access_token`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, code: q.get('code') }),
      });
      const j = await r.json();
      if (!j.access_token) return send(res, 500, 'text/plain', 'Install failed: ' + JSON.stringify(j));
      const esc = v => String(v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
      return send(res, 200, 'text/html; charset=utf-8', `<div style="font:16px/1.5 system-ui;max-width:720px;margin:40px auto;padding:0 20px">
        <h2>Almost done: copy this access token</h2>
        <p>On Render, open your service → <b>Environment</b> → add <b>SHOPIFY_ACCESS_TOKEN</b> with this value, and <b>SHOPIFY_SHOP</b> = <b>${esc(shop.replace('.myshopify.com', ''))}</b>. Save (the app restarts).</p>
        <p style="background:#F4F6F5;padding:14px;border-radius:10px;word-break:break-all;font-family:monospace">${esc(j.access_token)}</p>
        <p style="color:#9A5530">Keep it secret. It is shown only now. Scopes granted: ${esc(j.scope || '')}</p></div>`);
    }

    if (p === '/') return send(res, 200, 'text/plain', 'Dynox Order Tracking is running.');

    // App proxy: /apps/track  ->  /proxy
    if (p === '/proxy' || p === '/proxy/status') {
      if (!verifyProxy(url.searchParams)) return send(res, 401, 'text/plain', 'Unauthorized');
      const prefix = /^\/[a-z]+\/[A-Za-z0-9_-]{1,30}$/.test(url.searchParams.get('path_prefix') || '') ? url.searchParams.get('path_prefix') : '/apps/track';

      if (p === '/proxy') return send(res, 200, 'application/liquid', pageLiquid(prefix));

      const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
      if (limited(ip)) return json(res, 429, { error: 'too_many_requests' });
      const orderNo = (url.searchParams.get('order') || '').trim();
      const email = (url.searchParams.get('email') || '').trim().toLowerCase();
      if (!orderNo || !email) return json(res, 400, { error: 'missing_fields' });

      const order = await findOrder(orderNo);
      // Same answer for "no order" and "wrong email", so order numbers can't be probed.
      if (!order || !order.email || order.email.trim().toLowerCase() !== email) return json(res, 404, { error: 'not_found' });
      return json(res, 200, buildStatus(order, loadConfig()));
    }

    // Owner-only helper: /debug?key=DEBUG_KEY&order=1042  -> shows the order's metafields
    if (p === '/debug') {
      if (!DEBUG_KEY || url.searchParams.get('key') !== DEBUG_KEY) return send(res, 401, 'text/plain', 'Unauthorized');
      const order = await findOrder(url.searchParams.get('order') || '');
      if (!order) return json(res, 404, { error: 'order not found' });
      return json(res, 200, {
        order: order.name, createdAt: order.createdAt, fulfillment: order.displayFulfillmentStatus,
        metafields: (order.metafields.nodes || []).map(m => ({ metafield: `${m.namespace}.${m.key}`, type: m.type, value: m.value })),
        preview: buildStatus(order, loadConfig()),
      });
    }

    send(res, 404, 'text/plain', 'Not found');
  } catch (err) {
    console.error(err);
    json(res, 500, { error: 'server_error' });
  }
});

if (require.main === module) {
  if (!SHOP || !CLIENT_ID || !CLIENT_SECRET) console.warn('Missing SHOPIFY_SHOP / SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET');
  server.listen(PORT, () => console.log(`Dynox Order Tracking on :${PORT}`));
}
module.exports = { server, buildStatus, verifyProxy };
