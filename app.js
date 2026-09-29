/* disasm.local — a local, two-way assembler/disassembler workbench.
 *
 * Both panels are live-editable at once:
 *   - edit Assembly    -> Machine code (and the listing/byte-map) update
 *   - edit Machine code-> Assembly     (and the listing/byte-map) update
 *
 * The "source of truth" is whichever panel you edited last. Programmatic
 * writes to the *other* panel don't fire input events, so there's no feedback
 * loop. Engines: Keystone.js (assemble) + Capstone.js (disassemble), as WASM.
 */
"use strict";

let KS = null; // keystone module
let CS = null; // capstone module

/* ---- Architecture configuration ------------------------------------------ */
const ARCHS = {
  x86: {
    label: "x86",
    modeLabel: "Bits",
    modes: [
      { id: "16", label: "16-bit" },
      { id: "32", label: "32-bit" },
      { id: "64", label: "64-bit" },
    ],
    defaultMode: "64",
    endianLocked: "le",       // x86 is little-endian only
    syntax: true,             // Intel / AT&T
    build(s) {
      const ksBits = { 16: KS.MODE_16, 32: KS.MODE_32, 64: KS.MODE_64 };
      const csBits = { 16: CS.MODE_16, 32: CS.MODE_32, 64: CS.MODE_64 };
      return {
        ksArch: KS.ARCH_X86, ksMode: ksBits[s.mode],
        csArch: CS.ARCH_X86, csMode: csBits[s.mode],
        ksSyntax: s.syntax === "att" ? KS.OPT_SYNTAX_ATT : KS.OPT_SYNTAX_INTEL,
        csSyntax: s.syntax === "att" ? CS.OPT_SYNTAX_ATT : CS.OPT_SYNTAX_INTEL,
      };
    },
  },
  arm: {
    label: "ARM",
    modeLabel: "Mode",
    modes: [
      { id: "arm", label: "ARM" },
      { id: "thumb", label: "Thumb" },
    ],
    defaultMode: "arm",
    endian: true,
    build(s) {
      const eKs = s.endian === "be" ? KS.MODE_BIG_ENDIAN : KS.MODE_LITTLE_ENDIAN;
      const eCs = s.endian === "be" ? CS.MODE_BIG_ENDIAN : CS.MODE_LITTLE_ENDIAN;
      const subKs = s.mode === "thumb" ? KS.MODE_THUMB : KS.MODE_ARM;
      const subCs = s.mode === "thumb" ? CS.MODE_THUMB : CS.MODE_ARM;
      return {
        ksArch: KS.ARCH_ARM, ksMode: subKs | eKs,
        csArch: CS.ARCH_ARM, csMode: subCs | eCs,
      };
    },
  },
  arm64: {
    label: "ARM64",
    modeLabel: "Mode",
    modes: [{ id: "a64", label: "AArch64" }],
    defaultMode: "a64",
    endian: true,
    build(s) {
      const eKs = s.endian === "be" ? KS.MODE_BIG_ENDIAN : KS.MODE_LITTLE_ENDIAN;
      const eCs = s.endian === "be" ? CS.MODE_BIG_ENDIAN : CS.MODE_LITTLE_ENDIAN;
      return {
        ksArch: KS.ARCH_ARM64, ksMode: eKs,
        csArch: CS.ARCH_ARM64, csMode: eCs,
      };
    },
  },
  mips: {
    label: "MIPS",
    modeLabel: "Bits",
    modes: [
      { id: "32", label: "MIPS32" },
      { id: "64", label: "MIPS64" },
    ],
    defaultMode: "32",
    endian: true,
    build(s) {
      const eKs = s.endian === "be" ? KS.MODE_BIG_ENDIAN : KS.MODE_LITTLE_ENDIAN;
      const eCs = s.endian === "be" ? CS.MODE_BIG_ENDIAN : CS.MODE_LITTLE_ENDIAN;
      const subKs = s.mode === "64" ? KS.MODE_MIPS64 : KS.MODE_MIPS32;
      const subCs = s.mode === "64" ? CS.MODE_MIPS64 : CS.MODE_MIPS32;
      return {
        ksArch: KS.ARCH_MIPS, ksMode: subKs | eKs,
        csArch: CS.ARCH_MIPS, csMode: subCs | eCs,
      };
    },
  },
};

