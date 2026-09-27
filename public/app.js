// Minimal client for the City League vertical slice: region/core picker ->
// battle screen driven entirely by polling the HTTP API after every choice
// -> win/loss screen. No build step, no framework - just enough JS to turn
// server state into a playable screen.

const screens = {
	picker: document.getElementById('screen-picker'),
	preview: document.getElementById('screen-preview'),
	battle: document.getElementById('screen-battle'),
	end: document.getElementById('screen-end'),
};

function showScreen(name) {
	for (const [key, el] of Object.entries(screens)) el.classList.toggle('hidden', key !== name);
}

function spriteId(speciesName) {
	return speciesName.toLowerCase().replace(/[.']/g, '').replace(/[\s:]+/g, '');
}

async function api(path, opts) {
	const res = await fetch(path, opts);
	const body = await res.json();
	if (!res.ok) throw new Error(body.error || `Request failed: ${res.status}`);
	return body;
}

// --- Picker screen -------------------------------------------------------

async function loadPicker() {
	const { regions } = await api('/api/regions');
	const container = document.getElementById('region-list');
	container.innerHTML = '';
	for (const region of regions) {
		const block = document.createElement('div');
		block.className = 'region-block';
		const h2 = document.createElement('h2');
		h2.textContent = region.name;
		block.appendChild(h2);
		for (const core of region.cores) {
			const btn = document.createElement('button');
			btn.className = 'core-btn';
			btn.innerHTML = `${core.name}<div class="species-line">${core.species.join(' &amp; ')}</div>`;
			btn.onclick = () => startBattle(region.id, core.index);
			block.appendChild(btn);
		}
		container.appendChild(block);
	}
}

// --- Battle screen ---------------------------------------------------------

let currentBattleId = null;
// Pending action-collection state while the player is choosing moves/targets
// for this turn: one entry per active "you" slot index that needs an action.
let pendingActions = null; // { queue: [slotIdx, ...], results: {slotIdx: {moveSlot, target}}, awaitingTargetFor: slotIdx|null, moveSlotAwaitingTarget }

async function startBattle(region, coreIndex) {
	const state = await api('/api/battle/start', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ region, coreIndex }),
	});
	currentBattleId = state.battleId;
	render(state);
}

// --- Team preview screen (bring 6, pick 4) --------------------------------

let previewPicks = []; // ordered list of 1-based roster indices tapped so far

function renderPreview(state) {
	showScreen('preview');
	previewPicks = [];
	document.getElementById('preview-hint').textContent =
		`Tap ${state.maxChosenTeamSize} Pokemon in the order you want them - the first two lead the battle.`;

	const grid = document.getElementById('preview-grid');
	grid.innerHTML = '';
	for (const mon of state.roster) {
		const card = document.createElement('div');
		card.className = 'preview-card';
		card.innerHTML = `
			<img class="sprite" src="https://play.pokemonshowdown.com/sprites/gen5/${spriteId(mon.species)}.png" alt="${mon.species}">
			<div class="name">${mon.species}</div>
			<div class="level">Lv. ${mon.level}</div>
		`;
		card.onclick = () => togglePreviewPick(state, mon.index, card);
		grid.appendChild(card);
	}
	updatePreviewConfirmButton(state);
}

function togglePreviewPick(state, index, card) {
	const existing = previewPicks.indexOf(index);
	if (existing !== -1) {
		previewPicks.splice(existing, 1);
	} else if (previewPicks.length < state.maxChosenTeamSize) {
		previewPicks.push(index);
	}
	// Re-render badges across all cards since removing one shifts the rest.
	const cards = document.querySelectorAll('.preview-card');
	state.roster.forEach((mon, i) => {
		const pick = previewPicks.indexOf(mon.index);
		cards[i].classList.toggle('picked', pick !== -1);
		const existingBadge = cards[i].querySelector('.pick-badge');
		if (existingBadge) existingBadge.remove();
		if (pick !== -1) {
			const badge = document.createElement('div');
			badge.className = 'pick-badge';
			badge.textContent = pick + 1;
			cards[i].appendChild(badge);
		}
	});
	updatePreviewConfirmButton(state);
}

function updatePreviewConfirmButton(state) {
	const btn = document.getElementById('preview-confirm');
	btn.disabled = previewPicks.length !== state.maxChosenTeamSize;
	btn.textContent = `Confirm team (${previewPicks.length}/${state.maxChosenTeamSize})`;
}

document.getElementById('preview-confirm').onclick = async () => {
	const btn = document.getElementById('preview-confirm');
	btn.disabled = true;
	btn.textContent = 'Starting battle...';
	try {
		const newState = await api(`/api/battle/${currentBattleId}/choose`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ order: previewPicks }),
		});
		render(newState);
	} catch (err) {
		btn.disabled = false;
		document.getElementById('preview-hint').textContent = `Error: ${err.message}`;
	}
};

function hpClass(frac) {
	if (frac == null) return '';
	if (frac <= 0.2) return 'low';
	if (frac <= 0.5) return 'mid';
	return '';
}

