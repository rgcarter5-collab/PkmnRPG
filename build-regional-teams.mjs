// Builds regional TEAMS: for each region, a handful of named teams (soft
// archetypes: Tailwind offense / Trick Room / Weather / Balance), each with
// a roster of real, fully-evolved, non-legendary/mythical species from that
// region's dex, real learnable movesets (pulled from actual Showdown
// learnset data - not invented), sensible items/natures/EVs by role.
//
// Also builds simpler City League "rental cores" per region: small 2-mon
// preset squads for the tier-1 intro tournament.
import { Dex } from './sim/index.ts';
import { readFileSync, writeFileSync } from 'node:fs';

const regionalDex = JSON.parse(readFileSync('./regional-dex.json', 'utf8'));

const WEATHER_SETTERS = {
	drought: 'Sun', drizzle: 'Rain', sandstream: 'Sand', snowwarning: 'Snow',
};
const WEATHER_ABUSERS = {
	chlorophyll: 'Sun', solarpower: 'Sun', flowergift: 'Sun',
	swiftswim: 'Rain', raindish: 'Rain',
	sandrush: 'Sand', sandforce: 'Sand', sandveil: 'Sand',
	slushrush: 'Snow', iceshellf: 'Snow',
};

function abilityEntries(species) {
	// [name, id] pairs for every ability slot (0, 1, H, ...) - not just slot 0,
	// since a species' most relevant ability (e.g. Pelipper's Drizzle) is very
	// often NOT its first-listed one.
	return Object.values(species.abilities || {}).map(name => [name, Dex.toID(name)]);
}

function classify(species) {
	const abilities = abilityEntries(species);
	const spe = species.baseStats.spe;
	const bulk = species.baseStats.hp + species.baseStats.def + species.baseStats.spd;
	const setterEntry = abilities.find(([, id]) => WEATHER_SETTERS[id]);
	const abuserEntry = abilities.find(([, id]) => WEATHER_ABUSERS[id]);

	if (setterEntry) return { role: 'weather-setter', weather: WEATHER_SETTERS[setterEntry[1]], ability: setterEntry[0] };
	if (abuserEntry) return { role: 'weather-abuser', weather: WEATHER_ABUSERS[abuserEntry[1]], ability: abuserEntry[0] };
	if (spe <= 60 && (species.baseStats.atk >= 90 || species.baseStats.spa >= 90)) return { role: 'trickroom-abuser' };
	if (spe >= 100) return { role: 'tailwind-abuser' };
	if (bulk >= 260) return { role: 'wall' };
	return { role: 'balance' };
}

function isPhysical(species) {
	return species.baseStats.atk >= species.baseStats.spa;
}

function pickEVsAndNature(species, role) {
	const phys = isPhysical(species);
	if (role === 'wall') {
		return { evs: { hp: 252, def: 128, spd: 128 }, nature: 'Sassy' };
	}
	if (role === 'trickroom-abuser') {
		return phys
			? { evs: { hp: 252, atk: 252, def: 4 }, nature: 'Brave' }
			: { evs: { hp: 252, spa: 252, def: 4 }, nature: 'Quiet' };
	}
	// tailwind-abuser, weather-abuser, weather-setter, balance: standard fast attacker spread
	return phys
		? { evs: { hp: 4, atk: 252, spe: 252 }, nature: 'Adamant' }
		: { evs: { hp: 4, spa: 252, spe: 252 }, nature: 'Timid' };
}

function pickItem(species, role, bstRank) {
	if (role === 'wall') return 'Leftovers';
	if (species.baseStats.hp <= 70 && bstRank === 'top') return 'Focus Sash';
	if (!isPhysical(species) && species.baseStats.hp + species.baseStats.spd >= 190) return 'Assault Vest';
	if (role === 'weather-setter') return 'Leftovers';
	return isPhysical(species) ? 'Life Orb' : 'Life Orb';
}

