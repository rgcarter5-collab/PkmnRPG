// Proof-of-concept: run a full doubles battle using Showdown's own official
// RandomPlayerAI tool class against custom teams, to confirm the sim engine
// (damage calc, turn order, doubles targeting, win condition) runs correctly
// end to end with zero npm install beyond one tiny vendored shim.
import { BattleStream, getPlayerStreams, Teams } from './sim/index.ts';
import { RandomPlayerAI } from './sim/tools/random-player-ai.ts';

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
const p1spec = { name: 'Ash', team: Teams.pack(p1team) };
const p2spec = { name: 'Gary', team: Teams.pack(p2team) };

const p1 = new RandomPlayerAI(streams.p1);
const p2 = new RandomPlayerAI(streams.p2);

void p1.start();
void p2.start();

const fullLog = [];
void (async () => {
	for await (const chunk of streams.omniscient) {
		fullLog.push(chunk);
	}
	console.log('=== FULL BATTLE LOG ===');
	console.log(fullLog.join('\n'));
	process.exit(0);
})();

void streams.omniscient.write(`>start ${JSON.stringify(spec)}
>player p1 ${JSON.stringify(p1spec)}
>player p2 ${JSON.stringify(p2spec)}`);
