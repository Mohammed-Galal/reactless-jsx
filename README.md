# reactless-jsx — Mechanism & Examples

`reactless-jsx` compiles **every** JSX element and fragment into a plain JavaScript object called a **JSXRoot**.  
No React, no virtual DOM library, no runtime imports – just pure data.

---

## 1. The JSXRoot output format

```ts
type JSXRoot = {
  key:     string;          // stable, location‑based ID
  imports: any[];           // component references used as tags
  values:  any[];           // flat list of ALL dynamic expressions
  dom:     JSXRootNode;     // the static tree with placeholders
};

// Inside the tree
type JSXRootNode = [tag, props, children?];

type JSXChildNode = string | number | JSXRootNode;
//  - string       = static text
//  - number       = index into the current root's `values` array
//  - JSXRootNode  = nested static child element tuple

// Props are either:
//   null   → no attributes
//   object → { spreads: number[], props: { name: literal | valueIdx } }
```

---

## 2. Two contexts, one compilation

JSX can appear in **two places** – the compiler handles them differently:

| Context | Example | Output |
|---------|---------|--------|
| **Static child** of another element | `<div><span /></div>` | The `<span />` becomes a **nested tuple** inside the parent’s `dom`. It shares the parent’s `values` and `imports`. |
| **Expression value** (prop, `{…}` child, ternary, `map()`, arrow body, etc.) | `{items.map(i => <li />)}` | The JSX becomes a **full JSXRoot object** with its own `values`, `imports`, and `dom`. That object is stored in the enclosing root’s `values` array. |

This distinction is crucial:  
- Static children stay **inline** (no extra object, no extra `values` slot).  
- Dynamic children are **hoisted** into `values[]` as self‑contained JSXRoot objects.

---

## 3. How the compiler walks the AST

The compiler uses a **generic recursive transformer** that visits **every** ESTree AST node.  
It never relies on a hardcoded list of expression types – instead it:

1. Checks if the node is a `JSXElement` / `JSXFragment`.  
   → Compile it into a `JSXRoot` (value context) or a tuple (static child context).

2. For all other AST nodes, it **shallow‑clones** the node and recursively processes **only** the official AST child properties.  
   (Metadata like `loc`, `comments`, `extra` are ignored because they lack a `.type` field.)

This guarantees that **no JSX can hide** inside a ternary, logical expression, callback, object literal, or any future JavaScript syntax – the recursion always finds it.

---

## 4. Detailed transformation rules

### 4.1 `key` generation
A stable string is derived from the source filename, line, and column.  
This ensures the key remains the same across repeated compiles (unless the code moves).

### 4.2 Tag handling
- Intrinsic HTML element (`<div>`, `<span>`) → a **string literal** `"div"`.
- Custom component (`<MyButton>`) → **numeric index** into the current root’s `imports` array.
- Member expression (`<Context.Consumer>`) → index into `imports` (the full dotted path is stored).
- Fragment `<></>` → **`null`** tag.
- Named fragment `<Fragment>` (imported from React) → treated as a component, index into `imports`.

### 4.3 Props
- Static values (`id="main"`, `disabled`) → stored directly in the `props` object.
- Dynamic values (`onClick={handler}`) → the expression is pushed to `values[]` and replaced by its index.
- Spread attributes `{...obj}` → each spread is pushed to `values[]`, and the indices are collected into a `spreads` array. The resulting props object always has both `spreads` and `props` keys (even if one is empty), for predictable runtime merging.

### 4.4 Children
- Static text → string literal.
- `{expression}`:
  - Comments `{/* … */}` → **discarded**.
  - `true`, `false`, `null`, `undefined` → **discarded** (React‑ignored).
  - JSX expression → compiled into a **JSXRoot** object and referenced by index.
  - Any other expression → pushed to `values[]`, referenced by index.
- Static JSX child → recursively processed into a **tuple** inside the parent.
- Spread child `{...expr}` → pushed to `values[]`, referenced by index.

---

## 5. Before / After examples

### 5.1 Simple static element