// Build a legal, reasonable 4-move set from the species' real learnset.
function buildMoveset(species, role, weatherTag) {
	let learnsetData = Dex.species.getLearnsetData(species.id);
	let learnable = learnsetData?.learnset ? Object.keys(learnsetData.learnset) : [];
	// Cosmetic formes (Gourgeist sizes, Oricorio styles, etc.) often store
	// their learnset only under the base species id. Appliance Rotom formes
	// are the trickier case: their OWN learnset isn't empty, just tiny (only
	// their signature move, e.g. Rotom-Wash's own entry is just Hydro Pump) -
	// the shared movepool lives entirely under base Rotom - so always union
	// with the base species' learnset rather than only falling back when the
	// forme's own learnset is completely empty.
	if (species.baseSpecies && species.baseSpecies !== species.name) {
		const baseLearnsetData = Dex.species.getLearnsetData(Dex.toID(species.baseSpecies));
		const baseLearnable = baseLearnsetData?.learnset ? Object.keys(baseLearnsetData.learnset) : [];
		learnable = [...new Set([...learnable, ...baseLearnable])];
	}
	const has = id => learnable.includes(id);

	// Zero to Hero only triggers when its Pokemon switches OUT - so Palafin's
	// rental set needs a way to do that on its own turn (a self-switch move)
	// rather than just waiting on a forced switch to ever transform.
	if (species.id === 'palafin' && has('flipturn')) {
		const rest = ['wavecrash', 'aquatail', 'ironhead', 'protect'].filter(has);
		return ['Flip Turn', ...rest].slice(0, 4).map(id => Dex.moves.get(id).name);
	}

	// Pelipper's job on this core is setting Tailwind for the rest of the
	// team, not attacking - guarantee it regardless of its weather-setter role.
	if (species.id === 'pelipper' && has('tailwind')) {
		const rest = ['hurricane', 'scald', 'roost', 'protect', 'knockoff'].filter(has);
		return ['Tailwind', ...rest].slice(0, 4).map(id => Dex.moves.get(id).name);
	}

	// Whimsicott should be a Tailwind setter wherever it shows up - Prankster
	// makes its Tailwind go off before almost anything else in the format.
	if (species.id === 'whimsicott' && has('tailwind')) {
		const rest = ['moonblast', 'taunt', 'protect', 'encore'].filter(has);
		return ['Tailwind', ...rest].slice(0, 4).map(id => Dex.moves.get(id).name);
	}

	const phys = isPhysical(species);
	const category = phys ? 'Physical' : 'Special';

	const candidates = learnable
		.map(id => Dex.moves.get(id))
		.filter(m => m?.exists);

	const damaging = candidates.filter(m => m.basePower > 0 && m.category !== 'Status');
	const stab = damaging.filter(m => species.types.includes(m.type));
	const nonStab = damaging.filter(m => !species.types.includes(m.type));

	const score = m => m.basePower * (species.types.includes(m.type) ? 1.5 : 1) *
		(m.category === category || m.category === 'Physical' && phys || m.category === 'Special' && !phys ? 1 : 0.6);

	stab.sort((a, b) => score(b) - score(a));
	nonStab.sort((a, b) => score(b) - score(a));

	const moves = [];
	if (stab[0]) moves.push(stab[0].id);
	if (stab[1] && stab[1].id !== stab[0]?.id) moves.push(stab[1].id);
	for (const m of nonStab) {
		if (moves.length >= 3) break;
		if (!moves.includes(m.id)) moves.push(m.id);
	}

	// 4th slot: role-specific utility if learnable, else Protect, else best remaining damaging move.
	const statusPool = candidates.filter(m => m.category === 'Status');
	let utility = null;
	if (role === 'tailwind-abuser' && has('tailwind')) utility = 'tailwind';
	else if (role === 'trickroom-abuser' && has('trickroom')) utility = 'trickroom';
	else if (role === 'weather-setter' && weatherTag) {
		const weatherMove = { Sun: 'sunnyday', Rain: 'raindance', Sand: 'sandstorm', Snow: 'snowscape' }[weatherTag];
		if (has(weatherMove)) utility = weatherMove;
	}
	if (!utility && has('protect')) utility = 'protect';
	if (!utility) {
		const remaining = damaging.find(m => !moves.includes(m.id));
		utility = remaining?.id || statusPool[0]?.id;
	}
	if (utility && !moves.includes(utility)) moves.push(utility);

	while (moves.length < 4 && damaging[moves.length]) moves.push(damaging[moves.length].id);

	return moves.slice(0, 4).map(id => Dex.moves.get(id).name);
}

