// Mine high-frequency multi-word phrases from the rule corpus, attach a Chinese
// gloss (from the 2000-word vocab table + phrase overrides + component composition)
// and a data-driven business topic, then emit phrases.js.
// Usage: node gen_phrases.mjs
import fs from "node:fs";

const dir = new URL("./", import.meta.url);
const src = fs.readFileSync(new URL("corpus.js", dir), "utf8");
const data = JSON.parse(src.slice(src.indexOf("{"), src.lastIndexOf("}") + 1));
const items = data.items || [];
const TOPICS = data.topics || [];

const MINCOUNT = 5;
const MAX = 1500;
const NMIN = 2, NMAX = 4;

const STOP = new Set(
  ("a an the this that these those of to in on at for with by from into onto upon over under above below " +
   "between among within without through during before after since until while and or but nor so yet as if " +
   "then than because although though unless whether it its is are was were be been being am do does did done " +
   "have has had having will would shall should may might must can could not no also such any all each every " +
   "some most more much many few less least own same other another both either neither per via there here " +
   "their they them we us our you your i me my he she his her him who whom whose which what when where why how " +
   "about against out off up down again further once only very too just").split(/\s+/)
);
function splitSents(t) {
  return (String(t).match(/[^.!?;:]+[.!?;:]?/g) || [String(t)]).map((s) => s.trim()).filter((s) => s.length > 1);
}
const ok = (w) => w.length >= 3 && !STOP.has(w);

