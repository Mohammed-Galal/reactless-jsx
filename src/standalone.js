const acorn = require("acorn");
const jsx = require("acorn-jsx");
const astring = require("astring");

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Stable source‑location key (same as the Babel version) */
function generateKey(node, state) {
  const loc = node.loc;
  const line = loc ? loc.start.line : 0;
  const col = loc ? loc.start.column : 0;
  return `${state.filename}#${line}:${col}`;
}

/** Is it an intrinsic HTML tag? (first char lowercase) */
function isIntrinsic(name) {
  return name[0] === name[0].toLowerCase();
}

/** Walk a JSXMemberExpression and build a dotted key string */
function jsxMemberExprToKey(node) {
  if (node.type === "JSXIdentifier") return node.name;
  if (node.type === "JSXMemberExpression")
    return `${jsxMemberExprToKey(node.object)}.${node.property.name}`;
  return node.type;
}

/** Convert a JSX name node (JSXIdentifier / JSXMemberExpression) to a normal
    ESTree expression node (Identifier / MemberExpression). */
function jsxNameToExprNode(nameNode) {
  if (nameNode.type === "JSXIdentifier")
    return { type: "Identifier", name: nameNode.name };
  if (nameNode.type === "JSXMemberExpression")
    return {
      type: "MemberExpression",
      object: jsxNameToExprNode(nameNode.object),
      property: { type: "Identifier", name: nameNode.property.name },
      computed: false,
      optional: false,
    };
  throw new Error(`Unsupported JSX name node: ${nameNode.type}`);
}

// ─── AST builders (acorn style) ──────────────────────────────────────────────

function astNode(type, props = {}) {
  return { type, ...props };
}

function literal(value) {
  if (typeof value === "string")
    return astNode("Literal", { value, raw: JSON.stringify(value) });
  if (typeof value === "number")
    return astNode("Literal", { value, raw: String(value) });
  if (value === null) return astNode("Literal", { value: null, raw: "null" });
  // boolean
  return astNode("Literal", { value, raw: String(value) });
}

function identifier(name) {
  return astNode("Identifier", { name });
}

function arrayExpression(elements) {
  return astNode("ArrayExpression", { elements });
}

function objectExpression(properties) {
  return astNode("ObjectExpression", { properties });
}

function property(key, value) {
  return astNode("Property", {
    key,
    value,
    kind: "init",
    method: false,
    shorthand: false,
    computed: false,
  });
}

// ─── Import table ────────────────────────────────────────────────────────────

function getOrAddImport(key, nameNode, context) {
  if (context.importMap.has(key)) return context.importMap.get(key);
  const idx = context.importNodes.length;
  context.importNodes.push(jsxNameToExprNode(nameNode));
  context.importMap.set(key, idx);
  return idx;
}

// ─── Recursive expression transformer (visits every AST child) ───────────────
//
// This function recursively walks any AST node and replaces every JSXElement
// and JSXFragment with a compiled JSXRoot object (i.e. it treats the JSX as
// appearing in a *value* context). It is used for:
//   • Transforming the whole file (Program node)
//   • Transforming dynamic expressions inside props and children
//
// It ONLY descends into properties that are real AST nodes (have a .type) or
// arrays. Metadata objects like `loc` are automatically skipped because they
// lack a .type field. This makes the traversal safe and future-proof.

function transformExpression(node, state) {
  if (node == null || typeof node !== "object") return node;

  if (Array.isArray(node))
    return node.map((n) => transformExpression(n, state));

  if (typeof node.type !== "string") return node; // skip metadata (loc, …)

  // ── JSX boundary → compile to a full JSXRoot ─────────────────────────────
  if (node.type === "JSXElement" || node.type === "JSXFragment") {
    return compileJSXValue(node, state);
  }

  // ── Generic non‑JSX node: shallow clone, then recurse into children ──────
  const cloned = { ...node };
  for (const key of Object.keys(cloned)) {
    const child = cloned[key];
    if (child != null && typeof child === "object") {
      if (Array.isArray(child)) {
        cloned[key] = child.map((item) => transformExpression(item, state));
      } else if (child.type) {
        cloned[key] = transformExpression(child, state);
      }
      // else: leave non‑AST objects (like loc) untouched
    }
  }
  return cloned;
}

// ─── Props processing ────────────────────────────────────────────────────────
//
// Returns an acorn ObjectExpression node (or null literal) representing
//   { spreads: [idx…], props: { name: literal|idx } }

