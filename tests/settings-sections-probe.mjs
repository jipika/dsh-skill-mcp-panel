/**
 * dsh-skill-mcp-panel 本地改版离线探针（无需浏览器、无需 API Key）。
 *
 * 验证目标（对应「管理入口搬进设置窗口」这次改版）：
 *   1. client.js 能加载，导出 name / inject 完整；
 *   2. 侧栏（sidebar.panellist）与中央主区（main）**零注册** —— 侧栏不再出现技能/MCP 两行；
 *   3. 设置窗口注册了两个分栏：settings.section#skills 与 settings.section#mcp，
 *      且 label 可解析为字符串（resolveSlotLabel 契约）；
 *   4. 两个分栏的组件都能在「只有 Proxy 空壳服务」的环境下渲染，不抛错。
 */
import { readFileSync } from "node:fs";

const registrations = [];

/** 任意属性访问都返回可调用空壳，嵌套访问返回同样的空壳（用于替代真实 cordis 服务面）。 */
function anyStub(label) {
  const fn = function () { return anyStub(label); };
  return new Proxy(fn, {
    get(target, key) {
      if (key === "then") return undefined;          // 避免被当成 thenable
      if (key === "toString" || key === Symbol.toStringTag) return () => label;
      if (key in target) return target[key];
      return anyStub(label + "." + String(key));
    },
    apply() { return anyStub(label + "()"); },
  });
}

function makeCtx() {
  const ctx = {
    slots: {
      inject: (_slot, run) => { try { run(); } catch (e) { errors.push("slots.inject: " + e.message); } },
      register: (options, Component) => { registrations.push({ options, Component }); return () => {}; },
    },
    locale: {
      register: () => () => {},
      bind: () => (key) => "[" + key + "]",
    },
    effect: (fn) => { try { return fn(); } catch (e) { errors.push("effect: " + e.message); } },
    on: () => () => {},
    get: () => undefined,
    inject: (deps, cb) => { try { cb(ctx); } catch (e) { errors.push("inject: " + e.message); } },
    remote: anyStub("remote"),
    sessions: anyStub("sessions"),
    layout: anyStub("layout"),
  };
  return ctx;
}

const errors = [];
let moduleExports = null;

globalThis.window = {
  __ModuleLoader__: {
    load: ({ id, factory }) => {
      const require = (spec) => {
        if (spec === "react") return makeReact();
        if (spec.endsWith("jsx-runtime")) return makeJsxRuntime();
        if (spec === "clsx" || spec === "classnames") {
          return (...args) => args.flat().filter((x) => typeof x === "string" && x).join(" ");
        }
        if (spec.includes("dsh-client-ui-primitives")) return makePrimitives();
        // 其余宿主包一律给空壳：探针只断言注册面与渲染不抛错，不验证宿主组件行为
        return anyStub("require(" + spec + ")");
      };
      moduleExports = factory(require);
      globalThis.__panelModuleId = id;
    },
  },
};

function makeReact() {
  const hookState = new Map();
  let cursor = 0;
  return {
    createElement: (type, props, ...children) => ({ __el: true, type, props: props ?? {}, children: children.flat() }),
    useState: (init) => {
      const key = cursor++;
      if (!hookState.has(key)) hookState.set(key, typeof init === "function" ? init() : init);
      return [hookState.get(key), (next) => hookState.set(key, typeof next === "function" ? next(hookState.get(key)) : next)];
    },
    useRef: (init) => ({ current: init }),
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
    useSyncExternalStore: (subscribe, getSnapshot) => {
      try { subscribe(() => {}); } catch { /* 订阅失败不影响结构断言 */ }
      return getSnapshot();
    },
    Fragment: "Fragment",
  };
}

/**
 * 宿主 UI 组件空壳：每个导出（Switch / Menu / Button / 各式 Icon …）都是一个函数组件，
 * 渲染成 div 并保留传入的 className / role，使探针既不会因缺组件抛错，仍能做结构断言。
 */
function makePrimitives() {
  const wrap = (name) => (props = {}) => {
    const children = props.children === undefined ? [] : Array.isArray(props.children) ? props.children : [props.children];
    return { __el: true, type: name, props: { ...props }, children };
  };
  return new Proxy({}, {
    get(target, key) {
      if (key === "then" || typeof key === "symbol") return undefined;
      if (!(key in target)) target[key] = wrap(String(key));
      return target[key];
    },
    has() { return true; },
  });
}