const SAMPLES = {
  x86:  "mov rax, 1\nxor rdi, rdi\nmov rsi, rsp\nsyscall",
  arm:  "mov r0, #1\nadd r1, r0, #4\nldr r2, [r1]\nbx lr",
  arm64:"mov x0, #1\nadd x1, x0, #4\nldr x2, [x1]\nret",
  mips: "addiu $t0, $zero, 5\nsll $t1, $t0, 2\nlw $t2, 0($t1)\njr $ra",
};

/* ---- State ---------------------------------------------------------------- */
const state = {
  arch: "x86",
  mode: "64",
  endian: "le",
  syntax: "intel",
  base: 0x0n,
  mcFormat: "hex_space",
  source: "asm",       // "asm" | "mc": whichever panel was edited last
  asmText: SAMPLES.x86,
  mcText: "",
};

/* Per-instruction highlight palette (hue values). */
const HUES = [190, 40, 150, 280, 12, 95, 330, 220];
const hueFor = (i) => HUES[i % HUES.length];

/* ---- Byte encoders (machine-code display format) -------------------------- */
const toHexPairs = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0"));
const ENCODERS = {
  hex:       (b) => toHexPairs(b).join(""),
  hex_space: (b) => toHexPairs(b).join(" "),
  escaped:   (b) => toHexPairs(b).map((h) => "\\x" + h).join(""),
  zerox:     (b) => toHexPairs(b).map((h) => "0x" + h).join(", "),
  carray:    (b) => `unsigned char code[] = "${toHexPairs(b).map((h) => "\\x" + h).join("")}";\nunsigned int code_len = ${b.length};`,
  python:    (b) => 'code = b"' + toHexPairs(b).map((h) => "\\x" + h).join("") + '"',
  base64:    (b) => btoa(String.fromCharCode.apply(null, b)),
};
const FORMAT_LABELS = {
  hex_space: "hex, spaced",
  hex: "hex, raw string",
  escaped: "\\x escaped",
  zerox: "0x, comma",
  carray: "C array",
  python: "Python bytes",
  base64: "base64",
};

/* ---- Machine-code parser --------------------------------------------------
 * base64 when that format is selected; otherwise liberal hex: prefer explicit
 * 0x / \x tokens (so pasted C/Python declarations work), else raw hex pairs.
 */
function parseMachineCode(text, format) {
  if (format === "base64") {
    const t = text.trim();
    if (t === "") return { bytes: new Uint8Array(0), error: null };
    try {
      const bin = atob(t);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return { bytes: out, error: null };
    } catch (_) {
      return { bytes: new Uint8Array(0), error: "Invalid base64 input." };
    }
  }
  if (/0x[0-9a-fA-F]|\\x[0-9a-fA-F]/i.test(text)) {
    const bytes = [];
    const re = /(?:0x|\\x)([0-9a-fA-F]{1,2})/gi;
    let m;
    while ((m = re.exec(text)) !== null) bytes.push(parseInt(m[1], 16));
    return { bytes: Uint8Array.from(bytes), error: null };
  }
  const cleaned = text.replace(/[^0-9a-fA-F]/g, "");
  if (cleaned.length === 0) return { bytes: new Uint8Array(0), error: null };
  if (cleaned.length % 2 !== 0)
    return { bytes: new Uint8Array(0), error: `Odd number of hex digits (${cleaned.length}). Need whole bytes.` };
  const out = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(cleaned.substr(i * 2, 2), 16);
  return { bytes: out, error: null };
}

function ksErrName(code) {
  for (const k of Object.keys(KS)) if (k.startsWith("ERR_") && KS[k] === code) return "KS_" + k;
  return "KS_ERR_" + code;
}

/* ---- Engine calls --------------------------------------------------------- */
const currentConfig = () => ARCHS[state.arch].build(state);

