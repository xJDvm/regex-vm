import { type GraphEdge, type GraphLayout, type GraphNode, NODE_HEIGHT, NODE_WIDTH } from "./graph.ts";

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * Replaces the content of an SVG element with the drawing of a graph layout. Arcs are drawn first, so the boxes lie on
 * top of them. The `viewBox` lets the drawing scale to the width of its container.
 *
 * @param svg - The `<svg>` element to fill.
 * @param layout - The layout to draw, from `layoutGraph`.
 */
export function drawGraph(svg: SVGSVGElement, layout: GraphLayout): void {
  svg.setAttribute("viewBox", `0 0 ${layout.width} ${layout.height}`);
  const fragment = document.createDocumentFragment();
  fragment.append(arrowMarker());
  for (const edge of layout.edges) fragment.append(edgePath(edge));
  for (const node of layout.nodes) fragment.append(nodeBox(node));
  svg.replaceChildren(fragment);
}

/**
 * Marks the boxes of the instructions in `active`, and the arcs that leave them, as active. Every other box and arc
 * loses the mark. Call it after {@link drawGraph}.
 *
 * @param svg - The drawing produced by {@link drawGraph}.
 * @param active - Program counters of the threads of the current step.
 */
export function highlightGraph(svg: SVGSVGElement, active: ReadonlySet<number>): void {
  for (const node of svg.querySelectorAll<SVGGElement>(".node")) {
    node.classList.toggle("active", active.has(Number(node.dataset.pc)));
  }
  for (const edge of svg.querySelectorAll<SVGPathElement>(".edge")) {
    edge.classList.toggle("active", active.has(Number(edge.dataset.from)));
  }
}

/** Creates an SVG element and sets its attributes. */
function svgElement<K extends "defs" | "marker" | "path" | "g" | "rect" | "text">(
  tag: K,
  attributes: Readonly<Record<string, string | number>>,
): SVGElement {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value));
  return node;
}

/** The arrowhead referenced by every arc. */
function arrowMarker(): SVGElement {
  const defs = svgElement("defs", {});
  const marker = svgElement("marker", {
    id: "arrow",
    viewBox: "0 0 10 10",
    refX: 9,
    refY: 5,
    markerWidth: 6,
    markerHeight: 6,
    orient: "auto-start-reverse",
  });
  marker.append(svgElement("path", { d: "M0,0 L10,5 L0,10 z", class: "arrow-head" }));
  defs.append(marker);
  return defs;
}

/** Draws one arc as a quadratic Bézier curve with an arrowhead at its end. */
function edgePath(edge: GraphEdge): SVGElement {
  const { start, control, end } = edge;
  return svgElement("path", {
    class: `edge edge-${edge.kind}`,
    d: `M${start.x} ${start.y} Q${control.x} ${control.y} ${end.x} ${end.y}`,
    "data-from": edge.from,
    "data-to": edge.to,
    "marker-end": "url(#arrow)",
  });
}

/** Draws one instruction box: its program counter above its opcode. */
function nodeBox(node: GraphNode): SVGElement {
  const group = svgElement("g", { class: "node", "data-pc": node.pc });
  group.append(
    svgElement("rect", { x: node.x, y: node.y, width: NODE_WIDTH, height: NODE_HEIGHT, rx: 6 }),
    labelText(node.x + 10, node.y + 15, "pc", String(node.pc).padStart(3, "0")),
    labelText(node.x + 10, node.y + 31, "op", node.op),
  );
  return group;
}

/** Creates a text label. The content is set with `textContent`. */
function labelText(x: number, y: number, className: string, content: string): SVGElement {
  const text = svgElement("text", { x, y, class: className });
  text.textContent = content;
  return text;
}
