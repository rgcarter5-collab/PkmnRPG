// Minimal client for the City League vertical slice: region/core picker ->
// battle screen driven entirely by polling the HTTP API after every choice
// -> win/loss screen. No build step, no framework - just enough JS to turn
// server state into a playable screen.

const screens = {
	home: document.getElementById('screen-home'),
	picker: document.getElementById('screen-picker'),
	roster: document.getElementById('screen-roster'),
	preview: document.getElementById('screen-preview'),
	battle: document.getElementById('screen-battle'),
	end: document.getElementById('screen-end'),
	market: document.getElementById('screen-market'),
	team: document.getElementById('screen-team'),
};

function showScreen(name) {
	for (const [key, el] of Object.entries(screens)) el.classList.toggle('hidden', key !== name);
}

function spriteId(speciesName) {
	return speciesName.toLowerCase().replace(/[.']/g, '').replace(/[\s:]+/g, '');
}

// No accounts/login: a UUID generated once and kept in localStorage is this
// browser's whole "save file" identity. The server auto-creates a player
// record (with starting Pokedollars) the first time it sees an unfamiliar id.
function getPlayerId() {
	let id = localStorage.getItem('pkmnrpg_player_id');
	if (!id) {
		id = crypto.randomUUID();
		localStorage.setItem('pkmnrpg_player_id', id);
	}
	return id;
}
const PLAYER_ID = getPlayerId();

async function api(path, opts) {
	const finalOpts = { ...opts, headers: { 'X-Player-Id': PLAYER_ID, ...(opts && opts.headers) } };
	const res = await fetch(path, finalOpts);
	const body = await res.json();
	if (!res.ok) throw new Error(body.error || `Request failed: ${res.status}`);
	return body;
}

document.querySelectorAll('.back-btn').forEach(btn => {
	btn.addEventListener('click', () => {
		const dest = btn.dataset.back;
		if (dest === 'home') loadHome();
	});
});

// --- Home screen -----------------------------------------------------------

async function loadHome() {
	showScreen('home');
	const { player } = await api('/api/player');
	document.getElementById('wallet-line').textContent =
		`Pokedollars: ${player.pokedollars} | Training Points: ${player.trainingPoints}`;
}

document.getElementById('nav-rentals').onclick = () => { showScreen('picker'); loadPicker(); };
document.getElementById('nav-team').onclick = () => { loadTeamScreen(); };
document.getElementById('nav-market').onclick = () => { loadMarket(); };

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
			btn.onclick = () => openRosterBuilder(region.id, core.index);
			block.appendChild(btn);
		}
		container.appendChild(block);
	}
}

// --- Roster builder screen (edit rental movesets before the battle) --------

let rosterState = null; // { region, coreIndex, pokemon: [{index, species, level, moves, movepool}] }
let editingSlot = null; // { pokemonIndex, moveSlotIdx } while a movepool panel is open

async function openRosterBuilder(regionId, coreIndex) {
	const { coreName, roster } = await api(`/api/regions/${regionId}/cores/${coreIndex}`);
	rosterState = {
		region: regionId, coreIndex,
		pokemon: roster.map(p => ({ ...p, moves: [...p.moves] })),
	};
	editingSlot = null;
	document.getElementById('roster-title').textContent = coreName;
	renderRosterBuilder();
	showScreen('roster');
}

function renderRosterBuilder() {
	const grid = document.getElementById('roster-grid');
	grid.innerHTML = '';
	rosterState.pokemon.forEach((mon, pIdx) => {
		const card = document.createElement('div');
		card.className = 'roster-card';
		card.innerHTML = `
			<div class="roster-head">
				<img class="sprite" src="https://play.pokemonshowdown.com/sprites/gen5/${spriteId(mon.species)}.png" alt="">
				<div>
					<div class="roster-name">${mon.species}</div>
					<div class="roster-sub">Lv.${mon.level}</div>
				</div>
			</div>
			<div class="roster-moves"></div>
		`;
		const movesEl = card.querySelector('.roster-moves');
		mon.moves.forEach((moveName, mIdx) => {
			const btn = document.createElement('button');
			const isEditing = editingSlot && editingSlot.pokemonIndex === pIdx && editingSlot.moveSlotIdx === mIdx;
			btn.className = 'roster-move-btn' + (isEditing ? ' editing' : '');
			btn.textContent = moveName;
			btn.onclick = () => {
				editingSlot = isEditing ? null : { pokemonIndex: pIdx, moveSlotIdx: mIdx };
				renderRosterBuilder();
			};
			movesEl.appendChild(btn);
		});
		if (editingSlot && editingSlot.pokemonIndex === pIdx) {
			card.appendChild(renderMovepoolPanel(mon, pIdx, editingSlot.moveSlotIdx));
		}
		grid.appendChild(card);
	});
}