function processProps(attributes, context, state) {
  if (!attributes.length) return literal(null);

  const propsProperties = [];
  const spreadIndices = [];

  for (const attr of attributes) {
    // { ...expr }
    if (attr.type === "JSXSpreadAttribute") {
      const idx = context.values.length;
      context.values.push(transformExpression(attr.argument, state));
      spreadIndices.push(literal(idx));
      continue;
    }
    if (attr.type !== "JSXAttribute") continue;

    const name =
      attr.name.type === "JSXNamespacedName"
        ? `${attr.name.namespace.name}:${attr.name.name.name}`
        : attr.name.name;

    if (attr.value === null) {
      // Boolean shorthand: disabled
      propsProperties.push(property(literal(name), literal(true)));
    } else if (attr.value.type === "Literal") {
      propsProperties.push(property(literal(name), attr.value));
    } else if (attr.value.type === "JSXExpressionContainer") {
      const expr = attr.value.expression;
      if (expr.type === "JSXEmptyExpression") {
        propsProperties.push(property(literal(name), literal(true)));
      } else if (expr.type === "Literal") {
        // {true}, {0}, {"str"}, {null}
        propsProperties.push(property(literal(name), expr));
      } else {
        // Dynamic expression – put into values[]
        const idx = context.values.length;
        context.values.push(transformExpression(expr, state));
        propsProperties.push(property(literal(name), literal(idx)));
      }
    }
  }

  if (!propsProperties.length && !spreadIndices.length) return literal(null);

  return objectExpression([
    property(identifier("spreads"), arrayExpression(spreadIndices)),
    property(identifier("props"), objectExpression(propsProperties)),
  ]);
}

// ─── Children processing ─────────────────────────────────────────────────────
//
// Returns an array of AST nodes ready to be placed inside the dom tuple's
// children array.

function processChildren(children, context, state) {
  const result = [];

  for (const child of children) {
    // Static text
    if (child.type === "JSXText") {
      result.push(literal(child.value));
      continue;
    }

    // {expression}
    if (child.type === "JSXExpressionContainer") {
      const expr = child.expression;
      if (expr.type === "JSXEmptyExpression") continue;

      // React‑ignored values
      if (
        (expr.type === "Literal" &&
          (expr.value === true ||
            expr.value === false ||
            expr.value === null)) ||
        (expr.type === "Identifier" && expr.name === "undefined")
      )
        continue;

      const idx = context.values.length;
      context.values.push(transformExpression(expr, state));
      result.push(literal(idx));
      continue;
    }

    // {...spread} child
    if (child.type === "JSXSpreadChild") {
      const idx = context.values.length;
      context.values.push(transformExpression(child.expression, state));
      result.push(literal(idx));
      continue;
    }

    // Static JSX child → share parent context, produce a tuple
    if (child.type === "JSXElement" || child.type === "JSXFragment") {
      result.push(processJSXElement(child, context, state));
    }
  }
  return result;
}

// ─── Element → tuple ──────────────────────────────────────────────────────────
//
// Builds the [tag, props, children?] array expression for a JSX element/fragment.

function processJSXElement(node, context, state) {
  let tagNode;

  if (node.type === "JSXFragment") {
    tagNode = literal(null);
  } else {
    const tagName = node.openingElement.name;
    if (tagName.type === "JSXIdentifier") {
      const name = tagName.name;
      tagNode = isIntrinsic(name)
        ? literal(name)
        : literal(getOrAddImport(name, tagName, context));
    } else if (tagName.type === "JSXMemberExpression") {
      const key = jsxMemberExprToKey(tagName);
      tagNode = literal(getOrAddImport(key, tagName, context));
    } else {
      // Namespaced or unknown
      tagNode = literal(null);
    }
  }

  const attributes =
    node.type === "JSXElement" ? node.openingElement.attributes : [];
  const propsNode = processProps(attributes, context, state);
  const childrenNodes = processChildren(node.children, context, state);

  const elements = [tagNode, propsNode];
  if (childrenNodes.length > 0) elements.push(arrayExpression(childrenNodes));

  return arrayExpression(elements);
}

// ─── Compile a JSX node into a full JSXRoot object (value context) ───────────

function compileJSXValue(jsxNode, state) {
  const context = {
    values: [],
    importNodes: [],
    importMap: new Map(),
    key: generateKey(jsxNode, state),
  };

  const domTuple = processJSXElement(jsxNode, context, state);

  return objectExpression([
    property(identifier("key"), literal(context.key)),
    property(identifier("imports"), arrayExpression(context.importNodes)),
    property(identifier("values"), arrayExpression(context.values)),
    property(identifier("dom"), domTuple),
  ]);
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Compile a JSX/TSX source string into a plain JavaScript string
 * where every JSX element has been replaced by a JSXRoot object literal.
 *
 * @param {string} code   Source code
 * @param {object} [opts] Options
 * @param {string} [opts.filename='unknown']  Used for stable key generation
 * @returns {string} Transformed code
 */
function compile(code, opts = {}) {
  const filename = opts.filename || "unknown";
  const parser = acorn.Parser.extend(jsx({ allowNamespaces: true }));

  const ast = parser.parse(code, {
    sourceType: "module",
    ecmaVersion: "latest",
    locations: true,
  });

  const state = { filename };
  const newAST = transformExpression(ast, state);

  // astring might add a trailing newline – trim if desired
  return astring.generate(newAST);
}

module.exports = compile;
