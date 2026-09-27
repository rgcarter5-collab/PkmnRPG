// TieredAI v2: a heuristic battle AI whose skill is controlled by one knob
// (`tier`). Unlike v1, this does NOT subclass RandomPlayerAI's move-choice
// flow (that class randomizes single-target foe slots *before* handing
// choices to chooseMove, which made real target selection impossible) —
// instead it implements its own `receiveRequest` for the `active` case,
// generating every real (move, target) combination itself so scoring and
// target selection both matter. Switches and team preview still delegate to
// RandomPlayerAI's implementation, which is fine as-is for now.
import { Dex } from './sim/index.ts';
import { RandomPlayerAI } from './sim/tools/random-player-ai.ts';
import { createSeenTracker, trackSeenLine, parseDetails, parseHP, isSelfStallMove } from './battle-tracker.mjs';

// Each tier is a discrete probability distribution over "roll" 1-10, where
// 10 = the objectively best available (move, target) pair, 1 = the worst.
export const TIERS = {
	1: { name: 'Pokeball', rollWeights: [3, 4, 6, 8, 10, 12, 14, 13, 12, 8] },
	2: { name: 'Great Ball', rollWeights: [1, 2, 3, 5, 8, 12, 16, 18, 19, 16] },
	3: { name: 'Ultra Ball', rollWeights: [0, 1, 1, 2, 3, 6, 10, 18, 27, 32] },
	4: { name: 'Master', rollWeights: [0, 0, 0, 0, 0, 0, 0, 0, 0, 100] },
};

function weightedRollIndex(weights, prng) {
	const total = weights.reduce((a, b) => a + b, 0);
	let r = prng.random() * total;
	for (let i = 0; i < weights.length; i++) {
		if (r < weights[i]) return i; // 0 = worst .. weights.length-1 = best
		r -= weights[i];
	}
	return weights.length - 1;
}

// Approximate a stat at a given level assuming neutral nature, 31 IV, 0 EV.
// Good enough for AI scoring purposes; not meant to match exact opponent
// investment (which we can't see anyway from the protocol).
function estimateStat(base, level) {
	return Math.floor(Math.floor((2 * base + 31) * level / 100) + 5);
}

// Discount raw damage-fraction scoring for moves with a real structural
// downside our simple estimator doesn't otherwise see: a forced recharge
// turn (Hyper Beam, Giga Impact) or a charge-up turn (Solar Beam, Sky
// Attack) both effectively give the opponent a free turn afterward.
function riskMultiplier(moveData) {
	if (moveData.flags?.recharge) return 0.45;
	if (moveData.flags?.charge) return 0.65;
	return 1;
}

// Wide Guard / Quick Guard aren't stallingMove (they don't stall the user,
// they block the whole side against spread/priority moves respectively),
// but they're the same "protect-ish" utility bucket for scoring purposes.
function isSideProtectMove(moveData) {
	return moveData.id === 'wideguard' || moveData.id === 'quickguard';
}

export class TieredAI extends RandomPlayerAI {
	constructor(playerStream, tier, options = {}, debug = false) {
		super(playerStream, options, debug);
		this.tier = tier;
		this.tierConfig = TIERS[tier];
		if (!this.tierConfig) throw new Error(`Unknown AI tier: ${tier}`);
		this.seen = createSeenTracker(); // position ("p1a") -> { species, level, hpFraction, fainted, status }
	}

	// The game will send a followup request when a choice is rejected for any
	// reason (locked into a two-turn move like Bounce/Fly with no target
	// needed on the release turn, a move we thought was legal but wasn't,
	// etc). RandomPlayerAI only swallows the "[Unavailable choice]" case;
	// treat any bracketed rejection reason the same way instead of crashing.
	receiveError(error) {
		if (/^\[.*choice\]/i.test(error.message)) return;
		throw error;
	}

	receiveLine(line) {
		trackSeenLine(this.seen, line);
		return super.receiveLine(line);
	}

	receiveRequest(request) {
		if (request.wait) return;

		if (request.active && !request.forceSwitch) {
			this._sideId = request.side.id;
			return this.chooseActive(request);
		}

		// team preview / forceSwitch: delegate to RandomPlayerAI's handling
		return super.receiveRequest(request);
	}

