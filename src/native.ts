/* cryptocurrency balance management for chain-native currency (e.g., ETH, BNB, MATIC) */

import { get, writable } from 'svelte/store';
import { formatUnits } from 'ethers';
import { selectedNetwork } from './network';
import { selectedAddress } from './wallet';
import { provider } from './provider';
import type { IBalance, IBalanceWithFiat } from './types';
export type { IBalance };
export let nativeBalance = writable<IBalanceWithFiat | null>(null);
export let isLoadingNativeBalance = writable(false);


export async function refreshBalance() {
	const addr = get(selectedAddress);
	console.log('Refreshing native balance for', addr?.address);
	isLoadingNativeBalance.set(true);
	try {
		const v = await getBalance();
		if (v) {
			// Store crypto balance only - fiat conversion will be handled by updateAllFiats()
			nativeBalance.set({
				crypto: v,
				fiat: null, // Will be updated by updateAllFiats()
				timestamp: new Date()
			});
		}
	} finally {
		isLoadingNativeBalance.set(false);
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

