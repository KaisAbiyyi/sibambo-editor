import node from '@sveltejs/adapter-node';
import vercel from '@sveltejs/adapter-vercel';

const adapter = process.env.VERCEL ? vercel : node;

export default {
	kit: { adapter: adapter() }
};
