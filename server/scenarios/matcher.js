// Step matching (QA-CONTRACTS §6): Cucumber Expressions, keyword-agnostic, highest priority wins, two matches at the same
// (highest) priority = ambiguous (invalid scenario).
import { CucumberExpression, ParameterTypeRegistry } from '@cucumber/cucumber-expressions';

export function buildMatcher(steps) {
  const registry = new ParameterTypeRegistry();
  const compiled = [];
  const errors = [];
  for (const def of steps) {
    try {
      compiled.push({ def, expr: new CucumberExpression(def.pattern, registry) });
    } catch (error) {
      errors.push({ id: def.id, pattern: def.pattern, error: String(error.message).split('\n')[0] });
    }
  }
  // -> { def, args } | { error, candidates }
  function match(text) {
    const hits = [];
    for (const c of compiled) {
      let m = null;
      try { m = c.expr.match(text); } catch { m = null; }
      if (m) hits.push({ def: c.def, args: m.map((a) => a.getValue(null)) });
    }
    if (!hits.length) return { error: 'no step definition matches this step', candidates: [] };
    const top = Math.max(...hits.map((h) => Number(h.def.priority) || 0));
    const best = hits.filter((h) => (Number(h.def.priority) || 0) === top);
    if (best.length > 1) return { error: `ambiguous: matches ${best.map((h) => h.def.id).join(', ')} at priority ${top}`, candidates: best.map((h) => h.def.id) };
    return best[0];
  }
  return { match, errors, size: compiled.length };
}
