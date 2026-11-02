// ==UserScript==
// @name         Echo360 AI Poll Assistant
// @namespace    https://github.com/rsharma929/echo360-ai-poll-assistant
// @version      0.1.0
// @description  AI-assisted responder for PointSolutions / Echo360 browser polls, with an in-page control panel. Phase 1–2: draggable panel + live question detection + offline answers. AI brain (Puter/Groq) lands in Phase 3.
// @author       Rohan
// @license      MIT
// @match        https://*.ttpoll.com/*
// @match        https://ttpoll.com/*
// @match        https://*.echo360.com/*
// @match        https://echo360.com/*
// @match        https://*.turningtechnologies.com/*
// @match        https://turningtechnologies.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

/*
 * Brand-new, standalone tool — NOT the same as pointsolutions-poll-automation.
 * Phase 1–2 (this file): the control panel + detection + an OFFLINE answer path.
 *   - Auto-submit is OFF by default so you can first confirm it detects your polls
 *     correctly. Flip "Auto-submit" on in Settings once you're happy.
 * Phase 3 (next): the AI brain — Puter.js (keyless) primary, optional Groq key,
 *   with these offline pools as the final fallback. That will add @grant/@connect/@require.
 */
(function () {
    'use strict';

    // ==========================================================================
    // 0. CONFIG + SETTINGS
    // ==========================================================================
    const NS = 'ePA_';                 // localStorage prefix
    const SCAN_MS = 1000;              // how often we look at the page
    const MIN_DELAY_MS = 500;          // fastest we'll answer after spotting a question
    const MAX_DELAY_MS = 7500;         // slowest (randomised per question)

    // Offline answer pools (preclinical / basic sciences). Used now, and later as the
    // final fallback behind the AI. Short entries — boxes expect a word/phrase. NEVER "IDK".
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
    // Optional per-topic term banks (fuzzy-matched to the topic you type in the Context tab).
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

    const DEFAULTS = {
        power: true, paused: false, autoSubmit: false, aiForMCQ: false,
        confirm: false, theme: 'auto', fontScale: 1, model: 'Offline pools only',
        groqKey: '', topic: ''
    };
    const S = loadSettings();

    function loadSettings() {
        const s = Object.assign({}, DEFAULTS);
        try { for (const k in DEFAULTS) { const v = localStorage.getItem(NS + k); if (v !== null) s[k] = JSON.parse(v); } } catch (e) {}
        return s;
    }
    function saveSetting(k, v) { S[k] = v; try { localStorage.setItem(NS + k, JSON.stringify(v)); } catch (e) {} }

    const rint = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));

    // ==========================================================================
    // 1. DETECTION HELPERS  (ported from pointsolutions-poll-automation, Angular-safe)
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
        if (el.disabled) return true;
        if (el.tagName === 'IFRAME') return true;
        if (el.getAttribute && el.getAttribute('role') === 'tab') return true;
        if (isChatSupport(el)) return true;
        return matchesWords(el, NON_ANSWER_WORDS, true);
    }
    function isBadInput(el) {
        if (el.disabled || el.tagName === 'IFRAME') return true;
        return isChatSupport(el);
    }

    // Angular-safe value set: native setter + input/change so the framework registers it.
    function setNativeValue(el, value) {
        const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
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

    // Results/chart screen (between questions) — must be skipped, never answered.
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

    // Best-effort read of the question stem text.
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

    // ==========================================================================
    // 2. OFFLINE ANSWER LOGIC  (Phase-3 AI will sit in front of this)
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
    function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
    function topicBank() {
        const t = (S.topic || '').toLowerCase();
        if (!t) return null;
        for (const k in TOPIC_BANKS) if (t.includes(k)) return TOPIC_BANKS[k];
        // no bank match: echo the typed topic words themselves
        const words = t.split(/[^a-z]+/).filter(w => w.length > 3 && !STOP.has(w));
        return words.length ? words.map(w => w[0].toUpperCase() + w.slice(1)) : null;
    }
    // Returns {text, tier}
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
    // 3. PANEL  (Shadow-DOM isolated so the site's Angular CSS can't touch it)
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
  --font:"IBM Plex Sans",system-ui,-apple-system,sans-serif; --mono:"IBM Plex Mono",ui-monospace,Menlo,monospace;
  all:initial; }
