// AIClient2API 代理自适应脚本：让 A2 自动跟上代理环境变化
// 功能 1：当前 PROXY_URL 失效时，自动扫描常见代理端口，改配置并重启 A2
// 功能 2：检测 NiuBi(mihomo) 主选择组，若落在受限地区(香港/日本)自动切回美国节点
// 功能 3：Google 风控黑名单——裸探测(ip-api/节点名)测不出 Google 对出口 IP 的风控
//         （节点名是 🇺🇸 也可能被 Google 判 User location is not supported），
//         因此增量扫描 A2 日志里的 location 错误，归因给当前节点并拉黑 15 天；
//         合格范围 = 组内节点 - 受限地区名 - 黑名单(未过期)，当前节点不合格时自动切换
// 由 watchdog.bat 每 5 分钟调用；幂等，无副作用时秒退。
// ADAPT_DRY_RUN=1 时只记录将要执行的动作，不真正切换（用于验证）。
import http from 'node:http';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ROOT = path.resolve(import.meta.dirname);
const CFG = path.join(ROOT, 'configs', 'config.json');
const POOLS = path.join(ROOT, 'configs', 'provider_pools.json');
const STATE = path.join(ROOT, 'configs', 'node-guard-state.json');
const SERVICE_LOG = process.env.ADAPT_LOG || path.join(ROOT, 'logs', 'service.log');
const COMMON_PORTS = [7890, 7897, 7899, 10809, 10808, 1080, 2080];
const TEST_URL = 'https://cloudcode-pa.googleapis.com/';
const RESTRICTED = /(香港|日本|澳門|澳门|HK|JP|MO)/i;
const US_PREFERRED = /(凤凰城|亚特兰大|洛杉矶|圣何塞|US|🇺🇸)/i;
const LOCATION_ERROR = 'User location is not supported';
const LOG_TS_RE = /^\[(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.(\d+))?\]/;
const BAN_DAYS = 15;
const DRY_RUN = process.env.ADAPT_DRY_RUN === '1';

const log = (m) => console.log(`[adapt ${new Date().toISOString()}] ${m}`);

function curlViaProxy(proxy, url, timeout = 8) {
  try {
    const code = execSync(
      `curl -s -o NUL -w "%{http_code}" --max-time ${timeout} -x ${proxy} "${url}"`,
      { encoding: 'utf8', timeout: (timeout + 3) * 1000, windowsHide: true }
    ).trim();
    return code !== '000' && code !== '';
  } catch { return false; }
}

function findLiveProxy() {
  for (const p of COMMON_PORTS) {
    const proxy = `http://127.0.0.1:${p}`;
    const listening = execSync('netstat -ano', { encoding: 'utf8', windowsHide: true })
      .split('\n').some(l => l.includes(`:${p} `) && l.includes('LISTENING'));
    if (!listening) continue;
    if (curlViaProxy(proxy, TEST_URL)) return proxy;
  }
  return null;
}

function restartA2() {
  try {
    const out = execSync('netstat -ano', { encoding: 'utf8', windowsHide: true });
    for (const line of out.split('\n')) {
      if (line.includes(':3000 ') && line.includes('LISTENING')) {
        const pid = line.trim().split(/\s+/).pop();
        try { execSync(`taskkill /F /PID ${pid}`, { windowsHide: true }); log(`killed A2 pid ${pid}`); } catch {}
      }
    }
  } catch {}
}

function fixPoolHealth() {
  try {
    const p = JSON.parse(fs.readFileSync(POOLS, 'utf8'));
    let changed = false;
    for (const nodes of Object.values(p)) for (const n of nodes) {
      if (!n.isHealthy || n.errorCount > 0) { n.isHealthy = true; n.errorCount = 0; n.lastErrorTime = null; n.lastErrorMessage = null; changed = true; }
    }
    if (changed) { fs.writeFileSync(POOLS, JSON.stringify(p, null, 2)); log('pool health reset'); }
  } catch (e) { log('pool reset failed: ' + e.message); }
}

// ---- NiuBi (mihomo) 守护 ----
function mihomoApi() {
  try {
    const ps = execSync(
      `powershell -NoProfile -Command "(Get-CimInstance Win32_Process | Where-Object {$_.CommandLine -match 'nexgen-'}).CommandLine"`,
      { encoding: 'utf8', timeout: 15000, windowsHide: true }
    );
    const m = ps.match(/-ext-ctl (\S+) -secret (\S+)/);
    if (!m) return null;
    return { host: m[1], secret: m[2] };
  } catch { return null; }
}

function apiCall(api, method, apiPath, body) {
  return new Promise((resolve) => {
    const req = http.request({
      host: api.host.split(':')[0], port: Number(api.host.split(':')[1]), path: apiPath, method,
      headers: { 'Authorization': `Bearer ${api.secret}`, 'Content-Type': 'application/json' },
      timeout: 5000,
    }, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ---- 功能 3：Google 风控黑名单 ----
function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE, 'utf8'));
    if (!s.blacklist || typeof s.blacklist !== 'object') s.blacklist = {};
    if (!Number.isFinite(s.lastScanPos)) s.lastScanPos = 0;
    return s;
  } catch { return { blacklist: {}, lastScanPos: 0 }; }
}

function saveState(state) {
  try { fs.writeFileSync(STATE, JSON.stringify(state, null, 2)); }
  catch (e) { log('state save failed: ' + e.message); }
}

