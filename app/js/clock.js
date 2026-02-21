/**
 * clock.js - Animation Clock
 *
 * Drives the continuous update loop via requestAnimationFrame.
 * Separates the fast animation tick (every frame, ~60fps) from
 * slower display updates (configurable, default 1/second).
 *
 * Listeners register for either:
 *   - 'frame': called every animation frame with current Date
 *   - 'tick': called at the configured interval (for HUD, etc.)
 */

export class Clock {
    /**
     * @param {number} tickIntervalMs - interval for 'tick' callbacks, in ms. Default 1000.
     */
    /**
     * @param {number} tickIntervalMs - interval for 'tick' callbacks, in ms. Default 1000.
     * @param {number} offsetMinutes - minutes to add to the real clock. Default 0.
     */
    constructor(tickIntervalMs = 1000, offsetMinutes = 0) {
        this.tickInterval = tickIntervalMs;
        this.offsetMs = offsetMinutes * 60 * 1000;
        this.frameListeners = [];
        this.tickListeners = [];
        this.lastTickTime = 0;
        this.running = false;
        this._rafId = null;
        this.frozen = false;
        this.frozenTime = null;
    }

    /** Register a callback for every animation frame. fn(Date) */
    onFrame(fn) {
        this.frameListeners.push(fn);
    }

    /** Register a callback for periodic ticks. fn(Date) */
    onTick(fn) {
        this.tickListeners.push(fn);
    }

    /** Start the clock loop. */
    start() {
        if (this.running) return;
        this.running = true;
        this.lastTickTime = performance.now();
        this._loop(performance.now());
    }

    /** Stop the clock loop. */
    stop() {
        this.running = false;
        if (this._rafId !== null) {
            cancelAnimationFrame(this._rafId);
            this._rafId = null;
        }
    }

    /** Set the tick interval in ms. */
    setTickInterval(ms) {
        this.tickInterval = ms;
    }

    /** Set clock offset in minutes. */
    setOffsetMinutes(offsetMinutes) {
        this.offsetMs = offsetMinutes * 60 * 1000;
        // If frozen, keep frozen mode but jump to the new simulated "now".
        if (this.frozen) {
            this.frozenTime = new Date(Date.now() + this.offsetMs);
        }
    }

    /** Get current clock offset in minutes. */
    getOffsetMinutes() {
        return this.offsetMs / 60000;
    }

    /** Get the current simulated time (Date). */
    getNow() {
        return this.frozen ? new Date(this.frozenTime) : new Date(Date.now() + this.offsetMs);
    }

    /** Freeze time - stops updating but keeps RAF loop running */
    freeze() {
        if (!this.frozen) {
            this.frozen = true;
            this.frozenTime = new Date(Date.now() + this.offsetMs);
        }
    }

    /** Unfreeze time - resumes normal updates */
    unfreeze() {
        this.frozen = false;
        this.frozenTime = null;
    }

    /** Check if clock is frozen */
    isFrozen() {
        return this.frozen;
    }

    /** @private */
    _loop(timestamp) {
        if (!this.running) return;

        // Use frozen time if frozen, otherwise current time + offset
        const now = this.getNow();

        try {
            // Fire frame listeners every frame (even when frozen, for repositioning)
            for (const fn of this.frameListeners) {
                fn(now);
            }

            // Fire tick listeners at configured interval (only when not frozen)
            if (!this.frozen && timestamp - this.lastTickTime >= this.tickInterval) {
                this.lastTickTime = timestamp;
                for (const fn of this.tickListeners) {
                    fn(now);
                }
            }
        } catch (err) {
            console.error('Clock loop error:', err);
        }

        this._rafId = requestAnimationFrame((t) => this._loop(t));
    }
}
