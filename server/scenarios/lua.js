// A small reader for Lua table literals — enough for `tests/qa.lua` alias files (`return { locations = {...}, ... }`) and
// `Config.caps = {...}` in kora_qa/config.lua. Not a Lua interpreter: function calls other than vector3/vec3/vector4/vec4
// and any expression beyond literals become { __expr: '<source>' }.

export function tokenize(src) {
  const toks = [];
  let i = 0;
  const n = src.length;
  const longBracket = (at) => { const m = /^\[(=*)\[/.exec(src.slice(at, at + 64)); return m ? m[1].length : -1; };
  while (i < n) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '-' && src[i + 1] === '-') {
      i += 2;
      const lvl = longBracket(i);
      if (lvl >= 0) { const end = src.indexOf(`]${'='.repeat(lvl)}]`, i); i = end < 0 ? n : end + lvl + 2; } else { while (i < n && src[i] !== '\n') i++; }
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      let out = '';
      while (j < n && src[j] !== c) {
        if (src[j] === '\\') {
          const e = src[j + 1];
          const map = { n: '\n', t: '\t', r: '\r', '\\': '\\', '"': '"', "'": "'", '\n': '\n', a: '\x07', b: '\b', f: '\f', v: '\v', 0: '\0' };
          if (/[0-9]/.test(e)) { const m = /^[0-9]{1,3}/.exec(src.slice(j + 1)); out += String.fromCharCode(Number(m[0])); j += 1 + m[0].length; continue; }
          out += map[e] ?? e; j += 2; continue;
        }
        out += src[j++];
      }
      toks.push({ t: 'str', v: out, at: i });
      i = j + 1;
      continue;
    }
    if (c === '[') {
      const lvl = longBracket(i);
      if (lvl >= 0) {
        const start = i + lvl + 2;
        const end = src.indexOf(`]${'='.repeat(lvl)}]`, start);
        let v = src.slice(start, end < 0 ? n : end);
        if (v.startsWith('\n')) v = v.slice(1);
        toks.push({ t: 'str', v, at: i });
        i = end < 0 ? n : end + lvl + 2;
        continue;
      }
    }
    const num = /^(0x[0-9a-fA-F]+|[0-9]+\.?[0-9]*(?:[eE][+-]?[0-9]+)?|\.[0-9]+(?:[eE][+-]?[0-9]+)?)/.exec(src.slice(i, i + 64));
    if (num && /[0-9.]/.test(c)) { toks.push({ t: 'num', v: Number(num[1]), at: i }); i += num[1].length; continue; }
    const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i, i + 256));
    if (id) { toks.push({ t: 'id', v: id[0], at: i }); i += id[0].length; continue; }
    const two = src.slice(i, i + 2);
    if (['==', '~=', '<=', '>=', '..', '::'].includes(two)) { toks.push({ t: 'op', v: two, at: i }); i += 2; continue; }
    toks.push({ t: 'op', v: c, at: i });
    i++;
  }
  return toks;
}

const VEC = { vector3: ['x', 'y', 'z'], vec3: ['x', 'y', 'z'], vector4: ['x', 'y', 'z', 'h'], vec4: ['x', 'y', 'z', 'h'], vector2: ['x', 'y'], vec2: ['x', 'y'] };

class Reader {
  constructor(src, toks, pos = 0) { this.src = src; this.toks = toks; this.p = pos; }
  peek(o = 0) { return this.toks[this.p + o]; }
  next() { return this.toks[this.p++]; }
  is(v, o = 0) { const t = this.peek(o); return t && t.t === 'op' && t.v === v; }
  expect(v) { const t = this.next(); if (!t || t.t !== 'op' || t.v !== v) throw new Error(`expected '${v}' near offset ${t?.at ?? 'end'}`); }

  // Skips an expression we do not understand up to the next , ; or closing bracket at depth 0.
  skipExpr(startAt) {
    let depth = 0;
    while (this.peek()) {
      const t = this.peek();
      if (t.t === 'op' && ['{', '(', '['].includes(t.v)) depth++;
      if (t.t === 'op' && ['}', ')', ']'].includes(t.v)) { if (depth === 0) break; depth--; }
      if (depth === 0 && t.t === 'op' && (t.v === ',' || t.v === ';')) break;
      this.next();
    }
    const end = this.peek()?.at ?? this.src.length;
    return { __expr: this.src.slice(startAt, end).trim() };
  }