function renderMovepoolPanel(mon, pIdx, moveSlotIdx) {
	const panel = document.createElement('div');
	panel.className = 'movepool-panel';
	const search = document.createElement('input');
	search.className = 'movepool-search';
	search.placeholder = 'Search moves...';
	panel.appendChild(search);
	const list = document.createElement('div');
	panel.appendChild(list);

	function renderList(filter) {
		list.innerHTML = '';
		const q = filter.trim().toLowerCase();
		for (const move of mon.movepool) {
			if (q && !move.name.toLowerCase().includes(q)) continue;
			const opt = document.createElement('button');
			const isCurrent = mon.moves[moveSlotIdx] === move.name;
			opt.className = 'movepool-option' + (isCurrent ? ' current' : '');
			opt.textContent = isCurrent ? `${move.name} (current)` : move.name;
			opt.onclick = () => {
				mon.moves[moveSlotIdx] = move.name;
				editingSlot = null;
				renderRosterBuilder();
			};
			list.appendChild(opt);
		}
	}
	renderList('');
	search.oninput = () => renderList(search.value);
	return panel;
}

document.getElementById('roster-confirm').addEventListener('click', () => {
	const moves = {};
	for (const mon of rosterState.pokemon) moves[mon.index] = mon.moves;
	startBattle(rosterState.region, rosterState.coreIndex, moves);
});

// --- Battle screen ---------------------------------------------------------

let currentBattleId = null;
// Pending action-collection state while the player is choosing moves/targets
// for this turn: one entry per active "you" slot index that needs an action.
let pendingActions = null; // { queue: [slotIdx, ...], results: {slotIdx: {moveSlot, target}}, awaitingTargetFor: slotIdx|null, moveSlotAwaitingTarget }

async function startBattle(region, coreIndex, moves) {
	const state = await api('/api/battle/start', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ region, coreIndex, moves }),
	});
	currentBattleId = state.battleId;
	renderedEventCount = 0;
	await applyState(state);
}

// --- Team preview screen (bring 6, pick 4) --------------------------------

let previewPicks = []; // ordered list of 1-based roster indices tapped so far