function renderSlot(el, mon, { targetable, onClick } = {}) {
	el.classList.toggle('empty', !mon);
	el.classList.toggle('targetable', !!targetable);
	el.onclick = targetable && onClick ? onClick : null;

	if (!mon) { el.innerHTML = ''; return; }

	const frac = mon.hpFraction == null ? 1 : mon.hpFraction;
	const barClass = hpClass(frac);
	const statusHtml = mon.status ? `<div class="status-badge">${mon.status}</div>` : '';
	const hpText = mon.hpText || (mon.fainted ? 'Fainted' : '');

	el.innerHTML = `
		<img class="sprite" src="https://play.pokemonshowdown.com/sprites/${mon.back ? 'gen5-back' : 'gen5'}/${spriteId(mon.species)}.png" alt="${mon.species}">
		<div class="name">${mon.species}</div>
		<div class="level">Lv. ${mon.level}</div>
		<div class="hp-bar-bg"><div class="hp-bar-fill ${barClass}" style="width:${Math.max(0, frac * 100)}%"></div></div>
		<div class="hp-text">${hpText}</div>
		${statusHtml}
	`;
}

let lastState = null;

function render(state) {
	lastState = state;

	if (state.phase === 'teamPreview') {
		renderPreview(state);
		return;
	}

	showScreen('battle');
	document.getElementById('opponent-name').textContent = `vs. ${state.opponentName}`;

	const foeSlots = document.querySelectorAll('.slot[data-side="foe"]');
	state.foe.forEach((mon, i) => renderSlot(foeSlots[i], mon && { ...mon }));

	const youSlots = document.querySelectorAll('.slot[data-side="you"]');
	state.you.filter(p => p.active).forEach((mon, i) => {
		renderSlot(youSlots[i], { ...mon, back: true });
	});

	const logEl = document.getElementById('log');
	logEl.innerHTML = state.log.map(line => `<div>${escapeHtml(line)}</div>`).join('');
	logEl.scrollTop = logEl.scrollHeight;

	if (state.ended) {
		const title = state.tie ? "It's a tie!" : (state.winner === 'You' ? 'You won the battle!' : `${state.winner} won the battle.`);
		document.getElementById('end-title').textContent = state.error ? `Something went wrong: ${state.error}` : title;
		showScreen('end');
		return;
	}

	const switchPanel = document.getElementById('switch-panel');
	if (state.phase === 'switch') {
		switchPanel.classList.remove('hidden');
		document.getElementById('action-panel').innerHTML = '';
		renderSwitchPanel(state);
		return;
	}
	switchPanel.classList.add('hidden');

	pendingActions = null;
	renderActionPanel(state);
}

// --- Forced-switch screen (a mon fainted and there's a bench to pick from) --

// One entry per forceSwitch position still needing an answer, in order.
let pendingSwitches = null; // { queue: [posIdx,...], results: {posIdx: rosterSlot} }

function renderSwitchPanel(state) {
	const panel = document.getElementById('switch-panel');
	if (!pendingSwitches) {
		const queue = state.forceSwitch.map((needs, i) => (needs ? i : -1)).filter(i => i >= 0);
		pendingSwitches = { queue, results: {} };
	}

	if (pendingSwitches.queue.length === 0) {
		submitSwitches(state);
		return;
	}

	const posIdx = pendingSwitches.queue[0];
	const fainted = state.you[posIdx];
	const chosenSoFar = new Set(Object.values(pendingSwitches.results));
	const available = state.you.filter((p, i) => !p.active && !p.fainted && !chosenSoFar.has(i));

	panel.innerHTML = `<div class="prompt">${fainted.species} fainted - choose a replacement:</div><div class="switch-options" id="switch-options"></div>`;
	const optionsEl = document.getElementById('switch-options');
	for (const mon of available) {
		const btn = document.createElement('button');
		btn.className = 'switch-btn';
		btn.textContent = `${mon.species} (${mon.hpText})`;
		btn.onclick = () => {
			pendingSwitches.results[posIdx] = mon.index;
			pendingSwitches.queue.shift();
			renderSwitchPanel(state);
		};
		optionsEl.appendChild(btn);
	}
	if (!available.length) {
		// No legal switch-in for this position (shouldn't normally happen once
		// we've already confirmed a bench exists) - just pass it.
		pendingSwitches.queue.shift();
		renderSwitchPanel(state);
	}
}

async function submitSwitches(state) {
	const switches = state.forceSwitch.map((needs, i) => (needs ? (pendingSwitches.results[i] + 1 || null) : null));
	pendingSwitches = null;
	const panel = document.getElementById('switch-panel');
	panel.innerHTML = '<div class="prompt">Sending out replacement...</div>';
	try {
		const newState = await api(`/api/battle/${currentBattleId}/choose`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ switches }),
		});
		render(newState);
	} catch (err) {
		panel.innerHTML = `<div class="prompt">Error: ${escapeHtml(err.message)}</div>`;
	}
}

