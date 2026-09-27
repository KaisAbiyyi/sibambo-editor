import { CanvasTexture, DoubleSide, MeshStandardMaterial, SRGBColorSpace } from 'three';

/** Builds the same canvas label fallback used by the established renderer. */
export function createFallbackTextMaterial(text: string) {
	const canvas = document.createElement('canvas');
	canvas.width = 1024;
	canvas.height = 256;
	const context = canvas.getContext('2d');
	if (!context) return { material: new MeshStandardMaterial({ color: '#f8fafc', roughness: 1, metalness: 0, side: DoubleSide }), texture: null };
	context.clearRect(0, 0, canvas.width, canvas.height);
	context.fillStyle = 'rgba(255, 255, 255, 0.96)';
	context.fillRect(0, 0, canvas.width, canvas.height);
	context.fillStyle = '#111827';
	context.textAlign = 'center';
	context.textBaseline = 'middle';
	context.font = '600 72px Inter, Arial, sans-serif';
	context.fillText(text.slice(0, 96), canvas.width / 2, canvas.height / 2, canvas.width - 48);
	const texture = new CanvasTexture(canvas);
	texture.colorSpace = SRGBColorSpace;
	return { material: new MeshStandardMaterial({ map: texture, transparent: true, roughness: 1, metalness: 0, side: DoubleSide }), texture };
}
