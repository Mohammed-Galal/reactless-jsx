import React, {
  useState,
  useEffect,
  useMemo,
  useCallback,
  useRef,
  Fragment,
} from "react";

const uui = (
  <p>
    Lorem ipsum dolor sit amet, consectetur adipisicing elit. Vitae, illo!
    Voluptas, nostrum asperiores eveniet doloribus voluptatibus ducimus aut
    vitae reprehenderit officia molestias reiciendis repudiandae maxime suscipit
    architecto labore sequi illo?
  </p>
);

// Dummy components
const Button = ({ children, onClick, style }) => (
  <button style={style} onClick={onClick}>
    {children}
  </button>
);

const List = {
  Item({ item }) {
    return <li>{item}</li>;
  },
};

export default function JSXShowcase() {
  // State
  const [count, setCount] = useState(0);
  const [input, setInput] = useState("");
  const [items, setItems] = useState(["Apple", "Banana", "Orange"]);

  // Ref
  const inputRef = useRef(null);

  // Effect
  useEffect(() => {
    console.log("Component mounted or updated");
    return () => console.log("Cleanup");
  }, [count]);

  // Memoized value
  const doubled = useMemo(() => count * 2, [count]);

  // Callback
  const handleAdd = useCallback(() => {
    if (input.trim()) {
      setItems((prev) => [...prev, input]);
      setInput("");
      inputRef.current.focus();
    }
  }, [input]);

  // Inline styles
  const styles = {
    container: { padding: "20px", fontFamily: "Arial" },
    title: { color: "teal" },
    highlight: { color: "red", fontWeight: "bold" },
  };

  return (
    <div style={styles.container}>
      {/*_ 1. Basic JSX _*/}
      <h1 style={styles.title}>JSX Showcase</h1>

      {/* 2. Expressions */}
      <p>Count: {count}</p>
      <p>Doubled: {doubled}</p>

      {/* 3. Conditional Rendering */}
      {count > 5 ? (
        <p style={styles.highlight}>Count is greater than 5</p>
      ) : (
        <p>Count is small</p>
      )}

      {/* 4. Logical AND */}
      {count === 0 && <p>Count is zero</p>}

      {/* 5. Event Handling */}
      <Button onClick={() => setCount(count + 1)}>Increment</Button>
      <Button onClick={() => setCount(count - 1)}>Decrement</Button>

      {/* 6. Forms & Controlled Inputs */}
      <div>
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Add item"
        />
        <Button onClick={handleAdd}>Add</Button>
      </div>

      {/* 7. Lists & Keys */}
      <ul>
        {items.map((item, index) => (
          <List.Item key={index} item={item} />
        ))}
      </ul>

      {/* 8. Fragments */}
      <Fragment>
        <p>Fragment Line 1</p>
        <p>Fragment Line 2</p>
      </Fragment>

      {/* Short Fragment */}
      <>
        <p>Short Fragment 1</p>
        <p>Short Fragment 2</p>
      </>

      {/* 9. Inline Functions */}
      <p onClick={() => alert("Clicked!")}>Click me</p>

      {/* 10. Dynamic Attributes */}
      <img
        src="https://via.placeholder.com/100"
        alt="placeholder"
        width={100}
        height={100}
      />

      {/* 11. Spread Props */}
      <Button {...{ style: { backgroundColor: "black", color: "white" } }}>
        Spread Props Button
      </Button>

      {/* 12. Children */}
      <Button>
        <span>Nested JSX Child</span>
      </Button>

      {/* 13. Self-closing tags */}
      <hr />

      {/* 14. dangerouslySetInnerHTML */}
      <div
        dangerouslySetInnerHTML={{
          __html: "<strong>Injected HTML</strong>",
        }}
      />

      {/* 15. Ternary inside attribute */}
      <p style={{ color: count % 2 === 0 ? "blue" : "green" }}>Dynamic color</p>

      {/* 16. Function returning JSX */}
      {renderFooter(count)}
    </div>
  );
}

// Helper function returning JSX
function renderFooter(count) {
  return (
    <footer>
      <p>Footer count: {count}</p>
    </footer>
  );
}
