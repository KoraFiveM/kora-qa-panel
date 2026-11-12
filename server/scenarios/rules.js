// Port of kora_qa/shared/catalog.lua (S2): step-definition shape check, alias lookup and argument validation with the
// same `allow` vocabulary, caps keys and error messages, so a scenario the panel serves is one kora_qa will execute.
// Shared test vectors: test/fixtures/catalog-vectors.json (kora_qa's Lua tests can read the same file).

export const KINDS = new Set(['setup', 'observed', 'check', 'manual']);
export const SIDES = new Set(['server', 'client', 'both']);
export const TYPES = new Set(['int', 'float', 'string', 'word', 'any']);
export const ALIAS_GROUPS = ['locations', 'vehicles', 'peds', 'props', 'fixtures'];
const DEFAULT_MAX_LENGTH = { string: 200, word: 64, any: 500 };

// Lua's # on a string is its byte length.
const bytes = (s) => Buffer.byteLength(s, 'utf8');
const lower = (v) => (typeof v === 'string' ? v.toLowerCase() : v);
const isInteger = (v) => typeof v === 'number' && Number.isInteger(v);
// Lua tostring(): integers without a fraction.
const luaStr = (v) => (v === null || v === undefined ? 'nil' : typeof v === 'number' ? (Number.isInteger(v) ? String(v) : String(v)) : String(v));

const asList = (v) => (Array.isArray(v) ? v : v && typeof v === 'object' ? Object.values(v) : null);
export function listHas(list, value) {
  const l = asList(list);
  if (!l) return false;
  const needle = lower(value);
  return l.some((e) => lower(e) === needle);
}

// validateDef(def) -> { ok:true } | { ok:false, error }
export function validateDef(def) {
  if (!def || typeof def !== 'object' || Array.isArray(def)) return { ok: false, error: 'definition must be a table' };
  if (typeof def.id !== 'string' || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_.-]+$/.test(def.id) || bytes(def.id) > 64) return { ok: false, error: 'id must look like "group.name"' };
  if (typeof def.pattern !== 'string' || def.pattern === '' || bytes(def.pattern) > 200) return { ok: false, error: `${def.id}: pattern missing` };
  if (!KINDS.has(def.kind)) return { ok: false, error: `${def.id}: unknown kind ${luaStr(def.kind)}` };
  if (!SIDES.has(def.side)) return { ok: false, error: `${def.id}: unknown side ${luaStr(def.side)}` };
  if (def.priority !== undefined && def.priority !== null && !isInteger(def.priority)) return { ok: false, error: `${def.id}: priority must be an integer` };
  const args = def.args === undefined ? null : def.args;
  if (!Array.isArray(args)) return { ok: false, error: `${def.id}: args must be a list` };
  const placeholders = (def.pattern.match(/\{[A-Za-z]*\}/g) ?? []).length;
  if (placeholders !== args.length) return { ok: false, error: `${def.id}: pattern has ${placeholders} parameters but ${args.length} args` };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a || typeof a !== 'object' || typeof a.name !== 'string' || !TYPES.has(a.type)) return { ok: false, error: `${def.id}: arg ${i + 1} malformed` };
  }
  return { ok: true };
}

// Lua catalog: aliases[res][group][name]; "owner:name" explicit, else the scenario's resource, then kora_qa.
// -> { value, owner } | null
export function resolveAlias(aliases, group, name, resource) {
  if (!aliases || typeof aliases !== 'object' || typeof name !== 'string') return null;
  const m = /^([A-Za-z0-9_-]+):(.+)$/.exec(name);
  if (m && aliases[m[1]]?.[group] && aliases[m[1]][group][m[2]] !== undefined && aliases[m[1]][group][m[2]] !== null) return { value: aliases[m[1]][group][m[2]], owner: m[1] };
  for (const cand of [resource, 'kora_qa']) {
    const set = cand ? aliases[cand] : null;
    if (set?.[group] && set[group][name] !== undefined && set[group][name] !== null) return { value: set[group][name], owner: cand };
  }
  return null;
}

