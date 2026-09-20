<script lang="ts">
	import background from '$lib/images/background.webp';

	let { children } = $props();
</script>

<div
	class="absolute inset-0 -z-10 bg-cover bg-center bg-no-repeat"
	style="background-image: url({background});"
></div>

{@render children()}
