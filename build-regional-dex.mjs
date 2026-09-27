// Builds a "regional dex" per region: the species natively introduced in
// that region's generation, using each species' real National Dex number
// (Dex.species.get(...).num) pulled from Showdown's actual data - not
// hand-typed. Excludes non-standard entries (CAP mons, Pokestar, etc.),
// megas, Gmax forms, and battle-only formes, since those aren't things a
// trainer "catches" as a base roster entry.
//
// Note on scope: this groups by *where a species was originally introduced*
// (the common "regional dex = new Pokemon from that game" simplification),
// not the exact in-game Pokedex list of each title (which also includes
// many migrated older-gen species). Good enough as a starting roster/rental
// pool per region; regional variant forms (Alolan/Galarian/etc.) are noted
// separately since they share their base species' dex number.
import { Dex } from './sim/index.ts';
import { writeFileSync } from 'node:fs';

const REGIONS = [
	{ id: 'kanto', name: 'Kanto', gen: 1, min: 1, max: 151 },
	{ id: 'johto', name: 'Johto', gen: 2, min: 152, max: 251 },
	{ id: 'hoenn', name: 'Hoenn', gen: 3, min: 252, max: 386 },
	{ id: 'sinnoh', name: 'Sinnoh', gen: 4, min: 387, max: 493 },
	{ id: 'unova', name: 'Unova', gen: 5, min: 494, max: 649 },
	{ id: 'kalos', name: 'Kalos', gen: 6, min: 650, max: 721 },
	{ id: 'alola', name: 'Alola', gen: 7, min: 722, max: 809 },
	{ id: 'galar', name: 'Galar', gen: 8, min: 810, max: 905 },
	{ id: 'paldea', name: 'Paldea', gen: 9, min: 906, max: 1025 },
];

const speciesList = [];
for (const key in Dex.data.Pokedex) {
	const species = Dex.species.get(key);
	if (!species?.exists) continue;
	speciesList.push(species);
}

function isBaseRosterEntry(species) {
	if (!species.num || species.num <= 0) return false; // CAP / special
	if (species.battleOnly) return false; // auto-transforms in battle (Cramorant, Eiscue, Morpeko, etc.) - not a pick
	if (species.forme) {
		// Exclude clearly non-catchable / cosmetic-only / battle-only forms.
		const excludeFormeKeywords = [
			'Mega', 'Gmax', 'Totem', 'Primal', 'Origin', 'Therian', 'Crowned',
			'Eternamax', 'Ash', 'Battle-Bond', 'Starter', 'Cosplay', 'Rock-Star',
			'Belle', 'Pop-Star', 'PhD', 'Libre', 'World', 'Hero', 'Zenith',
			// Purely cosmetic flavor/color variants with no mechanical difference
			'Swirl', 'Cream', 'Dada', 'Antique', 'Caramel', 'Lemon', 'Matcha',
			'Mint', 'Ruby', 'Rainbow', 'Salted', 'Vanilla',
		];
		if (excludeFormeKeywords.some(k => species.forme.includes(k))) return false;
	}
	if (species.isNonstandard && ['CAP', 'Custom', 'Pokestar'].includes(species.isNonstandard)) return false;
	return true;
}

const regionalDex = {};
for (const region of REGIONS) {
	const entries = speciesList
		.filter(s => s.num >= region.min && s.num <= region.max)
		.filter(isBaseRosterEntry)
		.sort((a, b) => a.num - b.num || a.forme?.localeCompare(b.forme || '') || 0)
		.map(s => ({
			id: s.id,
			name: s.name,
			num: s.num,
			types: s.types,
			forme: s.forme || null,
			baseSpecies: s.baseSpecies !== s.name ? s.baseSpecies : null,
			fullyEvolved: !s.evos || s.evos.length === 0,
			nfe: !!(s.evos && s.evos.length),
		}));
	regionalDex[region.id] = {
		name: region.name,
		generation: region.gen,
		dexRange: [region.min, region.max],
		count: entries.length,
		species: entries,
	};
}

writeFileSync('./regional-dex.json', JSON.stringify(regionalDex, null, 2));

console.log('=== Regional Dex Summary ===');
for (const region of REGIONS) {
	const r = regionalDex[region.id];
	const fullyEvolvedCount = r.species.filter(s => s.fullyEvolved).length;
	console.log(`${r.name.padEnd(8)} (Gen ${r.generation}): ${r.count} entries, ${fullyEvolvedCount} fully evolved`);
}
