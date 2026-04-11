/* Centralized fiat currency exchange rate management */

import { writable, get } from "svelte/store";
import type { IBalance, IBalanceWithFiat } from "./types";
import { localStorageSharedStore } from "./utils/svelte-shared-store.ts";
// Types
export type Currency = string;
export type Rate = number;
export const fiat = localStorageSharedStore<string>("fiat", "USD");
interface ExchangeRatesData {
	currency: Currency;
	rates: Record<Currency, Rate>;
}
interface ExchangeRatesCache {
	data: ExchangeRatesData;
	timestamp: number;
}
// Constants
const EXCHANGE_RATES_CACHE_DURATION = 15 * 60 * 1000;
// Stores - separate cache per currency
export const exchangeRatesCaches = writable<Map<Currency, ExchangeRatesCache>>(
	new Map(),
);
export const isRefreshingExchangeRates = writable(false);

// Check if cache exists and is recent-enough for a specific currency
function isCacheValid(cache: ExchangeRatesCache | null): boolean {
	if (!cache) return false;
	return Date.now() - cache.timestamp < EXCHANGE_RATES_CACHE_DURATION;
}

// Fetch fresh exchange rates from API
async function fetchExchangeRates(
	currency: Currency,
): Promise<ExchangeRatesData | null> {
	const url = `https://api.coinbase.com/v2/exchange-rates?currency=${currency}`;
	try {
		const response = await fetch(url);
		if (!response.ok) throw new Error(`HTTP error, status: ${response.status}`);
		const data = await response.json();
		// Convert string rates to numbers
		const rates: Record<Currency, Rate> = {};
		for (const [currencySymbol, rateString] of Object.entries(
			data.data.rates,
		)) {
			rates[currencySymbol] = Number(rateString);
		}
		return {
			currency: data.data.currency,
			rates,
		};
	} catch (error) {
		console.error("Error fetching exchange rates:", error);
		return null;
	}
}

// Update cache for specific currency
function updateCacheForCurrency(
	currency: Currency,
	data: ExchangeRatesData,
): void {
	exchangeRatesCaches.update((caches) => {
		const newCaches = new Map(caches);
		newCaches.set(currency, {
			data,
			timestamp: Date.now(),
		});
		return newCaches;
	});
}

// Force refresh exchange rates for specific currency (ignore cache)
async function refreshExchangeRates(
	currency: Currency,
): Promise<ExchangeRatesData | null> {
	console.log("Force refreshing exchange rates for currency:", currency);

	while (get(isRefreshingExchangeRates)) {
		await new Promise((resolve) => setTimeout(resolve, 100));
	}

	isRefreshingExchangeRates.set(true);
	try {
		const rates = await fetchExchangeRates(currency);
		if (rates) {
			updateCacheForCurrency(currency, rates);
			//console.log('Exchange rates refreshed successfully for', currency);
		}
		return rates;
	} finally {
		isRefreshingExchangeRates.set(false);
	}
}

// Get exchange rates (from cache if valid, otherwise fetch fresh)
export async function getExchangeRates(
	currency: Currency,
): Promise<ExchangeRatesData | null> {
	// Check cache first
	const caches = get(exchangeRatesCaches);
	//console.log(`getExchangeRates: Checking caches ${JSON.stringify(caches)} for currency ${currency}`);
	const cache = caches.get(currency);
	if (cache && isCacheValid(cache)) {
		return cache.data;
	} else {
		return refreshExchangeRates(currency);
	}
}

/**
 * Convert a cryptocurrency balance to fiat currency using cached exchange rates
 *
 * @param cryptoBalance - The crypto balance to convert (amount, currency, decimals)
 * @param fiatSymbol - Target fiat currency symbol (e.g., 'USD', 'EUR')
 * @returns Promise<IBalance | null> - The converted fiat balance or null if conversion fails
 *
 * Uses cached exchange rates when available.
 * Falls back to fresh API call if cache is stale or missing.
 */
function getExchange(
	cryptoBalance: IBalance,
	fiatSymbol: Currency,
	rates: ExchangeRatesData | null,
): IBalance | null {
	if (
		!cryptoBalance ||
		cryptoBalance.amount === null ||
		cryptoBalance.amount === undefined ||
		!cryptoBalance.currency
	) {
		console.debug("getExchange: Invalid crypto balance for conversion");
		return null;
	}
	//console.log('getExchange: Converting', cryptoBalance.amount, cryptoBalance.currency, 'to', fiatSymbol);

	try {
		if (!rates) {
			console.error("Failed to fetch exchange rates");
			return null;
		}

		const symbol = cryptoBalance.currency.toUpperCase();
		//console.log('getExchange: Looking up exchange rate for currency symbol:', symbol, 'Available rates:', Object.keys(rates.rates).slice(0, 3), '...');
		const rate = rates.rates[symbol];
		if (!rate) {
			console.debug(
				"getExchange: Exchange rate not found for currency:",
				symbol,
			);
			return null;
		}

		// Convert exchange rate to BigInt with 18 decimal precision
		// Example: if rate = 0.00045 (1 USD = 0.00045 ETH), then:
		// rateBigInt = 450000000000000 (0.00045 * 1e18)
		const rateBigInt = BigInt(Math.round(rate * 1e18));

		// Calculate fiat amount using cross-multiplication to avoid precision loss
		// Formula: fiatAmount = cryptoAmount / exchangeRate
		// We multiply crypto amount by 1e18 first, then divide by rateBigInt to maintain precision
		// Example: if crypto = 2000000000000000000 (2 ETH) and rate = 0.00045:
		// fiatAmount = (2000000000000000000 * 1e18) / 450000000000000 = 4444444444444444444 (~4444.44 USD)
		const fiatAmount = (cryptoBalance.amount * BigInt(1e18)) / rateBigInt;

		return {
			amount: fiatAmount,
			currency: fiatSymbol,
			decimals: 18,
		};
	} catch (error) {
		console.error("getExchange: Error while getting exchange rate:", error);
		return null;
	}
}

export function balanceUpdateSync(
	crypto: IBalance,
	fiatSymbol: Currency,
	rates: ExchangeRatesData,
): IBalanceWithFiat {
	return {
		crypto,
		fiat: getExchange(crypto, fiatSymbol, rates),
		timestamp: new Date(),
	};
}

export async function updateAllFiats() {
	const f = get(fiat);
	const rates = await getExchangeRates(f);
	if (!rates) return;

	// Update native balance fiat conversion
	const { nativeBalance } = await import("./native");
	const b = get(nativeBalance)?.crypto;
	if (b) {
		nativeBalance.set(balanceUpdateSync(b, f, rates));
	}

	// Update token balances fiat conversion
	const { tokenBalances } = await import("./tokens");
	const token_balances = get(tokenBalances);
	const updatedTokenBalances = new Map(token_balances);

	for (const [key, value] of updatedTokenBalances.entries()) {
		if (value?.crypto) {
			updatedTokenBalances.set(key, balanceUpdateSync(value.crypto, f, rates));
		}
	}

	tokenBalances.set(updatedTokenBalances);
}
