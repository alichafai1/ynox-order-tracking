// Local test: fake Shopify API + signed App Proxy requests. Run: npm test
const http = require('http'), crypto = require('crypto'), assert = require('assert');
process.env.SHOPIFY_SHOP = 'test'; process.env.SHOPIFY_CLIENT_ID = 'id'; process.env.SHOPIFY_CLIENT_SECRET = 'secret';
process.env.DEBUG_KEY = 'dbg'; process.env.SHOP_API_BASE = 'http://127.0.0.1:4555';
const ORDER = { name: '#1042', email: 'Ali@Example.com', createdAt: '2026-11-07T15:00:00Z', cancelledAt: null, displayFulfillmentStatus: 'UNFULFILLED',
  metafields: { nodes: [{ namespace: 'mto', key: 'production_start', value: '2026-11-10', type: 'date' }] } };
const fake = http.createServer((req, res) => {
  let b = ''; req.on('data', c => b += c); req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url.includes('access_token')) return res.end(JSON.stringify({ access_token: 'tok', expires_in: 86399 }));
    const q = JSON.parse(b).variables.q;
    res.end(JSON.stringify({ data: { orders: { nodes: q.includes('1042') ? [ORDER] : [] } } }));
  });
}).listen(4555);
const { server } = require('../server.js');
const fs = require('fs'), path = require('path');
const cfgPath = path.join(__dirname, '..', 'config', 'steps.json'); const orig = fs.readFileSync(cfgPath, 'utf8');
const cfg = JSON.parse(orig); cfg.steps[1].metafield = 'mto.production_start'; fs.writeFileSync(cfgPath, JSON.stringify(cfg));
function signed(p, extra) {
  const params = Object.assign({ shop: 'test.myshopify.com', path_prefix: '/apps/track', timestamp: String(Math.floor(Date.now() / 1000)), logged_in_customer_id: '' }, extra);
  const msg = Object.keys(params).map(k => `${k}=${params[k]}`).sort().join('');
  params.signature = crypto.createHmac('sha256', 'secret').update(msg).digest('hex');
  return p + '?' + new URLSearchParams(params);
}
function get(u) { return new Promise(r => http.get('http://127.0.0.1:4556' + u, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => r({ s: res.statusCode, t: res.headers['content-type'], b })); })); }
server.listen(4556, async () => {
  try {
    let r = await get('/proxy?shop=x&signature=bad&timestamp=1'); assert.equal(r.s, 401);
    r = await get(signed('/proxy')); assert.equal(r.s, 200); assert.ok(r.t.includes('application/liquid')); assert.ok(r.b.includes("'/apps/track/status?order="));
    r = await get(signed('/proxy/status', { order: '1042', email: 'ali@example.com' })); assert.equal(r.s, 200);
    const d = JSON.parse(r.b); console.log(JSON.stringify(d));
    assert.equal(d.steps[0].status, 'done'); assert.equal(d.steps[1].status, 'current'); assert.equal(d.steps[2].status, 'upcoming'); assert.equal(d.steps[1].date, 'Nov 10, 2026');
    r = await get(signed('/proxy/status', { order: '1042', email: 'wrong@example.com' })); assert.equal(r.s, 404);
    r = await get(signed('/proxy/status', { order: '9999', email: 'ali@example.com' })); assert.equal(r.s, 404);
    r = await get('/debug?key=dbg&order=1042'); assert.equal(r.s, 200); console.log(r.b.slice(0, 200));
    r = await get('/debug?key=no&order=1042'); assert.equal(r.s, 401);
    console.log('ALL TESTS PASSED');
  } catch (e) { console.error('FAIL', e); process.exitCode = 1; }
  finally { fs.writeFileSync(cfgPath, orig); server.close(); fake.close(); }
});
