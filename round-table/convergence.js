'use strict';

/**
 * Check whether at least 2 of the 3 models landed on the same asset + direction.
 * Returns a convergence object with converged flag and details.
 */
function checkConvergence(turns) {
  const positions = turns.map(t => t.position).filter(Boolean);
  if (positions.length < 2) return { converged: false };

  // Normalize: uppercase asset, lowercase direction
  const normalized = positions.map(p => ({
    model: turns.find(t => t.position === p)?.model,
    asset: (p.asset || '').toUpperCase().trim(),
    direction: (p.direction || '').toLowerCase().trim(),
    confidence: p.confidence,
    thesis: p.thesis,
  })).filter(p => p.asset && p.direction);

  // Count votes per asset:direction pair
  const votes = {};
  for (const p of normalized) {
    const key = `${p.asset}:${p.direction}`;
    if (!votes[key]) votes[key] = [];
    votes[key].push(p);
  }

  // Find any pair with 2+ votes
  const winning = Object.entries(votes).find(([, v]) => v.length >= 2);
  if (!winning) return { converged: false };

  const [key, supporters] = winning;
  const [asset, direction] = key.split(':');

  return {
    converged: true,
    asset,
    direction,
    supportingModels: supporters.map(p => p.model),
    supportCount: supporters.length,
    theses: supporters.map(p => ({ model: p.model, thesis: p.thesis })),
    summary: `${supporters.length}/3 models converged: ${direction} on ${asset}.`,
  };
}

module.exports = { checkConvergence };
