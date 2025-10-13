/**
 * Rate limiter utility for controlling request frequency
 */
export class RateLimiter {
	private requestTimes: number[] = [];

	constructor(
		private maxRequests: number = 20,
		private timeWindow: number = 1000 // milliseconds
	) {}

	/**
	 * Wait for an available slot before proceeding with the request
	 */
	async waitForSlot(): Promise<void> {
		const now = Date.now();

		// Remove old requests outside the time window
		this.requestTimes = this.requestTimes.filter(time => now - time < this.timeWindow);

		if (this.requestTimes.length >= this.maxRequests) {
			const oldestRequest = Math.min(...this.requestTimes);
			const waitTime = this.timeWindow - (now - oldestRequest) + 10; // +10ms buffer

			if (waitTime > 0) {
				console.log(`[RateLimiter] Rate limit reached, waiting ${waitTime}ms`);
				await new Promise(resolve => setTimeout(resolve, waitTime));
				return this.waitForSlot(); // Recursive check after waiting
			}
		}

		this.requestTimes.push(now);
	}

	/**
	 * Get current request rate information
	 */
	getStatus(): { currentRequests: number; maxRequests: number; timeWindow: number } {
		const now = Date.now();
		this.requestTimes = this.requestTimes.filter(time => now - time < this.timeWindow);

		return {
			currentRequests: this.requestTimes.length,
			maxRequests: this.maxRequests,
			timeWindow: this.timeWindow
		};
	}

	/**
	 * Reset the rate limiter
	 */
	reset(): void {
		this.requestTimes = [];
	}
}