  value() {
    const t = this.peek();
    if (!t) throw new Error('unexpected end of input');
    const startAt = t.at;
    let v;
    if (t.t === 'op' && t.v === '{') v = this.table();
    else if (t.t === 'str') { this.next(); v = t.v; }
    else if (t.t === 'num') { this.next(); v = t.v; }
    else if (t.t === 'op' && t.v === '-' && this.peek(1)?.t === 'num') { this.next(); v = -this.next().v; }
    else if (t.t === 'id' && (t.v === 'true' || t.v === 'false')) { this.next(); v = t.v === 'true'; }
    else if (t.t === 'id' && t.v === 'nil') { this.next(); v = null; }
    else if (t.t === 'id' && VEC[t.v] && this.is('(', 1)) {
      this.next(); this.next();
      const args = [];
      while (!this.is(')')) { args.push(this.value()); if (this.is(',')) this.next(); else break; }
      this.expect(')');
      v = Object.fromEntries(VEC[t.v].map((k, i) => [k, args[i]]));
    } else return this.skipExpr(startAt);
    // a literal followed by an operator (e.g. 'a' .. 'b', 1 + 2): not a plain literal
    const after = this.peek();
    if (after && after.t === 'op' && !([',', ';', '}', ')', ']'].includes(after.v))) return this.skipExpr(startAt);
    return v;
  }

  table() {
    this.expect('{');
    const arr = [];
    const obj = {};
    let hasKeys = false;
    while (!this.is('}')) {
      if (!this.peek()) throw new Error('unterminated table');
      if (this.is('[')) {
        this.next();
        const k = this.value();
        this.expect(']');
        this.expect('=');
        obj[k] = this.value();
        hasKeys = true;
      } else if (this.peek()?.t === 'id' && this.is('=', 1)) {
        const k = this.next().v;
        this.next();
        obj[k] = this.value();
        hasKeys = true;
      } else arr.push(this.value());
      if (this.is(',') || this.is(';')) this.next();
      else if (!this.is('}')) throw new Error(`expected , or } near offset ${this.peek()?.at}`);
    }
    this.expect('}');
    if (!hasKeys) return arr;
    arr.forEach((v, i) => { obj[i + 1] = v; });
    return obj;
  }
}

export function parseLuaValue(src) {
  const r = new Reader(src, tokenize(src));
  return r.value();
}

// `return <table>` or `local t = {...} ... return t`. Returns the value or throws.
export function parseLuaReturn(src) {
  const toks = tokenize(src);
  let ri = -1;
  for (let i = toks.length - 1; i >= 0; i--) if (toks[i].t === 'id' && toks[i].v === 'return') { ri = i; break; }
  if (ri < 0) throw new Error('no return statement');
  const after = toks[ri + 1];
  if (after?.t === 'id' && !['true', 'false', 'nil'].includes(after.v) && !VEC[after.v]) {
    const v = findAssignment(src, toks, [after.v]);
    if (v === undefined) throw new Error(`cannot resolve returned variable ${after.v}`);
    return v;
  }
  return new Reader(src, toks, ri + 1).value();
}

// Value assigned to a dotted name (e.g. ['Config','caps']); the last assignment wins. undefined when absent.
function findAssignment(src, toks, parts) {
  let found;
  for (let i = 0; i < toks.length; i++) {
    let j = i;
    if (toks[j]?.t === 'id' && toks[j].v === 'local') j++;
    let ok = true;
    for (let k = 0; k < parts.length; k++) {
      if (k > 0) { if (!(toks[j]?.t === 'op' && toks[j].v === '.')) { ok = false; break; } j++; }
      if (!(toks[j]?.t === 'id' && toks[j].v === parts[k])) { ok = false; break; }
      j++;
    }
    if (!ok || !(toks[j]?.t === 'op' && toks[j].v === '=')) continue;
    if (i > 0 && toks[i - 1]?.t === 'op' && toks[i - 1].v === '.') continue;
    try { found = new Reader(src, toks, j + 1).value(); } catch { /* keep looking */ }
  }
  return found;
}

export function parseLuaAssignment(src, dotted) {
  return findAssignment(src, tokenize(src), dotted.split('.'));
}