function disassemble(bytes, cfg, baseAddr) {
  const d = new CS.Capstone(cfg.csArch, cfg.csMode);
  try {
    if (cfg.csSyntax !== undefined) { try { d.option(CS.OPT_SYNTAX, cfg.csSyntax); } catch (_) {} }
    const insns = d.disasm(bytes, baseAddr);
    let offset = 0;
    return insns.map((i) => {
      const rec = { address: BigInt(i.address), size: i.size, bytes: Uint8Array.from(i.bytes),
                    mnemonic: i.mnemonic, opStr: i.op_str, offset };
      offset += i.size;
      return rec;
    });
  } finally { d.close(); }
}

function assemble(source, cfg) {
  const a = new KS.Keystone(cfg.ksArch, cfg.ksMode);
  try {
    if (cfg.ksSyntax !== undefined) { try { a.option(KS.OPT_SYNTAX, cfg.ksSyntax); } catch (_) {} }
    const r = a.asm(source);
    if (r.failed) {
      let code = 0; try { code = a.errno(); } catch (_) {}
      return { bytes: null, error: `Assembly failed (${ksErrName(code)}). Check the instruction syntax.` };
    }
    return { bytes: Uint8Array.from(r.mc), error: null };
  } catch (e) {
    return { bytes: null, error: "Assembly error: " + (e && e.message ? e.message : String(e)) };
  } finally { a.close(); }
}

const insnsToAsm = (insns) =>
  insns.map((i) => (i.opStr ? i.mnemonic + " " + i.opStr : i.mnemonic)).join("\n");

/* ---- DOM helpers ---------------------------------------------------------- */
const $ = (sel) => document.querySelector(sel);
function setStatus(el, text, kind) {
  el.textContent = text;
  el.className = "status" + (kind ? " status--" + kind : "");
}

/* ---- Core: recompute the derived panel + shared views --------------------- */
function recompute() {
  const cfg = currentConfig();
  const baseAddr = state.base;
  const asmStatus = $("#asmStatus");
  const mcStatus = $("#mcStatus");

  let bytes = new Uint8Array(0);
  let asmError = null;   // shown under the Assembly panel
  let mcError = null;    // shown under the Machine code panel

  if (state.source === "asm") {
    // Assembly is authoritative -> produce bytes -> write Machine code panel.
    if (state.asmText.trim() !== "") {
      const res = assemble(state.asmText, cfg);
      if (res.error) asmError = res.error;
      else bytes = res.bytes;
    }
    state.mcText = asmError ? "" : (ENCODERS[state.mcFormat] || ENCODERS.hex_space)(bytes);
    $("#mcInput").value = state.mcText;   // programmatic: no input event -> no loop
  } else {
    // Machine code is authoritative -> parse -> disassemble -> write Assembly.
    const parsed = parseMachineCode(state.mcText, state.mcFormat);
    if (parsed.error) mcError = parsed.error;
    else bytes = parsed.bytes;
    let insns = [];
    if (!mcError && bytes.length) {
      try { insns = disassemble(bytes, cfg, baseAddr); }
      catch (e) { mcError = "Disassembly error: " + (e && e.message ? e.message : String(e)); }
    }
    state.asmText = mcError ? "" : insnsToAsm(insns);
    $("#asmInput").value = state.asmText;
  }

  // Shared derived views (listing + byte map) always come from canonical bytes.
  let insns = [];
  if (bytes.length) { try { insns = disassemble(bytes, cfg, baseAddr); } catch (_) { insns = []; } }

  // Status lines
  if (asmError) setStatus(asmStatus, asmError, "error");
  else setStatus(asmStatus, `${insns.length} instr`, "ok");

  if (mcError) setStatus(mcStatus, mcError, "error");
  else {
    const decoded = insns.reduce((n, i) => n + i.size, 0);
    const tail = bytes.length - decoded;
    setStatus(mcStatus, `${bytes.length} bytes` + (tail > 0 ? ` · ${tail} undecoded` : ""), tail > 0 ? "warn" : "ok");
  }

  $("#outMeta").textContent = `${bytes.length} bytes`;

  const undecodable = state.source === "mc" && !mcError && bytes.length && insns.length === 0;
  renderMatrix($("#matrix"), bytes, insns);
  renderListing($("#listing"), insns, asmError || mcError, undecodable);
}