@media (prefers-color-scheme:dark){:host(:not([data-theme="light"])){
  --surface:#161c26; --surface-2:#1d2430; --surface-3:#242c39; --border:#2a3340; --border-2:#222a35;
  --fg:#e7ebf1; --fg-dim:#9aa6b7; --fg-faint:#6b7585;
  --accent:#2ad2c4; --accent-weak:#11312f; --accent-fg:#052321;
  --good:#3ecb79; --warn:#e0a33a; --warn-weak:#33280f; --bad:#ef6b6b;
  --shadow:0 14px 40px rgba(0,0,0,.55),0 2px 10px rgba(0,0,0,.4); }}
:host([data-theme="dark"]){
  --surface:#161c26; --surface-2:#1d2430; --surface-3:#242c39; --border:#2a3340; --border-2:#222a35;
  --fg:#e7ebf1; --fg-dim:#9aa6b7; --fg-faint:#6b7585;
  --accent:#2ad2c4; --accent-weak:#11312f; --accent-fg:#052321;
  --good:#3ecb79; --warn:#e0a33a; --warn-weak:#33280f; --bad:#ef6b6b;
  --shadow:0 14px 40px rgba(0,0,0,.55),0 2px 10px rgba(0,0,0,.4); }
*{box-sizing:border-box}
.panel{position:fixed;top:16px;right:16px;width:360px;max-width:calc(100vw - 24px);
  background:var(--surface);color:var(--fg);border:1px solid var(--border);border-radius:14px;box-shadow:var(--shadow);
  font-family:var(--font);font-size:calc(13px*var(--fs));z-index:2147483646;display:flex;flex-direction:column;max-height:calc(100vh - 32px)}