function escapeHtml(s) {
	return s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

// The active "you" slots that actually need a choice this turn, in order.
function actingSlots(state) {
	return state.you.map((p, i) => ({ p, i })).filter(({ p }) => p.active && !p.fainted && p.moves);
}

function targetSlotFor(side, letterIndex) {
	// Matches the server/TieredAI convention: opposing slots are 1/2, own-side
	// ally slots are negative (-1 = your 'a' slot, -2 = your 'b' slot).
	return side === 'foe' ? letterIndex + 1 : -(letterIndex + 1);
}

function renderActionPanel(state) {
	const panel = document.getElementById('action-panel');
	const acting = actingSlots(state);

	if (!acting.length) {
		panel.innerHTML = '<div class="prompt">Waiting...</div>';
		return;
	}

	if (!pendingActions) {
		pendingActions = { queue: acting.map(a => a.i), results: {}, awaiting: null };
	}

	if (pendingActions.queue.length === 0) {
		submitActions(state);
		return;
	}

	const slotIdx = pendingActions.queue[0];
	const mon = state.you.find((p, i) => i === slotIdx);

	if (pendingActions.awaiting) {
		panel.innerHTML = `<div class="prompt">${mon.species}: pick a target for ${pendingActions.awaiting.moveName}</div>
			<button class="cancel-btn" id="cancel-target">Cancel</button>`;
		document.getElementById('cancel-target').onclick = () => { pendingActions.awaiting = null; renderActionPanel(state); };
		highlightTargets(pendingActions.awaiting.targetType, slotIdx, state);
		return;
	}

	clearTargetHighlights();
	panel.innerHTML = `<div class="mon-label">${mon.species}, choose a move:</div><div class="move-grid" id="move-grid"></div>`;
	const grid = document.getElementById('move-grid');
	for (const move of mon.moves) {
		const btn = document.createElement('button');
		btn.className = 'move-btn';
		btn.disabled = !!move.disabled || move.pp === 0;
		btn.innerHTML = `${move.name}<div class="pp">${move.pp}/${move.maxpp} PP</div>`;
		btn.onclick = () => chooseMove(state, slotIdx, move);
		grid.appendChild(btn);
	}
}

const NEEDS_SINGLE_FOE_TARGET = new Set(['normal', 'any', 'adjacentFoe']);

function chooseMove(state, slotIdx, move) {
	if (NEEDS_SINGLE_FOE_TARGET.has(move.target)) {
		pendingActions.awaiting = { moveSlot: move.slot, moveName: move.name, targetType: 'foe' };
		renderActionPanel(state);
		return;
	}
	if (move.target === 'adjacentAlly') {
		// With exactly two active slots, the ally is whichever slot isn't us.
		const allyIdx = slotIdx === 0 ? 1 : 0;
		const ally = state.you.find((p, i) => i === allyIdx);
		if (ally && ally.active && !ally.fainted) {
			pendingActions.results[slotIdx] = { moveSlot: move.slot, target: targetSlotFor('you', allyIdx) };
			pendingActions.queue.shift();
			renderActionPanel(state);
			return;
		}
	}
	// No target needed (self/spread/field moves) or no valid ally to target.
	pendingActions.results[slotIdx] = { moveSlot: move.slot };
	pendingActions.queue.shift();
	renderActionPanel(state);
}

function clearTargetHighlights() {
	document.querySelectorAll('.slot').forEach(el => { el.classList.remove('targetable'); el.onclick = null; });
}

function highlightTargets(targetType, slotIdx, state) {
	clearTargetHighlights();
	const foeSlots = document.querySelectorAll('.slot[data-side="foe"]');
	state.foe.forEach((mon, i) => {
		if (!mon || mon.fainted) return;
		foeSlots[i].classList.add('targetable');
		foeSlots[i].onclick = () => {
			pendingActions.results[slotIdx] = { moveSlot: pendingActions.awaiting.moveSlot, target: targetSlotFor('foe', i) };
			pendingActions.awaiting = null;
			pendingActions.queue.shift();
			clearTargetHighlights();
			renderActionPanel(state);
		};
	});
}

async function submitActions(state) {
	// Must stay index-aligned with state.you (== the request's active slots),
	// not compacted to just the slots that acted - a fainted/inactive slot
	// still needs its own (null -> "pass") entry at the same position.
	const actions = state.you.map((p, i) => pendingActions.results[i] || null);
	pendingActions = null;
	const panel = document.getElementById('action-panel');
	panel.innerHTML = '<div class="prompt">Resolving turn...</div>';
	try {
		const newState = await api(`/api/battle/${currentBattleId}/choose`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ actions }),
		});
		render(newState);
	} catch (err) {
		panel.innerHTML = `<div class="prompt">Error: ${escapeHtml(err.message)}</div>`;
	}
}

document.getElementById('btn-again').onclick = () => {
	currentBattleId = null;
	showScreen('picker');
	loadPicker();
};

loadPicker();