function renderPreview(state) {
	showScreen('preview');
	previewPicks = [];
	document.getElementById('preview-hint').textContent =
		`Tap ${state.maxChosenTeamSize} Pokemon in the order you want them - the first two lead the battle.`;

	document.getElementById('foe-preview-label').textContent = `${state.opponentName}'s team`;
	const foeGrid = document.getElementById('foe-preview-grid');
	foeGrid.innerHTML = '';
	for (const mon of state.foeRoster || []) {
		const card = document.createElement('div');
		card.className = 'foe-preview-card';
		card.innerHTML = `
			<img class="sprite" src="https://play.pokemonshowdown.com/sprites/gen5/${spriteId(mon.species)}.png" alt="${mon.species}">
			<div class="name">${mon.species}</div>
		`;
		foeGrid.appendChild(card);
	}

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
		await applyState(newState);
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

// --- Battle pacing: play the turn's events out one at a time instead of the
// whole outcome landing on screen at once (the actual ask that started this:
// "things happen too fast... let us see the health bar slide down"). Every
// state snapshot carries the FULL event history (see game-server.mjs's
// buildEvent), so the client just remembers how many it's already shown and
// replays the new tail with a deliberate pause between lines, updating each
// affected slot's HP bar (a CSS-transitioned width, so it visibly slides)
// as it goes. The existing render() below still runs after playback, as a
// "snap to truth" sync - harmless since by then the numbers already match.
const LOG_CAP = 60;
const EVENT_DELAY_MS = 950;
let renderedEventCount = 0;

function sleep(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function delayForEvent(ev) {
	if (ev.fainted) return 1500; // let a KO land before moving on
	if (ev.isTurnMarker) return 500; // just a divider, don't dwell on it
	if (ev.switched) return 1100;
	return EVENT_DELAY_MS;
}

function appendLogLine(text) {
	const logEl = document.getElementById('log');
	const div = document.createElement('div');
	div.className = 'log-enter';
	div.textContent = text;
	logEl.appendChild(div);
	while (logEl.children.length > LOG_CAP) logEl.removeChild(logEl.firstChild);
	logEl.scrollTop = logEl.scrollHeight;
}

function updateSlotHp(ev) {
	const el = document.querySelector(`.slot[data-side="${ev.side}"][data-slot="${ev.slot}"]`);
	if (!el) return;

	if (ev.switched) {
		// A new Pokemon in this slot is an identity change, not just an HP
		// change - nothing to blend from, so the sprite/name snap immediately
		// and only the HP bar (starting from empty) transitions in.
		el.classList.remove('empty', 'fainted');
		el.innerHTML = `
			<img class="sprite" src="https://play.pokemonshowdown.com/sprites/${ev.side === 'you' ? 'gen5-back' : 'gen5'}/${spriteId(ev.species)}.png" alt="${ev.species}">
			<div class="name">${ev.species}</div>
			<div class="level">Lv. ${ev.level ?? ''}</div>
			<div class="hp-bar-bg"><div class="hp-bar-fill" style="width:0%"></div></div>
			<div class="hp-text"></div>
		`;
		void el.offsetWidth; // force layout so width:0% -> target actually transitions
	}

	const fill = el.querySelector('.hp-bar-fill');
	const text = el.querySelector('.hp-text');
	const frac = Math.max(0, Math.min(1, ev.hpFraction));
	if (fill) {
		fill.style.width = `${frac * 100}%`;
		fill.classList.toggle('mid', frac > 0.2 && frac <= 0.5);
		fill.classList.toggle('low', frac <= 0.2);
	}
	if (text && ev.hpText !== undefined) text.textContent = ev.hpText;
	el.classList.toggle('fainted', !!ev.fainted);
}

async function playEvents(events) {
	for (const ev of events) {
		if (ev.text) appendLogLine(ev.text);
		if (ev.side && ev.hpFraction != null) updateSlotHp(ev);
		await sleep(delayForEvent(ev));
	}
}

// Every place that used to call render(state) directly now calls this
// instead, so new events get replayed before the screen snaps to the final
// state. Team Preview has no on-field events yet, so it skips straight
// through - no reason to pause before the player's even picked a team.
async function applyState(state) {
	const allEvents = state.events || [];
	if (allEvents.length < renderedEventCount) renderedEventCount = 0; // fresh battle
	const newEvents = allEvents.slice(renderedEventCount);
	renderedEventCount = allEvents.length;

	if (state.phase !== 'teamPreview' && newEvents.length) {
		showScreen('battle');
		document.getElementById('opponent-name').textContent = `vs. ${state.opponentName}`;
		await playEvents(newEvents);
	}
	render(state);
}

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

	// Sync from the authoritative full event history (matches what playEvents
	// already appended incrementally - see applyState). Capped the same way
	// playEvents caps it, so a long battle's log doesn't grow without bound.
	const logEl = document.getElementById('log');
	const lines = (state.events || []).filter(e => e.text).map(e => e.text).slice(-LOG_CAP);
	logEl.innerHTML = lines.map(line => `<div>${escapeHtml(line)}</div>`).join('');
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
		await applyState(newState);
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
		pendingActions = { queue: acting.map(a => a.i), results: {}, awaiting: null, pickingSwitch: false };
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

	if (pendingActions.pickingSwitch) {
		renderBenchPicker(state, slotIdx);
		return;
	}

	clearTargetHighlights();
	panel.innerHTML = `
		<div class="mon-label">${mon.species}, choose a move:</div>
		<div class="move-grid" id="move-grid"></div>
		<button class="cancel-btn" id="switch-instead">Switch out instead</button>
	`;
	const grid = document.getElementById('move-grid');
	for (const move of mon.moves) {
		const btn = document.createElement('button');
		btn.className = 'move-btn';
		btn.disabled = !!move.disabled || move.pp === 0;
		let effHint = '';
		if (move.effectiveness && !NEEDS_SINGLE_FOE_TARGET.has(move.target)) {
			// Spread moves resolve without a separate target step, so summarize
			// effectiveness against whichever foes are still up right on the button.
			const labels = Object.values(move.effectiveness).map(e => EFFECTIVENESS_LABELS[e]);
			if (labels.length) effHint = `<div class="eff-hint">${labels.join(' / ')}</div>`;
		}
		btn.innerHTML = `${move.name}<div class="pp">${move.pp}/${move.maxpp} PP</div>${effHint}`;
		btn.onclick = () => chooseMove(state, slotIdx, move);
		grid.appendChild(btn);
	}
	document.getElementById('switch-instead').onclick = () => {
		pendingActions.pickingSwitch = true;
		renderActionPanel(state);
	};
}

function renderBenchPicker(state, slotIdx) {
	const panel = document.getElementById('action-panel');
	const usedSwitchTargets = new Set(
		Object.values(pendingActions.results).filter(r => r && r.switchTo != null).map(r => r.switchTo)
	);
	const bench = state.you.filter(p => !p.active && !p.fainted && !usedSwitchTargets.has(p.index));

	if (!bench.length) {
		panel.innerHTML = '<div class="prompt">No other Pokemon available to switch in.</div><button class="cancel-btn" id="cancel-switch">Back</button>';
		document.getElementById('cancel-switch').onclick = () => { pendingActions.pickingSwitch = false; renderActionPanel(state); };
		return;
	}

	panel.innerHTML = `
		<div class="prompt">Choose a Pokemon to switch in:</div>
		<div class="switch-options" id="switch-options"></div>
		<button class="cancel-btn" id="cancel-switch">Back</button>
	`;
	const optionsEl = document.getElementById('switch-options');
	for (const mon of bench) {
		const btn = document.createElement('button');
		btn.className = 'switch-btn';
		btn.textContent = `${mon.species} (${mon.hpText})`;
		btn.onclick = () => {
			pendingActions.results[slotIdx] = { switchTo: mon.index };
			pendingActions.pickingSwitch = false;
			pendingActions.queue.shift();
			renderActionPanel(state);
		};
		optionsEl.appendChild(btn);
	}
	document.getElementById('cancel-switch').onclick = () => { pendingActions.pickingSwitch = false; renderActionPanel(state); };
}

const NEEDS_SINGLE_FOE_TARGET = new Set(['normal', 'any', 'adjacentFoe']);
const EFFECTIVENESS_LABELS = {
	noEffect: 'No effect',
	notVeryEffective: 'Not very effective...',
	effective: 'Effective',
	superEffective: 'Super effective!',
	extremelyEffective: 'Extremely effective!!',
};

function chooseMove(state, slotIdx, move) {
	if (NEEDS_SINGLE_FOE_TARGET.has(move.target)) {
		pendingActions.awaiting = {
			moveSlot: move.slot, moveName: move.name, targetType: 'foe', effectiveness: move.effectiveness,
		};
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
	document.querySelectorAll('.slot').forEach(el => {
		el.classList.remove('targetable');
		el.onclick = null;
		const tag = el.querySelector('.effectiveness-tag');
		if (tag) tag.remove();
	});
}

function highlightTargets(targetType, slotIdx, state) {
	clearTargetHighlights();
	const effectiveness = pendingActions.awaiting?.effectiveness;
	const foeSlots = document.querySelectorAll('.slot[data-side="foe"]');
	state.foe.forEach((mon, i) => {
		if (!mon || mon.fainted) return;
		const slotEl = foeSlots[i];
		slotEl.classList.add('targetable');
		const label = effectiveness && effectiveness[i + 1];
		if (label) {
			const tag = document.createElement('div');
			tag.className = `effectiveness-tag eff-${label}`;
			tag.textContent = EFFECTIVENESS_LABELS[label];
			slotEl.appendChild(tag);
		}
		slotEl.onclick = () => {
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
		await applyState(newState);
	} catch (err) {
		panel.innerHTML = `<div class="prompt">Error: ${escapeHtml(err.message)}</div>`;
	}
}

document.getElementById('btn-again').onclick = () => {
	currentBattleId = null;
	loadHome();
};

// --- Marketplace screen ------------------------------------------------

async function loadMarket() {
	showScreen('market');
	const [{ player }, { listings }] = await Promise.all([api('/api/player'), api('/api/marketplace')]);
	renderMarket(player, listings);
}

function renderMarket(player, listings) {
	document.getElementById('market-wallet').textContent = `Pokedollars: ${player.pokedollars}`;
	const grid = document.getElementById('market-grid');
	grid.innerHTML = '';
	for (const listing of listings) {
		const card = document.createElement('div');
		card.className = 'market-card';
		const afford = player.pokedollars >= listing.price;
		card.innerHTML = `
			<img class="sprite" src="https://play.pokemonshowdown.com/sprites/gen5/${spriteId(listing.species)}.png" alt="">
			<div class="name">${listing.species}</div>
			<div class="type-line">${listing.types.join(' / ')}</div>
			<div class="price">${listing.price} Pokedollars</div>
			<button class="core-btn buy-btn" ${afford ? '' : 'disabled'}>${afford ? 'Buy' : "Can't afford"}</button>
		`;
		card.querySelector('.buy-btn').onclick = async () => {
			try {
				const result = await api('/api/marketplace/buy', {
					method: 'POST', headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ listingId: listing.listingId }),
				});
				renderMarket(result.player, listings);
			} catch (err) {
				alert(err.message);
			}
		};
		grid.appendChild(card);
	}
}

// --- Team screen (owned roster, team selection, moves, SP training) ------

let teamPicks = new Set(); // owned-Pokemon ids currently chosen for the battle team
let teamEditingSlot = null; // { pokemonId, moveSlotIdx } while a movepool panel is open
let teamMovepoolCache = {}; // pokemonId -> movepool array (fetched on demand)

async function loadTeamScreen() {
	showScreen('team');
	teamEditingSlot = null;
	teamMovepoolCache = {};
	const [{ player, roster }, { regions }] = await Promise.all([api('/api/player'), api('/api/regions')]);
	teamPicks = new Set(roster.filter(p => p.onTeam).map(p => p.id));
	renderTeamRegionPicker(regions);
	renderTeamScreen(player, roster);
}

function renderTeamRegionPicker(regions) {
	const el = document.getElementById('team-region-picker');
	el.innerHTML = '<div class="hint">Battle with your team against:</div>';
	const row = document.createElement('div');
	row.className = 'team-region-row';
	for (const region of regions) {
		const btn = document.createElement('button');
		btn.className = 'core-btn region-pick-btn';
		btn.textContent = region.name;
		btn.onclick = () => startTeamBattle(region.id);
		row.appendChild(btn);
	}
	el.appendChild(row);
}

async function startTeamBattle(regionId) {
	try {
		const state = await api('/api/battle/start-team', {
			method: 'POST', headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ region: regionId }),
		});
		currentBattleId = state.battleId;
		renderedEventCount = 0;
		await applyState(state);
	} catch (err) {
		alert(err.message);
	}
}

