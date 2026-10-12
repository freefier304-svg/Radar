/*
 * parser.js
 * يحوّل نص رسالة عرض (من تليجرام أو واتساب) إلى بيانات منظمة:
 * العنوان، السعر الحالي، السعر القديم، نسبة الخصم، المتجر، رابط الشراء.
 * يعمل في Node وفي المتصفح بنفس الكود.
 *
 * مبدأ الأمان: لا يستنتج سعراً قديماً أو خصماً إلا من إشارة صريحة في الرسالة
 * (بدلاً من، كان، السعر قبل، سعر مشطوب، أو نسبة خصم مكتوبة). عدا ذلك يعرض السعر فقط.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DealParser = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var NOT_LETTER = '(^|[^\\u0600-\\u06FFA-Za-z])';
  var NOT_LETTER_AFTER = '(?![\\u0600-\\u06FFA-Za-z])';

  var STORE_RULES = [
    { key: 'amazon', label: 'أمازون مصر', host: /(^|\.)(amazon\.eg|amzn\.to|amzn\.eu|a\.co)$/i,
      words: new RegExp(NOT_LETTER + '(amazon|امازون)' + NOT_LETTER_AFTER, 'i') },
    { key: 'noon', label: 'نون', host: /(^|\.)noon\.com$/i,
      words: new RegExp(NOT_LETTER + '(noon|نون)' + NOT_LETTER_AFTER, 'i') },
    { key: 'breadfast', label: 'بريدفاست', host: /(^|\.)breadfast\.com$/i,
      words: /(breadfast|بريد\s?فاست)/i },
    { key: 'talabat', label: 'طلبات مارت', host: /(^|\.)talabat\.com$/i,
      words: /(talabat|طلبات\s?مارت)/i },
    { key: 'other', label: 'جوميا', host: /(^|\.)jumia\.com\.eg$/i, words: /(jumia|جوميا)/i },
    { key: 'other', label: 'كارفور', host: /(^|\.)carrefouregypt\.com$/i, words: /(carrefour|كارفور)/i }
  ];

  function normalize(text) {
    return String(text)
      .replace(/[٠-٩]/g, function (c) { return String(c.charCodeAt(0) - 1632); })
      .replace(/[۰-۹]/g, function (c) { return String(c.charCodeAt(0) - 1776); })
      .replace(/٬/g, ',')
      .replace(/٫/g, '.')
      .replace(new RegExp('[\\u064B-\\u065F\\u0670\\u0640]', 'g'), '')
      .replace(/[أإآ]/g, 'ا')
      .replace(/ى/g, 'ي')
      .replace(/ة/g, 'ه');
  }

  function hostStore(host) {
    host = String(host || '').toLowerCase();
    for (var i = 0; i < STORE_RULES.length; i++) {
      if (STORE_RULES[i].host.test(host)) return { key: STORE_RULES[i].key, label: STORE_RULES[i].label };
    }
    return null;
  }

  function textStore(t) {
    for (var i = 0; i < STORE_RULES.length; i++) {
      if (STORE_RULES[i].words.test(t)) return { key: STORE_RULES[i].key, label: STORE_RULES[i].label };
    }
    return null;
  }

  function hostOf(url) {
    var m = /^https?:\/\/([^\/:?#]+)/i.exec(url || '');
    return m ? m[1].toLowerCase() : '';
  }

  var NUM = '(\\d[\\d,]*(?:\\.\\d+)?)';
  var CUR = '(?:جنيه|ج\\.\\s?م|EGP|L\\.?E)(?![A-Za-z])';
  var EXCLUDE = /كاش\s?باك|cash\s?back|كوبون|coupon|كود|code|شحن|توصيل|رسوم|ضمان|قسط|اقساط|تقسيط|شهري|الحد الادني|حد ادني|يوفر|توفير|وفر|خصم\s?اضافي|بنك|كارت|فيزا/i;

  var OLD_CUE = new RegExp(
    '(?:^|[^\\u0600-\\u06FFA-Za-z])(?:بدل(?:ا)?(?:\\s*من)?|كان|السعر\\s*(?:قبل(?:\\s*الخصم)?|الاصلي|القديم)|قبل\\s*الخصم|قبل|was)\\s*[:：]?\\s*' + NUM, 'i');
  var NEW_CUE = new RegExp(
    '(?:السعر(?!\\s*(?:قبل|الاصلي|القديم))(?:\\s*(?:الان|الحالي|بعد\\s*الخصم))?|بسعر|سعر\\s*العرض|now|price)\\s*[:：]?\\s*' + NUM, 'i');
  var PERCENT = /(\d{1,2}(?:\.\d+)?)\s*(?:%|٪|في\s*المي[هة])/g;

  function toNum(s) {
    var v = parseFloat(String(s).replace(/,/g, ''));
    return isFinite(v) && v > 0 && v < 10000000 ? v : NaN;
  }

  function blank(len) { return new Array(len + 1).join(' '); }

  function currencyPrices(t) {
    var found = [], m;
    var re1 = new RegExp(NUM + '\\s*' + CUR, 'gi');
    var re2 = /(?:^|[^A-Za-z])EGP\s*[:：]?\s*(\d[\d,]*(?:\.\d+)?)/gi;
    function take(match, numStr, skipExclude) {
      var v = toNum(numStr);
      if (isNaN(v)) return;
      var start = match.index;
      var lineStart = t.lastIndexOf('\n', start) + 1;
      var before = t.slice(Math.max(lineStart, start - 18), start);
      var lastDigit = before.search(/\d[^\d]*$/);
      if (lastDigit > -1) before = before.slice(lastDigit + 1);
      found.push({ v: v, idx: start, excluded: EXCLUDE.test(before) });
    }
    while ((m = re1.exec(t))) take(m, m[1]);
    while ((m = re2.exec(t))) take(m, m[1]);
    found.sort(function (a, b) { return a.idx - b.idx; });
    return found;
  }

  function letters(s) {
    var m = String(s).match(new RegExp('[\\u0600-\\u06FFA-Za-z]', 'g'));
    return m ? m.length : 0;
  }

  var EMOJI = new RegExp('[\\u{1F000}-\\u{1FAFF}\\u{2190}-\\u{2BFF}\\u{FE0F}\\u200d]', 'gu');

  function cleanLine(l) {
    return String(l)
      .replace(/https?:\/\/\S+/g, ' ')
      .replace(/[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}(?:\/\S*)?/g, ' ')
      .replace(/~~[^~]*~~/g, ' ')
      .replace(EMOJI, '')
      .replace(/[*_`#>|•=–—\-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /* يقطع السطر عند أول كلمة سعر أو إشارة، فيبقى اسم المنتج فقط */
  var CUT = new RegExp('(?:' + NUM + '\\s*' + CUR + '|السعر|بسعر|بدل|جنيه|EGP|رابط|اضغط|للشراء|لينك|كوبون|كود|كاش باك)', 'i');
  function cutLine(l) {
    var m = CUT.exec(normalize(l));
    return m ? l.slice(0, m.index).trim() : l;
  }

  function pickTitle(raw) {
    var lines = String(raw).split(/\n+/).map(cleanLine).map(cutLine).filter(function (l) { return letters(l) >= 4; }).slice(0, 4);
    var best = '';
    lines.forEach(function (l) { if (letters(l) > letters(best)) best = l; });
    if (!best) {
      var first = String(raw).split(/\n+/).map(cleanLine).filter(Boolean)[0];
      best = first || 'عرض جديد';
    }
    return best.length > 110 ? best.slice(0, 110).trim() + '…' : best;
  }

  function uniq(a) {
    var seen = {}, out = [];
    a.forEach(function (x) { if (!seen[x]) { seen[x] = 1; out.push(x); } });
    return out;
  }

  function isTelegramLink(u) { return /^https?:\/\/(www\.)?(t\.me|telegram\.me|telegram\.org)\//i.test(u); }

  /**
   * input: { text: string, links?: string[] }
   * يرجع null إذا لم تكن الرسالة عرضاً (لا سعر ولا رابط).
   */
  function parseMessage(input) {
    var raw = String((input && input.text) || '');
    var links = ((input && input.links) || []).map(String);
    var urlRe = /https?:\/\/[^\s)<>"']+/gi, um;
    while ((um = urlRe.exec(raw))) links.push(um[0].replace(/[.,،؛]+$/, ''));
    links = uniq(links.filter(function (u) { return /^https?:\/\//i.test(u); }));
    var buy = links.filter(function (u) { return !isTelegramLink(u); })[0] || '';

    var t = normalize(raw).replace(/https?:\/\/\S+/gi, function (x) { return blank(x.length); });

    var oldL = null, newL = null, m;
    if ((m = OLD_CUE.exec(t))) oldL = toNum(m[m.length - 1]);
    if ((m = NEW_CUE.exec(t))) newL = toNum(m[1]);
    if (isNaN(oldL)) oldL = null;
    if (isNaN(newL)) newL = null;

    var struck = [], sre = /~~([^~]+)~~/g;
    while ((m = sre.exec(t))) {
      var nm = /(\d[\d,]*(?:\.\d+)?)/.exec(m[1]);
      if (nm && !isNaN(toNum(nm[1]))) struck.push(toNum(nm[1]));
    }

    var all = currencyPrices(t);
    var cands = all.filter(function (c) { return !c.excluded; }).map(function (c) { return c.v; });
    if (!cands.length && all.length) cands = [all[0].v];

    var now = newL, old = null, conf = 'none';
    if (oldL !== null) old = oldL;
    else if (struck.length) old = Math.max.apply(null, struck);

    if (now === null) {
      var pool = cands.filter(function (v) { return v !== old; });
      if (pool.length) now = pool[0];
    }
    if (old !== null && now !== null && (old <= now || old / now > 10)) old = null;

    var disc = null;
    if (now !== null) conf = 'single';
    if (old !== null && now !== null) {
      disc = Math.round((1 - now / old) * 100);
      conf = 'labeled';
    } else if (now !== null) {
      var best = null, pm;
      PERCENT.lastIndex = 0;
      while ((pm = PERCENT.exec(t))) {
        var pv = parseFloat(pm[1]);
        var ctx = t.slice(Math.max(0, pm.index - 18), pm.index);
        if (pv >= 5 && pv <= 90 && !EXCLUDE.test(ctx) && (best === null || pv > best)) best = pv;
      }
      if (best !== null) {
        old = Math.round(now / (1 - best / 100));
        disc = Math.round(best);
        conf = 'stated';
      }
    }

    if (now === null && !buy) return null;

    var store = null, i;
    for (i = 0; i < links.length && !store; i++) store = hostStore(hostOf(links[i]));
    if (!store) store = textStore(t);
    if (!store) store = { key: 'other', label: null };

    return {
      title: pickTitle(raw),
      now: now,
      old: old,
      disc: disc,
      store: store.key,
      storeLabel: store.label,
      url: buy,
      conf: conf
    };
  }

  return { parseMessage: parseMessage, hostStore: hostStore, normalize: normalize, hostOf: hostOf };
});
    