const num = (v) => { if (typeof v === 'number') return Number.isFinite(v) ? v : null; if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v); return null; };
export function normalizeLocation(value) {
  if (!value || typeof value !== 'object') return null;
  const at = (k, i) => (value[k] !== undefined ? value[k] : Array.isArray(value) ? value[i - 1] : value[i]);
  const x = num(at('x', 1));
  const y = num(at('y', 2));
  const z = num(at('z', 3));
  if (x === null || y === null || z === null) return null;
  const h = num(value.h ?? value.heading ?? value.w ?? at('_', 4));
  const r = num(value.r ?? value.radius);
  return { x, y, z, h, r, label: typeof value.label === 'string' ? value.label : null };
}

const MODEL_RE = /^[A-Za-z0-9_-]+$/;
const modelAllowed = (caps, ...names) => names.every((n) => !listHas(caps.modelDeny, n));

const R = (value) => ({ value });
const E = (error) => ({ error });
const identifier = (v) => (/^[A-Za-z0-9_-]+$/.test(v) ? R(v.toLowerCase()) : E('is not a valid name'));
const modelRule = (group) => (v, env) => {
  const alias = resolveAlias(env.aliases, group, v, env.resource);
  let model = alias ? alias.value : v;
  if (alias && typeof alias.value === 'object') model = alias.value.model;
  if (typeof model !== 'string' || !MODEL_RE.test(model)) return E('is not a model name or alias');
  if (!modelAllowed(env.caps, v, model)) return E('is on the model denylist');
  return R(model.toLowerCase());
};

// Mirrors kora_qa shared/keys.lua aliases and catalog.lua notifyTypes.
const KEY_ALIASES = {
  'LEFT ALT': 'ALT', 'RIGHT ALT': 'ALT', RALT: 'ALT', 'LEFT SHIFT': 'SHIFT', 'LEFT CTRL': 'CTRL',
  CONTROL: 'CTRL', RETURN: 'ENTER', 'PAGE UP': 'PAGEUP', 'PAGE DOWN': 'PAGEDOWN', DEL: 'DELETE',
  'ARROW UP': 'UP', 'ARROW DOWN': 'DOWN', 'ARROW LEFT': 'LEFT', 'ARROW RIGHT': 'RIGHT',
  'CAPS LOCK': 'CAPSLOCK', CAPS: 'CAPSLOCK', 'LEFT MOUSE': 'MOUSE1', 'RIGHT MOUSE': 'MOUSE2',
};
const NOTIFY_TYPES = { info: 'info', inform: 'info', success: 'success', warning: 'warning', warn: 'warning', error: 'error' };

