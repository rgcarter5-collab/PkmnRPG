// Stat Points (SP) training system - a Pokemon-Champions-style replacement
// for manually thinking in EVs. Player-facing concept is simple: 66 SP per
// Pokemon, 32 SP max per individual stat, every SP is worth +1 to that stat
// at level 50. Internally we convert SP to real EVs so Showdown's actual
// battle math (which only understands EVs/IVs/nature) stays 100% accurate -
// this is a presentation-layer simplification, not a different game engine.
//
// IVs are not modeled as a separate concept at all: every Pokemon is treated
// as having perfect (31) IVs everywhere, same as the system it's inspired by.

export const SP_TOTAL_CAP = 66;
export const SP_PER_STAT_CAP = 32;
export const EV_PER_SP = 8; // 8 EV = +1 stat at level 50 (standard formula)
export const EV_PER_STAT_CAP = 252; // Showdown's real per-stat EV ceiling
export const TP_COST_PER_SP = 5; // Training Points cost to add 1 SP
export const STATS = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];

export class TrainingError extends Error {}

/** Convert an SP allocation ({hp,atk,def,spa,spd,spe} each 0-32) to the EVs
 * Showdown's engine actually uses. Clamps to the engine's real per-stat cap
 * so a full 32 SP (256 EV nominal) never exceeds what the sim allows. */
export function spToEVs(sp) {
	const evs = {};
	for (const stat of STATS) {
		const points = sp[stat] || 0;
		evs[stat] = Math.min(points * EV_PER_SP, EV_PER_STAT_CAP);
	}
	return evs;
}

/** Reverse conversion, for migrating existing hand-authored EV spreads (like
 * the ones already baked into regional-teams.json) into their SP-system
 * equivalent so old and new data speak the same language. Lossy above the
 * 252 EV cap (256 would be needed for a "true" 32 SP, so 252 rounds to 31). */
export function evsToSP(evs) {
	const sp = {};
	for (const stat of STATS) {
		sp[stat] = Math.min(Math.round((evs[stat] || 0) / EV_PER_SP), SP_PER_STAT_CAP);
	}
	return sp;
}

export function totalSP(sp) {
	return STATS.reduce((sum, stat) => sum + (sp[stat] || 0), 0);
}

export function emptySP() {
	return { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 };
}

/** Validate an SP allocation is legal on its own terms (caps respected),
 * independent of whether the player can currently afford it. */
export function validateSP(sp) {
	for (const stat of STATS) {
		const v = sp[stat] || 0;
		if (v < 0) throw new TrainingError(`${stat} SP cannot be negative`);
		if (v > SP_PER_STAT_CAP) throw new TrainingError(`${stat} SP cannot exceed ${SP_PER_STAT_CAP}`);
	}
	const total = totalSP(sp);
	if (total > SP_TOTAL_CAP) {
		throw new TrainingError(`Total SP (${total}) exceeds the ${SP_TOTAL_CAP} cap`);
	}
}

/**
 * Spend Training Points to add SP to one stat. Returns the new SP object and
 * remaining TP balance; throws TrainingError (nothing is mutated) if the cap
 * would be exceeded or the player can't afford it.
 */
export function trainStat(currentSP, stat, amount, tpBalance) {
	if (!STATS.includes(stat)) throw new TrainingError(`Unknown stat: ${stat}`);
	if (amount <= 0) throw new TrainingError('amount must be positive - use removeStat to lower SP');

	const next = { ...currentSP, [stat]: (currentSP[stat] || 0) + amount };
	validateSP(next); // throws if per-stat or total cap exceeded

	const cost = amount * TP_COST_PER_SP;
	if (cost > tpBalance) {
		throw new TrainingError(`Not enough TP: need ${cost}, have ${tpBalance}`);
	}

	return { sp: next, tpBalance: tpBalance - cost, tpSpent: cost };
}

/** Removing SP is always free (encourages experimentation, matches the
 * source system this is modeled on). */
export function removeStat(currentSP, stat, amount) {
	if (!STATS.includes(stat)) throw new TrainingError(`Unknown stat: ${stat}`);
	const next = { ...currentSP, [stat]: Math.max(0, (currentSP[stat] || 0) - amount) };
	return { sp: next };
}

/** Given a species' natural stat-priority (from build-regional-teams.mjs's
 * role classification), suggest a default SP spread. Used to seed a newly
 * "unlocked" Pokemon at Champions League with something reasonable rather
 * than all zeros, or to regenerate the pre-Champions-League fixed spread
 * directly in SP terms instead of going through raw EVs. */
export function suggestSpread(role, isPhysicalAttacker) {
	const sp = emptySP();
	if (role === 'wall') {
		sp.hp = 32; sp.def = 17; sp.spd = 17; // 66 total
	} else if (role === 'trickroom-abuser') {
		sp.hp = 32; sp[isPhysicalAttacker ? 'atk' : 'spa'] = 32; sp.def = 2;
	} else {
		sp[isPhysicalAttacker ? 'atk' : 'spa'] = 32; sp.spe = 32; sp.hp = 2;
	}
	validateSP(sp);
	return sp;
}
