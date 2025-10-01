/* cryptocurrency balance management for chain-native currency (e.g., ETH, BNB, MATIC) with fiat conversion */

import { get, writable } from 'svelte/store';
import { formatUnits } from 'ethers';
import { selectedNetwork } from './network';
import { selectedAddress } from './wallet';
import { provider } from './provider';
import type { IBalance, IBalanceWithFiat } from './types';
export type { IBalance };
import { refreshInterval } from './common';


export let balance = writable<IBalanceWithFiat | null>(null);
export let isLoadingBalance = writable(false);
let balanceTimer: ReturnType<typeof setTimeout> | null = null;


export async function startBalanceRefresh() {
	if (balanceTimer) clearTimeout(balanceTimer);
	await refreshBalance();
	setTimeout(refreshBalance, refreshInterval * 1000);
}

export function stopBalanceRefresh() {
	if (balanceTimer) clearTimeout(balanceTimer);
	balanceTimer = null;
}


export async function refreshBalance() {
	const addr = get(selectedAddress);
	console.log('Refreshing native balance for', addr?.address);
	if (balanceTimer) clearTimeout(balanceTimer);
	isLoadingBalance.set(true);
	try {
		const nativeBalance = await getBalance();
		if (nativeBalance) {
			const fiatBalance = await getExchange(nativeBalance, 'USD');
			balance.set({
				crypto: nativeBalance,
				fiat: fiatBalance,
				timestamp: new Date()
			});
		}
	} finally {
		isLoadingBalance.set(false);
		balanceTimer = setTimeout(refreshBalance, refreshInterval * 1000);
	}
}


export async function getBalance(): Promise<IBalance | null> {
	const p = get(provider);
	const net = get(selectedNetwork);
	const addr = get(selectedAddress);
	if (!net || !p || !addr) {
		console.error('Network, provider, or address not set');
		return null;
	}
	//console.log('Getting balance for:', addr.address);
	try {
		const balanceWei = await p.getBalance(addr.address);
		//console.log('Balance fetched:', balanceWei, net.currency.symbol);
		return {
			amount: balanceWei,
			currency: net.currency.symbol || 'Unknown',
			decimals: 18
		};
	} catch (error) {
		console.error('Error while getting balance:', error);
		return null;
	}
}


export async function getExchange(cryptoBalance: IBalance, fiatSymbol: string = 'USD'): Promise<IBalance | null> {
	if (!cryptoBalance.amount) {
		//console.debug('Crypto amount not available');
		return null;
	}
	try {
		const rates = await exchangeRates(fiatSymbol);
		if (!rates) {
			console.error('Failed to fetch exchange rates');
			return null;
		}
		const symbol = cryptoBalance.currency.toUpperCase();
		const rate = rates.rates[symbol];
		if (!rate) {
			console.debug('Exchange rate not found for currency:', symbol);
			return null;
		}
		const rateNumber = Number(rate);
		const rateBigInt = BigInt(Math.round(rateNumber * 1e18));
		const fiatAmount = (cryptoBalance.amount * BigInt(1e18)) / rateBigInt;
		return {
			amount: fiatAmount,
			currency: fiatSymbol,
			decimals: 18
		};
	} catch (error) {
		console.error('Error while getting exchange rate:', error);
		return null;
	}
}

async function exchangeRates(currency: string = 'USD'): Promise<any> {
	const url = 'https://api.coinbase.com/v2/exchange-rates?currency=' + currency;
	try {
		const response = await fetch(url);
		if (!response.ok) throw new Error('HTTP error, status: ' + response.status);
		const data = await response.json();
		return data.data;
	} catch (error) {
		console.error('Error fetching exchange rates:', error);
		return null;
	}
}

export function formatBalance(balance: IBalance, roundToDecimals: number = -1, showCurrency: boolean = true): string | undefined {
	if (balance.amount === undefined || balance.amount === null) return undefined;
	let formatedAmount = formatUnits(balance.amount, balance.decimals !== undefined ? balance.decimals : 18);
	const decimals = balance.decimals !== undefined && balance.decimals !== null ? balance.decimals : 18;
	roundToDecimals = roundToDecimals > -1 ? roundToDecimals : decimals;
	// TODO: Intl.NumberFormat supports maximumFractionDigits only up to 20, so we need to handle larger fraction numbers differently
	console.log('Formatting balance:', formatedAmount, 'with', roundToDecimals, 'decimals');
	return Intl.NumberFormat(undefined, {
		minimumFractionDigits: 0,
		maximumFractionDigits: roundToDecimals
	}).format(Number(formatedAmount)) + (showCurrency ? ' ' + balance.currency : '');
}


