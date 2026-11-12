-- Runs test/fixtures/catalog-vectors.json through kora_qa's shared/catalog.lua (the Lua side of the shared vectors).
--   lua5.4 test/lua/catalog-vectors.lua <kora_qa dir> <vectors.json>
-- Prints one line per mismatch and exits 1 if any.
local qaDir, vectorsFile = arg[1], arg[2]
package.path = qaDir .. '/test/?.lua;' .. package.path
local json = dofile(qaDir .. '/test/json.lua')
dofile(qaDir .. '/shared/catalog.lua')
local C = QACatalog

local f = assert(io.open(vectorsFile, 'r')); local V = json.decode(f:read('a')); f:close()

local function copy(t) local o = {} for k, v in pairs(t or {}) do o[k] = v end return o end
local function equal(a, b)
    if type(a) ~= type(b) then return false end
    if type(a) ~= 'table' then return a == b end
    for k, v in pairs(a) do if not equal(v, b[k]) then return false end end
    for k, v in pairs(b) do if a[k] == nil and v ~= nil then return false end end
    return true
end
local function show(v) return type(v) == 'table' and json.encode(v) or tostring(v) end

local bad, n = 0, 0
for _, case in ipairs(V.cases) do
    n = n + 1
    local caps = copy(V.env.caps)
    for k, v in pairs(case.caps or {}) do caps[k] = v end
    for _, k in ipairs(case.capsUnset or {}) do caps[k] = nil end
    local params, err = C.validateArgs({ args = case.specs }, case.values or {}, { caps = caps, aliases = V.env.aliases, resource = case.resource or V.env.resource })
    local ok = params ~= nil
    if ok ~= case.ok then bad = bad + 1; print(('MISMATCH %s: ok=%s err=%s'):format(case.name, tostring(ok), tostring(err)))
    elseif not ok and case.error and err ~= case.error then bad = bad + 1; print(('MISMATCH %s: error %q, want %q'):format(case.name, err, case.error))
    elseif ok and case.params and not equal(params, case.params) then
        -- a location's `label` is nil when absent in Lua; params compare ignores nils already
        bad = bad + 1; print(('MISMATCH %s: params %s, want %s'):format(case.name, show(params), show(case.params)))
    end
end
for _, case in ipairs(V.defs or {}) do
    n = n + 1
    local ok, err = C.validateDef(case.def)
    if ok ~= case.ok or (not ok and case.error and err ~= case.error) then bad = bad + 1; print(('MISMATCH def %s: %s %s'):format(case.name, tostring(ok), tostring(err))) end
end
print(('%d cases, %d mismatches'):format(n, bad))
os.exit(bad == 0 and 0 or 1)