/* ---- Chinese gloss lexicon ---- */
// Parse the 2000-word vocab table: rows like `| No. | english | 中文 | ... |`.
const dict = new Map();
try {
  const md = fs.readFileSync(new URL("../券商IT英语词汇表_2000.md", dir), "utf8");
  for (const line of md.split(/\r?\n/)) {
    if (!/^\|/.test(line)) continue;
    const cells = line.split("|").map((c) => c.trim());
    // cells: ["", no, english, 中文, mastery?, ""]
    if (cells.length < 4) continue;
    const en = (cells[2] || "").toLowerCase();
    const zh = cells[3] || "";
    if (!en || !zh || /english/i.test(en) || /^-+$/.test(en)) continue;
    if (/[\u4e00-\u9fff]/.test(en)) continue; // skip non-English keys
    if (!dict.has(en)) dict.set(en, zh);
  }
} catch (_) {}
// Curated backups for common domain words the table may miss.
const LEX = new Map(Object.entries({
  clearing: "清算", settlement: "交收", participant: "参与者", member: "会员", trading: "交易",
  trade: "交易", order: "订单", book: "簿", market: "市场", maker: "做市商", margin: "保证金",
  default: "违约", custody: "存管", depository: "存管机构", corporate: "公司", action: "行为",
  board: "董事会", directors: "董事", director: "董事", business: "营业", day: "日", exchange: "交易所",
  security: "证券", securities: "证券", position: "持仓", delivery: "交收", payment: "支付",
  netting: "净额", collateral: "担保品", rule: "规则", rules: "规则", procedure: "程序",
  procedures: "程序", transaction: "交易", instruction: "指令", account: "账户", fund: "资金",
  cash: "现金", price: "价格", bid: "买盘", offer: "卖盘", quote: "报价", listing: "上市",
  issuer: "发行人", investor: "投资者", broker: "经纪商", dealer: "自营商", agent: "代理",
  fee: "费用", tax: "税", report: "报告", notice: "通知", agreement: "协议", contract: "合约",
  option: "期权", options: "期权", futures: "期货", swap: "掉期", bond: "债券", share: "股份",
  shares: "股份", stock: "股票", index: "指数", session: "时段", halt: "暂停", suspension: "停牌",
  limit: "限额", threshold: "阈值", breach: "违反", event: "事件", obligation: "义务",
  liability: "责任", requirement: "要求", eligible: "合格", qualification: "资格",
  register: "登记", registration: "注册", record: "记录", date: "日期", time: "时间",
  period: "期间", system: "系统", gateway: "网关", protocol: "协议", message: "报文",
  price: "价格", value: "价值", amount: "金额", rate: "费率", currency: "货币",
  counterparty: "对手方", central: "中央", house: "所", house: "所", risk: "风险",
  compliance: "合规", capital: "资本", asset: "资产", assets: "资产", holder: "持有人",
  holders: "持有人", buyer: "买方", seller: "卖方", client: "客户", customer: "客户",
  service: "服务", services: "服务", data: "数据", feed: "行情源", info: "信息",
  information: "信息", number: "编号", code: "代码", type: "类型", status: "状态",
  approval: "批准", consent: "同意", application: "申请", form: "表格", document: "文件",
  fees: "费用", charges: "费用", interest: "利息", dividend: "股息", coupon: "票息",
}));
// Expand the lexicon with more domain nouns/verbs/adjectives so composition covers the long tail.
for (const [k, v] of Object.entries({
  law: "法律", regulation: "法规", provision: "条款", section: "条", article: "条", clause: "条款",
  schedule: "附表", appendix: "附录", annex: "附件", table: "表", list: "清单", category: "类别",
  class: "类别", level: "级别", group: "组", entity: "实体", company: "公司", corporation: "法人",
  firm: "公司", institution: "机构", authority: "当局", regulator: "监管机构", commission: "委员会",
  committee: "委员会", department: "部门", party: "方", parties: "各方", person: "人",
  individual: "个人", body: "机构", organization: "组织", unit: "单位", branch: "分支",
  subsidiary: "子公司", affiliate: "关联方", representative: "代表", officer: "高管",
  employee: "雇员", personnel: "人员", staff: "员工", bidding: "竞价", matching: "撮合",
  execution: "执行", quotation: "报价", spread: "价差", depth: "深度", snapshot: "快照",
  lot: "手", symbol: "代码", ticker: "代码", instrument: "工具", product: "产品",
  derivative: "衍生品", warrant: "权证", portfolio: "投资组合", benchmark: "基准",
  volatility: "波动率", liquidity: "流动性", volume: "成交量", turnover: "成交额",
  closing: "收盘", opening: "开盘", novation: "更替", exposure: "敞口", haircut: "折扣率",
  pledge: "质押", guarantee: "担保", guarantor: "担保人", insolvency: "破产",
  liquidation: "清算", reconciliation: "对账", confirmation: "确认", allocation: "分配",
  aggregation: "汇总", law: "法律", limit: "限额", cap: "上限", floor: "下限", band: "区间",
  window: "窗口", queue: "队列", buffer: "缓冲", latency: "时延", throughput: "吞吐",
  message: "报文", field: "字段", tag: "标签", flag: "标志", value: "值", key: "键",
  identifier: "标识", reference: "参考", scope: "范围", basis: "基础", term: "条款",
  terms: "条款", condition: "条件", conditions: "条件", criteria: "标准", standard: "标准",
  guideline: "指引", policy: "政策", framework: "框架", model: "模型", method: "方法",
  process: "流程", workflow: "工作流", stage: "阶段", phase: "阶段", step: "步骤",
  version: "版本", release: "发布", update: "更新", change: "变更", request: "请求",
  approval: "批准", review: "复核", audit: "审计", control: "控制", check: "检查",
  validation: "校验", verification: "验证", monitoring: "监控", alert: "告警",
  warning: "警告", error: "错误", failure: "失败", exception: "异常", incident: "事件",
  issue: "问题", defect: "缺陷", root: "根", cause: "原因", impact: "影响", scope: "范围",
  law: "法律", right: "权利", rights: "权利", duty: "义务", duties: "义务", power: "权力",
  discretion: "裁量权", consent: "同意", authorisation: "授权", authorization: "授权",
  mandate: "授权", license: "牌照", licence: "牌照", permit: "许可", registration: "注册",
  filing: "备案", disclosure: "披露", notification: "通知", declaration: "申报",
  submission: "提交", application: "申请", statement: "报表", invoice: "发票",
  receipt: "收据", ledger: "账簿", entry: "分录", balance: "余额", credit: "贷记",
  debit: "借记", debt: "债务", loan: "贷款", repo: "回购", pledge: "质押", lien: "留置",
  law: "法律", relevant: "相关", applicable: "适用", respective: "各自", written: "书面",
  prior: "事先", additional: "额外", general: "一般", special: "特别", direct: "直接",
  indirect: "间接", financial: "金融", electronic: "电子", physical: "实物", foreign: "外国",
  domestic: "境内", daily: "每日", annual: "年度", aggregate: "合计", net: "净",
  gross: "总", outstanding: "未平仓", underlying: "标的", valid: "有效", effective: "有效",
  minimum: "最低", maximum: "最高", total: "总", average: "平均", current: "当前",
  previous: "前一", final: "最终", initial: "初始", relevant: "相关", eligible: "合格",
  applicable: "适用", mandatory: "强制", voluntary: "自愿", automatic: "自动",
  manual: "手动", relevant: "相关", specific: "特定", certain: "特定", official: "官方",
  competent: "主管", designated: "指定", authorised: "授权", registered: "注册",
  approved: "核准", qualified: "合格", listed: "上市", unlisted: "非上市",
})) if (!LEX.has(k)) LEX.set(k, v);

