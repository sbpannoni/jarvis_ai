// Loads full three.js + the postprocessing addons used by network-map.js
// (custom node meshes, moon terrain, bloom) and hangs them on window so the
// classic <script> files can reach them.
//
// This lives in its own FILE rather than an inline <script type="module"> in
// index.html on purpose: a Content-Security-Policy without 'unsafe-inline'
// blocks inline scripts outright, which would silently leave window.THREE3D
// undefined and strip the map of its terrain and custom nodes. An external
// module only needs script-src 'self'.
//
// Note this is a SECOND, independent three.js instance from the minimal
// subset bundled inside vendor/3d-force-graph.min.js. They don't need to be
// the same instance, and three logs a benign "Multiple instances" warning.
import * as THREE from "three";
import {EffectComposer} from "./vendor/three-addons/postprocessing/EffectComposer.js";
import {RenderPass} from "./vendor/three-addons/postprocessing/RenderPass.js";
import {UnrealBloomPass} from "./vendor/three-addons/postprocessing/UnrealBloomPass.js";

window.THREE3D = THREE;
window.THREE_POSTFX = {EffectComposer, RenderPass, UnrealBloomPass};

// This file is a MODULE, so it is deferred and its 1.3MB of three.js loads
// asynchronously — anything depending on window.THREE3D must wait for this
// signal rather than a timer. Firing on a fixed delay meant the map could
// activate before three.js existed, silently fall back to no-terrain
// rendering, and look like an empty black background.
window.dispatchEvent(new Event("three3d-ready"));

// Register the fcose layout extension (compound-aware force layout) for the
// CODEBASE MAP's grouped/cluster view. Built-in cose blows compound graphs up
// to a ~100k-px canvas (fit zoom ~0.01 -> blank), while fcose keeps clusters
// compact and legible. cose-base + cytoscape-fcose are UMD classic scripts
// loaded before this module, so their globals are already on window.
if (window.cytoscape && window.cytoscapeFcose) {
  window.cytoscape.use(window.cytoscapeFcose);
}
// dagre: layered (hierarchical) layout used for the CODEBASE MAP's directional
// "flow" view, which ranks modules by dependency depth so the graph reads as a
// left-to-right subway line instead of a radial hairball.
if (window.cytoscape && window.cytoscapeDagre) {
  window.cytoscape.use(window.cytoscapeDagre);
}