function makeJsxRuntime() {
  const react = makeReact();
  return {
    jsx: (type, props) => ({ __el: true, type, props: props ?? {}, children: [] }),
    jsxs: (type, props) => ({ __el: true, type, props: props ?? {}, children: props?.children ?? [] }),
    Fragment: "Fragment",
  };
}

/** 递归展开函数组件（含 children），得到可断言的元素树。 */
function resolve(el, depth = 0) {
  if (!el || typeof el !== "object" || !el.__el || depth > 12) return el;
  const out = typeof el.type === "function" ? resolve(el.type(el.props), depth + 1) : el;
  if (Array.isArray(out.children)) out.children = out.children.map((child) => resolve(child, depth + 1)).filter(Boolean);
  return out;
}

function walk(node, visit) {
  if (!node || typeof node !== "object") return;
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
}

// ── 1. 加载 client.js ───────────────────────────────────────────────────────
const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
new Function(source)();

const results = [];
const check = (ok, label) => { results.push({ ok, label }); };

check(moduleExports !== null, "client.js 可加载并调用 __ModuleLoader__.load");
check(typeof moduleExports?.apply === "function", "导出 apply 为函数");
check(Array.isArray(moduleExports?.inject) && moduleExports.inject.includes("slots"), "导出 inject 含 slots");

// ── 2. apply() 后检查注册面 ─────────────────────────────────────────────────
const ctx = makeCtx();
moduleExports.apply(ctx);

const byName = (name) => registrations.filter((r) => r.options.name === name);
const sidebar = byName("sidebar.panellist");
const main = byName("main");
const sections = byName("settings.section");

check(sidebar.length === 0, "侧栏零注册（sidebar.panellist 不再挂技能/MCP 两行）");
check(main.length === 0, "中央主区零注册（main 槽位不再被占用）");
check(sections.length === 2, "设置窗口注册了 2 个分栏");
check(
  sections.map((r) => r.options.id).sort().join(",") === "mcp,skills",
  "分栏 id = mcp / skills",
);
check(
  sections.every((r) => typeof r.Component === "function"),
  "两个分栏都给了可渲染组件",
);
check(
  sections.every((r) => {
    const label = typeof r.options.label === "function" ? r.options.label() : r.options.label;
    return typeof label === "string" && label.length > 0;
  }),
  "分栏 label 解析为非空字符串（resolveSlotLabel 契约）",
);

// ── 3. 分栏可渲染（Proxy 空壳服务下不抛错）─────────────────────────────────
let renderError = null;
let treeSummary = null;
try {
  const target = sections.find((r) => r.options.id === "skills");
  const face = typeof target.options.inject === "function" ? target.options.inject() : {};
  const tree = resolve(target.Component({ ...face, t: (key) => "[" + key + "]" }));
  const classNames = [];
  walk(tree, (n) => { if (n.props?.className) classNames.push(String(n.props.className)); });
  treeSummary = { rootClass: tree?.props?.className ?? null, classCount: classNames.length };
} catch (error) {
  renderError = error;
}

check(renderError === null, "「技能」分栏可渲染" + (renderError ? " — " + renderError.message : ""));
check(treeSummary?.rootClass === "SKV_setPage", "分栏根元素用设置外壳类 SKV_setPage（无返回箭头）");
check(errors.length === 0, "apply() 期间无副作用异常" + (errors.length ? " — " + errors[0] : ""));

// ── 输出 ────────────────────────────────────────────────────────────────────
const pad = (s, n) => String(s) + " ".repeat(Math.max(0, n - String(s).length));
console.log("dsh-skill-mcp-panel 本地改版探针");
console.log("─".repeat(64));
registrations.forEach((r, i) => {
  const label = typeof r.options.label === "function" ? r.options.label() : r.options.label;
  console.log(`  注册#${i + 1}  ${r.options.name}#${r.options.id}  order=${r.options.order ?? "-"}  label=${label}`);
});
console.log("─".repeat(64));
for (const { ok, label } of results) console.log(`  ${ok ? "✅" : "❌"} ${label}`);
const failed = results.filter((r) => !r.ok).length;
console.log("─".repeat(64));
console.log(`结果: ${results.length - failed} 通过, ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
