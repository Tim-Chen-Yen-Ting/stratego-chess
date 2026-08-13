/**
 * 吃子判定 — capture resolution. Gamebook §4, §5, 附錄 A.
 *
 * This module answers exactly two questions and nothing else:
 *   • who survives the contact
 *   • whose 兵種 becomes permanently public
 *
 * Board occupancy (who ends up standing where) is NOT decided here — see
 * game.ts, which applies gamebook §4「位置結算」and §5's bomb-loss table.
 */

import { BOMB_IMMUNE, RANK_ORDER } from './constants.js'
import type { CombatOutcome, Color, Piece, Rank } from './types.js'

export interface CombatResolution {
  outcome: CombatOutcome
  attackerSurvives: boolean
  defenderSurvives: boolean
  /** 翻明 — the winner's 兵種 becomes permanently public (§4.3). */
  revealAttacker: boolean
  revealDefender: boolean
}

/** 工兵 and 軍旗 are immune to 爆裂物, in both directions (§5, 附錄 A(a)). */
export function isBombImmune(rank: Rank): boolean {
  return BOMB_IMMUNE.includes(rank)
}

/** Numeric 階級. Throws for 'bomb', which deliberately has none. */
export function rankOrder(rank: Exclude<Rank, 'bomb'>): number {
  return RANK_ORDER[rank]
}

/**
 * 同歸於盡 — the single announcement every both-die contact makes.
 *
 * A FRESH object per call, never a shared singleton: `game.ts` puts the outcome
 * straight into the log, and an aliased literal would put one object in every
 * event of every game at once.
 *
 * The three cases below that use it — 同階相遇, 爆裂物 vs 一般兵種, 爆裂物 vs
 * 爆裂物 — are resolved differently and correctly; they simply announce the same
 * thing. See `CombatOutcome` in types.ts for why.
 */
function mutualDestruction(): CombatOutcome {
  return { kind: 'mutual-destruction' }
}

/**
 * Resolve a contact between two 兵種.
 *
 * §2  一律大吃小 — the lower RANK_ORDER number wins, no exceptions.
 * §5  爆裂物 counts as equal to whatever it touches (so: mutual destruction),
 *     except against 工兵/軍旗, where the bomb simply LOSES — in BOTH
 *     directions, whether the bomb attacked or was attacked.
 *
 * Three of the branches below are separate decisions with one announcement:
 * every contact that removes both pieces returns a bare `mutual-destruction`
 * and 翻明s NOBODY. Both halves of that are load-bearing. Announcing the tied
 * 階級 gave both players a free exact rank; announcing a detonation made 爆裂物
 * publicly countable. And 翻明 is not merely a second announcement — a revealed
 * piece hands its rank to every viewer through `entitledToRank`, alive or dead,
 * so leaving the reveal flags set would republish through the piece list exactly
 * what the opaque outcome withholds.
 *
 * 附錄 A is satisfied more strictly than before, not less: all three cases are
 * now literally the same observation.
 */
export function resolveCombat(
  attackerRank: Rank,
  defenderRank: Rank,
  attackerColor: Color,
  defenderColor: Color,
): CombatResolution {
  const aBomb = attackerRank === 'bomb'
  const dBomb = defenderRank === 'bomb'

  // 爆裂物 vs 爆裂物 — both removed. Two bombs are spent and the log says only
  // that two pieces died; nothing announces that either was a 爆裂物.
  if (aBomb && dBomb) {
    return {
      outcome: mutualDestruction(),
      attackerSurvives: false,
      defenderSurvives: false,
      revealAttacker: false,
      revealDefender: false,
    }
  }

  if (aBomb || dBomb) {
    const otherRank = aBomb ? defenderRank : attackerRank

    // 爆裂物 vs 工兵／軍旗 — 有煙無傷. Only the bomb is removed and NOTHING is
    // revealed: revealing the survivor would name it as 工兵 or 軍旗 and
    // destroy the one ambiguity 附錄 A(a) exists to protect.
    if (isBombImmune(otherRank)) {
      const survivorColor: Color = aBomb ? defenderColor : attackerColor
      return {
        outcome: { kind: 'fizzle', survivorColor },
        attackerSurvives: !aBomb,
        defenderSurvives: aBomb,
        revealAttacker: false,
        revealDefender: false,
      }
    }

    // 爆裂物 vs 一般兵種 — both removed. The bomb IS consumed, but which side
    // spent it is not announced and the bomb is not 翻明: that is the whole of
    // what stops 爆裂物 from being counted down to zero from the log.
    return {
      outcome: mutualDestruction(),
      attackerSurvives: false,
      defenderSurvives: false,
      revealAttacker: false,
      revealDefender: false,
    }
  }

  const a = RANK_ORDER[attackerRank as Exclude<Rank, 'bomb'>]
  const d = RANK_ORDER[defenderRank as Exclude<Rank, 'bomb'>]

  if (a < d) {
    return {
      outcome: { kind: 'attacker-wins', winnerRank: attackerRank },
      attackerSurvives: true,
      defenderSurvives: false,
      revealAttacker: true,
      revealDefender: false,
    }
  }

  if (d < a) {
    return {
      outcome: { kind: 'defender-wins', winnerRank: defenderRank },
      attackerSurvives: false,
      defenderSurvives: true,
      revealAttacker: false,
      revealDefender: true,
    }
  }

  // 同階相遇 — both removed. The shared 階級 is NOT announced: it would hand
  // both players an exact rank, and it would tell a bomb's victim that it was
  // not a bomb.
  return {
    outcome: mutualDestruction(),
    attackerSurvives: false,
    defenderSurvives: false,
    revealAttacker: false,
    revealDefender: false,
  }
}

/** Convenience wrapper over two Pieces. */
export function resolvePieceCombat(attacker: Piece, defender: Piece): CombatResolution {
  return resolveCombat(attacker.rank, defender.rank, attacker.color, defender.color)
}
