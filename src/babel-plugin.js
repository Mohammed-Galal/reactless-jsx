/**
 * Babel plugin — JSX → JSXRoot compiler.
 *
 * Output shapes
 * ─────────────
 * JSXRoot  : { key, imports, values, dom }
 * Tuple    : [tag, props, children?]
 * Props    : { spreads: number[], props: { [name]: staticLiteral | valueIndex } }
 *
 * Architectural guarantee
 * ───────────────────────
 * transformNodeJSX(node) walks any AST subtree generically — no hardcoded
 * expression type list. It recurses **only** into the official AST children
 * defined by Babel’s `VISITOR_KEYS`, never into metadata (loc, extra, comments, …).
 * This makes the compiler immune to internal Babel changes, cyclic metadata,
 * and new ECMAScript syntax – all future node types are handled automatically.
 *
 * Verification: after compilation, traversing the entire output AST must find
 * 0 JSXElement nodes and 0 JSXFragment nodes.
 */
module.exports = function ({ types: t }) {
  // ── Stable key (source‑location based, deterministic across server + client) ─
  function generateKey(node, state) {
    const filename = state.file.opts.filename || "unknown";
    const loc = node.loc;
    const line = loc ? loc.start.line : 0;
    const col = loc ? loc.start.column : 0;
    return `${filename}#${line}:${col}`;
  }

  // ── Tag helpers ──────────────────────────────────────────────────────────────
  function isIntrinsic(name) {
    return name[0] === name[0].toLowerCase();
  }

  // Derive a string key from a JSXMemberExpression by walking the AST —
  // never slices raw source text (fix for TypeScript generics, synthetic nodes).
  function jsxMemberExprToKey(node) {
    if (t.isJSXIdentifier(node)) return node.name;
    if (t.isJSXMemberExpression(node))
      return `${jsxMemberExprToKey(node.object)}.${node.property.name}`;
    return node.type;
  }

  // Convert JSX-specific name nodes to regular JS expression nodes.
  function jsxNameToExprNode(nameNode) {
    if (t.isJSXIdentifier(nameNode)) return t.identifier(nameNode.name);
    if (t.isJSXMemberExpression(nameNode))
      return t.memberExpression(
        jsxNameToExprNode(nameNode.object),
        t.identifier(nameNode.property.name),
      );
    throw new Error(`Unsupported JSX name node type: "${nameNode.type}"`);
  }

  // ── Import table ─────────────────────────────────────────────────────────────
  function getOrAddImport(key, nameNode, context) {
    if (context.importMap.has(key)) return context.importMap.get(key);
    const idx = context.importNodes.length;
    context.importNodes.push(jsxNameToExprNode(nameNode));
    context.importMap.set(key, idx);
    return idx;
  }

  // ── Generic recursive JSX transformer ────────────────────────────────────────
  //
  // This is the architectural core of the compiler.
  //
  // Instead of enumerating every possible expression node type, it walks the
  // AST using `t.VISITOR_KEYS[node.type]` – the canonical list of child
  // properties for each node. This guarantees:
  //   • Only real AST children are traversed (not loc, extra, comments, …)
  //   • No risk of infinite loops from cyclic metadata
  //   • Future node types are automatically handled, with zero code changes
  //
  // The recursion terminates because:
  //   • Primitives (string, number, boolean, null, undefined) are returned immediately.
  //   • Non-AST objects (no .type) are returned immediately.
  //   • JSX nodes are replaced with compiled ObjectExpressions and the recursion stops.
  //   • All other nodes eventually reach leaves that satisfy one of the above.
  //
  // After transformNodeJSX(expr):
  //   • No JSXElement or JSXFragment remains anywhere in the returned tree.
  //   • All other AST structure is preserved with no semantic change.

  // Helper for transforming a single child (could be a node or an array of nodes)
  function transformChild(value, state) {
    if (Array.isArray(value)) {
      return value.map((item) => transformNodeJSX(item, state));
    }
    return transformNodeJSX(value, state);
  }

  function transformNodeJSX(node, state) {
    // Terminals: primitives, null, undefined
    if (node == null || typeof node !== "object") return node;

    // Arrays: transform each element
    if (Array.isArray(node))
      return node.map((item) => transformNodeJSX(item, state));

    // Non-AST objects (no .type) – e.g. loc, extra, raw comments – leave untouched
    if (typeof node.type !== "string") return node;

    // JSX boundary – compile into a self-contained JSXRoot
    if (t.isJSXElement(node) || t.isJSXFragment(node)) {
      return compileJSXValue(node, state);
    }

    // Generic non-JSX AST node: shallow-clone, then recurse **only** into
    // the properties declared in VISITOR_KEYS
    const result = t.cloneNode(node, false);

    const visitorKeys = t.VISITOR_KEYS[node.type] || [];
    for (const key of visitorKeys) {
      result[key] = transformChild(result[key], state);
    }

    return result;
  }

  // ── Props ────────────────────────────────────────────────────────────────────
  //
  // Output shape:
  //   null                                    → no attributes at all
  //   { spreads: [i,j], props: {k:v|idx} }   → spreads and/or named props
  //
  // spreads  Each {...spread} argument is stored in values[] and its index is
  //          pushed to the spreads array. The renderer applies them in order
  //          before the named props.
  //
  // props    Static literals (boolean, string, number, null) are stored inline.
  //          Dynamic expressions are stored in values[] via transformNodeJSX
  //          and the prop entry holds the numeric index.
  //          Importantly, JSX passed as a prop value (e.g. icon={<Icon />}) is
  //          handled correctly because transformNodeJSX processes it generically.

  function processProps(attributes, context, state) {
    if (!attributes.length) return t.nullLiteral();

    const propsProperties = [];
    const spreadIndices = [];

    for (const attr of attributes) {
      // ── {...spread} ─────────────────────────────────────────────────────────
      if (t.isJSXSpreadAttribute(attr)) {
        const idx = context.values.length;
        context.values.push(transformNodeJSX(attr.argument, state));
        spreadIndices.push(t.numericLiteral(idx));
        continue;
      }

      if (!t.isJSXAttribute(attr)) continue;

      // ── attribute name: handles xml:lang, xlink:href, etc. ─────────────────
      const name = t.isJSXNamespacedName(attr.name)
        ? `${attr.name.namespace.name}:${attr.name.name.name}`
        : attr.name.name;

      // ── attribute value ──────────────────────────────────────────────────────
      if (attr.value === null) {
        // Shorthand boolean: <input disabled />
        propsProperties.push(
          t.objectProperty(t.stringLiteral(name), t.booleanLiteral(true)),
        );
      } else if (t.isStringLiteral(attr.value)) {
        // Direct string: className="foo"
        propsProperties.push(
          t.objectProperty(t.stringLiteral(name), t.cloneNode(attr.value)),
        );
      } else if (t.isJSXExpressionContainer(attr.value)) {
        const expr = attr.value.expression;

        if (t.isJSXEmptyExpression(expr)) {
          propsProperties.push(
            t.objectProperty(t.stringLiteral(name), t.booleanLiteral(true)),
          );
        } else if (t.isBooleanLiteral(expr)) {
          // disabled={false} — static, no values slot needed
          propsProperties.push(
            t.objectProperty(
              t.stringLiteral(name),
              t.booleanLiteral(expr.value),
            ),
          );
        } else if (t.isStringLiteral(expr)) {
          // className={"foo"} — unwrap the expression container
          propsProperties.push(
            t.objectProperty(t.stringLiteral(name), t.cloneNode(expr)),
          );
        } else if (t.isNumericLiteral(expr)) {
          propsProperties.push(
            t.objectProperty(
              t.stringLiteral(name),
              t.numericLiteral(expr.value),
            ),
          );
        } else if (t.isNullLiteral(expr)) {
          propsProperties.push(
            t.objectProperty(t.stringLiteral(name), t.nullLiteral()),
          );
        } else {
          // Any other expression — including JSX (e.g. icon={<Icon />}),
          // ObjectExpression (style={{ color }}), function expressions, etc.
          // transformNodeJSX handles all of them generically.
          const idx = context.values.length;
          context.values.push(transformNodeJSX(expr, state));
          propsProperties.push(
            t.objectProperty(t.stringLiteral(name), t.numericLiteral(idx)),
          );
        }
      }
      // JSXElement as attribute value (invalid JSX) — silently ignored.
    }

    const hasProps = propsProperties.length > 0;
    const hasSpreads = spreadIndices.length > 0;
    if (!hasProps && !hasSpreads) return t.nullLiteral();

    // Both keys always present when non-null — predictable shape for the renderer.
    return t.objectExpression([
      t.objectProperty(
        t.identifier("spreads"),
        t.arrayExpression(spreadIndices),
      ),
      t.objectProperty(
        t.identifier("props"),
        t.objectExpression(propsProperties),
      ),
    ]);
  }

  // ── Children ─────────────────────────────────────────────────────────────────
  function processChildren(children, context, state) {
    const result = [];

    for (const child of children) {
      // Static text node
      if (t.isJSXText(child)) {
        if (child.value.trim() === "") continue;
        result.push(t.stringLiteral(child.value.replace(/^\s+|\s+$/g, " ")));
        continue;
      }

      // Dynamic expression: {expr}
      if (t.isJSXExpressionContainer(child)) {
        const expression = child.expression;
        if (t.isJSXEmptyExpression(expression)) continue;

        // Render-nothing values — discard at compile time
        if (
          t.isBooleanLiteral(expression) ||
          t.isNullLiteral(expression) ||
          (t.isIdentifier(expression) && expression.name === "undefined")
        )
          continue;

        // transformNodeJSX handles everything else:
        //   • A bare JSXElement/JSXFragment  → compileJSXValue (new JSXRoot)
        //   • A ternary / logical / call     → recursed into, JSX compiled wherever found
        //   • A plain identifier / function call / await / … → cloned as-is
        // No expression type needs to be listed here.
        const idx = context.values.length;
        context.values.push(transformNodeJSX(expression, state));
        result.push(t.numericLiteral(idx));
        continue;
      }

      // Spread child: {...expr}
      if (t.isJSXSpreadChild(child)) {
        const idx = context.values.length;
        context.values.push(transformNodeJSX(child.expression, state));
        result.push(t.numericLiteral(idx));
        continue;
      }

      // Static JSX child — compiled directly to a tuple in the parent's IR.
      if (t.isJSXElement(child) || t.isJSXFragment(child)) {
        result.push(processJSXElement(child, context, state));
      }
    }

    return result;
  }

  // ── Element → tuple ──────────────────────────────────────────────────────────
  function processJSXElement(node, context, state) {
    let tagNode;

    if (t.isJSXFragment(node)) {
      tagNode = t.nullLiteral();
    } else {
      const tagName = node.openingElement.name;
      if (t.isJSXIdentifier(tagName)) {
        const name = tagName.name;
        tagNode = isIntrinsic(name)
          ? t.stringLiteral(name)
          : t.numericLiteral(getOrAddImport(name, tagName, context));
      } else if (t.isJSXMemberExpression(tagName)) {
        const key = jsxMemberExprToKey(tagName);
        tagNode = t.numericLiteral(getOrAddImport(key, tagName, context));
      } else {
        // Namespaced element or unknown — not a renderable component
        tagNode = t.nullLiteral();
      }
    }

    const attributes = t.isJSXFragment(node)
      ? []
      : node.openingElement.attributes;
    const propsNode = processProps(attributes, context, state);
    const childrenNodes = processChildren(node.children, context, state);

    const elements = [tagNode, propsNode];
    if (childrenNodes.length > 0)
      elements.push(t.arrayExpression(childrenNodes));

    return t.arrayExpression(elements);
  }

  // ── JSXRoot ───────────────────────────────────────────────────────────────────
  //
  // Compiles a JSX node into a self-contained JSXRoot object with its own
  // isolated context (values[], importNodes[]). This is called:
  //   • By the outer Babel visitor for top-level JSX.
  //   • By transformNodeJSX whenever it encounters JSX inside an expression tree.
  //
  // Mutual recursion:  compileJSXValue → processJSXElement → processChildren
  //                    → transformNodeJSX → compileJSXValue (for nested JSX)
  // This is bounded because each recursive compileJSXValue call processes a
  // strictly smaller JSX node.

  function compileJSXValue(jsxNode, state) {
    const context = {
      values: [],
      importNodes: [],
      importMap: new Map(),
      key: generateKey(jsxNode, state),
    };

    const domTuple = processJSXElement(jsxNode, context, state);

    return t.objectExpression([
      t.objectProperty(t.identifier("key"), t.stringLiteral(context.key)),
      t.objectProperty(
        t.identifier("imports"),
        t.arrayExpression(context.importNodes),
      ),
      t.objectProperty(
        t.identifier("values"),
        t.arrayExpression(context.values),
      ),
      t.objectProperty(t.identifier("dom"), domTuple),
    ]);
  }

  // ── Visitor ───────────────────────────────────────────────────────────────────
  //
  // The visitor catches every JSXElement and JSXFragment that is NOT a static
  // child of another JSX element (static children are handled recursively inside
  // processJSXElement). This covers:
  //
  //   • Top-level JSX expressions          export default <App />
  //   • JSX in variable declarations       const el = <div />
  //   • JSX in return statements           return <footer>{count}</footer>
  //   • JSX in function declarations       function render() { return <X /> }
  //   • JSX in assignment expressions      el = <div />
  //   • JSX inside if / switch / loops     if (x) return <A />
  //   • JSX in default parameters          function f(el = <div />) {}
  //   … and any other non-JSX-child position the parser can produce.
  //
  // After path.replaceWith + path.skip(), Babel does not traverse into the
  // compiled JSXRoot, so the visitor never processes the same JSX twice.
  //
  // Dynamic JSX that appears INSIDE expression trees (ternaries, maps, objects,
  // arrays, etc.) is handled by transformNodeJSX within processChildren and
  // processProps — the visitor never sees those because Babel enters their
  // outermost JSX ancestor first and path.skip() prevents further descent.

  return {
    visitor: {
      JSXElement(path, state) {
        if (path.findParent((p) => p.isJSXElement() || p.isJSXFragment()))
          return;
        path.replaceWith(compileJSXValue(path.node, state));
        path.skip();
      },

      JSXFragment(path, state) {
        if (path.findParent((p) => p.isJSXElement() || p.isJSXFragment()))
          return;
        path.replaceWith(compileJSXValue(path.node, state));
        path.skip();
      },
    },
  };
};
