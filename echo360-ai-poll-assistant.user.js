// ==UserScript==
// @name         Echo360 AI Poll Assistant
// @namespace    https://github.com/rsharma929/echo360-ai-poll-assistant
// @version      0.4.1
// @description  AI-assisted responder for PointSolutions / Echo360 browser polls, with a resizable in-page panel. Answers MCQ + short answer via Groq (your free key) — reads the question from page text OR the slide image (vision). Offline pools as fallback.
// @author       Rohan
// @license      MIT
// @match        https://*.ttpoll.com/*
// @match        https://ttpoll.com/*
// @match        https://*.echo360.com/*
// @match        https://echo360.com/*
// @match        https://*.turningtechnologies.com/*
// @match        https://turningtechnologies.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      api.groq.com
// @connect      user-content.turningtechnologies.com
// @connect      turningtechnologies.com
// @connect      echo360.com
// @run-at       document-idle
// @downloadURL  https://raw.githubusercontent.com/rsharma929/echo360-ai-poll-assistant/main/echo360-ai-poll-assistant.user.js
// @updateURL    https://raw.githubusercontent.com/rsharma929/echo360-ai-poll-assistant/main/echo360-ai-poll-assistant.user.js
// ==/UserScript==

/*
 * Standalone AI Poll Assistant — NOT pointsolutions-poll-automation.
 * Brain: Groq (OpenAI-compatible) via GM_xmlhttpRequest — bypasses the site CSP that blocks
 *   in-page SDKs like Puter. Needs the user's own FREE Groq key (console.groq.com), stored
 *   on-device. One model handles text AND vision (slide images sent as base64).
 * One-off per question (stateless). Only case-linked questions get a tiny context blurb.
 * MCQ -> AI returns only the option (matched + clicked). Short answer -> only a short phrase.
 * Timing: AI on -> submit the instant it replies; AI slow/fails -> offline promptly; the
 *   random 0.5-7.5s delay applies ONLY in offline-only mode. Auto-submit OFF by default.
 */
