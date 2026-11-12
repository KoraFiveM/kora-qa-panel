// Feature file -> raw scenarios (one per pickle) with the official @cucumber/gherkin parser and pickle compiler.
import { AstBuilder, GherkinClassicTokenMatcher, Parser, compile } from '@cucumber/gherkin';
import { IdGenerator } from '@cucumber/messages';

// A Scenario description written as a """ block (how the conversion keeps the original text) -> plain dedented text.
export function cleanDescription(desc) {
  if (!desc) return '';
  let lines = String(desc).replace(/\r/g, '').split('\n');
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines.at(-1).trim()) lines.pop();
  if (lines.length >= 2 && /^\s*("""|```)\s*$/.test(lines[0]) && /^\s*("""|```)\s*$/.test(lines.at(-1))) lines = lines.slice(1, -1);
  const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => /^\s*/.exec(l)[0].length), Infinity);
  return lines.map((l) => (Number.isFinite(indent) ? l.slice(indent) : l)).join('\n').trim();
}

function parseErrors(error) {
  const list = Array.isArray(error?.errors) && error.errors.length ? error.errors : [error];
  return list.map((e) => ({ line: e?.location?.line ?? null, message: String(e?.message ?? e).replace(/^\(\d+:\d+\): /, '') }));
}

// -> { scenarios: [{ id, resource, file, line, name, description, tags, steps:[{idx, keyword, text, line, docString, dataTable}] }],
//      errors: [{ line, message }], feature: { name, tags } | null }
export function compileFeature(text, { resource, file }) {
  const uuid = IdGenerator.incrementing();
  const parser = new Parser(new AstBuilder(uuid), new GherkinClassicTokenMatcher());
  let doc;
  try {
    doc = parser.parse(String(text));
  } catch (error) {
    return { scenarios: [], errors: parseErrors(error), feature: null };
  }
  if (!doc.feature) return { scenarios: [], errors: [{ line: 1, message: 'no Feature in this file' }], feature: null };
  let pickles;
  try {
    pickles = compile(doc, file, uuid);
  } catch (error) {
    return { scenarios: [], errors: parseErrors(error), feature: null };
  }

  const nodes = new Map(); // ast id -> { kind, node }
  const visit = (children) => {
    for (const ch of children ?? []) {
      if (ch.background) for (const st of ch.background.steps) nodes.set(st.id, { kind: 'step', node: st });
      if (ch.scenario) {
        nodes.set(ch.scenario.id, { kind: 'scenario', node: ch.scenario });
        for (const st of ch.scenario.steps) nodes.set(st.id, { kind: 'step', node: st });
        for (const ex of ch.scenario.examples ?? []) for (const row of ex.tableBody ?? []) nodes.set(row.id, { kind: 'row', node: row });
      }
      if (ch.rule) visit(ch.rule.children);
    }
  };
  visit(doc.feature.children);

  const scenarios = pickles.map((p) => {
    const sc = nodes.get(p.astNodeIds[0])?.node;
    const row = p.astNodeIds.length > 1 ? nodes.get(p.astNodeIds.at(-1))?.node : null;
    const line = row?.location?.line ?? sc?.location?.line ?? 0;
    return {
      id: `${resource}:${file}:${line}`,
      resource, file, line,
      name: p.name,
      description: cleanDescription(sc?.description),
      tags: p.tags.map((t) => t.name),
      steps: p.steps.map((st, idx) => {
        const ast = nodes.get(st.astNodeIds[0])?.node;
        return {
          idx,
          keyword: (ast?.keyword ?? '').trim() || ({ Context: 'Given', Action: 'When', Outcome: 'Then' }[st.type] ?? '*'),
          text: st.text,
          line: ast?.location?.line ?? null,
          docString: st.argument?.docString?.content ?? null,
          dataTable: st.argument?.dataTable ? st.argument.dataTable.rows.map((r) => r.cells.map((c) => c.value)) : null,
        };
      }),
    };
  });
  return { scenarios, errors: [], feature: { name: doc.feature.name, tags: doc.feature.tags.map((t) => t.name) } };
}