	// Estimate the raw damage a move deals from attacker position to target
	// position, as a fraction of the target's current max HP. Ignores crits,
	// random damage roll, item/ability damage modifiers, and stat stage
	// boosts - a deliberately simple proxy good enough for move ranking.
	estimateDamageFraction(moveData, attackerPos, targetPos) {
		const attacker = this.seen[attackerPos];
		const target = this.seen[targetPos];
		if (!attacker?.species || !target?.species || target.fainted) return 0;

		const immune = !Dex.getImmunity(moveData.type, target.species);
		if (immune) return 0;

		const isPhysical = moveData.category === 'Physical';
		const atkBase = isPhysical ? attacker.species.baseStats.atk : attacker.species.baseStats.spa;
		const defBase = isPhysical ? target.species.baseStats.def : target.species.baseStats.spd;
		const atkStat = estimateStat(atkBase, attacker.level);
		const defStat = estimateStat(defBase, target.level);

		const level = attacker.level;
		let damage = (((2 * level / 5 + 2) * moveData.basePower * atkStat / defStat) / 50) + 2;

		if (attacker.species.types.includes(moveData.type)) damage *= 1.5; // STAB
		const eff = Dex.getEffectiveness(moveData.type, target.species);
		damage *= Math.pow(2, eff);

		const targetMaxHPEstimate = estimateStat(target.species.baseStats.hp, target.level) + target.level + 5; // rough HP formula
		return Math.max(0, damage / targetMaxHPEstimate);
	}

	// Build the full list of legal (move, target) choices for one active slot,
	// each scored 0-100+ as "expected value" of taking that action.
	buildScoredChoices(myPos, activeData, pokemonState) {
		const results = [];
		const oppPrefix = myPos.startsWith('p1') ? 'p2' : 'p1';
		const allyPos = myPos.endsWith('a') ? myPos.slice(0, -1) + 'b' : myPos.slice(0, -1) + 'a';
		const foePositions = [oppPrefix + 'a', oppPrefix + 'b'];

		for (let slot = 1; slot <= activeData.moves.length; slot++) {
			const moveInfo = activeData.moves[slot - 1];
			if (moveInfo.disabled) continue;
			const moveData = Dex.moves.get(moveInfo.id);
			if (!moveData?.exists) continue;

			const isStatus = !moveData.basePower || moveData.category === 'Status';

			if (isStatus) {
				let utility = 35;
				if (isSelfStallMove(moveData)) {
					// Real Protect-family success chance halves each consecutive
					// use, so discount our own utility the same way instead of
					// spamming it at full value turn after turn.
					const streak = pokemonState.protectStreak || 0;
					utility = Math.max(6, Math.round(38 * Math.pow(0.5, streak)));
				} else if (isSideProtectMove(moveData)) {
					utility = 38;
				} else if (moveData.id === 'sleeppowder' || moveData.id === 'spore' || moveData.id === 'stunspore') {
					// Not very useful if both foes already have a status
					const bothStatused = foePositions.every(p => this.seen[p]?.status);
					utility = bothStatused ? 15 : 55;
				} else if (moveData.id === 'destinybond') {
					const meLow = pokemonState.hpFraction !== undefined && pokemonState.hpFraction < 0.25;
					utility = meLow ? 60 : 20;
				}
				results.push({ choice: `move ${slot}`, label: moveData.name, score: utility });
				continue;
			}

			// Damaging move: figure out its real target(s).
			if (moveData.target === 'normal' || moveData.target === 'any' || moveData.target === 'adjacentFoe') {
				for (const foePos of foePositions) {
					if (this.seen[foePos]?.fainted) continue;
					const frac = this.estimateDamageFraction(moveData, myPos, foePos);
					const targetSlot = foePos === foePositions[0] ? 1 : 2;
					const koBonus = frac >= (this.seen[foePos]?.hpFraction ?? 1) ? 1.4 : 1;
					// `moveData.flags.protect` correctly means "this attack can be
					// stopped by Protect" (unlike stallingMove, which marks Protect
					// itself). Use it here: if the foe protected last turn, their
					// next Protect attempt is less likely to succeed, so a move
					// that would otherwise be walled by it is worth pushing through.
					const foeStreak = this.seen[foePos]?.protectStreak || 0;
					const breakThroughBonus = (moveData.flags?.protect && foeStreak > 0) ?
						1 + 0.15 * Math.min(foeStreak, 3) : 1;
					results.push({
						choice: `move ${slot} ${targetSlot}`,
						label: `${moveData.name} -> ${foePos}`,
						score: Math.round(frac * 100 * koBonus * riskMultiplier(moveData) * breakThroughBonus),
					});
				}
			} else if (moveData.target === 'allAdjacentFoes') {
				let total = 0;
				let count = 0;
				for (const foePos of foePositions) {
					if (this.seen[foePos]?.fainted) continue;
					total += this.estimateDamageFraction(moveData, myPos, foePos);
					count++;
				}
				results.push({
					choice: `move ${slot}`,
					label: `${moveData.name} (spread foes)`,
					score: Math.round((count ? total / count : 0) * 100 * (count > 1 ? 1.3 : 1) * riskMultiplier(moveData)), // bonus for hitting both
				});
			} else if (moveData.target === 'allAdjacent') {
				// Hits both foes AND our own ally - real friendly fire.
				let foeTotal = 0;
				let foeCount = 0;
				for (const foePos of foePositions) {
					if (this.seen[foePos]?.fainted) continue;
					foeTotal += this.estimateDamageFraction(moveData, myPos, foePos);
					foeCount++;
				}
				let allyPenalty = 0;
				const ally = this.seen[allyPos];
				if (ally && !ally.fainted) {
					const allyFrac = this.estimateDamageFraction(moveData, myPos, allyPos);
					// Penalize harder if it would meaningfully hurt or KO our ally
					allyPenalty = allyFrac * (allyFrac >= (ally.hpFraction ?? 1) ? 90 : 60);
				}
				const foeAvg = foeCount ? foeTotal / foeCount : 0;
				results.push({
					choice: `move ${slot}`,
					label: `${moveData.name} (spread incl. ally)`,
					score: Math.round((foeAvg * 100 * (foeCount > 1 ? 1.3 : 1) * riskMultiplier(moveData)) - allyPenalty),
				});
			} else if (moveData.target === 'adjacentAlly') {
				// Support move on ally - only legal if ally alive; low priority
				// heuristically for now (heals/buffs aren't damage-scored here).
				const ally = this.seen[allyPos];
				if (ally && !ally.fainted) {
					const negSlot = myPos.endsWith('a') ? -2 : -1;
					results.push({ choice: `move ${slot} ${negSlot}`, label: `${moveData.name} -> ally`, score: 30 });
				}
			} else {
				// self, allySide, foeSide, all, adjacentAllyOrSelf, etc.
				let total = 0, count = 0;
				for (const foePos of foePositions) {
					if (this.seen[foePos]?.fainted) continue;
					total += this.estimateDamageFraction(moveData, myPos, foePos);
					count++;
				}
				results.push({
					choice: `move ${slot}`,
					label: `${moveData.name} (field/self)`,
					score: Math.round((count ? total / count : 0) * 100) || 30,
				});
			}
		}

		return results;
	}

