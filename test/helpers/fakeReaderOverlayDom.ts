/**
 * A fake reader document for the Inline Ask overlay tests: the same shape as
 * the one in readerSelectionPromptOverlay.test.ts (inline styles parsed from
 * cssText, bubbling events, a pointerdown target on the document, nested
 * view iframes), plus text nodes and a textContent that, like the DOM,
 * replaces the children when set.
 */

type Listener = (e: any) => void;

export type FakeOverlayNode = any;

function camel(name: string): string {
  return name.trim().replace(/-([a-z])/g, (_m, c) => c.toUpperCase());
}

function makeStyle() {
  const st: any = {};
  Object.defineProperty(st, "cssText", {
    set(v: string) {
      for (const pair of v.split(";")) {
        const i = pair.indexOf(":");
        if (i > 0) st[camel(pair.slice(0, i))] = pair.slice(i + 1).trim();
      }
    },
  });
  return st;
}

function dispatchOn(node: any, t: string, e: any = {}) {
  const ev = {
    type: t,
    target: node,
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation() {
      this.propagationStopped = true;
    },
    ...e,
  };
  for (let n: any = node; n; n = n.parentNode) {
    for (const fn of [...(n._listeners?.get(t) || [])]) fn(ev);
    if (ev.propagationStopped) break;
  }
  return ev;
}

function matchesSelector(n: any, sel: string): boolean {
  if (n.nodeType !== 1) return false;
  const attr = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(sel);
  if (attr) {
    return attr[2] === undefined
      ? attr[1] in n.attributes
      : n.attributes[attr[1]] === attr[2];
  }
  return n.tagName === sel.toUpperCase();
}