**Input:**
```jsx
<div className="box">Hello</div>
```

**Output:**
```js
({
  key: "App.jsx#3:10",
  imports: [],
  values: [],
  dom: ["div", { spreads: [], props: { "className": "box" } }, ["Hello"]]
})
```

### 5.2 Dynamic expression children

**Input:**
```jsx
<p>Count: {count}</p>
```

**Output:**
```js
({
  key: "App.jsx#5:12",
  imports: [],
  values: [count],
  dom: ["p", null, ["Count: ", 0]]
})
```
The variable `count` is lifted into `values[0]`, and the child placeholder is the number `0`.

### 5.3 Conditionals and logical expressions

**Input:**
```jsx
{count > 0 && <p>Positive</p>}
{error ? <Alert /> : null}
```

**Output (outer root shown):**
```js
({
  values: [
    count > 0 && ({
      key: "...",
      imports: [],
      values: [],
      dom: ["p", null, ["Positive"]]
    }),
    error ? ({
      key: "...",
      imports: [Alert],
      values: [],
      dom: [0, null]
    }) : null
  ],
  dom: [null, null, [0, 1]]   // ← parent is a fragment (tag null)
})
```
Each branch’s JSX becomes a separate `JSXRoot` embedded in the surrounding `values`.

### 5.4 Component with props

**Input:**
```jsx
<Button onClick={handleClick} style={btnStyle}>
  Click me
</Button>
```

**Output:**
```js
({
  key: "...",
  imports: [Button],
  values: [handleClick, btnStyle],
  dom: [0, {
    spreads: [],
    props: { "onClick": 0, "style": 1 }
  }, ["Click me"]]
})
```

### 5.5 Fragments

**Input:**
```jsx
<>
  <span>A</span>
  <span>B</span>
</>
```

**Output:**
```js
({
  key: "...",
  imports: [],
  values: [],
  dom: [null, null, [
    ["span", null, ["A"]],
    ["span", null, ["B"]]
  ]]
})
```

### 5.6 List rendering (map)

**Input:**
```jsx
<ul>
  {items.map(item => <li key={item.id}>{item.name}</li>)}
</ul>
```

**Output (simplified):**
```js
({
  key: "...",
  imports: [],
  values: [
    items.map(item => ({
      key: "...",
      imports: [],
      values: [item.id, item.name],
      dom: ["li", { spreads: [], props: { key: 0 } }, [1]]
    }))
  ],
  dom: ["ul", null, [0]]
})
```
The arrow function body is recursively compiled; the whole `.map()` call is one `values` entry.

### 5.7 Deeply nested JSX

**Input:**
```jsx
<div>
  {x ? <a>{y && <b><c/></b>}</a> : <d/>}
</div>
```

All nested JSX (`<a>`, `<b>`, `<c/>`, `<d/>`) are compiled into their respective `JSXRoot` objects deep inside the outer root’s `values`. The generic AST walker reaches every one of them.

---

## 6. Using reactless-jsx

### As a Babel plugin

1. Install:
   ```bash
   npm install reactless-jsx
   ```

2. Add to your Babel config (`babel.config.json`):
   ```json
   {
     "plugins": ["reactless-jsx"]
   }
   ```

3. Run Babel; your JSX will be replaced by `JSXRoot` objects.

### Standalone (acorn‑based)

```js
const compile = require('reactless-jsx/standalone');
const code = compile('<div>hello</div>', { filename: 'demo.jsx' });
console.log(code);
```

---

## 7. Guarantees & limitations

- **Every JSX node** in the input is guaranteed to be compiled, no matter how deeply nested inside expressions.
- Comments are stripped; `true`/`false`/`null`/`undefined` children are removed.
- Dynamic tag names (variables) are **not** supported and will throw a compile error.
- Namespaced JSX (`<ns:tag>`) is not supported.
- The output is **not** React – you need a custom renderer that understands the `JSXRoot` format.

This document explains the mechanism, the two-context compilation, the generic recursive traversal, and illustrates every major JSX pattern with before/after outputs.
