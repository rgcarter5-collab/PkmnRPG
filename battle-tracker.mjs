// Shared "what a single side can see" state tracker, extracted from
// TieredAI so both AI opponents and the human-facing game server can build
// identical fog-of-war state (species, HP fraction, status, protect streak)
// from the public battle protocol lines a player stream receives. Neither
// side gets the opponent's exact HP or PP - just what the real protocol
// exposes (percentage/fraction, faint, status, switches).
import { Dex, toID } from './sim/index.ts';

export function parseDetails(details) {
	// "Charizard, L50, F" / "Ditto, F" (implicit L100) / "Zoroark-Hisui, L50, M"
	const parts = details.split(',').map(s => s.trim());
	const speciesName = parts[0];
	const levelPart = parts.find(p => /^L\d+$/.test(p));
	const level = levelPart ? parseInt(levelPart.slice(1), 10) : 100;
	return { speciesName, level };
}

export function parseHP(str) {
	if (str.includes('fnt')) return { hpFraction: 0, fainted: true };
	const [cur, max] = str.split('/').map(s => parseInt(s, 10));
	if (!max) return { hpFraction: undefined };
	return { hpFraction: cur / max, fainted: false };
}

// Real Protect-family success chance halves each consecutive use.
// `moveData.stallingMove` is the real family marker on Protect's own move
// data - NOT `moveData.flags.protect`, which is set on ordinary attacking
// moves (Tackle, Fake Out, ...) to mean "this move can be stopped by
// Protect", a different thing entirely.
export function isSelfStallMove(moveData) {
	return !!moveData.stallingMove;
}

/** Create an empty seen-state store: position ("p1a") -> tracked info. */
export function createSeenTracker() {
	return {};
}

/** Feed one raw protocol line into a seen-state store, mutating it in place. */
export function trackSeenLine(seen, line) {
	const parts = line.split('|');
	const cmd = parts[1];

	if (cmd === 'switch' || cmd === 'drag') {
		const pos = parts[2].split(':')[0].trim();
		const { speciesName, level } = parseDetails(parts[3]);
		seen[pos] = { species: Dex.species.get(speciesName), level, status: '', protectStreak: 0, ...parseHP(parts[4]) };
	} else if (cmd === 'move') {
		const pos = parts[2].split(':')[0].trim();
		const moveData = Dex.moves.get(toID(parts[3]));
		if (seen[pos]) {
			seen[pos].protectStreak = isSelfStallMove(moveData) ? (seen[pos].protectStreak || 0) + 1 : 0;
		}
	} else if (cmd === '-damage' || cmd === '-heal' || cmd === '-sethp') {
		const pos = parts[2].split(':')[0].trim();
		if (seen[pos]) Object.assign(seen[pos], parseHP(parts[3]));
	} else if (cmd === 'faint') {
		const pos = parts[2].split(':')[0].trim();
		if (seen[pos]) seen[pos].fainted = true;
	} else if (cmd === '-status') {
		const pos = parts[2].split(':')[0].trim();
		if (seen[pos]) seen[pos].status = parts[3];
	} else if (cmd === '-curestatus') {
		const pos = parts[2].split(':')[0].trim();
		if (seen[pos]) seen[pos].status = '';
	}
}