(function () {
    'use strict';

    // ==========================================================================
    // 0. CONFIG + SETTINGS (GM storage, with localStorage fallback)
    // ==========================================================================
    const NS = 'ePA_';
    const SCAN_MS = 1000;
    const MIN_DELAY_MS = 500, MAX_DELAY_MS = 7500;
    const AI_TIMEOUT_MS = 9000;
    const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
    const GROQ_MODELS_URL = 'https://api.groq.com/openai/v1/models';
    const DEFAULT_MODEL = 'openai/gpt-oss-120b';   // current text default; click "Refresh" to list vision-capable models
    const OFFLINE = 'offline';
    const STARTER_MODELS = ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'llama-3.3-70b-versatile'];
    const BASE_SYSTEM = 'You help a student answer a live medical-school class poll quickly ' +
        '(preclinical / basic sciences: anatomy, physiology, biochemistry, pharmacology, microbiology, ' +
        'pathology, histology). Answers need not be certain or fully correct. Be extremely brief.';

    const DEFAULT_POOL = ['Supportive care', 'Monitor and reassess', 'Depends on the mechanism',
        'Increased activity', 'Inflammation', 'Negative feedback', 'Homeostasis'];
    const CATEGORY_POOLS = {
        drug:      ['Beta blocker', 'ACE inhibitor', 'Penicillin', 'NSAID', 'Statin', 'Corticosteroid', 'Levothyroxine'],
        histology: ['Squamous epithelium', 'Goblet cells', 'Granuloma', 'Hyperplasia', 'Follicular cells', 'Columnar epithelium'],
        diagnosis: ['Iron deficiency anemia', 'Type 1 diabetes', 'Pneumonia', 'Hashimoto thyroiditis', 'Myocardial infarction'],
        outcome:   ['Decreased cardiac output', 'Hypoxia', 'Acidosis', 'Vasodilation', 'Increased mortality'],
        mechanism: ['Increased cAMP', 'Inhibits the enzyme', 'Blocks the receptor', 'Competitive inhibition', 'Increased sympathetic tone'],
        general:   DEFAULT_POOL
    };
    const TOPIC_BANKS = {
        thyroid: ['Levothyroxine', 'Hashimoto thyroiditis', 'Graves disease', 'TSH', 'Follicular cells', 'Methimazole', 'Hypothyroidism'],
        cardio:  ['Reduced ejection fraction', 'Beta blocker', 'ACE inhibitor', 'Myocardial infarction', 'Afterload', 'Loop diuretic'],
        renal:   ['RAAS activation', 'Loop diuretic', 'Acute tubular necrosis', 'GFR', 'Hyperkalemia', 'Metabolic acidosis'],
        pulm:    ['Hypoxemia', 'V/Q mismatch', 'Bronchodilator', 'Surfactant', 'Pneumonia', 'Obstructive pattern'],
        heme:    ['Iron deficiency anemia', 'Hemolysis', 'Thrombocytopenia', 'Vitamin B12 deficiency', 'Reticulocytes'],
        gi:      ['PPI', 'H. pylori', 'Cirrhosis', 'Malabsorption', 'Portal hypertension'],
        endo:    ['Insulin', 'Cortisol', 'Negative feedback', 'Diabetes mellitus', 'Thyroid hormone'],
        neuro:   ['Acetylcholine', 'Dopamine', 'Upper motor neuron', 'Demyelination', 'Seizure'],
        id:      ['Penicillin', 'Gram-positive cocci', 'Vancomycin', 'Sepsis', 'Endotoxin']
    };

    const store = {
        get(k, d) { try { if (typeof GM_getValue !== 'undefined') { const v = GM_getValue(NS + k, '\u0000'); return v === '\u0000' ? d : v; } const s = localStorage.getItem(NS + k); return s === null ? d : JSON.parse(s); } catch (e) { return d; } },
        set(k, v) { try { if (typeof GM_setValue !== 'undefined') GM_setValue(NS + k, v); else localStorage.setItem(NS + k, JSON.stringify(v)); } catch (e) {} }
    };
    const DEFAULTS = {
        power: true, paused: false, autoSubmit: false, aiForMCQ: true, aiForText: true,
        theme: 'auto', fontScale: 1, model: DEFAULT_MODEL, topic: '',
        groqKey: '', panelW: 0, panelH: 0
    };
    const S = {};
    for (const k in DEFAULTS) S[k] = store.get(k, DEFAULTS[k]);
    if (S.model !== OFFLINE && /\s/.test(String(S.model))) S.model = DEFAULT_MODEL;  // migrate old friendly-label model values
    function saveSetting(k, v) { S[k] = v; store.set(k, v); }
    const rint = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));

    // ==========================================================================
    // 1. DETECTION HELPERS (Angular-safe)
    // ==========================================================================
    function isVisible(el) {
        const r = el.getBoundingClientRect(), st = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && st.display !== 'none' && st.visibility !== 'hidden' && st.opacity !== '0';
    }
    function classStr(el) {
        if (!el) return '';
        return (typeof el.className === 'string' ? el.className : (el.className && el.className.baseVal) || '').toString().toLowerCase();
    }
    function isSvgNode(el) { return el instanceof SVGElement || /^(svg|foreignobject|text|path|g|rect|circle)$/i.test(el.tagName); }
    const NON_ANSWER_WORDS = ['chat', 'messaging', 'support', 'help', 'close', 'menu', 'settings',
        'navbar', 'navigation', 'exit', 'leave', 'confirm', 'cancel', 'dismiss', 'logout', 'log out',
        'sign out', 'signout', 'intercom', 'zendesk', 'crisp', 'drift', 'hubspot', 'launcher',
        'widget', 'bubble', 'beacon', 'livechat', 'tt-nav', 'question', 'chart'];
    const NAV_WORDS = ['leave', 'exit', 'close', 'menu', 'settings', 'confirm', 'cancel', 'dismiss',
        'logout', 'log out', 'sign out', 'signout', 'navbar', 'navigation'];
    function matchesWords(el, words, includeOwnText) {
        const g = n => (el.getAttribute && (el.getAttribute(n) || '').toLowerCase()) || '';
        const aria = g('aria-label'), id = (el.id || '').toLowerCase(), cls = classStr(el);
        const pCls = classStr(el.parentElement), pId = (el.parentElement && (el.parentElement.id || '').toLowerCase()) || '';
        let text = '';
        if (includeOwnText) { text = (el.innerText || '').toLowerCase().trim(); if (text.length > 20) text = ''; }
        return words.some(w => aria.includes(w) || id.includes(w) || cls.includes(w) || pCls.includes(w) || pId.includes(w) || (text && text.includes(w)));
    }
    function isChatSupport(el) {
        const structural = ['intercom', 'zendesk', 'crisp', 'drift', 'beacon', 'hubspot', 'launcher',
            'chat-widget', 'chatwidget', 'livechat', 'helpdesk', 'support-bubble', 'messaging'];
        let n = el, hops = 0;
        while (n && hops < 12) {
            const c = classStr(n), id = (n.id || '').toLowerCase();
            const aria = (n.getAttribute && (n.getAttribute('aria-label') || '').toLowerCase()) || '';
            if (structural.some(w => c.includes(w) || id.includes(w) || aria.includes(w))) return true;
            n = n.parentElement; hops++;
        }
        return false;
    }
    function isNonAnswerButton(el) {
        if (el.disabled || el.tagName === 'IFRAME') return true;
        if (el.getAttribute && el.getAttribute('role') === 'tab') return true;
        if (isChatSupport(el)) return true;
        return matchesWords(el, NON_ANSWER_WORDS, true);
    }
    function isBadInput(el) { if (el.disabled || el.tagName === 'IFRAME') return true; return isChatSupport(el); }
    function setNativeValue(el, value) {
        const win = el.ownerDocument.defaultView || window;
        const proto = el.tagName === 'TEXTAREA' ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
        setter.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    function realClick(target, x, y) {
        const opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0 };
        ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(type => {
            const Ctor = type.startsWith('pointer') && window.PointerEvent ? PointerEvent : MouseEvent;
            const o = Ctor === PointerEvent ? Object.assign({ pointerType: 'mouse', isPrimary: true }, opts) : opts;
            target.dispatchEvent(new Ctor(type, o));
        });
    }
    function findSubmitButton(input) {
        let c = input;
        for (let i = 0; i < 5 && c.parentElement; i++) c = c.parentElement;
        const cands = Array.from(c.querySelectorAll('button,[role="button"],input[type="submit"]'))
            .filter(b => isVisible(b) && !b.disabled && !isChatSupport(b) && !matchesWords(b, NAV_WORDS, true));
        if (!cands.length) return null;
        const scored = cands.map(b => {
            const t = (b.innerText || b.value || '').toLowerCase().trim();
            const aria = (b.getAttribute('aria-label') || '').toLowerCase(), type = (b.getAttribute('type') || '').toLowerCase();
            const icon = !!b.querySelector('svg,i,[class*="icon" i],[class*="arrow" i]');
            let sc = 0;
            if (aria.includes('submit') || aria.includes('send') || aria.includes('respond')) sc += 5;
            if (type === 'submit') sc += 4;
            if (icon && t.length === 0) sc += 3;
            if (t.includes('submit') || t.includes('send') || t.includes('respond')) sc += 3;
            return { b, sc };
        }).sort((a, b) => b.sc - a.sc);
        return scored[0].sc > 0 ? scored[0].b : cands[0];
    }
    function onResultsScreen() {
        if (document.querySelector('.correctAnswer, .correctAnswerIcon, [class*="correctAnswer" i]')) return true;
        const chart = Array.from(document.querySelectorAll('button')).find(b =>
            (b.innerText || '').trim().toLowerCase() === 'chart' && classStr(b).includes('btn-primary'));
        return !!chart;
    }
    function getChoices() {
        const raw = document.querySelectorAll(
            'input[type="radio"],input[type="checkbox"],[role="radio"],[role="checkbox"],[class*="answer" i],[class*="choice" i],[class*="option" i],button');
        return Array.from(raw).filter(el => {
            if (isSvgNode(el) || !isVisible(el) || isNonAnswerButton(el)) return false;
            const text = (el.innerText || '').toLowerCase().trim(), cls = classStr(el);
            const isInput = el.tagName === 'INPUT';
            const isRole = el.getAttribute('role') === 'radio' || el.getAttribute('role') === 'checkbox';
            const good = cls.includes('choice') || cls.includes('answer') || cls.includes('option');
            const isSubmit = text.includes('submit') || text.includes('send') || text.includes('respond') || cls.includes('submit');
            const shortBtn = el.tagName === 'BUTTON' && text.length > 0 && text.length < 40 && !isSubmit;
            return isInput || isRole || good || shortBtn;
        });
    }
    function getTextInputs() {
        return Array.from(document.querySelectorAll('input[type="text"],textarea,[role="textbox"]')).filter(el => {
            if (!isVisible(el) || isBadInput(el)) return false;
            const ph = (el.getAttribute('placeholder') || '').toLowerCase();
            return !(ph.includes('search') || ph.includes('message') || ph.includes('chat'));
        });
    }
    function anySelected(choices) {
        return choices.some(el => (el.tagName === 'INPUT' && (el.type === 'radio' || el.type === 'checkbox')) ? el.checked :
            el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-selected') === 'true' ||
            el.classList.contains('selected') || el.classList.contains('checked') || el.classList.contains('active'));
    }
    function getQuestionText() {
        const sel = '[class*="question" i],[class*="prompt" i],[class*="stem" i],[class*="title" i]';
        let best = '';
        document.querySelectorAll(sel).forEach(el => {
            if (!isVisible(el) || classStr(el).includes('polling-title')) return;
            const t = (el.innerText || '').trim();
            if (t.length > best.length && t.length < 400) best = t;
        });
        return best;
    }
    function getSessionTitle() {
        const el = document.querySelector('.polling-title,[class*="polling-title" i]');
        return el ? (el.innerText || '').trim() : '';
    }
    function getSlideImage() {
        const imgs = Array.from(document.querySelectorAll('img')).filter(el => {
            if (!isVisible(el) || el.closest('button,a,[role="button"]')) return false;
            const r = el.getBoundingClientRect();
            if (r.width < 160 || r.height < 110) return false;
            const cls = classStr(el) + ' ' + classStr(el.parentElement);
            return !['icon', 'logo', 'avatar', 'chart', 'result', 'graph', 'poll-results'].some(w => cls.includes(w));
        });
        return imgs.length ? (imgs[0].currentSrc || imgs[0].src || '') : '';
    }

    // ==========================================================================
    // 2. OFFLINE ANSWERS (fallback tier)
    // ==========================================================================
    const STOP = new Set(['the', 'a', 'an', 'of', 'to', 'is', 'are', 'and', 'or', 'for', 'in', 'on',
        'with', 'what', 'which', 'this', 'that', 'patient', 'following', 'most', 'likely', 'best']);
    function classify(q) {
        const t = (q || '').toLowerCase();
        if (/\btrue or false\b/.test(t)) return 'tf';
        if (/^(is|are|am|was|were|do|does|did|can|could|should|would|will|have|has)\b/.test(t) || /\byes or no\b/.test(t)) return 'yn';
        if (/\b(drug|agent|medication|which drug|class of)\b/.test(t)) return 'drug';
        if (/\b(histo|stain|slide|identify|cell|tissue|microscop)\b/.test(t)) return 'histology';
        if (/\b(treat|manage|therapy|intervention)\b/.test(t)) return 'drug';
        if (/\bdiagnos/.test(t)) return 'diagnosis';
        if (/\b(what would happen|effect|result|outcome|lead to|consequence)\b/.test(t)) return 'outcome';
        if (/\b(mechanism|why|how|cause|pathophys)\b/.test(t)) return 'mechanism';
        return 'general';
    }
    const pick = arr => arr[Math.floor(Math.random() * arr.length)];
    function topicBank() {
        const t = (S.topic || '').toLowerCase();
        if (!t) return null;
        for (const k in TOPIC_BANKS) if (t.includes(k)) return TOPIC_BANKS[k];
        const words = t.split(/[^a-z]+/).filter(w => w.length > 3 && !STOP.has(w));
        return words.length ? words.map(w => w[0].toUpperCase() + w.slice(1)) : null;
    }
    function offlineAnswer(qText, hasText) {
        const cat = classify(qText);
        if (cat === 'tf') return { text: pick(['True', 'False']), tier: 'Offline' };
        if (cat === 'yn') return { text: pick(['Yes', 'No']), tier: 'Offline' };
        if (hasText && CATEGORY_POOLS[cat]) return { text: pick(CATEGORY_POOLS[cat]), tier: 'Offline' };
        const bank = topicBank();
        if (bank) return { text: pick(bank), tier: 'Offline · topic' };
        return { text: pick(DEFAULT_POOL), tier: 'Offline' };
    }

    // ==========================================================================
    // 3. AI BRAIN (Groq via GM_xmlhttpRequest — bypasses CSP; text + vision)
    // ==========================================================================
    let memory = [];
    function rememberQA(q, a) { if (q || a) { memory.push('Q: ' + (q || '[image]') + ' | A: ' + a); if (memory.length > 6) memory.shift(); } updateMemoryView(); }
    function hasKey() { return !!(S.groqKey && S.groqKey.length > 10); }
    function aiOn() { return S.model !== OFFLINE && hasKey(); }
    function aiForType(mode) { return aiOn() && (mode === 'mcq' ? S.aiForMCQ : S.aiForText); }
    function isCaseQuestion(q) { return /\b(this patient|the patient|patient'?s|the above|same patient|this case|continues|previously|as described|in the vignette)\b/i.test(q || ''); }
    function withTimeout(p, ms) { return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]); }

    function gmRequest(opts) {
        return new Promise((resolve, reject) => {
            const fn = (typeof GM_xmlhttpRequest !== 'undefined') ? GM_xmlhttpRequest
                : (typeof GM !== 'undefined' && GM.xmlHttpRequest) ? GM.xmlHttpRequest : null;
            if (!fn) return reject(new Error('GM_xmlhttpRequest unavailable'));
            try { fn(Object.assign({ onload: resolve, onerror: () => reject(new Error('network')), ontimeout: () => reject(new Error('timeout')) }, opts)); }
            catch (e) { reject(e); }
        });
    }
    async function groqChat(messages) {
        if (!hasKey()) throw new Error('no key');
        const model = (S.model && S.model !== OFFLINE) ? S.model : DEFAULT_MODEL;
        const r = await gmRequest({
            method: 'POST', url: GROQ_URL, timeout: AI_TIMEOUT_MS,
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + S.groqKey },
            data: JSON.stringify({ model, messages, temperature: 0.3, max_tokens: 100 })
        });
        if (r.status < 200 || r.status >= 300) throw new Error('HTTP ' + r.status + ' ' + (r.responseText || '').slice(0, 140));
        const j = JSON.parse(r.responseText);
        return (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
    }
    async function fetchImageDataUrl(url) {
        const r = await gmRequest({ method: 'GET', url, responseType: 'blob', timeout: AI_TIMEOUT_MS });
        if (r.status && (r.status < 200 || r.status >= 300)) throw new Error('img HTTP ' + r.status);
        const blob = r.response; if (!blob) throw new Error('no blob');
        if (blob.size > 3.8 * 1024 * 1024) throw new Error('image too large');
        return await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = () => rej(new Error('read fail')); fr.readAsDataURL(blob); });
    }
    function cleanAnswer(t) { return (t || '').trim().split('\n')[0].trim().replace(/^["'`*\s]+|["'`*\s]+$/g, '').replace(/^(answer|ans)[:\-]\s*/i, '').trim(); }

    async function aiAnswer(ctx) {
        if (!aiForType(ctx.mode)) return null;
        try {
            let imgDataUrl = null;
            if (ctx.imageUrl) { try { imgDataUrl = await fetchImageDataUrl(ctx.imageUrl); } catch (e) { imgDataUrl = null; } }
            if (!ctx.qText && !imgDataUrl) return null;   // nothing readable -> fall back
            const blurb = ctx.caseBlurb ? ctx.caseBlurb + '\n' : '';
            let userText;
            if (ctx.mode === 'mcq' && ctx.choices.length) {
                userText = blurb + 'Multiple-choice question.\nOptions:\n' + ctx.choices.map((c, i) => (i + 1) + '. ' + c).join('\n') + '\n' +
                    (ctx.qText ? ('Question: ' + ctx.qText) : 'The question is in the image.') +
                    '\nReply with ONLY the exact text of the single best option above. No other words.';
            } else {
                userText = blurb + (ctx.qText ? ('Question: ' + ctx.qText) : 'The question is in the image — read it.') +
                    '\nReply with ONLY the answer: one word or a short phrase. No other words.';
            }
            const content = imgDataUrl ? [{ type: 'text', text: userText }, { type: 'image_url', image_url: { url: imgDataUrl } }] : userText;
            const messages = [{ role: 'system', content: BASE_SYSTEM }, { role: 'user', content }];
            const txt = cleanAnswer(await withTimeout(groqChat(messages), AI_TIMEOUT_MS + 1500));
            if (!txt) return null;
            return { text: txt.slice(0, 160), tier: 'Groq' + (imgDataUrl ? ' · vision' : '') };
        } catch (e) { return null; }
    }

    // ==========================================================================
    // 4. PANEL (Shadow DOM)
    // ==========================================================================
    const host = document.createElement('div');
    host.id = 'echo360-ai-poll-assistant-host';
    host.style.cssText = 'all:initial';
    document.documentElement.appendChild(host);
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = PANEL_HTML();
    applyTheme(S.theme); applyFont(S.fontScale);
    const $ = s => root.querySelector(s);
    const $$ = s => Array.from(root.querySelectorAll(s));
    function applyTheme(v) { if (v === 'auto') root.host.removeAttribute('data-theme'); else root.host.setAttribute('data-theme', v); }
    function applyFont(f) { root.host.style.setProperty('--fs', f); }

    function PANEL_HTML() {
        return `<style>
:host{ --fs:1;
  --surface:#fff; --surface-2:#f3f6fa; --surface-3:#e9eef4; --border:#d8dee7; --border-2:#e7ecf2;
  --fg:#1a2130; --fg-dim:#5c6678; --fg-faint:#8b95a6;
  --accent:#0b8c9b; --accent-weak:#d7f0f2; --accent-fg:#fff;
  --good:#1f9d57; --warn:#b9781a; --warn-weak:#f6ecd7; --bad:#cf3b3b;
  --shadow:0 12px 34px rgba(26,33,48,.22),0 2px 8px rgba(26,33,48,.12);
  --font:"IBM Plex Sans",system-ui,-apple-system,sans-serif; --mono:"IBM Plex Mono",ui-monospace,Menlo,monospace; all:initial; }
@media (prefers-color-scheme:dark){:host(:not([data-theme="light"])){
  --surface:#161c26; --surface-2:#1d2430; --surface-3:#242c39; --border:#2a3340; --border-2:#222a35;
  --fg:#e7ebf1; --fg-dim:#9aa6b7; --fg-faint:#6b7585; --accent:#2ad2c4; --accent-weak:#11312f; --accent-fg:#052321;
  --good:#3ecb79; --warn:#e0a33a; --warn-weak:#33280f; --bad:#ef6b6b; --shadow:0 14px 40px rgba(0,0,0,.55),0 2px 10px rgba(0,0,0,.4); }}
:host([data-theme="dark"]){
  --surface:#161c26; --surface-2:#1d2430; --surface-3:#242c39; --border:#2a3340; --border-2:#222a35;
  --fg:#e7ebf1; --fg-dim:#9aa6b7; --fg-faint:#6b7585; --accent:#2ad2c4; --accent-weak:#11312f; --accent-fg:#052321;
  --good:#3ecb79; --warn:#e0a33a; --warn-weak:#33280f; --bad:#ef6b6b; --shadow:0 14px 40px rgba(0,0,0,.55),0 2px 10px rgba(0,0,0,.4); }
*{box-sizing:border-box}
.panel{position:fixed;top:16px;right:16px;width:360px;height:min(600px,calc(100vh - 32px));min-width:300px;min-height:240px;max-width:96vw;max-height:calc(100vh - 32px);
  background:var(--surface);color:var(--fg);border:1px solid var(--border);border-radius:14px;box-shadow:var(--shadow);
  font-family:var(--font);font-size:calc(13px*var(--fs));z-index:2147483646;display:flex;flex-direction:column;overflow:hidden;resize:both}
.panel.off{filter:grayscale(.6) opacity(.72)}
.hd{display:flex;align-items:center;gap:8px;padding:10px 12px;cursor:grab;user-select:none;background:linear-gradient(var(--surface-2),var(--surface));border-bottom:1px solid var(--border-2);touch-action:none;flex:0 0 auto}
.brand{display:flex;align-items:center;gap:8px;font-weight:600}
.spark{width:16px;height:16px;border-radius:5px;background:linear-gradient(135deg,var(--accent),#7c5cff);box-shadow:0 0 0 3px var(--accent-weak)}
.state{margin-left:auto;display:inline-flex;align-items:center;gap:6px;font-size:calc(11px*var(--fs));font-family:var(--mono);color:var(--fg-dim);background:var(--surface-3);border:1px solid var(--border-2);border-radius:999px;padding:3px 9px;white-space:nowrap}
.pulse{width:7px;height:7px;border-radius:50%;background:var(--fg-faint)}
.state[data-s="answering"] .pulse{background:var(--warn);animation:blink 1s infinite}
.state[data-s="answered"] .pulse{background:var(--good)}
.state[data-s="off"] .pulse{background:var(--bad)}
@keyframes blink{50%{opacity:.3}}
.iconbtn{width:28px;height:28px;border:1px solid var(--border);background:var(--surface);color:var(--fg-dim);border-radius:7px;cursor:pointer;font-size:13px;display:grid;place-items:center;padding:0}
.iconbtn:hover{color:var(--fg);border-color:var(--accent)}
.hdc{display:flex;gap:6px}
.body{flex:0 0 auto}
.sec{padding:12px;border-bottom:1px solid var(--border-2);display:flex;flex-direction:column;gap:10px}
.eyebrow{font-size:calc(10px*var(--fs));letter-spacing:.09em;text-transform:uppercase;color:var(--fg-faint);font-weight:600}
.chips{display:flex;flex-wrap:wrap;gap:6px}
.chip{font-size:calc(11px*var(--fs));font-family:var(--mono);padding:3px 8px;border-radius:7px;border:1px solid var(--border);background:var(--surface-2);color:var(--fg-dim)}
.chip.type{background:var(--accent-weak);border-color:color-mix(in srgb,var(--accent) 35%,transparent);color:color-mix(in srgb,var(--accent) 72%,var(--fg))}
.chip.cas{background:var(--warn-weak);border-color:color-mix(in srgb,var(--warn) 30%,transparent);color:color-mix(in srgb,var(--warn) 80%,var(--fg))}
.chip b{color:var(--fg)}
.qtext{font-size:calc(14px*var(--fs));line-height:1.4;font-weight:500}
.qtext.dim{font-family:var(--mono);font-size:calc(12px*var(--fs));color:var(--fg-dim);font-weight:400}
.ans{background:var(--surface-2);border:1px solid var(--border);border-radius:11px;padding:11px;display:flex;flex-direction:column;gap:9px}
.ans-head{display:flex;align-items:center;gap:8px}
.tier{font-size:calc(10px*var(--fs));font-family:var(--mono);padding:2px 7px;border-radius:6px;background:var(--surface-3);color:var(--fg-dim);border:1px solid var(--border)}
.ans-val{font-size:calc(15px*var(--fs));font-weight:600;line-height:1.35;background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:9px 11px;color:var(--fg);width:100%;font-family:var(--font);resize:none;min-height:40px}
.ans-val:focus{outline:2px solid var(--accent);outline-offset:1px}
.count{display:flex;align-items:center;gap:8px;font-size:calc(11px*var(--fs));color:var(--fg-dim);font-family:var(--mono)}
.bar{flex:1;height:5px;border-radius:999px;background:var(--surface-3);overflow:hidden}
.bar i{display:block;height:100%;background:var(--accent);transform-origin:left}
.btns{display:flex;gap:6px;flex-wrap:wrap}
.btn{flex:1;min-width:84px;border:1px solid var(--border);background:var(--surface);color:var(--fg);border-radius:8px;padding:8px 10px;font-size:calc(12.5px*var(--fs));font-weight:600;cursor:pointer;font-family:var(--font)}
.btn:hover{border-color:var(--accent)}
.btn.primary{background:var(--accent);color:var(--accent-fg);border-color:var(--accent)}
.btn:disabled{opacity:.45;cursor:not-allowed}
.idle{display:flex;align-items:center;gap:9px;color:var(--fg-dim);font-size:calc(12.5px*var(--fs))}
.idle .eye{width:26px;height:26px;border-radius:8px;background:var(--surface-3);display:grid;place-items:center}
.tabs{display:flex;gap:2px;padding:8px 10px 0;border-bottom:1px solid var(--border-2);flex:0 0 auto}
.tab{flex:1;border:none;background:transparent;color:var(--fg-dim);font-weight:600;font-size:calc(11.5px*var(--fs));font-family:var(--font);padding:8px 4px;cursor:pointer;border-bottom:2px solid transparent;border-radius:6px 6px 0 0}
.tab[aria-selected="true"]{color:var(--fg);border-bottom-color:var(--accent);background:var(--surface-2)}
.tabwrap{padding:12px;display:flex;flex-direction:column;gap:10px;flex:1 1 auto;min-height:0;overflow-y:auto}
.log{display:flex;flex-direction:column;gap:8px}
.logitem{border:1px solid var(--border-2);border-radius:9px;padding:8px 10px;background:var(--surface-2);display:flex;flex-direction:column;gap:3px}
.logitem .lq{font-size:calc(11.5px*var(--fs));color:var(--fg-dim);line-height:1.3}
.logitem .la{font-size:calc(13px*var(--fs));font-weight:600;display:flex;align-items:center;gap:7px}
.logitem .meta{font-family:var(--mono);font-size:calc(10px*var(--fs));color:var(--fg-faint);display:flex;gap:8px}
.dotok{width:7px;height:7px;border-radius:50%;background:var(--good)}
.chat{display:flex;flex-direction:column;gap:8px}
.msg{max-width:88%;padding:8px 11px;border-radius:12px;font-size:calc(12.5px*var(--fs));line-height:1.4}
.msg.ai{align-self:flex-start;background:var(--surface-2);border:1px solid var(--border-2);border-bottom-left-radius:4px}
.msg.me{align-self:flex-end;background:var(--accent);color:var(--accent-fg);border-bottom-right-radius:4px}
.chatbar{display:flex;gap:6px;margin-top:2px}
.field{display:flex;flex-direction:column;gap:6px}
.field label{font-size:calc(11.5px*var(--fs));color:var(--fg-dim);font-weight:600}
.row{display:flex;align-items:center;justify-content:space-between;gap:10px}
select,.input{width:100%;min-width:0;border:1px solid var(--border);background:var(--surface);color:var(--fg);border-radius:8px;padding:7px 9px;font-size:calc(12.5px*var(--fs));font-family:var(--font)}
textarea.input{min-height:60px;resize:vertical}
a.lnk{color:var(--accent);text-decoration:none}
.seg{display:flex;border:1px solid var(--border);border-radius:8px;overflow:hidden}
.seg button{flex:1;border:none;background:var(--surface);color:var(--fg-dim);padding:7px 4px;font-size:calc(11.5px*var(--fs));font-weight:600;cursor:pointer;font-family:var(--font)}
.seg button[aria-pressed="true"]{background:var(--accent);color:var(--accent-fg)}
input[type=range]{width:100%;accent-color:var(--accent)}
.toggle{position:relative;width:38px;height:22px;border-radius:999px;background:var(--surface-3);border:1px solid var(--border);cursor:pointer;flex:none}
.toggle::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--fg-faint);transition:transform .15s,background .15s}
.toggle[aria-pressed="true"]{background:var(--accent);border-color:var(--accent)}
.toggle[aria-pressed="true"]::after{transform:translateX(16px);background:#fff}
.hint{font-size:calc(10.5px*var(--fs));color:var(--fg-faint);line-height:1.4}
.aistat{font-family:var(--mono);font-size:calc(10.5px*var(--fs));padding:2px 7px;border-radius:6px;border:1px solid var(--border)}
.memview{background:var(--surface-2);border:1px solid var(--border-2);border-radius:8px;padding:8px 10px;font-family:var(--mono);font-size:calc(10.5px*var(--fs));color:var(--fg-dim);max-height:120px;overflow:auto;white-space:pre-wrap}
.collapsed .body,.collapsed .tabs,.collapsed .tabwrap{display:none}
.collapsed{resize:none;height:auto!important}
@media (max-width:440px){.panel{left:12px;right:12px;width:auto;max-width:none}}
</style>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap">
<section class="panel" id="panel">
  <header class="hd" id="drag">
    <span class="spark"></span><span class="brand">Poll Assistant</span>
    <span class="state" id="state" data-s="idle"><span class="pulse"></span><span id="stateTxt">Idle</span></span>
    <span class="hdc">
      <button class="iconbtn" id="power" title="On / off">&#9211;</button>
      <button class="iconbtn" id="pause" title="Pause auto-answer">&#9208;</button>
      <button class="iconbtn" id="collapse" title="Collapse">&#9662;</button>
    </span>
  </header>
  <div class="body" id="pbody">
    <div class="sec" id="qsec">
      <div class="eyebrow">Current question</div>
      <div class="chips" id="chips"></div>
      <div class="qtext" id="qtext">&mdash;</div>
    </div>
    <div class="sec" id="ansSec">
      <div class="ans">
        <div class="ans-head"><span class="eyebrow" style="margin:0">Proposed answer</span><span class="tier" id="tier">&mdash;</span></div>
        <textarea class="ans-val" id="ansVal" rows="1" aria-label="Proposed answer"></textarea>
        <div class="count" id="countRow"><span id="countTxt">&mdash;</span><span class="bar"><i id="countBar"></i></span></div>
        <div class="btns">
          <button class="btn primary" id="submit">Submit now</button>
          <button class="btn" id="regen">Regenerate</button>
        </div>
      </div>
    </div>
    <div class="sec" id="idleSec" hidden><div class="idle"><span class="eye">&#128065;</span><span>Watching slides — no open question.</span></div></div>
  </div>
  <nav class="tabs">
    <button class="tab" data-tab="log" aria-selected="true">Log</button>
    <button class="tab" data-tab="chat" aria-selected="false">Chat</button>
    <button class="tab" data-tab="ctx" aria-selected="false">Context</button>
    <button class="tab" data-tab="set" aria-selected="false">Settings</button>
  </nav>
  <div class="tabwrap">
    <div data-panel="log">
      <div class="hint" style="margin-bottom:6px">What it answered this session — question, answer, source, time.</div>
      <div class="log" id="log"><div class="hint">No answers yet.</div></div>
    </div>
    <div data-panel="chat" hidden>
      <div class="hint" style="margin-bottom:4px">A side chat for you — ask about the current question or topic. (Separate from the automatic answering.)</div>
      <div class="chat" id="chat"><div class="msg ai">Ask me anything about the current question or topic.</div></div>
      <div class="chatbar"><input class="input" id="chatIn" placeholder="Message the assistant…"><button class="btn primary" id="chatSend" style="flex:0 0 auto;min-width:0">Send</button></div>
    </div>
    <div data-panel="ctx" hidden>
      <div class="field"><label for="ctxBox">Today's topic / context <span class="hint">— you set this (optional)</span></label>
        <textarea class="input" id="ctxBox" placeholder="e.g. thyroid — hypothyroidism, Hashimoto, histology"></textarea></div>
      <div class="field"><label>Session memory <span class="hint">— built automatically</span></label>
        <div class="memview" id="memView">nothing yet</div></div>
      <div class="hint">Both the topic and the memory clear automatically when a new session starts.</div>
    </div>
    <div data-panel="set" hidden>
      <div class="row"><label>AI status</label><span class="aistat" id="aiStat">checking…</span></div>
      <div class="field"><label for="key">Groq API key <span class="hint">— free at <a class="lnk" href="https://console.groq.com/keys" target="_blank" rel="noopener">console.groq.com</a>; stored on this device only</span></label>
        <input class="input" id="key" type="password" placeholder="gsk_…"></div>
      <button class="btn" id="test" style="flex:0 0 auto">Test AI</button>
      <div class="field"><label>Theme</label><div class="seg" id="themeSeg"><button data-v="light">Light</button><button data-v="dark">Dark</button><button data-v="auto">Auto</button></div></div>
      <div class="field"><div class="row"><label for="fs">Text size</label><span class="hint" id="fsVal">100%</span></div><input type="range" id="fs" min="80" max="140" step="5" value="100"></div>
      <div class="hint">Drag the panel's bottom-right corner to resize it.</div>
      <div class="field"><label for="model">AI model <span class="hint">— click Refresh to list models your key can use</span></label>
        <div class="row" style="gap:6px"><select id="model" style="flex:1"></select><button class="btn" id="refreshModels" style="flex:0 0 auto;min-width:0">Refresh</button></div>
        <div class="hint">Reading slide images needs a vision-capable model — pick one from the list if your key has it.</div></div>
      <div class="row"><label>Auto-submit answers</label><button class="toggle" id="tAuto"></button></div>
      <div class="row"><label>AI for multiple-choice</label><button class="toggle" id="tMCQ"></button></div>
      <div class="row"><label>AI for short answer</label><button class="toggle" id="tText"></button></div>
      <div class="hint">AI answers as soon as it replies; if it's too slow or fails it falls back to offline. Turn AI off for a type to use offline only (with a short random delay). Auto-submit OFF = it only proposes; you press Submit.</div>
    </div>
  </div>
</section>`;
    }

    // ==========================================================================
    // 5. PANEL WIRING
    // ==========================================================================
    function setState(s, t) { $('#state').setAttribute('data-s', s); $('#stateTxt').textContent = t; }
    function autosize(t) { t.style.height = 'auto'; t.style.height = Math.min(140, t.scrollHeight) + 'px'; }
    function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
    function updateMemoryView() { const el = $('#memView'); if (el) el.textContent = memory.length ? memory.join('\n') : 'nothing yet'; }

    if (S.panelW > 0) $('#panel').style.width = S.panelW + 'px';
    if (S.panelH > 0) $('#panel').style.height = S.panelH + 'px';
    $$('#themeSeg button').forEach(b => b.setAttribute('aria-pressed', b.dataset.v === S.theme ? 'true' : 'false'));
    $('#fs').value = Math.round(S.fontScale * 100); $('#fsVal').textContent = Math.round(S.fontScale * 100) + '%';
    $('#ctxBox').value = S.topic; $('#key').value = S.groqKey; populateModels([]);
    $('#tAuto').setAttribute('aria-pressed', S.autoSubmit ? 'true' : 'false');
    $('#tMCQ').setAttribute('aria-pressed', S.aiForMCQ ? 'true' : 'false');
    $('#tText').setAttribute('aria-pressed', S.aiForText ? 'true' : 'false');
    if (!S.power) { $('#panel').classList.add('off'); setState('off', 'Off'); }

    function refreshAiStatus() {
        const el = $('#aiStat'); if (!el) return;
        if (S.model === OFFLINE) { el.textContent = 'offline mode'; el.style.color = 'var(--fg-dim)'; }
        else if (!hasKey()) { el.textContent = 'no API key set'; el.style.color = 'var(--warn)'; }
        else { el.textContent = 'key set — click Test'; el.style.color = 'var(--fg-dim)'; }
    }
    refreshAiStatus();

    function populateModels(ids) {
        const sel = $('#model'); if (!sel) return;
        const seen = {}, list = [];
        const add = id => { if (id && id !== OFFLINE && !seen[id]) { seen[id] = 1; list.push(id); } };
        (ids || []).forEach(add); STARTER_MODELS.forEach(add); add(S.model);
        let html = '<option value="' + OFFLINE + '">Offline (no AI)</option>';
        list.forEach(id => { html += '<option value="' + esc(id) + '">' + esc(id) + '</option>'; });
        sel.innerHTML = html;
        sel.value = (S.model === OFFLINE || seen[S.model]) ? S.model : (list[0] || OFFLINE);
    }
    async function fetchModels() {
        if (!hasKey()) return 0;
        try {
            const r = await gmRequest({ method: 'GET', url: GROQ_MODELS_URL, timeout: AI_TIMEOUT_MS, headers: { 'Authorization': 'Bearer ' + S.groqKey } });
            if (r.status < 200 || r.status >= 300) return 0;
            const j = JSON.parse(r.responseText); const ids = (j.data || []).map(m => m.id).filter(Boolean).sort();
            populateModels(ids); return ids.length;
        } catch (e) { return 0; }
    }
    $('#refreshModels').addEventListener('click', async function () {
        const note = $('#aiStat');
        if (!hasKey()) { note.textContent = 'enter a key first'; note.style.color = 'var(--warn)'; return; }
        this.disabled = true; const old = this.textContent; this.textContent = '…';
        const n = await fetchModels();
        note.textContent = n ? ('loaded ' + n + ' models') : 'could not list models'; note.style.color = n ? 'var(--good)' : 'var(--bad)';
        this.disabled = false; this.textContent = old;
    });

    $('#themeSeg').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return;
        $$('#themeSeg button').forEach(x => x.setAttribute('aria-pressed', x === b ? 'true' : 'false'));
        saveSetting('theme', b.dataset.v); applyTheme(b.dataset.v); });
    $('#fs').addEventListener('input', e => { const f = e.target.value / 100; saveSetting('fontScale', f); applyFont(f); $('#fsVal').textContent = e.target.value + '%'; });
    $('#ctxBox').addEventListener('input', e => saveSetting('topic', e.target.value.trim()));
    $('#key').addEventListener('input', e => { saveSetting('groqKey', e.target.value.trim()); refreshAiStatus(); });
    $('#model').addEventListener('change', e => { saveSetting('model', e.target.value); refreshAiStatus(); });
    const tog = (id, key) => $(id).addEventListener('click', () => { const v = $(id).getAttribute('aria-pressed') !== 'true'; $(id).setAttribute('aria-pressed', v ? 'true' : 'false'); saveSetting(key, v); });
    tog('#tAuto', 'autoSubmit'); tog('#tMCQ', 'aiForMCQ'); tog('#tText', 'aiForText');

    $('#test').addEventListener('click', async function () {
        const note = $('#aiStat');
        if (!hasKey()) { note.textContent = 'enter a key first'; note.style.color = 'var(--warn)'; return; }
        this.disabled = true; const old = this.textContent; this.textContent = 'Testing…'; note.textContent = 'testing…'; note.style.color = 'var(--fg-dim)';
        try { const r = cleanAnswer(await groqChat([{ role: 'user', content: 'Reply with the word OK.' }])); note.textContent = r ? 'AI working ✓' : 'empty reply'; note.style.color = r ? 'var(--good)' : 'var(--warn)'; }
        catch (e) { note.textContent = 'failed: ' + (e && e.message ? e.message : 'error'); note.style.color = 'var(--bad)'; }
        this.disabled = false; this.textContent = old;
    });

    $$('.tab').forEach(t => t.addEventListener('click', () => {
        $$('.tab').forEach(x => x.setAttribute('aria-selected', 'false')); t.setAttribute('aria-selected', 'true');
        $$('[data-panel]').forEach(p => p.hidden = p.getAttribute('data-panel') !== t.dataset.tab);
    }));
    $('#power').addEventListener('click', () => { saveSetting('power', !S.power); $('#panel').classList.toggle('off', !S.power);
        if (!S.power) { clearCountdown(); setState('off', 'Off'); } else setState('idle', 'Idle'); });
    $('#pause').addEventListener('click', function () { saveSetting('paused', !S.paused); this.innerHTML = S.paused ? '&#9654;' : '&#9208;';
        if (S.paused) { clearCountdown(); setState('idle', 'Paused'); } });
    $('#collapse').addEventListener('click', function () { const c = $('#panel').classList.toggle('collapsed'); this.innerHTML = c ? '&#9656;' : '&#9662;'; });
    $('#ansVal').addEventListener('input', function () { autosize(this); });
    $('#submit').addEventListener('click', () => doSubmit(false));
    $('#regen').addEventListener('click', () => { if (current.mode) handleQuestion(); });

    (function () {
        const p = $('#panel'), h = $('#drag'); let drag = false, sx, sy, ox, oy;
        h.addEventListener('pointerdown', e => { if (e.target.closest('.iconbtn')) return; drag = true; p.style.right = 'auto';
            const r = p.getBoundingClientRect(); ox = r.left; oy = r.top; sx = e.clientX; sy = e.clientY; p.style.left = ox + 'px'; p.style.top = oy + 'px'; h.setPointerCapture(e.pointerId); });
        h.addEventListener('pointermove', e => { if (!drag) return;
            p.style.left = Math.max(4, Math.min(window.innerWidth - 60, ox + e.clientX - sx)) + 'px';
            p.style.top = Math.max(4, Math.min(window.innerHeight - 40, oy + e.clientY - sy)) + 'px'; });
        h.addEventListener('pointerup', e => { drag = false; try { h.releasePointerCapture(e.pointerId); } catch (_) {} });
    })();
    (function () {
        const p = $('#panel'); let tmr = null;
        if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => {
            if (p.classList.contains('collapsed')) return;
            clearTimeout(tmr); tmr = setTimeout(() => { saveSetting('panelW', p.offsetWidth); saveSetting('panelH', p.offsetHeight); }, 300);
        }).observe(p);
    })();

    async function sendChat() {
        const v = $('#chatIn').value.trim(); if (!v) return;
        const box = $('#chat');
        const me = document.createElement('div'); me.className = 'msg me'; me.textContent = v; box.appendChild(me);
        $('#chatIn').value = ''; box.scrollTop = box.scrollHeight;
        const ai = document.createElement('div'); ai.className = 'msg ai'; ai.textContent = '…'; box.appendChild(ai); box.scrollTop = box.scrollHeight;
        let reply;
        if (hasKey()) {
            const ctxLine = current.q ? ('Current question on screen: ' + current.q + '\n') : '';
            const sys = BASE_SYSTEM + (S.topic ? ' Topic: ' + S.topic + '.' : '');
            try { reply = cleanAnswer(await groqChat([{ role: 'system', content: sys }, { role: 'user', content: ctxLine + v }])) || '(no reply)'; }
            catch (e) { reply = 'AI error: ' + (e && e.message ? e.message : 'failed'); }
        } else reply = 'No Groq key set — add one in Settings to use chat.';
        ai.textContent = reply; box.scrollTop = box.scrollHeight;
    }
    $('#chatSend').addEventListener('click', sendChat);
    $('#chatIn').addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });

    function addLog(q, ans, tier) {
        const box = $('#log'); if (box.firstChild && box.firstChild.className === 'hint') box.innerHTML = '';
        const now = new Date(), hh = now.getHours() % 12 || 12, mm = ('0' + now.getMinutes()).slice(-2);
        const row = document.createElement('div'); row.className = 'logitem';
        row.innerHTML = '<div class="lq">Q' + current.num + ' · ' + esc(q || '(no text)') + '</div>' +
            '<div class="la"><span class="dotok"></span>' + esc(ans) + '</div>' +
            '<div class="meta"><span>' + esc(tier) + '</span><span>' + hh + ':' + mm + '</span></div>';
        box.insertBefore(row, box.firstChild);
    }

    // ==========================================================================
    // 6. ANSWER FLOW
    // ==========================================================================
    let current = { sig: '', mode: null, q: '', num: 0, done: false, isCase: false, choiceEls: [], choiceTexts: [], inputEl: null, answer: null, optionText: '' };
    let countTimer = null;
    function clearCountdown() { if (countTimer) cancelAnimationFrame(countTimer); countTimer = null; }
    function showProposed(text, tier) { $('#tier').textContent = tier; $('#ansVal').value = text; autosize($('#ansVal')); }
    function readyAssisted() { setState('answered', 'Proposed'); $('#countTxt').textContent = 'Review & press Submit (auto-submit off)'; $('#countBar').style.transform = 'scaleX(1)'; }

    async function handleQuestion() {
        const useAI = aiForType(current.mode);
        if (useAI) {
            const sig = current.sig;
            const imageUrl = current.q ? '' : getSlideImage();
            const caseBlurb = current.isCase && memory.length ? ('This is part of an ongoing case. Earlier: ' + memory[memory.length - 1] + '.') : '';
            setState('answering', imageUrl ? 'Reading slide…' : 'Thinking…');
            showProposed('', imageUrl ? 'Reading slide…' : 'Thinking…');
            $('#countTxt').textContent = 'Waiting for AI…'; $('#countBar').style.transform = 'scaleX(1)';
            const res = await aiAnswer({ mode: current.mode, qText: current.q, choices: current.choiceTexts, imageUrl, caseBlurb });
            if (sig !== current.sig) return;
            if (res) {
                current.answer = res; current.optionText = res.text; showProposed(res.text, res.tier);
                if (S.autoSubmit) doSubmit(true); else readyAssisted();
                return;
            }
            const off = offlineAnswer(current.q, !!current.q);
            current.answer = { text: off.text, tier: 'Offline (AI failed)' }; current.optionText = off.text;
            showProposed(off.text, current.answer.tier);
            if (S.autoSubmit) doSubmit(true); else readyAssisted();
            return;
        }
        const off = offlineAnswer(current.q, !!current.q);
        current.answer = off; current.optionText = off.text; showProposed(off.text, off.tier);
        if (S.autoSubmit) startDelayCountdown(); else readyAssisted();
    }
    function startDelayCountdown() {
        clearCountdown();
        if (!S.power || S.paused) { setState('idle', S.paused ? 'Paused' : 'Idle'); $('#countTxt').textContent = S.paused ? 'Paused' : '—'; return; }
        setState('answering', 'Answering…');
        const dur = rint(MIN_DELAY_MS, MAX_DELAY_MS), t0 = performance.now();
        (function loop(now) {
            const rem = Math.max(0, dur - (now - t0));
            $('#countTxt').textContent = 'Submitting in ' + (rem / 1000).toFixed(1) + 's';
            $('#countBar').style.transform = 'scaleX(' + (rem / dur) + ')';
            if (rem <= 0) { countTimer = null; doSubmit(true); } else countTimer = requestAnimationFrame(loop);
        })(t0);
    }
    function doSubmit(auto) {
        clearCountdown();
        if (current.done) return;
        let ok = false, submittedText = $('#ansVal').value;
        try {
            if (current.mode === 'mcq' && current.choiceEls.length) {
                let el = null;
                const want = (current.optionText || '').toLowerCase().replace(/^\d+[\).]\s*/, '').replace(/^[a-e][\).]\s*/, '').trim();
                if (want && S.aiForMCQ) el = current.choiceEls.find(c => { const t = (c.innerText || '').toLowerCase().trim(); return t && (t === want || t.includes(want) || want.includes(t)); });
                if (!el) el = current.choiceEls[Math.floor(Math.random() * current.choiceEls.length)];
                const r = el.getBoundingClientRect(); realClick(el, r.left + r.width / 2, r.top + r.height / 2);
                submittedText = (el.innerText || '').trim().slice(0, 60) || ('Option ' + (current.choiceEls.indexOf(el) + 1)); ok = true;
            } else if (current.mode === 'text' && current.inputEl) {
                setNativeValue(current.inputEl, submittedText);
                setTimeout(() => { try { const b = findSubmitButton(current.inputEl); if (b && isVisible(b) && !b.disabled) { const r = b.getBoundingClientRect(); realClick(b, r.left + r.width / 2, r.top + r.height / 2); } } catch (e) {} }, 300);
                ok = true;
            }
        } catch (e) {}
        current.done = true;
        setState('answered', ok ? (auto ? 'Answered ✓' : 'Submitted') : 'Could not submit');
        $('#countTxt').textContent = ok ? 'Submitted' : 'Submit failed — try manually';
        $('#countBar').style.transform = 'scaleX(0)';
        if (ok) { addLog(current.q, submittedText, current.answer ? current.answer.tier : '—'); rememberQA(current.q, submittedText); }
    }

    // ==========================================================================
    // 7. SCAN LOOP
    // ==========================================================================
    let sessionKey = '';
    function resetSession() {
        memory = []; updateMemoryView();
        saveSetting('topic', ''); if ($('#ctxBox')) $('#ctxBox').value = '';
        const lb = $('#log'); if (lb) lb.innerHTML = '<div class="hint">New session — log cleared.</div>';
        current = { sig: '', mode: null, q: '', num: 0, done: false, isCase: false, choiceEls: [], choiceTexts: [], inputEl: null, answer: null, optionText: '' };
    }
    setInterval(() => {
        if (!S.power) return;
        const title = getSessionTitle();
        if (title && title !== sessionKey) { const first = sessionKey === ''; sessionKey = title; if (!first) resetSession(); }

        if (onResultsScreen()) { goIdle(); return; }
        const choices = getChoices(), inputs = getTextInputs();
        const mode = choices.length ? 'mcq' : inputs.length ? 'text' : null;
        if (!mode) { goIdle(); return; }

        const q = getQuestionText();
        const sig = mode + '|' + choices.length + '|' + inputs.length + '|' + q.slice(0, 60);
        if (sig === current.sig) return;
        current = { sig, mode, q, num: current.num + 1, done: false, isCase: isCaseQuestion(q),
            choiceEls: choices, choiceTexts: choices.map(c => (c.innerText || '').trim()).filter(Boolean),
            inputEl: inputs[0] || null, answer: null, optionText: '' };

        if ((mode === 'mcq' && anySelected(choices)) || (mode === 'text' && inputs.some(i => i.value && i.value.trim()))) {
            current.done = true; showQuestion(); setState('answered', 'Already answered'); $('#countTxt').textContent = 'You answered this one'; return;
        }
        showQuestion();
        handleQuestion();
    }, SCAN_MS);

    function goIdle() {
        if (current.mode !== null || current.sig !== '') current = { sig: '', mode: null, q: '', num: current.num, done: false, isCase: false, choiceEls: [], choiceTexts: [], inputEl: null, answer: null, optionText: '' };
        clearCountdown();
        $('#qsec').hidden = true; $('#ansSec').hidden = true; $('#idleSec').hidden = false;
        if (S.power && !S.paused) setState('idle', 'Watching slides');
    }
    function showQuestion() {
        $('#idleSec').hidden = true; $('#qsec').hidden = false; $('#ansSec').hidden = false;
        const typeLabel = current.mode === 'mcq' ? 'Multiple choice' : 'Short answer';
        const isImg = !current.q;
        $('#chips').innerHTML = '<span class="chip type">' + typeLabel + '</span>' +
            '<span class="chip">Q <b>' + current.num + '</b></span>' +
            (current.isCase ? '<span class="chip cas">Case</span>' : '');
        const qt = $('#qtext'); qt.className = 'qtext' + (isImg ? ' dim' : '');
        qt.textContent = current.q || '[shown as image — reading with AI…]';
    }

    updateMemoryView();
    console.log('[AI Poll Assistant] v0.4.1 loaded. GM_xmlhttpRequest: ' + (typeof GM_xmlhttpRequest !== 'undefined' || (typeof GM !== 'undefined' && GM.xmlHttpRequest) ? 'yes' : 'NO') + '; key: ' + (hasKey() ? 'set' : 'none') + '; auto-submit ' + (S.autoSubmit ? 'ON' : 'OFF'));
})();