export const allowRules = {
  items: (v, env) => {
    if (!/^[A-Za-z0-9_.-]+$/.test(v)) return E('is not an item name');
    if (listHas(env.caps.itemDeny, v)) return E('is on the item denylist');
    if (asList(env.caps.itemAllow) && !listHas(env.caps.itemAllow, v)) return E('is not on the item allowlist');
    return R(v.toLowerCase());
  },
  accounts: (v, env) => (listHas(env.caps.accounts ?? ['cash', 'bank'], v) ? R(v.toLowerCase()) : E('is not an allowed money account')),
  jobs: identifier,
  gangs: identifier,
  metadataKeys: (v, env) => {
    if (!/^[A-Za-z0-9_.-]+$/.test(v)) return E('is not a metadata key');
    if (listHas(env.caps.metadataDeny, v)) return E('is on the metadata denylist');
    return R(v);
  },
  locations: (v, env) => {
    const loc = normalizeLocation(resolveAlias(env.aliases, 'locations', v, env.resource)?.value);
    if (!loc) return E('is not a known location alias');
    return R({ ...loc, name: v });
  },
  vehicles: modelRule('vehicles'),
  peds: modelRule('peds'),
  props: modelRule('props'),
  pedScenarios: (v) => (/^[A-Z0-9_]+$/.test(v) ? R(v) : E('is not a GTA scenario name')),
  weather: (v, env) => (listHas(env.caps.weather, v) ? R(v.toUpperCase()) : E('is not a weather type')),
  inventoryTypes: (v, env) => (listHas(env.caps.inventoryTypes, v) ? R(v.toLowerCase()) : E('is not an inventory type')),
  // Lua requires the fixture's table; the registry only carries names (value true), so the panel accepts any non-null entry.
  fixtures: (v, env) => {
    const f = resolveAlias(env.aliases, 'fixtures', v, env.resource);
    if (!f || (typeof f.value !== 'object' && f.value !== true)) return E('is not a known fixture');
    return R({ name: v, owner: f.owner, steps: typeof f.value === 'object' ? (f.value.steps ?? f.value) : null });
  },
  commands: (v) => {
    const text = v.replace(/^\s*\//, '').replace(/\s+$/, '');
    const name = /^(\S+)/.exec(text)?.[1];
    if (!name || !/^[A-Za-z0-9_:.-]+$/.test(name)) return E('is not a command');
    return R({ text, name: name.toLowerCase() });
  },
  marks: (v) => (bytes(v) > 64 || !/^[A-Za-z0-9_:./ -]+$/.test(v) ? E('is not a mark name') : R(v)),
  text: (v) => R(v),
  // kora_qa shared/keys.lua QAKeys.normalize (any key name; unknown keys fall back to Done in game).
  keys: (v) => {
    const key = v.trim().toUpperCase();
    if (!key || bytes(key) > 24 || !/^[A-Z0-9_ `-]+$/.test(key)) return E('is not a key name');
    return R(KEY_ALIASES[key] ?? key);
  },
  notifyTypes: (v) => {
    const kind = NOTIFY_TYPES[v.toLowerCase()];
    return kind ? R(kind) : E('is not a notification type (info, success, warning, error)');
  },
};

// validateArgs(def, args, { caps, aliases, resource }) -> { params } | { error }  (catalog.lua C.validateArgs)
export function validateArgs(def, args, env = {}) {
  const list = Array.isArray(args) ? args : [];
  const specs = def.args ?? [];
  if (list.length !== specs.length) return { error: `expected ${specs.length} argument(s), got ${list.length}` };
  const e = { ...env, caps: env.caps ?? {} };
  const params = {};
  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i];
    let value = list[i];
    const label = `"${luaStr(value)}" (${spec.name})`;
    if (spec.type === 'int') {
      if (!isInteger(value)) return { error: `${label} must be a whole number` };
    } else if (spec.type === 'float') {
      if (typeof value !== 'number' || !Number.isFinite(value)) return { error: `${label} must be a number` };
    } else {
      if (typeof value !== 'string') return { error: `${label} must be text` };
      const maxLength = spec.maxLength ?? DEFAULT_MAX_LENGTH[spec.type] ?? 200;
      if (bytes(value) > maxLength) return { error: `${spec.name} is longer than ${maxLength} characters` };
      if (spec.type === 'word' && /\s/.test(value)) return { error: `${label} must be one word` };
    }
    if (typeof value === 'number') {
      if (spec.min !== undefined && spec.min !== null && value < spec.min) return { error: `${label} must be at least ${luaStr(spec.min)}` };
      if (spec.max !== undefined && spec.max !== null && value > spec.max) return { error: `${label} must be at most ${luaStr(spec.max)}` };
      if (spec.cap) {
        const limit = num(e.caps[spec.cap]);
        if (limit === null) return { error: `cap ${spec.cap} is not configured` };
        if (value > limit) return { error: `${label} is over the ${spec.cap} cap (${luaStr(limit)})` };
        if (value < -limit) return { error: `${label} is under the ${spec.cap} cap (-${luaStr(limit)})` };
      }
    }
    if (spec.allow) {
      const rule = allowRules[spec.allow];
      if (!rule) return { error: `unknown allow rule ${spec.allow}` };
      const out = rule(value, e);
      if (out.error !== undefined || out.value === undefined || out.value === null) return { error: `${label} ${out.error ?? 'is not allowed'}` };
      value = out.value;
    }
    params[spec.name] = value;
  }
  return { params };
}
