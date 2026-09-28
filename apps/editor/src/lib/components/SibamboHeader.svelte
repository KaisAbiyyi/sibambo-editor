<script lang="ts">
	import { onMount } from 'svelte';
	let { current }: { current: 'editor' } = $props();
	type BuildIdentity = typeof __SIBAMBO_APP_BUILD__ & { buildConfigSha256: string };
	const build = __SIBAMBO_APP_BUILD__ as BuildIdentity;
	type UpdateState = 'checking' | 'current' | 'available' | 'unknown';
	let updateState = $state<UpdateState>('checking');
	let latestBuild = $state<BuildIdentity | null>(null);
	let lastCheckedAt = $state('');
	let darkMode = $state(false);
	function formatPaths(paths: string[]) { return paths.length ? paths.join(' · ') : 'None'; }

	onMount(() => {
		const saved = localStorage.getItem('sibambo-theme');
		darkMode = saved ? saved === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
		applyTheme();
		let active = true;
		let checkSequence = 0;
		const checkForUpdate = async () => {
			if (document.visibilityState !== 'visible') return;
			const requestSequence = ++checkSequence;
			try {
				const response = await fetch('/__build.json', { cache: 'no-store' });
				if (!response.ok) throw new Error(`Build identity request failed (${response.status}).`);
				const candidate = await response.json() as BuildIdentity;
				if (!/^[a-f0-9]{40}$/i.test(candidate.commit) || typeof candidate.sourceSha256 !== 'string') throw new Error('Build identity response is incomplete.');
				if (!active || requestSequence !== checkSequence) return;
				latestBuild = candidate;
				updateState = candidate.commit === build.commit ? 'current' : 'available';
				lastCheckedAt = new Date().toISOString();
			} catch {
				if (!active || requestSequence !== checkSequence) return;
				updateState = 'unknown';
				lastCheckedAt = new Date().toISOString();
			}
		};
		const onVisibilityChange = () => { if (document.visibilityState === 'visible') void checkForUpdate(); };
		const onFocus = () => { void checkForUpdate(); };
		const onOnline = () => { void checkForUpdate(); };
		void checkForUpdate();
		const interval = window.setInterval(() => {
			if (document.visibilityState === 'visible') void checkForUpdate();
		}, 30_000);
		document.addEventListener('visibilitychange', onVisibilityChange);
		window.addEventListener('focus', onFocus);
		window.addEventListener('online', onOnline);
		return () => {
			active = false;
			window.clearInterval(interval);
			document.removeEventListener('visibilitychange', onVisibilityChange);
			window.removeEventListener('focus', onFocus);
			window.removeEventListener('online', onOnline);
		};
	});
	function applyTheme() { document.documentElement.dataset.theme = darkMode ? 'dark' : 'light'; }
	function toggleTheme() {
		darkMode = !darkMode;
		localStorage.setItem('sibambo-theme', darkMode ? 'dark' : 'light');
		applyTheme();
	}
	function reloadBuild() { window.location.reload(); }
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
		{#if updateState === 'available'}
			<button class="build-update" type="button" aria-live="polite" onclick={reloadBuild}>New build available · Reload</button>
		{/if}
		<button class="theme-toggle" type="button" aria-label={darkMode ? 'Switch to light mode' : 'Switch to dark mode'} title={darkMode ? 'Light mode' : 'Dark mode'} onclick={toggleTheme}>
			{#if darkMode}<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42"/></svg>{:else}<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.9 13A9 9 0 0 1 11 3.1 9 9 0 1 0 20.9 13Z"/></svg>{/if}
		</button>
		<details class="build-details">
			<summary aria-label={`Build ${build.commit.slice(0, 8)}`}>Build {build.commit.slice(0, 8)}</summary>
			<div class="build-popover" data-testid="build-fingerprint" aria-label="Running build identity">
				<p><strong>Running commit</strong><code>{build.commit}</code></p>
				<p><strong>Source fingerprint</strong><code data-testid="source-fingerprint">{build.sourceSha256}</code></p>
				<p><strong>Build configuration</strong><code>{build.buildConfigSha256}</code></p>
				<p><strong>Source state</strong><span>{build.dirty ? 'Dirty build inputs' : 'Clean build inputs'}</span></p>
				<div class="build-working-tree" data-testid="build-working-tree" aria-label="Working tree path diagnostics">
					<p><strong>Build-input modified paths</strong><code>{formatPaths(build.workingTree.buildInputModifiedPaths)}</code></p>
					<p><strong>Build-input untracked paths</strong><code>{formatPaths(build.workingTree.buildInputUntrackedPaths)}</code></p>
					<p><strong>Other modified paths</strong><code>{formatPaths(build.workingTree.otherModifiedPaths)}</code></p>
					<p><strong>Other untracked paths</strong><code>{formatPaths(build.workingTree.otherUntrackedPaths)}</code></p>
					<p><strong>Generated output paths</strong><code>{formatPaths(build.workingTree.generatedOutputPaths)}</code></p>
				</div>
				<p><strong>Build captured</strong><time datetime={build.capturedAt}>{build.capturedAt}</time></p>
				<p><strong>Update status</strong><span>{updateState === 'checking' ? 'Checking for updates…' : updateState === 'current' ? 'Running the latest reported commit.' : updateState === 'available' ? 'A newer commit is available.' : 'Update status unknown; the running build label remains unchanged.'}</span></p>
				{#if latestBuild}<p><strong>Live commit</strong><code>{latestBuild.commit}</code></p>{/if}
				{#if lastCheckedAt}<p><strong>Last checked</strong><time datetime={lastCheckedAt}>{lastCheckedAt}</time></p>{/if}
			</div>
		</details>
	</div>
</header>
