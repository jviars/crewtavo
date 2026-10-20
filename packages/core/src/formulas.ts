/**
 * A small, safe expression evaluator for quote formulas, for example
 *   area_sqyd * depth_in * 110 / 2000                 hot-mix asphalt tons
 *   area_sqft * pitch_factor * (1 + waste) / 100      roofing squares
 *
 * Supports numbers, variable names, + - * / // % ** (or ^), parentheses, unary minus, and
 * min, max, round, ceil, floor, sqrt, abs. Nothing else parses, so formulas from presets or admins
 * can't run code. Operator precedence follows Python (where these formulas started): ** binds
 * tighter than unary minus, so -2 ** 2 is -4.
 */

export class FormulaError extends Error {
  override name = "FormulaError";
}

/**
 * Values a measurement supplies to formulas (apply-measurement in apps/api/src/routes/sales.ts
 * fills in each one). A formula that reads anything else could never be worked out.
 */
export const FORMULA_VARIABLES = [
  "area_sqft", "area_sqyd", "length_ft", "count", "depth_in", "pitch_factor", "waste", "waste_pct",
  // Lines marked as roof edges, at true length (ROOF_EDGES in geo.ts).
  "eave_ft", "rake_ft", "ridge_ft", "hip_ft", "valley_ft",
] as const;
export type FormulaVariable = (typeof FORMULA_VARIABLES)[number];

const MAX_LENGTH = 300;
const MAX_POWER = 10;

const FUNCTIONS: Record<string, (...args: number[]) => number> = {
  min: (...a) => (a.length ? Math.min(...a) : fail("min() needs at least one value")),
  max: (...a) => (a.length ? Math.max(...a) : fail("max() needs at least one value")),
  round: (x, digits = 0) => {
    const f = 10 ** digits;
    return (Math.sign(x) * Math.round(Math.abs(x) * f)) / f; // half away from zero
  },
  ceil: (x) => Math.ceil(x),
  floor: (x) => Math.floor(x),
  sqrt: (x) => (x < 0 ? fail("Square root of a negative number") : Math.sqrt(x)),
  abs: (x) => Math.abs(x),
};

function fail(message: string): never {
  throw new FormulaError(message);
}

type Token =
  | { kind: "num"; value: number }
  | { kind: "name"; value: string }
  | { kind: "op"; value: string };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  const re = /\s*(?:(\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)|([A-Za-z_][A-Za-z0-9_]*)|(\*\*|\/\/|[-+*/%^(),]))/y;
  let index = 0;
  while (index < source.length) {
    if (/^\s*$/.test(source.slice(index))) break;
    re.lastIndex = index;
    const match = re.exec(source);
    if (!match) fail(`Formula has something that isn't allowed near "${source.slice(index).trim().slice(0, 12)}"`);
    if (match[1] !== undefined) tokens.push({ kind: "num", value: Number(match[1]) });
    else if (match[2] !== undefined) tokens.push({ kind: "name", value: match[2] });
    else tokens.push({ kind: "op", value: match[3] === "^" ? "**" : match[3] });
    index = re.lastIndex;
  }
  return tokens;
}

type Node =
  | { type: "num"; value: number }
  | { type: "var"; name: string }
  | { type: "unary"; op: string; arg: Node }
  | { type: "binary"; op: string; left: Node; right: Node }
  | { type: "call"; name: string; args: Node[] };

