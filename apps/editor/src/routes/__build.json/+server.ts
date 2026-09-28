import { json } from '@sveltejs/kit';

export function GET() {
	return json(__SIBAMBO_APP_BUILD__, { headers: { 'Cache-Control': 'no-store' } });
}
