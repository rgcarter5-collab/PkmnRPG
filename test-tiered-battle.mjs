// Tier 1 (rookie, makes visible mistakes) vs Tier 4 (Master, always best move)
// using the same two teams, to sanity-check the dice-roll difficulty system.
import { BattleStream, getPlayerStreams, Teams } from './sim/index.ts';
import { TieredAI } from './tiered-ai.mjs';

const p1team = Teams.import(`
Charizard @ Choice Specs
Ability: Solar Power
Level: 50
Tera Type: Fire
EVs: 4 HP / 252 SpA / 252 Spe
Timid Nature
- Flamethrower
- Air Slash
- Solar Beam
- Focus Blast

Blastoise @ Assault Vest
Ability: Torrent
Level: 50
Tera Type: Water
EVs: 252 HP / 4 Def / 252 SpD
Sassy Nature
- Scald
- Ice Beam
- Fake Out
- Wide Guard
`);

const p2team = Teams.import(`
Venusaur @ Life Orb
Ability: Chlorophyll
Level: 50
Tera Type: Grass
EVs: 4 HP / 252 SpA / 252 Spe
Timid Nature
- Giga Drain
- Sludge Bomb
- Sleep Powder
- Protect

Gengar @ Focus Sash
Ability: Cursed Body
Level: 50
Tera Type: Ghost
EVs: 4 HP / 252 SpA / 252 Spe
Timid Nature
- Shadow Ball
- Sludge Wave
- Protect
- Destiny Bond
`);

const streams = getPlayerStreams(new BattleStream());
const spec = { formatid: 'gen9doublescustomgame' };
const p1spec = { name: 'Rookie', team: Teams.pack(p1team) };
const p2spec = { name: 'Champion', team: Teams.pack(p2team) };

const p1 = new TieredAI(streams.p1, 1, {}, true);  // tier 1, debug on
const p2 = new TieredAI(streams.p2, 4, {}, true);  // tier 4, debug on

void p1.start();
void p2.start();

const fullLog = [];
void (async () => {
	for await (const chunk of streams.omniscient) {
		fullLog.push(chunk);
	}
	console.log('\n=== BATTLE LOG ===');
	console.log(fullLog.join('\n'));
	process.exit(0);
})();

void streams.omniscient.write(`>start ${JSON.stringify(spec)}
>player p1 ${JSON.stringify(p1spec)}
>player p2 ${JSON.stringify(p2spec)}`);
