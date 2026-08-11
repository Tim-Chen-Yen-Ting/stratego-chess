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
 * Resolve a contact between two 兵種.
 *
 * §2  一律大吃小 — the lower RANK_ORDER number wins, no exceptions.
 * §5  爆裂物 counts as equal to whatever it touches (so: mutual destruction),
 *     except against 工兵/軍旗, where the bomb simply LOSES — in BOTH
 *     directions, whether the bomb attacked or was attacked.
 *
 * The 'mutual-rank' and 'bomb-detonate' outcomes are deliberately distinct
 * (§4「翻明總表」): if a bomb's victim saw the same announcement as an
 * equal-rank trade, it would wrongly conclude that the attacker shared its
 * own 階級.
 */
export function resolveCombat(
  attackerRank: Rank,
  defenderRank: Rank,
  attackerColor: Color,
  defenderColor: Color,
): CombatResolution {
  const aBomb = attackerRank === 'bomb'
  const dBomb = defenderRank === 'bomb'

  // 爆裂物 vs 爆裂物 — both removed, both announced (§4 table row 4).
  if (aBomb && dBomb) {
    return {
      outcome: { kind: 'bomb-vs-bomb' },
      attackerSurvives: false,
      defenderSurvives: false,
      revealAttacker: true,
      revealDefender: true,
    }
  }

  if (aBomb || dBomb) {
    const bombColor = aBomb ? attackerColor : defenderColor
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

    // 爆裂物 vs 一般兵種 — both removed, only the bomb is announced.
    return {
      outcome: { kind: 'bomb-detonate', bombColor },
      attackerSurvives: false,
      defenderSurvives: false,
      revealAttacker: aBomb,
      revealDefender: dBomb,
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

  // 同階相遇 — both removed, both 階級 announced.
  return {
    outcome: { kind: 'mutual-rank', rank: attackerRank },
    attackerSurvives: false,
    defenderSurvives: false,
    revealAttacker: true,
    revealDefender: true,
  }
}

/** Convenience wrapper over two Pieces. */
export function resolvePieceCombat(attacker: Piece, defender: Piece): CombatResolution {
  return resolveCombat(attacker.rank, defender.rank, attacker.color, defender.color)
}