// Lookup with light inflection fallback (plurals / -ies).
function look(w) {
  return dict.get(w) || LEX.get(w) ||
    (w.endsWith("ies") ? dict.get(w.slice(0, -3) + "y") || LEX.get(w.slice(0, -3) + "y") : null) ||
    (w.endsWith("es") ? dict.get(w.slice(0, -2)) || LEX.get(w.slice(0, -2)) : null) ||
    (w.endsWith("s") ? dict.get(w.slice(0, -1)) || LEX.get(w.slice(0, -1)) : null) || null;
}
const firstGloss = (s) => (s || "").split(/[\/;，、（(]/)[0].trim();
const CONN = new Set(["for", "to", "and", "or", "versus", "vs", "with", "in", "on", "by", "a", "an", "the", "at", "from"]);
// Overrides for proper nouns, of-phrases and idioms where composition fails.
const PMAP = new Map(Object.entries({
  "board of directors": "董事会", "china connect": "中华通/互联互通", "market maker": "做市商",
  "set forth": "列明；规定", "time to time": "不时", "delivery versus payment": "货银对付（DVP）",
  "event of default": "违约事件", "paragraph of article": "条款段落", "brokerage for clearing": "清算经纪费",
  "six x-clear": "SIX X-Clear（清算所）", "euronext clearing": "泛欧清算", "nasdaq nordic": "纳斯达克北欧",
  "nasdaq baltic": "纳斯达克波罗的海", "asx clear": "ASX Clear（清算所）", "non-resident investor": "非居民投资者",
  "order book": "订单簿/盘口", "clearing house": "清算所", "central counterparty": "中央对手方（CCP）",
  "clearing participant": "清算参与者", "clearing member": "清算会员", "trading participant": "交易参与者",
  "trading member": "交易会员", "market participant": "市场参与者", "trading system": "交易系统",
  "business day": "营业日", "trading day": "交易日", "settlement date": "交收日", "value date": "起息日",
  "record date": "登记日", "trade date": "成交日", "business rules": "业务规则", "clearing qualification": "清算资格",
  "futures clearing": "期货清算", "corporate action": "公司行为", "corporate actions": "公司行为",
  "stock exchange": "证券交易所", "settlement instruction": "交收指令", "good faith": "善意",
  "margin call": "追加保证金", "initial margin": "初始保证金", "variation margin": "变动保证金",
  "block trade": "大宗交易", "short selling": "卖空", "circuit breaker": "熔断机制",
  "price limit": "价格涨跌幅限制", "opening auction": "开盘集合竞价", "closing auction": "收盘集合竞价",
}));
for (const [k, v] of Object.entries({
  "rules and procedures": "规则与程序", "terms and conditions": "条款与条件", "clearing of securities etc": "证券清算等",
  "pursuant to the provisions": "根据本条款规定", "accordance with the provisions": "按照条款规定",
  "preceding paragraph": "前款", "sponsored member": "保荐会员", "sponsoring member": "保荐会员",
  "settling bank": "交收银行", "clearing agency": "清算机构", "china connect clearing": "中华通清算",
  "china connect securities": "中华通证券", "designated market operator": "指定市场运营者", "market making": "做市",
  "disciplinary committee": "纪律委员会", "jgb futures": "日本国债期货", "jse equities": "JSE 股票",
  "eurex clearing": "Eurex 清算", "euronext market undertaking": "泛欧市场机构", "relevant euronext market": "相关泛欧市场",
  "relevant euronext market undertaking": "相关泛欧市场机构", "operating rules": "业务规则", "third party": "第三方",
  "come into effect": "生效", "full trading participant": "正式交易参与者", "full trading": "正式交易",
  "subject contracts": "标的合约", "reference translation": "参考译文", "amended effective": "修订生效",
  "amended with effect": "修订生效", "pursuant to rule": "根据规则", "pursuant to section": "根据本条",
  "commission of the brokerage": "经纪佣金", "hereinafter referred": "以下简称", "operating hours": "运营时间",
  "clearing house rules": "清算所规则", "central securities depository": "中央证券存管机构（CSD）",
  "long position": "多头持仓", "short position": "空头持仓", "open position": "未平仓头寸",
  "cayman islands": "开曼群岛", "appeals committee": "上诉委员会", "bme clearing": "BME 清算",
  "accordance with the rules": "依照本规则", "accordance with rule": "依照规则", "accordance with article": "依照本条",
  "pursuant to article": "根据本条", "pursuant to the commission": "根据委员会", "set forth in paragraph": "载于本款",
  "provisions of paragraph": "本款规定", "supplementary provisions": "补充规定", "trading hours": "交易时间",
  "settlement by delivery": "实物交收", "financial instruments": "金融工具", "equity securities": "股本证券",
  "debt securities": "债务证券", "listed company": "上市公司", "listed companies": "上市公司",
  "clearing bank": "清算银行", "custodian bank": "托管银行", "nominee account": "代名人账户",
  "omnibus account": "综合账户", "house account": "自营账户", "client account": "客户账户",
})) if (!PMAP.has(k)) PMAP.set(k, v);
for (const [k, v] of Object.entries({
  sponsored: "保荐", sponsoring: "保荐", settling: "交收", bank: "银行", agency: "机构",
  preceding: "前述", operating: "运营", operator: "运营者", disciplinary: "纪律", undertaking: "机构",
  equities: "股票", equity: "权益", effect: "效力", provisions: "条款", translation: "译文",
  third: "第三", amended: "修订", sponsor: "保荐人", settling: "交收", depository: "存管机构",
  brokerage: "经纪", commission: "佣金", decision: "决定", hereinafter: "以下", operator: "运营者",
  // Exchange / clearing house proper nouns.
  nasdaq: "纳斯达克", nordic: "北欧", baltic: "波罗的海", euronext: "泛欧交易所",
  eurex: "欧洲期货交易所", jscc: "日本证券清算公司", hkscc: "香港结算公司", athex: "雅典交易所",
  nzx: "新西兰交易所", jse: "约翰内斯堡交易所", jgb: "日本国债", clearinghouse: "清算所",
  asx: "澳洲证券交易所", dtcc: "美国存管信托清算公司", lch: "伦敦清算所", cme: "芝加哥商品交易所",
  ice: "洲际交易所", tadawul: "沙特证券交易所", bist: "伊斯坦布尔交易所", hkex: "香港交易所",
  sgx: "新加坡交易所", nyse: "纽约证券交易所", tse: "东京证券交易所", krx: "韩国交易所",
  // More domain nouns/verbs/adjectives seen in the long tail.
  contracts: "合约", contract: "合约", insurance: "保险", investor: "投资者", investors: "投资者",
  transfer: "转让", steering: "督导", revised: "修订", title: "权属", mutual: "共同",
  prescribed: "规定的", specified: "指定的", traded: "交易的", public: "公开", income: "收益",
  agent: "代理", client: "客户", clients: "客户", deposit: "保证金", certain: "特定",
  pertaining: "有关", accordance: "依照", markets: "市场", corporation: "法人", resident: "居民",
  spot: "现货", forward: "远期", repo: "回购", forth: "列明", including: "包括", provided: "规定",
  income: "收益", position: "持仓", positions: "持仓", delivery: "交收", order: "订单",
  orders: "订单", information: "信息", item: "项", certain: "特定", version: "版本",
  connect: "通", china: "中国", transferable: "可转让", tradable: "可交易", underlying: "标的",
  redemption: "赎回", subscription: "认购", issuance: "发行", allotment: "配发", quotation: "报价",
  rulebook: "规则手册",
})) if (!LEX.has(k)) LEX.set(k, v);
const ARTICLE = new Set(["the", "a", "an", "etc", "etc.", "'s"]);
// Compose a gloss from a plain (connector-free) word sequence; articles are dropped.
function compose(str) {
  const ws = str.split(" ").filter((w) => !ARTICLE.has(w));
  if (!ws.length || ws.some((w) => CONN.has(w))) return "";
  const parts = ws.map((w) => PMAP.get(w) || look(w));
  if (parts.every(Boolean)) return parts.map(firstGloss).join("");
  return "";
}
function resolveSide(str) {
  if (PMAP.has(str)) return PMAP.get(str);
  const cleaned = str.split(" ").filter((w) => !ARTICLE.has(w)).join(" ");
  if (PMAP.has(cleaned)) return PMAP.get(cleaned);
  return look(cleaned) || compose(cleaned);
}
function glossOf(p) {
  if (PMAP.has(p)) return PMAP.get(p);
  if (dict.has(p)) return dict.get(p);
  const words = p.split(" ").filter((w) => !ARTICLE.has(w));
  if (!words.length) return "";
  const io = words.indexOf("of");
  if (io > 0 && io < words.length - 1) {
    const gl = resolveSide(words.slice(0, io).join(" "));
    const gr = resolveSide(words.slice(io + 1).join(" "));
    if (gl && gr) return firstGloss(gr) + "的" + firstGloss(gl);
    return "";
  }
  const ia = words.indexOf("and");
  if (ia > 0 && ia < words.length - 1) {
    const gl = resolveSide(words.slice(0, ia).join(" "));
    const gr = resolveSide(words.slice(ia + 1).join(" "));
    if (gl && gr) return firstGloss(gl) + "和" + firstGloss(gr);
    return "";
  }
  return compose(words.join(" "));
}

/* ---- noise filter: drop grams with OCR-garbage / non-word tokens ---- */
let WORDS = new Set();
try {
  WORDS = new Set(fs.readFileSync("/usr/share/dict/words", "utf8").split(/\r?\n/).map((w) => w.trim().toLowerCase()).filter(Boolean));
} catch (_) {}
const ABBR = new Set(["jgb", "nzx", "jse", "bme", "krx", "cme", "ice", "lch", "sgx", "tse", "nyse", "asx",
  "dtcc", "hkex", "hkscc", "jscc", "athex", "euronext", "eurex", "nasdaq", "tadawul", "bist", "otc", "dvp",
  "rvp", "ccp", "csd", "isin", "cusip", "sedol", "figi", "etf", "nav", "fix", "api", "ipo", "mtf", "aml",
  "kyc", "aum", "clearnet", "x-clear", "nordic", "baltic", "clearinghouse"]);
function inWords(w) {
  if (WORDS.has(w)) return true;
  if (w.endsWith("ies") && WORDS.has(w.slice(0, -3) + "y")) return true;
  if (w.endsWith("es") && (WORDS.has(w.slice(0, -2)) || WORDS.has(w.slice(0, -1)))) return true;
  if (w.endsWith("s") && WORDS.has(w.slice(0, -1))) return true;
  if (w.endsWith("ed") && (WORDS.has(w.slice(0, -2)) || WORDS.has(w.slice(0, -1)))) return true;
  if (w.endsWith("ing") && (WORDS.has(w.slice(0, -3)) || WORDS.has(w.slice(0, -3) + "e"))) return true;
  return false;
}
function validToken(w) {
  if (w.length <= 2 || /\d/.test(w) || w.includes("-")) return true;
  return inWords(w) || dict.has(w) || LEX.has(w) || ABBR.has(w);
}
const noiseFilter = WORDS.size > 0;
function isNoise(gram) { return noiseFilter && gram.some((w) => !validToken(w)); }

/* ---- count grams ---- */
const counts = new Map();
for (const it of items) {
  for (const sent of splitSents(it.text)) {
    const toks = sent.toLowerCase().match(/[a-z][a-z'-]+/g) || [];
    for (let n = NMIN; n <= NMAX; n++) {
      for (let i = 0; i + n <= toks.length; i++) {
        const gram = toks.slice(i, i + n);
        if (!ok(gram[0]) || !ok(gram[n - 1])) continue;
        if (gram.some((w) => w.length < 2)) continue;
        if (isNoise(gram)) continue;
        const key = gram.join(" ");
        counts.set(key, (counts.get(key) || 0) + 1);
      }
    }
  }
}

let ranked = [];
for (const [p, n] of counts) {
  if (n < MINCOUNT) continue;
  const words = p.split(" ").length;
  ranked.push({ p, n, score: n * (words >= 3 ? 1.1 : 1) });
}
ranked.sort((a, b) => b.score - a.score);
ranked = ranked.slice(0, Math.round(MAX * 1.6));

const cnt = new Map(ranked.map((r) => [r.p, r.n]));
const longer = ranked.filter((r) => r.p.split(" ").length >= 3).map((r) => r.p);
const redundant = new Set();
for (const r of ranked) {
  if (r.p.split(" ").length !== 2) continue;
  const pad = " " + r.p + " ";
  for (const q of longer) {
    if ((" " + q + " ").includes(pad) && cnt.get(q) >= r.n * 0.8) { redundant.add(r.p); break; }
  }
}
const finalPhrases = ranked.filter((r) => !redundant.has(r.p)).slice(0, MAX);

/* ---- one full pass: example clause + topic tally ---- */
const need = new Map();
const byFirst = new Map();
for (const r of finalPhrases) {
  need.set(r.p, r);
  const fw = r.p.split(" ")[0];
  if (!byFirst.has(fw)) byFirst.set(fw, []);
  byFirst.get(fw).push(r.p);
}
const topicTally = new Map();
for (const it of items) {
  const foundInItem = new Set();
  for (const sent of splitSents(it.text)) {
    const slow = sent.toLowerCase();
    const toks = slow.match(/[a-z][a-z'-]+/g) || [];
    const padded = " " + slow + " ";
    const seen = new Set();
    for (const w of toks) {
      if (seen.has(w) || !byFirst.has(w)) continue;
      seen.add(w);
      for (const p of byFirst.get(w)) {
        const r = need.get(p); if (!r) continue;
        if (padded.includes(" " + p + " ")) {
          if (!r.ex) {
            let ex = sent.replace(/\s+/g, " ").trim();
            if (ex.length > 200) ex = ex.slice(0, 200).replace(/\s+\S*$/, "") + "…";
            r.ex = ex;
          }
          foundInItem.add(p);
        }
      }
    }
  }
  for (const p of foundInItem) {
    let m = topicTally.get(p); if (!m) { m = new Map(); topicTally.set(p, m); }
    m.set(it.t, (m.get(it.t) || 0) + 1);
  }
}
function topicOf(p) {
  const m = topicTally.get(p); if (!m) return "";
  let best = "", bestN = -1;
  for (const [t, c] of m) if (c > bestN) { bestN = c; best = t; }
  return best;
}

const out = finalPhrases
  .map((r) => ({ p: r.p, n: r.n, g: glossOf(r.p), ex: r.ex || "", t: topicOf(r.p) }))
  .sort((a, b) => b.n - a.n);

const banner = "// AUTO-GENERATED by gen_phrases.mjs: high-frequency phrases mined from 88 rule PDFs (with CN gloss + topic).\n";
fs.writeFileSync(
  new URL("phrases.js", dir),
  banner + "window.RULE_PHRASES = " + JSON.stringify({ topics: TOPICS, items: out }) + ";\n"
);

console.log("unique grams:", counts.size, "-> kept:", out.length,
  "| with gloss:", out.filter((r) => r.g).length,
  "| with example:", out.filter((r) => r.ex).length,
  "| with topic:", out.filter((r) => r.t).length);
console.log("TOP 20:");
out.slice(0, 20).forEach((r, i) => console.log(String(i + 1).padStart(2), r.n, (r.t || "-").padEnd(10), r.p, "→", r.g || "(无)"));