// 增量扫描 service.log 新增的 location 错误（记住上次读到的字节偏移，每轮只看增量；
// 首次运行从当前文件尾开始——历史错误不算旧账）。返回 { times: Date[], newPos }
function scanNewLocationErrors(lastPos) {
  let size = 0;
  try { size = fs.statSync(SERVICE_LOG).size; } catch { return { times: [], newPos: lastPos }; }
  let pos = lastPos;
  if (!pos || pos > size) pos = size; // 首次运行 / 日志被截断重建：从当前文件尾开始
  const times = [];
  if (pos < size) {
    try {
      const fd = fs.openSync(SERVICE_LOG, 'r');
      const buf = Buffer.alloc(size - pos);
      fs.readSync(fd, buf, 0, buf.length, pos);
      fs.closeSync(fd);
      for (const line of buf.toString('utf8').split('\n')) {
        const m = LOG_TS_RE.exec(line);
        if (m && line.includes(LOCATION_ERROR)) {
          const ms = m[3] ? '.' + (m[3] + '00').slice(0, 3) : '';
          const t = new Date(`${m[1]}T${m[2]}${ms}`);
          if (!isNaN(t)) times.push(t);
        }
      }
    } catch (e) { log('log scan failed: ' + e.message); }
  }
  return { times, newPos: size };
}

const banActive = (iso) => !!iso && (Date.now() - new Date(iso).getTime()) < BAN_DAYS * 86400000;

async function guardNode(api, state) {
  const proxies = await apiCall(api, 'GET', '/proxies');
  if (!proxies) { log('mihomo api unreachable'); return; }
  const map = JSON.parse(proxies.body).proxies || {};
  // 主选择组：名为「牛逼」的 Selector，找不到则取第一个非 GLOBAL 的 Selector
  let group = Object.entries(map).find(([k, v]) => v.type === 'Selector' && /牛逼/.test(k));
  if (!group) group = Object.entries(map).find(([k, v]) => v.type === 'Selector' && k !== 'GLOBAL');
  if (!group) { log('no selector group found'); return; }
  const [gname, g] = group;
  const current = g.now || '';

  // 1) 增量扫描 A2 日志：新出现的 location 错误归因给当前节点（尽力归因：以扫描时刻组内选中节点为准）
  const { times, newPos } = scanNewLocationErrors(state.lastScanPos);
  state.lastScanPos = newPos;
  if (times.length > 0) {
    const maxTs = times[times.length - 1];
    const prev = state.blacklist[current] ? new Date(state.blacklist[current]).getTime() : 0;
    if (maxTs.getTime() > prev) {
      state.blacklist[current] = maxTs.toISOString();
      log(`⚠ 发现 ${times.length} 条 "${LOCATION_ERROR}"（最近 ${maxTs.toLocaleString()}），归因当前节点 "${current}" → 拉黑 ${BAN_DAYS} 天`);
    }
  }

  // 2) 清理过期黑名单（15 天后允许再次尝试）
  for (const [n, t] of Object.entries(state.blacklist)) {
    if (!banActive(t)) { delete state.blacklist[n]; log(`node "${n}" 的 ${BAN_DAYS} 天黑名单已过期，重新进入合格范围`); }
  }

  // 3) 合格范围 = 组内节点 - 受限地区名 - 未过期黑名单
  const eligible = (g.all || []).filter(n => !RESTRICTED.test(n) && !banActive(state.blacklist[n]));

  // 4) 当前节点不合格（受限地区名 / 被风控拉黑）→ 切到下一个合格节点
  const currentBad = RESTRICTED.test(current) || banActive(state.blacklist[current]);
  if (!currentBad) {
    log(`group "${gname}" node OK: ${current}（合格节点 ${eligible.length}/${(g.all || []).length}）`);
    return;
  }
  const reason = RESTRICTED.test(current)
    ? '节点名落在受限地区'
    : `被 Google 风控拉黑（最后判定 ${state.blacklist[current]}）`;
  const next = eligible.find(n => US_PREFERRED.test(n)) || eligible[0];
  if (!next) {
    log(`⚠ "${current}" ${reason}，但组内没有其他合格节点，保持不动（需更新机场订阅）`);
    return;
  }
  if (DRY_RUN) { log(`[dry-run] would switch "${gname}": ${current} -> ${next}（原因：${reason}）`); return; }
  const r = await apiCall(api, 'PUT', `/proxies/${encodeURIComponent(gname)}`, { name: next });
  log(r && r.status === 204 ? `switched "${gname}": ${current} -> ${next}（原因：${reason}）` : `switch failed (${r && r.status})`);
}

// ---- 主流程 ----
const cfg = JSON.parse(fs.readFileSync(CFG, 'utf8'));
const cur = cfg.PROXY_URL;

if (curlViaProxy(cur, TEST_URL)) {
  log(`proxy OK: ${cur}`);
} else {
  const live = findLiveProxy();
  if (live) {
    log(`proxy ${cur} dead, switching to ${live}`);
    cfg.PROXY_URL = live;
    fs.writeFileSync(CFG, JSON.stringify(cfg, null, 2));
    fixPoolHealth();
    restartA2();
    execSync('cmd /c "' + path.join(ROOT, 'watchdog.bat') + '"', { windowsHide: true });
    log('A2 restarted with ' + live);
  } else {
    log('⚠ no live proxy found on common ports, leaving config unchanged');
  }
}

const state = loadState();
const api = mihomoApi();
if (api) {
  await guardNode(api, state);
  saveState(state);
} else {
  log('mihomo (NiuBi) not detected, skip node guard');
}
