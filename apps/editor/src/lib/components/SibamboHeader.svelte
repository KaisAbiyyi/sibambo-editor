<script lang="ts">
	import { onMount } from 'svelte';
	let { current }: { current: 'editor' } = $props();
	const build = __SIBAMBO_APP_BUILD__;
	let darkMode = $state(false);

	onMount(() => {
		const saved = localStorage.getItem('sibambo-theme');
		darkMode = saved ? saved === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
		applyTheme();
	});
	function applyTheme() { document.documentElement.dataset.theme = darkMode ? 'dark' : 'light'; }
	function toggleTheme() {
		darkMode = !darkMode;
		localStorage.setItem('sibambo-theme', darkMode ? 'dark' : 'light');
		applyTheme();
	}
</script>

<svelte:head><meta name="theme-color" content={darkMode ? '#15181C' : '#7A1F2B'} /></svelte:head>

<header class="sibambo-header">
	<a class="sibambo-brand" href="https://sibambo.vercel.app/" aria-label="Sibambo home">
		<span class="brand-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m21 16-9 5-9-5V8l9-5 9 5v8Z"/><path d="m3.3 7 8.7 5 8.7-5M12 22V12"/></svg></span>
		<span class="brand-name">Sibambo</span><span class="app-badge">EDITOR</span>
	</a>
	<nav class="app-switcher" aria-label="Sibambo apps">
		<a href="https://sibambo-rooms.vercel.app/">Rooms</a>
		<a href="/" aria-current={current === 'editor' ? 'page' : undefined}>Editor</a>
		<a href="https://sibambo-benchmark.vercel.app/">Benchmark</a>
	</nav>
	<div class="header-actions">
		<button class="theme-toggle" type="button" aria-label={darkMode ? 'Switch to light mode' : 'Switch to dark mode'} title={darkMode ? 'Light mode' : 'Dark mode'} onclick={toggleTheme}>
			{#if darkMode}<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42"/></svg>{:else}<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.9 13A9 9 0 0 1 11 3.1 9 9 0 1 0 20.9 13Z"/></svg>{/if}
		</button>
		<details class="build-details"><summary aria-label={`Build ${build.sourceSha256.slice(0, 8)}`}>Build {build.sourceSha256.slice(0, 8)}</summary><output data-testid="build-fingerprint" aria-label="Build fingerprint">{build.sourceSha256}</output></details>
	</div>
</header>