function renderTeamScreen(player, roster) {
	document.getElementById('team-wallet').textContent =
		`Pokedollars: ${player.pokedollars} | Training Points: ${player.trainingPoints} | Team: ${teamPicks.size}/6`;

	const grid = document.getElementById('owned-grid');
	grid.innerHTML = '';
	if (!roster.length) {
		grid.innerHTML = '<p class="hint">You don\'t own any Pokemon yet - visit the Breeder Marketplace.</p>';
		return;
	}

	for (const mon of roster) {
		const card = document.createElement('div');
		card.className = 'roster-card owned-card' + (teamPicks.has(mon.id) ? ' on-team' : '');
		card.innerHTML = `
			<div class="roster-head">
				<img class="sprite" src="https://play.pokemonshowdown.com/sprites/gen5/${spriteId(mon.species)}.png" alt="">
				<div>
					<div class="roster-name">${mon.species}</div>
					<div class="roster-sub">Lv.${mon.level} - ${mon.ability} - ${mon.item}</div>
				</div>
				<button class="team-toggle-btn">${teamPicks.has(mon.id) ? 'On team' : 'Add to team'}</button>
			</div>
			<div class="roster-moves"></div>
			<div class="sp-grid"></div>
		`;
		card.querySelector('.team-toggle-btn').onclick = async () => {
			if (teamPicks.has(mon.id)) teamPicks.delete(mon.id);
			else if (teamPicks.size < 6) teamPicks.add(mon.id);
			else { alert('You can only bring up to 6 Pokemon.'); return; }
			try {
				await api('/api/roster/team', {
					method: 'POST', headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ ids: [...teamPicks] }),
				});
			} catch (err) {
				alert(err.message);
			}
			renderTeamScreen(player, roster);
		};

		const movesEl = card.querySelector('.roster-moves');
		mon.moves.forEach((moveName, mIdx) => {
			const btn = document.createElement('button');
			const isEditing = teamEditingSlot && teamEditingSlot.pokemonId === mon.id && teamEditingSlot.moveSlotIdx === mIdx;
			btn.className = 'roster-move-btn' + (isEditing ? ' editing' : '');
			btn.textContent = moveName;
			btn.onclick = async () => {
				if (isEditing) { teamEditingSlot = null; renderTeamScreen(player, roster); return; }
				teamEditingSlot = { pokemonId: mon.id, moveSlotIdx: mIdx };
				if (!teamMovepoolCache[mon.id]) {
					const q = encodeURIComponent(mon.moves.join(','));
					const { movepool } = await api(`/api/movepool/${encodeURIComponent(mon.species)}?presets=${q}`);
					teamMovepoolCache[mon.id] = movepool;
				}
				renderTeamScreen(player, roster);
			};
			movesEl.appendChild(btn);
		});
		if (teamEditingSlot && teamEditingSlot.pokemonId === mon.id && teamMovepoolCache[mon.id]) {
			card.appendChild(renderOwnedMovepoolPanel(mon, teamEditingSlot.moveSlotIdx, player, roster));
		}

		renderSpGrid(card.querySelector('.sp-grid'), mon, player, roster);
		grid.appendChild(card);
	}
}