function buildSet(species, role, weatherTag, bstRank, ability, movesOverride, itemOverride) {
	const { evs, nature } = pickEVsAndNature(species, role);
	return {
		species: species.name,
		ability: ability || species.abilities['0'],
		item: itemOverride || pickItem(species, role, bstRank),
		moves: movesOverride || buildMoveset(species, role, weatherTag),
		nature,
		evs: { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0, ...evs },
		level: 50,
		teraType: species.types[Math.floor(Math.random() * species.types.length)],
	};
}

const ARCHETYPES = [
	{ tag: 'tailwind-offense', name: 'Tailwind Offense', wantRoles: ['tailwind-abuser', 'balance'] },
	{ tag: 'trick-room', name: 'Trick Room', wantRoles: ['trickroom-abuser', 'wall'] },
	{ tag: 'weather', name: 'Weather', wantRoles: ['weather-setter', 'weather-abuser'] },
	{ tag: 'balance', name: 'Balance', wantRoles: ['balance', 'wall', 'tailwind-abuser'] },
];

function bstOf(species) {
	const b = species.baseStats;
	return b.hp + b.atk + b.def + b.spa + b.spd + b.spe;
}

// Species with multiple mechanically-identical cosmetic formes (color/pattern
// only, no stat/type/ability difference) - keep just the base forme so
// rosters aren't padded with redundant picks.
const COSMETIC_MULTIFORME_BASES = ['Vivillon', 'Minior', 'Furfrou', 'Squawkabilly', 'Basculin', 'Tatsugiri'];

// A few DLC-era Paradox Pokemon (The Indigo Disk) aren't tagged 'Paradox' in
// this data snapshot - exclude by id explicitly so they don't slip through
// the tags-based filter below.
const UNTAGGED_PARADOX_IDS = ['ragingbolt', 'ironboulder', 'ironcrown', 'gougingfire'];
function isCosmeticDuplicateForme(species) {
	return COSMETIC_MULTIFORME_BASES.includes(species.baseSpecies) && species.name !== species.baseSpecies;
}

function buildRegionTeams(regionId) {
	const region = regionalDex[regionId];
	const pool = region.species
		.map(s => Dex.species.get(s.id))
		.filter(s => s.exists)
		.filter(s => {
			const full = region.species.find(e => e.id === s.id);
			return full?.fullyEvolved;
		})
		.filter(s => !isCosmeticDuplicateForme(s))
		.filter(s => !(s.tags || []).some(t => ['Mythical', 'Sub-Legendary', 'Restricted Legendary', 'Ultra Beast', 'Paradox'].includes(t)) && !UNTAGGED_PARADOX_IDS.includes(s.id));

	const classified = pool.map(s => ({ species: s, ...classify(s), bst: bstOf(s) }));
	classified.sort((a, b) => b.bst - a.bst);
	const median = classified[Math.floor(classified.length / 2)]?.bst || 400;

	const used = new Set();
	const teams = ARCHETYPES.map(archetype => {
		const weatherTag = archetype.tag === 'weather'
			? (classified.find(c => c.role === 'weather-setter' && !used.has(c.species.id))?.weather || 'Sun')
			: null;

		let candidates = classified.filter(c => !used.has(c.species.id) && archetype.wantRoles.includes(c.role));
		if (archetype.tag === 'weather') {
			candidates = candidates.filter(c => !c.weather || c.weather === weatherTag);
		}
		// top up with balance mons if archetype pool is thin
		if (candidates.length < 6) {
			const fallback = classified.filter(c => !used.has(c.species.id) && !candidates.includes(c));
			candidates = candidates.concat(fallback);
		}

		const roster = candidates.slice(0, 6);
		roster.forEach(c => used.add(c.species.id));

		return {
			name: `${region.name} ${archetype.name}`,
			archetype: archetype.tag,
			roster: roster.map((c, i) => buildSet(
				c.species, c.role, c.weather || weatherTag,
				c.bst >= median ? 'top' : 'mid', c.ability
			)),
		};
	});

	return teams;
}