function parse(source: string): Node {
  if (!source || !source.trim()) fail("Formula is empty");
  if (source.length > MAX_LENGTH) fail("Formula is too long");
  const tokens = tokenize(source);
  let pos = 0;
  const peek = () => tokens[pos];
  const isOp = (value: string) => peek()?.kind === "op" && peek()?.value === value;
  const expectOp = (value: string) => {
    if (!isOp(value)) fail(`Expected "${value}"`);
    pos++;
  };

  // expr := term (('+' | '-') term)*
  function expr(): Node {
    let node = term();
    while (isOp("+") || isOp("-")) {
      const op = (tokens[pos++] as { value: string }).value;
      node = { type: "binary", op, left: node, right: term() };
    }
    return node;
  }
  // term := unary (('*' | '/' | '//' | '%') unary)*
  function term(): Node {
    let node = unary();
    while (isOp("*") || isOp("/") || isOp("//") || isOp("%")) {
      const op = (tokens[pos++] as { value: string }).value;
      node = { type: "binary", op, left: node, right: unary() };
    }
    return node;
  }
  // unary := ('+' | '-') unary | power
  function unary(): Node {
    if (isOp("-") || isOp("+")) {
      const op = (tokens[pos++] as { value: string }).value;
      return { type: "unary", op, arg: unary() };
    }
    return power();
  }
  // power := primary ('**' unary)?
  function power(): Node {
    const base = primary();
    if (isOp("**")) {
      pos++;
      return { type: "binary", op: "**", left: base, right: unary() };
    }
    return base;
  }
  // primary := number | name | name '(' args ')' | '(' expr ')'
  function primary(): Node {
    const token = peek();
    if (!token) fail("Formula ends unexpectedly");
    if (token.kind === "num") {
      pos++;
      return { type: "num", value: token.value };
    }
    if (token.kind === "name") {
      pos++;
      if (isOp("(")) {
        // Own keys only: every object also has "constructor", "__proto__" and the like.
        if (!Object.hasOwn(FUNCTIONS, token.value)) fail(`Unknown function "${token.value}"`);
        pos++;
        const args: Node[] = [];
        if (!isOp(")")) {
          args.push(expr());
          while (isOp(",")) {
            pos++;
            args.push(expr());
          }
        }
        expectOp(")");
        return { type: "call", name: token.value, args };
      }
      return { type: "var", name: token.value };
    }
    if (isOp("(")) {
      pos++;
      const node = expr();
      expectOp(")");
      return node;
    }
    fail(`Unexpected "${token.value}"`);
  }

  const tree = expr();
  if (pos !== tokens.length) fail(`Unexpected "${String(tokens[pos].value)}"`);
  return tree;
}

function evalNode(node: Node, vars: Record<string, number | null | undefined>): number {
  switch (node.type) {
    case "num":
      return node.value;
    case "var": {
      if (!Object.hasOwn(vars, node.name)) fail(`Unknown value "${node.name}"`);
      const value = vars[node.name];
      if (value === null || value === undefined || Number.isNaN(Number(value))) fail(`"${node.name}" has no value yet`);
      return Number(value);
    }
    case "unary": {
      const value = evalNode(node.arg, vars);
      return node.op === "-" ? -value : value;
    }
    case "binary": {
      const left = evalNode(node.left, vars);
      const right = evalNode(node.right, vars);
      switch (node.op) {
        case "+": return left + right;
        case "-": return left - right;
        case "*": return left * right;
        case "/": return right === 0 ? fail("Division by zero") : left / right;
        case "//": return right === 0 ? fail("Division by zero") : Math.floor(left / right);
        case "%": return right === 0 ? fail("Division by zero") : left - right * Math.floor(left / right);
        case "**": return Math.abs(right) > MAX_POWER ? fail("Exponent too large") : left ** right;
      }
      return fail(`Unknown operator "${node.op}"`);
    }
    case "call":
      return FUNCTIONS[node.name](...node.args.map((arg) => evalNode(arg, vars)));
  }
}

/** Evaluate a formula. Throws FormulaError with a message suitable for showing to the user. */
export function evaluateFormula(source: string, variables: Record<string, number | null | undefined>): number {
  const result = evalNode(parse(source), variables);
  if (!Number.isFinite(result)) fail("Formula result isn't a finite number");
  return result;
}

/** Variable names a formula reads, so the UI can show what it needs. */
export function formulaVariables(source: string): Set<string> {
  const names = new Set<string>();
  const walk = (node: Node): void => {
    if (node.type === "var") names.add(node.name);
    else if (node.type === "unary") walk(node.arg);
    else if (node.type === "binary") {
      walk(node.left);
      walk(node.right);
    } else if (node.type === "call") node.args.forEach(walk);
  };
  walk(parse(source));
  return names;
}

/** Throws FormulaError if a formula doesn't parse or reads values measurements can't supply. */
export function validateFormula(source: string): void {
  for (const name of formulaVariables(source)) {
    if (!(FORMULA_VARIABLES as readonly string[]).includes(name)) fail(`Unknown value "${name}"`);
  }
}