function renderOwnedMovepoolPanel(mon, moveSlotIdx, player, roster) {
	const panel = document.createElement('div');
	panel.className = 'movepool-panel';
	const search = document.createElement('input');
	search.className = 'movepool-search';
	search.placeholder = 'Search moves...';
	panel.appendChild(search);
	const list = document.createElement('div');
	panel.appendChild(list);

	function renderList(filter) {
		list.innerHTML = '';
		const q = filter.trim().toLowerCase();
		for (const move of teamMovepoolCache[mon.id]) {
			if (q && !move.name.toLowerCase().includes(q)) continue;
			const opt = document.createElement('button');
			const isCurrent = mon.moves[moveSlotIdx] === move.name;
			opt.className = 'movepool-option' + (isCurrent ? ' current' : '');
			opt.textContent = isCurrent ? `${move.name} (current)` : move.name;
			opt.onclick = async () => {
				const newMoves = [...mon.moves];
				newMoves[moveSlotIdx] = move.name;
				try {
					await api(`/api/roster/${mon.id}/moves`, {
						method: 'PATCH', headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ moves: newMoves }),
					});
					mon.moves = newMoves;
				} catch (err) {
					alert(err.message);
				}
				teamEditingSlot = null;
				renderTeamScreen(player, roster);
			};
			list.appendChild(opt);
		}
	}
	renderList('');
	search.oninput = () => renderList(search.value);
	return panel;
}