	chooseActive(request) {
		const pokemon = request.side.pokemon;
		const chosen = [];

		const choices = request.active.map((activeData, i) => {
			if (pokemon[i].condition.endsWith(' fnt') || pokemon[i].commanding) return 'pass';

			const myPos = `${this._sideId}${i === 0 ? 'a' : 'b'}`;
			// keep our own tracked state fresh from the authoritative request
			const { speciesName, level } = parseDetails(pokemon[i].details);
			this.seen[myPos] = {
				...(this.seen[myPos] || {}),
				species: Dex.species.get(speciesName),
				level,
				...parseHP(pokemon[i].condition),
			};

			let scored = this.buildScoredChoices(myPos, activeData, this.seen[myPos]);

			// Fallback: if everything got filtered out (e.g. all foes fainted
			// and only foe-targeted moves existed), allow struggle/pass safety.
			if (!scored.length) {
				scored = [{ choice: 'move 1', label: 'fallback', score: 1 }];
			}

			scored.sort((a, b) => b.score - a.score);
			const roll = weightedRollIndex(this.tierConfig.rollWeights, this.prng);
			const index = Math.round(((this.tierConfig.rollWeights.length - 1 - roll) /
				(this.tierConfig.rollWeights.length - 1)) * (scored.length - 1));
			const picked = scored[index];

			if (this.debug) {
				console.log(
					`[${this.tierConfig.name} ${myPos}] roll=${roll + 1}/10 -> "${picked.label}" (${picked.score}) ` +
					`from [${scored.map(s => `${s.label}:${s.score}`).join(', ')}]`
				);
			}

			return picked.choice;
		});

		this.choose(choices.join(', '));
	}
}