/* ---- Rendering: byte map + listing ---------------------------------------- */
function renderMatrix(container, bytes, insns) {
  container.innerHTML = "";
  if (!bytes.length) {
    const empty = document.createElement("div");
    empty.className = "matrix-empty";
    empty.textContent = "Bytes appear here, colored per instruction.";
    container.appendChild(empty);
    return;
  }
  const owner = new Int32Array(bytes.length).fill(-1);
  insns.forEach((ins, idx) => {
    for (let k = 0; k < ins.size; k++) if (ins.offset + k < bytes.length) owner[ins.offset + k] = idx;
  });
  const frag = document.createDocumentFragment();
  for (let i = 0; i < bytes.length; i++) {
    const cell = document.createElement("span");
    cell.className = "byte";
    const idx = owner[i];
    if (idx >= 0) {
      cell.style.setProperty("--h", hueFor(idx));
      cell.dataset.ins = String(idx);
      cell.classList.add("byte--owned");
      if (i === insns[idx].offset) cell.classList.add("byte--start");
    } else {
      cell.classList.add("byte--orphan");
    }
    cell.textContent = bytes[i].toString(16).padStart(2, "0");
    frag.appendChild(cell);
  }
  container.appendChild(frag);
}

function renderListing(table, insns, error, undecodable) {
  table.innerHTML = "";
  const msg = (text, cls) => {
    const row = document.createElement("div");
    row.className = "listing-msg" + (cls ? " " + cls : "");
    row.textContent = text;
    table.appendChild(row);
  };
  if (error) return msg(error, "listing-msg--error");
  if (undecodable) return msg("These bytes don't decode to a valid instruction for the selected architecture.", "listing-msg--error");
  if (!insns.length) return msg("Edit either panel — the listing shows up here.");

  const head = document.createElement("div");
  head.className = "lrow lrow--head";
  head.innerHTML =
    '<span class="c-addr">address</span><span class="c-bytes">bytes</span>' +
    '<span class="c-mnem">mnemonic</span><span class="c-ops">operands</span>';
  table.appendChild(head);

  insns.forEach((ins, idx) => {
    const row = document.createElement("div");
    row.className = "lrow";
    row.dataset.ins = String(idx);
    row.style.setProperty("--h", hueFor(idx));
    const a = document.createElement("span"); a.className = "c-addr";
    a.textContent = "0x" + ins.address.toString(16).padStart(8, "0");
    const b = document.createElement("span"); b.className = "c-bytes";
    b.textContent = toHexPairs(ins.bytes).join(" ");
    const m = document.createElement("span"); m.className = "c-mnem"; m.textContent = ins.mnemonic;
    const desc = (typeof describeInsn === "function") ? describeInsn(ins.mnemonic) : "";
    if (desc) m.dataset.desc = desc;
    const o = document.createElement("span"); o.className = "c-ops"; o.textContent = ins.opStr;
    row.append(a, b, m, o);
    row.addEventListener("mouseenter", () => highlightIns(idx, true));
    row.addEventListener("mouseleave", () => highlightIns(idx, false));
    table.appendChild(row);
  });
}

function highlightIns(idx, on) {
  document.querySelectorAll(`.byte[data-ins="${idx}"]`).forEach((el) => el.classList.toggle("byte--hot", on));
  document.querySelectorAll(`.lrow[data-ins="${idx}"]`).forEach((el) => el.classList.toggle("lrow--hot", on));
}

/* Hover tooltip: shows a short description for the mnemonic under the cursor.
   Delegated on the persistent #listing container (rows are re-rendered often). */