const SP_STATS = [['hp', 'HP'], ['atk', 'Atk'], ['def', 'Def'], ['spa', 'SpA'], ['spd', 'SpD'], ['spe', 'Spe']];

function renderSpGrid(el, mon, player, roster) {
	el.innerHTML = '';
	for (const [stat, label] of SP_STATS) {
		const row = document.createElement('div');
		row.className = 'sp-row';
		const value = mon.sp[stat] || 0;
		row.innerHTML = `
			<span class="sp-label">${label}</span>
			<button class="sp-btn sp-minus">-1</button>
			<span class="sp-value">${value}/32</span>
			<button class="sp-btn sp-plus">+1</button>
		`;
		row.querySelector('.sp-minus').onclick = async () => {
			if (value <= 0) return;
			await api(`/api/roster/${mon.id}/untrain`, {
				method: 'POST', headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ stat, amount: 1 }),
			});
			await reloadOwnedMon(mon, player, roster);
		};
		row.querySelector('.sp-plus').onclick = async () => {
			try {
				await api(`/api/roster/${mon.id}/train`, {
					method: 'POST', headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ stat, amount: 1 }),
				});
				await reloadOwnedMon(mon, player, roster);
			} catch (err) {
				alert(err.message);
			}
		};
		el.appendChild(row);
	}
}

async function reloadOwnedMon(mon, player, roster) {
	const { player: updatedPlayer, roster: updatedRoster } = await api('/api/player');
	renderTeamScreen(updatedPlayer, updatedRoster);
}

loadHome();