export function makeFakeReaderDoc(
  viewport = { innerWidth: 800, innerHeight: 600 },
  options: { deferTimers?: boolean; dark?: boolean } = {},
) {
  const listeners = new Map<string, Listener[]>();
  const timers: Array<() => void> = [];
  const makeText = (text: string) => {
    const node: any = {
      nodeType: 3,
      parentNode: null as any,
      isConnected: false,
      textContent: text,
      _listeners: new Map(),
      contains(n: any) {
        return n === node;
      },
      remove() {
        node.parentNode?.removeChild(node);
      },
    };
    return node;
  };
  const makeEl = (tag: string) => {
    let ownText = "";
    const el: any = {
      nodeType: 1,
      tagName: tag.toUpperCase(),
      style: makeStyle(),
      childNodes: [] as any[],
      parentNode: null as any,
      attributes: {} as Record<string, string>,
      focused: false,
      disabled: false,
      scrollTop: 0,
      scrollHeight: 0,
      _listeners: new Map<string, Listener[]>(),
      isConnected: false,
      get children() {
        return el.childNodes.filter((c: any) => c.nodeType === 1);
      },
      get firstChild() {
        return el.childNodes[0] || null;
      },
      get textContent(): string {
        if (!el.childNodes.length) return ownText;
        return el.childNodes.map((c: any) => c.textContent).join("");
      },
      set textContent(v: string) {
        for (const c of el.childNodes) {
          c.parentNode = null;
          c.isConnected = false;
        }
        el.childNodes = [];
        ownText = v ?? "";
      },
      get innerText(): string {
        return el.textContent;
      },
      setAttribute(k: string, v: string) {
        el.attributes[k] = String(v);
      },
      getAttribute(k: string) {
        return k in el.attributes ? el.attributes[k] : null;
      },
      hasAttribute(k: string) {
        return k in el.attributes;
      },
      removeAttribute(k: string) {
        delete el.attributes[k];
      },
      append(...nodes: any[]) {
        for (const raw of nodes) {
          const n = typeof raw === "string" ? makeText(raw) : raw;
          n.parentNode?.removeChild?.(n);
          n.parentNode = el;
          n.isConnected = true;
          el.childNodes.push(n);
        }
      },
      appendChild(n: any) {
        el.append(n);
        return n;
      },
      insertBefore(n: any, ref: any) {
        if (!ref) return el.appendChild(n);
        n.parentNode?.removeChild?.(n);
        const index = el.childNodes.indexOf(ref);
        n.parentNode = el;
        n.isConnected = true;
        el.childNodes.splice(index < 0 ? el.childNodes.length : index, 0, n);
        return n;
      },
      removeChild(n: any) {
        el.childNodes = el.childNodes.filter((c: any) => c !== n);
        n.parentNode = null;
        n.isConnected = false;
        return n;
      },
      remove() {
        if (el.parentNode) el.parentNode.removeChild(el);
      },
      contains(n: any): boolean {
        if (n === el) return true;
        return el.childNodes.some((c: any) => c.contains(n));
      },
      addEventListener(t: string, fn: Listener) {
        const a = el._listeners.get(t) || [];
        a.push(fn);
        el._listeners.set(t, a);
      },
      removeEventListener(t: string, fn: Listener) {
        el._listeners.set(
          t,
          (el._listeners.get(t) || []).filter((f: Listener) => f !== fn),
        );
      },
      listenerCount(t: string) {
        return (el._listeners.get(t) || []).length;
      },
      dispatch(t: string, e: any = {}) {
        return dispatchOn(el, t, e);
      },
      click() {
        if (el.disabled) return null;
        return dispatchOn(el, "click");
      },
      focus() {
        el.focused = true;
        dispatchOn(el, "focus");
      },
      blur() {
        el.focused = false;
      },
      getBoundingClientRect() {
        return {
          width: 360,
          height: 120,
          left: 0,
          top: 0,
          right: 360,
          bottom: 120,
        };
      },
      querySelector(sel: string): any {
        return el.querySelectorAll(sel)[0] || null;
      },
      querySelectorAll(sel: string): any[] {
        const out: any[] = [];
        const walk = (n: any) => {
          if (n !== el && matchesSelector(n, sel)) out.push(n);
          for (const c of n.childNodes || []) walk(c);
        };
        walk(el);
        return out;
      },
    };
    return el;
  };
  const body = makeEl("body");
  body.isConnected = true;
  const doc: any = {
    execCommands: [] as unknown[][],
    execCommand(...args: unknown[]) {
      this.execCommands.push(args);
      return true;
    },
    body,
    documentElement: makeEl("html"),
    defaultView: {
      innerWidth: viewport.innerWidth,
      innerHeight: viewport.innerHeight,
      matchMedia: () => ({ matches: Boolean(options.dark) }),
      setTimeout(this: unknown, fn: () => void) {
        // Gecko chrome throws on an unbound window.setTimeout call.
        if (this !== doc.defaultView) throw new Error("unbound setTimeout");
        if (options.deferTimers) timers.push(fn);
        else fn();
        return 0;
      },
      clearTimeout: () => {},
    },
    createElementNS: (_ns: string, tag: string) => makeEl(tag),
    createTextNode: (text: string) => makeText(text),
    addEventListener(t: string, fn: Listener) {
      const a = listeners.get(t) || [];
      a.push(fn);
      listeners.set(t, a);
    },
    removeEventListener(t: string, fn: Listener) {
      listeners.set(
        t,
        (listeners.get(t) || []).filter((f) => f !== fn),
      );
    },
    dispatch(t: string, e: any) {
      for (const fn of [...(listeners.get(t) || [])])
        fn({ type: t, preventDefault() {}, stopPropagation() {}, ...e });
    },
    listenerCount: (t: string) => (listeners.get(t) || []).length,
    iframes: [] as any[],
    querySelectorAll(sel: string) {
      return sel === "iframe" ? this.iframes : [];
    },
    runTimers: () => {
      while (timers.length) timers.shift()!();
    },
  };
  return doc;
}

/** The text of `node` and its descendants, in order. */
export function fakeText(node: FakeOverlayNode): string {
  return node?.textContent ?? "";
}

/** True when the node and every ancestor up to `root` are not display:none. */
export function isFakeShown(node: FakeOverlayNode, root?: any): boolean {
  for (let n = node; n; n = n.parentNode) {
    if (n.style?.display === "none") return false;
    if (n === root) break;
  }
  return true;
}
