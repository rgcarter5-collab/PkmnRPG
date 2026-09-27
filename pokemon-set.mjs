// Convert our roster JSON shape (regional-teams.json entries, or anything
// authored the same way) into the PokemonSet object Showdown's Teams.pack /
// TeamValidator / BattleStream actually understand. Every Pokemon in this
// project is treated as having perfect (31) IVs everywhere and no gender
// restrictions - see stat-training.mjs for why IVs aren't a separate concept.
export function toPokemonSet(setData) {
	return {
		name: setData.species,
		species: setData.species,
		item: setData.item,
		ability: setData.ability,
		moves: setData.moves,
		nature: setData.nature,
		gender: '',
		evs: { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0, ...setData.evs },
		ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
		level: setData.level,
		shiny: false,
		teraType: setData.teraType,
	};
}