function wireTooltip() {
  const tip = $("#insTip");
  const listing = $("#listing");
  tip.innerHTML = '<span class="tip-mnem"></span> — <span class="tip-body"></span>';
  const mnemEl = tip.querySelector(".tip-mnem");
  const bodyEl = tip.querySelector(".tip-body");
  let curr = null;

  const place = (e) => {
    const pad = 12, r = tip.getBoundingClientRect();
    let x = e.clientX + 14, y = e.clientY + 16;
    if (x + r.width + pad > window.innerWidth) x = e.clientX - r.width - 14;
    if (y + r.height + pad > window.innerHeight) y = e.clientY - r.height - 16;
    tip.style.left = Math.max(pad, x) + "px";
    tip.style.top = Math.max(pad, y) + "px";
  };
  const hide = () => { curr = null; tip.classList.remove("on"); tip.setAttribute("aria-hidden", "true"); };

  listing.addEventListener("mouseover", (e) => {
    const el = e.target.closest(".c-mnem[data-desc]");
    if (!el || el === curr) return;
    curr = el;
    mnemEl.textContent = el.textContent;
    bodyEl.textContent = el.dataset.desc;
    tip.classList.add("on"); tip.setAttribute("aria-hidden", "false");
    place(e);
  });
  listing.addEventListener("mousemove", (e) => { if (curr) place(e); });
  listing.addEventListener("mouseout", (e) => {
    const el = e.target.closest(".c-mnem[data-desc]");
    if (el && el === curr && !(e.relatedTarget && el.contains(e.relatedTarget))) hide();
  });
  listing.addEventListener("scroll", hide, true);
}

function wireMatrixHover() {
  const m = $("#matrix");
  m.addEventListener("mouseover", (e) => {
    const c = e.target.closest(".byte[data-ins]"); if (c) highlightIns(Number(c.dataset.ins), true);
  });
  m.addEventListener("mouseout", (e) => {
    const c = e.target.closest(".byte[data-ins]"); if (c) highlightIns(Number(c.dataset.ins), false);
  });
}

/* ---- Controls ------------------------------------------------------------- */
function buildSegmented(container, options, current, onPick) {
  container.innerHTML = "";
  options.forEach((opt) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "seg" + (opt.id === current ? " seg--on" : "");
    btn.textContent = opt.label;
    btn.dataset.id = opt.id;
    btn.addEventListener("click", () => onPick(opt.id));
    container.appendChild(btn);
  });
}
const markOn = (container, id) =>
  Array.from(container.children).forEach((c) => c.classList.toggle("seg--on", c.dataset.id === id));

function syncArchDependentControls() {
  const spec = ARCHS[state.arch];

  buildSegmented($("#modeSeg"), spec.modes, state.mode, (id) => { state.mode = id; markOn($("#modeSeg"), id); recompute(); });
  $("#modeLabel").textContent = spec.modeLabel;

  const endianGroup = $("#endianGroup");
  const endianOpts = [{ id: "le", label: "LE" }, { id: "be", label: "BE" }];
  if (spec.endianLocked) { state.endian = spec.endianLocked; endianGroup.classList.add("ctrl--disabled"); }
  else endianGroup.classList.remove("ctrl--disabled");
  buildSegmented($("#endianSeg"), endianOpts, state.endian, (id) => {
    if (spec.endianLocked) return;
    state.endian = id; markOn($("#endianSeg"), id); recompute();
  });

  const synGroup = $("#syntaxGroup");
  if (spec.syntax) {
    synGroup.classList.remove("ctrl--hidden");
    buildSegmented($("#syntaxSeg"),
      [{ id: "intel", label: "Intel" }, { id: "att", label: "AT&T" }],
      state.syntax, (id) => { state.syntax = id; markOn($("#syntaxSeg"), id); recompute(); });
  } else {
    synGroup.classList.add("ctrl--hidden");
  }
}

