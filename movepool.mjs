// Shared helper for the pre-battle "edit your rental's moves" screen: what
// moves is a given species actually allowed to swap in? Scoped to level-up
// and TM/TR learning (the methods a real rental Pokemon could plausibly know
// "out of the box"), not egg moves, tutor moves, or event-only moves - those
// need a specific parent/tutor/event to legitimately have, which doesn't fit
// "here's a rental, tweak its kit."
import { Dex } from './sim/index.ts';

// Showdown learnset method codes: "<gen><method>[extra]", e.g. "9L1" (level
// 1, gen 9), "8M" (machine, gen 8), "9E" (egg, gen 9), "7T" (tutor, gen 7).
// The method character is always the second character.
const ALLOWED_METHODS = new Set(['L', 'M']);

function isAllowedBySources(sources) {
	return sources.some(src => ALLOWED_METHODS.has(src[1]));
}

/**
 * @param {string} speciesName
 * @returns {{id: string, name: string}[]} sorted, deduplicated level-up/TM movepool
 */
export function getMovepool(speciesName) {
	const species = Dex.species.get(speciesName);
	let learnsetData = Dex.species.getLearnsetData(species.id);
	let learnable = learnsetData?.learnset || {};
	// Cosmetic formes (Gourgeist sizes, Oricorio styles, regional formes with
	// their own dex entry, etc.) often store their learnset only under the
	// base species id. Appliance Rotom formes are trickier: their OWN
	// learnset isn't empty, just tiny (only their signature move, e.g.
	// Rotom-Wash's own entry is just Hydro Pump) - the shared movepool lives
	// entirely under base Rotom - so always union with the base species'
	// learnset rather than only falling back when the forme's own learnset
	// is completely empty.
	if (species.baseSpecies && species.baseSpecies !== species.name) {
		const baseLearnsetData = Dex.species.getLearnsetData(Dex.toID(species.baseSpecies));
		learnable = { ...(baseLearnsetData?.learnset || {}), ...learnable };
	}

	const moves = [];
	for (const [moveId, sources] of Object.entries(learnable)) {
		if (!isAllowedBySources(sources)) continue;
		const moveData = Dex.moves.get(moveId);
		if (!moveData?.exists) continue;
		moves.push({ id: moveData.id, name: moveData.name });
	}
	moves.sort((a, b) => a.name.localeCompare(b.name));
	return moves;
}

/**
 * A rental's starting moveset is picked from its FULL learnset (see
 * build-regional-teams.mjs's buildMoveset), which can include an egg/tutor
 * move that isn't level-up/TM-learnable on its own. Those still need to
 * round-trip cleanly when the player leaves a slot untouched, so both the
 * offered movepool and validation always fold in a mon's original presets
 * regardless of method, on top of the real level-up/TM swap-in pool.
 * @param {string} speciesName
 * @param {string[]} presetMoves
 */
export function getMovepoolWithPresets(speciesName, presetMoves) {
	const pool = getMovepool(speciesName);
	const seen = new Set(pool.map(m => m.id));
	for (const name of presetMoves || []) {
		const moveData = Dex.moves.get(name);
		if (moveData?.exists && !seen.has(moveData.id)) {
			seen.add(moveData.id);
			pool.push({ id: moveData.id, name: moveData.name });
		}
	}
	pool.sort((a, b) => a.name.localeCompare(b.name));
	return pool;
}

/**
 * Validate a proposed 4-move replacement set against a species' real
 * level-up/TM movepool (plus its original preset moves - see
 * getMovepoolWithPresets). Returns the cleaned move NAME list on success, or
 * throws with a human-readable reason on failure.
 * @param {string} speciesName
 * @param {string[]} moveNames
 * @param {string[]} [presetMoves] the rental's original, pre-edit moveset
 * @returns {string[]}
 */
export function validateMoveset(speciesName, moveNames, presetMoves) {
	if (!Array.isArray(moveNames) || moveNames.length !== 4) {
		throw new Error(`${speciesName}: must choose exactly 4 moves`);
	}
	const pool = getMovepoolWithPresets(speciesName, presetMoves);
	const poolIds = new Set(pool.map(m => m.id));
	const seen = new Set();
	const cleaned = [];
	for (const name of moveNames) {
		const moveData = Dex.moves.get(name);
		if (!moveData?.exists) throw new Error(`${speciesName}: "${name}" isn't a real move`);
		if (!poolIds.has(moveData.id)) throw new Error(`${speciesName} can't learn ${moveData.name}`);
		if (seen.has(moveData.id)) throw new Error(`${speciesName}: ${moveData.name} is chosen twice`);
		seen.add(moveData.id);
		cleaned.push(moveData.name);
	}
	return cleaned;
}