// City League "rental cores": 6-mon preset squads (bring 6, pick 4 in an
// actual battle), lower-power picks, no archetype complexity - just
// something to hand a brand-new trainer. The first 2 mons of each core are
// its "signature pair" (the strongest available at intro-tier power, same
// selection this always used); the other 4 are lower-priority support picks
// filling out the bench so a real bring-4 choice exists.
const CORE_SIZE = 6;
const SIGNATURE_SIZE = 2;

// Hand-picked rosters that override (or, past the procedurally-generated
// count, append to) a region's City League cores - for a "Champion Core"
// that showcases the region's pseudo-legendary plus other genuinely strong
// picks, rather than whatever the BST-sorted pool happens to produce. A
// roster entry can be a bare species name (ability/item/moves auto-built as
// usual) or { species, moves, item, ability } to pin any of those exactly.
const FIXED_CORES = {
	paldea: [
		{
			index: 0,
			roster: [
				{ species: 'Pelipper', moves: ['Tailwind', 'Hurricane', 'Scald', 'Weather Ball'] },
				{ species: 'Archaludon', moves: ['Electro Shot', 'Draco Meteor', 'Body Press', 'Protect'] },
				{ species: 'Gholdengo', moves: ['Make It Rain', 'Shadow Ball', 'Nasty Plot', 'Protect'] },
				{ species: 'Palafin', moves: ['Flip Turn', 'Wave Crash', 'Iron Head', 'Jet Punch'] },
				{ species: 'Tinkaton' },
				{ species: 'Baxcalibur', moves: ['Dragon Dance', 'Icicle Crash', 'Glaive Rush', 'Protect'] },
			],
		},
	],
	kanto: [
		{
			index: 4, name: 'Kanto Champion Core',
			roster: [
				{ species: 'Dragonite', ability: 'Multiscale' }, { species: 'Snorlax', ability: 'Thick Fat' },
				{ species: 'Gyarados' }, { species: 'Alakazam', ability: 'Magic Guard' },
				{ species: 'Tauros' }, { species: 'Exeggutor' },
			],
		},
	],
	johto: [
		{
			index: 4, name: 'Johto Champion Core',
			roster: [
				{ species: 'Tyranitar' }, { species: 'Blissey' }, { species: 'Scizor', ability: 'Technician' },
				{ species: 'Kingdra' }, { species: 'Umbreon' }, { species: 'Feraligatr' },
			],
		},
	],
	hoenn: [
		{
			index: 4, name: 'Hoenn Champion Core',
			roster: [
				{ species: 'Salamence' }, { species: 'Metagross' }, { species: 'Blaziken', ability: 'Speed Boost' },
				{ species: 'Swampert' }, { species: 'Gardevoir' }, { species: 'Milotic' },
			],
		},
	],
	sinnoh: [
		{
			index: 4, name: 'Sinnoh Champion Core',
			roster: [
				{ species: 'Garchomp', ability: 'Rough Skin' }, { species: 'Lucario', ability: 'Inner Focus' },
				{ species: 'Togekiss', ability: 'Serene Grace' }, { species: 'Gliscor', ability: 'Poison Heal' },
				{ species: 'Rotom-Wash' }, { species: 'Weavile' },
			],
		},
	],
	unova: [
		{
			index: 4, name: 'Unova Champion Core',
			roster: [
				{ species: 'Hydreigon' }, { species: 'Volcarona' }, { species: 'Chandelure' },
				{ species: 'Haxorus', ability: 'Mold Breaker' }, { species: 'Excadrill', ability: 'Mold Breaker' },
				// Prankster is what makes its Tailwind so good - classify()'s
				// weather-role scan would otherwise hand it Chlorophyll instead,
				// since that's also a weather-linked ability in its kit.
				{ species: 'Whimsicott', ability: 'Prankster' },
			],
		},
	],
	kalos: [
		{
			index: 4, name: 'Kalos Champion Core',
			roster: [
				{ species: 'Goodra' }, { species: 'Aegislash' }, { species: 'Talonflame', ability: 'Gale Wings' },
				{ species: 'Greninja', ability: 'Protean' }, { species: 'Tyrantrum' }, { species: 'Sylveon', ability: 'Pixilate' },
			],
		},
	],
	alola: [
		{
			index: 4, name: 'Alola Champion Core',
			roster: [
				{ species: 'Kommo-o' }, { species: 'Toxapex', ability: 'Regenerator' }, { species: 'Mimikyu' },
				{ species: 'Primarina' }, { species: 'Incineroar', ability: 'Intimidate' }, { species: 'Golisopod' },
			],
		},
	],
	galar: [
		{
			index: 4, name: 'Galar Champion Core',
			roster: [
				{ species: 'Dragapult' }, { species: 'Corviknight' }, { species: 'Grimmsnarl' },
				{ species: 'Hatterene', ability: 'Magic Bounce' }, { species: 'Rillaboom', ability: 'Grassy Surge' },
				{ species: 'Cinderace', ability: 'Libero' },
			],
		},
	],
};