/* ---- Init ----------------------------------------------------------------- */
function init(ks, cs) {
  KS = ks; CS = cs;
  $("#boot").classList.add("boot--done");

  buildSegmented($("#archSeg"),
    Object.entries(ARCHS).map(([id, a]) => ({ id, label: a.label })),
    state.arch, (id) => {
      state.arch = id;
      state.mode = ARCHS[id].defaultMode;
      // Reset to that arch's sample on the currently-authoritative side.
      if (state.source === "asm") { state.asmText = SAMPLES[id] || ""; $("#asmInput").value = state.asmText; }
      markOn($("#archSeg"), id);
      syncArchDependentControls();
      recompute();
    });

  const sel = $("#formatSel");
  Object.keys(FORMAT_LABELS).forEach((k) => {
    const opt = document.createElement("option");
    opt.value = k; opt.textContent = FORMAT_LABELS[k]; sel.appendChild(opt);
  });
  sel.value = state.mcFormat;
  sel.addEventListener("change", () => {
    // Reformat the Machine code panel from the canonical bytes without changing
    // which panel is authoritative (format is purely a display concern). This
    // also normalizes text the user typed into the Machine code panel.
    const cfg = currentConfig();
    let bytes = new Uint8Array(0);
    if (state.source === "asm") {
      const r = assemble(state.asmText, cfg);
      if (!r.error && r.bytes) bytes = r.bytes;
    } else {
      const p = parseMachineCode(state.mcText, state.mcFormat); // parse under OLD format
      if (!p.error) bytes = p.bytes;
    }
    state.mcFormat = sel.value;
    state.mcText = bytes.length ? (ENCODERS[state.mcFormat] || ENCODERS.hex_space)(bytes) : "";
    $("#mcInput").value = state.mcText;
    recompute();
  });

  const baseInput = $("#baseAddr");
  baseInput.value = "0x" + state.base.toString(16);
  baseInput.addEventListener("input", () => {
    const raw = baseInput.value.trim().replace(/^0x/i, "");
    if (raw === "") { state.base = 0n; baseInput.classList.remove("bad"); recompute(); return; }
    if (/^[0-9a-fA-F]+$/.test(raw)) { state.base = BigInt("0x" + raw); baseInput.classList.remove("bad"); recompute(); }
    else baseInput.classList.add("bad");
  });

  // Both editors are live and bidirectional.
  const asmInput = $("#asmInput");
  const mcInput = $("#mcInput");
  let ta = null, tb = null;
  asmInput.addEventListener("input", () => {
    state.source = "asm";
    state.asmText = asmInput.value;
    clearTimeout(ta); ta = setTimeout(recompute, 120);
  });
  mcInput.addEventListener("input", () => {
    state.source = "mc";
    state.mcText = mcInput.value;
    clearTimeout(tb); tb = setTimeout(recompute, 120);
  });

  $("#copyOut").addEventListener("click", () => copyText($("#mcInput").value, $("#copyOut")));

  $("#asmInput").value = state.asmText;
  wireMatrixHover();
  wireTooltip();
  syncArchDependentControls();
  recompute();
}

function copyText(text, btn) {
  if (!text) return;
  const done = () => {
    const old = btn.textContent;
    btn.textContent = "copied"; btn.classList.add("copied");
    setTimeout(() => { btn.textContent = old; btn.classList.remove("copied"); }, 900);
  };
  if (navigator.clipboard && navigator.clipboard.writeText)
    navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
  else fallbackCopy(text, done);
}
function fallbackCopy(text, done) {
  const ta = document.createElement("textarea");
  ta.value = text; document.body.appendChild(ta); ta.select();
  try { document.execCommand("copy"); done(); } catch (_) {}
  document.body.removeChild(ta);
}

/* ---- Boot ----------------------------------------------------------------- */
window.addEventListener("DOMContentLoaded", () => {
  const boot = $("#boot"), bootMsg = $("#bootMsg");
  if (typeof MKeystone !== "function" || typeof MCapstone !== "function") {
    bootMsg.textContent = "Engine scripts didn't load. Serve this folder over HTTP (see README).";
    boot.classList.add("boot--error");
    return;
  }
  Promise.all([MKeystone(), MCapstone()])
    .then(([ks, cs]) => init(ks, cs))
    .catch((e) => {
      bootMsg.textContent = "Failed to initialize WASM engines: " + (e && e.message ? e.message : e);
      boot.classList.add("boot--error");
    });
});