.panel.off{filter:grayscale(.6) opacity(.72)}
.hd{display:flex;align-items:center;gap:8px;padding:10px 12px;cursor:grab;user-select:none;background:linear-gradient(var(--surface-2),var(--surface));border-bottom:1px solid var(--border-2);touch-action:none}
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
.body{overflow-y:auto;overscroll-behavior:contain}
.sec{padding:12px;border-bottom:1px solid var(--border-2);display:flex;flex-direction:column;gap:10px}
.eyebrow{font-size:calc(10px*var(--fs));letter-spacing:.09em;text-transform:uppercase;color:var(--fg-faint);font-weight:600}
.chips{display:flex;flex-wrap:wrap;gap:6px}
.chip{font-size:calc(11px*var(--fs));font-family:var(--mono);padding:3px 8px;border-radius:7px;border:1px solid var(--border);background:var(--surface-2);color:var(--fg-dim)}
.chip.type{background:var(--accent-weak);border-color:color-mix(in srgb,var(--accent) 35%,transparent);color:color-mix(in srgb,var(--accent) 72%,var(--fg))}
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
.tabs{display:flex;gap:2px;padding:8px 10px 0;border-bottom:1px solid var(--border-2)}
.tab{flex:1;border:none;background:transparent;color:var(--fg-dim);font-weight:600;font-size:calc(11.5px*var(--fs));font-family:var(--font);padding:8px 4px;cursor:pointer;border-bottom:2px solid transparent;border-radius:6px 6px 0 0}
.tab[aria-selected="true"]{color:var(--fg);border-bottom-color:var(--accent);background:var(--surface-2)}
.tabwrap{padding:12px;display:flex;flex-direction:column;gap:10px;min-height:110px}
.log{display:flex;flex-direction:column;gap:8px}
.logitem{border:1px solid var(--border-2);border-radius:9px;padding:8px 10px;background:var(--surface-2);display:flex;flex-direction:column;gap:3px}
.logitem .lq{font-size:calc(11.5px*var(--fs));color:var(--fg-dim);line-height:1.3}
.logitem .la{font-size:calc(13px*var(--fs));font-weight:600;display:flex;align-items:center;gap:7px}
.logitem .meta{font-family:var(--mono);font-size:calc(10px*var(--fs));color:var(--fg-faint);display:flex;gap:8px}
.dotok{width:7px;height:7px;border-radius:50%;background:var(--good)}
.field{display:flex;flex-direction:column;gap:6px}
.field label{font-size:calc(11.5px*var(--fs));color:var(--fg-dim);font-weight:600}
.row{display:flex;align-items:center;justify-content:space-between;gap:10px}
select,.input{width:100%;border:1px solid var(--border);background:var(--surface);color:var(--fg);border-radius:8px;padding:7px 9px;font-size:calc(12.5px*var(--fs));font-family:var(--font)}
textarea.input{min-height:60px;resize:vertical}
.seg{display:flex;border:1px solid var(--border);border-radius:8px;overflow:hidden}
.seg button{flex:1;border:none;background:var(--surface);color:var(--fg-dim);padding:7px 4px;font-size:calc(11.5px*var(--fs));font-weight:600;cursor:pointer;font-family:var(--font)}
.seg button[aria-pressed="true"]{background:var(--accent);color:var(--accent-fg)}
input[type=range]{width:100%;accent-color:var(--accent)}
.toggle{position:relative;width:38px;height:22px;border-radius:999px;background:var(--surface-3);border:1px solid var(--border);cursor:pointer;flex:none}
.toggle::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--fg-faint);transition:transform .15s,background .15s}
.toggle[aria-pressed="true"]{background:var(--accent);border-color:var(--accent)}
.toggle[aria-pressed="true"]::after{transform:translateX(16px);background:#fff}
.hint{font-size:calc(10.5px*var(--fs));color:var(--fg-faint);line-height:1.4}
.phase{font-family:var(--mono);font-size:calc(10px*var(--fs));color:var(--warn);background:var(--warn-weak);border:1px solid color-mix(in srgb,var(--warn) 30%,transparent);padding:2px 7px;border-radius:6px;align-self:flex-start}
.collapsed .body,.collapsed .tabs,.collapsed .tabwrap{display:none}
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
      <div class="qtext" id="qtext">—</div>
    </div>
    <div class="sec" id="ansSec">
      <div class="ans">
        <div class="ans-head"><span class="eyebrow" style="margin:0">Proposed answer</span><span class="tier" id="tier">—</span></div>
        <textarea class="ans-val" id="ansVal" rows="1" aria-label="Proposed answer"></textarea>
        <div class="count" id="countRow"><span id="countTxt">—</span><span class="bar"><i id="countBar"></i></span></div>
        <div class="btns">
          <button class="btn primary" id="submit">Submit now</button>
          <button class="btn" id="regen">Regenerate</button>
          <button class="btn" id="skip">Skip</button>
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
    <div data-panel="log"><div class="log" id="log"><div class="hint">Answers will appear here.</div></div></div>
    <div data-panel="chat" hidden><span class="phase">PHASE 3</span><p class="hint">Direct chat with the AI arrives with the AI brain (Puter/Groq). Offline mode can't chat.</p></div>
    <div data-panel="ctx" hidden>
      <div class="field"><label for="ctxBox">Today's topic / context <span class="hint">(steers offline + AI answers)</span></label>
        <textarea class="input" id="ctxBox" placeholder="e.g. thyroid — hypothyroidism, Hashimoto, histology"></textarea></div>
      <div class="hint">No reliable auto-topic (session titles are often random), so set it here when you can.</div>
    </div>
    <div data-panel="set" hidden>
      <div class="field"><label>Theme</label><div class="seg" id="themeSeg">
        <button data-v="light">Light</button><button data-v="dark">Dark</button><button data-v="auto">Auto</button></div></div>
      <div class="field"><div class="row"><label for="fs">Text size</label><span class="hint" id="fsVal">100%</span></div>
        <input type="range" id="fs" min="85" max="130" step="5" value="100"></div>
      <div class="field"><label for="model">AI model <span class="phase">PHASE 3</span></label>
        <select id="model"><option>Offline pools only</option><option>Puter · GPT-4o-mini (vision)</option><option>Puter · Gemini Flash (vision)</option><option>Groq · Llama-4 Scout (vision)</option></select></div>
      <div class="field"><label for="key">Groq API key <span class="hint">(optional, Phase 3; device-only)</span></label><input class="input" id="key" type="password" placeholder="gsk_…"></div>
      <div class="row"><label>Auto-submit answers</label><button class="toggle" id="tAuto"></button></div>
      <div class="row"><label>Use AI for multiple-choice <span class="phase">P3</span></label><button class="toggle" id="tMCQ"></button></div>
      <div class="row"><label>Confirm before submit</label><button class="toggle" id="tConfirm"></button></div>
      <div class="hint">v0.1: auto-submit is OFF by default — confirm it detects your polls, then turn it on. MCQ picks a random option (offline); AI answers arrive in Phase 3.</div>
    </div>
  </div>
</section>`;
    }

    // ==========================================================================
    // 4. PANEL WIRING
    // ==========================================================================
    function setState(s, t) { $('#state').setAttribute('data-s', s); $('#stateTxt').textContent = t; }
    function autosize(t) { t.style.height = 'auto'; t.style.height = Math.min(120, t.scrollHeight) + 'px'; }
    function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

    // reflect persisted settings into the UI
    $$('#themeSeg button').forEach(b => b.setAttribute('aria-pressed', b.dataset.v === S.theme ? 'true' : 'false'));
    $('#fs').value = Math.round(S.fontScale * 100); $('#fsVal').textContent = Math.round(S.fontScale * 100) + '%';
    $('#ctxBox').value = S.topic; $('#key').value = S.groqKey; $('#model').value = S.model;
    $('#tAuto').setAttribute('aria-pressed', S.autoSubmit ? 'true' : 'false');
    $('#tMCQ').setAttribute('aria-pressed', S.aiForMCQ ? 'true' : 'false');
    $('#tConfirm').setAttribute('aria-pressed', S.confirm ? 'true' : 'false');
    if (!S.power) { $('#panel').classList.add('off'); setState('off', 'Off'); }

    $('#themeSeg').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return;
        $$('#themeSeg button').forEach(x => x.setAttribute('aria-pressed', x === b ? 'true' : 'false'));
        saveSetting('theme', b.dataset.v); applyTheme(b.dataset.v); });
    $('#fs').addEventListener('input', e => { const f = e.target.value / 100; saveSetting('fontScale', f); applyFont(f); $('#fsVal').textContent = e.target.value + '%'; });
    $('#ctxBox').addEventListener('input', e => saveSetting('topic', e.target.value.trim()));
    $('#key').addEventListener('input', e => saveSetting('groqKey', e.target.value.trim()));
    $('#model').addEventListener('change', e => saveSetting('model', e.target.value));
    const tog = (id, key) => $(id).addEventListener('click', () => { const v = $(id).getAttribute('aria-pressed') !== 'true'; $(id).setAttribute('aria-pressed', v ? 'true' : 'false'); saveSetting(key, v); });
    tog('#tAuto', 'autoSubmit'); tog('#tMCQ', 'aiForMCQ'); tog('#tConfirm', 'confirm');

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
    $('#skip').addEventListener('click', () => { clearCountdown(); current.done = true; setState('idle', 'Skipped'); $('#countTxt').textContent = 'Skipped'; $('#countBar').style.transform = 'scaleX(0)'; });
    $('#regen').addEventListener('click', () => { if (!current.q && current.mode !== 'mcq') return; proposeAnswer(); });

    // drag
    (function () {
        const p = $('#panel'), h = $('#drag'); let drag = false, sx, sy, ox, oy;
        h.addEventListener('pointerdown', e => { if (e.target.closest('.iconbtn')) return; drag = true; p.style.right = 'auto';
            const r = p.getBoundingClientRect(); ox = r.left; oy = r.top; sx = e.clientX; sy = e.clientY; p.style.left = ox + 'px'; p.style.top = oy + 'px'; h.setPointerCapture(e.pointerId); });
        h.addEventListener('pointermove', e => { if (!drag) return;
            p.style.left = Math.max(4, Math.min(innerWidth - 60, ox + e.clientX - sx)) + 'px';
            p.style.top = Math.max(4, Math.min(innerHeight - 40, oy + e.clientY - sy)) + 'px'; });
        h.addEventListener('pointerup', e => { drag = false; try { h.releasePointerCapture(e.pointerId); } catch (_) {} });
    })();

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
    // 5. ANSWER FLOW  (hybrid: propose -> countdown -> auto-submit unless overridden)
    // ==========================================================================
    let current = { sig: '', mode: null, q: '', num: 0, done: false, choiceEls: [], inputEl: null };
    let countTimer = null;
    function clearCountdown() { if (countTimer) cancelAnimationFrame(countTimer); countTimer = null; }

    function proposeAnswer() {
        const ans = current.mode === 'mcq'
            ? { text: '(random choice)', tier: S.aiForMCQ ? 'Offline' : 'Random' }
            : offlineAnswer(current.q, !!current.q);
        current.answer = ans;
        $('#tier').textContent = ans.tier;
        $('#ansVal').value = ans.text; autosize($('#ansVal'));
        startCountdown();
    }
    function startCountdown() {
        clearCountdown();
        if (!S.power || S.paused) { setState('idle', S.paused ? 'Paused' : 'Idle'); $('#countTxt').textContent = S.paused ? 'Paused' : '—'; return; }
        if (!S.autoSubmit) { setState('answered', 'Proposed'); $('#countTxt').textContent = 'Review & press Submit (auto-submit off)'; $('#countBar').style.transform = 'scaleX(1)'; return; }
        setState('answering', 'Answering…');
        const dur = rint(MIN_DELAY_MS, MAX_DELAY_MS), t0 = performance.now();
        (function loop(now) {
            const rem = Math.max(0, dur - (now - t0));
            $('#countTxt').textContent = 'Auto-submit in ' + (rem / 1000).toFixed(1) + 's';
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
                const el = current.choiceEls[Math.floor(Math.random() * current.choiceEls.length)];
                const r = el.getBoundingClientRect(); realClick(el, r.left + r.width / 2, r.top + r.height / 2);
                submittedText = 'Option ' + (current.choiceEls.indexOf(el) + 1); ok = true;
            } else if (current.mode === 'text' && current.inputEl) {
                setNativeValue(current.inputEl, submittedText);
                setTimeout(() => { const b = findSubmitButton(current.inputEl); if (b && isVisible(b) && !b.disabled) { const r = b.getBoundingClientRect(); realClick(b, r.left + r.width / 2, r.top + r.height / 2); } }, 300);
                ok = true;
            }
        } catch (e) {}
        current.done = true;
        setState('answered', ok ? (auto ? 'Answered ✓' : 'Submitted') : 'Could not submit');
        $('#countTxt').textContent = ok ? 'Submitted' : 'Submit failed — try manually';
        $('#countBar').style.transform = 'scaleX(0)';
        if (ok) addLog(current.q, submittedText, current.answer ? current.answer.tier : '—');
    }

    // ==========================================================================
    // 6. SCAN LOOP
    // ==========================================================================
    setInterval(() => {
        const title = getSessionTitle(); // reserved for future use
        if (!S.power) return;

        if (onResultsScreen()) { goIdle(); return; }
        const choices = getChoices();
        const inputs = getTextInputs();
        const mode = choices.length ? 'mcq' : inputs.length ? 'text' : null;

        if (!mode) { goIdle(); return; }

        // signature so we only react once per distinct question
        const q = getQuestionText();
        const sig = mode + '|' + choices.length + '|' + inputs.length + '|' + q.slice(0, 60);
        if (sig === current.sig) return;        // same question, already handled
        // new question
        current = { sig, mode, q, num: current.num + 1, done: false,
            choiceEls: choices, inputEl: inputs[0] || null, answer: null };

        // if the user already answered manually, lock without acting
        if ((mode === 'mcq' && anySelected(choices)) || (mode === 'text' && inputs.some(i => i.value && i.value.trim()))) {
            current.done = true; showQuestion(); setState('answered', 'Already answered'); $('#countTxt').textContent = 'You answered this one'; return;
        }
        showQuestion();
        proposeAnswer();
    }, SCAN_MS);

    function goIdle() {
        if (current.mode !== null || current.sig !== '') { current = { sig: '', mode: null, q: '', num: current.num, done: false, choiceEls: [], inputEl: null }; }
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
            '<span class="chip">Case: <b>—</b></span>';
        const qt = $('#qtext');
        qt.className = 'qtext' + (isImg ? ' dim' : '');
        qt.textContent = current.q || '[shown as image / no text on page]';
    }

    console.log('[AI Poll Assistant] v0.1.0 loaded — offline mode, auto-submit ' + (S.autoSubmit ? 'ON' : 'OFF'));
})();
