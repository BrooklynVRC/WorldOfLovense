// Turns the addon's health bar into "took damage" and "low health" events.
// (WoW Forever hides the combat log and exact health from addons, so this is worked out from the bar.)

export type HealthEvent = { key: 'damage'; intensity: number; percent: number } | { key: 'low_health' };

const WINDOW_MS = 500;   // hits within this time add up into one event (same as the old addon)
const MIN_DROP = 0.02;   // ignore anything under 2% of your health
const JITTER = 0.006;    // smaller changes are measuring noise

export class HealthWatch {
  private last: number | null = null;
  private sum = 0;
  private since = 0;
  private low = false;

  /** Feed the newest reading (0..1, or null when the bar isn't visible). Returns events to play. */
  update(health: number | null, now: number): HealthEvent[] {
    const out: HealthEvent[] = [];
    if (health === null) { this.reset(); return out; }
    // `last` only moves on a real change, so slow damage (or noise-sized steps) still adds up.
    if (this.last === null || health > this.last) this.last = health;
    else {
      const drop = this.last - health;
      if (health < 0.005) { this.sum = 0; this.last = health; } // dead: the "You died" event covers it
      else if (drop > JITTER) { if (this.sum === 0) this.since = now; this.sum += drop; this.last = health; }
    }
    if (this.sum > 0 && now - this.since >= WINDOW_MS) {
      if (this.sum >= MIN_DROP) {
        const percent = Math.round(this.sum * 100);
        out.push({ key: 'damage', intensity: Math.min(15, Math.ceil(percent / 5)), percent });
      }
      this.sum = 0;
    }
    if (health > 0.005 && health < 0.25 && !this.low) { this.low = true; out.push({ key: 'low_health' }); }
    else if (health > 0.4) this.low = false;
    return out;
  }

  reset() { this.last = null; this.sum = 0; }
}
