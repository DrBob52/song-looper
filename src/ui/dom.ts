type Child = Node | string | null | undefined | false;

export interface HProps {
  class?: string;
  text?: string;
  html?: string;
  attrs?: Record<string, string | number | boolean | undefined>;
  style?: Partial<CSSStyleDeclaration> & Record<string, string>;
  on?: { [K in keyof HTMLElementEventMap]?: (ev: HTMLElementEventMap[K]) => void };
  props?: Record<string, unknown>;
}

/** Tiny typed element builder: h('button', { class: 'btn', text: 'Go' }, [child, ...]). */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: HProps = {},
  children: Child[] = [],
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props.class) el.className = props.class;
  if (props.text !== undefined) el.textContent = props.text;
  if (props.html !== undefined) el.innerHTML = props.html;
  if (props.attrs) {
    for (const [k, v] of Object.entries(props.attrs)) {
      if (v === undefined || v === false) continue;
      el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  if (props.style) {
    for (const [k, v] of Object.entries(props.style)) {
      if (k.startsWith('--')) el.style.setProperty(k, String(v));
      else (el.style as unknown as Record<string, string>)[k] = String(v);
    }
  }
  if (props.props) Object.assign(el, props.props);
  if (props.on) {
    for (const [k, fn] of Object.entries(props.on)) {
      el.addEventListener(k, fn as EventListener);
    }
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
