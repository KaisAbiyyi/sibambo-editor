import type { BomcGraph } from '@sibambo/bomc-document';
import type { AuthoringPoint } from './protocol.js';
export type ConstructionGuide = { kind: 'line' | 'point' | 'edge'; start: AuthoringPoint; end: AuthoringPoint };
// Transient flat context views retain construction references without altering their canonical graph shape.
export const constructionGuides = new WeakMap<BomcGraph, readonly ConstructionGuide[]>();
