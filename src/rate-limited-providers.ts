import { JsonRpcProvider, WebSocketProvider, Network } from 'ethers';
import { RateLimiter } from './rate-limiter';

// Type for Networkish to maintain compatibility
type Networkish = Network | number | bigint | string;

/**
 * Check if a URL is a WebSocket URL
 */
export function isWebSocketUrl(url: string): boolean {
	return url.startsWith('ws://') || url.startsWith('wss://');
}

/**
 * Rate-limited JSON RPC Provider that prevents hitting provider rate limits
 */
export class RateLimitedJsonRpcProvider extends JsonRpcProvider {
	private rateLimiter: RateLimiter;

	constructor(url: string, network?: Networkish, maxRequests = 15, timeWindowMs = 1000) {
		super(url, network);
		this.rateLimiter = new RateLimiter(maxRequests, timeWindowMs);
	}

	async send(method: string, params: any[]): Promise<any> {
		await this.rateLimiter.waitForSlot();

		try {
			return await super.send(method, params);
		} catch (error: any) {
			// Handle QuickNode-style rate limit errors
			if (this.isRateLimitError(error)) {
				console.warn('[RateLimitedJsonRpcProvider] Rate limit error detected, retrying after delay:', error.error?.message);
				// Wait longer and retry once
				await new Promise(resolve => setTimeout(resolve, 2000));
				await this.rateLimiter.waitForSlot();
				return await super.send(method, params);
			}
			throw error;
		}
	}

	private isRateLimitError(error: any): boolean {
		return (
			error.code === 'UNKNOWN_ERROR' &&
			error.error?.code === -32007 &&
			error.error?.message?.toLowerCase().includes('request limit')
		) ||
		(
			error.code === 'UNKNOWN_ERROR' &&
			error.error?.code === -32005 &&
			error.error?.message?.toLowerCase().includes('rate limit')
		) ||
		(
			error.error?.message?.toLowerCase().includes('too many requests')
		);
	}

	/**
	 * Get current rate limiter status
	 */
	getRateLimitStatus() {
		return this.rateLimiter.getStatus();
	}
}

/**
 * Rate-limited WebSocket Provider that prevents hitting provider rate limits
 */
export class RateLimitedWebSocketProvider extends WebSocketProvider {
	private rateLimiter: RateLimiter;

	constructor(url: string, network?: Networkish, maxRequests = 15, timeWindowMs = 1000) {
		super(url, network);
		this.rateLimiter = new RateLimiter(maxRequests, timeWindowMs);
	}

	async send(method: string, params: any[]): Promise<any> {
		await this.rateLimiter.waitForSlot();

		try {
			return await super.send(method, params);
		} catch (error: any) {
			// Handle rate limit errors similar to JSON RPC
			if (this.isRateLimitError(error)) {
				console.warn('[RateLimitedWebSocketProvider] Rate limit error detected, retrying after delay:', error.error?.message);
				await new Promise(resolve => setTimeout(resolve, 2000));
				await this.rateLimiter.waitForSlot();
				return await super.send(method, params);
			}
			throw error;
		}
	}

	private isRateLimitError(error: any): boolean {
		return (
			error.code === 'UNKNOWN_ERROR' &&
			error.error?.code === -32007 &&
			error.error?.message?.toLowerCase().includes('request limit')
		) ||
		(
			error.code === 'UNKNOWN_ERROR' &&
			error.error?.code === -32005 &&
			error.error?.message?.toLowerCase().includes('rate limit')
		) ||
		(
			error.error?.message?.toLowerCase().includes('too many requests')
		);
	}

	/**
	 * Get current rate limiter status
	 */
	getRateLimitStatus() {
		return this.rateLimiter.getStatus();
	}
}

/**
 * Factory function to create the appropriate rate-limited provider
 * @param url - RPC URL (HTTP/HTTPS for JSON RPC, WS/WSS for WebSocket)
 * @param network - Network identifier
 * @param maxRequests - Maximum requests per time window (default: 15)
 * @param timeWindowMs - Time window in milliseconds (default: 1000)
 * @returns Rate-limited provider instance
 */
export function createRateLimitedProvider(
	url: string,
	network?: Networkish,
	maxRequests = 15,
	timeWindowMs = 1000
): RateLimitedJsonRpcProvider | RateLimitedWebSocketProvider {
	if (isWebSocketUrl(url)) {
		return new RateLimitedWebSocketProvider(url, network, maxRequests, timeWindowMs);
	} else {
		return new RateLimitedJsonRpcProvider(url, network, maxRequests, timeWindowMs);
	}
}