function buildCityLeagueCores(regionId) {
	const region = regionalDex[regionId];
	const numCores = 4;
	const basePool = region.species
		.map(s => Dex.species.get(s.id))
		.filter(s => s.exists)
		.filter(s => {
			const full = region.species.find(e => e.id === s.id);
			return full?.fullyEvolved;
		})
		.filter(s => !isCosmeticDuplicateForme(s))
		.filter(s => !(s.tags || []).some(t => ['Mythical', 'Sub-Legendary', 'Restricted Legendary', 'Ultra Beast', 'Paradox'].includes(t)) && !UNTAGGED_PARADOX_IDS.includes(s.id));

	// Adaptive BST cutoff: start low-power for a real intro feel, but relax
	// it if a region's generation just doesn't have enough small mons to
	// fill every core (numCores x CORE_SIZE mons) - a thin City League isn't
	// much of an intro tournament.
	const needed = numCores * CORE_SIZE;
	let cutoff = 460;
	let pool = basePool.filter(s => bstOf(s) < cutoff);
	while (pool.length < needed && cutoff < 600) {
		cutoff += 20;
		pool = basePool.filter(s => bstOf(s) < cutoff);
	}
	// Still short (a very small regional dex)? Fall back to the full pool
	// rather than leaving cores incomplete.
	if (pool.length < needed) pool = basePool;

	pool.sort((a, b) => bstOf(b) - bstOf(a));
	const picks = pool.slice(0, needed);

	const cores = [];
	for (let i = 0; i + CORE_SIZE <= picks.length; i += CORE_SIZE) {
		const group = picks.slice(i, i + CORE_SIZE);
		cores.push({
			name: `${region.name} Rental Core ${cores.length + 1}`,
			signatureCount: SIGNATURE_SIZE,
			roster: group.map(s => { const c = classify(s); return buildSet(s, c.role, null, 'mid', c.ability); }),
		});
	}
	for (const override of FIXED_CORES[regionId] || []) {
		const built = {
			name: override.name || cores[override.index]?.name || `${region.name} Rental Core ${override.index + 1}`,
			signatureCount: SIGNATURE_SIZE,
			roster: override.roster.map(entry => {
				const sp = Dex.species.get(entry.species);
				const c = classify(sp);
				return buildSet(sp, c.role, null, 'mid', entry.ability || c.ability, entry.moves, entry.item);
			}),
		};
		// Replace an existing procedurally-generated core at this index, or
		// append a brand new one past the procedural count (e.g. a region's
		// index-4 "Champion Core" alongside its usual 4 rental cores).
		if (override.index < cores.length) cores[override.index] = built;
		else cores.push(built);
	}

	return cores;
}

const output = {};
for (const regionId of Object.keys(regionalDex)) {
	output[regionId] = {
		name: regionalDex[regionId].name,
		regionalTeams: buildRegionTeams(regionId),
		cityLeagueCores: buildCityLeagueCores(regionId),
	};
}

writeFileSync('./regional-teams.json', JSON.stringify(output, null, 2));

console.log('=== Regional Teams Summary ===');
for (const regionId of Object.keys(output)) {
	const r = output[regionId];
	console.log(`\n${r.name}:`);
	for (const team of r.regionalTeams) {
		console.log(`  [${team.archetype}] ${team.name}: ${team.roster.map(s => s.species).join(', ')}`);
	}
	console.log(`  City League cores: ${r.cityLeagueCores.length} (${r.cityLeagueCores.map(c => c.roster.map(s => s.species).join('+')).join(' | ')})`);
}
