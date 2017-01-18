import {Mission} from "./Mission";
import {Operation} from "../operations/Operation";
import {helper} from "../../helpers/helper";
import {notifier} from "../../notifier";
import {RaidCache} from "../../interfaces";
import {RaidGuru} from "./RaidGuru";
import {ZombieGuru, ZombieStatus, BOOST_AVERAGE_HITS} from "./ZombieGuru";
import {ZombieAgent} from "./ZombieAgent";
import {Agent} from "./Agent";

export class ZombieMission extends Mission {

    zombies: Agent[];
    guru: ZombieGuru;

    constructor(operation: Operation) {
        super(operation, "zombie");
    }

    initMission() {
        this.guru = new ZombieGuru(this);
        this.guru.init(this.flag.pos.roomName, true);
    }

    roleCall() {

        let max = () => this.guru.status === ZombieStatus.Attack ? 1 : 0;

        this.zombies = this.headCount2("zombie", this.getBody, max, {
                memory: {boosts: this.guru.boost, safeCount: 0},
                prespawn: this.memory.prespawn,
                skipMoveToRoom: true,
                blindSpawn: true});
    }

    missionActions() {
        for (let zombie of this.zombies) {
            this.zombieActions(zombie);
        }
    }

    finalizeMission() {

        if (this.guru.status === ZombieStatus.Complete) {
            notifier.log(`ZOMBIE: mission complete in ${this.room.name}`);
            this.flag.remove();
        }
    }

    invalidateMissionCache() {
    }

    private zombieActions(zombie: Agent) {

        let currentlyHealing = this.healWhenHurt(zombie, this.guru.expectedDamage / 10) === OK;
        this.massRangedAttackInRoom(zombie);

        // retreat condition
        let threshold = 500;
        if (this.guru.boost) {
            threshold = 250;
        }
        if (!this.isFullHealth(zombie, threshold)) {
            zombie.memory.reachedFallback = false;
        }

        if (!zombie.memory.reachedFallback) {
            if (zombie.isNearTo(this.guru.fallbackPos) && this.isFullHealth(zombie)) {
                this.registerPrespawn(zombie);
                zombie.memory.reachedFallback = true;
            }
            zombie.travelTo({pos: this.guru.fallbackPos});
            return;
        }

        if (zombie.pos.isNearExit(0)) {
            if (this.isFullHealth(zombie)) {zombie.memory.safeCount++; }
            else {zombie.memory.safeCount = 0;}
            console.log(zombie.creep.hits, zombie.memory.safeCount);
            if (zombie.memory.safeCount < 10) {
                return;
            }
        }
        else {
            zombie.memory.safeCount = 0;
        }

        let destination = this.findDestination(zombie);

        let returnData: {nextPos?: RoomPosition} = {};
        this.moveZombie(zombie, destination, zombie.memory.demolishing, returnData);
        zombie.memory.demolishing = false;
        if (zombie.pos.roomName === this.room.name && !zombie.pos.isNearExit(0)) {
            if (!returnData.nextPos) return;
            let structure = returnData.nextPos.lookFor<Structure>(LOOK_STRUCTURES)[0];
            if (structure && structure.structureType !== STRUCTURE_ROAD) {
                zombie.memory.demolishing = true;
                if (!currentlyHealing) {
                    zombie.attack(structure);
                }
            }
        }
    }

    private moveZombie(agent: Agent, destination: {pos: RoomPosition}, demolishing: boolean,
               returnData: {nextPos?: RoomPosition}): number | RoomPosition {

        let roomCallback = (roomName: string) => {
            if (roomName === this.guru.raidRoomName) {
                let matrix = this.guru.matrix;

                // add other zombies, whitelist nearby exits, and attack same target
                for (let otherZomb of this.zombies) {
                    if (agent === otherZomb || otherZomb.room !== this.room || otherZomb.pos.isNearExit(0)) { continue; }
                    matrix.set(otherZomb.pos.x, otherZomb.pos.y, 0xff);
                    for (let direction = 1; direction <= 8; direction ++) {
                        let position = otherZomb.pos.getPositionAtDirection(direction);
                        if (position.isNearExit(0)) {
                            matrix.set(position.x, position.y, 1);
                        }
                        else if (position.lookForStructure(STRUCTURE_WALL) ||
                            position.lookForStructure(STRUCTURE_RAMPART)){
                            let currentCost = matrix.get(position.x, position.y);
                            matrix.set(position.x, position.y, Math.ceil(currentCost / 2));
                        }
                    }
                }

                // avoid plowing into storages/terminals
                if (this.guru.raidRoom) {

                    for (let hostile of this.guru.raidRoom.hostiles) {
                        matrix.set(hostile.pos.x, hostile.pos.y, 0xff);
                    }
                    if (this.guru.raidRoom.storage) {
                        matrix.set(this.guru.raidRoom.storage.pos.x, this.guru.raidRoom.storage.pos.y, 0xff);
                    }

                    if (this.guru.raidRoom.terminal) {
                        matrix.set(this.guru.raidRoom.terminal.pos.x, this.guru.raidRoom.terminal.pos.y, 0xff);
                    }
                }

                return matrix;
            }
        };

        return agent.travelTo(destination, {
            ignoreStuck: demolishing,
            returnData: returnData,
            roomCallback: roomCallback,
        })
    }

    findDestination(agent: Agent) {
        let destination: {pos: RoomPosition} = this.flag;
        if (agent.pos.roomName === destination.pos.roomName) {
            let closestSpawn = agent.pos.findClosestByRange<Structure>(
                this.room.findStructures<Structure>(STRUCTURE_SPAWN));
            if (closestSpawn) {
                destination = closestSpawn;
            }
        }
        return destination;
    }

    getBody = (): string[] => {
        if (this.guru.expectedDamage === 0) {
            return this.workerBody(10, 0, 10);
        }
        if (this.guru.boost) {
            let healCount = Math.ceil((this.guru.expectedDamage * .3) / (HEAL_POWER * 4)); // boosting heal and tough
            let moveCount = 10;
            let rangedAttackCount = 1;
            let toughCount = 8;
            let dismantleCount = MAX_CREEP_SIZE - moveCount - rangedAttackCount - toughCount - healCount;
            return this.configBody({[TOUGH]: toughCount, [WORK]: dismantleCount, [RANGED_ATTACK]: rangedAttackCount,
                [MOVE]: moveCount, [HEAL]: healCount})
        }
        else {
            let healCount = Math.ceil(this.guru.expectedDamage / HEAL_POWER);
            let moveCount = 17; // move once every other tick
            let dismantleCount = MAX_CREEP_SIZE - healCount - moveCount;
            return this.configBody({[WORK]: dismantleCount, [MOVE]: 17, [HEAL]: healCount })
        }
    };

    massRangedAttackInRoom(agent: Agent) {
        if (agent.room.name === this.guru.raidRoomName) {
            return agent.rangedMassAttack();
        }
    }

    isFullHealth(agent: Agent, margin = 0) {
        return agent.hits >= agent.hitsMax - margin;
    }

    healWhenHurt(agent: Agent, margin = 0) {
        if (agent.hits < agent.hitsMax - margin) {
            return agent.heal(agent);
        }
    }

    attack(agent: Agent, target: Structure | Creep): number {
        if (target instanceof Structure && agent.partCount(WORK) > 0) {
            return agent.dismantle(target);
        }
        else {
            return agent.attack(target);
        }
    }
}